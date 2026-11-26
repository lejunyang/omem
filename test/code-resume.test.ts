import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import "../src/agents/jobs.ts";
import { __testHandlers, addRunEvent, createRun, getRun, ResumeRunAt, setRunOutput } from "../src/agents/runs.ts";
import { codeChainFor } from "../src/agents/code-chain.ts";
import { addTask, listCheckpoints, recordCheckpoint } from "../src/agents/code-tasks.ts";
import * as runner from "../src/agents/runner.ts";
import { createThread } from "../src/agents/threads.ts";
import { createSpace } from "../src/core/spaces.ts";
import { all, run } from "../src/core/db.ts";
import { startServer } from "../src/server/http.ts";
import { testApp } from "./helpers.ts";

describe("coding rounds and the agent session", () => {
  it.each([
    { scenario: "starts a fresh round after the previous one finished", resumed: false, branchMoved: false },
    { scenario: "re-enters the same interrupted coding round", resumed: true, branchMoved: false },
    { scenario: "re-enters with an additional branch commit", resumed: true, branchMoved: true },
  ])("attributes uncommitted edits when it $scenario", async ({ resumed, branchMoved }) => {
    const app = testApp();
    const paused = new ResumeRunAt(Date.now());
    const coder = vi.spyOn(runner, "runRole").mockRejectedValue(paused);
    try {
      const repo = mkdtempSync(join(tmpdir(), "omem-resume-edits-"));
      const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: repo, encoding: "utf8" });
      git("init", "-q", "-b", "main");
      writeFileSync(join(repo, "refund.ts"), "export const refund = 0;\n");
      git("add", "-A");
      git("commit", "-qm", "init");
      const base = git("rev-parse", "HEAD").trim();
      const path = join(app.home, "worktree");
      git("worktree", "add", "-qb", "work", path);
      const workGit = (...args: string[]) => git("-C", path, ...args);
      const worktrees = [{ space: "shop-api", path, branch: "work", base, start: base, commits: true }];
      createSpace(app, { id: "shop-api", name: "订单服务", kind: "repo", rootPath: repo });
      const first = createRun(app, { kind: "code", spaceId: "shop-api", title: "退款", input: { task: "退款", taskMode: true } });
      run(app.db, "update runs set status = 'done' where id = ?", first.id);
      setRunOutput(app, first.id, { worktrees });
      recordCheckpoint(app, first.id, worktrees, first.id, [], "第 1 轮");
      addTask(app, first.id, { title: "调整退款金额", kind: "build" }, "coder");
      const second = createRun(app, { kind: "code", spaceId: "shop-api", title: "退款", input: { task: "调整退款金额", continueFrom: first.id, round: 2 } });
      run(app.db, "update runs set status = 'running' where id = ?", second.id);
      const go = () => __testHandlers.get("code")!({ app, run: getRun(app, second.id), signal: new AbortController().signal, event: (type, data) => addRunEvent(app, second.id, type, data), output: (data) => setRunOutput(app, second.id, data) });
      const edit = "export const refund = 1;\n";
      if (resumed) {
        coder.mockImplementationOnce(async (_app, input) => {
          expect(input).toMatchObject({ role: "coder", runId: second.id, cwd: path });
          writeFileSync(join(path, "refund.ts"), edit);
          throw paused;
        });
        await expect(go()).rejects.toBe(paused);
      } else {
        writeFileSync(join(path, "refund.ts"), edit);
      }
      if (branchMoved) {
        writeFileSync(join(path, "note.md"), "分支上的补充说明\n");
        workGit("add", "note.md");
        workGit("commit", "-qm", "补充说明");
      }
      const before = workGit("rev-parse", "HEAD");
      await expect(go()).rejects.toBe(paused);
      expect(coder).toHaveBeenCalledTimes(resumed ? 2 : 1);
      const checkpoints = listCheckpoints(app, first.id);
      const commits = workGit("log", "--format=%B", `${base}..HEAD`);
      if (resumed) {
        expect(workGit("rev-parse", "HEAD")).toBe(before);
        expect(workGit("status", "--porcelain")).toBe(" M refund.ts\n");
        expect(commits).not.toContain("Omem-By: owner");
        expect(checkpoints.map(checkpoint => checkpoint.by)).toEqual(branchMoved ? [first.id, "branch"] : [first.id]);
      } else {
        expect(commits).toContain("Omem-By: owner");
        expect(workGit("status", "--porcelain")).toBe("");
        expect(checkpoints.map(checkpoint => checkpoint.by)).toEqual([first.id, "owner"]);
      }
      expect(readFileSync(join(path, "refund.ts"), "utf8")).toBe(edit);
    } finally {
      coder.mockRestore();
      app.db.close();
    }
  });

  it("starts a new session that reads the branch when the last one held too much context", async () => {
    const app = testApp();
    const log = join(app.home, "coder.jsonl");
    // Every turn reports 800 tokens of context; the limit is 500.
    app.config.agents.profiles.push({ id: "fake", name: "fake", transport: "acp", command: process.execPath, args: [resolve("test/fake-acp-agent.ts")], env: { FAKE_MODE: "review", FAKE_USAGE: "800", FAKE_CODER_LOG: log }, idleTimeoutMs: 60000 });
    app.config.agents.default = "fake";
    app.config.sessions.codeResumeMaxTokens = 500;
    const dir = mkdtempSync(join(tmpdir(), "omem-resume-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" } });
    git("init", "-q");
    writeFileSync(join(dir, "refund.ts"), "export const refund = 0;\n");
    git("add", "-A");
    git("commit", "-q", "-m", "init");
    createSpace(app, { id: "shop-api", name: "订单服务", kind: "repo", rootPath: dir });
    // Only the business check, which always asks for a change: round 1 queues round 2.
    app.config.review = { tiers: [{ id: "one", name: "业务", guide: "", when: null, checks: ["review-business"], maxRounds: 3, lead: false, confirmPlan: false }], rereviewAllEvery: 2, checks: {} };
    const server = await startServer(app, { port: 0, quiet: true });
    try {
      const t = createThread(app, { channel: "web", spaceId: "shop-api", userId: "owner" });
      const ask = createRun(app, { kind: "ask", spaceId: "shop-api", title: "交办", input: { conversationId: t.id } });
      const first = createRun(app, { kind: "code", spaceId: "shop-api", title: "退款金额", input: { task: "按已发货行计算退款金额", repos: ["shop-api"] }, parentId: ask.id });
      codeChainFor(app, first);
      const go = async (id: string) => {
        run(app.db, "update runs set status = 'running' where id = ?", id);
        return await __testHandlers.get("code")!({ app, run: getRun(app, id), signal: new AbortController().signal, event: (type, data) => addRunEvent(app, id, type, data), output: (data) => setRunOutput(app, id, data) }) as { verdict: string; continuedRunId?: string };
      };
      const out = await go(first.id);
      expect(getRun(app, first.id).output.coderContext).toEqual({ used: 800, size: 1000 });
      const second = getRun(app, out.continuedRunId!);
      expect(second.input.resumeSessionId).toBe(getRun(app, first.id).output.coderSessionId);
      await go(second.id);
      const said = all<{ data: string }>(app.db, "select data from run_events where run_id = ? and type = 'status'", second.id).map((e) => JSON.parse(e.data).text as string);
      expect(said.some((s) => s.includes("换新会话"))).toBe(true);
      const turns = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { session: string; prompt: string });
      expect(turns).toHaveLength(2);
      expect(turns[1].session).not.toBe(turns[0].session);
      // The new session gets the original task, what the branch already has and this round's request.
      expect(turns[1].prompt).toContain("# 原始任务\n\n按已发货行计算退款金额");
      expect(turns[1].prompt).toContain("# 之前各轮已经做的");
      expect(turns[1].prompt).toMatch(/工作分支上的提交：\n\n```\n[0-9a-f]+ 退款金额（第 1 轮没提交的改动）/);
      expect(turns[1].prompt).toContain("上一轮评审要求修改");
    } finally {
      await server.close();
      app.db.close();
    }
  }, 180000);
});
