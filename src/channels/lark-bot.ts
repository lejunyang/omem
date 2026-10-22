import { isApp, persistChatMessages, type LarkMessage } from "./lark-messages.ts";
import { chatSpace } from "./lark-personal.ts";
import { itemNotificationCard } from "./item-notification.ts";
import * as lark from "@larksuiteoapi/node-sdk";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scheduleIngest } from "../agents/jobs.ts";
import { registerThreadSender } from "../agents/inbox.ts";
import type { App } from "../core/app.ts";
import { one, run } from "../core/db.ts";
import { addNotificationSink } from "../core/notify.ts";
import { identitiesOf, OWNER, resolveIdentity } from "../core/users.ts";
import { importFile, keepOriginal, needsDocumentConversion } from "../sources/import.ts";
import { inQuietHours } from "../core/notify.ts";
import { findSourceByUri, sourceText } from "../sources/store.ts";
import { answerFromChannel, resolveCitations } from "./common.ts";
import { registerCodeProgress } from "./lark-code-progress.ts";
import { startReplyProgress } from "./lark-progress.ts";
import { finishCot, setCotSdk } from "./lark-cot.ts";
import { watchAgentBubbles } from "./lark-agent-cot.ts";
import { handleCardAction } from "./lark-actions.ts";
import { reactLark, sendLark, setLarkClient, unreactLark } from "./lark-send.ts";
import { larkAppSecret } from "./lark-setup.ts";
import { routeWatchedMessages } from "./lark-watch.ts";
import { askAsGuest, guestsAllowed, ownerInChat, waitGuest } from "./lark-guest.ts";
import { claimedByRule, markAddressed } from "../rules/store.ts";
import { larkSenderNames } from "./lark-sender.ts";

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
  /** Feishu message type (text, post, share_chat…). */
  type?: string;
  raw?: string;
  parentId?: string;
  rootId?: string;
  /** @_user_N placeholders in the text → who they are. */
  mentionNames?: Record<string, { name: string; isBot: boolean }>;
  /** Sent by an app (alert cards, other bots). */
  fromApp?: boolean;
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
    if (type === "interactive") {
      // Visible text of the card; the API answers "请升级至最新版本客户端" for newer card schemas, which says nothing.
      const texts: string[] = [];
      const walk = (v: unknown) => {
        if (Array.isArray(v)) return v.forEach(walk);
        if (!v || typeof v !== "object") return;
        const o = v as Record<string, unknown>;
        if (typeof o.text === "string" && o.text.trim()) texts.push(o.text);
        else if (typeof o.content === "string" && o.content.trim()) texts.push(o.content);
        for (const x of Object.values(o)) if (x && typeof x === "object") walk(x);
      };
      walk(c.elements ?? c.body ?? []);
      const title = c.title ?? c.header?.title?.content ?? "";
      const body = texts.filter((t) => !/请升级至最新版本客户端/.test(t)).join(" ").replace(/\s+/g, " ").slice(0, 1500);
      return `[卡片]${title ? ` ${title}` : ""}${body ? ` ${body}` : ""}`;
    }
    return `[${type}]`;
  } catch {
    return raw;
  }
}

/** Messages that carry material but no instruction; the words usually follow, so the turn waits longer. */
export const CONTENT_ONLY_TYPES = new Set(["share_chat", "share_user", "merge_forward", "image", "file", "media", "audio", "sticker", "share_calendar_event"]);

type ContentLookups = {
  /** A group's name, or null when neither the bot nor the owner's lark-cli can read it. */
  chatName: (chatId: string) => Promise<string | null>;
  userName: (openId: string) => Promise<string>;
  /** The messages inside a merged forward (in order). */
  children: (messageId: string) => Promise<{ sender: string; type: string; content: string }[]>;
};

/**
 * Readable text for message kinds whose body is only ids (shared group, contact card, merged
 * forward). The agent gets the group's name and chat_id, and where its messages already are,
 * instead of a bare "[share_chat]".
 */
