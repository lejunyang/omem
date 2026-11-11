import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { App } from "../core/app.ts";
import { all, run } from "../core/db.ts";
import { defaultBaseRef, git, resolveRef, submodules } from "../core/git.ts";
import { findSpace, getSpace, updateSpace, type Space } from "../core/spaces.ts";
import { HttpError, now } from "../core/util.ts";
import { resolveCodeRefs } from "./callgraph.ts";
import { deleteSource, upsertSource, type SourceKind } from "./store.ts";
import { ensureGrammars } from "./treesitter.ts";

/**
 * A repository space's code index read from one commit (docs/v2/code-index.md): the baseline, by
 * default origin's default branch, instead of whatever the directory has checked out. Files come
 * out of Git (`ls-tree`, `cat-file --batch`), never the working tree, so a feature branch or
 * uncommitted changes in the directory do not end up as "the repository's code". A file is read
 * again only when its blob changed (the blob id is kept on the source); unchanged files cost one
 * listing line. Sources keep their ids: they are keyed by space and path, the same as when the
 * directory was read, so `src:` citations survive the switch and every update.
 */

/** What the owner set on the space (settings.codeIndex). */
export type CodeIndexConfig = {
  /** baseline: read the commit of `ref`; directory: the working tree as it is (the old way). */
  mode?: "baseline" | "directory";
  /** A branch, tag or commit; empty = origin's default branch. */
  ref?: string;
  /** Work branches kept indexed as overlays next to the baseline (worktree-index.ts indexBranch). */
  branches?: string[];
};

/** What the last sync and fetch found (settings.codeIndexState); written by omem only. */
export type CodeIndexState = {
  mode: "baseline" | "directory";
  /** baseline: the ref as resolved (origin/main); directory: the branch checked out. */
  ref?: string | null;
  commit?: string | null;
  committedAt?: string | null;
  subject?: string | null;
  /** directory: the working tree had changes not committed when it was read. */
  dirty?: boolean;
  /** baseline: which submodules were checked out when it was read. */
  subKey?: string;
  /** directory: HEAD and `git status` at the last read, to tell whether anything changed since. */
  workKey?: string;
  /** When the index was last brought to `commit`. */
  indexedAt?: string;
  /** When the remote was last fetched, and what went wrong the last time something did. */
  fetchedAt?: string;
  error?: string | null;
  errorAt?: string | null;
  /** Followed branches that could not be indexed, by branch. */
  branchErrors?: Record<string, string>;
};

const MAX_BYTES = 1_000_000;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", "target", ".next", ".nuxt", ".venv", "venv", "__pycache__", ".idea", ".vscode", "coverage", ".cache", ".turbo", ".gradle", "vendor", ".omem"]);
const LOCKFILES = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock|go\.sum|composer\.lock|Gemfile\.lock|osdk\.lock)$/;
const BINARY = /\.(png|jpe?g|gif|webp|bmp|ico|svg|pdf|docx?|xlsx?|pptx?|zip|gz|tgz|7z|rar|jar|war|class|so|dll|dylib|exe|bin|wasm|woff2?|ttf|otf|eot|mp3|mp4|mov|avi|webm|wav|flac|db|sqlite|lock|onnx|safetensors|gguf|pt|npy|parquet)$/i;

/** The same files a directory sync takes (import.ts repoFiles), by path. */
export function indexable(rel: string) {
  const parts = rel.split("/");
  if (parts.some((p) => SKIP_DIRS.has(p) || (p.startsWith(".") && p !== ".github"))) return false;
  if (LOCKFILES.test(rel) || BINARY.test(rel)) return false;
  return !/\.min\.(js|css)$/.test(rel) && !/\.map$/.test(rel);
}

export const codeIndexConfig = (s: Pick<Space, "settings">): CodeIndexConfig => (s.settings.codeIndex as CodeIndexConfig | undefined) ?? {};
export const codeIndexState = (s: Pick<Space, "settings">): CodeIndexState | null => (s.settings.codeIndexState as CodeIndexState | undefined) ?? null;

