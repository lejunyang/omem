import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";
import type { App } from "../core/app.ts";
import { all, run } from "../core/db.ts";
import { gitAsync, resolveRef } from "../core/git.ts";
import { managedCheckout } from "../core/repositories.ts";
import { getSpace, type Space } from "../core/spaces.ts";
import { json, now } from "../core/util.ts";
import { baselineRef, codeIndexConfig } from "../sources/code-baseline.ts";
import { getRun } from "../agents/runs.ts";
import { worktreesOf } from "../agents/code.ts";
import { codeWork } from "../agents/code-works.ts";
import type { WorktreeRef } from "../agents/worktree-index.ts";
import { leaseWorkspaceAsync, releaseWorkspaceAsync, workDirOf, MAX_POOL, managedSlot } from "../agents/workspaces.ts";
import type { Direction } from "./store.ts";
import { studyScope } from "./scope.ts";

async function checked(dir: string, args: string[]) {
  const r = await gitAsync(dir, args, { timeoutMs: 30_000 });
  if (!r.ok) throw new Error(`Git ${args[0]}：${r.stderr.trim().slice(0, 500)}`);
  return r.stdout.trim();
}

export async function currentStudyCommit(app: App, repo: Space) {
  const root = repo.rootPath;
  if (!root) return null;
  const managed = managedCheckout(app, root);
  if (managed) {
    const config = codeIndexConfig(repo);
    const ref = baselineRef(root, config);
    const tip = ref ? resolveRef(root, ref) : null;
    // Without an explicit ref, baselineRef can return a local main or master when origin is unavailable.
    if (tip && (config.ref?.trim() || tip.ref.startsWith("refs/remotes/origin/"))) {
      return { commit: tip.commit, usedHeadFallback: false };
    }
  }
  const head = await gitAsync(root, ["rev-parse", "HEAD"], { timeoutMs: 5000 });
  return head.ok ? { commit: head.stdout.trim(), usedHeadFallback: managed } : null;
}

