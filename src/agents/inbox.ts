import type { App } from "../core/app.ts";
import { canWrite, OWNER, personalSpaceId } from "../core/users.ts";
import { HttpError, now, truncate } from "../core/util.ts";
import { injectionScore } from "../sources/guard.ts";
import { reviewReply, runCommand } from "./commands.ts";
import { createRun, queuedInLane, updateQueuedRun } from "./runs.ts";
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
  /** Web / CLI: an explicit conversation (thread) id. */
  conversationId?: string;
  /** What was being discussed around the message (group lines before an @mention). */
  context?: string;
  contextLabel?: string;
  /** Channel message id, so later replies can land in the right place (topic). */
  externalMessageId?: string;
  /** The message this one replies to / quotes (Feishu 引用回复): sender, readable text and optional origin link. */
  quote?: { messageId?: string; sender?: string; text?: string; origin?: string };
  /** Wait this long for more messages before starting (defaults to sessions.mergeMs for chats, 0 for web). */
  mergeMs?: number;
  /** Who sent it (resolved from the channel identity); the owner by default. */
  userId?: string;
  /** For watched chats: the person who actually wrote it (not a user of omem). */
  speaker?: string;
  /** A colleague (not a user) asking the assistant in a group the owner is in (lark.guests.ownerPresent). */
  asker?: string;
  /** Said for the owner by an ask (a clicked suggestion, a delivered answer): not itself an answer. */
  fromAsk?: boolean;
};

export type Received = { thread: Thread; messageId: string | null; runId: string | null; merged: boolean; reply: string | null; card?: Record<string, unknown>; started: "new" | "renewed" | null };

