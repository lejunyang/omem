import type { App } from "../core/app.ts";
import { one } from "../core/db.ts";
import { truncate } from "../core/util.ts";
import { getRun, type Run } from "../agents/runs.ts";
import { findThread } from "../agents/threads.ts";
import { workInConversation } from "../agents/agent-work.ts";
import { cotEvent, finishCot, hasCot, startCot } from "./lark-cot.ts";

/**
 * Thinking bubbles for the agents working behind a conversation, not only for the turn that
 * answers the owner's message: each round of a delegated agent, a consultation between agents,
 * and the main assistant's coordination turn gets its own native bubble, in order, in the topic
 * (or chat) where the work is followed. A bubble is titled with who is working on what.
 */
export function watchAgentBubbles(app: App) {
  const ours = new Set<string>();
  app.events.on("event", (e: { type: string; runId?: string; status?: string; event?: { type: string; data: unknown } }) => {
    if (!e.runId) return;
    if (e.type === "run" && e.status === "running") {
      try {
        if (start(app, getRun(app, e.runId))) ours.add(e.runId);
      } catch {}
    } else if (e.type === "run" && ours.has(e.runId) && (e.status === "done" || e.status === "failed" || e.status === "cancelled")) {
      let quiet = false;
      try {
        const r = getRun(app, e.runId);
        quiet = r.quiet || r.output.quiet === true;
      } catch {}
      finishCot(app, e.runId, e.status === "done", quiet);
      ours.delete(e.runId);
    } else if (e.type === "run-event" && e.event && ours.has(e.runId) && hasCot(e.runId)) {
      cotEvent(app, e.runId, { type: e.event.type, data: e.event.data });
    }
  });
}

/** The conversation a background run works for, and how to title its bubble. */
function placeOf(app: App, r: Run): { conversationId: string; title: string } | null {
  const input = r.input as { spec?: string; task?: string; threadId?: string; conversationId?: string; coordinate?: unknown; consultOf?: string | null; askedBy?: string; replyAt?: { chatId: string; messageId: string } };
  const task = truncate((input.task ?? "").split("\n").find((l) => l.trim() && !l.startsWith("#")) ?? "", 60);
  if (r.kind === "agent" && input.threadId) return { conversationId: input.threadId, title: `**${input.spec}** 开始：${task}` };
  if (r.kind === "agent" && input.consultOf) {
    // A consultation shows where the asking run works.
    const parent = one<{ input: string }>(app.db, "select input from runs where id = ?", input.consultOf);
    const p = parent ? (JSON.parse(parent.input) as { threadId?: string; conversationId?: string }) : {};
    const conv = p.threadId ?? p.conversationId;
    return conv ? { conversationId: conv, title: `**${input.spec}** 被 ${input.askedBy ?? "其他 Agent"} 请教：${task}` } : null;
  }
  if (r.kind === "ask" && input.coordinate && input.conversationId) return { conversationId: input.conversationId, title: "**主助手** 看报告、决定下一步" };
  if (r.kind === "ask" && (input as { handoff?: unknown }).handoff && input.conversationId) return { conversationId: input.conversationId, title: "**主助手** 看编码交办的结果" };
  return null;
}

function start(app: App, r: Run) {
  // A rule's agent answering under the triggering message: its bubble opens the topic there.
  const input = r.input as { replyAt?: { chatId: string; messageId: string }; spec?: string; wake?: boolean };
  // A wake-up re-check: nobody waits on it, and most end with nothing new (QUIET). Its process is
  // shown only when it has something to say.
  const defer = !!input.wake;
  const at = input.replyAt;
  if (r.kind === "agent" && at) return startCot(app, r.id, { chatId: at.chatId, originMessageId: at.messageId, inThread: true, title: `**${input.spec}** ${defer ? "复查" : "处理这条消息"}`, defer });
  const place = placeOf(app, r);
  if (!place) return false;
  const t = findThread(app, place.conversationId);
  if (!t || t.channel !== "lark" || !t.key) return false;
  const [chatId, topic] = t.key.split("#");
  const anchor = t.settings.lastMessageId;
  if (!chatId || !anchor) return false;
  // A work conversation shows its process in its own topic; before the topic exists, nowhere
  // (not in the group the work was started from).
  if (!topic && workInConversation(app, t.id)) return false;
  return startCot(app, r.id, { chatId, originMessageId: anchor, inThread: !!topic, title: place.title, defer });
}
