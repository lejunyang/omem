import type { App } from "../core/app.ts";
import { requireReadableItem } from "../items/store.ts";
import { mayJoinTurn } from "./steer.ts";
import { canWrite, OWNER, personalSpaceId, turnSpaceFor } from "../core/users.ts";
import { HttpError, now, RUN_TITLE_MAX, truncate } from "../core/util.ts";
import { all, one, run } from "../core/db.ts";
import { injectionScore } from "../sources/guard.ts";
import { reviewReply, runCommand } from "./commands.ts";
import { createRun, queuedInLane, updateQueuedRun } from "./runs.ts";
import { larkBy, userBy } from "../core/run-trigger.ts";
import { overDailyLimit } from "./assistants.ts";
import { moveHome, runOfLarkMessage } from "./home.ts";
import { addMessage, createThread, findThread, resolveThread, updateThread, type Thread, type ThreadAddress } from "./threads.ts";

/**
 * Every message from the owner, whatever the channel, enters here:
 *
 * - `/command` lines are handled directly (no model) and answered at once.
 * - Otherwise the message joins its thread. If the thread already has a turn
 *   waiting to start, the message is merged into it (bursts become one turn);
 *   otherwise a new turn is queued in the thread's lane, so turns of one thread
 *   run in order while different threads run in parallel.
 */
export type Inbound = Partial<ThreadAddress> & {
  text: string;
  /** Plain text authored by the authenticated owner at the web chat entry point. */
  ownerText?: boolean;
  /** Web / CLI: an explicit conversation (thread) id. */
  conversationId?: string;
  itemId?: string;
  /** What was being discussed around the message (group lines before an @mention). */
  context?: string;
  contextLabel?: string;
  /** Channel message id, so later replies can land in the right place (topic). */
  externalMessageId?: string;
  /** Sender in the originating bot's app, resolved by the Feishu adapter. */
  larkSenderId?: string;
  topicRootId?: string;
  /** The message this one replies to / quotes (Feishu 引用回复): sender, readable text and optional origin link. */
  quote?: { messageId?: string; sender?: string; text?: string; origin?: string };
  /** Wait this long for more messages before starting (defaults to sessions.mergeMs for chats, 0 for web). */
  mergeMs?: number;
  /** Later messages do not extend the wait (only shorten it): a watched chat's batch window. */
  fixedWindow?: boolean;
  /** Who sent it (resolved from the channel identity); the owner by default. */
  userId?: string;
  /** For watched chats: the person who actually wrote it (not a user of omem). */
  speaker?: string;
  /** Kept on the stored message (a plugin page's submission: meta.submission). Never an answer to an open ask. */
  meta?: Record<string, unknown>;
  /** A colleague (not a user) asking the assistant in a group the owner is in (lark.guests.ownerPresent). */
  asker?: string;
  /** That colleague's open_id in omem's main bot app (the app their own grant goes through, auth/grants.ts). */
  askerId?: string;
  /** Said for the owner by an ask (a clicked suggestion, a delivered answer): not itself an answer. */
  fromAsk?: boolean;
  /** Channel adapter opens a topic and returns its actual external identifiers before the task starts. */
  openTopic?: () => Promise<{ topicId: string; messageId: string }>;
};

export type Received = { thread: Thread; messageId: string | null; runId: string | null; merged: boolean; reply: string | null; card?: Record<string, unknown>; started: "new" | "renewed" | null };

