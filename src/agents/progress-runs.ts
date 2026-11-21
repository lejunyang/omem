import type { App } from "../core/app.ts";
import { deviceLabels } from "../core/peers.ts";
import { all } from "../core/db.ts";
import { HttpError } from "../core/util.ts";
import { runAudience } from "../auth/permissions.ts";
import { runPredicate } from "../auth/run-scope.ts";
import type { Run } from "./runs.ts";

export type Usage = { input: number; output: number; cached?: number; runs: number; missing: number };
export type ProgressAttempt = { runId: string; status: Run["status"]; startedAt?: string; endedAt?: string; queuedMs: number; runMs?: number; usage: Usage; local: boolean; device: string; deviceName?: string; mode?: "borrow" | "remote"; access?: "read" | "write"; remoteRunId?: string; remoteUrl?: string; deadline?: string; lateAt?: string };
export type Reader = { user: string; spaces?: string[] | null };

export function visibleRuns(app: App, reader: Reader, alias = "r") {
  const audience = runAudience(app, reader.user);
  const review = runAudience(app, reader.user, "code.review.view");
  const clauses: string[] = [], params: string[] = [];
  if (audience && review) {
    const read = runPredicate(audience, alias), code = runPredicate(review, alias);
    clauses.push(read.sql, `(${alias}.kind not in ('code','review') or ${code.sql})`);
    params.push(...read.params, ...code.params);
  }
  if (reader.spaces) {
    const scoped = runPredicate({ userId: reader.user, spaces: reader.spaces, ownUnscoped: false, ownEmpty: false }, alias);
    clauses.push(scoped.sql);
    params.push(...scoped.params);
  }
  return { sql: clauses.join(" and ") || "1", params };
}

export type Node = {
  id: string; parent: string | null; kind: string; title: string; status: Run["status"]; ai: string | null;
  created: string; started: string | null; ended: string | null; item: string | null; first: string | null;
  helper: string | null; assigned: string | null; branches: string | null; plan: string | null; reviewStage: string | null;
  verdict: string | null; applied: string | null; discarded: string | null; paused: string | null;
  access?: "read" | "write" | null; peer: string | null; onlyChecks: string | null; splitOnly: number | null; stage: string | null; trial: string | null; flowStart: string | null; round: number | null;
};
const bound = 4096;
export function rootRun(app: App, id: string, reader: Reader) {
  const v = visibleRuns(app, reader);
  const rows = all<{ id: string }>(app.db, `with recursive ancestors(id,parent,depth) as (
    select r.id,coalesce(r.parent_id,json_extract(r.input,'$.continueFrom')),0 from runs r where r.id=? and ${v.sql}
    union all select r.id,coalesce(r.parent_id,json_extract(r.input,'$.continueFrom')),a.depth+1
    from ancestors a join runs r on r.id=a.parent where a.depth<100 and ${v.sql})
    select id from ancestors order by depth desc limit 1`, id, ...v.params, ...v.params);
  return rows[0]?.id;
}

