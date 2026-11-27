import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { branchWorktree, settleRound } from "../src/agents/code-branch.ts";
import { codeFolders, codeRunsAt, discardCodeRun, runCodeTask, worktreesOf } from "../src/agents/code.ts";
import { queueStandaloneFix } from "../src/agents/review-fix.ts";
import { ideUrl } from "../web/src/lib/ide.ts";
import { createRun, getRun, setRunOutput } from "../src/agents/runs.ts";
import { leaseWorkspace, listWorkspaces, managedSlot, MAX_POOL, releaseWorkspace, setupCommandFor, setupDone, setupKey, workDirOf } from "../src/agents/workspaces.ts";
import { run as sql } from "../src/core/db.ts";
import { createSpace, getSpace, updateSpace } from "../src/core/spaces.ts";
import { testApp } from "./helpers.ts";

const app = testApp();
afterAll(() => app.db.close());

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" } });

const root = mkdtempSync(join(tmpdir(), "omem-ws-"));
sh(root, "init", "-q", "-b", "main");
writeFileSync(join(root, ".gitignore"), "node_modules/\n");
writeFileSync(join(root, "app.ts"), "export const a = 1;\n");
writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
sh(root, "add", "-A");
sh(root, "commit", "-q", "-m", "init");
createSpace(app, { id: "shop-web", name: "商城前端", kind: "repo", rootPath: root });
const repo = () => getSpace(app, "shop-web");
const head = sh(root, "rev-parse", "HEAD").trim();
const noLog = () => {};
const codeRun = (input: Record<string, unknown> = {}) => createRun(app, { kind: "code", spaceId: repo().id, title: "改按钮", input: { task: "改按钮", ...input } });
const status = (id: string, state: "running" | "done") => sql(app.db, "update runs set status = ? where id = ?", state, id);
const linkFor = (id: string) => join(app.runsDir, id, "work", repo().id);
const borrowFor = (id: string) => {
  const branch = `omem/${id}`;
  sh(root, "branch", branch, head);
  return branchWorktree(app, repo(), id, linkFor(id), { branch, base: head, newBranch: true }, noLog).wt;
};
const fillOtherSlots = () => Array.from({ length: MAX_POOL - 1 }, () => {
  const { id } = codeRun();
  const path = linkFor(id);
  const slot = leaseWorkspace(app, repo(), id, path, noLog)!.path;
  return () => releaseWorkspace(id, { path, slot });
});

