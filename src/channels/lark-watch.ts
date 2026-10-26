import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { notify } from "../core/notify.ts";
import { HttpError, now } from "../core/util.ts";
import { receive } from "../agents/inbox.ts";
import { findAgentSpec } from "../agents/specs.ts";
import { chatSettings, setChatSettings, type WatchRule } from "../agents/threads.ts";

/**
 * Watched chats: an alert group, an on-call group, a group the owner asked the assistant to keep
 * an eye on for a while… Each has a rule naming who handles its messages (the main assistant, or
 * an agent spec the owner wrote), which messages count, whether it may reply through the bot
 * (never, as a draft the owner approves, or directly), what for (the owner's words) and until when.
 *
 * Messages arrive from the bot (real time, when the bot is in the group) or from the owner's
 * capture (polling, any chat the owner is in). Each message is handled once. A watched chat is one
 * thread of channel `lark-watch` (topics included): the handler reads the group in one context and
 * decides itself which topics deserve their own work. Messages are handed over in batches: the
 * window (`batchMinutes`) is the handler's to adjust; a message that @s the owner or the bot
 * shortens it. Past `expiresAt` the watch ends.
 */
export const WATCH_CHANNEL = "lark-watch";

/** A message that @s the owner or the bot is looked at within this, whatever the batch window. */
const MENTION_MS = 30_000;
/** Default batch window of a watch the assistant sets up. */
export const DEFAULT_BATCH_MINUTES = 10;

export type ChatMessage = { id: string; time: string; sender: string; senderId?: string; text: string; topicId?: string; mentions?: string[] };

export function watchRule(app: App, chatId: string): WatchRule | null {
  return chatSettings(app, WATCH_CHANNEL, chatId).watch ?? null;
}

export function setWatchRule(app: App, chatId: string, rule: WatchRule | null) {
  if (rule) {
    if (rule.spec !== "assistant" && !findAgentSpec(app, rule.spec)) throw new Error(`没有 Agent 档案 ${rule.spec}：先建好处理这个群的 Agent（说明怎么处理、用哪些技能和工具），或交给 assistant`);
    if (rule.on === "keyword") new RegExp(rule.pattern ?? "");
  }
  return setChatSettings(app, WATCH_CHANNEL, chatId, {
    watch: rule ?? undefined,
    spec: rule && rule.spec !== "assistant" ? rule.spec : undefined,
    spaceId: rule?.spaceId,
    // One context for the whole group: the handler tells topics apart itself.
    mode: "chat",
    idleHours: 0,
    lark: rule ? { chats: rule.reply === "none" ? [] : [chatId], draft: rule.reply === "draft" } : undefined,
  });
}

/** Watches past their time end (heartbeat; also checked when a message arrives). */
export function expireWatches(app: App, at = now()) {
  const due = all<{ chat_id: string; until: string; name: string | null }>(app.db,
    "select chat_id, json_extract(settings, '$.watch.expiresAt') until, (select title from conversations c where c.channel = ? and c.external_id = chat_id order by updated_at desc limit 1) name from chat_settings where channel = ? and json_extract(settings, '$.watch.expiresAt') < ?",
    WATCH_CHANNEL, WATCH_CHANNEL, at);
  for (const w of due) {
    setWatchRule(app, w.chat_id, null);
    notify(app, { title: `不再盯「${w.name ?? w.chat_id}」了`, body: `到了设定的时间（${w.until.slice(0, 16).replace("T", " ")}）。还要继续就再说一声。` });
  }
  return due.length;
}

function mentioned(m: ChatMessage, who: { ownerOpenId?: string; botOpenId?: string | null; ownerName?: string }) {
  const ids = m.mentions ?? [];
  return (!!who.ownerOpenId && ids.includes(who.ownerOpenId)) || (!!who.botOpenId && ids.includes(who.botOpenId)) || (!!who.ownerName && m.text.includes(`@${who.ownerName}`));
}

