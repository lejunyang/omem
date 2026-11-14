import type { App } from "../core/app.ts";
import { upkeepRoles } from "../core/config.ts";
import { all, one, run } from "../core/db.ts";
import { now } from "../core/util.ts";

/**
 * Recall accounting for memories: every time a memory is put in front of an agent it is logged,
 * and when the run finishes we mark which of them it cited (in its answer or in what it wrote).
 *
 * How it got there (`via`): the agent asked (`recall`), it was close to what the person just said or
 * to the task (`passive`), or it was among the preferences and experience picked for a task (`lesson`).
 * What for (`purpose`): `answer` — a run that answers or acts; `upkeep` — a role that keeps the
 * knowledge in order looked at it before writing (config.upkeepRoles). Upkeep lookups are most of
 * the rows and say nothing about whether a memory is useful, so the figures leave them out.
 */
export type RecallVia = "recall" | "passive" | "lesson";
export type RecallPurpose = "answer" | "upkeep";

export const recallPurpose = (who?: string | null): RecallPurpose => (who && upkeepRoles.has(who) ? "upkeep" : "answer");

export function recordRecalls(app: App, ids: string[], ctx: { runId: string | null; profile?: string | null; spec?: string; via?: RecallVia; purpose?: RecallPurpose }) {
  if (!ids.length) return;
  const purpose = ctx.purpose ?? recallPurpose(ctx.spec);
  for (const id of ids) {
    run(
      app.db,
      "insert into memory_recalls(memory_id, run_id, agent_profile, agent_spec, used, at, via, purpose) values(?,?,?,?,0,?,?,?)",
      id,
      ctx.runId,
      ctx.profile ?? null,
      ctx.spec ?? null,
      now(),
      ctx.via ?? "recall",
      purpose,
    );
  }
}

/** A run "used" a memory when it cited it or wrote it into an item/page/message/run output. */
export function markUsed(app: App, runId: string, memoryIds: string[]) {
  if (!memoryIds.length) return;
  const placeholders = memoryIds.map(() => "?").join(",");
  run(app.db, `update memory_recalls set used = 1 where run_id = ? and used = 0 and memory_id in (${placeholders})`, runId, ...memoryIds);
}

export type ViaStats = { shown: number; used: number; memories: number; runs: number };

/** Everything but `upkeepRecalls` counts runs that answer or act only. */
export type MemoryRecallStats = {
  total: number;
  /** Preferences: a conversation always carries them, so "never recalled" does not apply to them. */
  standing: number;
  recalled: number;
  /** Not a preference, and never in front of a run that answers or acts. */
  neverRecalled: number;
  totalRecalls: number;
  usedRecalls: number;
  distinctRecalls: number;
  distinctUsed: number;
  passiveRecalls: number;
  passiveUsed: number;
  byVia: Record<RecallVia, ViaStats>;
  /** Lookups by the roles that keep the knowledge in order (before writing, while reviewing). */
  upkeepRecalls: number;
};

export function recallStats(app: App, opts: { spaceId?: string; includeInactive?: boolean } = {}): MemoryRecallStats {
  const where: string[] = [];
  const params: string[] = [];
  if (opts.spaceId) where.push("m.space_id = ?"), params.push(opts.spaceId);
  if (!opts.includeInactive) where.push("m.status = 'active'");
  const mem = where.length ? where.join(" and ") : "1";
  const totals = one<{ total: number; standing: number }>(app.db, `select count(*) total, coalesce(sum(m.kind = 'preference'), 0) standing from memories m where ${mem}`, ...params)!;
  const rows = all<{ via: string; shown: number; used: number; memories: number; runs: number }>(
    app.db,
    `select r.via, count(*) shown, coalesce(sum(r.used), 0) used, count(distinct r.memory_id) memories, count(distinct r.run_id) runs
     from memory_recalls r join memories m on m.id = r.memory_id where r.purpose = 'answer' and ${mem} group by r.via`,
    ...params,
  );
  const overall = one<{ recalled: number; others: number; pairs: number; usedPairs: number }>(
    app.db,
    `select count(distinct r.memory_id) recalled, count(distinct case when m.kind != 'preference' then r.memory_id end) others,
       count(distinct r.memory_id || '|' || coalesce(r.run_id, '')) pairs,
       count(distinct case when r.used = 1 then r.memory_id || '|' || coalesce(r.run_id, '') end) usedPairs
     from memory_recalls r join memories m on m.id = r.memory_id where r.purpose = 'answer' and ${mem}`,
    ...params,
  )!;
  const upkeep = one<{ n: number }>(app.db, `select count(*) n from memory_recalls r join memories m on m.id = r.memory_id where r.purpose = 'upkeep' and ${mem}`, ...params)!.n;
  const byVia: Record<RecallVia, ViaStats> = { recall: { shown: 0, used: 0, memories: 0, runs: 0 }, passive: { shown: 0, used: 0, memories: 0, runs: 0 }, lesson: { shown: 0, used: 0, memories: 0, runs: 0 } };
  for (const r of rows) if (r.via in byVia) byVia[r.via as RecallVia] = { shown: r.shown, used: r.used, memories: r.memories, runs: r.runs };
  const shown = rows.reduce((n, r) => n + r.shown, 0);
  return {
    total: totals.total,
    standing: totals.standing,
    recalled: overall.recalled,
    neverRecalled: totals.total - totals.standing - overall.others,
    totalRecalls: shown,
    usedRecalls: rows.reduce((n, r) => n + r.used, 0),
    distinctRecalls: overall.pairs,
    distinctUsed: overall.usedPairs,
    passiveRecalls: byVia.passive.shown,
    passiveUsed: byVia.passive.used,
    byVia,
    upkeepRecalls: upkeep,
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

/** Per memory, counting runs that answer or act only. "never" leaves preferences out (a conversation always carries them). */
export function memoriesWithRecall(app: App, opts: { spaceId?: string; sort?: "recalls" | "never" | "unused" | "recent"; limit?: number } = {}): MemoryRecallRow[] {
  const limit = Math.min(opts.limit ?? 500, 2000);
  const where: string[] = ["m.status = 'active'"];
  const params: (string | number)[] = [];
  if (opts.spaceId) where.push("m.space_id = ?"), params.push(opts.spaceId);
  if (opts.sort === "never") where.push("m.kind != 'preference'");
  const order =
    opts.sort === "never" ? "recalls asc, m.updated_at desc"
    : opts.sort === "unused" ? "used asc, recalls desc, m.updated_at desc"
    : opts.sort === "recent" ? "lastRecalledAt desc"
    : "recalls desc, used desc, m.updated_at desc";
  return all<MemoryRecallRow>(
    app.db,
    `select m.id, m.space_id as spaceId, m.kind, m.subject, m.content, m.status, m.agent, m.updated_at as updatedAt,
       (select count(*) from memory_recalls mr where mr.memory_id = m.id and mr.purpose = 'answer') recalls,
       (select count(*) from memory_recalls mr where mr.memory_id = m.id and mr.purpose = 'answer' and mr.used = 1) used,
       (select max(at) from memory_recalls mr where mr.memory_id = m.id and mr.purpose = 'answer') lastRecalledAt
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