export const hasOrigin = (root: string) => git(root, ["remote", "get-url", "origin"]).ok;

/**
 * Whether the space is indexed from its baseline. Spaces that never set it keep reading the
 * directory, except a repository space connected after this existed (never synced) that has an
 * origin: it starts on the baseline.
 */
export function usesBaseline(s: Space) {
  const c = codeIndexConfig(s);
  if (c.mode) return c.mode === "baseline";
  return s.kind === "repo" && !s.settings.lastSync && !!s.rootPath && existsSync(s.rootPath) && hasOrigin(s.rootPath);
}

/** The ref the baseline follows: the one set, else origin's default branch (main / master without origin). */
export function baselineRef(root: string, c: CodeIndexConfig) {
  return c.ref?.trim() || defaultBaseRef(root);
}

/** Commit date and subject. */
export function commitInfo(root: string, commit: string) {
  const r = git(root, ["show", "-s", "--format=%cI%x1f%s", commit]);
  const [at, subject] = r.stdout.trim().split("\x1f");
  return { committedAt: at || null, subject: subject ?? null };
}

/** Write part of the state on a fresh copy of the settings (a sync takes minutes; the owner may have saved meanwhile). */
export function patchState(app: App, spaceId: string, patch: Partial<CodeIndexState>, extra: Record<string, unknown> = {}) {
  const s = findSpace(app, spaceId);
  if (!s) return;
  const prev = codeIndexState(s) ?? { mode: usesBaseline(s) ? "baseline" : "directory" };
  updateSpace(app, spaceId, { settings: { ...s.settings, ...extra, codeIndexState: { ...prev, ...patch } } });
}

type Entry = { rel: string; blob: string; size: number; repo: string; object: string };

