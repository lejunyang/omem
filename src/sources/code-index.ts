import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { git, gitAsync, resolveRef } from "../core/git.ts";
import { remoteKey, remoteKeys } from "../core/repositories.ts";
import { findSpace, listSpaces, spaceFamily, type Space } from "../core/spaces.ts";
import { HttpError, now } from "../core/util.ts";
import { baselineRef, codeIndexConfig, codeIndexState, hasOrigin, patchState, usesBaseline, workKeyOf } from "./code-baseline.ts";

/**
 * Keeping repository spaces' code indexes current (docs/v2/code-index.md): fetch each repository
 * once (several spaces may be folders of one repository), sync a space only when its baseline moved
 * (or, for a space still read from its directory, when HEAD or the working tree changed), refresh
 * the work branches it follows, and let temporary overlays (branch and delegation indexes) expire.
 * Driven by the hourly `repo-sync` schedule, the change-notification endpoint and the owner's
 * “立即同步”.
 */

/** Unused branch indexes go after this many days: a commit-sha one (made to review one commit) sooner. */
export const OVERLAY_DAYS = { sha: 3, branch: 14, delegation: 14 };

type Repo = Space & { rootPath: string };

const isRepo = (s: Space): s is Repo => !!s.rootPath && s.kind !== "worktree" && existsSync(s.rootPath) && git(s.rootPath, ["rev-parse", "--git-dir"]).ok;

/** The repository a directory belongs to (its common git dir), so folders of one repository share a fetch. */
function repoKey(root: string) {
  const r = git(root, ["rev-parse", "--git-common-dir"]);
  return r.ok ? resolve(root, r.stdout.trim()) : resolve(root);
}

