import type { App } from "../core/app.ts";
import { all, one } from "../core/db.ts";
import { HttpError, truncate } from "../core/util.ts";
import { createRun, getRun, type Run } from "./runs.ts";

/**
 * Retry a run that failed or was stopped. Work with something to keep is continued rather than
 * redone: a coding run goes on in its worktrees and coding Agent session (the changes made so far
 * stay), and an agent run is told what the failed attempt already did (a message it already
 * posted is not posted again). Other runs are queued again with the same input.
 */
export async function retryRun(app: App, id: string, userId?: string): Promise<Run & { continued?: boolean }> {
  const r = getRun(app, id);
  if (r.status === "queued" || r.status === "running") throw new HttpError(409, "这次运行还没结束");
  const owner = userId ?? one<{ user_id: string | null }>(app.db, "select user_id from runs where id = ?", id)?.user_id ?? undefined;
  if (r.kind === "code") {
    const continued = await continueCode(app, r, owner);
    if (continued) return { ...continued, continued: true };
  }
  if (r.kind === "agent") {
    // Only work rounds and silent investigations keep their session; others start a new one.
    const session = r.input.agentWorkId || r.input.silent ? lastSession(app, r.id) : undefined;
    const input = { ...r.input, retryOf: r.id, ...(session ? { resumeSessionId: session } : {}) };
    return { ...createRun(app, { kind: r.kind, spaceId: r.spaceId, title: r.title, input, parentId: r.parentId, lane: r.lane, ...(owner ? { userId: owner } : {}) }), continued: true };
  }
  return createRun(app, { kind: r.kind, spaceId: r.spaceId, title: r.title, input: r.input, parentId: r.parentId, lane: r.lane, ...(owner ? { userId: owner } : {}) });
}

/** The latest agent session a run opened (ACP reports it as soon as it is open), coding phase first. */
export function lastSession(app: App, runId: string, phase?: string): string | undefined {
  const rows = all<{ data: string }>(app.db, "select data from run_events where run_id = ? and type = 'session' order by seq desc", runId);
  for (const row of rows) {
    const d = JSON.parse(row.data) as { sessionId?: string; phase?: string };
    if (d.sessionId && (!phase || d.phase === phase)) return d.sessionId;
  }
  return undefined;
}

/**
 * What a failed attempt got done before it stopped, for the attempt that continues it: its error
 * and the writes it made (messages posted, files written, wake-ups set), so none is repeated.
 */
export function attemptNote(app: App, runId: string) {
  const r = getRun(app, runId);
  const writes = all<{ data: string }>(app.db, "select data from run_events where run_id = ? and type = 'tool-write' order by seq", runId).map((row) => {
    const d = JSON.parse(row.data) as { name?: string; args?: unknown };
    return `- ${d.name ?? "?"} ${truncate(JSON.stringify(d.args ?? {}), 300)}`;
  });
  return [
    `# 上一次尝试（运行 ${r.id}）没有完成`,
    "",
    `结果：${r.status === "cancelled" ? "被停止" : `失败：${truncate(r.error ?? "", 600)}`}`,
    writes.length ? `\n它已经做过这些写入，不要重复（已发的消息不要再发，写过的文件接着用）：\n${writes.slice(-30).join("\n")}` : "\n它还没有做过任何写入。",
    "",
    "接着把任务做完，不要从头重做已经完成的部分。",
  ].join("\n");
}

/** A coding run continues in its worktrees: another round of the same chain, or of the same work. */
async function continueCode(app: App, r: Run, owner?: string): Promise<Run | null> {
  const rootId = String(r.input.continueFrom ?? r.id);
  const root = getRun(app, rootId);
  if (root.output.appliedAt || root.output.discardedAt) return null;
  const { worktreesOf } = await import("./code.ts");
  if (!worktreesOf(app, rootId).length) return null;
  const session = (r.output.coderSessionId as string | undefined) ?? lastSession(app, r.id, "coder");
  const extraInput = { retryOf: r.id };
  const chain = r.output.codeChain as import("./code-chain.ts").CodeChain | undefined;
  if (chain) {
    if (chain.lastCodeRunId !== r.id) throw new HttpError(409, "这一轮之后已经有新的一轮了：重试最新的那一轮");
    const { queueNextCodeRound } = await import("./code-chain.ts");
    return queueNextCodeRound(app, chain, String(r.input.task ?? ""), { resumeSessionId: session, manual: true, extraInput })?.run ?? null;
  }
  // Not tied to a conversation (delegated from the web page): the same work, in its worktrees.
  return createRun(app, {
    kind: "code",
    spaceId: r.spaceId,
    title: r.title,
    input: { ...r.input, ...extraInput, continueFrom: rootId, ...(session ? { resumeSessionId: session } : {}), sync: undefined, syncOnly: undefined, syncResume: undefined, moveToTarget: undefined },
    parentId: r.parentId,
    ...(owner ? { userId: owner } : {}),
  });
}
