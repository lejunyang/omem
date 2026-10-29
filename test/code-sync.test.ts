import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "../src/agents/jobs.ts";
import { answerAsk, listAsks } from "../src/agents/asks.ts";
import { applyCodeRun, worktreesOf } from "../src/agents/code.ts";
import { finishSync, moveToTarget, popWip, syncInProgress, syncWorktree, type Resolver } from "../src/agents/code-sync.ts";
import { __testHandlers, addRunEvent, createRun, getRun, listRuns, setRunOutput } from "../src/agents/runs.ts";
import type { WorktreeRef } from "../src/agents/worktree-index.ts";
import { git } from "../src/core/git.ts";
import { run as sql } from "../src/core/db.ts";
import { createSpace } from "../src/core/spaces.ts";
import { startServer } from "../src/server/http.ts";
import { testApp } from "./helpers.ts";

let app: ReturnType<typeof testApp>, root: string, remote: string, wtPath: string, wt: WorktreeRef;
function sh(cwd: string, ...args: string[]) {
  const r = git(cwd, args);
  if (!r.ok) throw new Error(r.stderr);
  return r.stdout.trim();
}
const commit = (cwd: string, file: string, text: string, msg: string) => {
  writeFileSync(join(cwd, file), text);
  sh(cwd, "add", file);
  sh(cwd, "commit", "-qm", msg);
  return sh(cwd, "rev-parse", "HEAD");
};
/** Stands in for the coding Agent: takes "ours" plus "theirs" in every conflicted file. */
const bothSides: Resolver = async (files) => {
  for (const f of files) {
    const text = readFileSync(join(wtPath, f), "utf8").replace(/^(<{7}|={7}|>{7}).*\n/gm, "");
    writeFileSync(join(wtPath, f), text);
    sh(wtPath, "add", f);
  }
};
const giveUp: Resolver = async () => {};
const noop = () => {};

beforeEach(() => {
  app = testApp();
  root = join(app.home, "repo");
  remote = join(app.home, "remote.git");
  mkdirSync(root);
  mkdirSync(remote);
  sh(remote, "init", "--bare", "-q");
  sh(root, "init", "-q", "-b", "main");
  sh(root, "config", "user.name", "Example");
  sh(root, "config", "user.email", "example@example.com");
  // Byte-exact files on Windows too (a global autocrlf would rewrite line ends on checkout).
  sh(root, "config", "core.autocrlf", "false");
  commit(root, "rules.txt", "refund: all lines\n", "initial");
  sh(root, "remote", "add", "origin", remote);
  sh(root, "push", "-q", "origin", "main");
  sh(root, "branch", "feature/refund");
  sh(root, "push", "-q", "origin", "feature/refund");
  wtPath = join(app.home, "work");
  const start = sh(root, "rev-parse", "feature/refund");
  sh(root, "worktree", "add", "-q", "-b", "omem/r1", wtPath, start);
  wt = { space: "shop", path: wtPath, branch: "omem/r1", base: start, start, targetBranch: "feature/refund" };
}, 60000);
// A reviewer's Agent process may still be exiting (Windows keeps its directory busy): leave the temp dir then.
afterEach(() => { app.db.close(); try { rmSync(app.home, { recursive: true, force: true }); } catch { /* still in use */ } });

