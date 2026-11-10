import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertOwnRange, changeBase, planBranch, withDiffBase } from "../src/agents/code-branch.ts";
import { finishSync, settleDiffBase, syncWorktree } from "../src/agents/code-sync.ts";
import { addTask, getTask, recordCheckpoint, scheduleWorkRevert, settleCodingRound, updateTask } from "../src/agents/code-tasks.ts";
import { createRun, setRunOutput } from "../src/agents/runs.ts";
import type { WorktreeRef } from "../src/agents/worktree-index.ts";
import { git } from "../src/core/git.ts";
import { createSpace, getSpace } from "../src/core/spaces.ts";
import { testApp } from "./helpers.ts";

/**
 * The comparison base of a delegation on a reused branch (code-branch.ts changeBase / diffBase):
 * where it starts, how a sync moves it, how older delegations are read, and the whole-range
 * operations it must not let take back commits that are not the delegation's.
 */
let app: ReturnType<typeof testApp>, root: string, remote: string, path: string;
const sh = (cwd: string, ...args: string[]) => {
  const r = git(cwd, args);
  if (!r.ok) throw new Error(r.stderr);
  return r.stdout.trim();
};
const commit = (cwd: string, file: string, text: string, msg: string) => {
  writeFileSync(join(cwd, file), text);
  sh(cwd, "add", file);
  sh(cwd, "commit", "-qm", msg);
  return sh(cwd, "rev-parse", "HEAD");
};
/** origin/release moves on by `n` commits the local release does not have. */
const advanceOrigin = (n: number, tag: string) => {
  const other = join(app.home, "other");
  sh(other, "pull", "-q", "--ff-only");
  for (let i = 0; i < n; i++) commit(other, `${tag}-${i}.txt`, `${tag}\n`, `${tag} ${i}`);
  sh(other, "push", "-q", "origin", "release");
  sh(root, "fetch", "-q", "origin");
  return sh(other, "rev-parse", "HEAD");
};
const noConflicts = async () => { throw new Error("unexpected conflict"); };

beforeEach(() => {
  app = testApp();
  root = join(app.home, "repo");
  remote = join(app.home, "remote.git");
  path = join(app.home, "work");
  mkdirSync(root);
  mkdirSync(remote);
  sh(remote, "init", "--bare", "-q");
  sh(root, "init", "-q", "-b", "main");
  for (const [k, v] of [["user.name", "Example"], ["user.email", "example@example.com"], ["core.autocrlf", "false"]]) sh(root, "config", k, v);
  commit(root, "app.ts", "export const a = 1;\n", "initial");
  sh(root, "remote", "add", "origin", remote);
  sh(root, "branch", "release");
  sh(root, "push", "-q", "origin", "main", "release");
  sh(app.home, "clone", "-q", "-b", "release", remote, join(app.home, "other"));
  for (const [k, v] of [["user.name", "Other"], ["user.email", "other@example.com"], ["core.autocrlf", "false"]]) sh(join(app.home, "other"), "config", k, v);
  createSpace(app, { id: "shop", name: "项目 A", kind: "repo", rootPath: root });
}, 60000);
// The Git calls are synchronous: give the worker's messages to Vitest a turn between tests.
afterEach(async () => {
  app.db.close();
  try { rmSync(app.home, { recursive: true, force: true }); } catch { /* still in use */ }
  await new Promise((r) => setImmediate(r));
});

/** A delegation on the existing release branch, worktree detached at the local branch's tip. */
async function delegate(): Promise<{ id: string; wt: WorktreeRef }> {
  const plan = await planBranch(getSpace(app, "shop"), "r1", { from: "release" });
  sh(root, "worktree", "add", "-q", "--detach", path, plan.base);
  const wt: WorktreeRef = { space: "shop", path, branch: plan.branch, base: plan.base, start: plan.base, targetBranch: plan.branch, commits: true, ...(plan.diffBase ? { diffBase: plan.diffBase } : {}) };
  const r = createRun(app, { kind: "code", spaceId: "shop", title: "示例改动", input: { task: "改", taskMode: true } });
  setRunOutput(app, r.id, { worktrees: [wt] });
  return { id: r.id, wt };
}