/** origin/x or x → the branch name on origin; null for a tag, a commit or a ref of another remote. */
function originBranch(root: string, ref: string) {
  const m = /^(?:refs\/remotes\/)?origin\/(.+)$/.exec(ref);
  if (m) return m[1];
  if (/^[0-9a-f]{7,40}$/.test(ref) || ref.startsWith("refs/tags/")) return null;
  return git(root, ["rev-parse", "--verify", "--quiet", `refs/tags/${ref}`]).ok ? null : ref.replace(/^refs\/heads\//, "");
}

/** Whether a sync of the space is queued or running already. */
const syncPending = (app: App, id: string) => !!one(app.db, "select 1 from runs where kind = 'sync' and space_id = ? and status in ('queued','running') limit 1", id);

/** `fetched`: the remote was asked (and fetched from when something moved); `fetches`: how many `git fetch` actually ran. */
export type RefreshReport = { spaces: { id: string; fetched?: boolean; synced: boolean; reason: string; error?: string }[]; fetches: number };

/**
 * Bring repository spaces up to date: fetch, then sync those whose index is behind. `force` syncs
 * even when nothing seems to have changed (the owner's “立即同步”). Returns what it did per space.
 */
export async function refreshRepoSpaces(app: App, opts: { spaces?: string[]; force?: boolean; branch?: string } = {}): Promise<RefreshReport> {
  const wanted = opts.spaces ? new Set(opts.spaces) : null;
  const repos = listSpaces(app).filter((s) => (!wanted || wanted.has(s.id)) && isRepo(s)) as Repo[];
  const groups = new Map<string, Repo[]>();
  for (const s of repos) groups.set(repoKey(s.rootPath), [...(groups.get(repoKey(s.rootPath)) ?? []), s]);
  const report: RefreshReport = { spaces: [], fetches: 0 };
  const { scheduleSpaceSync } = await import("../agents/jobs.ts");
  for (const group of groups.values()) {
    const root = group[0].rootPath;
    // One fetch per repository: every baseline and followed branch of its spaces, and the branch a notification named.
    let fetched: boolean | undefined;
    let fetchError: string | undefined;
    if (hasOrigin(root)) {
      const names = new Set<string>();
      for (const s of group) {
        const c = codeIndexConfig(s);
        if (usesBaseline(s)) {
          const b = originBranch(root, baselineRef(root, c) ?? "");
          if (b) names.add(b);
        }
        for (const b of c.branches ?? []) {
          const n = originBranch(root, b);
          if (n) names.add(n);
        }
      }
      if (opts.branch) {
        const n = originBranch(root, opts.branch);
        if (n && overlayFor(app, group.map((s) => s.id), opts.branch)) names.add(n);
      }
      if (names.size) {
        // Ask the remote where those branches are first: nothing moved means no fetch at all, and a
        // branch that exists only here (a followed local branch) does not fail the fetch of the others.
        const ls = await gitAsync(root, ["ls-remote", "--heads", "origin", ...names], { timeoutMs: 60_000 });
        const failed = (r: { stderr: string }) => `拉取失败：${r.stderr.trim().split("\n").slice(-2).join(" ").slice(0, 300)}`;
        if (!ls.ok) {
          fetched = false;
          fetchError = failed(ls);
        } else {
          const remote = new Map(ls.stdout.split("\n").map((l) => l.split("\t")).filter((p) => p.length === 2).map(([sha, ref]) => [ref.trim().replace(/^refs\/heads\//, ""), sha.trim()]));
          const behind = [...names].filter((n) => remote.has(n) && git(root, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${n}`]).stdout.trim() !== remote.get(n));
          fetched = true;
          if (behind.length) {
            const r = await gitAsync(root, ["fetch", "-q", "--no-tags", "origin", ...behind.map((n) => `+refs/heads/${n}:refs/remotes/origin/${n}`)], { timeoutMs: 120_000 });
            report.fetches++;
            fetched = r.ok;
            if (!r.ok) fetchError = failed(r);
          }
        }
      }
    }
    for (const s of group) {
      const at = now();
      if (fetched !== undefined) patchState(app, s.id, fetched ? { fetchedAt: at, error: null, errorAt: null } : { error: fetchError, errorAt: at });
      const need = await needsSync(s, opts.force);
      const pending = syncPending(app, s.id);
      if (need && !pending) scheduleSpaceSync(app, s.id);
      report.spaces.push({ id: s.id, fetched, synced: need && !pending, reason: pending ? "已有同步在排队" : need ? "索引落后" : "没有变化", ...(fetchError ? { error: fetchError } : {}) });
    }
    // Followed work branches: their overlays move with them.
    const { indexBranch } = await import("../agents/worktree-index.ts");
    for (const s of group) {
      const errors: Record<string, string> = {};
      const follow = new Set(codeIndexConfig(s).branches ?? []);
      if (opts.branch && overlayFor(app, [s.id], opts.branch)) follow.add(opts.branch);
      for (const b of follow) {
        try {
          await indexBranch(app, s.id, b, { touch: false });
        } catch (e) {
          errors[b] = (e as Error).message.slice(0, 300);
        }
      }
      if (follow.size || codeIndexState(s)?.branchErrors) patchState(app, s.id, { branchErrors: Object.keys(errors).length ? errors : undefined });
    }
  }
  return report;
}

/** An existing branch index of one of these spaces for `branch`. */
function overlayFor(app: App, spaces: string[], branch: string) {
  return all<{ id: string; settings: string }>(app.db, "select id, settings from spaces where kind = 'worktree'").some((r) => {
    const st = JSON.parse(r.settings || "{}") as { repo?: string; branch?: string; runId?: string };
    return !st.runId && st.branch === branch && spaces.includes(st.repo ?? "");
  });
}

/** Whether the space's index is behind: the baseline's commit moved, or (read from the directory) HEAD or the working tree changed. */
async function needsSync(s: Repo, force?: boolean) {
  if (force) return true;
  const st = codeIndexState(s);
  if (!s.settings.lastSync) return true;
  if (usesBaseline(s)) {
    const ref = baselineRef(s.rootPath, codeIndexConfig(s));
    if (!ref) return false;
    const tip = resolveRef(s.rootPath, ref);
    return !!tip && (st?.mode !== "baseline" || st.ref !== ref || st.commit !== tip.commit);
  }
  // `git status` can take a while on a large working tree: off the main thread.
  const head = (await gitAsync(s.rootPath, ["rev-parse", "HEAD"])).stdout.trim();
  const status = await gitAsync(s.rootPath, ["status", "--porcelain", "-z", "--untracked-files=normal"]);
  return st?.mode !== "directory" || st.workKey !== workKeyOf(head, status.ok ? status.stdout : null);
}

// ------------------------------------------------------------------ overlays

type OverlaySettings = { runId?: string; repo?: string; branch?: string; path?: string; usedAt?: string; commit?: string };

const days = (iso: string | null | undefined, at: number) => (iso ? (at - Date.parse(iso)) / 86400_000 : Infinity);

/**
 * Drop temporary indexes nobody needs any more:
 * - a delegation's or branch review's (wt-…) once it was applied, discarded or superseded, or when
 *   nothing happened on it for OVERLAY_DAYS.delegation days;
 * - a branch index (br-…) whose branch is not followed and that no search asked for lately
 *   (a commit sha after OVERLAY_DAYS.sha days, a branch after OVERLAY_DAYS.branch).
 */
export async function expireOverlays(app: App, at = Date.now()): Promise<{ dropped: string[] }> {
  const { dropWorktreeSpace, sweepWorktreeSpaces } = await import("../agents/worktree-index.ts");
  const dropped: string[] = [];
  const followed = new Map<string, Set<string>>();
  for (const s of listSpaces(app)) followed.set(s.id, new Set(codeIndexConfig(s).branches ?? []));
  for (const r of all<{ id: string; settings: string; updated_at: string }>(app.db, "select id, settings, updated_at from spaces where kind = 'worktree'")) {
    const st = JSON.parse(r.settings || "{}") as OverlaySettings;
    let drop = false;
    if (st.runId) drop = delegationOver(app, st.runId, at);
    else if (st.branch) {
      if (!followed.get(st.repo ?? "")?.has(st.branch)) {
        const idle = days(st.usedAt ?? r.updated_at, at);
        drop = /^[0-9a-f]{7,40}$/.test(st.branch) ? idle > OVERLAY_DAYS.sha : idle > OVERLAY_DAYS.branch;
      }
    }
    if (drop) {
      dropWorktreeSpace(app, r.id);
      dropped.push(r.id);
    }
  }
  // Worktrees removed by hand, branches that are gone (the old sweep).
  sweepWorktreeSpaces(app);
  return { dropped };
}

/** A delegation (or branch review) whose worktree index is no longer wanted. */
function delegationOver(app: App, runId: string, at: number) {
  const r = one<{ id: string; input: string }>(app.db, "select id, input from runs where id = ?", runId);
  if (!r) return true;
  const root = (JSON.parse(r.input || "{}") as { continueFrom?: string }).continueFrom ?? r.id;
  const first = one<{ output: string }>(app.db, "select output from runs where id = ?", root);
  if (!first) return true;
  const out = JSON.parse(first.output || "{}") as { appliedAt?: string; discardedAt?: string; supersededBy?: string };
  if (out.appliedAt || out.discardedAt || out.supersededBy) return true;
  const rounds = all<{ id: string; status: string; at: string }>(app.db,
    "select id, status, coalesce(finished_at, started_at, created_at) at from runs where id = ? or json_extract(input, '$.continueFrom') = ?", root, root);
  if (rounds.some((x) => x.status === "queued" || x.status === "running")) return false;
  const children = one<{ n: number }>(app.db, `select count(*) n from runs where status in ('queued','running') and parent_id in (${rounds.map(() => "?").join(",")})`, ...rounds.map((x) => x.id))!.n;
  if (children) return false;
  const last = rounds.reduce((t, x) => (x.at > t ? x.at : t), "");
  return days(last, at) > OVERLAY_DAYS.delegation;
}

/** The hourly `repo-sync`: fetch and sync what is behind, refresh followed branches, expire overlays. */
export async function repoSyncTick(app: App) {
  const r = await refreshRepoSpaces(app);
  const x = await expireOverlays(app);
  // Branch indexes asked for lately (not followed) follow their local ref too.
  await (await import("../agents/worktree-index.ts")).refreshBranchIndexes(app);
  if (x.dropped.length) console.log(`[omem] 清理了 ${x.dropped.length} 个过期的分支或交办索引`);
  return { ...r, dropped: x.dropped };
}

/**
 * Libraries that had `repo-sync` off since before it was cheap (it never ran): turn it on once.
 * One whose owner turned it off after it ran stays off.
 */
export function adoptRepoSyncDefault(app: App) {
  if (one(app.db, "select 1 from kv where key = 'repo_sync_default_on'")) return false;
  run(app.db, "insert into kv(key,value) values('repo_sync_default_on', ?)", now());
  return run(app.db, "update schedules set enabled = 1 where id = 'repo-sync' and enabled = 0 and last_run_at is null").changes > 0;
}

// ------------------------------------------------------------------ provenance

const short = (c?: string | null) => (c ? c.slice(0, 8) : "?");
/** A time in the owner's timezone (a commit's date carries its author's offset, omem's own times are UTC). */
const day = (app: App, iso?: string | null) => {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return "?";
  return d.toLocaleString("zh-CN", { hour12: false, timeZone: app.config.timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).replace(/\//g, "-");
};

/**
 * Where a space's code comes from, in one line for search results and read_source: the baseline
 * and its commit, a branch index, a delegation's worktree, or a directory as checked out. Null for
 * spaces that are not code.
 */
export function codeVersion(app: App, spaceId: string): string | null {
  const s = findSpace(app, spaceId);
  if (!s) return null;
  if (s.kind === "worktree") {
    const st = s.settings as OverlaySettings & { baseRef?: string; committedAt?: string };
    if (st.runId) return `交办 ${st.runId} 工作区里的改动（只含改过的文件，可能还没提交；其余文件按 ${st.repo}）`;
    return `分支 ${st.branch} 的提交 ${short(st.commit)}（${day(app, st.committedAt)}），相对 ${st.baseRef} 改过的文件；其余文件按 ${st.repo}`;
  }
  if (!s.rootPath) return null;
  const st = codeIndexState(s);
  if (!st) return s.settings.lastSync ? `按目录索引（同步于 ${day(app, String(s.settings.lastSync))}，当时检出的分支没有记录）` : null;
  if (st.mode === "baseline") return `基线 ${st.ref} 的提交 ${short(st.commit)}（提交于 ${day(app, st.committedAt)}，索引于 ${day(app, st.indexedAt)}）`;
  return `按目录索引：当时检出 ${st.ref ?? "（游离 HEAD）"} 的提交 ${short(st.commit)}（${day(app, st.committedAt)}）${st.dirty ? "，带未提交的改动" : ""}，同步于 ${day(app, st.indexedAt)}；不一定是主干上的代码`;
}

/** The provenance lines for the code spaces among `spaceIds` (search results), one per space. */
export function codeVersions(app: App, spaceIds: Iterable<string>) {
  const out: string[] = [];
  for (const id of new Set(spaceIds)) {
    const v = codeVersion(app, id);
    if (v) out.push(`- ${id}：${v}`);
  }
  return out;
}

// ------------------------------------------------------------------ change notifications

const HOOK_KEY = "code_hook_token";
const hash = (t: string) => createHash("sha256").update(t).digest("hex");

/** A new token for the change-notification endpoint (the old one stops working); shown once. */
export function createHookToken(app: App) {
  const token = "omh_" + randomBytes(24).toString("base64url");
  run(app.db, "insert into kv(key,value) values(?, ?) on conflict(key) do update set value = excluded.value", HOOK_KEY, JSON.stringify({ hash: hash(token), createdAt: now() }));
  return token;
}

export function hookTokenInfo(app: App) {
  const v = one<{ value: string }>(app.db, "select value from kv where key = ?", HOOK_KEY)?.value;
  if (!v) return null;
  const j = JSON.parse(v) as { hash: string; createdAt: string; usedAt?: string };
  return { createdAt: j.createdAt, usedAt: j.usedAt ?? null };
}

export function revokeHookToken(app: App) {
  run(app.db, "delete from kv where key = ?", HOOK_KEY);
}

export function checkHookToken(app: App, token: string) {
  if (!token.startsWith("omh_")) return false;
  const v = one<{ value: string }>(app.db, "select value from kv where key = ?", HOOK_KEY)?.value;
  if (!v) return false;
  const j = JSON.parse(v) as { hash: string; createdAt: string };
  const a = Buffer.from(hash(token));
  const b = Buffer.from(j.hash);
  if (a.length !== b.length || !a.equals(b)) return false;
  run(app.db, "update kv set value = ? where key = ?", JSON.stringify({ ...j, usedAt: now() }), HOOK_KEY);
  return true;
}

/**
 * The spaces a change notification is about: a space id (a business space stands for its
 * repositories), or a repository address matched against each repository space's remotes.
 */
export function spacesForNotice(app: App, input: { space?: string; repo?: string }): string[] {
  if (input.space) {
    if (!findSpace(app, input.space)) throw new HttpError(404, `没有空间 ${input.space}`);
    return spaceFamily(app, input.space).filter((id) => !!findSpace(app, id)?.rootPath);
  }
  if (!input.repo?.trim()) throw new HttpError(400, "给出 repo（仓库地址）或 space（空间 id）");
  const key = remoteKey(input.repo);
  return listSpaces(app).filter((s) => isRepo(s) && remoteKeys(s.rootPath!).has(key)).map((s) => s.id);
}

/** A push happened somewhere: fetch and refresh the matching spaces in the background. */
export function notifyCodeChange(app: App, input: { space?: string; repo?: string; branch?: string }) {
  const spaces = spacesForNotice(app, input);
  const branch = input.branch?.replace(/^refs\/heads\//, "");
  if (spaces.length)
    void refreshRepoSpaces(app, { spaces, branch }).catch((e) => console.warn(`[omem] 处理代码变更通知失败：${(e as Error).message}`));
  return { spaces, queued: spaces.length > 0 };
}

/** What the settings page shows for one repository space. */
export function codeIndexView(app: App, id: string) {
  const s = findSpace(app, id);
  if (!s) throw new HttpError(404, `没有空间 ${id}`);
  const root = s.rootPath && existsSync(s.rootPath) ? s.rootPath : null;
  const git_ = !!root && git(root, ["rev-parse", "--git-dir"]).ok;
  const config = codeIndexConfig(s);
  const overlays = all<{ id: string; settings: string }>(app.db, "select id, settings from spaces where kind = 'worktree'")
    .map((r) => ({ id: r.id, ...(JSON.parse(r.settings || "{}") as OverlaySettings & { baseRef?: string; committedAt?: string }) }))
    .filter((r) => r.repo === id && !r.runId);
  return {
    space: id,
    git: git_,
    origin: git_ ? hasOrigin(root!) : false,
    mode: git_ && usesBaseline(s) ? "baseline" : "directory",
    config,
    defaultRef: git_ ? baselineRef(root!, {}) : null,
    state: codeIndexState(s),
    lastSync: (s.settings.lastSync as string | undefined) ?? null,
    version: codeVersion(app, id),
    overlays: overlays.map((b) => ({ space: b.id, branch: b.branch, commit: b.commit ?? null, committedAt: b.committedAt ?? null, usedAt: b.usedAt ?? null, baseRef: b.baseRef ?? null, followed: (config.branches ?? []).includes(b.branch ?? "") })),
    syncing: syncPending(app, id),
  };
}
