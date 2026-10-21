import { queueCaptureEvent, drainCaptureEvents, queueRetentionRefresh } from "./lark-event-queue.ts";
import { persistChatMessages, type LarkMessage } from "./lark-messages.ts";
import { chatSpace } from "./lark-personal.ts";
import { detectRetention, retentionRule, retentionState, retentionLifecycle, saveRetention } from "./lark-retention.ts";
import { itemNotificationCard } from "./item-notification.ts";
import * as lark from "@larksuiteoapi/node-sdk";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scheduleIngest } from "../agents/jobs.ts";
import { registerThreadSender } from "../agents/inbox.ts";
import type { App } from "../core/app.ts";
import { sha256 } from "../core/util.ts";
import { one, run } from "../core/db.ts";
import { addNotificationSink } from "../core/notify.ts";
import { identitiesOf, OWNER, resolveIdentity, userName } from "../core/users.ts";
import { importFile, keepOriginal } from "../sources/import.ts";
import { inQuietHours } from "../core/notify.ts";
import { findSourceByUri, sourceText } from "../sources/store.ts";
import { getRun } from "../agents/runs.ts";
import { answerFromChannel, resolveCitations } from "./common.ts";
import { registerCodeProgress } from "./lark-code-progress.ts";
import { startProgress } from "./lark-progress.ts";
import { cotAvailable, cotEvent, cotLiveFor, finishCot, setCotSdk, startCot } from "./lark-cot.ts";
import { watchAgentBubbles } from "./lark-agent-cot.ts";
import { handleCardAction } from "./lark-actions.ts";
import { reactLark, sendLark, setLarkClient, unreactLark } from "./lark-send.ts";
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
  /** Feishu message type (text, post, share_chat…). */
  type?: string;
  captureChanged?: boolean;
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
/** Resource keys embedded in posts/cards are message resources too, when Feishu permits reading them. */
export function embeddedLarkResources(raw: string): { key: string; type: "image" | "file"; name?: string }[] {
  const found = new Map<string, { key: string; type: "image" | "file"; name?: string }>();
  const walk = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    const obj = value as Record<string, unknown>;
    const image = obj.image_key ?? obj.img_key;
    if (typeof image === "string") found.set(image, { key: image, type: "image" });
    if (typeof obj.file_key === "string") found.set(obj.file_key, { key: obj.file_key, type: "file", name: typeof obj.file_name === "string" ? obj.file_name : undefined });
    for (const child of Object.values(obj)) walk(child);
  };
  try { walk(JSON.parse(raw)); } catch { /* readable text has no raw resource keys */ }
  return [...found.values()];
}

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
      sender: { id: m.senderId, name: m.senderName }, mentions: m.mentions.map(id => ({ id })) };
    const r = persistChatMessages(app, { chatId: m.chatId, spaceId, name: before?.title ?? groupName(m.chatId), messages: [message], owner: cfg.ownerOpenId });
    if (!r.id) return;
    const state = retentionState(app, m.chatId);
    if (state) saveRetention(app, { ...state, botEventAt: Date.now() });
    lastCapture.set(m.messageId, r.id);
    if (r.status === "unchanged" && !m.captureChanged) return;
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
  const dispatchToRules = (m: Inbound) => {
    if (m.senderId === botOpenId) return;
    const email = one<{ email: string | null }>(app.db, "select email from lark_people where bot_open_id = ?", m.senderId)?.email ?? null;
    void import("../rules/engine.ts")
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

  const handle = async (m: Inbound) => {
    if (m.chatType === "group") {
      captureGroup(m);
      if (retentionRule(app, m.chatId)) return; // retention is capture-only, even if the bot was also mentioned
      dispatchToRules(m);
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
    // The bot's own @ goes away; other people keep their name (「结合 @小李 在文档里…」 means something).
    const text = m.text.replace(/@_user_\d+/g, (key) => {
      const who = m.mentionNames?.[key];
      return who && !who.isBot ? `@${who.name}` : "";
    }).replace(/[ \t]{2,}/g, " ").trim();
    const context = m.chatType === "group" ? groupContext(m) : "";
    if (!text) return;
    let progress: Awaited<ReturnType<typeof startProgress>> | null = null;
    let runId: string | null = null;
    /** The "处理中" reaction when the bubble shows the process and no progress card was sent. */
    let working: string | undefined;
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
          // Material without words: the instruction usually comes right after; the next message shortens the wait again.
          mergeMs: m.type && CONTENT_ONLY_TYPES.has(m.type) ? Math.max(app.config.sessions.mergeMs, app.config.sessions.contentWaitMs) : undefined,
        },
        {
          onStart: async (id) => {
            runId = id;
            // A run can be queued behind another turn in this thread; only start the
            // bubble/progress once it actually runs, otherwise the cards sit frozen while
            // the user waits on a previous turn.
            const card = () => startProgress(app, { messageId: m.messageId, inThread: !!m.topicId }, id).then((p) => { progress = p; }).catch(() => {});
            const begin = async () => {
              // Native collapsible thinking bubble (message_cot) when available: it shows the
              // process, and the answer comes as its own message when it is ready. The progress
              // card is only the fallback, for when the bubble has not shown anything after a while.
              if (!cotAvailable() || !startCot(app, id, { chatId: m.chatId, originMessageId: m.messageId, inThread: !!m.topicId })) return card();
              const listener = (e: { type: string; runId?: string; event?: { type: string; data: unknown } }) => {
                if (e.runId !== id || !e.event) return;
                cotEvent(app, id, { type: e.event.type, data: e.event.data });
                if (cotLiveFor(id)) progress?.setMinimal(true);
              };
              app.events.on("event", listener);
              const t = setTimeout(() => app.events.off("event", listener), 30 * 60_000);
              t.unref();
              working = await reactLark(m.messageId, "OnIt").catch(() => undefined);
              setTimeout(() => {
                if (!cotLiveFor(id) && getRun(app, id).status === "running") void card();
              }, 15_000).unref();
            };
            const st = getRun(app, id).status;
            if (st === "running") void begin();
            else {
              const onRun = (e: { type: string; runId?: string; status?: string }) => {
                if (e.type === "run" && e.runId === id) {
                  if (e.status === "running") { app.events.off("event", onRun); void begin(); }
                  else if (e.status === "done" || e.status === "failed" || e.status === "cancelled") app.events.off("event", onRun);
                }
              };
              app.events.on("event", onRun);
            }
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
      if (runId) finishCot(app, runId, true);
      const p = progress as Awaited<ReturnType<typeof startProgress>> | null;
      const sentId = p ? (await p.finish(answer), p.messageId) : (await reply(m.chatId, answer, m.messageId, !!m.topicId)).messageId;
      if (working) {
        await unreactLark(m.messageId, working).catch(() => {});
        await reactLark(m.messageId, "DONE").catch(() => {});
      }
      // A later quote of this reply reads back as an empty card; this maps it to the answer.
      if (runId && sentId) run(app.db, "update messages set meta = json_set(meta, '$.larkMessageId', ?) where run_id = ? and role = 'assistant'", sentId, runId);
    } catch (e) {
      if (runId) finishCot(app, runId, false);
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
    if (m.chatType === "group" && one(app.db, "select 1 from lark_messages m,json_each(m.resources) r where m.chat_id=? and m.message_id=? and r.key=?", m.chatId, m.messageId, key)) return;
    const dir = await mkdtemp(join(tmpdir(), "omem-lark-"));
    try {
      const name = c.file_name ?? `${msg.message_id}.png`;
      const file = join(dir, name.replace(/[\\/]/g, "_"));
      const res = await client.im.messageResource.get({ path: { message_id: msg.message_id, file_key: key }, params: { type: msg.message_type === "image" ? "image" : "file" } });
      await res.writeFile(file);
      const spaceId = m.chatType === "group" ? groupSpace(m.chatId) : cfg.defaultSpace;
      const r = await importFile(app, spaceId, file, `lark:${m.chatId}/${name}`);
      if (m.chatType === "group") {
        persistChatMessages(app, { chatId: m.chatId, spaceId, name: groupName(m.chatId), messages: [{ message_id: m.messageId, chat_id: m.chatId, msg_type: m.type ?? "file", content: m.text, raw_content: m.raw, create_time: m.createTime, thread_id: m.topicId, parent_id: m.parentId, root_id: m.rootId, sender: { id: m.senderId, name: m.senderName } }], resources: new Map([[m.messageId, { [key]: { type: msg.message_type, sourceId: r?.id, file: keepOriginal(app, file), name } }]]) });
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

  /** Everything after the acknowledgement: names, quotes and the turn may take seconds. */
  const processEvent = async (data: any, updateOnly = false, resourceKey?: string) => {
    const msg = data.message;
    const senderId = data.sender?.sender_id?.open_id ?? "";
    const retained = msg.chat_type !== "p2p" && !!retentionRule(app, msg.chat_id);
    const snapshotKey = `lark_bot_snapshot:${msg.message_id}`;
    const snapshot = sha256(JSON.stringify([msg.content, msg.message_type, msg.thread_id, msg.parent_id, msg.root_id, msg.mentions, senderId]));
    // Only completed processing records a snapshot: resource/enrichment failures must retry.
    if (updateOnly && !resourceKey && retained && kv(app, snapshotKey) === snapshot) return;
    let captureChanged = false;
    if (retained && (!updateOnly || !one(app.db, "select 1 from lark_messages where chat_id=? and message_id=?", msg.chat_id, msg.message_id))) {
      const raw: LarkMessage = { message_id: msg.message_id, chat_id: msg.chat_id, msg_type: msg.message_type,
        content: messageText(msg.content, msg.message_type), raw_content: msg.content, create_time: msg.create_time,
        thread_id: msg.thread_id, parent_id: msg.parent_id, root_id: msg.root_id,
        sender: { id: senderId }, mentions: msg.mentions };
      detectRetention(app, raw, cfg.ownerOpenId, "bot");
      captureChanged = persistChatMessages(app, { chatId: msg.chat_id, spaceId: groupSpace(msg.chat_id), name: groupName(msg.chat_id), messages: [raw], owner: cfg.ownerOpenId }).status !== "unchanged";
    }

    const mentions = ((msg.mentions ?? []) as { id?: { open_id?: string } }[]).map((x) => x.id?.open_id ?? "").filter(Boolean);
    if (msg.chat_type !== "p2p") void learnName(msg.chat_id);
    void learnPeopleFromEvent(data).catch(() => {});
    const m: Inbound = {
      chatId: msg.chat_id,
      chatType: msg.chat_type === "p2p" ? "p2p" : "group",
      messageId: msg.message_id,
      senderId,
      senderName: await nameOf(senderId),
      text: await describeLarkContent(app, { messageId: msg.message_id, type: msg.message_type, content: msg.content }, lookups),
      mentions,
      mentionsBot: !!botOpenId && mentions.includes(botOpenId),
      createTime: msg.create_time,
      topicId: msg.thread_id || undefined,
      type: msg.message_type,
      fromApp: data.sender?.sender_type === "app",
      captureChanged, raw: msg.content, parentId: msg.parent_id, rootId: msg.root_id,
      mentionNames: Object.fromEntries(
        ((msg.mentions ?? []) as { key?: string; name?: string; id?: { open_id?: string } }[])
          .filter((x) => x.key)
          .map((x) => [x.key!, { name: x.name ?? "", isBot: !!botOpenId && x.id?.open_id === botOpenId }]),
      ),
    };
    if (m.chatType === "group") detectRetention(app, { message_id: m.messageId, chat_id: m.chatId, msg_type: m.type ?? "text", content: msg.content, create_time: m.createTime, mentions: m.mentions.map(id => ({ id })) }, cfg.ownerOpenId, "bot");
    // Existing refreshes render before saving, avoiding a raw/rendered rewrite of unchanged lines.
    // Save the rendered body before resource work so a failed attachment cannot lose an edit.
    if (updateOnly && m.chatType === "group") captureGroup(m);
    if ((msg.message_type === "image" || msg.message_type === "file") && (m.chatType === "group" || resolveIdentity(app, "lark", m.senderId))) {
      if (m.chatType === "group" && retentionRule(app, m.chatId)) await saveResource(msg, m);
      else saveResource(msg, m).catch((e) => console.warn("[omem] 飞书附件保存失败", e));
    }
    if (m.chatType === "group" && retentionRule(app, m.chatId) && ["post", "interactive"].includes(msg.message_type)) {
      for (const ref of embeddedLarkResources(msg.content)) {
        if (resourceKey && resourceKey!==ref.key) continue;
        try { await saveResource({ message_id:m.messageId,message_type:ref.type,content:JSON.stringify(ref.type==="image" ? {image_key:ref.key} : {file_key:ref.key,file_name:ref.name}) },m); }
        catch (e) {
          if (resourceKey) throw e;
          // A permanently inaccessible card asset must not suppress later body/card updates.
          queueCaptureEvent(app,`resource:${m.messageId}:${ref.key}`,{updateId:m.messageId,resourceKey:ref.key});
        }
      }
    }
    if (msg.message_type !== "image" && msg.message_type !== "file") {
      if (resolveIdentity(app, "lark", m.senderId) === OWNER) m.quote = await fetchQuote(msg);
      if (updateOnly) { if (m.chatType === "group") captureGroup(m); }
      else await handle(m);
    } else if (m.chatType === "group") captureGroup(m);
    if (retained && !resourceKey) kv(app, snapshotKey, snapshot);
  };

  const processQueuedEvent = async (data: any) => {
    if (!data.updateId) {
      if (!retentionRule(app, data.message?.chat_id)) throw new Error("保留规则已停用，暂停事件处理");
      return processEvent(data);
    }
    const r = await client.im.message.get({ path: { message_id: data.updateId } });
    if (r.code || !r.data?.items?.length) throw new Error("读取更新消息失败");
    for (const msg of r.data.items) {
      if (!retentionRule(app, msg.chat_id!)) throw new Error("保留规则已停用，暂停消息回读");
      await processEvent({ sender: { sender_id: { open_id: msg.sender?.id } }, message: { ...msg, chat_type: "group", message_type: msg.msg_type, content: msg.body?.content } }, true, data.resourceKey);
    }
  };

  // Also drain events acknowledged by the previous process. No user-token read is required.
  const retryCapture = () => {
    queueRetentionRefresh(app);
    void drainCaptureEvents(app, processQueuedEvent);
  };
  retryCapture();
  const captureRetry = setInterval(retryCapture, 60_000);
  captureRetry.unref();

  const dispatcher = new lark.EventDispatcher({ loggerLevel: lark.LoggerLevel.warn }).register({
    // Acknowledge at once: Feishu redelivers an event it has not heard back about within a few
    // seconds, and a slow handler also holds back the messages sent right after it.
    "im.message.receive_v1": async (data: any) => {
      if (!data?.message?.message_id) return {};
      if (data.message.chat_type !== "p2p" && retentionRule(app, data.message.chat_id)) {
        queueCaptureEvent(app, data.message.message_id, data);
        void drainCaptureEvents(app, processQueuedEvent);
        return {};
      }
      if (!firstDelivery(app, data.message.message_id)) return {};
      processEvent(data).catch((e) => console.warn("[omem] 飞书消息处理失败", e));
      return {};
    },
    "im.chat.member.bot.added_v1": async (data: any) => {
      const state = data.chat_id && retentionState(app, data.chat_id);
      if (state && retentionRule(app, data.chat_id)) saveRetention(app, { ...state, invite: "joined", lifecycle: state.lifecycle === "bot-removed" ? undefined : state.lifecycle });
      return {};
    },
    "im.chat.disbanded_v1": async (data: any) => { if (data.chat_id) retentionLifecycle(app, data.chat_id, "disbanded"); return {}; },
    "im.chat.member.bot.deleted_v1": async (data: any) => { if (data.chat_id) retentionLifecycle(app, data.chat_id, "bot-removed"); return {}; },
    "im.chat.member.user.deleted_v1": async (data: any) => {
      if (data.chat_id && cfg.ownerOpenId && data.users?.some((u: any) => u.user_id?.open_id === cfg.ownerOpenId)) retentionLifecycle(app, data.chat_id, "owner-removed");
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
