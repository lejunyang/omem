import * as lark from "@larksuiteoapi/node-sdk";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scheduleIngest } from "../agents/jobs.ts";
import { registerThreadSender } from "../agents/inbox.ts";
import type { App } from "../core/app.ts";
import { one, run } from "../core/db.ts";
import { addNotificationSink } from "../core/notify.ts";
import { findSpace } from "../core/spaces.ts";
import { identitiesOf, OWNER, resolveIdentity, userName } from "../core/users.ts";
import { importFile } from "../sources/import.ts";
import { appendToSource, findSourceByUri, sourceText } from "../sources/store.ts";
import { answerFromChannel, resolveCitations } from "./common.ts";
import { startProgress } from "./lark-progress.ts";
import { handleCardAction } from "./lark-actions.ts";
import { sendLark, setLarkClient } from "./lark-send.ts";
import { larkAppSecret } from "./lark-setup.ts";
import { routeWatchedMessages } from "./lark-watch.ts";

/**
 * Feishu/Lark bot channel.
 *
 * - Private chat with the owner (and registered users) talks to the assistant,
 *   with a live progress card that turns into the answer.
 * - In groups the bot is in, every message is captured as a chat source; an
 *   @mention of the bot by a user starts a turn in that chat's (or topic's)
 *   thread; watched groups hand messages to their handler spec.
 * - Card buttons and forms come back through `card.action.trigger`: drafts are
 *   sent or dropped, other actions continue the conversation that posted them,
 *   and only the people a card names may act on it.
 */
type Inbound = {
  chatId: string;
  chatType: "p2p" | "group";
  messageId: string;
  senderId: string;
  senderName: string;
  text: string;
  mentionsBot: boolean;
  mentions: string[];
  createTime: string;
  /** Topic (话题) the message belongs to: thread_id in topic groups and threaded replies. */
  topicId?: string;
  /** Quoted / reply-referenced message, resolved to readable text. */
  quote?: { messageId?: string; sender?: string; text?: string; origin?: string };
};

export function messageText(raw: string | undefined, type: string | undefined): string {
  if (!raw) return "";
  try {
    const c = JSON.parse(raw);
    if (type === "text") return String(c.text ?? "");
    if (type === "post") {
      const body = c.content ?? c.zh_cn?.content ?? c.en_us?.content ?? [];
      return [c.title, ...body.map((line: { tag: string; text?: string; href?: string }[]) => line.map((n) => n.text ?? n.href ?? "").join(""))].filter(Boolean).join("\n");
    }
    if (type === "image") return "[图片]";
    if (type === "file") return `[文件] ${c.file_name ?? ""}`;
    if (type === "interactive") return `[卡片] ${c.title ?? c.header?.title?.content ?? ""}`;
    return `[${type}]`;
  } catch {
    return raw;
  }
}

function kv(app: App, key: string, value?: string) {
  if (value === undefined) return one<{ value: string }>(app.db, "select value from kv where key = ?", key)?.value;
  run(app.db, "insert into kv(key,value) values(?,?) on conflict(key) do update set value = excluded.value", key, value);
  return value;
}

