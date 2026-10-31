import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import "../src/agents/jobs.ts";
import { answerAsk, listAsks } from "../src/agents/asks.ts";
import { codeChainFor, trySettleCodeChain } from "../src/agents/code-chain.ts";
import { worktreesOf } from "../src/agents/code.ts";
import { addTask, applyReverts, lastRound, listCheckpoints, listTasks, recordCheckpoint, recordOutsideChanges, scheduleWorkRevert, settleCodingRound, updateTask, workPatches, workState } from "../src/agents/code-tasks.ts";
import { advanceWork, taskReview } from "../src/agents/code-loop.ts";
import { callTool, type ToolContext } from "../src/agents/tools.ts";
import { recordReview, roundFindings } from "../src/agents/review.ts";
import { identity } from "../src/agents/code-branch.ts";
import { snapshot } from "../src/channels/lark-code-progress.ts";
import type { CodeChain } from "../src/agents/code-chain.ts";
import { __testHandlers, addRunEvent, createRun, getRun, setRunOutput } from "../src/agents/runs.ts";
import { createThread } from "../src/agents/threads.ts";
import { run } from "../src/core/db.ts";
import { createSpace } from "../src/core/spaces.ts";
import { OWNER } from "../src/core/users.ts";
import { startServer } from "../src/server/http.ts";
import { testApp } from "./helpers.ts";

/** Run a queued run's handler the way the worker does, and mark it finished. */
async function work(app: ReturnType<typeof testApp>, id: string) {
  run(app.db, "update runs set status = 'running' where id = ?", id);
  const r = getRun(app, id);
  const out = await __testHandlers.get(r.kind)!({
    app, run: r, signal: new AbortController().signal,
    event: (type, data) => addRunEvent(app, id, type, data),
    output: (data) => setRunOutput(app, id, data),
  }) as Record<string, unknown>;
  setRunOutput(app, id, out ?? {});
  run(app.db, "update runs set status = 'done' where id = ?", id);
  trySettleCodeChain(app, id);
  return out as { verdict: string; continuedRunId?: string };
}