describe("Git sync before coding", { timeout: 60000 }, () => {
  it("merges another branch, sends its conflicts to the resolver and finishes the merge", async () => {
    commit(root, "rules.txt", "refund: shipped lines\n", "main changes the rule");
    commit(wtPath, "rules.txt", "refund: unshipped lines\n", "feature changes the rule");
    const seen: string[][] = [];
    const r = await syncWorktree(root, wt, { onto: "main", fetch: false }, async (files, label) => { seen.push(files); await bothSides(files, label); }, noop);
    expect(r.stopped).toBeNull();
    expect(seen).toEqual([["rules.txt"]]);
    expect(r.steps[0]).toMatchObject({ label: "合并 main", conflicts: ["rules.txt"] });
    expect(syncInProgress(wtPath)).toBeNull();
    // A merge commit with both parents, and both sides kept.
    expect(sh(wtPath, "log", "-1", "--format=%P").split(" ")).toHaveLength(2);
    expect(readFileSync(join(wtPath, "rules.txt"), "utf8")).toBe("refund: unshipped lines\nrefund: shipped lines\n");
  });

  it("stops on conflicts the resolver leaves, and finishes once the owner resolved them", async () => {
    commit(root, "rules.txt", "refund: shipped lines\n", "main");
    commit(wtPath, "rules.txt", "refund: unshipped lines\n", "feature");
    const r = await syncWorktree(root, wt, { onto: "main", mode: "rebase", fetch: false }, giveUp, noop);
    expect(r.stopped).toMatchObject({ op: "rebase", conflicts: ["rules.txt"] });
    expect(syncInProgress(wtPath)).toBe("rebase");
    // The owner edits the file and stages it; continuing needs no resolver.
    writeFileSync(join(wtPath, "rules.txt"), "refund: shipped lines only\n");
    sh(wtPath, "add", "rules.txt");
    expect(await finishSync(wtPath, "继续", giveUp)).toBeNull();
    expect(syncInProgress(wtPath)).toBeNull();
    // Rebased: linear history on top of main.
    expect(sh(wtPath, "merge-base", "--is-ancestor", sh(root, "rev-parse", "main"), "HEAD")).toBe("");
    expect(sh(wtPath, "log", "-1", "--format=%P").split(" ")).toHaveLength(1);
  });

  it("pulls the target branch's remote commits by fast-forward, and keeps work already in the worktree", async () => {
    // Someone pushed to the target branch from elsewhere.
    const other = join(app.home, "other");
    sh(app.home, "clone", "-q", "-b", "feature/refund", remote, other);
    sh(other, "config", "core.autocrlf", "false"); sh(other, "config", "user.name", "Other"); sh(other, "config", "user.email", "other@example.com");
    const pushed = commit(other, "notes.txt", "from a colleague\n", "colleague");
    sh(other, "push", "-q", "origin", "feature/refund");
    // Uncommitted work of an earlier round.
    writeFileSync(join(wtPath, "draft.txt"), "work in progress\n");
    const r = await syncWorktree(root, wt, { pull: true }, giveUp, noop);
    expect(r.stopped).toBeNull();
    expect(r.steps[0].label).toMatch(/快进/);
    expect(sh(wtPath, "rev-parse", "HEAD")).toBe(pushed);
    expect(readFileSync(join(wtPath, "draft.txt"), "utf8")).toBe("work in progress\n");
    expect(sh(wtPath, "stash", "list")).toBe("");
  });

  it("moves unapplied work onto the target's newer commit and puts it back staged", async () => {
    writeFileSync(join(wtPath, "rules.txt"), "refund: unshipped lines\n");
    const newer = commit(root.replace(/repo$/, "repo"), "other.txt", "x\n", "target moves");
    // root is on main; move the target branch itself forward.
    sh(root, "branch", "-f", "feature/refund", newer);
    const m = await moveToTarget(root, wt, giveUp);
    expect(m).toMatchObject({ moved: true, stopped: null, start: newer, wip: true });
    expect(sh(wtPath, "rev-parse", "HEAD")).toBe(newer);
    expect(sh(wtPath, "diff", "--cached", "--name-only")).toBe("rules.txt");
  });

  it("an interrupted move finishes with the work back as staged changes", async () => {
    writeFileSync(join(wtPath, "rules.txt"), "refund: unshipped lines\n");
    sh(root, "checkout", "-q", "feature/refund");
    const newer = commit(root, "rules.txt", "refund: shipped lines\n", "target changes the rule too");
    sh(root, "checkout", "-q", "main");
    const m = await moveToTarget(root, wt, giveUp);
    expect(m.stopped?.conflicts).toEqual(["rules.txt"]);
    writeFileSync(join(wtPath, "rules.txt"), "refund: shipped and unshipped lines\n");
    sh(wtPath, "add", "rules.txt");
    expect(await finishSync(wtPath, "继续", giveUp)).toBeNull();
    popWip(wtPath);
    expect(sh(wtPath, "rev-parse", "HEAD")).toBe(newer);
    expect(sh(wtPath, "diff", "--cached")).toContain("+refund: shipped and unshipped lines");
  });
});

