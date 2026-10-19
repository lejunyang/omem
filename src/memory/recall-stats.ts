import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { now } from "../core/util.ts";

/**
 * Recall accounting for memories. Every `recall` result is logged once per
 * run; when the run finishes we mark which recalled memories it actually used
 * (referenced in writes or its answer). The UI and CLI use it to find dead
 * memories (never recalled) and ineffective ones (recalled but never used).
 */
export function recordRecalls(app: App, ids: string[], ctx: { runId: string | null; profile?: string | null; spec?: string }) {
  if (!ids.length) return;
  for (const id of ids) {
    run(
      app.db,
      "insert into memory_recalls(memory_id, run_id, agent_profile, agent_spec, used, at) values(?,?,?,?,0,?)",
      id,
      ctx.runId,
      ctx.profile ?? null,
      ctx.spec ?? null,
      now(),
    );
  }
}

/** A run "used" a memory when it cited it or wrote it into an item/page/message/run output. */
export function markUsedRuns(app: App, memoryIds: string[]) {
  if (!memoryIds.length) return;
  const placeholders = memoryIds.map(() => "?").join(",");
  run(app.db, `update memory_recalls set used = 1 where used = 0 and memory_id in (${placeholders})`, ...memoryIds);
}

export type MemoryRecallStats = {
  total: number;
  recalled: number;
  neverRecalled: number;
  totalRecalls: number;
  usedRecalls: number;
  distinctRecalls: number;
  distinctUsed: number;
};

export function recallStats(app: App, opts: { spaceId?: string; includeInactive?: boolean } = {}): MemoryRecallStats {
  const memRows = all<{ id: string; space_id: string; status: string }>(
    app.db,
    "select id, space_id, status from memories",
  ).filter((m) => (!opts.spaceId || m.space_id === opts.spaceId) && (opts.includeInactive || m.status === "active"));
  const ids = new Set(memRows.map((m) => m.id));
  const ev = all<{ memory_id: string; run_id: string | null; used: number }>(
    app.db,
    "select memory_id, run_id, used from memory_recalls",
  ).filter((x) => ids.has(x.memory_id));
  const recalledIds = new Set(ev.map((x) => x.memory_id));
  const distinct = new Set(ev.map((x) => `${x.memory_id}|${x.run_id ?? ""}`));
  const distinctUsed = new Set(ev.filter((x) => x.used).map((x) => `${x.memory_id}|${x.run_id ?? ""}`));
  return {
    total: memRows.length,
    recalled: recalledIds.size,
    neverRecalled: memRows.length - recalledIds.size,
    totalRecalls: ev.length,
    usedRecalls: ev.filter((x) => x.used).length,
    distinctRecalls: distinct.size,
    distinctUsed: distinctUsed.size,
  };
}

export type MemoryRecallRow = {
  id: string;
  spaceId: string;
  kind: string;
  subject: string;
  content: string;
  status: string;
  agent: string | null;
  updatedAt: string;
  recalls: number;
  used: number;
  lastRecalledAt: string | null;
};

export function memoriesWithRecall(app: App, opts: { spaceId?: string; sort?: "recalls" | "never" | "unused" | "recent"; limit?: number } = {}): MemoryRecallRow[] {
  const limit = Math.min(opts.limit ?? 500, 2000);
  const where: string[] = ["m.status = 'active'"];
  const params: (string | number)[] = [];
  if (opts.spaceId) where.push("m.space_id = ?"), params.push(opts.spaceId);
  const order =
    opts.sort === "never" ? "recalls asc, m.updated_at desc"
    : opts.sort === "unused" ? "used asc, recalls desc, m.updated_at desc"
    : opts.sort === "recent" ? "last_recalled desc"
    : "recalls desc, used desc, m.updated_at desc";
  return all<MemoryRecallRow>(
    app.db,
    `select m.id, m.space_id as spaceId, m.kind, m.subject, m.content, m.status, m.agent, m.updated_at as updatedAt,
       (select count(*) from memory_recalls mr where mr.memory_id = m.id) recalls,
       (select count(*) from memory_recalls mr where mr.memory_id = m.id and mr.used = 1) used,
       (select max(at) from memory_recalls mr where mr.memory_id = m.id) lastRecalledAt
     from memories m where ${where.join(" and ")} order by ${order} limit ?`,
    ...params,
    limit,
  );
}

/** Whether a run's output references memory ids, for marking used recalls on completion. */
export function usedMemoryIds(app: App, runId: string, candidateIds: string[]): string[] {
  if (!candidateIds.length) return [];
  const hay = [
    one<{ output: string | null; error: string | null }>(app.db, "select output, error from runs where id = ?", runId)?.output ?? "",
    ...all<{ text: string }>(app.db, "select text from messages where run_id = ?", runId).map((x) => x.text),
    ...all<{ data: string }>(app.db, "select data from run_events where run_id = ? and type in ('tool-write','text')", runId).map((x) => x.data),
  ].join("\n");
  return candidateIds.filter((id) => hay.includes(id));
}