export async function describeLarkContent(app: App, msg: { messageId: string; type: string | undefined; content: string | undefined }, look: ContentLookups): Promise<string> {
  let c: Record<string, unknown> = {};
  try {
    c = JSON.parse(msg.content || "{}");
  } catch {}
  if (msg.type === "share_chat" && typeof c.chat_id === "string") {
    const chatId = c.chat_id;
    const name = await look.chatName(chatId).catch(() => null);
    const src = one<{ id: string }>(app.db, "select id from sources where uri = ? and deleted_at is null order by updated_at desc limit 1", `lark:${chatId}`);
    const where = src ? `已采集为原件 [${name ?? chatId}](src:${src.id})` : "还没有采集：要读它的消息，用 set_lark_subscription 订阅、set_lark_backfill 回溯";
    return `[分享群聊]「${name ?? "读不到群名"}」chat_id=${chatId}，${where}`;
  }
  if (msg.type === "share_user" && typeof c.user_id === "string") return `[分享名片] ${await look.userName(c.user_id)}`;
  if (msg.type === "merge_forward") {
    const items = await look.children(msg.messageId).catch(() => []);
    if (!items.length) return "[合并转发]（读不到其中的消息）";
    const lines = items.slice(0, 60).map((m) => `- ${m.sender}: ${messageText(m.content, m.type).replace(/\n/g, " ⏎ ").slice(0, 500)}`);
    return [`[合并转发] ${items.length} 条`, ...lines, ...(items.length > 60 ? [`- …另有 ${items.length - 60} 条`] : [])].join("\n");
  }
  return messageText(msg.content, msg.type);
}

/**
 * Feishu pushes an event again when it did not get the acknowledgement in time (after ~15 s, 5 min,
 * 1 h…). The first delivery wins, also across restarts; repeats would otherwise become new turns.
 */