export async function receive(app: App, inb: Inbound): Promise<Received> {
  const userId = inb.userId ?? OWNER;
  const item = inb.itemId ? requireReadableItem(app, inb.itemId, userId) : undefined;
  let thread: Thread;
  let started: Received["started"] = null;
  if (inb.conversationId) {
    const previous = findThread(app, inb.conversationId);
    thread = previous ?? createThread(app, { id: inb.conversationId, spaceId: inb.spaceId ?? personalSpaceId(userId), channel: inb.channel ?? "web", userId });
    if (!previous && item) {
      thread = updateThread(app, thread.id, { settings: { ...thread.settings, itemId: item.id } });
      if (canWrite(app, userId, item.spaceId)) {
        const { addLocalMaterials } = await import("../items/materials.ts");
        addLocalMaterials(app, item.id, [{ kind: "conversation", ref: thread.id }], userId, "user");
      }
    }
    if (thread.userId !== userId && !canWrite(app, userId, thread.spaceId)) throw new HttpError(403, "不能在别人的会话里发消息");
  } else if (inb.channel && inb.chatId) {
    const r = resolveThread(app, { ...(inb as ThreadAddress), userId, spaceId: inb.spaceId ?? (inb.isGroup ? undefined : personalSpaceId(userId)) });
    thread = r.thread;
    started = r.started;
  } else {
    thread = createThread(app, { spaceId: inb.spaceId ?? personalSpaceId(userId), channel: inb.channel ?? "web", userId });
    started = "new";
  }
  if (inb.externalMessageId) thread = updateThread(app, thread.id, { settings: { ...thread.settings, lastMessageId: inb.externalMessageId, ...(inb.chatId ? { lastTopicId: inb.topicId ?? null } : {}), ...(inb.chatId && inb.isGroup !== undefined ? { group: inb.isGroup } : {}) } });

  const ownerOrigin = inb.ownerText && thread.channel === "listen"
    ? { sourceSpaces: item && item.spaceId !== thread.spaceId ? [thread.spaceId, item.spaceId] : [thread.spaceId] }
    : {};
  let text = inb.text.trim();
  let freshTask = false;
  // An in-chat review takes plain replies until it ends.
  if (!text.startsWith("/") && thread.settings.review) {
    const reply = reviewReply(app, thread, text, userId);
    if (reply !== null) {
      addMessage(app, thread.id, "user", text, null, { ...ownerOrigin, command: true });
      addMessage(app, thread.id, "assistant", reply, null, { command: true });
      return { thread: findThread(app, thread.id)!, messageId: null, runId: null, merged: false, reply, started };
    }
  }
  if (text.startsWith("/")) {
    let reply = await runCommand(app, thread, text, inb);
    if (reply !== null && typeof reply !== "string") {
      addMessage(app, thread.id, "user", text, null, { ...ownerOrigin, command: true });
      thread = reply.thread;
      started = "new";
      text = reply.task;
      // Explicit fresh starts do not inherit surrounding group history or answer an old ask.
      inb = { ...inb, context: undefined };
      freshTask = true;
      if (inb.externalMessageId && !thread.settings.lastMessageId) {
        thread = updateThread(app, thread.id, { settings: { lastMessageId: inb.externalMessageId } });
      }
      if (!text) {
        const confirmation = reply.reply ?? "已开始新会话。";
        addMessage(app, thread.id, "assistant", confirmation, null, { command: true });
        return { thread, messageId: null, runId: null, merged: false, reply: confirmation, started };
      }
      reply = null;
    }
    if (reply !== null) {
      addMessage(app, thread.id, "user", text, null, { ...ownerOrigin, command: true });
      let card: Record<string, unknown> | undefined;
      let plain = reply;
      if (reply.startsWith("{")) {
        try {
          const j = JSON.parse(reply) as { __omem_card?: Record<string, unknown> };
          if (j.__omem_card) {
            card = j.__omem_card;
            plain = "";
          }
        } catch {
          // ordinary text that happens to start with {
        }
      }
      addMessage(app, thread.id, "assistant", plain || "[卡片]", null, { command: true, ...(card ? { card } : {}) });
      return { thread: findThread(app, thread.id)!, messageId: null, runId: null, merged: false, reply: plain || "[card]", card, started };
    }
  }

  // The owner replying to a notification's card in Feishu has read it (channels/notify-read.ts).
  if (inb.quote?.messageId && userId === OWNER && !inb.speaker && !inb.asker) (await import("../channels/notify-read.ts")).markCardRead(app, inb.quote.messageId);

  // A reply to an open question (or a number picking a suggested step). When an agent is waiting
  // for it inside its turn, it is the answer there and starts no turn of its own.
  if (!freshTask && !inb.fromAsk && !inb.speaker && !inb.asker && !inb.meta) {
    const { answerFromMessage } = await import("./asks.ts");
    if (await answerFromMessage(app, thread.id, text, userId)) {
      const messageId = addMessage(app, thread.id, "user", text, null, { ...ownerOrigin, answer: true, ...(inb.externalMessageId ? { externalId: inb.externalMessageId } : {}) });
      return { thread: findThread(app, thread.id)!, messageId, runId: null, merged: false, reply: null, started };
    }
  }

  const meta: Record<string, unknown> = { ...ownerOrigin, ...inb.meta, ...(inb.itemId ? { itemId: inb.itemId } : {}), ...(userId === OWNER ? {} : { userId }) };
  if (inb.fromAsk) meta.fromAsk = true;
  if (inb.context) {
    meta.context = inb.context;
    meta.contextLabel = inb.contextLabel ?? "群里";
    // Other people's lines reach the agent here directly, before any ingest: check them now.
    const score = await injectionScore(app, inb.context);
    if (score !== null && score >= app.config.guard.threshold) meta.contextSuspect = Math.round(score * 100) / 100;
  }
  if (inb.externalMessageId) meta.externalId = inb.externalMessageId;
  if ((inb.channel === "lark" || inb.channel?.startsWith("lark:")) && inb.externalMessageId) {
    meta.larkInThread = !!inb.topicId;
    if (inb.larkSenderId) meta.larkSenderId = inb.larkSenderId;
  }
  if (inb.topicRootId) meta.topicRootId = inb.topicRootId;
  if (inb.quote) meta.quote = inb.quote;
  if (inb.speaker) meta.speaker = inb.speaker;
  if (inb.asker) meta.asker = inb.asker;
  if (inb.asker && inb.askerId) meta.askerId = inb.askerId;
  const messageId = addMessage(app, thread.id, "user", text, null, meta);
  // The owner replying to a message of some work carries that work on here (agents/home.ts).
  if (inb.quote?.messageId && userId === OWNER && !inb.speaker && !inb.asker) followQuoted(app, inb.quote.messageId, thread.id, inb.externalMessageId);
  const mergeMs = inb.mergeMs ?? (inb.conversationId || !inb.channel || inb.channel === "web" || inb.channel === "cli" ? 0 : app.config.sessions.mergeMs);
  const notBefore = new Date(Date.now() + mergeMs).toISOString();

  const waiting = queuedInLane(app, thread.id, "ask");
  // Bursts merge into a waiting turn of the same sender, or of someone whose access the sender's covers
  // (steer.ts mayJoinTurn): the turn keeps its own user's permissions.
  if (waiting && !waiting.input.itemStepApproval && !waiting.input.aiLoginWait && mayJoinTurn(app, (waiting.input.userId as string | undefined) ?? OWNER, userId, [{ meta }])) {
    const ids = [...((waiting.input.messageIds as string[] | undefined) ?? []), messageId];
    // A fixed window (a watched chat's batch) is never pushed back, only brought forward.
    const due = inb.fixedWindow ? app.db.prepare("select not_before from runs where id = ?").get(waiting.id) as { not_before: string | null } | undefined : undefined;
    const later = !!due?.not_before && due.not_before <= notBefore;
    if (updateQueuedRun(app, waiting.id, { input: { ...waiting.input, messageIds: ids, ...(inb.fromAsk ? { fromAsk: true } : {}) }, notBefore: mergeMs && !later ? notBefore : undefined, title: truncate(`${waiting.title} / ${text.replace(/\s+/g, " ")}`, RUN_TITLE_MAX) })) {
      app.db.prepare("update messages set run_id = ? where id = ?").run(waiting.id, messageId);
      steerSoon(app, thread.id);
      return { thread, messageId, runId: waiting.id, merged: true, reply: null, started };
    }
  }
  // An assistant with a daily limit (agents/assistants.ts): past it the sender is told, nothing runs.
  const over = overDailyLimit(app, thread.channel);
  if (over) return { thread, messageId, runId: null, merged: false, reply: over, started };
  const run = createRun(app, {
    kind: "ask",
    spaceId: turnSpaceFor(app, userId, thread.spaceId),
    title: truncate(text.replace(/\s+/g, " "), RUN_TITLE_MAX),
    input: { conversationId: thread.id, messageIds: [messageId], ...(thread.settings.situation && thread.settings.itemId ? { itemId: thread.settings.itemId } : {}), ...(inb.fromAsk ? { fromAsk: true } : {}), ...(userId === OWNER ? {} : { userId }), ...((inb as Inbound & { continueCodeAskId?: string }).continueCodeAskId ? { continueCodeAskId: (inb as Inbound & { continueCodeAskId?: string }).continueCodeAskId } : {}) },
    lane: thread.id,
    userId,
    notBefore: mergeMs ? notBefore : null,
    // A colleague asking in the owner's group, or the speaker of a watched chat, is the one behind it; else the sender.
    trigger: { via: "chat", by: inb.asker ? larkBy(inb.askerId ?? null, inb.asker) : inb.speaker ? larkBy(null, inb.speaker) : userBy(app, userId), where: thread.channel === "web" ? "网页" : thread.title || thread.channel },
  });
  app.db.prepare("update messages set run_id = ? where id = ?").run(run.id, messageId);
  steerSoon(app, thread.id);
  return { thread, messageId, runId: run.id, merged: false, reply: null, started };
}

