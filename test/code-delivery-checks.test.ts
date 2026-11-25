import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { allowedCheckCommand, assertStageCoverage, returnFailedTasks, reviewCheckFacts, runStageChecks } from "../src/agents/code-check-plan.ts";
import { parallelTaskHint } from "../src/agents/code-helpers.ts";
import { taskReview } from "../src/agents/code-loop.ts";
import { recoveryBrief } from "../src/agents/code-recovery.ts";
import { addTask, listTasks, updateTask } from "../src/agents/code-tasks.ts";
import * as dispatch from "../src/agents/dispatch.ts";
import { addRunEvent, createRun, getRun, setRunOutput } from "../src/agents/runs.ts";
import { runRole } from "../src/agents/runner.ts";
import { callTool } from "../src/agents/tools.ts";
import { agentProfileSchema } from "../src/core/config.ts";
import { run as sql } from "../src/core/db.ts";
import { git } from "../src/core/git.ts";
import { createSpace } from "../src/core/spaces.ts";
import { answerAsk, listAsks } from "../src/agents/asks.ts";
import { testApp } from "./helpers.ts";

describe("逐项交付和阶段检查", () => {
  let app: ReturnType<typeof testApp>, repo: string, root: ReturnType<typeof createRun>, base: string;
  const checkCommand = "git status --short && git diff --check";
  const signal = new AbortController().signal;
  function sh(...args: string[]) {
    const result = git(repo, args);
    if (!result.ok) throw new Error(result.stderr);
    return result.stdout.trim();
  }
  function commit(file: string, message: string, text = "示例\n") {
    writeFileSync(join(repo, file), text);
    sh("add", "--", file);
    sh("commit", "-qm", message);
    return sh("rev-parse", "HEAD");
  }
  function issue(title: string, files: string[] = []) {
    return addTask(app, root.id, { title, kind: "build", origin: { files } }, "owner");
  }
  beforeEach(() => {
    app = testApp();
    repo = join(app.home, "repo");
    mkdirSync(repo);
    sh("init", "-qb", "work");
    sh("config", "user.name", "Example");
    sh("config", "user.email", "example@example.com");
    base = commit("README.md", "初始文档");
    sh("remote", "add", "origin", join(app.home, "remote.git"));
    createSpace(app, { id: "project-a", name: "项目 A", kind: "repo", rootPath: repo });
    root = createRun(app, { kind: "code", spaceId: "project-a", title: "退款改造", input: { taskMode: true, task: "调整退款", repos: ["project-a"], checkCommand } });
    sql(app.db, "update runs set status='running' where id=?", root.id);
    setRunOutput(app, root.id, { worktrees: [{ path: repo, space: "project-a", base, start: base, branch: "work", commits: true }], deliveryBases: { "project-a": base }, repos: [{ space: "project-a", check: null }] });
  });
  afterEach(() => { app.db.close(); rmSync(app.home, { recursive: true, force: true }); });

  it("交第一项时只发该提交的推送确认，待做项直接续而不跑阶段检查", async () => {
    const remote = join(app.home, "remote.git");
    mkdirSync(remote);
    expect(git(remote, ["init", "--bare", "-q"]).ok).toBe(true);
    sh("push", "origin", "HEAD:refs/heads/main");
    setRunOutput(app, root.id, { worktrees: [{ path: repo, space: "project-a", base, start: base, branch: "work", targetBranch: "main", newBranch: true, commits: true }] });
    const first = issue("调整金额", ["refund.ts"]);
    const second = issue("准备报表", ["report.ts"]);
    const sha = commit("refund.ts", "退款金额\n\nOmem-Task: T1");
    updateTask(app, root.id, first.seq, { state: "done", coderRun: root.id, commits: { "project-a": [sha] } });
    const result = await callTool({ app, runId: root.id, spaceId: "project-a", spaces: ["project-a"], tools: new Set(["finish_task"]), actor: "agent", role: "coder" }, "finish_task", { checkpoint: [{ task: "T1", validation: "退款用例通过" }] });
    expect(result.isError, result.text).toBe(false);
    const asks = listAsks(app, { status: "pending" });
    expect(asks).toHaveLength(1);
    expect(asks[0]).toMatchObject({ handler: "work-deliver", question: expect.stringContaining("退款用例通过") });
    expect(asks[0].question).toContain("没有跑宿主检查");
    expect(asks[0].question).not.toContain(second.title);
    expect(getRun(app, root.id).status).toBe("running");
    expect(git(remote, ["rev-parse", "--verify", "refs/heads/work"]).ok).toBe(false);
    const later = commit("report.ts", "未交付的报表");
    await answerAsk(app, asks[0].id, { choice: 0, by: "owner" });
    expect(git(remote, ["rev-parse", "refs/heads/work"]).stdout.trim()).toBe(sha);
    expect(sh("rev-parse", "HEAD")).toBe(later);
    expect(getRun(app, root.id).status).toBe("running");
    const event = vi.fn();
    const next = await taskReview(app, root.id, { runId: root.id, signal, event });
    expect(next).toMatchObject({ verdict: "continuing", continuedRunId: expect.any(String) });
    expect(getRun(app, root.id).output.repositoryCheckEvidence).toBeUndefined();
    expect(getRun(app, root.id).output.reviewPlan).toBeUndefined();
    expect(event.mock.calls.map(([, entry]) => entry.text).join("\n")).not.toContain("阶段评审");
  });

  it("记录全量、复用同一提交，按计划跑相关检查或跳过纯文档", async () => {
    const runChecks = (choices: Parameters<typeof runStageChecks>[2], event = vi.fn()) => runStageChecks(app, getRun(app, root.id), choices, signal, event);
    const plan = (choice: Record<string, unknown>) => callTool({ app, runId: root.id, spaceId: "project-a", spaces: ["project-a"], tools: new Set(["plan_review"]), actor: "agent", role: "review-lead" }, "plan_review", {
      checks: [{ name: "reviewer", focus: "核对退款" }], summary: "检查受影响范围", repository_checks: [{ space: "project-a", ...choice }],
    });
    const first = vi.fn();
    expect(await runChecks([], first)).toBe(true);
    expect(first.mock.calls.find(([type]) => type === "check")?.[1]).toMatchObject({ scope: "full", command: checkCommand });
    const cached = vi.fn();
    expect(await runChecks([], cached)).toBe(true);
    expect(cached).not.toHaveBeenCalled();
    commit("README.md", "改文档", "示例说明\n");
    const skip = { space: "project-a", mode: "skip", reason: "只改 README" } as const;
    expect((await plan(skip)).isError).toBe(false);
    expect(await runChecks([skip], cached)).toBe(true);
    expect(cached).not.toHaveBeenCalled();
    commit("refund.ts", "改退款逻辑");
    expect(reviewCheckFacts(app, getRun(app, root.id))).toContain(`上次全量通过 ${base}`);
    expect((await plan(skip)).isError).toBe(true);
    const focused = { space: "project-a", mode: "focused", commands: ["git diff --check"], covers: ["refund.ts"], reason: "覆盖本次改动" } as const;
    expect((await plan({ ...focused, commands: ["echo unsafe"] })).isError).toBe(true);
    expect((await plan(focused)).isError).toBe(false);
    const picked = (getRun(app, root.id).output.reviewPlanDraft as { repositoryChecks: Parameters<typeof runStageChecks>[2] }).repositoryChecks;
    const only = vi.fn();
    expect(await runChecks(picked, only)).toBe(true);
    expect(only.mock.calls.find(([type]) => type === "check")?.[1]).toMatchObject({ scope: "focused", command: "git diff --check" });
    expect(() => assertStageCoverage(app, getRun(app, root.id))).not.toThrow();
    commit("other.ts", "另一个改动");
    expect(() => assertStageCoverage(app, getRun(app, root.id))).toThrow("没有完整的仓库检查依据");
    expect(allowedCheckCommand("pnpm run check", "pnpm exec vitest run test/example.test.ts", { check: "pnpm run test", test: "vitest run" })).toBe(true);
    expect(allowedCheckCommand("vitest run", "vitest run --config other.ts")).toBe(false);
    expect(allowedCheckCommand("vitest run", "vitest run test/example.test.ts; echo unsafe")).toBe(false);
  });

  it("全量失败按提交打回；修复后有全量基线可只复跑失败和受影响的检查", async () => {
    const full = "test -f ready && git diff --check";
    sql(app.db, "update runs set input=json_set(input, '$.checkCommand', ?) where id=?", full, root.id);
    const read = () => getRun(app, root.id);
    const failures = vi.fn();
    const passed = commit("ready", "建立全量基线");
    expect(await runStageChecks(app, read(), [], signal, vi.fn())).toBe(true);
    const task = issue("调整准备条件");
    sh("rm", "ready");
    sh("commit", "-qm", "移除准备文件");
    updateTask(app, root.id, task.seq, { state: "done", coderRun: root.id, commits: { "project-a": [sh("rev-parse", "HEAD")] } });
    expect(await runStageChecks(app, read(), [], signal, failures)).toBe(false);
    returnFailedTasks(app, read());
    expect(listTasks(app, root.id)[0].state).toBe("todo");
    commit("ready", "恢复准备文件");
    commit("refund.ts", "修正准备条件");
    const retry = vi.fn();
    expect(await runStageChecks(app, read(), [{ space: "project-a", mode: "focused", commands: ["test -f ready", "git diff --check"], covers: ["refund.ts"], reruns_failure: true, reason: "复跑失败检查并检查修改文件" }], signal, retry)).toBe(true);
    expect(retry.mock.calls.filter(([type]) => type === "check").map(([, check]) => [check.scope, check.command])).toEqual([["focused", "test -f ready"], ["focused", "git diff --check"]]);
    expect(read().output.repositoryCheckEvidence).toEqual(expect.arrayContaining([expect.objectContaining({ mode: "focused", baseline: passed, passed: true })]));
  });

  it("给出不重叠组和容量，新会话只接未完项并看到现有提交和进展", () => {
    const first = issue("金额", ["src/refund.ts"]);
    issue("金额测试", ["src"]);
    issue("下载", ["web/export.ts"]);
    issue("核对未知项");
    updateTask(app, root.id, first.seq, { state: "coding", coderRun: root.id });
    app.config.agents.autoAdvance.parallelCoders = 2;
    const text = parallelTaskHint(app, root.id, listTasks(app, root.id));
    expect(text).toContain("T2、T1 / T3");
    expect(text).toContain("2 个编码助手名额");
    expect(text).toContain("信息的项：T4");
    const sha = commit("refund.ts", "已加金额校验");
    addRunEvent(app, root.id, "text", { phase: "coder", text: "只剩边界测试" });
    addRunEvent(app, root.id, "status", { text: "编码掉线" });
    const brief = recoveryBrief(app, root.id, getRun(app, root.id), getRun(app, root.id).output.worktrees as Parameters<typeof recoveryBrief>[3]);
    expect(brief.markdown).toContain("只剩边界测试");
    expect(brief.markdown).toContain(sha.slice(0, 7));
    expect(brief.markdown).toContain("T1 [");
  });
});