describe("a delegation driven by tasks", () => {
  it("splits, verifies each fix with the check that raised it, reverts a broken fix, asks the owner only the business choice, and finishes without other clicks", async () => {
    const app = testApp();
    app.config.agents.profiles.push({ id: "fake", name: "fake", transport: "acp", command: process.execPath, args: [resolve("test/fake-acp-agent.ts")], env: { FAKE_MODE: "tasks" }, idleTimeoutMs: 60000 });
    app.config.agents.default = "fake";
    const dir = mkdtempSync(join(tmpdir(), "omem-loop-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" } });
    git("init", "-q", "-b", "main");
    writeFileSync(join(dir, "refund.ts"), "export const refund = 0;\n");
    git("add", "-A");
    git("commit", "-q", "-m", "init");
    createSpace(app, { id: "shop-api", name: "订单服务", kind: "repo", rootPath: dir });
    const server = await startServer(app, { port: 0, quiet: true });
    try {
      const t = createThread(app, { channel: "web", spaceId: "shop-api", userId: OWNER });
      const ask = createRun(app, { kind: "ask", spaceId: "shop-api", title: "交办", input: { conversationId: t.id } });
      const r1 = createRun(app, { kind: "code", spaceId: "shop-api", title: "退款金额", input: { task: "退款只按未发货的行计算", repos: ["shop-api"], taskMode: true }, parentId: ask.id });
      codeChainFor(app, r1);

      // Round 1: the coder splits into two tasks and commits each; review-lead picks the checks; the
      // business finding becomes a task done without the owner, the naming nit a question for the owner.
      const one = await work(app, r1.id);
      expect(one.verdict).toBe("continuing");
      const after1 = listTasks(app, r1.id);
      // The two checks run side by side: their findings become T3 and T4 in either order.
      const fix = after1.find((x) => x.title === "已发货行不能退")!;
      const naming = after1.find((x) => x.title === "命名可以更具体")!;
      const task = (seq: number) => listTasks(app, r1.id).find((x) => x.seq === seq)!;
      expect(after1.slice(0, 2).map((x) => [x.seq, x.kind, x.state])).toEqual([[1, "build", "done"], [2, "build", "done"]]);
      expect(after1[0].commits["shop-api"]).toHaveLength(1);
      // T2 was left uncommitted: finish_task made it a commit of its own, with its Omem-Task line.
      expect(after1[1].commits["shop-api"]).toHaveLength(1);
      expect(git("log", "--format=%B", "-n", "1", after1[1].commits["shop-api"][0])).toContain("Omem-Task: T2");
      expect(fix).toMatchObject({ kind: "fix", state: "todo", verifier: "review-business" });
      expect(naming).toMatchObject({ kind: "fix", state: "owner", verifier: "reviewer", question: "退款函数要不要统一改名成 refundable？", options: ["改名", "保持现状"] });
      expect(getRun(app, r1.id).output.reviewPlan).toMatchObject({ tier: "ai", checks: ["reviewer", "review-business"], focus: { reviewer: "退款金额的边界" } });
      expect(workState(app, r1.id)).toMatchObject({ budget: 6, budgetBy: "coder" });
      // Nothing asked of the owner but the business choice: no plan to confirm, no “按评审修改” card.
      const pending = listAsks(app, { status: "pending" });
      expect(pending.map((a) => a.handler)).toEqual(["code-task"]);
      // The Feishu card shows the tasks and what waits for the owner, not rounds and tiers.
      const progress = JSON.stringify(snapshot(app, getRun(app, ask.id).output.codeChain as CodeChain));
      expect(progress).toContain("修改项**：完成 2 / 4");
      expect(progress).toContain("（等你决定）");

      // Round 2: the coder asks the business check what its finding means, in that check's session;
      // then the fix is verified by the same check, which finds it broke something.
      const two = await work(app, one.continuedRunId!);
      expect(two.verdict).toBe("continuing");
      const asked = task(fix.seq).notes.filter((n) => n.kind === "consult");
      expect(asked.map((n) => n.by)).toEqual(["coder", "review-business"]);
      expect(asked[1].text).toContain("shipped 为 true 的行");
      const consult = app.db.prepare("select title, input from runs where parent_id = ? and kind = 'agent'").get(one.continuedRunId!) as { title: string; input: string };
      expect(consult.title).toContain("业务评审（被 编码 Agent 请教）");
      expect(JSON.parse(consult.input)).toMatchObject({ role: "review-business", askedBy: "编码 Agent" });
      expect(workState(app, r1.id).sessions?.["review-business"]?.id).toBeTruthy();
      expect(task(fix.seq)).toMatchObject({ state: "todo" });
      expect(workState(app, r1.id).reverts?.map((x) => x.seq)).toEqual([fix.seq]);

      // Round 3: T3 is reverted first, then redone; verified; the stage review of the new stretch finds
      // nothing; only the owner's question is left, and the rest of the work did not wait for it.
      const three = await work(app, two.continuedRunId!);
      expect(three.verdict).toBe("awaiting-owner");
      expect(task(fix.seq)).toMatchObject({ state: "done", reverts: 1 });
      expect(git("log", "--format=%B", "-n", "20", "--all").includes(`Omem-Revert: T${fix.seq}`)).toBe(true);
      expect(getRun(app, three.continuedRunId ?? two.continuedRunId!).output.reviewPlan).toBeTruthy();

      // The owner answers: the next round starts at once and the work finishes with only the confirm card.
      const card = listAsks(app, { status: "pending" }).find((a) => a.handler === "code-task")!;
      await answerAsk(app, card.id, { choice: 0, by: OWNER });
      expect(task(naming.seq)).toMatchObject({ state: "todo", answer: "改名" });
      const r4 = lastRound(app, r1.id);
      expect(r4.status).toBe("queued");
      const four = await work(app, r4.id);
      expect(four.verdict).toBe("approved");
      expect(listTasks(app, r1.id).map((x) => x.state)).toEqual(["done", "done", "done", "done"]);
      expect(listAsks(app, { status: "pending" }).map((a) => a.handler)).toEqual(["review-done"]);

      // Each task's change on its own, and the stretch between checkpoints.
      const worktrees = worktreesOf(app, r1.id);
      const fixPatch = workPatches(app, r1.id, worktrees, { tasks: [fix.seq] });
      expect(fixPatch).toHaveLength(1);
      expect(fixPatch[0].label).toContain(`T${fix.seq}`);
      expect(listCheckpoints(app, r1.id).length).toBeGreaterThanOrEqual(4);
      expect(workPatches(app, r1.id, worktrees, { from: 0 })[0].patch).toContain("refund.ts");

      // Back to checkpoint 1 on the owner's word: a round that only reverts — no coding Agent, no
      // review — and the tasks finished after that checkpoint count as reverted.
      const cp1 = listCheckpoints(app, r1.id)[0];
      scheduleWorkRevert(app, r1.id, worktrees, { checkpoint: 1, reason: "先回到第一轮的样子" }, OWNER);
      const back = await advanceWork(app, r1.id, { owner: true });
      const five = await work(app, back!.id);
      expect(five.verdict).toBe("approved");
      expect(getRun(app, back!.id).output).toMatchObject({ gitOnly: true, coderSummary: "这一轮只做了回退：回到检查点 1" });
      const wt = worktreesOf(app, r1.id)[0];
      expect(git("show", `${cp1.heads["shop-api"]}:refund.ts`)).toBe(readFileSync(join(wt.path, "refund.ts"), "utf8"));
      expect(task(fix.seq).state).toBe("reverted");
      expect(task(1).state).toBe("done");
    } finally {
      await server.close();
      app.db.close();
    }
  }, 120_000);

  it("stops at the budget the owner gave and goes on when the owner says so", async () => {
    const app = testApp();
    app.config.agents.profiles.push({ id: "fake", name: "fake", transport: "acp", command: process.execPath, args: [resolve("test/fake-acp-agent.ts")], env: { FAKE_MODE: "tasks" }, idleTimeoutMs: 60000 });
    app.config.agents.default = "fake";
    app.config.agents.autoAdvance.codeRoundsMax = 4;
    const dir = mkdtempSync(join(tmpdir(), "omem-loop-budget-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" } });
    git("init", "-q", "-b", "main");
    writeFileSync(join(dir, "refund.ts"), "export const refund = 0;\n");
    git("add", "-A");
    git("commit", "-q", "-m", "init");
    createSpace(app, { id: "shop-api", name: "订单服务", kind: "repo", rootPath: dir });
    const server = await startServer(app, { port: 0, quiet: true });
    try {
      // Web-started: no conversation chain; one round of budget, which the coder's estimate (6) does not replace.
      const r1 = createRun(app, { kind: "code", spaceId: "shop-api", title: "退款金额", input: { task: "退款只按未发货的行计算", repos: ["shop-api"], taskMode: true, maxRounds: 1 }, userId: OWNER });
      const one = await work(app, r1.id);
      expect(one.verdict).toBe("paused");
      expect(getRun(app, r1.id).output.reviewStop).toBe("budget");
      expect(workState(app, r1.id)).toMatchObject({ budget: 1, budgetBy: "owner", paused: "budget" });
      // The owner answers the naming question: a fresh budget, and the next round starts after the last.
      const card = listAsks(app, { status: "pending" }).find((a) => a.handler === "code-task")!;
      await answerAsk(app, card.id, { choice: null, text: "保持现状，不改名", by: OWNER });
      const next = lastRound(app, r1.id);
      expect(next.id).not.toBe(r1.id);
      expect(next).toMatchObject({ status: "queued", input: { continueFrom: r1.id, round: 2, taskMode: true } });
      expect(workState(app, r1.id)).toMatchObject({ paused: null, until: 2 });
    } finally {
      await server.close();
      app.db.close();
    }
  }, 120_000);

  it("takes back a file or a hunk as a commit of its own, and hands a hunk that no longer applies to the coder", () => {
    const app = testApp();
    const dir = mkdtempSync(join(tmpdir(), "omem-revert-"));
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: dir, encoding: "utf8" });
    git("init", "-q", "-b", "main");
    // Twenty lines, so a change at each end is a hunk of its own.
    const text = (first: string, last: string) => [first, ...Array.from({ length: 18 }, (_, i) => `l${i + 2}`), last, ""].join("\n");
    writeFileSync(join(dir, "refund.ts"), text("l1", "l20"));
    writeFileSync(join(dir, "rate.ts"), "export const rate = 1;\n");
    git("add", "-A");
    git("commit", "-q", "-m", "init");
    const base = git("rev-parse", "HEAD").trim();
    createSpace(app, { id: "shop-api", name: "订单服务", kind: "repo", rootPath: dir });
    const r = createRun(app, { kind: "code", spaceId: "shop-api", title: "退款", input: { task: "退款", repos: ["shop-api"], taskMode: true } });
    const worktrees = [{ space: "shop-api", path: dir, branch: "main", base, start: base }];
    // Two tasks: one changes the first and last lines, one the rate.
    writeFileSync(join(dir, "refund.ts"), text("L1", "L20"));
    git("commit", "-qam", "T1\n\nOmem-Task: T1");
    writeFileSync(join(dir, "rate.ts"), "export const rate = 2;\n");
    git("commit", "-qam", "T2\n\nOmem-Task: T2");
    for (const title of ["改退款", "改费率"]) addTask(app, r.id, { title, kind: "build", state: "done" }, "coder");
    recordCheckpoint(app, r.id, worktrees, r.id, [1, 2], "第 1 轮");
    const patch = workPatches(app, r.id, worktrees, { from: 0 })[0];
    expect(patch.from).toBe(base);

    // The rate file back as it was, and the first hunk of refund.ts (line 1) taken back.
    const hunks = patch.patch.split(/^diff --git /m).find((c) => c.startsWith("a/refund.ts"))!;
    const [head, ...parts] = hunks.split(/^(?=@@ )/m);
    expect(parts).toHaveLength(2);
    scheduleWorkRevert(app, r.id, worktrees, { file: { space: "shop-api", path: "rate.ts", rev: base }, reason: "费率先不动" }, OWNER);
    scheduleWorkRevert(app, r.id, worktrees, { patch: { space: "shop-api", text: `diff --git ${head}${parts[0]}` }, reason: "第一行保持原样" }, OWNER);
    // A hunk of a line nobody has any more: refused by git, so it becomes a task.
    scheduleWorkRevert(app, r.id, worktrees, { patch: { space: "shop-api", text: "diff --git a/refund.ts b/refund.ts\n--- a/refund.ts\n+++ b/refund.ts\n@@ -3,1 +3,1 @@\n-zzz\n+yyy\n" }, reason: "这段也退回去" }, OWNER);
    expect(() => scheduleWorkRevert(app, r.id, worktrees, { file: { space: "shop-api", path: "../x", rev: base } }, OWNER)).toThrow(/路径/);
    expect(() => scheduleWorkRevert(app, r.id, worktrees, { checkpoint: 9 }, OWNER)).toThrow(/检查点 9/);
    const done = applyReverts(app, r.id, worktrees, () => {}, identity);
    expect(done).toHaveLength(2);
    expect(readFileSync(join(dir, "rate.ts"), "utf8")).toBe("export const rate = 1;\n");
    expect(readFileSync(join(dir, "refund.ts"), "utf8")).toBe(text("l1", "L20"));
    expect(git("log", "--format=%B", "-n", "2")).toMatch(/Omem-Revert: 回退 refund\.ts 里的一段[\s\S]*Omem-Revert: 把 rate\.ts 恢复成/);
    const handed = listTasks(app, r.id).at(-1)!;
    expect(handed).toMatchObject({ kind: "owner", state: "todo" });
    expect(handed.doneWhen).toContain("这段也退回去");
    expect(workState(app, r.id).reverts).toEqual([]);
    updateTask(app, r.id, handed.seq, { state: "wontdo" });
    app.db.close();
  });

  it("keeps the owner's own edits between rounds as a checkpoint of theirs, never a task's change", () => {
    const app = testApp();
    const dir = mkdtempSync(join(tmpdir(), "omem-outside-"));
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: dir, encoding: "utf8" });
    git("init", "-q", "-b", "main");
    writeFileSync(join(dir, "refund.ts"), "export const refund = 0;\n");
    git("add", "-A");
    git("commit", "-q", "-m", "init");
    const base = git("rev-parse", "HEAD").trim();
    createSpace(app, { id: "shop-api", name: "订单服务", kind: "repo", rootPath: dir });
    const r = createRun(app, { kind: "code", spaceId: "shop-api", title: "退款", input: { task: "退款", repos: ["shop-api"], taskMode: true } });
    const worktrees = [{ space: "shop-api", path: dir, branch: "main", base, start: base }];
    recordCheckpoint(app, r.id, worktrees, r.id, [], "第 1 轮");
    // Nothing happened since: no checkpoint.
    expect(recordOutsideChanges(app, r.id, "r2", worktrees, identity, { previousEnded: true, round: 2 })).toBeNull();
    // The owner edits in the worktree between rounds, and leaves it uncommitted.
    writeFileSync(join(dir, "note.md"), "本人加的说明\n");
    const outside = recordOutsideChanges(app, r.id, "r2", worktrees, identity, { previousEnded: true, round: 2 })!;
    expect(outside).toMatchObject({ owner: true, files: ["note.md"], checkpoint: { seq: 2, by: "owner" } });
    expect(git("log", "--format=%B", "-n", "1")).toContain("Omem-By: owner");
    // The round codes its one task: only the coder's commit is the task's, not the owner's.
    const t = addTask(app, r.id, { title: "改退款", kind: "build", state: "coding" }, "coder");
    updateTask(app, r.id, t.seq, { coderRun: "r2" });
    writeFileSync(join(dir, "refund.ts"), "export const refund = 1;\n");
    git("commit", "-qam", "改退款\n\nOmem-Task: T1");
    settleCodingRound(app, r.id, "r2", worktrees, 2);
    const mine = listTasks(app, r.id)[0].commits["shop-api"];
    expect(mine).toHaveLength(1);
    expect(git("log", "--format=%s", "-n", "1", mine[0]).trim()).toBe("改退款");
    // After a round that failed, uncommitted changes are its unfinished work: left as they are.
    writeFileSync(join(dir, "refund.ts"), "export const refund = 2;\n");
    expect(recordOutsideChanges(app, r.id, "r3", worktrees, identity, { previousEnded: false, round: 3 })).toBeNull();
    expect(git("status", "--porcelain").trim()).toBe("M refund.ts");
    app.db.close();
  });

  it("hands a dispute the check still insists on to review-lead, and to the owner after a ruling", async () => {
    const app = testApp();
    app.config.agents.profiles.push({ id: "fake", name: "fake", transport: "acp", command: process.execPath, args: [resolve("test/fake-acp-agent.ts")], env: { FAKE_MODE: "tasks" }, idleTimeoutMs: 60000 });
    app.config.agents.default = "fake";
    const dir = mkdtempSync(join(tmpdir(), "omem-dispute-"));
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: dir, encoding: "utf8" });
    git("init", "-q", "-b", "main");
    writeFileSync(join(dir, "refund.ts"), "export const refund = 0;\n");
    git("add", "-A");
    git("commit", "-q", "-m", "init");
    const base = git("rev-parse", "HEAD").trim();
    createSpace(app, { id: "shop-api", name: "订单服务", kind: "repo", rootPath: dir });
    const server = await startServer(app, { port: 0, quiet: true });
    try {
      const r = createRun(app, { kind: "code", spaceId: "shop-api", title: "退款", input: { task: "退款只按未发货的行计算", repos: ["shop-api"], taskMode: true }, userId: OWNER });
      run(app.db, "update runs set status = 'running' where id = ?", r.id);
      setRunOutput(app, r.id, { worktrees: [{ space: "shop-api", path: dir, branch: "main", base, start: base, commits: true }], repos: [{ space: "shop-api", diffStat: "", diffBytes: 0, check: null }] });
      recordReview(app, { codeRunId: r.id, round: 1, check: "reviewer", verdict: "changes_requested", summary: "", findings: [
        { severity: "major", title: "已发货的行也算进了退款", detail: "", suggestion: "过滤已发货的行", evidence: [], confidence: "high" },
        { severity: "minor", title: "空订单会报错", detail: "", suggestion: "判空", evidence: [], confidence: "medium" },
      ] });
      const [f1, f2] = roundFindings(app, r.id, 1);
      const { taskForFinding } = await import("../src/agents/code-tasks.ts");
      const t1 = taskForFinding(app, r.id, f1, "review-lead");
      const t2 = taskForFinding(app, r.id, f2, "review-lead");
      const coding = (seq: number) => updateTask(app, r.id, seq, { state: "coding", coderRun: r.id });
      const ctx: ToolContext = { app, runId: r.id, spaceId: "shop-api", spaces: null, tools: null, actor: "agent", role: "coder" } as ToolContext;
      const dispute = (seq: number, reason: string) => callTool(ctx, "report_task", { task: `T${seq}`, kind: "disputed", reason });
      const { recordVerification } = await import("../src/agents/code-loop.ts");

      // First objection: back to the check that raised it, which insists.
      for (const t of [t1, t2]) coding(t.seq);
      expect((await dispute(t1.seq, "需求里已发货的行也要退")).text).toContain("交给 reviewer");
      await dispute(t2.seq, "空订单在上游就被拦了");
      expect(listTasks(app, r.id).map((t) => t.state)).toEqual(["verify", "verify"]);
      recordVerification(app, r.id, "reviewer", [{ task: t1.seq, verdict: "not_fixed", note: "需求第 3 条写明已发货的行不退" }, { task: t2.seq, verdict: "not_fixed", note: "上游拦不住批量导入" }]);
      // Objecting again after it insisted: review-lead rules, at the end of the round.
      for (const t of [t1, t2]) coding(t.seq);
      expect((await dispute(t1.seq, "我还是认为已发货的行要退")).text).toContain("评审负责人裁决");
      await dispute(t2.seq, "批量导入也走同一个校验");
      expect(listTasks(app, r.id).map((t) => t.state)).toEqual(["disputed", "disputed"]);
      const out = await taskReview(app, r.id, { runId: r.id, signal: new AbortController().signal, event: (type, data) => addRunEvent(app, r.id, type, data) });
      expect(out.verdict).toBe("continuing");
      const [a, b] = listTasks(app, r.id);
      expect(a).toMatchObject({ state: "todo" });
      expect(a.notes.at(-1)).toMatchObject({ by: "review-lead", kind: "lead" });
      expect(a.notes.at(-1)!.text).toContain("照评审的意见改");
      expect(b.state).toBe("wontdo");
      expect(roundFindings(app, r.id, 1).find((f) => f.id === f2.id)!.state).toBe("rejected");
      // After a ruling, objecting once more goes to the owner.
      run(app.db, "update runs set status = 'running' where id = ?", r.id);
      coding(a.seq);
      expect((await dispute(a.seq, "还是不同意")).text).toContain("交给本人");
      expect(listTasks(app, r.id)[0]).toMatchObject({ state: "owner", options: ["照评审的意见改", "不改"] });
    } finally {
      await server.close();
      app.db.close();
    }
  }, 120_000);

  it("lets the coder hand groups of tasks to helpers coding beside it, and merges what they commit", async () => {
    const app = testApp();
    app.config.agents.profiles.push({ id: "fake", name: "fake", transport: "acp", command: process.execPath, args: [resolve("test/fake-acp-agent.ts")], env: { FAKE_MODE: "tasks", FAKE_PARALLEL: "1" }, idleTimeoutMs: 60000 });
    app.config.agents.default = "fake";
    const dir = mkdtempSync(join(tmpdir(), "omem-parallel-"));
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: dir, encoding: "utf8" });
    git("init", "-q", "-b", "main");
    writeFileSync(join(dir, "refund.ts"), "export const refund = 0;\n");
    git("add", "-A");
    git("commit", "-q", "-m", "init");
    createSpace(app, { id: "shop-api", name: "订单服务", kind: "repo", rootPath: dir });
    const server = await startServer(app, { port: 0, quiet: true });
    try {
      const t = createThread(app, { channel: "web", spaceId: "shop-api", userId: OWNER });
      const ask = createRun(app, { kind: "ask", spaceId: "shop-api", title: "交办", input: { conversationId: t.id } });
      const r1 = createRun(app, { kind: "code", spaceId: "shop-api", title: "退款", input: { task: "退款三件事", repos: ["shop-api"], taskMode: true }, parentId: ask.id });
      codeChainFor(app, r1);
      await work(app, r1.id);
      // Three tasks, each done once, by the lead (T1) or a helper (T2, T3), each with its own commit on the work branch.
      const tasks = listTasks(app, r1.id).slice(0, 3);
      expect(tasks.map((x) => x.title)).toEqual(["退款只算未发货的行", "运费按比例退", "补退款说明"]);
      expect(tasks.map((x) => x.state)).toEqual(["done", "done", "done"]);
      const wt = worktreesOf(app, r1.id)[0];
      for (const x of tasks) {
        expect(x.commits["shop-api"]).toHaveLength(1);
        expect(execFileSync("git", ["log", "--format=%B", "-n", "1", x.commits["shop-api"][0]], { cwd: wt.path, encoding: "utf8" })).toContain(`Omem-Task: T${x.seq}`);
      }
      // The helpers' runs are children of the round; their workspaces are given back.
      const helpers = app.db.prepare("select id, status, input from runs where parent_id = ? and kind = 'agent' and json_extract(input, '$.helperOf') is not null order by created_at").all(r1.id) as { id: string; status: string; input: string }[];
      expect(helpers.map((h) => [h.status, JSON.parse(h.input).tasks])).toEqual([["done", [2]], ["done", [3]]]);
      expect(tasks[1].coderRun).toBe(helpers[0].id);
      for (const h of helpers) expect(existsSync(join(app.runsDir, h.id, "work", "shop-api"))).toBe(false);
      // All three edits of the same spot are there, the conflicts resolved by the lead.
      const merged = readFileSync(join(wt.path, "refund.ts"), "utf8");
      expect(merged).not.toMatch(/^[<=>]{7}/m);
      for (const n of [1, 2, 3]) expect(merged).toContain(`export const t${n} =`);
      const events = (app.db.prepare("select data from run_events where run_id = ? and type = 'status'").all(r1.id) as { data: string }[]).map((e) => JSON.parse(e.data).text as string);
      expect(events.some((e) => e.startsWith("已合并编码助手 1"))).toBe(true);
      expect(events.some((e) => e.startsWith("已合并编码助手 2"))).toBe(true);
    } finally {
      await server.close();
      app.db.close();
    }
  }, 180_000);

  it("verifies a round's tasks while it codes, and lets another model look at the stage again beside the fixes", async () => {
    const app = testApp();
    const fake = (id: string) => ({ id, name: id, transport: "acp" as const, command: process.execPath, args: [resolve("test/fake-acp-agent.ts")], env: { FAKE_MODE: "tasks", FAKE_OVERLAP: "1", FAKE_LOOK_DELAY: "2500" }, idleTimeoutMs: 60000 });
    app.config.agents.profiles.push(fake("fake"), fake("fake2"));
    app.config.agents.default = "fake";
    app.config.review.rotation = [{ profile: "fake2" }];
    const dir = mkdtempSync(join(tmpdir(), "omem-overlap-"));
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: dir, encoding: "utf8" });
    git("init", "-q", "-b", "main");
    writeFileSync(join(dir, "refund.ts"), "export const refund = 0;\n");
    git("add", "-A");
    git("commit", "-q", "-m", "init");
    createSpace(app, { id: "shop-api", name: "订单服务", kind: "repo", rootPath: dir });
    const server = await startServer(app, { port: 0, quiet: true });
    try {
      const t = createThread(app, { channel: "web", spaceId: "shop-api", userId: OWNER });
      const ask = createRun(app, { kind: "ask", spaceId: "shop-api", title: "交办", input: { conversationId: t.id } });
      const r1 = createRun(app, { kind: "code", spaceId: "shop-api", title: "退款金额", input: { task: "退款只按未发货的行计算", repos: ["shop-api"], taskMode: true }, parentId: ask.id });
      codeChainFor(app, r1);

      // Round 1: the stage review asks another model to look at the business side again.
      const one = await work(app, r1.id);
      expect(one.verdict).toBe("continuing");
      expect(workState(app, r1.id).look?.checks.map((c) => c.name)).toEqual(["review-business"]);
      expect(workState(app, r1.id).lookAI).toEqual({ "review-business": { profile: "fake2" } });
      const fix = listTasks(app, r1.id).find((x) => x.title === "已发货行不能退")!;

      // Round 2 codes the fix while the second look runs. The fix is verified as soon as it is
      // finished, is not fixed, comes back and is fixed in the same round; what the second look adds
      // joins this round too.
      const two = await work(app, one.continuedRunId!);
      const r2 = one.continuedRunId!;
      expect(two.verdict).toBe("awaiting-owner");
      const task = (seq: number) => listTasks(app, r1.id).find((x) => x.seq === seq)!;
      expect(task(fix.seq)).toMatchObject({ state: "done", attempts: 1, coderRun: r2 });
      expect(task(fix.seq).commits["shop-api"]).toHaveLength(2);
      expect(task(fix.seq).notes.map((n) => n.text)).toEqual(expect.arrayContaining([expect.stringContaining("没改好"), "验证没过，交回这一轮接着改", "验证通过"]));
      const added = listTasks(app, r1.id).find((x) => x.title === "退款要按支付渠道分开算")!;
      expect(added).toMatchObject({ state: "done", verifier: "review-business@复看", coderRun: r2 });
      expect(added.notes.map((n) => n.text)).toContain("复看新发现，交给正在编码的这一轮");
      // Nothing else needed a round of its own: the owner's question is all that is left.
      expect(lastRound(app, r1.id).id).toBe(r2);
      expect(workState(app, r1.id).look).toBeNull();

      // The second look is recorded apart from the first, on its own model and session.
      const looks = app.db.prepare("select check_name, profile_id from reviews where code_run_id = ? order by created_at").all(r1.id) as { check_name: string; profile_id: string }[];
      expect(looks.find((x) => x.check_name === "review-business")?.profile_id).toBe("fake");
      expect(looks.find((x) => x.check_name === "review-business@复看")?.profile_id).toBe("fake2");
      expect(Object.keys(workState(app, r1.id).sessions ?? {})).toEqual(expect.arrayContaining(["review-business", "review-business@复看"]));
      const child = app.db.prepare("select title, status from runs where parent_id = ? and json_extract(input, '$.secondLookOf') is not null").get(r1.id) as { title: string; status: string };
      expect(child).toMatchObject({ status: "done" });
      expect(child.title).toContain("复看：业务（fake2）");
      // The coder heard about both mid-turn, through its tool results.
      const events = (app.db.prepare("select data from run_events where run_id = ? and type = 'status'").all(r2) as { data: string }[]).map((e) => JSON.parse(e.data).text as string);
      expect(events.filter((e) => e === "把评审的反馈交给了编码 Agent").length).toBeGreaterThanOrEqual(1);
    } finally {
      await server.close();
      app.db.close();
    }
  }, 180_000);

  it("turns a delegation started before the task loop task-driven on the owner's next request, its rounds so far one checkpoint", async () => {
    const app = testApp();
    const dir = mkdtempSync(join(tmpdir(), "omem-convert-"));
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: dir, encoding: "utf8" }).trim();
    git("init", "-q", "-b", "main");
    writeFileSync(join(dir, "refund.ts"), "export const refund = 0;\n");
    git("add", "-A");
    git("commit", "-q", "-m", "init");
    const base = git("rev-parse", "HEAD");
    writeFileSync(join(dir, "refund.ts"), "export const refund = 1;\n");
    git("commit", "-qam", "第 1 轮");
    createSpace(app, { id: "shop-api", name: "订单服务", kind: "repo", rootPath: dir });
    try {
      const old = createRun(app, { kind: "code", spaceId: "shop-api", title: "退款", input: { task: "退款只按未发货的行计算", repos: ["shop-api"] } });
      setRunOutput(app, old.id, { worktrees: [{ space: "shop-api", path: dir, branch: "main", base, start: base, commits: true }], verdict: "changes-requested" });
      run(app.db, "update runs set status = 'done' where id = ?", old.id);
      const { startFix } = await import("../src/agents/review-fix.ts");
      const next = await startFix(app, old.id, { findingIds: [], text: "看一下 SDK 不支持的字段旧数据会不会保留", review: { checks: ["review-arch"] } }, OWNER);
      expect(getRun(app, old.id).input.taskMode).toBe(true);
      expect(listCheckpoints(app, old.id).map((c) => [c.seq, c.by, c.heads["shop-api"]])).toEqual([[1, "host", git("rev-parse", "HEAD")]]);
      expect(listTasks(app, old.id).map((t) => [t.kind, t.state, t.title])).toEqual([["owner", "todo", "看一下 SDK 不支持的字段旧数据会不会保留"]]);
      expect(next).toMatchObject({ kind: "code", status: "queued" });
      expect(next.input).toMatchObject({ continueFrom: old.id, roundReview: { checks: ["review-arch"] } });
      // Nothing reviewed yet: the first stage review takes the whole change since the start.
      expect(workState(app, old.id).stageAt ?? 0).toBe(0);
    } finally {
      app.db.close();
    }
  });
});