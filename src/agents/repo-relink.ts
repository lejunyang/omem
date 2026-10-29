import { existsSync } from "node:fs";
import type { App } from "../core/app.ts";
import { git } from "../core/git.ts";
import { repositoryRoot, sameRepository } from "../core/repositories.ts";
import { getSpace, updateSpace } from "../core/spaces.ts";
import { HttpError } from "../core/util.ts";
import { cleanItems, cleanupCandidates } from "./code-cleanup.ts";
import { managedSlot, MAX_POOL } from "./workspaces.ts";

export type RelinkResult =
  | { done: true; old: string; root: string; pool: number; discarded: string[] }
  | { done: false; pending: { run: string; title: string }[] };

/**
 * Point a repository space at another checkout of the same repository (same remote): delegations
 * then start from, and apply to, that directory. Delegations still holding worktrees of the old
 * checkout are listed (`done: false`) unless `discard` lets them go; running ones refuse the move.
 * omem's own reusable worktrees belong to the old checkout and are removed (made again from the new
 * one when used); the new directory leaves the space's list of reusable workspaces.
 */
export function relinkRepoSpace(app: App, id: string, path: string, opts: { discard?: boolean; userId?: string | null } = {}): RelinkResult {
  const s = getSpace(app, id);
  const root = repositoryRoot(path);
  const old = s.rootPath;
  if (!old) throw new HttpError(400, `空间 ${id} 没有关联仓库`);
  if (repositoryRoot(old) === root) throw new HttpError(400, `空间 ${id} 已经关联 ${root}`);
  if (!sameRepository(old, root)) throw new HttpError(409, `${root} 和空间 ${id} 的仓库不是同一个（git remote 不同）；不同的仓库请另建空间`);
  const open = cleanupCandidates(app, { userId: opts.userId ?? null, spaces: new Set([id]) });
  if (open.running.length) throw new HttpError(409, `空间 ${id} 还有进行中的交办（${open.running.map((r) => r.run).join("、")}），等它们结束再改`);
  const pending = [...new Map(open.items.filter((i) => i.kind === "discard").map((i) => [i.run, { run: i.run, title: i.title }])).values()];
  let discarded: string[] = [];
  if (open.items.length) {
    if (pending.length && !opts.discard) return { done: false, pending };
    const r = cleanItems(app, open.items);
    if (r.failed.length) throw new HttpError(409, `清理旧仓库里的交办没有成功：${r.failed.join("；")}`);
    discarded = pending.map((p) => p.run);
  }
  // omem's workspaces belong to the old repository's worktree list; made again on the new one when needed.
  let pool = 0;
  for (let n = 1; n <= MAX_POOL; n++) if (existsSync(managedSlot(app, id, n)) && git(old, ["worktree", "remove", "--force", managedSlot(app, id, n)]).ok) pool++;
  git(old, ["worktree", "prune"]);
  const { pool: _p, workspaces: _w, inPlace: _i, ...settings } = s.settings as Record<string, unknown>;
  updateSpace(app, id, { rootPath: root, settings });
  return { done: true, old, root, pool, discarded };
}
