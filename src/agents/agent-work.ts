import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { now, truncate } from "../core/util.ts";
import { addMessage, createThread, getThread } from "./threads.ts";
import { createRun, getRun, queuedInLane, updateQueuedRun, type Run } from "./runs.ts";

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

export const MAX_AGENT_WORK_RUNS = 30;

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

  const runId = queueAgentRound(app, work, { agent: input.agent, task: input.task });
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
};

/** Queue the next agent round inside an existing work conversation. */
export function queueAgentRound(app: App, work: AgentWork, a: AgentRoundInput): string {
  if (work.runs >= MAX_AGENT_WORK_RUNS) throw new Error(`多 Agent 循环已达上限 ${MAX_AGENT_WORK_RUNS} 轮`);
  const r = createRun(app, {
    kind: "agent",
    spaceId: a.spaceId ?? getThread(app, work.workConversationId).spaceId,
    title: truncate(`${a.agent}：${a.task.split("\n")[0]}`, 80),
    input: { spec: a.agent, task: a.task, threadId: work.workConversationId, agentWorkId: work.askRunId },
    parentId: work.askRunId,
  });
  const id = r.id;
  const next: AgentWork = { ...work, runs: work.runs + 1, rounds: [...work.rounds, { runId: id, agent: a.agent, status: "queued" }] };
  saveWork(app, next, [id, work.askRunId, ...work.rounds.map((r) => r.runId)]);
  return id;
}

/**
 * The work a conversation belongs to: it is that work's own conversation (a Feishu topic or a web
 * child conversation). With includeRoot, also the latest work started from it.
 */
export function workInConversation(app: App, conversationId: string, opts: { includeRoot?: boolean } = {}): AgentWork | null {
  const own = one<{ output: string }>(
    app.db,
    "select output from runs where json_extract(output,'$.agentWork.workConversationId') = ? and json_extract(output,'$.agentWork.askRunId') = id order by created_at desc limit 1",
    conversationId,
  );
  if (own) return (JSON.parse(own.output) as { agentWork?: AgentWork }).agentWork ?? null;
  if (!opts.includeRoot) return null;
  const root = one<{ output: string }>(
    app.db,
    "select output from runs where json_extract(output,'$.agentWork.rootConversationId') = ? and json_extract(output,'$.agentWork.askRunId') = id order by created_at desc limit 1",
    conversationId,
  );
  return root ? (JSON.parse(root.output) as { agentWork?: AgentWork }).agentWork ?? null : null;
}

/**
 * Where a work's replies go: its own Feishu topic once it has one (the owner follows the work
 * there and replies in it), otherwise the conversation it was asked from (web, private chats
 * without topics). Never both: the same digest twice is noise.
 */
export function workDeliveryTarget(app: App, work: AgentWork): string {
  const key = one<{ external_id: string | null }>(app.db, "select external_id from conversations where id = ?", work.workConversationId)?.external_id ?? "";
  return key.includes("#") ? work.workConversationId : work.rootConversationId;
}

/** Re-read fresh work from the ask run. */
export function refreshWork(app: App, askRunId: string): AgentWork | null {
  const out = one<{ output: string | null }>(app.db, "select output from runs where id = ?", askRunId);
  return out?.output ? (JSON.parse(out.output) as { agentWork?: AgentWork }).agentWork ?? null : null;
}


// ----------------------------------------------------------------- orchestration

/**
 * After this many coordination turns without the owner saying anything in the work, the main
 * assistant has to stop and report instead of handing out another round.
 */
export const MAX_AUTO_TURNS = 6;

/** Coordination turns the main assistant took since the owner last spoke in the work conversation. */
export function autoTurnsSinceOwner(app: App, work: AgentWork): number {
  const lastOwner = one<{ at: string }>(
    app.db,
    "select max(created_at) at from messages where conversation_id = ? and role = 'user' and json_extract(meta, '$.command') is null",
    work.workConversationId,
  )?.at ?? "";
  return one<{ n: number }>(
    app.db,
    "select count(*) n from runs where lane = ? and kind = 'ask' and json_extract(input, '$.coordinate') is not null and created_at > ?",
    work.workConversationId,
    lastOwner,
  )!.n;
}

/**
 * A specialist round finished (or failed): its report goes into the work conversation and the
 * main assistant takes a turn there as the one responsible for the work. It reads the report
 * against what the owner wants and either hands out the next round, reports a result, or asks
 * the owner — the loop runs without the owner pushing it, until it is done or stuck.
 */
