import type { App } from "../core/app.ts";
import { all, one } from "../core/db.ts";
import { json } from "../core/util.ts";
import { worktreesOf } from "../agents/code.ts";
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
export type WorkStage = "coding" | "reviewing" | "peer" | "owner" | "done" | "applied" | "discarded";
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
  branch: string | null;
  /** Findings of the latest round the owner has not decided on yet (hints left out). */
  open: number;
  createdAt: string;
  updatedAt: string;
};

type RunRow = { id: string; status: string; title: string; input: string; output: string; created_at: string; finished_at: string | null };
type ReqMaterial = { item_id: string; ref: string; title: string };

function reqMaterials(app: App, userId: string) {
  return all<ReqMaterial>(app.db, "select m.item_id, m.ref, i.title from item_materials m join items i on i.id = m.item_id where m.kind = 'req' and i.user_id = ? and i.status not in ('cancelled')", userId);
}

/** One work's state from its rounds (oldest first). */
function workOf(app: App, item: { id: string; title: string }, rounds: RunRow[]): Work {
  const root = rounds[0];
  const last = rounds.at(-1)!;
  const rootIn = json<{ branches?: Record<string, { branch: string }>; fromBranches?: Record<string, string>; branchNames?: Record<string, string> }>(root.input, {});
  const outs = rounds.map((r) => json<{ verdict?: string | null; appliedAt?: string; discardedAt?: string }>(r.output, {}));
  const out = outs.at(-1)!;
  const branchReview = !!rootIn.branches;
  const open = one<{ n: number }>(app.db, "select count(*) n from review_findings f join reviews r on r.id = f.review_id where r.code_run_id = ? and f.state in ('open', 'accepted') and f.severity != 'nit' and f.decision is null", last.id)!.n;
  const reviewing = !!one(app.db, "select 1 from runs where kind = 'review' and parent_id = ? and status in ('queued', 'running')", last.id);
  const verdict = out.verdict ?? null;
  const stage: WorkStage = outs.some((o) => o.appliedAt) ? "applied"
    : outs.some((o) => o.discardedAt) ? "discarded"
    : ["queued", "running"].includes(last.status) ? (branchReview ? "reviewing" : "coding")
    : reviewing ? "reviewing"
    : verdict === "awaiting-peer" || verdict === "awaiting-peer-code" ? "peer"
    : branchReview && last.status === "done" && verdict !== "awaiting-plan" && (verdict === "approved" || !open) ? "done"
    : "owner";
  let branch = Object.values(rootIn.branches ?? {})[0]?.branch ?? Object.values(rootIn.fromBranches ?? {})[0] ?? Object.values(rootIn.branchNames ?? {})[0] ?? null;
  if (!branch) {
    const w = worktreesOf(app, root.id)[0];
    branch = w?.targetBranch ?? w?.branch ?? null;
  }
  return {
    itemId: item.id, itemTitle: item.title, rootId: root.id, latestId: last.id, title: last.title, rounds: rounds.map((r) => r.id),
    status: last.status, verdict, stage, branchReview, branch, open, createdAt: root.created_at, updatedAt: last.finished_at ?? last.created_at,
  };
}

/** Every work done for the item, newest first. */
export function itemWork(app: App, item: { id: string; title: string }): Work[] {
  const runs = all<{ ref: string }>(app.db, "select ref from item_materials where item_id = ? and kind = 'run'", item.id).map((r) => r.ref);
  const roots = new Set<string>();
  for (const id of runs) {
    const r = one<{ kind: string; input: string }>(app.db, "select kind, input from runs where id = ?", id);
    if (r?.kind !== "code") continue;
    roots.add(json<{ continueFrom?: string }>(r.input, {}).continueFrom ?? id);
  }
  return [...roots]
    .map((root) => all<RunRow>(app.db, "select id, status, title, input, output, created_at, finished_at from runs where id = ? or (kind = 'code' and json_extract(input, '$.continueFrom') = ?) order by created_at", root, root))
    .filter((rounds) => rounds.length)
    .map((rounds) => workOf(app, item, rounds))
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
