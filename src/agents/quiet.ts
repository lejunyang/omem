import type { App } from "../core/app.ts";
import { getRun, type Run } from "./runs.ts";
import { threadMessages } from "./threads.ts";

/**
 * Saying nothing is a tool call (stay_quiet), never a word in the answer. A run nobody waits on may
 * end without a reply: a wake-up, a watched group's batch, a rule's agent, the tasks a delegation
 * handed back, a background role. A turn answering someone's message may not, so an answer that
 * happens to read "QUIET" is sent like any other.
 */
export function mayStayQuiet(app: App, run: Run): boolean {
  const input = run.input as { wake?: unknown; rule?: unknown; silent?: unknown; meeting?: unknown; mention?: unknown; coordinate?: unknown; fromAsk?: unknown; handoff?: { kind?: string }; conversationId?: string; messageIds?: string[] };
  if (run.kind === "agent") return !!(input.wake || input.rule || input.silent || input.meeting || input.mention);
  if (run.kind === "ask") {
    // Tasks handed back for the assistant to settle: the owner needs to hear only what is left for them.
    if (input.handoff?.kind === "code-tasks" || input.handoff?.kind === "design") return true;
    if (input.handoff || input.coordinate || input.fromAsk || !input.conversationId) return false;
    const ids = input.messageIds ?? [];
    const msgs = threadMessages(app, input.conversationId, { limit: 400 }).filter((m) => ids.includes(m.id));
    // Its own wake notes, or what others said in a group it watches; never a person's message to it.
    return msgs.length > 0 && msgs.every((m) => !!m.meta.wake || typeof m.meta.speaker === "string");
  }
  // People's turns elsewhere: a guest's question, the owner's private-chat command, an outside agent.
  return !["guest", "lark-command", "peer-agent"].includes(run.kind);
}

/** Why the run chose to say nothing (stay_quiet), or null when it did not. */
export function quietReason(app: App, runId: string): string | null {
  const v = getRun(app, runId).output.stayQuiet;
  return typeof v === "string" && v ? v : null;
}