describe("reusable workspaces", () => {
  it("makes omem's own slots as needed, keeps ignored files and drops the run's changes when given back", () => {
    const link = join(app.runsDir, "r1", "work", "shop-web");
    const slot = leaseWorkspace(app, repo(), "r1", link, noLog)!.path;
    expect(slot).toBe(managedSlot(app, "shop-web", 1));
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(workDirOf({ path: link })).toBe(slot);
    // The first is taken: the next run gets a second one.
    const link2 = join(app.runsDir, "r2", "work", "shop-web");
    expect(leaseWorkspace(app, repo(), "r2", link2, noLog)?.path).toBe(managedSlot(app, "shop-web", 2));
    releaseWorkspace("r2", { path: link2, slot: managedSlot(app, "shop-web", 2) });
    expect(listWorkspaces(app, repo())).toMatchObject([{ state: "leased", run: "r1" }, { state: "free" }]);

    sh(slot, "checkout", "-q", "-B", "omem/r1", head);
    mkdirSync(join(slot, "node_modules"), { recursive: true });
    writeFileSync(join(slot, "node_modules", "dep.js"), "installed");
    writeFileSync(join(slot, "app.ts"), "export const a = 2;\n");
    writeFileSync(join(slot, "new.ts"), "x");
    expect(releaseWorkspace("r1", { path: link, slot })).toBe(true);
    expect(existsSync(link)).toBe(false);
    expect(readFileSync(join(slot, "app.ts"), "utf8").trimEnd()).toBe("export const a = 1;");
    expect(existsSync(join(slot, "new.ts"))).toBe(false);
    expect(readFileSync(join(slot, "node_modules", "dep.js"), "utf8")).toBe("installed");
    expect(listWorkspaces(app, repo()).map((s) => s.state)).toEqual(["free", "free"]);
    // A lease whose run link is gone does not hold the slot.
    expect(leaseWorkspace(app, repo(), "r3", join(app.runsDir, "r3", "work", "shop-web"), noLog)?.path).toBe(slot);
    releaseWorkspace("r3", { path: join(app.runsDir, "r3", "work", "shop-web"), slot });
  });

  it("when all are taken, takes one back from an idle run whose work is on a branch, never from a busy one", () => {
    const links = [1, 2, 3, 4].map((n) => join(app.runsDir, `h${n}`, "work", "shop-web"));
    const held = links.map((l, i) => leaseWorkspace(app, repo(), `h${i + 1}`, l, noLog)!.path);
    expect(held).toEqual([1, 2, 3, 4].map((n) => managedSlot(app, "shop-web", n)));
    const link = join(app.runsDir, "h5", "work", "shop-web");
    expect(leaseWorkspace(app, repo(), "h5", link, noLog)).toBeNull();
    // h1 is busy, h2's slot holds commits on no branch, h3 is idle with its HEAD on a branch.
    sh(held[1], "checkout", "-q", "--detach", head);
    writeFileSync(join(held[1], "app.ts"), "export const a = 9;\n");
    sh(held[1], "commit", "-qam", "not on a branch");
    sh(held[2], "checkout", "-q", "--detach", head);
    const logs: string[] = [];
    const got = leaseWorkspace(app, repo(), "h5", link, (t) => logs.push(t), { idle: (run) => run !== "h1" });
    expect(got?.path).toBe(held[2]);
    expect(logs.join("\n")).toContain("收回交办 h3");
    expect(existsSync(links[2])).toBe(false);
    for (const [i, l] of [...links, link].entries()) releaseWorkspace(i < 4 ? `h${i + 1}` : "h5", { path: l, slot: i < 4 ? held[i] : held[2] });
  });

  it.each([
    { active: "queued coding round", running: false, review: null, heldByRound: false },
    { active: "running coding round", running: true, review: null, heldByRound: false },
    { active: "queued review of the root", running: false, review: "root", heldByRound: false },
    { active: "running review of a later round", running: true, review: "round", heldByRound: true },
  ])("protects a finished delegation's slot during a $active", ({ running, review, heldByRound }) => {
    const first = codeRun();
    const round = codeRun({ continueFrom: first.id });
    const holder = heldByRound ? round.id : first.id;
    const held = borrowFor(holder);
    const free = fillOtherSlots();
    const borrowers = [codeRun(), codeRun()];
    try {
      expect(held.slot).toBeTruthy();
      status(first.id, "done");
      if (review) status(round.id, "done");
      const active = review
        ? createRun(app, { kind: "review", spaceId: repo().id, title: "评审", input: { codeRunId: review === "root" ? first.id : round.id } })
        : round;
      if (running) status(active.id, "running");

      const separate = borrowFor(borrowers[0].id);
      expect(separate.slot).toBeUndefined();
      expect(existsSync(held.path)).toBe(true);
      expect(sh(held.path, "branch", "--show-current").trim()).toBe(held.branch);

      status(active.id, "done");
      expect(borrowFor(borrowers[1].id).slot).toBe(held.slot);
      expect(existsSync(held.path)).toBe(false);
    } finally {
      for (const { id } of borrowers) {
        if (lstatSync(linkFor(id), { throwIfNoEntry: false })?.isSymbolicLink()) releaseWorkspace(id, { path: linkFor(id), slot: held.slot });
        else if (existsSync(linkFor(id))) sh(root, "worktree", "remove", "--force", linkFor(id));
      }
      releaseWorkspace(holder, held);
      for (const release of free) release();
    }
  });

  it.each([true, false])("can queue and start a reclaimed delegation again (free slot: %s)", async (freeSlot) => {
    const first = codeRun({ repos: [repo().id] });
    const held = borrowFor(first.id);
    const free = fillOtherSlots();
    const borrower = codeRun();
    try {
      expect(held.slot).toBeTruthy();
      writeFileSync(join(held.path, "app.ts"), "export const a = 2;\n");
      sh(held.path, "commit", "-qam", "第 1 轮");
      const saved = sh(held.path, "rev-parse", "HEAD").trim();
      sh(held.path, "checkout", "-q", "--detach");
      setRunOutput(app, first.id, { worktrees: [held] });
      status(first.id, "done");
      expect(borrowFor(borrower.id).slot).toBe(held.slot);
      expect(existsSync(held.path)).toBe(false);

      sh(root, "branch", "-D", held.branch);
      expect(() => queueStandaloneFix(app, first.id, first.id, "继续", "owner")).toThrow(/原工作区缺失/);
      sh(root, "branch", held.branch, saved);
      for (const state of ["appliedAt", "discardedAt"]) {
        setRunOutput(app, first.id, { [state]: new Date().toISOString() });
        expect(() => queueStandaloneFix(app, first.id, first.id, "继续", "owner")).toThrow(/已应用或丢弃/);
        setRunOutput(app, first.id, { [state]: null });
      }
      const next = queueStandaloneFix(app, first.id, first.id, "同步分支", "owner", { syncOnly: true });
      expect(next).toMatchObject({ status: "queued", input: { continueFrom: first.id } });
      expect(existsSync(held.path)).toBe(false);
      if (freeSlot) free[0]();
      const expectedSlot = freeSlot ? managedSlot(app, repo().id, 2) : undefined;
      status(next.id, "running");
      const out = await runCodeTask({
        app, run: getRun(app, next.id), signal: new AbortController().signal, event: noLog,
        output: (data) => {
          if ("worktrees" in data) expect(worktreesOf(app, first.id)[0].slot).toBe(expectedSlot);
          setRunOutput(app, next.id, data);
        },
      });
      expect(out).toMatchObject({ verdict: "synced" });
      const [resumed] = worktreesOf(app, first.id);
      expect(resumed).toMatchObject({ path: held.path, branch: held.branch });
      expect(resumed.slot).toBe(expectedSlot);
      expect(sh(resumed.path, "rev-parse", "HEAD").trim()).toBe(saved);
      expect(sh(linkFor(borrower.id), "branch", "--show-current").trim()).toBe(`omem/${borrower.id}`);
    } finally {
      const [ours] = worktreesOf(app, first.id);
      if (ours?.slot) releaseWorkspace(first.id, ours);
      else if (existsSync(held.path)) sh(root, "worktree", "remove", "--force", held.path);
      releaseWorkspace(borrower.id, { path: linkFor(borrower.id), slot: held.slot });
      for (const release of free) release();
    }
  });

  it("explains a missing leased workspace at the end of a round", () => {
    const first = codeRun();
    const held = borrowFor(first.id);
    releaseWorkspace(first.id, held);
    expect(() => settleRound(root, held, "第 1 轮")).toThrow(/工作区被收回/);
  });

  it("picks the setup command by the lockfile unless the space names one", () => {
    expect(setupCommandFor(repo(), root)).toBe("pnpm install --frozen-lockfile --prefer-offline");
    updateSpace(app, "shop-web", { settings: { setupCommand: "make deps" } });
    expect(setupCommandFor(repo(), root)).toBe("make deps");
    updateSpace(app, "shop-web", { settings: { setupCommand: "none" } });
    expect(setupCommandFor(repo(), root)).toBeNull();
    updateSpace(app, "shop-web", { settings: {} });
  });

  it("runs the setup command again only when a lockfile changed", () => {
    expect(setupKey(root, "pnpm install")).toBeTruthy();
    setupDone(root, setupKey(root, "pnpm install")!);
    expect(setupKey(root, "pnpm install")).toBeNull();
    expect(setupKey(root, "npm ci")).toBeTruthy();
    writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: 9\npackages: {}\n");
    sh(root, "add", "pnpm-lock.yaml");
    expect(setupKey(root, "pnpm install")).toBeTruthy();
    sh(root, "reset", "-q", "--hard");
  });

  it("discarding a run gives its slot back and deletes the run's branch", () => {
    const r = createRun(app, { kind: "code", spaceId: "shop-web", title: "改按钮", input: { task: "改按钮" } });
    const link = join(app.runsDir, r.id, "work", "shop-web");
    const slot = leaseWorkspace(app, repo(), r.id, link, noLog)!.path;
    sh(slot, "checkout", "-q", "-B", `omem/${r.id}`, head);
    writeFileSync(join(slot, "app.ts"), "export const a = 3;\n");
    setRunOutput(app, r.id, { worktrees: [{ space: "shop-web", path: link, branch: `omem/${r.id}`, base: head, slot }] });
    sql(app.db, "update runs set status = 'done' where id = ?", r.id);
    // An editor opens the slot itself, not the link to it.
    expect(codeFolders(app, r.id)).toEqual([{ space: "shop-web", path: slot, kind: "work", branch: `omem/${r.id}` }]);
    // The VS Code extension finds the run from the folder it opened, through the link or the slot.
    expect(codeRunsAt(app, slot, null)).toMatchObject([{ id: r.id, rounds: [r.id], folder: "work" }]);
    expect(codeRunsAt(app, slot, "someone-else")).toEqual([]);
    discardCodeRun(app, r.id);
    expect(codeFolders(app, r.id)).toEqual([]);
    expect(existsSync(link)).toBe(false);
    expect(existsSync(slot)).toBe(true);
    expect(sh(root, "branch", "--list", `omem/${r.id}`).trim()).toBe("");
    expect(listWorkspaces(app, repo()).every((s) => s.state === "free")).toBe(true);
  });

  it("links to a folder in the editor, locally or over Remote-SSH", () => {
    expect(ideUrl("vscode", "E:\\work\\shop web")).toBe("vscode://file/E:/work/shop%20web");
    expect(ideUrl("cursor", "/home/me/repo#1")).toBe("cursor://file/home/me/repo%231");
    expect(ideUrl("vscode", "/srv/omem/runs/r1/work/shop-web", "devbox")).toBe("vscode://vscode-remote/ssh-remote+devbox/srv/omem/runs/r1/work/shop-web");
  });
});