export async function startLarkBot(app: App) {
  const cfg = app.config.lark;
  const appSecret = larkAppSecret(app.home, cfg.appId, cfg.appSecretEnv);
  if (!cfg.appId || !appSecret) throw new Error("还没有绑定飞书机器人：运行 omem setup → 渠道 → 飞书机器人（扫码创建或授权已有应用）");
  const client = new lark.Client({ appId: cfg.appId, appSecret, domain: lark.Domain.Feishu });
  let botOpenId: string | null = kv(app, "lark_bot_open_id") ?? null;
  try {
    const info = (await client.request({ method: "GET", url: "/open-apis/bot/v3/info" })) as { bot?: { open_id?: string; app_name?: string } };
    if (info.bot?.open_id) botOpenId = kv(app, "lark_bot_open_id", info.bot.open_id) ?? null;
    if (info.bot?.app_name) kv(app, "lark_bot_name", info.bot.app_name);
  } catch (e) {
    console.warn("[omem] 读取飞书机器人信息失败：", (e as Error).message);
  }
  setLarkClient(client, botOpenId);

  // Names for people in groups (needs contact read permission; falls back to the id).
  const names = new Map<string, string>();
  const nameOf = async (openId: string) => {
    if (!openId) return "?";
    const known = resolveIdentity(app, "lark", openId);
    if (known) return userName(app, known);
    if (names.has(openId)) return names.get(openId)!;
    try {
      const r = await client.contact.user.get({ path: { user_id: openId }, params: { user_id_type: "open_id" } });
      const n = r.data?.user?.name;
      if (n) names.set(openId, n);
      return n ?? openId;
    } catch {
      names.set(openId, openId.slice(-6));
      return openId.slice(-6);
    }
  };

  const reply = (chatId: string, markdown: string, replyTo?: string, inThread = false) => sendLark(replyTo ? { replyTo, inThread } : { chatId }, { markdown });

  // Later results for a thread (delegated agents…) go back to the same chat, inside the topic when there is one.
  registerThreadSender("lark", async (thread, markdown) => {
    const [chatId, topic] = (thread.key ?? "").split("#");
    if (!chatId) return;
    await reply(chatId, markdown, thread.settings.lastMessageId, !!topic);
  });

  addNotificationSink(async (n) => {
    const target = n.userId === OWNER
      ? (kv(app, "lark_owner_chat") ? { chatId: kv(app, "lark_owner_chat")! } : cfg.ownerOpenId ? { userId: cfg.ownerOpenId } : null)
      : { userId: identitiesOf(app, n.userId).find((i) => i.channel === "lark")?.external_id ?? "" };
    if (!target || (!("userId" in target) && !("chatId" in target)) || ("userId" in target && !target.userId)) return;
    // Internal citations/routes cannot be opened in Feishu: real originals become links, the rest plain text.
    const body = resolveCitations(app, n.body ?? "");
    if (n.entity === "item" && n.entityId) {
      // Actionable item card: 已处理 / 忽略 resolve the item directly, no agent turn.
      const { buildCard, recordInteraction } = await import("./lark-send.ts");
      const { getItem } = await import("../items/store.ts");
      // Where the item came from, as links Feishu can open (web/Feishu docs, the chat it was said in).
      let origin = "";
      try {
        const refs = getItem(app, n.entityId).sourceRefs.filter((r) => r.startsWith("src:"));
        const links = [...new Set(refs.map((r, i) => resolveCitations(app, `[原文${refs.length > 1 ? i + 1 : ""}](${r})`)).filter((l) => l.includes("](")))];
        if (links.length) origin = `来源：${links.join("　")}`;
      } catch {}
      const card = buildCard({
        title: n.title,
        color: "blue",
        blocks: [
          { markdown: body || " " },
          ...(origin ? [{ markdown: origin }] : []),
          {
            buttons: [
              { text: "已处理", value: `item:done:${n.entityId}`, style: "primary" },
              { text: "忽略", value: `item:cancel:${n.entityId}` },
              ...((n.actions ?? []).map((a) => ({ text: a.label, value: `item:act:${n.entityId}:${a.action}`, ...(a.style ? { style: a.style } : {}) }))),
            ],
          },
        ],
      });
      const sent = await sendLark(target, { card });
      recordInteraction(app, { messageId: sent.messageId, chatId: ("chatId" in target ? target.chatId : null) ?? null, conversationId: null, runId: null, purpose: "agent", allowed: [], payload: { itemId: n.entityId, notificationId: n.id } });
      return;
    }
    const markdown = `**${n.title}**\n${body}`;
    await sendLark(target, { markdown });
  });

  const pending = new Map<string, NodeJS.Timeout>();
  const lastCapture = new Map<string, string>();
  const groupSpace = (chatId: string) => ((findSpace(app, "personal")?.settings.larkGroups ?? {}) as Record<string, string>)[chatId] ?? cfg.defaultSpace;
  const captureGroup = (m: Inbound) => {
    const spaceId = groupSpace(m.chatId);
    const uri = `lark:${m.chatId}`;
    const before = findSourceByUri(app, spaceId, uri);
    const at = new Date(Number(m.createTime)).toISOString().slice(0, 16).replace("T", " ");
    const r = appendToSource(app, {
      spaceId,
      kind: "chat",
      uri,
      title: (before?.title as string) ?? `飞书群 ${m.chatId.slice(-6)}`,
      lines: [`[${at}${m.topicId ? ` · 话题 ${m.topicId}` : ""}] ${m.senderName}: ${m.text.replace(/\n/g, " ⏎ ")} (${m.messageId})`],
      meta: { chatId: m.chatId },
    });
    lastCapture.set(m.messageId, r.id);
    // Debounce: hand a burst of messages to the ingest role once.
    const key = `${spaceId}:${r.id}`;
    clearTimeout(pending.get(key));
    pending.set(
      key,
      setTimeout(() => {
        pending.delete(key);
        scheduleIngest(app, spaceId, [r.id], "飞书群新消息");
      }, 5 * 60_000),
    );
  };

  /** What was said just before an @mention, in the same topic when there is one. */
  const groupContext = (m: Inbound) => {
    const sourceId = lastCapture.get(m.messageId);
    lastCapture.delete(m.messageId);
    if (!sourceId) return "";
    const lines = sourceText(app, sourceId).split("\n").filter(Boolean);
    lines.pop(); // the mention itself
    const pick = m.topicId ? lines.filter((l) => l.includes(`话题 ${m.topicId}]`)) : lines;
    return pick.slice(-15).join("\n");
  };

  /** Fetch the message a user quoted/reply-referenced, so the agent knows what they mean. */
  const fetchQuote = async (msg: Record<string, unknown>): Promise<Inbound["quote"]> => {
    const parentId = typeof (msg as { parent_id?: string }).parent_id === "string" ? (msg as { parent_id: string }).parent_id : "";
    const threadId = typeof (msg as { thread_id?: string }).thread_id === "string" ? (msg as { thread_id: string }).thread_id : "";
    // thread_id is the topic; parent_id points at the quoted message. Same id = plain topic reply.
    if (!parentId || parentId === threadId) return undefined;
    try {
      const r = await client.request({
        method: "GET",
        url: `/open-apis/im/v1/messages/${encodeURIComponent(parentId)}`,
        params: { user_id_type: "open_id" },
      });
      const items = (r as { data?: { items?: Record<string, unknown>[] } }).data?.items ?? [];
      const orig = items[0] as { body?: { content?: string }; message_type?: string; sender?: { id?: { open_id?: string } } } | undefined;
      if (!orig) return { messageId: parentId };
      return {
        messageId: parentId,
        sender: orig.sender?.id?.open_id ? await nameOf(orig.sender.id.open_id) : undefined,
        text: messageText(orig.body?.content, orig.message_type).slice(0, 2000) || undefined,
      };
    } catch {
      return { messageId: parentId };
    }
  };

  const handle = async (m: Inbound) => {
    if (m.chatType === "group") {
      captureGroup(m);
      await routeWatchedMessages(app, m.chatId, groupName(m.chatId), [{ id: m.messageId, time: m.createTime, sender: m.senderName, senderId: m.senderId, text: m.text, topicId: m.topicId, mentions: m.mentions }], { botOpenId });
      if (!m.mentionsBot) return;
    }
    if (!cfg.ownerOpenId) {
      await reply(m.chatId, `还没有绑定本人。请在 omem 配置中设置 \`lark.ownerOpenId\` 为：\`${m.senderId}\`，然后重启服务。`, m.messageId);
      return;
    }
    const userId = resolveIdentity(app, "lark", m.senderId);
    if (!userId) return; // not the owner and not a registered user (omem user add … --lark <open_id>)
    if (m.chatType === "p2p" && userId === OWNER) kv(app, "lark_owner_chat", m.chatId);
    const text = m.text.replace(/@_user_\d+/g, "").trim();
    const context = m.chatType === "group" ? groupContext(m) : "";
    if (!text) return;
    let progress: Awaited<ReturnType<typeof startProgress>> | null = null;
    try {
      const answer = await answerFromChannel(
        app,
        {
          channel: "lark",
          chatId: m.chatId,
          topicId: m.topicId,
          isGroup: m.chatType === "group",
          text,
          spaceId: m.chatType === "group" ? groupSpace(m.chatId) : userId === OWNER ? cfg.defaultSpace : undefined,
          context,
          contextLabel: m.topicId ? "话题里" : "群里",
          externalMessageId: m.messageId,
          quote: m.quote,
          userId,
        },
        {
          onStart: async (runId) => {
            progress = await startProgress(app, { messageId: m.messageId, inThread: !!m.topicId }, runId).catch(() => null);
          },
          onMerged: async () => {
            const { reactLark } = await import("./lark-send.ts");
            await reactLark(m.messageId, "Get").catch(() => {});
          },
          onCard: async (card) => {
            const { sendLark } = await import("./lark-send.ts");
            const { resolveThread } = await import("../agents/threads.ts");
            const { newId } = await import("../core/util.ts");
            const sent = await sendLark({ chatId: m.chatId, replyTo: m.messageId, inThread: !!m.topicId }, { card }).catch(() => null);
            if (sent) {
              let conversationId: string | null = null;
              try {
                conversationId = resolveThread(app, { channel: "lark", chatId: m.chatId, topicId: m.topicId }).thread.id;
              } catch { conversationId = null; }
              run(app.db, "insert into card_interactions(id,message_id,chat_id,conversation_id,run_id,purpose,allowed,payload,created_at) values(?,?,?,?,?,?,?,?,?)",
                newId("ci"), sent.messageId, m.chatId, conversationId, null, "model", "[]", "{}", new Date().toISOString());
            }
          },
        },
      );
      if (answer === null) return;
      const p = progress as Awaited<ReturnType<typeof startProgress>> | null;
      if (p) await p.finish(answer);
      else await reply(m.chatId, answer, m.messageId, !!m.topicId);
    } catch (e) {
      const p = progress as Awaited<ReturnType<typeof startProgress>> | null;
      if (p) await p.fail((e as Error).message);
      else throw e;
    }
  };

  const chatNames = new Map<string, string>();
  const groupName = (chatId: string) => chatNames.get(chatId) ?? chatId;
  const learnName = async (chatId: string) => {
    if (chatNames.has(chatId)) return;
    try {
      const r = await client.im.chat.get({ path: { chat_id: chatId } });
      if (r.data?.name) chatNames.set(chatId, r.data.name);
    } catch {}
  };

  /** Images and files sent to the bot (or in its groups) become sources; the ingest role reads them. */
  const saveResource = async (msg: { message_id: string; message_type: string; content: string }, m: Inbound) => {
    const c = JSON.parse(msg.content || "{}") as { image_key?: string; file_key?: string; file_name?: string };
    const key = c.image_key ?? c.file_key;
    if (!key) return;
    const dir = await mkdtemp(join(tmpdir(), "omem-lark-"));
    try {
      const name = c.file_name ?? `${msg.message_id}.png`;
      const file = join(dir, name.replace(/[\\/]/g, "_"));
      const res = await client.im.messageResource.get({ path: { message_id: msg.message_id, file_key: key }, params: { type: msg.message_type === "image" ? "image" : "file" } });
      await res.writeFile(file);
      const spaceId = m.chatType === "group" ? groupSpace(m.chatId) : cfg.defaultSpace;
      const r = await importFile(app, spaceId, file, `lark:${m.chatId}/${name}`);
      if (r && r.status !== "unchanged") scheduleIngest(app, spaceId, [r.id], `飞书${m.chatType === "group" ? "群" : "私聊"}附件`);
      if (m.chatType === "p2p") await reply(m.chatId, r ? `已保存「${name}」，助理会读取并整理。` : `「${name}」的格式暂不支持。`, m.messageId);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };

  /**
   * The bot's ids for the people in a message (sender and mentions carry open_id, and user_id when the
   * app may read it), so it can @ them later; the email is looked up once per new person.
   */
  const learnPeopleFromEvent = async (data: any) => {
    const { learnBotPerson, rememberPerson } = await import("./lark-people.ts");
    const people: { id?: { open_id?: string; user_id?: string }; name?: string }[] = [
      { id: data.sender?.sender_id },
      ...((data.message?.mentions ?? []) as { id?: { open_id?: string; user_id?: string }; name?: string }[]),
    ];
    for (const p of people) {
      const openId = p.id?.open_id;
      if (!openId || openId === botOpenId) continue;
      rememberPerson(app, { botOpenId: openId, userId: p.id?.user_id || null, name: p.name ?? "" });
      await learnBotPerson(app, client, openId);
    }
  };

  const dispatcher = new lark.EventDispatcher({ loggerLevel: lark.LoggerLevel.warn }).register({
    "im.message.receive_v1": async (data: any) => {
      const msg = data.message;
      const senderId = data.sender?.sender_id?.open_id ?? "";
      const mentions = ((msg.mentions ?? []) as { id?: { open_id?: string } }[]).map((x) => x.id?.open_id ?? "").filter(Boolean);
      if (msg.chat_type !== "p2p") void learnName(msg.chat_id);
      void learnPeopleFromEvent(data).catch(() => {});
      const m: Inbound = {
        chatId: msg.chat_id,
        chatType: msg.chat_type === "p2p" ? "p2p" : "group",
        messageId: msg.message_id,
        senderId,
        senderName: await nameOf(senderId),
        text: messageText(msg.content, msg.message_type),
        mentions,
        mentionsBot: !!botOpenId && mentions.includes(botOpenId),
        createTime: msg.create_time,
        topicId: msg.thread_id || undefined,
      };
      if ((msg.message_type === "image" || msg.message_type === "file") && (m.chatType === "group" || resolveIdentity(app, "lark", m.senderId)))
        saveResource(msg, m).catch((e) => console.warn("[omem] 飞书附件保存失败", e));
      if (msg.message_type !== "image" && msg.message_type !== "file") {
        if (resolveIdentity(app, "lark", m.senderId) === OWNER) m.quote = await fetchQuote(msg);
        handle(m).catch((e) => console.warn("[omem] 飞书消息处理失败", e));
      } else if (m.chatType === "group") captureGroup(m);
      return {};
    },
    "card.action.trigger": async (data: any) => {
      try {
        return await handleCardAction(app, data, nameOf);
      } catch (e) {
        console.warn("[omem] 卡片操作处理失败", e);
        return { toast: { type: "error", content: "处理失败，请稍后再试" } };
      }
    },
  } as never);
  const ws = new lark.WSClient({ appId: cfg.appId, appSecret, domain: lark.Domain.Feishu, loggerLevel: lark.LoggerLevel.warn });
  await ws.start({ eventDispatcher: dispatcher });
  console.log("[omem] 飞书机器人已连接");
}