describe("applying synced work", { timeout: 60000 }, () => {
  it("fast-forwards the target branch to the sync commits, then applies the patch; refuses when the target moved", async () => {
    createSpace(app, { id: "shop", name: "项目 A", kind: "repo", rootPath: root });
    commit(root, "main.txt", "main\n", "main moves");
    const r1 = await syncWorktree(root, wt, { onto: "main", fetch: false }, giveUp, noop);
    expect(r1.stopped).toBeNull();
    const syncHead = sh(wtPath, "rev-parse", "HEAD");
    writeFileSync(join(wtPath, "rules.txt"), "refund: unshipped lines\n");
    sh(wtPath, "add", "-A");
    const patch = git(wtPath, ["diff", "--cached", "--no-color", "HEAD"]).stdout;
    const make = () => {
      const run = createRun(app, { kind: "code", spaceId: "shop", title: "合并 main 并改规则", input: { task: "x", repos: ["shop"], fromBranches: { shop: "feature/refund" } } });
      sql(app.db, "update runs set status='done' where id=?", run.id);
      mkdirSync(join(app.runsDir, run.id, "patches"), { recursive: true });
      writeFileSync(join(app.runsDir, run.id, "patches", "shop.patch"), patch);
      setRunOutput(app, run.id, { worktrees: [{ ...wt, syncHead }], repos: [{ space: "shop", diffStat: "", diffBytes: patch.length, check: null }] });
      return run.id;
    };
    const id = make();
    const res = applyCodeRun(app, id);
    const target = res.targets[0];
    expect(target.branch).toBe("feature/refund");
    expect(sh(target.path, "rev-parse", "HEAD")).toBe(syncHead);
    expect(readFileSync(join(target.path, "rules.txt"), "utf8")).toBe("refund: unshipped lines\n");
    expect(readFileSync(join(target.path, "main.txt"), "utf8")).toBe("main\n");

    // A second delegation whose target moved meanwhile: the sync commits cannot be fast-forwarded.
    sh(target.path, "checkout", "-q", "--", "rules.txt");
    commit(target.path, "late.txt", "late\n", "someone commits on the target");
    const wt2 = join(app.home, "work2");
    sh(root, "worktree", "add", "-q", "-b", "omem/r2", wt2, syncHead);
    wt = { ...wt, path: wt2, branch: "omem/r2", start: syncHead };
    commit(wt2, "x.txt", "x\n", "a sync commit");
    const head2 = sh(wt2, "rev-parse", "HEAD");
    const run2 = createRun(app, { kind: "code", spaceId: "shop", title: "第二次", input: { task: "x", repos: ["shop"], fromBranches: { shop: "feature/refund" } } });
    sql(app.db, "update runs set status='done' where id=?", run2.id);
    setRunOutput(app, run2.id, { worktrees: [{ ...wt, syncHead: head2 }], repos: [] });
    expect(() => applyCodeRun(app, run2.id)).toThrow(/新提交/);
  });
});