/** One bounded, permission-filtered forest per request. Descendants beyond an unreadable run stay private. */
// Keep each recursive edge as an indexed lookup. Unary + removes the CTE column's TEXT
// affinity so SQLite can seek the JSON expression index; CROSS JOIN keeps the tree outermost.
export function runForest(app: App, seeds: string[], reader: Reader) {
  const v = visibleRuns(app, reader);
  const rows = all<Node>(app.db, `with recursive tree(id) as (
    select r.id from runs r where r.id in (select value from json_each(?)) and ${v.sql}
    union select r.id from tree cross join runs r indexed by runs_parent on r.parent_id=tree.id where ${v.sql}
    union select r.id from tree cross join runs r indexed by runs_continue_from on json_extract(r.input,'$.continueFrom')=+tree.id
      where ${v.sql} limit ${bound + 1})
    select r.id,r.parent_id parent,r.kind,r.title,r.status,r.ai,r.created_at created,r.started_at started,r.finished_at ended,
    coalesce(json_extract(input,'$.itemId'),json_extract(output,'$.turnContext.item.id')) item,
    json_extract(input,'$.continueFrom') first,json_extract(input,'$.helperOf') helper,json_extract(input,'$.tasks') assigned,
    json_extract(output,'$.worktrees') branches,json_extract(output,'$.reviewPlan.checks') plan,json_extract(output,'$.reviewStage') reviewStage,
    json_extract(output,'$.verdict') verdict,json_extract(output,'$.appliedAt') applied,json_extract(output,'$.discardedAt') discarded,
    json_extract(output,'$.work.paused') paused,json_extract(input,'$.only') onlyChecks,json_extract(input,'$.splitOnly') splitOnly,json_extract(input,'$.stageId') stage,json_extract(input,'$.trialId') trial,
    json_extract(input,'$.boardDevice.access') access,json_extract(input,'$.peer.node') peer,json_extract(input,'$.flowStartedAt') flowStart,json_extract(input,'$.round') round
    from tree cross join runs r on r.id=tree.id order by created,r.id`, JSON.stringify(seeds), ...v.params, ...v.params, ...v.params);
  if (rows.length > bound) throw new HttpError(413, "关联运行超过单次进度查询上限");
  // Only explicit split token totals count. A later context-window snapshot has no billing fields.
  const totals = all<{ run_id: string; input: number; output: number; cached: number | null }>(app.db, `select e.run_id,
    json_extract(e.data,'$.input') input,json_extract(e.data,'$.output') output,json_extract(e.data,'$.cached') cached
    from json_each(?) ids join run_events e on e.run_id=ids.value
    and e.seq=(select max(seq) from run_events indexed by progress_tokens where run_id=ids.value and type='usage'
      and json_type(data,'$.input')='integer' and json_type(data,'$.output')='integer')`, JSON.stringify(rows.map(r => r.id)));
  return new Forest(rows, new Map(totals.map(r => [r.run_id, r])), deviceLabels(app));
}

export class Forest {
  device: ReturnType<typeof deviceLabels>;
  nodes: Map<string, Node>;
  children = new Map<string, string[]>();
  totals: Map<string, { input: number; output: number; cached: number | null }>;
  constructor(rows: Node[], totals: Forest["totals"], device: Forest["device"]) {
    this.device = device;
    this.totals = totals;
    this.nodes = new Map(rows.map(r => [r.id, r]));
    for (const r of rows) if (r.parent) {
      const children = this.children.get(r.parent) ?? [];
      children.push(r.id);
      this.children.set(r.parent, children);
    }
  }
  sees(id?: string | null) { return !id || this.nodes.has(id); }
  contributors(ids: Iterable<string>, boundaries?: ReadonlySet<string>) {
    const seen = new Set<string>(), queue = [...ids];
    while (queue.length) {
      const id = queue.pop()!;
      if (seen.has(id) || !this.nodes.has(id)) continue;
      seen.add(id);
      for (const child of this.children.get(id) ?? []) if (!boundaries?.has(child)) queue.push(child);
    }
    return seen;
  }
  usage(ids: Iterable<string>, boundaries?: ReadonlySet<string>) {
    return this.sum(this.contributors(ids, boundaries));
  }
  sum(seen: Set<string>): Usage {
    const sum: Usage = { input: 0, output: 0, runs: seen.size, missing: 0 };
    for (const id of seen) {
      const record = this.totals.get(id);
      if (!record) { sum.missing++; continue; }
      sum.input += record.input;
      sum.output += record.output;
      if (record.cached != null) sum.cached = (sum.cached ?? 0) + record.cached;
    }
    return sum;
  }
  attempts(ids: (string | null | undefined)[], boundaries?: ReadonlySet<string>): ProgressAttempt[] {
    const rows = [...new Set(ids)].flatMap(id => id && this.nodes.has(id) ? [this.nodes.get(id)!] : []);
    return rows.sort((a, b) => a.created.localeCompare(b.created)).map(r => ({
      ...this.device(r.peer), access: r.access ?? undefined, runId: r.id, status: r.status, startedAt: r.started ?? undefined, endedAt: r.ended ?? undefined,
      queuedMs: Date.parse(r.started ?? r.ended ?? new Date().toISOString()) - Date.parse(r.created),
      runMs: r.started ? Date.parse(r.ended ?? new Date().toISOString()) - Date.parse(r.started) : undefined,
      usage: this.usage([r.id], boundaries),
    }));
  }
}
