import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve as resolvePath, sep } from "node:path";
import type { App } from "../core/app.ts";
import { one } from "../core/db.ts";
import { getRun } from "./runs.ts";
import { findSpace } from "../core/spaces.ts";
import { HttpError } from "../core/util.ts";
import { accessibleSpaces } from "../core/users.ts";
import { readSource } from "../sources/store.ts";

/** Where a file a delegation or review names was read from, and its bytes. */
export type RunFile = { from: "worktree" | "branch" | "repo" | "source"; space: string; path: string; bytes: () => Buffer; size: number; sourceId?: string };

/**
 * A file a delegation or review names (`space` optional; a path may start with the repository's
 * space id): the worktree while it exists, a reviewed branch's tip after it is gone, else the
 * repository; a path in another space the review read (a migration's source) comes from the index.
 * Only spaces `userId` may read.
 */
export async function readRunFile(app: App, runId: string, o: { space?: string; path: string }, userId: string): Promise<RunFile> {
  const r = getRun(app, runId);
  if (r.kind !== "code") throw new HttpError(400, "只有编码交办有文件");
  const { worktreesOf } = await import("./code.ts");
  const root = (r.output as { continueFrom?: string }).continueFrom ?? (r.input as { continueFrom?: string }).continueFrom ?? r.id;
  const worktrees = worktreesOf(app, root);
  const input = getRun(app, root).input as { repos?: string[]; readSpaces?: string[]; itemId?: string };
  const repos = o.space ? [o.space] : [...new Set([...worktrees.map((w) => w.space), ...(input.repos ?? [])])];
  const allowed = accessibleSpaces(app, userId);
  for (const space of repos) {
    if (allowed && !allowed.includes(space)) continue;
    const path = o.path.startsWith(`${space}/`) && !o.space ? o.path.slice(space.length + 1) : o.path;
    const wt = worktrees.find((w) => w.space === space);
    const appliedTo = (r.output.appliedTo ?? getRun(app, root).output.appliedTo) as { space: string; path: string }[] | undefined;
    const base = wt && existsSync(wt.path) ? wt.path : appliedTo?.find(t => t.space === space)?.path ?? findSpace(app, space)?.rootPath;
    // A reviewed branch's tip, or a work branch between rounds (its workspace given back).
    const tip = wt?.tip ?? (wt?.commits ? `refs/heads/${wt.branch}` : undefined);
    if (wt && !existsSync(wt.path) && tip && base) {
      const shown = spawnSync("git", ["show", `${tip}:${path}`], { cwd: base, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
      if (shown.status === 0) return { from: "branch", space, path, bytes: () => shown.stdout, size: shown.stdout.length };
    }
    if (!base) continue;
    const full = resolvePath(base, path);
    if (!full.startsWith(resolvePath(base) + sep) || !existsSync(full) || statSync(full).isDirectory()) continue;
    return { from: wt && existsSync(wt.path) ? "worktree" : "repo", space, path, bytes: () => readFileSync(full), size: statSync(full).size };
  }
  const { materialSpaces } = await import("../items/materials.ts");
  const readable = [...(input.readSpaces ?? []), ...(input.itemId ? materialSpaces(app, input.itemId, userId) : [])].filter((s) => !allowed || allowed.includes(s));
  for (const space of readable) {
    const path = o.path.startsWith(`${space}/`) ? o.path.slice(space.length + 1) : o.path;
    const s = one<{ id: string }>(app.db, "select id from sources where space_id = ? and uri = ? and deleted_at is null", space, path);
    if (s) {
      const text = Buffer.from(readSource(app, s.id).text, "utf8");
      return { from: "source", space, path, bytes: () => text, size: text.length, sourceId: s.id };
    }
  }
  throw new HttpError(404, `找不到文件 ${o.path}`);
}