export async function captureBaseline(app: App, item: string) {
  const baseline: Record<string, string> = {};
  const headFallbacks = new Map<string, string>();
  for (const repo of studyScope(app, item).repos) {
    // A missing checkout must block the trial, not the owner's direction selection.
    const current = await currentStudyCommit(app, getSpace(app, repo.id));
    if (!current) continue;
    baseline[repo.id] = current.commit;
    if (current.usedHeadFallback) headFallbacks.set(repo.id, repo.name);
  }
  return { baseline, headFallbacks };
}
/** Never reset or clean a code work's checkout during verification. */
export async function fixWorkspace(app: App, item: string, work: string) {
  const w = codeWork(app, work);
  if (!w || w.item?.id !== item) throw new Error("交办不属于这个研究");
  const refs = [...w.roundList].reverse().flatMap((r) => worktreesOf(app, r.id));
  const selected = studyScope(app, item).repos.map((repo) => {
    const wt = refs.find((r) => r.space === repo.id);
    if (!wt || !existsSync(workDirOf(wt))) throw new Error(`${repo.name} 的交办工作区不可用`);
    return wt;
  });
  if (!selected.length) throw new Error("研究没有登记仓库");
  const commits: Record<string, string> = {};
  for (const wt of selected) commits[wt.space] = await checked(workDirOf(wt), ["rev-parse", "HEAD"]);
  return { cwd: workDirOf(selected[0]), commits, note: `## 交办工作区\n${selected.map((w) => `${w.space}：${workDirOf(w)}（${commits[w.space]}）`).join("\n")}` };
}
function saveRefs(app: App, owner: string, refs: WorktreeRef[]) {
  const r = getRun(app, owner);
  run(app.db, "update runs set output=? where id=?", JSON.stringify({ ...r.output, worktrees: refs }), owner);
}
function owned(app: App, owner: string, wt: WorktreeRef) {
  const expected = resolve(app.runsDir, owner, "work", wt.space);
  const runRel = relative(resolve(app.runsDir), expected);
  if (resolve(wt.path) !== expected || runRel.startsWith("..") || isAbsolute(runRel)) throw new Error("工作区路径不是宿主管理的运行目录");
  if (wt.slot) {
    if (!Array.from({ length: MAX_POOL }, (_, i) => resolve(managedSlot(app, wt.space, i + 1))).includes(resolve(wt.slot))) throw new Error("工作区槽位不属于宿主");
    // The data directory may itself sit under a linked path (/home -> /data/home): only the slot itself must not be a link.
    if (lstatSync(wt.slot, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error("工作区槽位不能指向其他目录");
    if (existsSync(wt.path) && existsSync(wt.slot) && realpathSync(wt.path) !== realpathSync(wt.slot)) throw new Error("工作区链接不匹配租用槽位");
  } else if (lstatSync(wt.path, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new Error("独立工作区不能是目录链接");
  }
}
/**
 * One repository at `base` in the host-managed workspace `owner` (a run) holds: a leased slot, or a
 * worktree of its own under the run's directory; reset and cleaned each time. Never the owner's checkout.
 */
export async function checkoutManaged(app: App, owner: string, repo: Space, base: string) {
  if (!repo.rootPath) throw new Error(`${repo.name} 没有仓库目录`);
  const refs = worktreesOf(app, owner);
  let wt = refs.find((w) => w.space === repo.id);
  if (!wt || !existsSync(wt.path)) {
    const path = join(app.runsDir, owner, "work", repo.id);
    const slot = await leaseWorkspaceAsync(app, repo, owner, path);
    if (!slot) {
      mkdirSync(join(app.runsDir, owner, "work"), { recursive: true });
      await checked(repo.rootPath, ["worktree", "add", "-q", "--detach", path, base]);
    }
    wt = { space: repo.id, path, branch: "", base, ...(slot ? { slot: slot.path } : {}) };
    const old = refs.findIndex((w) => w.space === repo.id);
    if (old >= 0) refs[old] = wt; else refs.push(wt);
    saveRefs(app, owner, refs);
  }
  owned(app, owner, wt);
  const path = workDirOf(wt);
  const top = await checked(path, ["rev-parse", "--show-toplevel"]);
  // Git reports the physical path; the data directory may sit under a linked one (e.g. /home on another disk).
  if (realpathSync(top) !== realpathSync(path)) throw new Error("工作区根目录不匹配");
  await checked(path, ["checkout", "-q", "--detach", "--force", base]);
  await checked(path, ["reset", "--hard", base]);
  await checked(path, ["clean", "-ffdqx"]);
  return { ...wt, base };
}
export async function prepareWorkspace(app: App, d: Direction, runId: string) {
  const repos = studyScope(app, d.item_id).repos, baseline = json<Record<string, string>>(d.baseline, {});
  if (!repos.length) return { cwd: undefined, commits: {}, note: "这个研究没有登记仓库" };
  if (!d.workspace_run_id) await cleanupStudyWorkspaces(app, d.item_id);
  const owner = d.workspace_run_id ?? runId;
  if (!d.workspace_run_id) run(app.db, "update study_directions set workspace_run_id=? where id=?", owner, d.id);
  const selected: WorktreeRef[] = [];
  for (const r of repos) {
    const repo = getSpace(app, r.id), base = baseline[r.id];
    if (!repo.rootPath || !base) throw new Error(`${r.name} 没有确认方向时的基线提交；请重新定方向`);
    selected.push(await checkoutManaged(app, owner, repo, base));
  }
  return { cwd: selected[0] ? workDirOf(selected[0]) : undefined, commits: Object.fromEntries(selected.map((w) => [w.space, w.base])),
    note: selected.length ? `## 研究工作区\n${selected.map((w) => `${w.space}：${workDirOf(w)}（${w.base}）`).join("\n")}` : "这个研究没有登记仓库" };
}
/** Give back what `owner` holds (checkoutManaged): leases returned, its own worktrees removed. What could not be is kept, and returned. */
export async function releaseManaged(app: App, owner: string) {
  const remaining: WorktreeRef[] = [];
  for (const wt of worktreesOf(app, owner)) {
    try {
      owned(app, owner, wt);
      if (!await releaseWorkspaceAsync(owner, wt) && existsSync(wt.path)) {
        const root = getSpace(app, wt.space).rootPath;
        if (!root) throw new Error("仓库目录不可用，保留工作区登记");
        await checked(root, ["worktree", "remove", "--force", wt.path]);
        await checked(root, ["worktree", "prune"]);
      }
    } catch (e) { remaining.push(wt); console.warn(`[omem] 研究工作区清理失败：${(e as Error).message}`); }
  }
  saveRefs(app, owner, remaining);
  return remaining;
}
export async function cleanupStudyWorkspaces(app: App, item: string, onlyDirection?: string) {
  const rows = all<Direction>(app.db, "select * from study_directions where item_id=? and workspace_run_id is not null", item);
  for (const d of rows.filter((d) => !onlyDirection || d.id === onlyDirection)) {
    if (!(await releaseManaged(app, d.workspace_run_id!)).length) run(app.db, "update study_directions set workspace_run_id=null where id=?", d.id);
  }
}