export function onWorkRunSettled(app: App, run: Run): { work: AgentWork; coordinateRunId?: string } | null {
  const workId = (run.input as { agentWorkId?: string }).agentWorkId;
  if (!workId) return null;
  const work = refreshWork(app, workId);
  if (!work) return null;
  const status = run.status === "done" ? "done" : "failed";
  const next: AgentWork = { ...work, rounds: work.rounds.map((r) => (r.runId === run.id ? { ...r, status } : r)) };
  saveWork(app, next, [workId, run.id, ...work.rounds.map((r) => r.runId)]);
  // Rounds of an older version's digest step are bookkeeping only; cancelled rounds wait for the owner.
  if ((run.input as { role?: string }).role || run.status === "cancelled") return { work: next };
  return { work: next, coordinateRunId: queueCoordination(app, next, run) };
}

function queueCoordination(app: App, work: AgentWork, run: Run): string {
  const agent = (run.input as { spec?: string }).spec ?? "Agent";
  const round = work.rounds.filter((r) => r.agent === agent).findIndex((r) => r.runId === run.id) + 1;
  const report = run.status === "done" ? String((run.output as { answer?: string }).answer ?? "").trim() || "（没有输出）" : `这一轮失败了：${run.error ?? "未知错误"}`;
  const messageId = addWorkMessage(app, work, {
    role: "assistant",
    text: report,
    runId: run.id,
    meta: { agentReport: { agent, runId: run.id, status: run.status, round }, record: true },
  });
  // The owner may have written in the topic meanwhile: one turn takes both.
  const waiting = queuedInLane(app, work.workConversationId, "ask");
  if (waiting) {
    const ids = [...((waiting.input.messageIds as string[] | undefined) ?? []), messageId];
    const coordinate = { workId: work.askRunId, sourceRunIds: [...(((waiting.input.coordinate as { sourceRunIds?: string[] } | undefined)?.sourceRunIds) ?? []), run.id] };
    if (updateQueuedRun(app, waiting.id, { input: { ...waiting.input, messageIds: ids, coordinate } })) return waiting.id;
  }
  const r = createRun(app, {
    kind: "ask",
    spaceId: getThread(app, work.workConversationId).spaceId,
    title: truncate(`协调：${agent} 第 ${round} 轮${run.status === "done" ? "完成" : "失败"}`, 60),
    input: { conversationId: work.workConversationId, messageIds: [messageId], coordinate: { workId: work.askRunId, sourceRunIds: [run.id] } },
    lane: work.workConversationId,
    parentId: work.askRunId,
  });
  return r.id;
}

/**
 * What a specialist is told about the work so far, besides its own task: the owner's words in the
 * work conversation and the other rounds' results. It may be a fresh session that never saw them.
 */
export function workContext(app: App, work: AgentWork, forRunId: string): string {
  const msgs = all<{ role: string; text: string; meta: string; created_at: string; run_id: string | null }>(
    app.db,
    "select role, text, meta, created_at, run_id from messages where conversation_id = ? order by created_at desc limit 30",
    work.workConversationId,
  ).reverse();
  const lines = msgs
    .filter((m) => m.run_id !== forRunId)
    .map((m) => {
      const meta = JSON.parse(m.meta || "{}") as { agentReport?: { agent: string; round: number }; command?: boolean };
      if (meta.command) return "";
      const who = m.role === "user" ? "本人" : meta.agentReport ? `${meta.agentReport.agent}（第 ${meta.agentReport.round} 轮报告）` : "主助手";
      return `- ${who}（${m.created_at.slice(5, 16).replace("T", " ")}）：${truncate(m.text.replace(/\s+/g, " "), meta.agentReport ? 600 : 400)}`;
    })
    .filter(Boolean);
  return lines.length ? `# 这项工作到目前为止（工作会话 ${work.workConversationId}；全文用 read_conversation 读）\n\n目标：${work.title}\n\n${lines.join("\n")}` : "";
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
    `**${work.title}**\n\n这项工作在这个话题里推进：Agent 的结论和需要你决定的事都在这里，你也可以直接在话题里回复补充要求。`,
    { openTopicFrom: anchorMessageId, agentWorkTopic: work.askRunId },
  );
  return refreshWork(app, work.askRunId) ?? work;
}