function followQuoted(app: App, quoted: string, conversationId: string, anchor: string | undefined) {
  try {
    const chatId = (findThread(app, conversationId)?.key ?? "").split("#")[0];
    if (!chatId) return;
    const runId = runOfLarkMessage(app, quoted, chatId);
    if (runId) moveHome(app, runId, conversationId, anchor ?? null);
  } catch (e) {
    console.warn("[omem] 记录这件事换到哪里聊失败：", (e as Error).message);
  }
}

/** A turn already running in this conversation gets the new words now when its agent can take them. */
function steerSoon(app: App, threadId: string) {
  void import("./sessions.ts").then((m) => m.steerLiveTurn(app, threadId)).catch((e) => console.warn("[omem] 补充消息交给进行中的一轮失败：", (e as Error).message));
}

// ---- delivering to threads -------------------------------------------------

/** `messageId`: the omem message being sent, for channels that note what it became on their side. */
type Sender = (thread: Thread, markdown: string, meta: Record<string, unknown>, messageId: string) => Promise<void>;
const senders = new Map<string, Sender>();

/** Channels register how to post into one of their threads (chat, topic). */
export function registerThreadSender(channel: string, send: Sender) {
  senders.set(channel, send);
  return () => { if (senders.get(channel) === send) senders.delete(channel); };
}