/** Files of `commit` under the directory `cwd` (paths relative to it), with checked-out submodules at the commit recorded for them. */
function listTree(cwd: string, commit: string, prefix = "", depth = 0): Entry[] {
  const r = spawnSync("git", ["ls-tree", "-r", "-l", "-z", commit], { cwd, encoding: "utf8", maxBuffer: 512 * 1024 * 1024, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  if (r.status !== 0) throw new HttpError(500, `读取 ${commit.slice(0, 8)} 的文件列表失败：${String(r.stderr).trim().slice(0, 300)}`);
  const out: Entry[] = [];
  for (const line of String(r.stdout).split("\0")) {
    const m = /^(\d+) (\w+) ([0-9a-f]+)\s+(-|\d+)\t(.+)$/s.exec(line);
    if (!m) continue;
    const [, , type, sha, size, path] = m;
    if (type === "blob") out.push({ rel: prefix + path, blob: sha, size: size === "-" ? 0 : Number(size), repo: cwd, object: sha });
    else if (type === "commit" && depth < 3) {
      // A submodule: its files at the commit the baseline records, when that checkout has it.
      const sub = join(cwd, path);
      if (existsSync(sub) && git(sub, ["cat-file", "-e", `${sha}^{commit}`]).ok) out.push(...listTree(sub, sha, `${prefix}${path}/`, depth + 1));
    }
  }
  return out;
}

/** Blob contents by object id, read in batches through one `cat-file --batch` per batch (one process per file was the slow part). */
function readBlobs(repo: string, objects: string[]): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  for (let i = 0; i < objects.length; i += 400) {
    const part = objects.slice(i, i + 400);
    const r = spawnSync("git", ["cat-file", "--batch"], { cwd: repo, input: part.join("\n") + "\n", maxBuffer: 1024 * 1024 * 1024, windowsHide: true });
    if (r.status !== 0) throw new HttpError(500, `读取文件内容失败：${String(r.stderr).trim().slice(0, 300)}`);
    const buf = r.stdout as Buffer;
    let at = 0;
    for (const id of part) {
      const nl = buf.indexOf(10, at);
      if (nl < 0) break;
      const head = buf.subarray(at, nl).toString("utf8").split(" ");
      at = nl + 1;
      if (head[1] === "missing" || head.length < 3) continue;
      const size = Number(head[2]);
      out.set(id, buf.subarray(at, at + size));
      at += size + 1;
    }
  }
  return out;
}

const docKind = (rel: string): SourceKind => (/\.(md|markdown|mdx|txt|rst|adoc)$/i.test(rel) ? "doc" : "code");

function globToRegex(pattern: string) {
  const p = pattern.replace(/^\.\//, "").replace(/\/$/, "/**");
  const re = p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\u0000/g, ".*");
  return new RegExp(`^${re}${p.includes("*") ? "" : "(/.*)?"}$`);
}

export type BaselineReport = { created: number; updated: number; unchanged: number; removed: number; skipped: string[]; sourceIds: string[] };

/**
 * Bring the space's index to its baseline commit. Runs in the import process (import-worker.ts),
 * like the directory sync it stands in for.
 */
export async function syncBaselineLocally(app: App, spaceId: string, onProgress?: (done: number, total: number) => Promise<void>, opts: { force?: boolean } = {}): Promise<BaselineReport> {
  const space = getSpace(app, spaceId);
  const root = space.rootPath;
  if (!root || !existsSync(root) || !git(root, ["rev-parse", "--git-dir"]).ok) throw new HttpError(400, `空间 ${spaceId} 没有关联 Git 仓库`);
  const config = codeIndexConfig(space);
  const ref = baselineRef(root, config);
  const report: BaselineReport = { created: 0, updated: 0, unchanged: 0, removed: 0, skipped: [], sourceIds: [] };
  if (!ref) {
    patchState(app, spaceId, { mode: "baseline", error: "找不到基线分支（没有 origin 的默认分支，也没有 main / master）：在空间设置里填基线分支", errorAt: now() });
    throw new HttpError(400, `${spaceId} 找不到基线分支，请在空间设置里填一个`);
  }
  const tip = resolveRef(root, ref);
  if (!tip) {
    patchState(app, spaceId, { mode: "baseline", ref, error: `仓库里没有 ${ref}（还没拉取过，或名字写错了）`, errorAt: now() });
    throw new HttpError(404, `${spaceId} 里没有 ${ref}`);
  }
  const prev = codeIndexState(space);
  const info = commitInfo(root, tip.commit);
  // Which submodules are checked out: one checked out since is read even when the commit stayed.
  const subKey = existsSync(join(git(root, ["rev-parse", "--show-toplevel"]).stdout.trim() || root, ".gitmodules")) ? submodules(root).map((m) => `${m.path}:${m.state === "missing" ? 0 : 1}`).join(",") : "";
  // The same commit as last time: nothing to read.
  if (!opts.force && prev?.mode === "baseline" && prev.ref === ref && prev.commit === tip.commit && (prev.subKey ?? "") === subKey) {
    patchState(app, spaceId, { indexedAt: prev.indexedAt ?? now(), error: null, errorAt: null });
    return report;
  }
  const exclude = ((space.settings.exclude as string[] | undefined) ?? []).map(globToRegex);
  const entries = listTree(root, tip.commit).filter((e) => indexable(e.rel) && !exclude.some((re) => re.test(e.rel)));
  // What each managed source was read from last time (its blob): unchanged blobs are not read again.
  const known = new Map(all<{ id: string; uri: string; blob: string | null; deleted_at: string | null }>(app.db,
    "select id, uri, json_extract(meta, '$.blob') blob, deleted_at from sources where space_id = ? and kind in ('code','doc')", spaceId).map((r) => [r.uri, r]));
  const seen = new Set<string>();
  const toRead: Entry[] = [];
  for (const e of entries) {
    if (e.size > MAX_BYTES) { report.skipped.push(e.rel); continue; }
    seen.add(e.rel);
    const k = known.get(e.rel);
    if (k && k.blob === e.blob && !k.deleted_at) report.unchanged++;
    else toRead.push(e);
  }
  await ensureGrammars(toRead.map((e) => e.rel));
  const byRepo = new Map<string, Entry[]>();
  for (const e of toRead) byRepo.set(e.repo, [...(byRepo.get(e.repo) ?? []), e]);
  let done = 0;
  for (const [repo, list] of byRepo) {
    for (let i = 0; i < list.length; i += 400) {
      const part = list.slice(i, i + 400);
      const blobs = readBlobs(repo, part.map((e) => e.object));
      for (const e of part) {
        const buf = blobs.get(e.object);
        if (!buf || buf.subarray(0, 8000).includes(0)) { report.skipped.push(e.rel); seen.delete(e.rel); continue; }
        try {
          const r = upsertSource(app, { spaceId, kind: docKind(e.rel), uri: e.rel, title: e.rel, text: buf.toString("utf8"), meta: { directoryRoot: root, blob: e.blob } });
          // Same text under a new blob (line endings): remember the blob so it is not read again.
          if (r.status === "unchanged") run(app.db, "update sources set meta = json_set(json_set(meta, '$.blob', ?), '$.directoryRoot', ?) where id = ?", e.blob, root, r.id);
          report[r.status]++;
          if (r.status !== "unchanged") report.sourceIds.push(r.id);
        } catch {
          report.skipped.push(e.rel);
          seen.delete(e.rel);
        }
        if (onProgress && ++done % 50 === 0) await onProgress(done, toRead.length);
      }
    }
  }
  // Files no longer in the baseline become tombstones (only those that came from this directory, as a directory sync does).
  for (const row of all<{ id: string; uri: string; kind: string; meta: string }>(app.db, "select id, uri, kind, meta from sources where space_id = ? and deleted_at is null and kind in ('code','doc')", spaceId)) {
    const meta = JSON.parse(row.meta || "{}") as { directoryRoot?: string };
    const legacy = meta.directoryRoot === undefined && space.kind === "repo" && row.kind === "code" && !/^[a-z][a-z\d+.-]*:/i.test(row.uri) && !row.uri.startsWith("/");
    if ((meta.directoryRoot === root || legacy) && !seen.has(row.uri)) {
      deleteSource(app, row.id);
      report.removed++;
    }
  }
  if (report.created || report.updated || report.removed || prev?.mode !== "baseline") resolveCodeRefs(app, spaceId);
  const at = now();
  patchState(app, spaceId, { mode: "baseline", ref, commit: tip.commit, ...info, subKey, indexedAt: at, dirty: false, error: null, errorAt: null },{ lastSync: new Date().toISOString(), commit: tip.commit });
  return report;
}

/** HEAD and the working tree's status, to tell whether a directory-mode space needs reading again. */
export function workKey(root: string) {
  const head = git(root, ["rev-parse", "HEAD"]).stdout.trim();
  const status = git(root, ["status", "--porcelain", "-z", "--untracked-files=normal"]);
  return { head, dirty: !!status.stdout.trim(), key: workKeyOf(head, status.ok ? status.stdout : null) };
}

export const workKeyOf = (head: string, status: string | null) => `${head}:${status === null ? "?" : hashOf(status)}`;

function hashOf(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16);
}

/** After a directory sync: which branch and commit the working tree had, and whether it had uncommitted changes. */
export function recordDirectoryState(app: App, spaceId: string) {
  const s = findSpace(app, spaceId);
  if (!s?.rootPath || !existsSync(s.rootPath) || !git(s.rootPath, ["rev-parse", "--git-dir"]).ok) return;
  const w = workKey(s.rootPath);
  const branch = git(s.rootPath, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim();
  patchState(app, spaceId, { mode: "directory", ref: branch === "HEAD" ? null : branch, commit: w.head || null, ...(w.head ? commitInfo(s.rootPath, w.head) : {}), dirty: w.dirty, workKey: w.key, indexedAt: now(), error: null, errorAt: null });
}
