import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../src/agents/jobs.ts";
import { codeChainFor, queueNextCodeRound } from "../src/agents/code-chain.ts";
import { activeBranchSync, openBranchSyncRound, roundSyncReport, runQueuedBranchSync } from "../src/agents/code-round-sync.ts";
import { hasSyncStash, syncInProgress } from "../src/agents/code-sync.ts";
import { worktreesOf } from "../src/agents/code.ts";
import { __testHandlers, addRunEvent, createRun, getRun, setRunOutput } from "../src/agents/runs.ts";
import { createThread } from "../src/agents/threads.ts";
import { callTool, type ToolContext } from "../src/agents/tools.ts";
import type { WorktreeRef } from "../src/agents/worktree-index.ts";
import { run as sql } from "../src/core/db.ts";
import { git } from "../src/core/git.ts";
import { createSpace } from "../src/core/spaces.ts";
import { startServer } from "../src/server/http.ts";
import { testApp } from "./helpers.ts";

describe("synchronizing a coding round in progress", { timeout: 60_000 }, () => {
  let app: ReturnType<typeof testApp>, repo: string, remote: string, tree: string, wt: WorktreeRef, base: string;
  const sh = (cwd: string, ...args: string[]) => {
    const result = git(cwd, args);
    if (!result.ok) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  const commit = (cwd: string, file: string, body: string) => {
    writeFileSync(join(cwd, file), body);
    sh(cwd, "add", "--", file);
    sh(cwd, "commit", "-qm", file);
    return sh(cwd, "rev-parse", "HEAD");
  };
  beforeEach(() => {
    app = testApp();
    repo = join(app.home, "repo"); remote = join(app.home, "origin.git"); tree = join(app.home, "tree");
    mkdirSync(repo); mkdirSync(remote);
    sh(repo, "init", "-qb", "main"); sh(remote, "init", "--bare", "-q");
    sh(repo, "config", "user.name", "Example"); sh(repo, "config", "user.email", "example@example.com");
    sh(repo, "config", "core.autocrlf", "false");
    base = commit(repo, "rules.txt", "original\n");
    sh(repo, "remote", "add", "origin", remote); sh(repo, "push", "-q", "origin", "main");
    sh(repo, "worktree", "add", "-qb", "work", tree);
    wt = { space: "shop", path: tree, branch: "work", targetBranch: "main", base, start: base, commits: true };
    createSpace(app, { id: "shop", name: "项目 A", kind: "repo", rootPath: repo });
  });
  afterEach(() => { app.db.close(); rmSync(app.home, { recursive: true, force: true }); });

  function setup(task = "编码期间同步") {
    const thread = createThread(app, { channel: "web", spaceId: "shop", userId: "owner" });
    const ask = createRun(app, { kind: "ask", spaceId: "shop", title: task, input: { conversationId: thread.id } });
    const round = createRun(app, { kind: "code", spaceId: "shop", title: task, input: { repos: ["shop"], task, design: "never", reviewTier: "test" }, parentId: ask.id });
    const chain = codeChainFor(app, round)!;
    const caller: ToolContext = { app, runId: ask.id, spaceId: "shop", spaces: null, tools: null, actor: "agent" };
    return { round, caller, chain };
  }

  function direct() {
    const { round, caller } = setup();
    sql(app.db, "update runs set status='running' where id=?", round.id);
    const close = openBranchSyncRound({ app, run: getRun(app, round.id), trees: [wt], roots: new Map([["shop", repo]]), event: () => {}, conflictText: (worktree, state) => `${worktree.space} ${state.label}: ${state.conflicts.join("、")}` });
    const coder = { ...caller, runId: round.id, role: "coder", tools: new Set(["sync_branch", "list_pages"]) };
    return { round, caller, coder, close, tool: (args: Record<string, unknown>) => callTool(coder, "sync_branch", args) };
  }

  it("reports a merge conflict, verifies marker removal, then also stops on a stash conflict", async () => {
    const theirs = commit(repo, "rules.txt", "theirs\n");
    sh(repo, "push", "-q", "origin", "main");
    const ours = commit(tree, "rules.txt", "ours\n");
    writeFileSync(join(tree, "rules.txt"), "unsaved\n");
    writeFileSync(join(tree, "notes.txt"), "not tracked\n");
    const { round, tool, close } = direct();
    try {
      const call = await tool({ pull: true });
      expect(call).toMatchObject({ isError: false, text: expect.stringContaining("rules.txt") });
      expect(syncInProgress(tree)).toBe("merge");
      expect(hasSyncStash(tree)).toBe(true);
      sh(tree, "add", "--", "rules.txt");
      expect((await tool({ continue: true })).text).toContain("rules.txt");
      rmSync(join(tree, "rules.txt"));
      expect((await tool({ continue: true })).text).toContain("rules.txt");
      expect(syncInProgress(tree)).toBe("merge");
      writeFileSync(join(tree, "rules.txt"), "ours and theirs\n");
      expect((await tool({ continue: true })).text).toContain("放回同步前的改动");
      expect(syncInProgress(tree)).toBeNull();
      expect(hasSyncStash(tree)).toBe(true);
      expect((await tool({ continue: true, resolved: ["notes.txt"] })).isError).toBe(true);
      writeFileSync(join(tree, "rules.txt"), "ours and theirs and unsaved\n");
      const at = sh(tree, "rev-parse", "HEAD");
      expect(await tool({ continue: true })).toMatchObject({ isError: false, text: expect.stringContaining(at) });
      expect(sh(tree, "show", "-s", "--format=%P", at)).toBe(`${ours} ${theirs}`);
      expect(readFileSync(join(tree, "notes.txt"), "utf8")).toBe("not tracked\n");
      expect(readFileSync(join(tree, "rules.txt"), "utf8")).toContain("unsaved");
      expect(activeBranchSync(app, round.id)).toBeNull();
      expect(hasSyncStash(tree)).toBe(false);
      expect(sh(remote, "for-each-ref", "--format=%(refname)")).toBe("refs/heads/main");
    } finally { await close(); }
  });

  it.each(["merge", "stash"])("aborts a %s conflict to the exact starting HEAD, index and files", async kind => {
    commit(repo, "rules.txt", "theirs\n");
    if (kind === "merge") commit(tree, "rules.txt", "ours\n");
    writeFileSync(join(tree, "rules.txt"), "staged\n");
    sh(tree, "add", "--", "rules.txt");
    writeFileSync(join(tree, "rules.txt"), "unstaged\n");
    writeFileSync(join(tree, "notes.txt"), "untracked\n");
    const state = () => [sh(tree, "rev-parse", "HEAD"), sh(tree, "diff", "--cached"), sh(tree, "diff"), readFileSync(join(tree, "notes.txt"), "utf8")];
    const before = state();
    const { tool, close } = direct();
    try {
      expect((await tool({ onto: "main", fetch: false })).text).toContain("rules.txt");
      expect(await tool({ abort: true })).toMatchObject({ isError: false, text: expect.stringContaining("回到同步前") });
      expect(state()).toEqual(before);
      expect(hasSyncStash(tree)).toBe(false);
      expect(syncInProgress(tree)).toBeNull();
    } finally { await close(); }
  });

  it("delivers a running round's pending request once and consumes it through the coder tool", async () => {
    const tip = commit(repo, "integration.txt", "confirmed\n");
    const { round, caller, coder, close, tool } = direct();
    try {
      const sync = { onto: "main", fetch: false };
      expect((await callTool(caller, "continue_code_run", { run_id: round.id, sync })).text).toContain("下次调用 omem 工具时收到");
      expect((await callTool(caller, "continue_code_run", { run_id: round.id, sync: { ...sync, mode: "merge", pull: false } })).text).toContain("没有重复添加");
      const delivery = await callTool(coder, "list_pages", {});
      const id = /"request_id":"([^"]+)"/.exec(delivery.text)?.[1];
      expect(id).toBeDefined();
      expect((await callTool(coder, "list_pages", {})).text).not.toContain("本人要求先同步");
      const result = await tool({ request_id: id });
      expect(result).toMatchObject({ isError: false, text: expect.stringContaining(sh(tree, "rev-parse", "HEAD")) });
      expect(sh(tree, "rev-parse", "HEAD^2")).toBe(tip);
      expect(getRun(app, round.id).output.branchSyncRequests).toEqual([]);
    } finally { await close(); }
  });

  it("consumes a review-time request before the following round codes", async () => {
    const tip = commit(repo, "integration.txt", "confirmed\n");
    const { round, caller, chain } = setup();
    sql(app.db, "update runs set status='running' where id=?", round.id);
    setRunOutput(app, round.id, { coderSummary: "编码完成，开始评审" });
    expect(await callTool(caller, "continue_code_run", { run_id: round.id, sync: { onto: "main", fetch: false } }))
      .toMatchObject({ isError: false, text: expect.stringContaining("下一次开始编码前自动同步") });
    sql(app.db, "update runs set status='done' where id=?", round.id);
    const next = queueNextCodeRound(app, chain, "核对轮前同步", { manual: true })!.run;
    expect(await runQueuedBranchSync({ app, run: next, trees: [wt], roots: new Map([["shop", repo]]), event: () => {}, conflictText: () => "" }, () => async () => {
      throw new Error("不应有冲突");
    })).toBeNull();
    expect(sh(tree, "rev-parse", "HEAD^2")).toBe(tip);
    expect(roundSyncReport(app, next.id)[0].summary).toContain(sh(tree, "rev-parse", "HEAD"));
    expect(getRun(app, round.id).output.branchSyncRequests).toEqual([]);
  });

  it("continues a saved conflict and finishes the remaining sync steps in a later round", async () => {
    const theirs = commit(repo, "rules.txt", "theirs\n");
    sh(repo, "push", "-q", "origin", "main");
    sh(repo, "checkout", "-qb", "integration");
    const tip = commit(repo, "integration.txt", "confirmed\n");
    commit(tree, "rules.txt", "ours\n");
    writeFileSync(join(tree, "notes.txt"), "unsaved\n");
    const { round, close, tool } = direct();
    try {
      expect((await tool({ pull: true, onto: "integration", fetch: false })).text).toContain("rules.txt");
      expect(activeBranchSync(app, round.id)?.stopped?.conflicts).toEqual(["rules.txt"]);
    } finally { await close(); }
    sql(app.db, "update runs set status='done' where id=?", round.id);
    const next = queueNextCodeRound(app, codeChainFor(app, round)!, "继续同步", { manual: true, extraInput: { syncResume: true } })!.run;
    const status = await runQueuedBranchSync({ app, run: next, trees: [wt], roots: new Map([["shop", repo]]), event: () => {}, conflictText: () => "" }, () => async files => {
      expect(files).toEqual(["rules.txt"]);
      writeFileSync(join(tree, "rules.txt"), "resolved\n");
    });
    expect(status).toBeNull();
    expect(sh(tree, "rev-parse", "HEAD^1^2", "HEAD^2")).toBe(`${theirs}\n${tip}`);
    expect(readFileSync(join(tree, "notes.txt"), "utf8")).toBe("unsaved\n");
    expect(activeBranchSync(app, round.id)).toBeNull();
  });

  it("won't push, mutate another checked-out branch, or update a sibling ref during rebase", async () => {
    const target = commit(repo, "integration.txt", "integrated\n");
    const previous = commit(tree, "ours.txt", "our work\n");
    sh(tree, "branch", "sibling");
    sh(repo, "config", "rebase.updateRefs", "true");
    const { tool, close } = direct();
    try {
      expect((await tool({ onto: "main", push: true })).isError).toBe(true);
      expect((await tool({ onto: "main:refs/heads/sibling" })).isError).toBe(true);
      sh(tree, "checkout", "-q", "sibling");
      expect((await tool({ onto: "main", fetch: false })).text).toContain("不能切换到其他分支");
      sh(tree, "checkout", "-q", "work");
      expect((await tool({ onto: "main", mode: "rebase", fetch: false })).isError).toBe(false);
      expect(sh(repo, "rev-parse", "sibling")).toBe(previous);
      expect(sh(repo, "rev-parse", "main")).toBe(target);
      expect(sh(remote, "rev-parse", "refs/heads/main")).toBe(base);
      expect(sh(tree, "rev-parse", "HEAD^")).toBe(target);
    } finally { await close(); }
  });

  function backend() {
    const gate = join(app.home, "coder-gate");
    app.config.agents.profiles.push({ id: "fake", name: "fake", transport: "acp", command: process.execPath, args: [resolve("test/fake-acp-agent.ts")], env: { FAKE_MODE: "round-sync", FAKE_SYNC_GATE: gate }, idleTimeoutMs: 15_000 });
    app.config.agents.default = "fake";
    app.config.review.tiers = [{ id: "test", name: "验证", when: null, guide: "", checks: ["reviewer"], maxRounds: 1, lead: false, confirmPlan: true }];
    return gate;
  }

  const execute = (id: string) => {
    sql(app.db, "update runs set status='running' where id=?", id);
    return __testHandlers.get("code")!({ app, run: getRun(app, id), signal: new AbortController().signal, event: (type, data) => addRunEvent(app, id, type, data), output: data => setRunOutput(app, id, data) });
  };

  it("delivers a deduplicated request through MCP to the running coder", async () => {
    const gate = backend();
    sh(repo, "checkout", "-qb", "integration");
    commit(repo, "integration.txt", "confirmed\n");
    sh(repo, "checkout", "-q", "main");
    const { round, caller } = setup();
    const server = await startServer(app, { port: 0, quiet: true });
    const coding = execute(round.id);
    try {
      await vi.waitFor(() => expect(existsSync(gate + ".ready")).toBe(true), { timeout: 10_000 });
      expect((await callTool(caller, "continue_code_run", { run_id: round.id, sync: { onto: "integration", fetch: false } })).text).toContain("下次调用 omem 工具时收到");
      expect((await callTool(caller, "continue_code_run", { run_id: round.id, sync: { onto: "integration", mode: "merge", pull: false, fetch: false } })).text).toContain("没有重复添加");
      writeFileSync(gate, "go");
      await coding;
      const finished = getRun(app, round.id);
      expect(finished.output.branchSyncRequests).toEqual([]);
      expect(finished.output.coderSummary).toContain("Git 带进来的改动");
      expect(finished.output.coderSummary).toContain("合并 integration");
      expect(readFileSync(join(worktreesOf(app, round.id)[0].path, "integration.txt"), "utf8")).toBe("confirmed\n");
    } finally {
      writeFileSync(gate, "go");
      await coding.catch(() => {});
      await server.close();
    }
  });

  it("handles requests received in review before the next coder starts", async () => {
    backend();
    sh(repo, "checkout", "-qb", "integration");
    commit(repo, "integration.txt", "confirmed\n");
    sh(repo, "checkout", "-q", "main");
    const { round, caller, chain } = setup();
    sql(app.db, "update runs set status='running' where id=?", round.id);
    setRunOutput(app, round.id, { coderSummary: "编码完成，开始评审" });
    const queued = await callTool(caller, "continue_code_run", { run_id: round.id, sync: { onto: "integration", fetch: false } });
    expect(queued).toMatchObject({ isError: false, text: expect.stringContaining("下一次开始编码前自动同步") });
    sql(app.db, "update runs set status='done' where id=?", round.id);
    const next = queueNextCodeRound(app, chain, "核对轮前同步", { manual: true })!.run;
    const server = await startServer(app, { port: 0, quiet: true });
    try {
      await execute(next.id);
      expect(getRun(app, next.id).output.coderSummary).toContain("编码前已读取：confirmed");
      expect(getRun(app, round.id).output.branchSyncRequests).toEqual([]);
    } finally { await server.close(); }
  });
});
