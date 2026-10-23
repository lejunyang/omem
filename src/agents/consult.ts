import type { Execution } from "./execution.ts";
import type { App } from "../core/app.ts";
import { run } from "../core/db.ts";
import { now, truncate } from "../core/util.ts";
import { runRole } from "./runner.ts";
import { addRunEvent, createRun, flushRunText, setRunOutput } from "./runs.ts";
import type { AgentSpec } from "./specs.ts";
import { replyOf } from "./types.ts";

/** What a consulted agent cannot do: ask on, or hand work out. */
const NO_HANDOFF = ["ask_agent", "run_agent", "continue_agent_work", "delegate_code", "continue_code_run"];

/**
 * One agent asks another a question and waits for the answer (`ask_agent`). The consulted agent
 * runs right here, inside the asking tool call, rather than through the queue: the asker holds a
 * worker slot while it waits, so queueing could deadlock once every slot waits on a consult. It is
 * still a run of its own (kind agent, child of the asking run) so its work shows in the run list
 * and in Feishu like any other agent's.
 */
export async function consultAgent(app: App, i: { execution?: Execution; spec: AgentSpec; question: string; askedBy: string; parentRunId: string | null; spaceId: string; userId?: string }): Promise<string> {
  const r = createRun(app, {
    kind: "agent",
    spaceId: i.spaceId,
    title: truncate(`${i.spec.name}（被 ${i.askedBy} 请教）：${i.question.split("\n")[0]}`, 80),
    input: { spec: i.spec.name, task: i.question, execution: i.execution, consultOf: i.parentRunId, askedBy: i.askedBy },
    parentId: i.parentRunId,
    userId: i.userId ?? null,
  });
  // Claimed before the worker's next look (it runs on a microtask after this synchronous step).
  run(app.db, "update runs set status = 'running', started_at = ? where id = ? and status = 'queued'", now(), r.id);
  app.emit({ type: "run", runId: r.id, status: "running" });
  try {
    const res = await runRole(app, {
      role: "assistant",
      spec: i.spec,
      execution: i.execution,
      spaceId: i.spaceId,
      task: `${i.askedBy} 在工作中向你请教（只回答问题，不要接手它的整件工作）：\n\n${i.question}`,
      runId: r.id,
      userId: i.userId,
      denyTools: NO_HANDOFF,
      onEvent: (e) => addRunEvent(app, r.id, e.type, e),
    });
    flushRunText(app, r.id);
    const answer = replyOf(res).trim() || "（没有回答）";
    setRunOutput(app, r.id, { answer, ai: res.ai });
    run(app.db, "update runs set status = 'done', profile_id = ?, finished_at = ? where id = ?", res.profileId, now(), r.id);
    app.emit({ type: "run", runId: r.id, status: "done" });
    return `${i.spec.name} 的回答（运行 ${r.id}）：\n\n${answer}`;
  } catch (e) {
    flushRunText(app, r.id);
    run(app.db, "update runs set status = 'failed', error = ?, finished_at = ? where id = ?", (e as Error).message, now(), r.id);
    addRunEvent(app, r.id, "error", { message: (e as Error).message });
    app.emit({ type: "run", runId: r.id, status: "failed" });
    return `请教 ${i.spec.name} 失败：${(e as Error).message}`;
  }
}