describe("the comparison base of a reused branch", { timeout: 60000 }, () => {
  it("starts where the branch meets a freshly fetched origin, and follows a pull that brings in only others' commits", async () => {
    const stale = sh(root, "rev-parse", "release");
    const ahead = advanceOrigin(4, "public");
    sh(root, "update-ref", "refs/remotes/origin/release", stale); // the planning machine has not fetched yet
    const { wt } = await delegate();
    expect(wt).toMatchObject({ start: stale, diffBase: stale });
    expect((await syncWorktree(root, wt, { pull: true }, noConflicts, () => {})).stopped).toBeNull();
    settleDiffBase(wt);
    expect(wt.diffBase).toBe(ahead);
    const mine = commit(path, "app.ts", "export const a = 2;\n", "mine");
    expect(changeBase(path, wt)).toBe(ahead);
    expect(sh(path, "diff", "--name-only", changeBase(path, wt), "HEAD")).toBe("app.ts");
    // An older endpoint (before a later sync) still compares from the origin commit it contained.
    const later = advanceOrigin(2, "later");
    expect((await syncWorktree(root, wt, { pull: true }, noConflicts, () => {})).stopped).toBeNull();
    settleDiffBase(wt);
    expect(wt.diffBase).toBe(later);
    expect(changeBase(path, wt, mine)).toBe(ahead);
  });

  it("keeps the base when origin already has the work (it was pushed)", async () => {
    const { wt } = await delegate();
    const mine = commit(path, "app.ts", "export const a = 2;\n", "mine");
    const base = wt.diffBase;
    sh(path, "push", "-q", "origin", `${mine}:refs/heads/release`);
    advanceOrigin(2, "after-push");
    expect((await syncWorktree(root, wt, { pull: true }, noConflicts, () => {})).stopped).toBeNull();
    settleDiffBase(wt);
    expect(wt.diffBase).toBe(base);
    expect(sh(path, "diff", "--name-only", changeBase(path, wt), "HEAD").split("\n")).toContain("app.ts");
  });

  it("moves the base only once a pull stopped on conflicts is finished", async () => {
    const { wt } = await delegate();
    commit(path, "app.ts", "export const a = 2;\n", "mine");
    const other = join(app.home, "other");
    commit(other, "app.ts", "export const a = 3;\n", "theirs");
    sh(other, "push", "-q", "origin", "release");
    const theirs = sh(other, "rev-parse", "HEAD");
    const r = await syncWorktree(root, wt, { pull: true }, async () => {}, () => {});
    expect(r.stopped).toBeTruthy();
    settleDiffBase(wt);
    expect(wt).toMatchObject({ diffBaseNext: theirs });
    expect(wt.diffBase).not.toBe(theirs);
    writeFileSync(join(path, "app.ts"), "export const a = 4;\n");
    sh(path, "add", "app.ts");
    expect(await finishSync(path, "继续", async () => {})).toBeNull();
    settleDiffBase(wt);
    expect(wt.diffBase).toBe(theirs);
    expect(wt.diffBaseNext).toBeUndefined();
  });
});

describe("whole-range operations take back only the delegation's commits", { timeout: 60000 }, () => {
  it("refuses when the range holds the owner's unpushed commits or commits already on origin", async () => {
    sh(root, "checkout", "-q", "release");
    commit(root, "owner.ts", "owner\n", "owner's unpushed commit on release");
    sh(root, "checkout", "-q", "main");
    const { wt } = await delegate();
    const mine = commit(path, "app.ts", "export const a = 2;\n", "mine");
    expect(() => assertOwnRange(path, wt, changeBase(path, wt), mine)).toThrow(/交办开始前/);
    expect(() => assertOwnRange(path, wt, wt.start!, mine)).not.toThrow();
    sh(path, "push", "-q", "origin", `${mine}:refs/heads/release`);
    sh(root, "fetch", "-q", "origin");
    expect(() => assertOwnRange(path, wt, wt.start!, mine)).toThrow(/origin\/release 上已有/);
  });

  it("refuses back-to-checkpoint-0 when the change since the base was pushed", async () => {
    const { id, wt } = await delegate();
    const mine = commit(path, "app.ts", "export const a = 2;\n", "mine");
    recordCheckpoint(app, id, [wt], id, [], "第 1 轮");
    expect(() => scheduleWorkRevert(app, id, [wt], { checkpoint: 0 }, "owner")).not.toThrow();
    sh(path, "push", "-q", "origin", `${mine}:refs/heads/release`);
    sh(root, "fetch", "-q", "origin");
    expect(() => scheduleWorkRevert(app, id, [wt], { checkpoint: 0 }, "owner")).toThrow(/按修改项回退/);
  });
});

describe("delegations from before the comparison base was recorded", { timeout: 60000 }, () => {
  /** An old first round: stale start, the sync fast-forwarded to origin, the only task given every commit since the start. */
  async function legacy() {
    const stale = sh(root, "rev-parse", "release");
    const ahead = advanceOrigin(3, "public");
    const { id, wt } = await delegate();
    delete wt.diffBase;
    sh(path, "merge", "-q", "--ff-only", ahead);
    const mine = commit(path, "app.ts", "export const a = 2;\n", "mine");
    sh(root, "update-ref", "refs/heads/release", mine);
    const t = addTask(app, id, { title: "改", kind: "build", state: "coding" }, "coder");
    updateTask(app, id, t.seq, { coderRun: id });
    setRunOutput(app, id, { worktrees: [{ ...wt, start: stale, base: stale }] });
    settleCodingRound(app, id, id, [{ ...wt, start: stale, base: stale }], 1);
    return { id, wt: { ...wt, start: stale, base: stale }, stale, ahead, mine, seq: t.seq };
  }

  it("reads the base where the branch meets origin and leaves pulled commits out of the task", async () => {
    const { id, wt, ahead, mine, seq } = await legacy();
    const read = withDiffBase(app, id, wt);
    expect(read.diffBase).toBe(ahead);
    expect(getTask(app, id, seq).commits.shop).toEqual([mine]);
  });

  it("keeps the old start when origin already has a coding round", async () => {
    const { id, wt, mine } = await legacy();
    sh(path, "push", "-q", "origin", `${mine}:refs/heads/release`);
    sh(root, "fetch", "-q", "origin");
    expect(withDiffBase(app, id, wt).diffBase).toBeUndefined();
  });

  it("a new first round gives its task only the commits after its sync", async () => {
    const ahead = advanceOrigin(2, "public");
    const { id, wt } = await delegate();
    sh(path, "merge", "-q", "--ff-only", ahead);
    wt.syncHead = ahead;
    const mine = commit(path, "app.ts", "export const a = 2;\n", "mine");
    const t = addTask(app, id, { title: "改", kind: "build", state: "coding" }, "coder");
    updateTask(app, id, t.seq, { coderRun: id });
    settleCodingRound(app, id, id, [wt], 1);
    const row = app.db.prepare("select commits from code_tasks where work_id = ?").get(id) as { commits: string };
    expect(JSON.parse(row.commits).shop).toEqual([mine]);
  });
});