/**
 * Post something into a thread later (a delegated agent finished, a reminder
 * for that chat): it becomes part of the thread and reaches the chat/topic
 * when its channel is connected.
 */
export async function deliverToThread(app: App, threadId: string, markdown: string, meta: Record<string, unknown> = {}) {
  const t = findThread(app, threadId);
  if (!t) return false;
  const recovering = meta.recoverReply === true;
  const id = addMessage(app, t.id, "assistant", markdown, recovering && typeof meta.runId === "string" ? meta.runId : null, { ...meta, ...(recovering ? {} : { deliveredAt: now() }) });
  if (recovering) {
    // Persist before sending: the channel may still be connecting after startup.
    run(app.db, "insert into kv(key,value) values(?,?)", `recovered-reply:${id}`, JSON.stringify({ threadId: t.id, messageId: id, at: now() }));
    await flushRecoveredReplies(app);
    return !one(app.db, "select 1 from kv where key = ?", `recovered-reply:${id}`);
  }
  const send = senders.get(t.channel);
  if (!send) return false;
  try {
    await send(t, markdown, meta, id);
    return true;
  } catch (e) {
    console.warn(`[omem] 发送到会话 ${t.id} 失败：${(e as Error).message}`);
    return false;
  }
}

const recoveringReplies = new Set<string>();
const RECOVER_FOR_MS = 24 * 3600_000;
/** Queue the saved answer after its live channel adapter could not deliver it; do not rerun the AI. */
export function retryChannelReply(app: App, runId: string, at: { progressMessageId?: string; replyTo?: string; inThread?: boolean } = {}) {
  const m = one<{ id: string; conversation_id: string }>(app.db, "select id,conversation_id from messages where run_id = ? and role = 'assistant' order by rowid desc limit 1", runId);
  if (!m) return false;
  run(app.db, "update messages set meta = json_patch(meta, ?) where id = ?", JSON.stringify({ runId, recoverReply: true, progressMessageId: at.progressMessageId, larkReplyTo: at.replyTo, larkInThread: at.inThread }), m.id);
  run(app.db, "insert or ignore into kv(key,value) values(?,?)", `recovered-reply:${m.id}`, JSON.stringify({ threadId: m.conversation_id, messageId: m.id, at: now() }));
  return true;
}

/** Retry saved channel replies after a restart or a failed live delivery. */
export async function flushRecoveredReplies(app: App) {
  for (const row of all<{ key: string; value: string }>(app.db, "select key,value from kv where key glob 'recovered-reply:*' order by key")) {
    const lock = `${app.home}:${row.key}`;
    // An earlier await may let another flush finish a later row from this snapshot.
    if (recoveringReplies.has(lock) || !one(app.db, "select 1 from kv where key = ?", row.key)) continue;
    const { threadId, messageId, at } = JSON.parse(row.value) as { threadId: string; messageId: string; at?: string };
    const t = findThread(app, threadId);
    const send = t && senders.get(t.channel);
    // The conversation is gone, or its channel never came up (a watched group, a plugin's block: no
    // sender at all) or kept failing for a day: the reply stays in the conversation, not in the queue.
    if (!t || (at && Date.now() - Date.parse(at) > RECOVER_FOR_MS)) {
      if (t) console.warn(`[omem] 恢复会话 ${t.id} 的回复一天内没能发出，不再重试（回复在会话记录里）`);
      run(app.db, "delete from kv where key = ?", row.key);
      continue;
    }
    if (!send) continue;
    const message = one<{ text: string; meta: string }>(app.db, "select text,meta from messages where id = ? and conversation_id = ?", messageId, t.id);
    if (!message) { run(app.db, "delete from kv where key = ?", row.key); continue; }
    recoveringReplies.add(lock);
    try {
      await send(t, message.text, JSON.parse(message.meta), messageId);
      run(app.db, "update messages set meta = json_set(meta, '$.deliveredAt', ?) where id = ?", now(), messageId);
      run(app.db, "delete from kv where key = ?", row.key);
    } catch (e) {
      console.warn(`[omem] 恢复会话 ${t.id} 的回复失败：${(e as Error).message}`);
    } finally { recoveringReplies.delete(lock); }
  }
}