export function firstDelivery(app: App, messageId: string) {
  return run(app.db, "insert or ignore into handled_messages(channel,message_id,rule,at) values('lark-bot',?,'',?)", messageId, new Date().toISOString()).changes > 0;
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
  setCotSdk(client);
  registerCodeProgress(app);
  watchAgentBubbles(app);

  const nameOf = larkSenderNames(app, client);

  const reply = (chatId: string, markdown: string, replyTo?: string, inThread = false) => sendLark(replyTo ? { replyTo, inThread } : { chatId }, { markdown });

  /**
   * Group names for shared group cards: the bot can only read groups it is in, so fall back to
   * what personal capture already knows, then to the owner's lark-cli (read-only).
   */
  const sharedChatNames = new Map<string, string | null>();
  const lookups: ContentLookups = {
    chatName: async (chatId) => {
      if (sharedChatNames.has(chatId)) return sharedChatNames.get(chatId)!;
      let name: string | null = one<{ name: string }>(app.db, "select name from lark_cursors where chat_id = ? and name != ''", chatId)?.name ?? null;
      if (!name) {
        const r = await client.im.chat.get({ path: { chat_id: chatId } }).catch(() => null);
        name = r?.data?.name || null;
      }
      if (!name) {
        const { larkCli } = await import("./lark-cli.ts");
        const v = await larkCli(["api", "GET", `/open-apis/im/v1/chats/${chatId}`, "--as", "user"], 20_000).catch(() => null);
        name = (v?.data?.name as string | undefined) || null;
      }
      sharedChatNames.set(chatId, name);
      return name;
    },
    userName: (openId) => nameOf(openId),
    children: async (messageId) => {
      const r = (await client.request({ method: "GET", url: `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`, params: { user_id_type: "open_id" } })) as {
        data?: { items?: { message_id?: string; msg_type?: string; body?: { content?: string }; sender?: { id?: string } }[] };
      };
      const items = (r.data?.items ?? []).filter((i) => i.message_id !== messageId);
      return Promise.all(items.map(async (i) => ({ sender: i.sender?.id ? await nameOf(i.sender.id) : "?", type: i.msg_type ?? "text", content: i.body?.content ?? "" })));
    },
  };


  // Later results for a thread (delegated agents…) go back to the same chat, inside the topic when there is one.
  registerThreadSender("lark", async (thread, raw, meta: Record<string, unknown> = {}) => {
    const [chatId, topic] = (thread.key ?? "").split("#");
    if (!chatId) return;
    // Internal citations and paths on this machine mean nothing in Feishu.
    const markdown = resolveCitations(app, raw);
    // First message of a multi-agent work topic: open the topic from the request message.
    if (!topic && typeof (meta as { openTopicFrom?: unknown }).openTopicFrom === "string") {
      const sent = await sendLark({ replyTo: String(meta.openTopicFrom), inThread: true }, { markdown });
      // Keep Feishu's thread id as is (omt_…): replies inside the topic arrive with the same id,
      // so they resolve to this work conversation instead of starting a second one.
      if (sent.threadId) {
        run(
          app.db,
          "update conversations set external_id = ?, settings = json_set(coalesce(settings,'{}'), '$.lastMessageId', ?), updated_at = ? where id = ?",
          `${chatId}#${sent.threadId}`,
          sent.messageId,
          new Date().toISOString(),
          thread.id,
        );
      }
      return;
    }
    // A digest carries the agent's full report: one message, the answer on top and the record folded below.
    const details = typeof meta.details === "string" && meta.details.trim() ? String(meta.details) : "";
    if (details) {
      const { buildCard } = await import("./lark-send.ts");
      const card = buildCard({ wide: true, blocks: [{ markdown }, { fold: { title: String(meta.detailsTitle ?? "完整记录"), markdown: resolveCitations(app, details) } }] });
      const to = thread.settings.lastMessageId ? { replyTo: thread.settings.lastMessageId, inThread: !!topic } : { chatId };
      await sendLark(to, { card });
      return;
    }
    await reply(chatId, markdown, thread.settings.lastMessageId, !!topic);
  });

  addNotificationSink(async (n) => {
    // Background work tied to a conversation goes there (its Feishu topic), never as a private DM.
    const inThread = (() => {
      const cid = (n as { larkConversationId?: string }).larkConversationId;
      if (!cid) return null;
      const t = one<{ external_id: string | null; last: string | null }>(app.db, "select external_id, json_extract(settings, '$.lastMessageId') last from conversations where id = ? and channel = 'lark'", cid);
      if (!t?.external_id) return null;
      const [chatId, topic] = t.external_id.split("#");
      return { chatId, inThread: !!topic, replyTo: t.last ?? undefined };
    })();
    const target = inThread
      ? (inThread.replyTo ? { replyTo: inThread.replyTo, inThread: inThread.inThread } : { chatId: inThread.chatId })
      : n.userId === OWNER
        ? (kv(app, "lark_owner_chat") ? { chatId: kv(app, "lark_owner_chat")! } : cfg.ownerOpenId ? { userId: cfg.ownerOpenId } : null)
        : { userId: identitiesOf(app, n.userId).find((i) => i.channel === "lark")?.external_id ?? "" };
    if (!target || (!("userId" in target) && !("chatId" in target) && !("replyTo" in target)) || ("userId" in target && !target.userId)) return;
    // Push policy: non-urgent nudges stay in-app at night; and when the triggering message is
    // already read by the owner, the change has been seen — no ping (urgent always pushes).
    if (n.urgency !== "urgent" && !n.scheduled && inQuietHours(app)) return;
    // Lessons from "忽略": a class of nudges the owner dismissed stays in-app.
    {
      const { aiIgnoreMatch } = await import("../core/notify-ai-gate.ts");
      const hit = await aiIgnoreMatch(app, n).catch(() => null);
      if (hit) { console.info(`[omem] 通知按忽略规则静默：${hit.rule.id}（${hit.reason}）`); return; }
    }
    // Suppress when the owner has clearly seen/handled the triggering chat:
    // read status, an OK/DONE reaction, or a later reply in the same topic.
    if (app.config.notify.onlyUnread && n.sourceRefs?.length) {
      const { ownerAlreadyHandled } = await import("./notify-gate.ts");
      if (await ownerAlreadyHandled(app, n).catch(() => false)) return;
    }
    // Internal citations/routes cannot be opened in Feishu: real originals become links, the rest plain text.
    const body = resolveCitations(app, n.body ?? "");
    if (n.entity === "item" && n.entityId) {
      // Actionable item card: 已处理 / 忽略 resolve the item directly, no agent turn.
      const { recordInteraction } = await import("./lark-send.ts");
      const card = itemNotificationCard(app, n);
      const sent = await sendLark(target, { card });
      recordInteraction(app, { messageId: sent.messageId, chatId: ("chatId" in target ? target.chatId : null) ?? null, conversationId: null, runId: null, purpose: "agent", allowed: [], payload: { itemId: n.entityId, notificationId: n.id, userId: n.userId } });
      return;
    }
    const markdown = `**${n.title}**\n${body}`;
    await sendLark(target, { markdown });
  });

  const pending = new Map<string, NodeJS.Timeout>();
  const lastCapture = new Map<string, string>();
  const groupSpace = (chatId: string) => chatSpace(app, chatId);
  const captureGroup = (m: Inbound) => {
    const spaceId = groupSpace(m.chatId);
    const uri = `lark:${m.chatId}`;
    const before = findSourceByUri(app, spaceId, uri);
    const message: LarkMessage = { message_id: m.messageId, chat_id: m.chatId, msg_type: m.type ?? "text",
      content: m.text, raw_content: m.raw, create_time: m.createTime, thread_id: m.topicId, parent_id: m.parentId, root_id: m.rootId,
      sender: { id: m.senderId, name: m.senderName, sender_type: m.fromApp ? "app" : "user" }, mentions: m.mentions.map(id => ({ id })) };
    const r = persistChatMessages(app, { chatId: m.chatId, spaceId, name: before?.title ?? groupName(m.chatId), messages: [message], owner: cfg.ownerOpenId });
    if (!r.id) return;
    lastCapture.set(m.messageId, r.id);
    if (r.status === "unchanged") return;
    // Debounce: hand a burst of messages to the ingest role once.
    const sourceId = r.id;
    const key = `${spaceId}:${sourceId}`;
    clearTimeout(pending.get(key));
    pending.set(
      key,
      setTimeout(() => {
        pending.delete(key);
        scheduleIngest(app, spaceId, [sourceId], "飞书群新消息");
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
      // The message API says msg_type and sender.id (a string); the event says message_type and sender_id.open_id.
      const orig = items[0] as { body?: { content?: string }; msg_type?: string; message_type?: string; sender?: { id?: string | { open_id?: string } } } | undefined;
      if (!orig) return { messageId: parentId };
      const senderId = typeof orig.sender?.id === "string" ? orig.sender.id : orig.sender?.id?.open_id;
      const own = one<{ text: string }>(app.db, "select text from messages where role = 'assistant' and json_extract(meta, '$.larkMessageId') = ? order by created_at desc limit 1", parentId);
      const text = own ? `（助手之前的回复）${own.text}` : await describeLarkContent(app, { messageId: parentId, type: orig.msg_type ?? orig.message_type, content: orig.body?.content }, lookups);
      return { messageId: parentId, sender: senderId ? await nameOf(senderId) : undefined, text: text.slice(0, 2000) || undefined };
    } catch {
      return { messageId: parentId };
    }
  };

  /** Rules see the groups the bot is in as messages arrive (the capture sees them later, deduplicated). */
  const dispatchToRules = async (m: Inbound) => {
    if (m.senderId === botOpenId) return;
    const email = one<{ email: string | null }>(app.db, "select email from lark_people where bot_open_id = ?", m.senderId)?.email ?? null;
    await import("../rules/engine.ts")
      .then(({ dispatchRuleEvent }) =>
        dispatchRuleEvent(app, {
          key: `lark:${m.messageId}`,
          kind: "message",
          at: new Date(Number(m.createTime) || Date.now()).toISOString(),
          chat: { id: m.chatId, name: groupName(m.chatId), kind: "group" },
          sender: { id: m.senderId, name: m.senderName, email, kind: m.senderId === cfg.ownerOpenId ? "owner" : m.fromApp ? "bot" : "user" },
          message: { id: m.messageId, text: m.text, type: m.type ?? "text", mentionsOwner: !!cfg.ownerOpenId && m.mentions.includes(cfg.ownerOpenId), mentionsBot: m.mentionsBot, topicId: m.topicId ?? null, cardTitle: /<card title="([^"]*)"/.exec(m.text)?.[1] ?? null },
          via: "bot",
        }),
      )
      .catch(() => {});
  };

  /** The bot's own @ goes away; other people keep their name (「结合 @小李 在文档里…」 means something). */
  const spoken = (m: Inbound) =>
    m.text.replace(/@_user_\d+/g, (key) => {
      const who = m.mentionNames?.[key];
      return who && !who.isBot ? `@${who.name}` : "";
    }).replace(/[ \t]{2,}/g, " ").trim();

  /**
   * Someone who is not a user (or another bot) asked the bot: the gatekeeper decides, the guest
   * role answers in restricted mode (lark-guest.ts). Another bot's message goes to the rules
   * first; only when no rule took it does the gatekeeper look at it.
   */
  /** Returns true when the assistant itself should answer (a group the owner is in, `ownerPresent` gated or free). */
  const answerGuest = async (m: Inbound, ruled: Promise<void> | null): Promise<boolean> => {
    if (m.fromApp) {
      if (m.chatType !== "group" || !app.config.lark.guests.enabled) return false;
      await ruled;
      if (claimedByRule(app, `lark:${m.messageId}`)) return false;
    } else if (!guestsAllowed(app, m.chatType)) return false;
    const text = spoken(m);
    if (!text) return false;
    const mode = app.config.lark.guests.ownerPresent;
    const withOwner = !m.fromApp && m.chatType === "group" && mode !== "guest" && (await ownerInChat(app, m.chatId));
    if (withOwner && mode === "free") return true;
    const r = askAsGuest(app, {
      chatId: m.chatId, chatType: m.chatType, chatName: m.chatType === "group" ? groupName(m.chatId) : undefined, messageId: m.messageId,
      senderId: m.senderId, senderName: m.senderName, fromApp: !!m.fromApp, text,
      context: m.chatType === "group" ? groupContext(m) : "", groupSpace: m.chatType === "group" ? groupSpace(m.chatId) : undefined,
      gateOnly: withOwner,
    });
    if (!r) return false; // over the hourly limit: quietly
    const working = await reactLark(m.messageId, "OnIt").catch(() => undefined);
    const v = await waitGuest(app, r.id).catch(() => null);
    if (working) await unreactLark(m.messageId, working);
    if (withOwner && v?.verdict === "answer") return true;
    const say = v?.verdict === "refuse" ? v.reply : v?.verdict === "answer" ? v.answer : "";
    if (say) await reply(m.chatId, resolveCitations(app, say), m.messageId, !!m.topicId).catch((e) => console.warn("[omem] 飞书访客回复失败", e));
    return false;
  };

  const handle = async (m: Inbound) => {
    let ruled: Promise<void> | null = null;
    if (m.chatType === "group") {
      captureGroup(m);
      // A person @-ing the bot asks it directly, and it answers (a user, or a guest when allowed):
      // the rules (waits, silent checks) are for what nobody asked and step aside.
      if (m.mentionsBot && !m.fromApp && (resolveIdentity(app, "lark", m.senderId) || guestsAllowed(app, "group"))) markAddressed(app, `lark:${m.messageId}`);
      else ruled = dispatchToRules(m).catch(() => {});
      await routeWatchedMessages(app, m.chatId, groupName(m.chatId), [{ id: m.messageId, time: m.createTime, sender: m.senderName, senderId: m.senderId, text: m.text, topicId: m.topicId, mentions: m.mentions }], { botOpenId });
      if (!m.mentionsBot) return;
    }
    if (!cfg.ownerOpenId) {
      await reply(m.chatId, `还没有绑定本人。请在 omem 配置中设置 \`lark.ownerOpenId\` 为：\`${m.senderId}\`，然后重启服务。`, m.messageId);
      return;
    }
    let userId = m.fromApp ? null : resolveIdentity(app, "lark", m.senderId);
    // Not the owner and not a registered user (omem user add … --lark <open_id>): guest mode, when on.
    // In a group the owner is in, the owner may let colleagues talk to the assistant itself.
    let asker: string | undefined;
    if (!userId) {
      if (!(await answerGuest(m, ruled))) return;
      userId = OWNER;
      asker = m.senderName;
    }
    if (m.chatType === "p2p" && userId === OWNER) kv(app, "lark_owner_chat", m.chatId);
    const text = spoken(m);
    const context = m.chatType === "group" ? groupContext(m) : "";
    if (!text) return;
    let presentation: ReturnType<typeof startReplyProgress> | undefined;
    let runId: string | null = null;
    let answered = false;
    try {
      const answer = await answerFromChannel(
        app,
        {
          channel: "lark",
          chatId: m.chatId,
          topicId: m.topicId,
          isGroup: m.chatType === "group",
          text,
          asker,
          spaceId: m.chatType === "group" ? groupSpace(m.chatId) : userId === OWNER ? cfg.defaultSpace : undefined,
          context,
          contextLabel: m.topicId ? "话题里" : "群里",
          externalMessageId: m.messageId,
          quote: m.quote,
          userId,
          // Material without words: the instruction usually comes right after; the next message shortens the wait again.
          mergeMs: m.type && CONTENT_ONLY_TYPES.has(m.type) ? Math.max(app.config.sessions.mergeMs, app.config.sessions.contentWaitMs) : undefined,
        },
        {
          onStart: async (id) => {
            runId = id;
            presentation = startReplyProgress(app, { chatId: m.chatId, messageId: m.messageId, inThread: !!m.topicId }, id);
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
      answered = true;
      if (runId) finishCot(app, runId, true);
      const p = await presentation?.close();
      const sentId = p ? (await p.finish(answer), p.messageId) : (await reply(m.chatId, answer, m.messageId, !!m.topicId)).messageId;
      if (runId && !p) await reactLark(m.messageId, "DONE").catch(() => {});
      // A later quote of this reply reads back as an empty card; this maps it to the answer.
      if (runId && sentId) run(app.db, "update messages set meta = json_set(meta, '$.larkMessageId', ?) where run_id = ? and role = 'assistant'", sentId, runId);
    } catch (e) {
      if (runId && !answered) finishCot(app, runId, false);
      const p = await presentation?.close();
      if (p) await p.fail((e as Error).message);
      else throw e;
    } finally {
      await presentation?.close();
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
    const key = c.file_key ?? c.image_key;
    if (!key) return;
    if (m.chatType === "group" && one(app.db, "select 1 from lark_messages m,json_each(m.resources) r where m.chat_id=? and m.message_id=? and r.key=?", m.chatId, m.messageId, key)) return;
    const dir = await mkdtemp(join(tmpdir(), "omem-lark-"));
    try {
      const name = c.file_name ?? `${msg.message_id}.${msg.message_type === "media" ? "mp4" : msg.message_type === "audio" ? "ogg" : msg.message_type === "image" ? "png" : "bin"}`;
      const file = join(dir, name.replace(/[\\/]/g, "_"));
      const res = await client.im.messageResource.get({ path: { message_id: msg.message_id, file_key: key }, params: { type: msg.message_type === "image" ? "image" : "file" } });
      await res.writeFile(file);
      const spaceId = m.chatType === "group" ? groupSpace(m.chatId) : cfg.defaultSpace;
      const stored = keepOriginal(app, file);
      const deferred = m.chatType === "group" && needsDocumentConversion(file);
      const r = deferred ? null : await importFile(app, spaceId, file, `lark:${m.chatId}/${name}`);
      if (m.chatType === "group") {
        persistChatMessages(app, { chatId: m.chatId, spaceId, name: groupName(m.chatId), messages: [{ message_id: m.messageId, chat_id: m.chatId, msg_type: m.type ?? "file", content: m.text, raw_content: m.raw, create_time: m.createTime, thread_id: m.topicId, parent_id: m.parentId, root_id: m.rootId, sender: { id: m.senderId, name: m.senderName, sender_type: m.fromApp ? "app" : "user" } }], resources: new Map([[m.messageId, { [key]: { type: msg.message_type, sourceId: r?.id, file: stored, name, ...(deferred ? { parse: { status: "pending" as const } } : {}) } }]]) });
      }
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
      ...(isApp({ sender: data.sender }) ? [] : [{ id: data.sender?.sender_id }]),
      ...((data.message?.mentions ?? []) as { id?: { open_id?: string; user_id?: string }; name?: string }[]),
    ];
    for (const p of people) {
      const openId = p.id?.open_id;
      if (!openId?.startsWith("ou_") || openId === botOpenId) continue;
      rememberPerson(app, { botOpenId: openId, userId: p.id?.user_id || null, name: p.name ?? "" });
      await learnBotPerson(app, client, openId);
    }
  };

  /** Everything after the acknowledgement: names, quotes and the turn may take seconds. */
  const processEvent = async (data: any) => {
    const msg = data.message;
    const senderId = data.sender?.sender_id?.open_id ?? "";
    const fromApp = isApp({ sender: data.sender });
    const mentions = ((msg.mentions ?? []) as { id?: { open_id?: string } }[]).map((x) => x.id?.open_id ?? "").filter(Boolean);
    if (msg.chat_type !== "p2p") await learnName(msg.chat_id);
    void learnPeopleFromEvent(data).catch(() => {});
    const m: Inbound = {
      chatId: msg.chat_id,
      chatType: msg.chat_type === "p2p" ? "p2p" : "group",
      messageId: msg.message_id,
      senderId,
      senderName: await nameOf(senderId, { id: msg.message_id, chatId: msg.chat_id, fromApp }),
      text: await describeLarkContent(app, { messageId: msg.message_id, type: msg.message_type, content: msg.content }, lookups),
      mentions,
      mentionsBot: !!botOpenId && mentions.includes(botOpenId),
      createTime: msg.create_time,
      topicId: msg.thread_id || undefined,
      type: msg.message_type,
      fromApp,
      raw: msg.content, parentId: msg.parent_id, rootId: msg.root_id,
      mentionNames: Object.fromEntries(
        ((msg.mentions ?? []) as { key?: string; name?: string; id?: { open_id?: string } }[])
          .filter((x) => x.key)
          .map((x) => [x.key!, { name: x.name ?? "", isBot: !!botOpenId && x.id?.open_id === botOpenId }]),
      ),
    };
    if ((["image", "file"].includes(msg.message_type) || (m.chatType === "group" && ["media", "audio"].includes(msg.message_type))) && (m.chatType === "group" || resolveIdentity(app, "lark", m.senderId)))
      saveResource(msg, m).catch((e) => console.warn("[omem] 飞书附件保存失败", e));
    if (msg.message_type !== "image" && msg.message_type !== "file") {
      if (resolveIdentity(app, "lark", m.senderId) === OWNER) m.quote = await fetchQuote(msg);
      await handle(m);
    } else if (m.chatType === "group") captureGroup(m);
  };

  const dispatcher = new lark.EventDispatcher({ loggerLevel: lark.LoggerLevel.warn }).register({
    // Acknowledge at once: Feishu redelivers an event it has not heard back about within a few
    // seconds, and a slow handler also holds back the messages sent right after it.
    "im.message.receive_v1": async (data: any) => {
      if (!data?.message?.message_id || !firstDelivery(app, data.message.message_id)) return {};
      processEvent(data).catch((e) => console.warn("[omem] 飞书消息处理失败", e));
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
