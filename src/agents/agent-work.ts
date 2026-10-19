import type { App } from "../core/app.ts";
import { one, run } from "../core/db.ts";
import { now, truncate } from "../core/util.ts";
import { addMessage, createThread, getThread } from "./threads.ts";
import { createRun, getRun, type Run } from "./runs.ts";

/**
 * Multi-agent work handed off by the main assistant. It is one conversation (a Feishu topic, or
 * a web conversation) where agents work and loop without flooding the original chat: progress
 * stays in the work conversation, only the digested result is delivered where it was asked.
 *
 * Shape:
 * - askRunId: the main-assistant turn that called run_agent / run_workflow
 * - rootConversationId: where the request came from (final result lands here)
 * - workConversationId: the topic/web conversation agents loop in
 * - rounds: [{ runId, agent, status }]
 * - awaitingUser: set in the work conversation; a reply there is treated as input to continue
 */

export type AgentWork = {
  askRunId: string;
  rootConversationId: string;
  workConversationId: string;
  /** Feishu thread key (chatId or chatId#topic) of the work conversation. */
  larkKey: string | null;
  /** Message that opened the topic (progress attaches under it). */
  larkMessageId: string | null;
  title: string;
  rounds: { runId: string; agent: string; status: "queued" | "done" | "failed"; waitingForUser?: boolean }[];
  awaitingUser: boolean;
  /** How many agent runs the main assistant has chained; a hard guard against loops. */
  runs: number;
};

export const MAX_AGENT_WORK_RUNS = 8;

export function workOfRun(app: App, run: Run): AgentWork | null {
  return (run.output as { agentWork?: AgentWork } | null)?.agentWork ?? null;
}

/** Work whose ask run is the parent (or ancestor) of `run`. */
export function workForChild(app: App, run: Run): AgentWork | null {
  let id = run.parentId;
  const seen = new Set<string>();
  while (id && !seen.has(id)) {
    seen.add(id);
    const r = one<{ output: string | null; parent_id: string | null }>(app.db, "select output, parent_id from runs where id = ?", id);
    const w = r?.output ? (JSON.parse(r.output) as { agentWork?: AgentWork }).agentWork : undefined;
    if (w) return w;
    id = r?.parent_id ?? null;
  }
  return null;
}

export function saveWork(app: App, work: AgentWork, runIds: string[]) {
  for (const id of new Set(runIds)) {
    const out = one<{ output: string | null }>(app.db, "select output from runs where id = ?", id)?.output;
    run(app.db, "update runs set output = ? where id = ?", JSON.stringify({ ...(out ? JSON.parse(out) : {}), agentWork: work }), id);
  }
}

/**
 * Start one piece of multi-agent work: open its work conversation and queue the first agent.
 * `startMessage` is posted into the work conversation as context.
 */
export function startAgentWork(app: App, input: {
  askRunId: string;
  rootConversationId: string;
  spaceId: string;
  title: string;
  agent: string;
  task: string;
  startMessage: string;
  /** Open a new Feishu topic from this message (the ask), instead of another plain reply. */
  anchorLarkMessageId?: string;
}): { work: AgentWork; runId: string; larkThreadMessageId?: string } {
  const root = getThread(app, input.rootConversationId);
  const lark = root?.channel === "lark";
  const workThread = createWorkThread(app, { rootId: input.rootConversationId, spaceId: input.spaceId, title: input.title });
  const work: AgentWork = {
    askRunId: input.askRunId,
    rootConversationId: input.rootConversationId,
    workConversationId: workThread.id,
    larkKey: workThread.key,
    larkMessageId: null,
    title: input.title,
    rounds: [],
    awaitingUser: false,
    runs: 0,
  };
  const ask = getRun(app, input.askRunId);
  saveWork(app, work, [input.askRunId]);

  // Record the request in the work conversation.
  addWorkMessage(app, work, { role: "user", text: input.startMessage, meta: { agentWork: true, spec: input.agent } });

  const runId = queueAgentRound(app, work, { agent: input.agent, task: input.task, kind: "agent" });
  return { work, runId };
}

function createWorkThread(app: App, i: { rootId: string; spaceId: string; title: string }) {
  const root = getThread(app, i.rootId);
  return createThread(app, {
    spaceId: i.spaceId,
    channel: root.channel,
    // A Feishu topic is created by the first reply-in-thread; the topic id is filled in afterwards.
    key: root.key,
    title: i.title,
    parentId: i.rootId,
    settings: { ...root.settings, spec: undefined, links: [i.rootId] },
    userId: root.userId,
  });
}

