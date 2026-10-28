import { existsSync, realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { App } from "../core/app.ts";
import { all } from "../core/db.ts";
import { git } from "../core/git.ts";
import { findSpace } from "../core/spaces.ts";
import { discardCodeRun, worktreesOf } from "./code.ts";
import { listRuns, runUser, type Run } from "./runs.ts";
import { workDirOf } from "./workspaces.ts";

/**
 * Cleaning up after delegations (the assistant's `clean_code_runs`): what is left on disk and how to
 * let it go.
 *
 * - `discard`: a delegation never applied nor discarded whose worktrees are still there. Discarding
 *   removes them (a reused slot or the main directory is reset), the changes are gone.
 * - `receiver`: where an applied delegation landed when the target branch had no checkout, a
 *   worktree under `runs/<id>/applied/`; removing it drops what was applied and not committed.
 * - `stray`: a worktree under the runs directory whose delegation is gone, applied or discarded
 *   (left by a crash or an older version); removed, and the repository's worktree list pruned.
 */
export type CleanupItem = { kind: "discard" | "receiver" | "stray"; run: string; title: string; space: string; path: string; changed: number; branch?: string | null };

const realOr = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};
const inside = (dir: string, p: string) => {
  const rel = relative(realOr(dir), realOr(p));
  return !!rel && !rel.startsWith("..") && !rel.startsWith(sep) && !/^[a-zA-Z]:/.test(rel);
};
const changedFiles = (path: string) => (existsSync(path) ? git(path, ["status", "--porcelain"]).stdout.split("\n").filter(Boolean).length : 0);

type Chain = { first: Run; rounds: Run[] };

/** Each delegation (first round) with its rounds, newest delegation first. */
function chains(app: App): Chain[] {
  const runs = listRuns(app, { kind: "code", limit: 500, includeQuiet: true });
  const byFirst = new Map<string, Chain>();
  for (const r of [...runs].reverse()) {
    const first = String(r.input.continueFrom ?? r.id);
    const c = byFirst.get(first) ?? { first: r, rounds: [] };
    if (r.id === first) c.first = r;
    c.rounds.push(r);
    byFirst.set(first, c);
  }
  return [...byFirst.values()].reverse();
}

/**
 * What can be cleaned for `userId` (null: everyone's), limited to `spaces` (null: all) and to the
 * delegations in `runIds` (any round's id) when given. Running delegations are left out.
 */
export function cleanupCandidates(app: App, opts: { userId: string | null; spaces: Set<string> | null; runIds?: string[]; receivers?: boolean }): { items: CleanupItem[]; running: { run: string; title: string }[] } {
  const items: CleanupItem[] = [];
  const running: { run: string; title: string }[] = [];
  const wanted = opts.runIds?.length ? new Set(opts.runIds) : null;
  const visible = (space: string) => !opts.spaces || opts.spaces.has(space);
  const every = chains(app);
  for (const c of every) {
    if (opts.userId && runUser(app, c.first.id) !== opts.userId) continue;
    if (wanted && !c.rounds.some((r) => wanted.has(r.id))) continue;
    const latest = c.rounds.at(-1)!;
    const applied = c.rounds.find((r) => r.output.appliedAt);
    const discarded = c.rounds.some((r) => r.output.discardedAt);
    const repos = ((c.first.input.repos as string[] | undefined) ?? (c.first.spaceId ? [c.first.spaceId] : [])).filter(visible);
    if (!repos.length) continue;
    if (c.rounds.some((r) => r.status === "running" || r.status === "queued")) {
      running.push({ run: latest.id, title: latest.title });
      continue;
    }
    if (!applied && !discarded) {
      for (const wt of worktreesOf(app, latest.id).filter((w) => repos.includes(w.space) && existsSync(w.path)))
        items.push({ kind: "discard", run: latest.id, title: latest.title, space: wt.space, path: workDirOf(wt), changed: changedFiles(wt.path), branch: wt.inPlace ? wt.targetBranch : wt.branch || null });
    }
    if (applied && opts.receivers) {
      const targets = (applied.output.appliedTo ?? c.first.output.appliedTo ?? []) as { space: string; path: string; branch: string | null }[];
      for (const t of targets.filter((t) => repos.includes(t.space) && existsSync(t.path) && inside(join(app.runsDir, c.first.id, "applied"), t.path)))
        items.push({ kind: "receiver", run: c.first.id, title: c.first.title, space: t.space, path: t.path, changed: changedFiles(t.path), branch: t.branch });
    }
  }
  // Worktrees under the runs directory that no live delegation holds.
  for (const s of repoSpaces(app).filter((s) => visible(s.id))) {
    const listed = git(s.rootPath, ["worktree", "list", "--porcelain", "-z"]);
    if (!listed.ok) continue;
    for (const block of listed.stdout.split("\0\0")) {
      const path = block.split("\0").find((f) => f.startsWith("worktree "))?.slice(9);
      if (!path || !inside(app.runsDir, path)) continue;
      const [run, where] = relative(realOr(app.runsDir), realOr(path)).split(/[\\/]/);
      if (wanted && !wanted.has(run)) continue;
      if (items.some((i) => realOr(i.path) === realOr(path))) continue;
      const c = every.find((x) => x.first.id === run);
      const live = c && !c.rounds.some((r) => r.output.discardedAt) && (where === "applied" || !c.rounds.some((r) => r.output.appliedAt));
      if (live) continue;
      if (c && opts.userId && runUser(app, c.first.id) !== opts.userId) continue;
      items.push({ kind: "stray", run, title: c?.first.title ?? "（交办记录已不在）", space: s.id, path: resolve(path), changed: changedFiles(path) });
    }
  }
  return { items, running };
}

function repoSpaces(app: App) {
  return all<{ id: string; root_path: string }>(app.db, "select id, root_path from spaces where kind = 'repo' and root_path is not null")
    .filter((s) => existsSync(s.root_path))
    .map((s) => ({ id: s.id, rootPath: s.root_path }));
}

/** Clean exactly these items (from `cleanupCandidates`); returns what happened to each. */
export function cleanItems(app: App, items: CleanupItem[]) {
  const done: string[] = [];
  const failed: string[] = [];
  for (const run of new Set(items.filter((i) => i.kind === "discard").map((i) => i.run))) {
    try {
      discardCodeRun(app, run);
      done.push(`丢弃交办 ${run}`);
    } catch (e) {
      failed.push(`${run}：${(e as Error).message}`);
    }
  }
  for (const i of items.filter((i) => i.kind !== "discard")) {
    const root = findSpace(app, i.space)?.rootPath;
    if (!root) continue;
    const r = git(root, ["worktree", "remove", "--force", i.path]);
    (r.ok || !existsSync(i.path) ? done : failed).push(r.ok || !existsSync(i.path) ? `删掉${i.kind === "receiver" ? "接收工作区" : "遗留工作区"} ${i.path}` : `${i.path}：${r.stderr.trim().slice(0, 300)}`);
  }
  for (const s of new Set(items.map((i) => i.space))) {
    const root = findSpace(app, s)?.rootPath;
    if (root) git(root, ["worktree", "prune"]);
  }
  return { done, failed };
}
