import type { App } from "../core/app.ts";
import { all } from "../core/db.ts";
import { json } from "../core/util.ts";
import { isBranchWork } from "../agents/code-branch.ts";
import type { WorktreeRef } from "../agents/worktree-index.ts";
import { findReq, reqPath } from "./requirements.ts";

/**
 * The coding done for an item, seen from the requirement tree (docs/v2/requirements.md): an item's
 * `req` materials mark the part of the tree it is about, its `run` materials the delegations and
 * branch reviews done for it. A node shows the work of every item whose part contains it or lies
 * under it; one work is a delegation (or branch review) with all its rounds.
 *
 * `stage`: coding / reviewing (a round or its review is running), peer (an outside Agent on another
 * device is coding or reviewing), owner (waiting for the owner: a plan to confirm, findings to decide,
 * a result to apply, a failure), done (a branch review with nothing left to decide), applied, discarded.
 */
export type WorkStage = "coding" | "reviewing" | "peer" | "assistant" | "owner" | "done" | "applied" | "discarded";
export type Work = {
  itemId: string;
  itemTitle: string;
  rootId: string;
  latestId: string;
  title: string;
  /** Round runs, oldest first. */
  rounds: string[];
  status: string;
  verdict: string | null;
  stage: WorkStage;
  branchReview: boolean;
  /** Rounds commit on a work branch, confirmed by pushing it (code-branch.ts) rather than applied as a patch. */
  branchWork: boolean;
  branch: string | null;
  /** Findings of the latest round the owner has not decided on yet (hints left out). */
  open: number;
  createdAt: string;
  updatedAt: string;
};

type RunRow = { id: string; root_id: string; space_id: string; status: string; title: string; input: string; output: string; created_at: string; finished_at: string | null };
type WorkOutput = { verdict?: string | null; appliedAt?: string; discardedAt?: string; worktrees?: WorktreeRef[]; worktree?: string; branch?: string; base?: string };
type ReqMaterial = { item_id: string; ref: string; title: string };

function reqMaterials(app: App, userId: string) {
  return all<ReqMaterial>(app.db, "select m.item_id, m.ref, i.title from item_materials m join items i on i.id = m.item_id where m.kind = 'req' and i.user_id = ? and i.status not in ('cancelled')", userId);
}

/** One work's state from its rounds (oldest first). */
function workOf(item: { id: string; title: string }, rounds: RunRow[], open: number, reviewing: boolean): Work {
  const root = rounds[0];
  const last = rounds.at(-1)!;
  const rootIn = json<{ branches?: Record<string, { branch: string }>; fromBranches?: Record<string, string>; branchNames?: Record<string, string> }>(root.input, {});
  const outs = rounds.map((r) => json<WorkOutput>(r.output, {}));
  const out = outs.at(-1)!;
  const branchReview = !!rootIn.branches;
  const verdict = out.verdict ?? null;
  const stage: WorkStage = outs.some((o) => o.appliedAt) ? "applied"
    : outs.some((o) => o.discardedAt) ? "discarded"
    : ["queued", "running"].includes(last.status) ? (branchReview ? "reviewing" : "coding")
    : reviewing ? "reviewing"
    : verdict === "awaiting-peer" || verdict === "awaiting-peer-code" ? "peer"
    : branchReview && last.status === "done" && verdict !== "awaiting-plan" && (verdict === "approved" || !open) ? "done"
    // Waiting on the assistant that started it, not on the owner.
    : verdict === "awaiting-assistant" ? "assistant"
    : "owner";
  const first = outs[0];
  const wts = first.worktrees ?? (first.worktree && root.space_id ? [{ space: root.space_id, path: first.worktree, branch: first.branch ?? "", base: first.base ?? "" }] : []);
  const branch = Object.values(rootIn.branches ?? {})[0]?.branch ?? Object.values(rootIn.fromBranches ?? {})[0] ?? Object.values(rootIn.branchNames ?? {})[0] ?? wts[0]?.targetBranch ?? wts[0]?.branch ?? null;
  return {
    itemId: item.id, itemTitle: item.title, rootId: root.id, latestId: last.id, title: last.title, rounds: rounds.map((r) => r.id),
    status: last.status, verdict, stage, branchReview, branchWork: !branchReview && isBranchWork(wts), branch, open, createdAt: root.created_at, updatedAt: last.finished_at ?? last.created_at,
  };
}