describe("a sync-only delegation, end to end", { timeout: 120000 }, () => {
  const exec = (id: string) => {
    sql(app.db, "update runs set status = 'running' where id = ?", id);
    return __testHandlers.get("code")!({
      app, run: getRun(app, id), signal: new AbortController().signal,
      event: (type, data) => addRunEvent(app, id, type, data),
      output: (data) => setRunOutput(app, id, data),
    }) as Promise<{ verdict: string }>;
  };
  const delegate = (conflict: "resolve" | "giveup") => {
    app.config.agents.profiles.push({ id: "fake", name: "fake", transport: "acp", command: process.execPath, args: [resolve("test/fake-acp-agent.ts")], env: { FAKE_MODE: "review", FAKE_CONFLICT: conflict }, idleTimeoutMs: 60000 });
    app.config.agents.default = "fake";
    createSpace(app, { id: "shop", name: "项目 A", kind: "repo", rootPath: root });
    commit(root, "rules.txt", "refund: shipped lines\n", "main changes the rule");
    sh(root, "checkout", "-q", "feature/refund");
    commit(root, "rules.txt", "refund: unshipped lines\n", "feature changes the rule");
    sh(root, "checkout", "-q", "main");
    return createRun(app, { kind: "code", spaceId: "shop", title: "把 main 合并到 feature/refund", input: { task: "合并 main，解决冲突", repos: ["shop"], fromBranches: { shop: "feature/refund" }, sync: { onto: "main", fetch: false }, syncOnly: true } });
  };

  it("every coding round first pulls what others pushed to the target branch", async () => {
    const server = await startServer(app, { port: 0, quiet: true });
    try {
      delegate("resolve");
      const other = join(app.home, "other");
      sh(app.home, "clone", "-q", "-b", "feature/refund", remote, other);
      sh(other, "config", "core.autocrlf", "false"); sh(other, "config", "user.name", "Other"); sh(other, "config", "user.email", "other@example.com");
      const pushed = commit(other, "notes.txt", "from a colleague\n", "colleague");
      sh(other, "push", "-q", "origin", "feature/refund");
      const r = createRun(app, { kind: "code", spaceId: "shop", title: "退款只按未发货行", input: { task: "退款只按未发货的行计算", repos: ["shop"], fromBranches: { shop: "feature/refund" }, reviewTier: "light" } });
      await exec(r.id);
      const [w] = worktreesOf(app, r.id);
      expect(sh(w.path, "merge-base", "--is-ancestor", pushed, "HEAD")).toBe("");
      expect(readFileSync(join(w.path, "notes.txt"), "utf8")).toBe("from a colleague\n");
      expect(String(getRun(app, r.id).output.coderSummary)).toMatch(/## Git 同步\n\n(拉取|合并) origin\/feature\/refund/);
    } finally {
      await server.close();
    }
  });

  it("commits each round on the work branch, and confirming pushes it", async () => {
    const server = await startServer(app, { port: 0, quiet: true });
    try {
      delegate("resolve");
      const before = sh(root, "rev-parse", "feature/refund");
      const r = createRun(app, { kind: "code", spaceId: "shop", title: "退款只按未发货行", input: { task: "退款只按未发货的行计算", repos: ["shop"], fromBranches: { shop: "feature/refund" }, reviewTier: "light" } });
      await exec(r.id);
      const [w] = worktreesOf(app, r.id);
      expect(w).toMatchObject({ commits: true, branch: "feature/refund" });
      // What the Agent left uncommitted is a commit on the branch; the workspace is clean and detached.
      expect(sh(root, "log", "-1", "--format=%s", "feature/refund")).toContain("第 1 轮没提交的改动");
      expect(sh(root, "show", "feature/refund:refund.ts")).toContain("round = 1");
      expect(sh(w.path, "status", "--porcelain")).toBe("");
      expect(git(w.path, ["symbolic-ref", "-q", "HEAD"]).ok).toBe(false);
      // The diff the reviewers saw is the branch since the work began.
      expect(readFileSync(join(app.runsDir, r.id, "patches", "shop.patch"), "utf8")).toContain("round = 1");
      expect(sh(root, "merge-base", "--is-ancestor", before, "feature/refund")).toBe("");
      sql(app.db, "update runs set status = 'done' where id = ?", r.id);
      const res = applyCodeRun(app, r.id) as ReturnType<typeof applyCodeRun> & { pushed: { branch: string }[] };
      expect(res.pushed.map((p) => p.branch)).toEqual(["feature/refund"]);
      expect(sh(remote, "rev-parse", "feature/refund")).toBe(sh(root, "rev-parse", "feature/refund"));
      expect(sh(root, "rev-parse", "--abbrev-ref", "feature/refund@{upstream}")).toBe("origin/feature/refund");
      expect(existsSync(w.path)).toBe(false);
      expect(getRun(app, r.id).output.appliedAt).toBeTruthy();
    } finally {
      await server.close();
    }
  });

  it("the coding Agent resolves the conflict; the merge is on the work branch", async () => {
    const server = await startServer(app, { port: 0, quiet: true });
    try {
      const r = delegate("resolve");
      expect((await exec(r.id)).verdict).toBe("synced");
      sql(app.db, "update runs set status = 'done' where id = ?", r.id);
      const out = getRun(app, r.id).output as { coderSummary: string };
      expect(out.coderSummary).toMatch(/合并 main，解决了 1 个冲突文件/);
      expect(out.coderSummary).toContain("rules.txt");
      expect(sh(root, "log", "-1", "--format=%P", "feature/refund").split(" ")).toHaveLength(2);
      expect(sh(root, "show", "feature/refund:rules.txt")).toBe("refund: unshipped lines\nrefund: shipped lines");
      applyCodeRun(app, r.id);
      expect(sh(remote, "rev-parse", "feature/refund")).toBe(sh(root, "rev-parse", "feature/refund"));
    } finally {
      await server.close();
    }
  });

  it("what the Agent leaves goes to the owner; their “continue” finishes it in a next round", async () => {
    const server = await startServer(app, { port: 0, quiet: true });
    try {
      const r = delegate("giveup");
      expect((await exec(r.id)).verdict).toBe("sync-conflict");
      sql(app.db, "update runs set status = 'done' where id = ?", r.id);
      const [ask] = listAsks(app, { runId: r.id, status: "pending" });
      expect(ask.options.map((o) => o.label)).toEqual(["已解决，继续", "放弃这次同步"]);
      const [w] = worktreesOf(app, r.id);
      expect(ask.question).toContain(w.path);
      expect(() => applyCodeRun(app, r.id)).toThrow(/冲突/);
      // The owner resolves it in the worktree.
      writeFileSync(join(w.path, "rules.txt"), "refund: shipped lines only\n");
      sh(w.path, "add", "rules.txt");
      await answerAsk(app, ask.id, { choice: 0, by: "owner" });
      const next = listRuns(app, { kind: "code" }).find((x) => (x.input as { continueFrom?: string }).continueFrom === r.id)!;
      expect(next.input).toMatchObject({ syncResume: true, syncOnly: true });
      expect((await exec(next.id)).verdict).toBe("synced");
      sql(app.db, "update runs set status = 'done' where id = ?", next.id);
      expect(sh(root, "show", "feature/refund:rules.txt")).toBe("refund: shipped lines only");
    } finally {
      await server.close();
    }
  });
});