function matches(rule: WatchRule, m: ChatMessage, who: { ownerOpenId?: string; botOpenId?: string | null; ownerName?: string }) {
  if (rule.on === "all") return true;
  if (rule.on === "keyword") {
    try {
      return new RegExp(rule.pattern ?? "", "i").test(m.text);
    } catch {
      return false;
    }
  }
  return mentioned(m, who);
}

/** Hand new messages of a watched chat to its handler. Returns how many were handed over. */
export async function routeWatchedMessages(app: App, chatId: string, chatName: string, messages: ChatMessage[], opts: { botOpenId?: string | null } = {}) {
  const rule = watchRule(app, chatId);
  if (!rule) return 0;
  if (rule.expiresAt && rule.expiresAt < now()) {
    expireWatches(app);
    return 0;
  }
  const who = { ownerOpenId: app.config.lark.ownerOpenId, botOpenId: opts.botOpenId };
  let n = 0;
  for (const m of messages) {
    // Each message once, whichever path saw it first.
    if (one(app.db, "select 1 from handled_messages where channel = 'lark' and message_id = ?", m.id)) continue;
    if (!matches(rule, m, who)) continue;
    // Never react to our own posts (the bot's open_id in real time, its app id when captured).
    if (m.senderId && (m.senderId === opts.botOpenId || m.senderId === app.config.lark.appId)) continue;
    run(app.db, "insert or ignore into handled_messages(channel,message_id,rule,at) values('lark',?,?,?)", m.id, rule.spec, now());
    const batch = rule.batchMinutes === undefined ? 5000 : rule.batchMinutes * 60_000;
    const r = await receive(app, {
      channel: WATCH_CHANNEL,
      chatId,
      isGroup: true,
      title: chatName,
      spaceId: rule.spaceId,
      speaker: m.sender,
      text: `${m.text}
（飞书消息 ${m.id}${m.topicId ? `，话题 ${m.topicId}` : ""}，群「${chatName}」 ${chatId}）`,
      externalMessageId: m.id,
      mergeMs: mentioned(m, who) ? Math.min(batch, MENTION_MS) : batch,
      // A busy group must not keep pushing the batch back: the window starts with its first message.
      fixedWindow: true,
    });
    if (r.runId) run(app.db, "update handled_messages set run_id = ? where channel = 'lark' and message_id = ?", r.runId, m.id);
    n++;
  }
  return n;
}

/**
 * Add omem's own bot to a chat the owner is in, as the owner (lark-cli): the one write to Feishu
 * done as the owner outside the owner's own messages. Only for what the owner set up or asked for
 * themself: a rule's action, or a watch the owner asked for in their own message.
 */
export async function inviteOwnBot(app: App, chatId: string) {
  const appId = app.config.lark.appId;
  if (!appId) throw new HttpError(400, "没有配置飞书机器人（lark.appId）");
  const { larkCli } = await import("./lark-cli.ts");
  await larkCli(["im", "chat.members", "create", "--chat-id", chatId, "--member-id-type", "app_id", "--succeed-type", "1", "--data", JSON.stringify({ id_list: [appId] }), "--as", "user"], 60_000);
  (await import("../rules/engine.ts")).forgetChatBots(chatId);
}

export type WatchInfo = WatchRule & { chatId: string; name: string; conversationId: string | null };

/** Groups being watched, for the rules page. */
export function listWatches(app: App): WatchInfo[] {
  return all<{ chat_id: string; settings: string }>(app.db, "select chat_id, settings from chat_settings where channel = ? and json_extract(settings, '$.watch') is not null", WATCH_CHANNEL).map((r) => {
    const conv = one<{ id: string; title: string }>(app.db, "select id, title from conversations where channel = ? and external_id = ? order by updated_at desc limit 1", WATCH_CHANNEL, r.chat_id);
    const name = conv?.title ?? one<{ title: string }>(app.db, "select title from sources where uri = ? and deleted_at is null limit 1", `lark:${r.chat_id}`)?.title ?? r.chat_id;
    return { ...(JSON.parse(r.settings) as { watch: WatchRule }).watch, chatId: r.chat_id, name, conversationId: conv?.id ?? null };
  });
}
