import type { App } from "../core/app.ts";
import { withinTx } from "../core/db.ts";
import { git } from "../core/git.ts";
import { HttpError, newId } from "../core/util.ts";
import { projectMemberSync, receiveMemberGit } from "./member-git.ts";
import { addRunEvent, getRun, setRunOutput, type Run } from "./runs.ts";
import { conflictReport, dropSyncStash, finishSync, hasSyncStash, markedConflicts, pushSyncStash, rollbackSync, settleDiffBase, stageResolvedConflicts, syncInProgress, syncWorktree, unmerged, type Resolver, type SyncRequest, type SyncState, type SyncStep } from "./code-sync.ts";
import type { WorktreeRef } from "./worktree-index.ts";

export type BranchSync = SyncRequest & { space?: string };
type Request = { id: string; space: string; sync: SyncRequest };
type Active = {
  request: Request;
  from: string;
  branch: string;
  steps: SyncStep[];
  stopped?: SyncState;
  marked: string[];
  remaining?: SyncRequest;
  restoring?: boolean;
  restoreConflicts?: string[];
  diffBaseNext?: string;
};
type Summary = { summary: string; report: string; conflicts: number };
type Args = BranchSync & { request_id?: string; continue?: boolean; abort?: boolean; resolved?: string[] };

export const codeRoot = (run: Run) => String(run.input.continueFrom ?? run.id);
const requests = (app: App, root: string) => (getRun(app, root).output.branchSyncRequests ?? []) as Request[];
export const activeBranchSync = (app: App, root: string) => getRun(app, root).output.activeBranchSync as Active | null | undefined;
export const roundSyncReport = (app: App, runId: string) => (getRun(app, runId).output.roundBranchSync ?? []) as Summary[];

export function normalizeBranchSync(sync: SyncRequest) {
  return { pull: sync.pull ?? !sync.onto, ...(sync.onto ? { onto: sync.onto } : {}), mode: sync.mode ?? "merge", fetch: sync.fetch ?? true } satisfies SyncRequest;
}

export function checkSyncBranch(path: string, onto?: string) {
  if (!onto) return;
  const branch = onto.replace(/^(refs\/remotes\/origin\/|refs\/heads\/|origin\/)/, "");
  if (branch.startsWith("-") || !git(path, ["check-ref-format", `refs/heads/${branch}`]).ok)
    throw new HttpError(400, "onto 要写有效的分支名，不接受 Git 表达式或 refspec");
}

export function queueBranchSync(app: App, round: Run, spaces: string[], sync: SyncRequest) {
  const root = codeRoot(round);
  const request = normalizeBranchSync(sync);
  return withinTx(app.db, () => {
    const first = getRun(app, root);
    if (first.output.appliedAt || first.output.discardedAt || first.input.branches) throw new HttpError(409, "这次交办没有可同步的工作分支");
    const before = requests(app, root);
    const added = spaces.filter(space => !before.some(x => x.space === space && JSON.stringify(x.sync) === JSON.stringify(request)))
      .map(space => ({ id: newId("sync"), space, sync: request }));
    if (added.length) {
      setRunOutput(app, root, { branchSyncRequests: [...before, ...added] });
      addRunEvent(app, round.id, "status", { text: `已登记本人要求的 Git 同步：${added.map(r => `${r.space} ${JSON.stringify(r.sync)}`).join("；")}` });
    }
    return added.length;
  });
}

type Running = {
  app: App;
  run: Run;
  trees: WorktreeRef[];
  roots: Map<string, string>;
  event: (type: string, data: unknown) => void;
  conflictText: (wt: WorktreeRef, stopped: SyncState) => string;
  delivered: Set<string>;
  busy?: Promise<unknown>;
};
const running = new Map<string, Running>();

export function openBranchSyncRound(round: Omit<Running, "delivered">) {
  const live = { ...round, delivered: new Set<string>() };
  running.set(round.run.id, live);
  return async () => {
    running.delete(round.run.id);
    await (live as Running).busy?.catch(() => {});
  };
}

export function takeBranchSyncSteering(app: App, runId: string) {
  const live = running.get(runId);
  if (!live || live.app !== app) return "";
  const pending = requests(app, codeRoot(live.run)).filter(x => !live.delivered.has(x.id));
  for (const item of pending) live.delivered.add(item.id);
  return pending.length ? `## 本人要求先同步\n\n${pending.map(x => `- ${x.space}：${JSON.stringify(x.sync)} → 调用 sync_branch(${JSON.stringify({ request_id: x.id })})`).join("\n")}\n\n依赖同步结果的修改先不要做。` : "";
}

const head = (path: string) => git(path, ["rev-parse", "--verify", "HEAD"]).stdout.trim();
const branchAt = (path: string) => git(path, ["symbolic-ref", "-q", "HEAD"]).stdout.trim();