describe("恢复编码后端", () => {
  afterEach(() => vi.restoreAllMocks());
  it.each([true, false])("先沿用原会话重试，不降档（备用档位已标明：%s）", async hasAlternative => {
    const app = testApp();
    try {
      app.baseUrl = "http://127.0.0.1:1";
      app.config.agents.profiles.push(...["original", "cheap", "backup"].map(id => agentProfileSchema.parse({ id, transport: "acp", command: process.execPath, model: id })));
      app.config.agents.tiers = { cheap: { profile: "cheap", effort: "low" }, ...(hasAlternative ? { standard: { profile: "original", effort: "high" } } : {}), strong: { profile: hasAlternative ? "backup" : "original", effort: "high" } };
      app.config.agents.fallback = [{ profile: "cheap", effort: "low" }, { profile: "backup", effort: "high" }];
      const root = createRun(app, { kind: "code", spaceId: "personal", title: "示例编码" });
      const backend = vi.spyOn(dispatch, "runBackend").mockImplementation(async (_app, profile) => {
        if (profile.id === "original") throw new Error("600 秒没有任何活动");
        return { text: "继续完成", agent: profile.id, stopReason: "end_turn" };
      });
      const promise = runRole(app, { role: "coder", task: "恢复本轮", runId: root.id, spaceId: "personal", resumeSessionId: "saved-session", codingRecovery: { freshTask: () => "已有提交和修改项状态", onSession: () => {} }, execution: { profile: "original", effort: "high", source: "user", reason: "本人指定" } });
      if (hasAlternative) {
        await expect(promise).resolves.toMatchObject({ profileId: "backup" });
        expect(backend.mock.calls[2]?.[2].prompt).toContain("已有提交和修改项状态");
      } else await expect(promise).rejects.toThrow("不低于原编码档位");
      expect(backend.mock.calls.map(([, profile, request]) => [profile.id, request.resumeSessionId])).toEqual([["original", "saved-session"], ["original", "saved-session"], ...(hasAlternative ? [["backup", undefined]] : [])]);
    } finally { app.db.close(); rmSync(app.home, { recursive: true, force: true }); }
  });
});
