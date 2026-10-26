import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { defaultBaseRef, fetchBranch, git, resolveRef } from "../core/git.ts";
import { findSpace, getSpace, listSpaces, type Space } from "../core/spaces.ts";
import { HttpError, now } from "../core/util.ts";
import { resolveCodeRefs } from "../sources/callgraph.ts";
import { purgeSource, upsertSource } from "../sources/store.ts";
import { ensureGrammars } from "../sources/treesitter.ts";

/**
 * The files a delegated coding run changed, searchable while its worktree exists; and the files
 * an existing branch changed, searchable until the index is removed.
 *
 * Each one gets a temporary space (kind `worktree`) over its repository holding only the added or
 * modified files, plus the list of deleted ones. Searching it together with the repository shows
 * the code as it is there: search.ts hides the repository's copies of the files it changed or
 * deleted, without copying the whole repository. Removing a delegation's worktree (apply,
 * discard, or deleting it by hand) drops its space; a branch index goes when it is removed or the
 * branch is gone.
 */

/** `ref` / `tip`: the existing branch a branch review checked out (detached; `branch` is then empty). */
export type WorktreeRef = { space: string; path: string; branch: string; base: string; ref?: string; tip?: string; baseRef?: string; targetBranch?: string | null };
/** A delegation's worktree (`runId`, `path`) or a branch index (`branch`, `commit`), both over repository `repo`. */
type WorktreeSettings = { runId?: string; repo: string; path?: string; base: string; branch?: string; baseRef?: string; commit?: string; deleted?: string[] };

const MAX_BYTES = 1_000_000;

export const worktreeSpaceId = (runId: string, repo: string) => `wt-${runId}-${repo}`;

/** The space row of an index over `repo`: created, or its name, description and settings refreshed. */
function saveIndexSpace(app: App, id: string, name: string, description: string, settings: WorktreeSettings) {
  const at = now();
  run(
    app.db,
    `insert into spaces(id,name,kind,description,root_path,settings,created_at,updated_at) values(?,?,'worktree',?,null,?,?,?)
     on conflict(id) do update set name = excluded.name, description = excluded.description, settings = excluded.settings, updated_at = excluded.updated_at`,
    id,
    name,
    description,
    JSON.stringify(settings),
    at,
    at,
  );
}

const docKind = (rel: string) => (/\.(md|markdown|mdx|txt|rst|adoc)$/i.test(rel) ? "doc" : "code");

/** Index `files` (path → reader returning the text, or null when too big or binary) into space `id`, dropping what is no longer there. */
async function indexFiles(app: App, id: string, files: [string, () => string | null][], meta: Record<string, unknown>) {
  const keep = new Set<string>();
  await ensureGrammars(files.map(([rel]) => rel));
  for (const [rel, read] of files) {
    try {
      const text = read();
      if (text === null) continue;
      upsertSource(app, { spaceId: id, kind: docKind(rel), uri: rel, title: rel, text, meta });
      keep.add(rel);
    } catch {
      // unreadable: leave it out
    }
  }
  for (const s of all<{ id: string; uri: string }>(app.db, "select id, uri from sources where space_id = ?", id)) if (!keep.has(s.uri)) purgeSource(app, s.id);
  resolveCodeRefs(app, id);
  app.emit({ type: "changed", entity: "space", id });
  return keep.size;
}

/** Index (or re-index) the files changed in one worktree since its base commit. */
export async function indexWorktree(app: App, runId: string, wt: WorktreeRef): Promise<{ space: string; files: number }> {
  const repo = getSpace(app, wt.space);
  const id = worktreeSpaceId(runId, repo.id);
  // Staged against the base: what the run added or changed, committed or not.
  git(wt.path, ["add", "-A"]);
  const names = (filter: string) => git(wt.path, ["diff", "--cached", "--name-only", "--no-renames", `--diff-filter=${filter}`, "-z", wt.base]).stdout.split("\0").filter(Boolean);
  saveIndexSpace(
    app,
    id,
    wt.ref ? `${repo.name} · 分支 ${wt.ref}` : `${repo.name} · 交办 ${runId.slice(-6)}`,
    wt.ref
      ? `分支评审 ${runId} 检出的 ${repo.id} 分支 ${wt.ref}（${(wt.tip ?? "").slice(0, 8)}）相对 ${wt.baseRef ?? wt.base.slice(0, 8)} 改过的文件；和 ${repo.id} 一起检索时以这里为准。评审工作区删除后这个空间连同索引一起删除。`
      : `交办运行 ${runId} 在 ${repo.id} 里改过的文件（只含新增和修改的文件，其余以 ${repo.id} 为准）。工作区删除后这个空间连同索引一起删除。`,
    { runId, repo: repo.id, path: wt.path, base: wt.base, deleted: names("D") },
  );
  const files = names("ACM").map((rel): [string, () => string | null] => [rel, () => {
    const full = join(wt.path, rel);
    if (statSync(full).size > MAX_BYTES) return null;
    const buf = readFileSync(full);
    return buf.subarray(0, 8000).includes(0) ? null : buf.toString("utf8");
  }]);
  return { space: id, files: await indexFiles(app, id, files, { worktree: runId, repo: repo.id }) };
}

export const branchSpaceId = (repo: string, branch: string) =>
  `br-${repo}-${branch.replace(/[^\w.-]+/g, "-").slice(0, 40)}-${createHash("sha1").update(branch).digest("hex").slice(0, 6)}`;

export type BranchIndex = { space: string; repo: string; branch: string; baseRef: string; base: string; commit: string; files: number; deleted: number; refreshed: boolean };