export async function receive(app: App, inb: Inbound): Promise<Received> {
  const userId = inb.userId ?? OWNER;
  let thread: Thread;
  let started: Received["started"] = null;
  if (inb.conversationId) {
    thread = findThread(app, inb.conversationId) ?? createThread(app, { id: inb.conversationId, spaceId: inb.spaceId ?? personalSpaceId(userId), channel: inb.channel ?? "web", userId });
    if (thread.userId !== userId && !canWrite(app, userId, thread.spaceId)) throw new HttpError(403, "不能在别人的会话里发消息");
  } else if (inb.channel && inb.chatId) {
    const r = resolveThread(app, { ...(inb as ThreadAddress), userId, spaceId: inb.spaceId ?? (inb.isGroup ? undefined : personalSpaceId(userId)) });
    thread = r.thread;
    started = r.started;
  } else {
    thread = createThread(app, { spaceId: inb.spaceId ?? personalSpaceId(userId), channel: inb.channel ?? "web", userId });
    started = "new";
  }
  if (inb.externalMessageId) updateThread(app, thread.id, { settings: { ...thread.settings, lastMessageId: inb.externalMessageId } as Thread["settings"] });

  const text = inb.text.trim();
  // An in-chat review takes plain replies until it ends.
  if (!text.startsWith("/") && thread.settings.review) {
    const reply = reviewReply(app, thread, text, userId);
    if (reply !== null) {
      addMessage(app, thread.id, "user", text, null, { command: true });
      addMessage(app, thread.id, "assistant", reply, null, { command: true });
      return { thread: findThread(app, thread.id)!, messageId: null, runId: null, merged: false, reply, started };
    }
  }
  if (text.startsWith("/")) {
    const reply = await runCommand(app, thread, text, inb);
    if (reply !== null) {
      addMessage(app, thread.id, "user", text, null, { command: true });
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

  // A reply to an open question (or a number picking a suggested step). When an agent is waiting
  // for it inside its turn, it is the answer there and starts no turn of its own.
  if (!inb.fromAsk && !inb.speaker && !inb.asker) {
    const { answerFromMessage } = await import("./asks.ts");
    if (await answerFromMessage(app, thread.id, text, userId)) {
      const messageId = addMessage(app, thread.id, "user", text, null, { answer: true, ...(inb.externalMessageId ? { externalId: inb.externalMessageId } : {}) });
      return { thread: findThread(app, thread.id)!, messageId, runId: null, merged: false, reply: null, started };
    }
  }

  const meta: Record<string, unknown> = userId === OWNER ? {} : { userId };
  if (inb.fromAsk) meta.fromAsk = true;
  if (inb.context) {
    meta.context = inb.context;
    meta.contextLabel = inb.contextLabel ?? "群里";
    // Other people's lines reach the agent here directly, before any ingest: check them now.
    const score = await injectionScore(app, inb.context);
    if (score !== null && score >= app.config.guard.threshold) meta.contextSuspect = Math.round(score * 100) / 100;
  }
  if (inb.externalMessageId) meta.externalId = inb.externalMessageId;
  if (inb.quote) meta.quote = inb.quote;
  if (inb.speaker) meta.speaker = inb.speaker;
  if (inb.asker) meta.asker = inb.asker;
  const messageId = addMessage(app, thread.id, "user", text, null, meta);
  const mergeMs = inb.mergeMs ?? (inb.conversationId || !inb.channel || inb.channel === "web" || inb.channel === "cli" ? 0 : app.config.sessions.mergeMs);
  const notBefore = new Date(Date.now() + mergeMs).toISOString();

  const waiting = queuedInLane(app, thread.id, "ask");
  // Bursts merge only within one sender: each turn runs with its sender's permissions.
  if (waiting && ((waiting.input.userId as string | undefined) ?? OWNER) === userId) {
    const ids = [...((waiting.input.messageIds as string[] | undefined) ?? []), messageId];
    if (updateQueuedRun(app, waiting.id, { input: { ...waiting.input, messageIds: ids }, notBefore: mergeMs ? notBefore : undefined, title: truncate(`${waiting.title} / ${text.replace(/\s+/g, " ")}`, 80) })) {
      app.db.prepare("update messages set run_id = ? where id = ?").run(waiting.id, messageId);
      return { thread, messageId, runId: waiting.id, merged: true, reply: null, started };
    }
  }
  const run = createRun(app, {
    kind: "ask",
    spaceId: thread.spaceId,
    title: truncate(text.replace(/\s+/g, " "), 60),
    input: { conversationId: thread.id, messageIds: [messageId], ...(userId === OWNER ? {} : { userId }), ...((inb as Inbound & { continueCodeAskId?: string }).continueCodeAskId ? { continueCodeAskId: (inb as Inbound & { continueCodeAskId?: string }).continueCodeAskId } : {}) },
    lane: thread.id,
    userId,
    notBefore: mergeMs ? notBefore : null,
  });
  app.db.prepare("update messages set run_id = ? where id = ?").run(run.id, messageId);
  return { thread, messageId, runId: run.id, merged: false, reply: null, started };
}

// ---- delivering to threads -------------------------------------------------

type Sender = (thread: Thread, markdown: string, meta?: Record<string, unknown>) => Promise<void>;
const senders = new Map<string, Sender>();

/** Channels register how to post into one of their threads (chat, topic). */
export function registerThreadSender(channel: string, send: Sender) {
  senders.set(channel, send);
}

/**
 * Post something into a thread later (a delegated agent finished, a reminder
 * for that chat): it becomes part of the thread and reaches the chat/topic
 * when its channel is connected.
 */
export async function deliverToThread(app: App, threadId: string, markdown: string, meta: Record<string, unknown> = {}) {
  const t = findThread(app, threadId);
  if (!t) return false;
  addMessage(app, t.id, "assistant", markdown, null, { ...meta, deliveredAt: now() });
  const send = senders.get(t.channel);
  if (!send) return false;
  try {
    await send(t, markdown, meta);
    return true;
  } catch (e) {
    console.warn(`[omem] 发送到会话 ${t.id} 失败：${(e as Error).message}`);
    return false;
  }
}