export function addWorkMessage(app: App, work: AgentWork, m: { role: "user" | "assistant"; text: string; runId?: string | null; meta?: Record<string, unknown> }) {
  return addMessage(app, work.workConversationId, m.role, m.text, m.runId ?? null, m.meta ?? {});
}

export type AgentRoundInput = {
  agent: string;
  task: string;
  spaceId?: string;
  /** Run as a built-in role (digester) instead of an agent spec. */
  role?: string;
  kind?: "agent" | "agent-followup";
};

/** Queue the next agent (or digester) round inside an existing work conversation. */
export function queueAgentRound(app: App, work: AgentWork, a: AgentRoundInput): string {
  if (work.runs >= MAX_AGENT_WORK_RUNS) throw new Error(`多 Agent 循环已达上限 ${MAX_AGENT_WORK_RUNS} 轮`);
  const r = createRun(app, {
    kind: a.kind ?? "agent",
    spaceId: a.spaceId ?? getThread(app, work.workConversationId).spaceId,
    title: truncate(`${a.agent}：${a.task.split("\n")[0]}`, 80),
    input: { spec: a.agent, role: a.role, task: a.task, threadId: work.workConversationId, agentWorkId: work.askRunId },
    parentId: work.askRunId,
  });
  const id = r.id;
  const next: AgentWork = { ...work, runs: work.runs + 1, rounds: [...work.rounds, { runId: id, agent: a.agent, status: "queued" }] };
  saveWork(app, next, [id, work.askRunId, ...work.rounds.map((r) => r.runId)]);
  return id;
}

/** Re-read fresh work from the ask run. */
export function refreshWork(app: App, askRunId: string): AgentWork | null {
  const out = one<{ output: string | null }>(app.db, "select output from runs where id = ?", askRunId);
  return out?.output ? (JSON.parse(out.output) as { agentWork?: AgentWork }).agentWork ?? null : null;
}


// ----------------------------------------------------------------- orchestration

import type { App as AppType } from "../core/app.ts";

/** Mark a finished work round and, for a specialist, queue its digester (the conclusion to the root conversation). */
export function onWorkRunSettled(app: App, run: Run): { work: AgentWork; followupRunId?: string } | null {
  const workId = (run.input as { agentWorkId?: string }).agentWorkId;
  if (!workId) return null;
  const work = refreshWork(app, workId);
  if (!work) return null;
  const next: AgentWork = {
    ...work,
    rounds: work.rounds.map((r) => (r.runId === run.id ? { ...r, status: run.status === "done" ? "done" : "failed" } : r)),
  };
  saveWork(app, next, [workId, run.id, ...work.rounds.map((r) => r.runId)]);
  if (run.status !== "done" || (run.input as { role?: string }).role) return { work: next };
  // A specialist round finished: digest it for the root conversation; the main assistant continues or asks.
  const answer = (run.output as { answer?: string }).answer ?? "";
  const rootThread = getThread(app, work.rootConversationId);
  const task = [
    `# 本人的原始诉求`,
    "",
    work.title,
    "",
    `# ${run.input && (run.input as { spec?: string }).spec ? (run.input as { spec: string }).spec : "专门 Agent"} 的产出`,
    "",
    truncate(answer, 40000),
    "",
    "按你的职责给出结论、需要本人决定的事和下一步建议。",
  ].join("\n");
  const followupRunId = queueAgentRound(app, next, { agent: "digester", role: "digester", task, kind: "agent-followup" });
  return { work: refreshWork(app, workId)!, followupRunId };
}

/** Open the work topic on Feishu on first use; updates work with the topic id and message id. */
export async function openWorkTopic(app: App, work: AgentWork, anchorMessageId: string) {
  if (work.larkKey?.includes("#")) return work;
  const root = getThread(app, work.rootConversationId);
  if (root.channel !== "lark" || !root.key) return work;
  const { deliverToThread } = await import("./inbox.ts");
  await deliverToThread(
    app,
    work.workConversationId,
    `**${work.title}**\n\n这项工作在这里推进；完成后把结论带回发起的会话。`,
    { openTopicFrom: anchorMessageId, agentWorkTopic: work.askRunId },
  );
  return refreshWork(app, work.askRunId) ?? work;
}