/**
 * Index an existing branch of a repository space: the files it added or changed since it left
 * `base` (default: origin's default branch), read from the commit (`git show`), no checkout. Only
 * re-reads when the branch or the base moved. `fetch` first updates both from origin.
 */
export async function indexBranch(app: App, repoId: string, branch: string, opts: { base?: string; fetch?: boolean } = {}): Promise<BranchIndex> {
  const repo = getSpace(app, repoId);
  const root = repo.rootPath;
  if (repo.kind === "worktree" || !root || !existsSync(root) || !git(root, ["rev-parse", "--git-dir"]).ok) throw new HttpError(400, `空间 ${repoId} 没有关联 Git 仓库`);
  const id = branchSpaceId(repo.id, branch);
  const before = findSpace(app, id)?.settings as WorktreeSettings | undefined;
  const baseRef = opts.base ?? before?.baseRef ?? defaultBaseRef(root);
  if (!baseRef) throw new HttpError(400, `${repoId} 找不到默认分支（main / master），请指定 base`);
  if (opts.fetch) {
    for (const name of new Set([branch, baseRef])) {
      const f = fetchBranch(root, name);
      if (!f.ok && !resolveRef(root, name)) throw new HttpError(400, `从 origin 拉取 ${name} 失败：${f.stderr.trim().slice(0, 300)}`);
    }
  }
  const tip = resolveRef(root, branch);
  if (!tip) throw new HttpError(404, `${repoId} 里没有分支 ${branch}${opts.fetch ? "" : "（远端新建的分支先拉取：fetch）"}`);
  const baseTip = resolveRef(root, baseRef);
  if (!baseTip) throw new HttpError(404, `${repoId} 里没有 ${baseRef}`);
  const mb = git(root, ["merge-base", baseTip.commit, tip.commit]);
  if (!mb.ok) throw new HttpError(400, `${branch} 和 ${baseRef} 没有共同的提交`);
  const base = mb.stdout.trim();
  if (before && before.commit === tip.commit && before.base === base && before.baseRef === baseRef) {
    const files = one<{ n: number }>(app.db, "select count(*) n from sources where space_id = ?", id)!.n;
    return { space: id, repo: repo.id, branch, baseRef, base, commit: tip.commit, files, deleted: before.deleted?.length ?? 0, refreshed: false };
  }
  const changes = git(root, ["diff", "--name-status", "--no-renames", "-z", base, tip.commit]).stdout.split("\0").filter(Boolean);
  const added: string[] = [];
  const deleted: string[] = [];
  for (let i = 0; i + 1 < changes.length; i += 2) (changes[i] === "D" ? deleted : added).push(changes[i + 1]);
  saveIndexSpace(app, id, `${repo.name} · 分支 ${branch}`,
    `${repo.id} 的分支 ${branch}（${tip.commit.slice(0, 8)}）相对 ${baseRef} 改过的文件；和 ${repo.id} 一起检索时以这里为准，其余文件以 ${repo.id} 为准。`,
    { repo: repo.id, branch, baseRef, base, commit: tip.commit, deleted });
  const files = added.map((rel): [string, () => string | null] => [rel, () => {
    const size = Number(git(root, ["cat-file", "-s", `${tip.commit}:${rel}`]).stdout.trim());
    if (!size || size > MAX_BYTES) return null;
    const r = git(root, ["show", `${tip.commit}:${rel}`]);
    return !r.ok || r.stdout.slice(0, 8000).includes("\0") ? null : r.stdout;
  }]);
  const n = await indexFiles(app, id, files, { branch, repo: repo.id, commit: tip.commit });
  return { space: id, repo: repo.id, branch, baseRef, base, commit: tip.commit, files: n, deleted: deleted.length, refreshed: true };
}

/** Branch indexes over a repository space (or all of them). */
export function branchIndexes(app: App, repoId?: string): (Space & { settings: WorktreeSettings })[] {
  return listSpaces(app, { worktrees: true }).filter((s): s is Space & { settings: WorktreeSettings } => {
    const st = s.settings as WorktreeSettings;
    return s.kind === "worktree" && !!st.branch && !st.runId && (!repoId || st.repo === repoId);
  });
}

/** The repository space a worktree or branch index is over (null for any other space). */
export function overlayRepo(app: App, id: string): string | null {
  const s = findSpace(app, id);
  return s?.kind === "worktree" ? ((s.settings as WorktreeSettings).repo ?? null) : null;
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

/** Worktree spaces whose worktree is gone (removed by hand, or the run was cleaned up); branch indexes whose repository or branch is gone. */
export function sweepWorktreeSpaces(app: App): number {
  let n = 0;
  for (const s of listSpaces(app, { worktrees: true })) {
    if (s.kind !== "worktree") continue;
    const st = s.settings as WorktreeSettings;
    if (st.branch && !st.runId) {
      const root = findSpace(app, st.repo)?.rootPath;
      if (root && existsSync(root) && resolveRef(root, st.branch)) continue;
    } else if (st.path && existsSync(st.path)) continue;
    dropWorktreeSpace(app, s.id);
    n++;
  }
  return n;
}

/** Re-read branch indexes whose branch moved (repository sync). */
export async function refreshBranchIndexes(app: App) {
  for (const s of branchIndexes(app)) {
    try {
      await indexBranch(app, s.settings.repo, s.settings.branch!, { base: s.settings.baseRef });
    } catch (e) {
      console.warn(`[omem] 更新分支索引 ${s.id} 失败：${(e as Error).message}`);
    }
  }
}
