import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { notify } from "../core/notify.ts";
import { now, localStamp } from "../core/util.ts";
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
    notify(app, { title: `不再盯「${w.name ?? w.chat_id}」了`, body: `到了设定的时间（${localStamp(w.until, app.config.timezone)}）。还要继续就再说一声。` });
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
      // Addressed to the owner or the bot: never screened out (prefilterBatch).
      ...(mentioned(m, who) ? { meta: { addressed: true } } : {}),
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
 * A message that @s the bot is answered where it was asked (lark-bot.ts), by one run: the watch on the
 * chat does not take it as well. Recorded as handled, so the owner's capture seeing it later leaves it too.
 */
export function answeredDirectly(app: App, chatId: string, messageId: string) {
  if (!watchRule(app, chatId)) return false;
  run(app.db, "insert or ignore into handled_messages(channel,message_id,rule,at) values('lark',?,'direct',?)", messageId, now());
  return true;
}

/** What the owner wants from a watched chat, for the run that answers someone @-ing the bot there. */
export function watchPurpose(app: App, chatId: string) {
  const w = watchRule(app, chatId);
  if (!w || (w.expiresAt && w.expiresAt < now())) return "";
  return `本人让你盯着这个群：${w.note ?? "（没有写目的）"}。这条消息 @ 了你，由你在这里回答，盯群的那一路不再处理它；群里别的消息仍由那一路看。`;
}

/** Rules bring omem's bot into a chat with this (lark-invite.ts, shared with `lark_invite`). */
export { inviteOwnBot } from "./lark-invite.ts";

export type WatchInfo = WatchRule & { chatId: string; name: string; conversationId: string | null };

/** Groups being watched, for the rules page. */
export function listWatches(app: App): WatchInfo[] {
  return all<{ chat_id: string; settings: string }>(app.db, "select chat_id, settings from chat_settings where channel = ? and json_extract(settings, '$.watch') is not null", WATCH_CHANNEL).map((r) => {
    const conv = one<{ id: string; title: string }>(app.db, "select id, title from conversations where channel = ? and external_id = ? order by updated_at desc limit 1", WATCH_CHANNEL, r.chat_id);
    const name = conv?.title ?? one<{ title: string }>(app.db, "select title from sources where uri = ? and deleted_at is null limit 1", `lark:${r.chat_id}`)?.title ?? r.chat_id;
    return { ...(JSON.parse(r.settings) as { watch: WatchRule }).watch, chatId: r.chat_id, name, conversationId: conv?.id ?? null };
  });
}

/**
 * Before a watched group's batch goes to its handler (a full agent run), the decision model asks
 * whether it is worth a look at all, given what the owner wants from the watch: most batches of a
 * busy group (chatter, "稍等", a video call notice) end with the handler saying nothing. On unless the
 * watch says otherwise (`prefilter`) or the owner turned it off (`lark.watchPrefilter`), and only
 * with a decision model. Messages that @ the owner or the bot always go through; so does a batch when
 * the model fails. Returns why the batch is skipped, or null to hand it over.
 */
export async function prefilterBatch(app: App, conversationId: string, batch: { text: string; meta: Record<string, unknown> }[], signal?: AbortSignal): Promise<string | null> {
  const { findThread, threadMessages } = await import("../agents/threads.ts");
  const t = findThread(app, conversationId);
  if (!t || t.channel !== WATCH_CHANNEL) return null;
  const rule = watchRule(app, (t.key ?? "").split("#")[0]);
  if (!rule || !(rule.prefilter ?? app.config.lark.watchPrefilter !== false)) return null;
  if (batch.some((m) => m.meta.addressed)) return null;
  const { decide, decisionReady, describeDecision } = await import("../core/decision.ts");
  if (!decisionReady(app)) return null;
  const said = threadMessages(app, conversationId, { limit: 12 }).filter((m) => m.role === "assistant" && !m.meta.prefiltered).slice(-3);
  try {
    const r = await decide(app, {
      群: t.title || t.key,
      本人要的: rule.note ?? "（没写）",
      之前的摘要: t.summary || "（无）",
      最近的处理: said.map((m) => m.text.slice(0, 400)).join("\n---\n") || "（无）",
      这一批消息: batch.map((m) => `${String(m.meta.speaker ?? "?")}：${m.text.slice(0, 600)}`).join("\n"),
    }, {
      type: "yesno",
      instructions: "这是本人让助手盯着的一个群新来的一批消息。判断要不要交给助手处理（读上下文、查资料、回复或告诉本人）。按“本人要的”判断：和它有关的、有人提问或求助的、出了问题的、需要跟进之前处理的，选“要看”；闲聊、客套、“稍等”“收到”、系统通知、和本人要的无关的，选“不用看”。拿不准选“要看”。",
      yes: "要看",
      no: "不用看",
    }, { signal });
    if (!r || r.choice === "yes") return null;
    return describeDecision(r, { yes: "要看", no: "不用看" });
  } catch {
    return null;
  }
}