function assertTree(wt: WorktreeRef, active?: Active) {
  const branch = branchAt(wt.path);
  const expected = `refs/heads/${wt.branch}`;
  const tip = git(wt.path, ["rev-parse", "--verify", expected]).stdout.trim();
  if (!wt.commits || wt.inPlace || !tip || (branch && branch !== expected) || (active && active.branch !== expected)
    || (!branch && !active && !git(wt.path, ["merge-base", "--is-ancestor", tip, "HEAD"]).ok))
    throw new HttpError(409, "只能同步这次交办登记的工作分支，工作树不能切换到其他分支");
}

function consume(app: App, root: string, request: Request) {
  setRunOutput(app, root, { branchSyncRequests: requests(app, root).filter(x => x.id !== request.id) });
}

export function abortBranchSync(app: App, run: Run, wt: WorktreeRef) {
  const root = codeRoot(run);
  const active = activeBranchSync(app, root);
  if (!active || active.request.space !== wt.space) return false;
  assertTree(wt, active);
  rollbackSync(wt.path, active.from);
  setRunOutput(app, root, { activeBranchSync: null });
  consume(app, root, active.request);
  projectMemberSync(app, run.id, wt.space, wt.path, "abort");
  addRunEvent(app, run.id, "status", { text: `${wt.space} 已放弃同步，工作区恢复到 ${active.from}` });
  return true;
}

async function perform(round: Omit<Running, "delivered">, request: Request, resolved: string[] = []): Promise<{ head: string; summary?: Summary; stopped?: SyncState }> {
  const { app, run, trees } = round;
  const root = codeRoot(run);
  const wt = trees.find(tree => tree.space === request.space)!;
  const previous = activeBranchSync(app, root);
  assertTree(wt, previous ?? undefined);
  const status = (text: string) => round.event("status", { text: `${wt.space}：${text}` });
  const path = wt.path;
  if (!previous) {
    checkSyncBranch(round.roots.get(wt.space)!, request.sync.onto);
    if (syncInProgress(path) || hasSyncStash(path) || unmerged(path).length) throw new HttpError(409, "工作树里已有未完成的 Git 操作，不能开始另一次同步");
    await receiveMemberGit(app, run.id, wt.space, path, run.title, true);
    projectMemberSync(app, run.id, wt.space, path, "start");
    const dirty = git(path, ["status", "--porcelain"]);
    if (!dirty.ok) throw new HttpError(409, dirty.stderr);
    if (dirty.stdout.trim()) pushSyncStash(path);
  }
  const active: Active = previous ?? { request, from: head(path), branch: `refs/heads/${wt.branch}`, steps: [], marked: [] };
  const save = () => setRunOutput(app, root, { activeBranchSync: active });
  save();
  try {
    const old = active.stopped;
    const candidate = { ...wt, ...(active.diffBaseNext ? { diffBaseNext: active.diffBaseNext } : {}) };
    const pause: Resolver = async (files) => { active.marked = markedConflicts(path, files); };
    if (old) {
      if (resolved.some(file => !old.conflicts.includes(file))) throw new HttpError(400, "resolved 只能列出这一步的冲突文件");
      const left = stageResolvedConflicts(path, old.conflicts, active.marked, resolved);
      if (left.length) return { head: head(path), stopped: { ...old, conflicts: left } };
      if (!active.restoring) {
        const last = active.steps.at(-1);
        const later = await finishSync(path, old.label, pause, last?.conflicts);
        if (last) last.to = head(path);
        if (later) {
          active.stopped = later;
          save();
          projectMemberSync(app, run.id, wt.space, path, "conflict");
          return { head: head(path), stopped: later };
        }
      }
      delete active.stopped;
      save();
    }
    if (!active.restoring) {
      const result = await syncWorktree(round.roots.get(wt.space)!, candidate, old ? active.remaining ?? { fetch: false } : request.sync, pause, status, true);
      active.diffBaseNext = candidate.diffBaseNext;
      active.steps.push(...result.steps);
      if (result.stopped) {
        active.stopped = result.stopped;
        active.restoring = "restoring" in result && result.restoring;
        if (active.restoring) active.restoreConflicts = result.stopped.conflicts;
        active.remaining = "remaining" in result ? result.remaining : undefined;
        save();
        projectMemberSync(app, run.id, wt.space, path, "conflict");
        return { head: head(path), stopped: result.stopped };
      }
    }
    const at = head(path);
    assertTree(candidate, active);
    settleDiffBase(candidate);
    projectMemberSync(app, run.id, wt.space, path, "done");
    dropSyncStash(path);
    Object.assign(wt, candidate);
    delete wt.diffBaseNext;
    if (at !== active.from) wt.syncHead = at;
    setRunOutput(app, run.id, { worktrees: trees });
    if (root !== run.id) setRunOutput(app, root, { worktrees: trees });
    const steps = active.steps.map(step => `${step.label}（${step.from.slice(0, 8)} → ${step.to.slice(0, 8)}）`);
    const summary = {
      summary: `${wt.space}：${steps.join("；") || "没有需要带入的提交"}；HEAD ${at}`,
      report: [conflictReport(path, active.steps), active.restoreConflicts?.length ? `放回同步前的改动时解决了：${active.restoreConflicts.join("、")}` : ""].filter(Boolean).join("\n\n"),
      conflicts: active.steps.reduce((count, step) => count + step.conflicts.length, active.restoreConflicts?.length ?? 0),
    };
    const reports = roundSyncReport(app, run.id);
    setRunOutput(app, run.id, { roundBranchSync: [...reports, summary] });
    setRunOutput(app, root, { activeBranchSync: null });
    consume(app, root, request);
    status(summary.summary);
    return { head: at, summary };
  } catch (error) {
    if (!active.stopped) abortBranchSync(app, run, wt);
    throw error;
  }
}

