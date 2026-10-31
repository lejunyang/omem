import type { Execution } from "./execution.ts";
import type { App } from "../core/app.ts";
import type { RoleName } from "../core/config.ts";
import { run } from "../core/db.ts";
import { now, truncate } from "../core/util.ts";
import { runRole, type RoleRunInput } from "./runner.ts";
import { addRunEvent, createRun, flushRunText, setRunOutput } from "./runs.ts";
import type { AgentSpec } from "./specs.ts";
import type { AgentResult } from "./types.ts";
import { replyOf } from "./types.ts";

/** What a consulted agent cannot do: ask on, or hand work out. */
const NO_HANDOFF = ["ask_agent", "ask_reviewer", "run_agent", "continue_agent_work", "delegate_code", "review_branch", "continue_code_run"];

/**
 * One agent asks another a question and waits for the answer (`ask_agent`, and the coder asking the
 * review check that raised a task, `ask_reviewer`). The consulted agent runs right here, inside the
 * asking tool call, rather than through the queue: the asker holds a worker slot while it waits, so
 * queueing could deadlock once every slot waits on a consult. It is still a run of its own (kind
 * agent, child of the asking run) so its work shows in the run list and in Feishu like any other
 * agent's. A built-in role can be asked too (`role` instead of `spec`), with `extra` run options:
 * the session it resumes, where it works, what it may read.
 */
export async function consultAgent(app: App, i: {
  execution?: Execution; spec?: AgentSpec; role?: RoleName; label?: string; question: string; askedBy: string; parentRunId: string | null; spaceId: string; userId?: string;
  extra?: Partial<RoleRunInput>; onDone?: (res: AgentResult & { profileId: string }) => void;
}): Promise<string> {
  const name = i.label ?? i.spec?.name ?? i.role ?? "Agent";
  const r = createRun(app, {
    kind: "agent",
    spaceId: i.spaceId,
    title: truncate(`${name}（被 ${i.askedBy} 请教）：${i.question.split("\n")[0]}`, 80),
    input: { spec: i.spec?.name, role: i.spec ? undefined : i.role, task: i.question, execution: i.execution, consultOf: i.parentRunId, askedBy: i.askedBy },
    parentId: i.parentRunId,
    userId: i.userId ?? null,
  });
  // Claimed before the worker's next look (it runs on a microtask after this synchronous step).
  run(app.db, "update runs set status = 'running', started_at = ? where id = ? and status = 'queued'", now(), r.id);
  app.emit({ type: "run", runId: r.id, status: "running" });
  try {
    const res = await runRole(app, {
      role: i.spec ? "assistant" : i.role ?? "assistant",
      ...(i.spec ? { spec: i.spec } : {}),
      execution: i.execution,
      spaceId: i.spaceId,
      task: `${i.askedBy} 在工作中向你请教（只回答问题，不要接手它的整件工作）：\n\n${i.question}`,
      runId: r.id,
      userId: i.userId,
      denyTools: NO_HANDOFF,
      onEvent: (e) => addRunEvent(app, r.id, e.type, e),
      ...i.extra,
    });
    flushRunText(app, r.id);
    const answer = replyOf(res).trim() || "（没有回答）";
    setRunOutput(app, r.id, { answer, ai: res.ai });
    run(app.db, "update runs set status = 'done', profile_id = ?, finished_at = ? where id = ?", res.profileId, now(), r.id);
    app.emit({ type: "run", runId: r.id, status: "done" });
    i.onDone?.(res);
    return `${name} 的回答（运行 ${r.id}）：\n\n${answer}`;
  } catch (e) {
    flushRunText(app, r.id);
    run(app.db, "update runs set status = 'failed', error = ?, finished_at = ? where id = ?", (e as Error).message, now(), r.id);
    addRunEvent(app, r.id, "error", { message: (e as Error).message });
    app.emit({ type: "run", runId: r.id, status: "failed" });
    return `请教 ${name} 失败：${(e as Error).message}`;
  }
}
