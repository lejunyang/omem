import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { git } from "../core/git.ts";
import { getSpace, listSpaces, type Space } from "../core/spaces.ts";
import { now } from "../core/util.ts";
import { resolveCodeRefs } from "../sources/callgraph.ts";
import { purgeSource, upsertSource } from "../sources/store.ts";
import { ensureGrammars } from "../sources/treesitter.ts";

/**
 * The files a delegated coding run changed, searchable while its worktree exists.
 *
 * Each repository worktree gets a temporary space (kind `worktree`) holding only the added or
 * modified files, so a search there (or with `space: "*"`) finds the new code next to the
 * repository's own index without copying the whole repository. Removing the worktree (apply,
 * discard, or deleting it by hand) drops the space and everything indexed in it.
 */

export type WorktreeRef = { space: string; path: string; branch: string; base: string };
type WorktreeSettings = { runId: string; repo: string; path: string; base: string };

const MAX_BYTES = 1_000_000;

export const worktreeSpaceId = (runId: string, repo: string) => `wt-${runId}-${repo}`;

/** Index (or re-index) the files changed in one worktree since its base commit. */
export async function indexWorktree(app: App, runId: string, wt: WorktreeRef): Promise<{ space: string; files: number }> {
  const repo = getSpace(app, wt.space);
  const id = worktreeSpaceId(runId, repo.id);
  const settings: WorktreeSettings = { runId, repo: repo.id, path: wt.path, base: wt.base };
  const at = now();
  run(
    app.db,
    `insert into spaces(id,name,kind,description,root_path,settings,created_at,updated_at) values(?,?,'worktree',?,null,?,?,?)
     on conflict(id) do update set settings = excluded.settings, updated_at = excluded.updated_at`,
    id,
    `${repo.name} · 交办 ${runId.slice(-6)}`,
    `交办运行 ${runId} 在 ${repo.id} 里改过的文件（只含新增和修改的文件，其余以 ${repo.id} 为准）。工作区删除后这个空间连同索引一起删除。`,
    JSON.stringify(settings),
    at,
    at,
  );
  // Staged against the base: what the run added or changed, committed or not.
  git(wt.path, ["add", "-A"]);
  const changed = git(wt.path, ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z", wt.base]).stdout.split("\0").filter(Boolean);
  const keep = new Set<string>();
  await ensureGrammars(changed.map((rel) => join(wt.path, rel)));
  for (const rel of changed) {
    const full = join(wt.path, rel);
    try {
      if (statSync(full).size > MAX_BYTES) continue;
      const buf = readFileSync(full);
      if (buf.subarray(0, 8000).includes(0)) continue;
      const kind = /\.(md|markdown|mdx|txt|rst|adoc)$/i.test(rel) ? "doc" : "code";
      upsertSource(app, { spaceId: id, kind, uri: rel, title: rel, text: buf.toString("utf8"), meta: { worktree: runId, repo: repo.id } });
      keep.add(rel);
    } catch {
      // unreadable: leave it out
    }
  }
  for (const s of all<{ id: string; uri: string }>(app.db, "select id, uri from sources where space_id = ?", id)) if (!keep.has(s.uri)) purgeSource(app, s.id);
  resolveCodeRefs(app, id);
  app.emit({ type: "changed", entity: "space", id });
  return { space: id, files: keep.size };
}

/** Drop a worktree space and its index. */
export function dropWorktreeSpace(app: App, id: string) {
  const s = one<{ kind: string }>(app.db, "select kind from spaces where id = ?", id);
  if (!s || s.kind !== "worktree") return;
  for (const r of all<{ id: string }>(app.db, "select id from sources where space_id = ?", id)) purgeSource(app, r.id);
  run(app.db, "delete from space_members where space_id = ?", id);
  run(app.db, "delete from space_relations where space_a = ? or space_b = ?", id, id);
  run(app.db, "delete from spaces where id = ?", id);
  app.emit({ type: "changed", entity: "space", id });
}

export function worktreeSpacesOf(app: App, runId: string): Space[] {
  return listSpaces(app, { worktrees: true }).filter((s) => s.kind === "worktree" && (s.settings as WorktreeSettings).runId === runId);
}

/** Worktree spaces whose worktree is gone (removed by hand, or the run was cleaned up). */
export function sweepWorktreeSpaces(app: App): number {
  let n = 0;
  for (const s of listSpaces(app, { worktrees: true })) {
    if (s.kind !== "worktree") continue;
    const path = (s.settings as WorktreeSettings).path;
    if (path && existsSync(path)) continue;
    dropWorktreeSpace(app, s.id);
    n++;
  }
  return n;
}