export async function runQueuedBranchSync(round: Omit<Running, "delivered">, resolverFor: (wt: WorktreeRef) => Resolver) {
  const { app, run } = round;
  const root = codeRoot(run);
  const active = activeBranchSync(app, root);
  const pending = [...(active ? [active.request] : []), ...requests(app, root).filter(x => x.id !== active?.request.id)];
  for (const item of pending) {
    const wt = round.trees.find(tree => tree.space === item.space);
    if (!wt) continue;
    let result = await perform(round, item);
    for (let attempt = 0; result.stopped && attempt < 20; attempt++) {
      const { conflicts, label } = result.stopped;
      await resolverFor(wt)(conflicts, label);
      const next = await perform(round, item);
      if (next.stopped && next.head === result.head && next.stopped.label === label && JSON.stringify(next.stopped.conflicts) === JSON.stringify(conflicts)) return next.stopped;
      result = next;
    }
    if (result.stopped) return result.stopped;
  }
  return null;
}

export async function syncBranchTool(app: App, runId: string, args: Args, allow: (space: string) => void) {
  const live = running.get(runId);
  if (!live || live.app !== app || getRun(app, runId).status !== "running") throw new HttpError(403, "只允许这一轮正在编码的主编码 Agent 同步工作分支");
  if (live.busy) throw new HttpError(409, "已经有一个同步工具调用在进行，请等它返回");
  const root = codeRoot(live.run);
  const active = activeBranchSync(app, root);
  if ((args.continue || args.abort) && (!active || (args.space && args.space !== active.request.space))) throw new HttpError(409, "这个仓库没有待处理的同步");
  if (active && !args.continue && !args.abort) throw new HttpError(409, `${active.request.space} 还有没完成的同步，先调用 sync_branch(continue: true) 或 sync_branch(abort: true)`);
  const pending = args.request_id ? requests(app, root).find(x => x.id === args.request_id) : undefined;
  if (args.request_id && !pending) throw new HttpError(404, "没有这个待同步请求（可能已经处理）");
  if (pending && args.space && args.space !== pending.space) throw new HttpError(400, "space 与待同步请求的仓库不一致");
  const space = active?.request.space ?? pending?.space ?? args.space ?? (live.trees.length === 1 ? live.trees[0].space : undefined);
  const wt = live.trees.find(tree => tree.space === space);
  if (!wt) throw new HttpError(400, "space 要指定这次交办中的一个仓库");
  allow(wt.space);
  if (args.abort) {
    abortBranchSync(app, live.run, wt);
    return `${wt.space} 已放弃同步，工作区回到同步前；HEAD ${head(wt.path)}。`;
  }
  const item = active?.request ?? pending ?? { id: newId("sync"), space: wt.space, sync: normalizeBranchSync(args) };
  const operation = perform(live, item, args.resolved);
  live.busy = operation;
  try {
    const result = await operation;
    if (!result.stopped) return result.summary!.summary;
    return `${live.conflictText(wt, result.stopped)}\n\n解决后调用 sync_branch(continue: true)，不要提交。删文件、解决二进制冲突等需要宿主暂存时，把已解决的文件加进 resolved。实在解决不了用 sync_branch(abort: true) 恢复同步前，再如实报告卡点；先不要做依赖这次同步的修改。`;
  } finally {
    delete live.busy;
  }
}

export function abortBranchSyncForBlock(app: App, runId: string) {
  const live = running.get(runId);
  if (!live || live.app !== app) return;
  if (live.busy) throw new HttpError(409, "Git 同步调用还没返回，先等它结束");
  const active = activeBranchSync(app, codeRoot(live.run));
  const tree = live.trees.find(wt => wt.space === active?.request.space);
  if (tree) abortBranchSync(app, live.run, tree);
}

export function assertBranchSyncIdle(app: App, runId: string) {
  const live = running.get(runId);
  if (live?.app === app && (live.busy || activeBranchSync(app, codeRoot(live.run))))
    throw new HttpError(409, "先完成或放弃正在进行的 Git 同步，再继续这项操作");
}