/** Every work done for the item, newest first. */
export function itemWork(app: App, item: { id: string; title: string }): Work[] {
  const roots = all<{ id: string }>(app.db, `select distinct coalesce(json_extract(r.input, '$.continueFrom'), r.id) id
    from item_materials m join runs r on r.id = m.ref where m.item_id = ? and m.kind = 'run' and r.kind = 'code'`, item.id).map((r) => r.id);
  if (!roots.length) return [];
  const marks = roots.map(() => "?").join(",");
  // Lists need status, branch and application metadata, never patches, check output or the run log.
  // Project in SQLite and batch the rounds: one query per work otherwise repeatedly scans runs and
  // decodes multi-megabyte outputs just to paint the requirement's coding list.
  const rows = all<RunRow>(app.db, `select id, coalesce(json_extract(input, '$.continueFrom'), id) root_id,
    space_id, status, title, created_at, finished_at,
    json_object('branches', json_extract(input, '$.branches'), 'fromBranches', json_extract(input, '$.fromBranches'), 'branchNames', json_extract(input, '$.branchNames')) input,
    json_object('verdict', json_extract(output, '$.verdict'), 'appliedAt', json_extract(output, '$.appliedAt'), 'discardedAt', json_extract(output, '$.discardedAt'),
      'worktrees', json_extract(output, '$.worktrees'), 'worktree', json_extract(output, '$.worktree'), 'branch', json_extract(output, '$.branch'), 'base', json_extract(output, '$.base')) output
    from runs where id in (${marks}) or (kind = 'code' and json_extract(input, '$.continueFrom') in (${marks})) order by created_at`, ...roots, ...roots);
  const grouped = new Map(roots.map((id) => [id, [] as RunRow[]]));
  for (const row of rows) {
    grouped.get(row.id)?.push(row);
    if (row.root_id !== row.id) grouped.get(row.root_id)?.push(row);
  }
  const groups = [...grouped.values()].filter((rounds) => rounds.length);
  if (!groups.length) return [];
  const latest = groups.map((rounds) => rounds.at(-1)!.id);
  const lastMarks = latest.map(() => "?").join(",");
  const findings = new Map(all<{ id: string; n: number }>(app.db, `select r.code_run_id id, count(*) n from review_findings f join reviews r on r.id = f.review_id
    where r.code_run_id in (${lastMarks}) and f.state in ('open', 'accepted') and f.severity != 'nit' and f.decision is null group by r.code_run_id`, ...latest).map((r) => [r.id, r.n]));
  const reviewing = new Set(all<{ parent_id: string }>(app.db, `select distinct parent_id from runs where kind = 'review' and status in ('queued', 'running') and parent_id in (${lastMarks})`, ...latest).map((r) => r.parent_id));
  return groups
    .map((rounds) => workOf(item, rounds, findings.get(rounds.at(-1)!.id) ?? 0, reviewing.has(rounds.at(-1)!.id)))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

/** The work of the items whose part of the tree contains `nodeId` or lies under it. */
export function reqWork(app: App, nodeId: string, userId: string): Work[] {
  const node = findReq(app, nodeId);
  if (!node) return [];
  const up = new Set(reqPath(app, node).map((n) => n.id));
  const items = new Map<string, string>();
  for (const m of reqMaterials(app, userId)) {
    if (up.has(m.ref)) items.set(m.item_id, m.title);
    else {
      const n = findReq(app, m.ref);
      if (n && n.spaceId === node.spaceId && reqPath(app, n).some((p) => p.id === nodeId)) items.set(m.item_id, m.title);
    }
  }
  return [...items].flatMap(([id, title]) => itemWork(app, { id, title })).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

/**
 * For a space's tree: the nodes an item is about (its `req` materials) with how many of that item's
 * works there are and how many wait for the owner.
 */
export function reqWorkMarks(app: App, spaceId: string, userId: string): Map<string, { total: number; waiting: number }> {
  const marks = new Map<string, { total: number; waiting: number }>();
  const cache = new Map<string, Work[]>();
  for (const m of reqMaterials(app, userId)) {
    if (findReq(app, m.ref)?.spaceId !== spaceId) continue;
    const works = cache.get(m.item_id) ?? itemWork(app, { id: m.item_id, title: m.title });
    cache.set(m.item_id, works);
    const live = works.filter((w) => w.stage !== "applied" && w.stage !== "discarded");
    if (!live.length) continue;
    const mark = marks.get(m.ref) ?? { total: 0, waiting: 0 };
    mark.total += live.length;
    mark.waiting += live.filter((w) => w.stage === "owner").length;
    marks.set(m.ref, mark);
  }
  return marks;
}
