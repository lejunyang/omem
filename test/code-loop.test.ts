import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import "../src/agents/jobs.ts";
import { answerAsk, createAsk, listAsks } from "../src/agents/asks.ts";
import { codeChainFor, trySettleCodeChain } from "../src/agents/code-chain.ts";
import { ignoredAdded, worktreesOf } from "../src/agents/code.ts";
import { addTask, applyReverts, lastRound, listCheckpoints, listTasks, ownerQuestionText, recordCheckpoint, recordOutsideChanges, retryTask, scheduleWorkRevert, setWorkState, settleCodingRound, updateTask, waitingText, workPatches, workState } from "../src/agents/code-tasks.ts";
import { advanceWork, reconcileWaiting, reviewAgain, settleTask, taskReview } from "../src/agents/code-loop.ts";
import { callTool, type ToolContext } from "../src/agents/tools.ts";
import { recordReview, roundFindings } from "../src/agents/review.ts";
import { identity } from "../src/agents/code-branch.ts";
import { snapshot } from "../src/channels/lark-code-progress.ts";
import type { CodeChain } from "../src/agents/code-chain.ts";
import { __testHandlers, addRunEvent, createRun, getRun, setRunOutput } from "../src/agents/runs.ts";
import { createThread } from "../src/agents/threads.ts";
import { all, run } from "../src/core/db.ts";
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
      // review-lead's question for the owner goes to the assistant first, with its options; no card yet.
      expect(naming).toMatchObject({ kind: "fix", state: "assistant", verifier: "reviewer", options: ["改名", "保持现状"] });
      expect(naming.question).toContain("评审负责人认为要本人决定：退款函数要不要统一改名成 refundable？");
      expect(listAsks(app, { status: "pending" }).filter((a) => a.handler === "code-task")).toHaveLength(0);
      // The assistant finds it is the owner's call and passes it on: now the card.
      settleTask(app, r1.id, naming.seq, { action: "owner", text: "命名口径需求没写", ownerWords: false, question: "退款函数要不要统一改名成 refundable？", options: ["改名", "保持现状"] }, "assistant");
      expect(task(naming.seq)).toMatchObject({ state: "owner", question: "退款函数要不要统一改名成 refundable？" });
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
      const fixPatch = await workPatches(app, r1.id, worktrees, { tasks: [fix.seq] });
      expect(fixPatch).toHaveLength(1);
      expect(fixPatch[0].label).toContain(`T${fix.seq}`);
      expect(listCheckpoints(app, r1.id).length).toBeGreaterThanOrEqual(4);
      expect((await workPatches(app, r1.id, worktrees, { from: 0 }))[0].patch).toContain("refund.ts");
      // The whole branch against another one, from where they part (a review before it goes in).
      const start = worktrees[0].start ?? git("rev-parse", worktrees[0].base).trim();
      git("branch", "release-x", start);
      const whole = await workPatches(app, r1.id, worktrees, { base: "release-x" });
      expect(whole[0]).toMatchObject({ from: start });
      expect(whole[0].patch).toContain("refund.ts");
      // Where the tip is checked out (an editor's new side): the work's worktree; nowhere once it moves off.
      const norm = (p?: string) => p && realpathSync(p).replace(/\\/g, "/").toLowerCase();
      expect(norm(whole[0].at)).toBe(norm(worktrees[0].path));
      execFileSync("git", ["-C", worktrees[0].path, "checkout", "-q", "--detach", "HEAD~1"]);
      expect((await workPatches(app, r1.id, worktrees, { base: "release-x" }))[0].at).toBeUndefined();
      execFileSync("git", ["-C", worktrees[0].path, "checkout", "-q", "-"]);
      await expect(workPatches(app, r1.id, worktrees, { base: "no-such-branch" })).rejects.toThrow(/没有分支 no-such-branch/);

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

  it("goes on to the stage review when a round its coder finished starts again after a restart, instead of approving it unreviewed", async () => {
    const app = testApp();
    app.config.agents.profiles.push({ id: "fake", name: "fake", transport: "acp", command: process.execPath, args: [resolve("test/fake-acp-agent.ts")], env: { FAKE_MODE: "tasks" }, idleTimeoutMs: 60000 });
    app.config.agents.default = "fake";
    const dir = mkdtempSync(join(tmpdir(), "omem-loop-restart-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" } });
    git("init", "-q", "-b", "main");
    writeFileSync(join(dir, "refund.ts"), "export const refund = 0;\n");
    git("add", "-A");
    git("commit", "-q", "-m", "init");
    createSpace(app, { id: "shop-api", name: "订单服务", kind: "repo", rootPath: dir });
    const server = await startServer(app, { port: 0, quiet: true });
    try {
      const r1 = createRun(app, { kind: "code", spaceId: "shop-api", title: "退款金额", input: { task: "退款只按未发货的行计算", repos: ["shop-api"], taskMode: true, maxRounds: 4 }, userId: OWNER });
      addTask(app, r1.id, { title: "退款只算未发货的行", kind: "build" }, "coder");
      const drive = async (id: string) => {
        for (let out = await work(app, id); out.continuedRunId; out = await work(app, out.continuedRunId)) id = out.continuedRunId;
        return id;
      };
      await drive(r1.id);
      // A later round, coded; the restart came during its stage review (nothing recorded for it yet).
      addTask(app, r1.id, { title: "补退款说明", kind: "build" }, "coder");
      setWorkState(app, r1.id, { paused: null });
      const next = advanceWork(app, r1.id, { owner: true })!;
      const r2 = { id: next.id };
      await work(app, r2.id);
      const round = Number(getRun(app, r2.id).input.round);
      const reviewed = () => all<{ n: number }>(app.db, "select count(*) n from reviews where code_run_id = ? and round = ?", r2.id, round)[0].n;
      expect(listTasks(app, r1.id).find((t) => t.title === "补退款说明")!.state).toBe("done");
      run(app.db, "delete from review_findings where review_id in (select id from reviews where code_run_id = ?)", r2.id);
      run(app.db, "delete from reviews where code_run_id = ?", r2.id);
      setWorkState(app, r1.id, { stageAt: workState(app, r1.id).stages?.length ? 1 : 0 });
      run(app.db, "update runs set status = 'queued', output = json_remove(output, '$.verdict', '$.reviewStage', '$.codeChain') where id = ?", r2.id);
      await work(app, r2.id);
      expect(getRun(app, r2.id).output.gitOnly).toBeFalsy();
      expect(reviewed()).toBeGreaterThan(0);

      // The owner asks for another review: a round with nothing to code reviews the last checkpoint's change.
      const end = await drive(lastRound(app, r1.id).status === "queued" ? lastRound(app, r1.id).id : r2.id).catch(() => r2.id);
      const latest = listCheckpoints(app, r1.id).at(-1)!.seq;
      const again = reviewAgain(app, r1.id);
      expect(again.id).not.toBe(end);
      expect(workState(app, r1.id).stageAt).toBe(latest - 1);
      await work(app, again.id);
      expect(getRun(app, again.id).output.gitOnly).toBeFalsy();
      expect(all<{ n: number }>(app.db, "select count(*) n from reviews where code_run_id = ?", again.id)[0].n).toBeGreaterThan(0);
    } finally {
      await server.close();
      app.db.close();
    }
  }, 120_000);

  it("takes back a file or a hunk as a commit of its own, and hands a hunk that no longer applies to the coder", async () => {
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
    const patch = (await workPatches(app, r.id, worktrees, { from: 0 }))[0];
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

  it("makes force-added ignored files and a check still failing at the end tasks of the host, again only when a done one did not hold", async () => {
    const app = testApp();
    const dir = mkdtempSync(join(tmpdir(), "omem-host-"));
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: dir, encoding: "utf8" });
    git("init", "-q", "-b", "main");
    writeFileSync(join(dir, ".gitignore"), "gen/\n");
    writeFileSync(join(dir, "refund.ts"), "export const refund = 0;\n");
    git("add", "-A");
    git("commit", "-q", "-m", "init");
    const base = git("rev-parse", "HEAD").trim();
    mkdirSync(join(dir, "gen"));
    writeFileSync(join(dir, "gen", "client.ts"), "export const listRefunds = () => [];\n");
    writeFileSync(join(dir, "refund.ts"), "export const refund = 1;\n");
    git("add", "-f", "gen/client.ts", "refund.ts");
    git("commit", "-q", "-m", "refund, with the generated client");
    const wt = { space: "shop-api", path: dir, branch: "main", base, start: base, commits: true };
    expect(ignoredAdded(wt)).toEqual([{ pattern: "gen/", files: 1, example: "gen/client.ts" }]);
    createSpace(app, { id: "shop-api", name: "订单服务", kind: "repo", rootPath: dir });
    try {
      const r = createRun(app, { kind: "code", spaceId: "shop-api", title: "退款", input: { task: "退款只按未发货的行计算", repos: ["shop-api"], taskMode: true }, userId: OWNER });
      run(app.db, "update runs set status = 'running' where id = ?", r.id);
      const repo = { space: "shop-api", diffStat: "", diffBytes: 0, check: { command: "npm test", code: 1, output: "1 failed: refund.test.ts" } };
      setRunOutput(app, r.id, { worktrees: [wt], repos: [{ ...repo, ignored: ignoredAdded(wt) }] });
      const review = () => taskReview(app, r.id, { runId: r.id, signal: new AbortController().signal, event: (type, data) => addRunEvent(app, r.id, type, data) });
      const states = () => listTasks(app, r.id).map((t) => [t.title, t.state]);
      // Nothing else to do: not approved with a red check, and the generated client goes back.
      expect((await review()).verdict).not.toBe("approved");
      expect(states()).toEqual([["撤回提交了的被忽略文件", "todo"], ["检查没通过", "todo"]]);
      expect(listTasks(app, r.id)[0].doneWhen).toContain("`gen/`：1 个文件（如 `gen/client.ts`）");
      expect(listTasks(app, r.id)[1].doneWhen).toContain("1 failed: refund.test.ts");
      // Still open: not added twice.
      await review();
      expect(states()).toHaveLength(2);
      // The coder said done but the check still fails; it hands that to the owner the next time.
      for (const t of listTasks(app, r.id)) updateTask(app, r.id, t.seq, { state: "done" });
      setRunOutput(app, r.id, { repos: [repo] });
      await review();
      expect(states()).toEqual([["撤回提交了的被忽略文件", "done"], ["检查没通过", "done"], ["检查没通过", "todo"]]);
      updateTask(app, r.id, 3, { state: "owner", question: "测试环境连不上，先不管？" });
      expect((await review()).verdict).toBe("awaiting-owner");
      expect(states()).toHaveLength(3);
    } finally {
      // The owner's card is shown after an import or two; let it land before the database closes.
      await new Promise((resolve) => setTimeout(resolve, 100));
      app.db.close();
    }
  });

  it("gives what held the coder up to the assistant that started the work at once, never as the owner's question, and holds it to what it may decide", async () => {
    const app = testApp();
    try {
      const t = createThread(app, { channel: "web", spaceId: "personal", userId: OWNER });
      const ask = createRun(app, { kind: "ask", spaceId: "personal", title: "交办", input: { conversationId: t.id } });
      const r = createRun(app, { kind: "code", spaceId: "personal", title: "退款", input: { task: "退款只按未发货的行计算", repos: ["personal"], taskMode: true }, parentId: ask.id, userId: OWNER });
      codeChainFor(app, r);
      run(app.db, "update runs set status = 'running' where id = ?", r.id);
      const sync = addTask(app, r.id, { title: "同步远端最新代码", kind: "build" }, "coder");
      const scope = addTask(app, r.id, { title: "存量订单怎么算", kind: "build", state: "owner", question: "存量订单按哪个口径？", options: ["旧口径", "新口径"] }, "coder");
      const coder: ToolContext = { app, runId: r.id, spaceId: "personal", spaces: null, tools: null, actor: "agent", role: "coder" } as ToolContext;
      const block = async () => {
        updateTask(app, r.id, sync.seq, { state: "coding", coderRun: r.id });
        return callTool(coder, "report_task", { task: `T${sync.seq}`, kind: "blocked", reason: "Git 目录只读，fetch 写不了 FETCH_HEAD" });
      };
      expect((await block()).text).toContain("发起交办的助手");
      expect(listTasks(app, r.id)[0]).toMatchObject({ state: "assistant", options: [] });
      // Woken now, while the round goes on; a second report does not queue a second turn.
      const wakes = () => all<{ input: string }>(app.db, "select input from runs where kind = 'ask' and json_extract(input, '$.handoff.kind') = 'code-tasks'").map((x) => JSON.parse(x.input));
      expect(wakes()).toHaveLength(1);
      expect(wakes()[0]).toMatchObject({ conversationId: t.id, handoff: { workId: r.id }, denyTools: expect.arrayContaining(["continue_code_run"]) });
      const waiting = waitingText(app, r.id);
      expect(waiting.split("## 在等本人决定")[0]).toContain("同步远端最新代码");
      expect(waiting.split("## 在等本人决定")[1]).toContain("存量订单");
      expect(listAsks(app, { status: "pending" }).some((a) => a.question.includes("同步远端最新代码"))).toBe(false);
      // An owner question without options is not one: the coder is told to use blocked.
      updateTask(app, r.id, scope.seq, { state: "coding", coderRun: r.id });
      expect((await callTool(coder, "report_task", { task: `T${scope.seq}`, kind: "owner", reason: "缺后端字段", question: "请后端补审核时间" })).isError).toBe(true);
      updateTask(app, r.id, scope.seq, { state: "owner" });

      const handoff = createRun(app, { kind: "ask", spaceId: "personal", title: "看结果", input: { conversationId: t.id, handoff: { kind: "code-tasks", runId: r.id, workId: r.id } } });
      const assistant: ToolContext = { app, runId: handoff.id, spaceId: "personal", spaces: null, tools: null, actor: "agent", userId: OWNER } as ToolContext;
      const settle = (ctx: ToolContext, seq: number, action: string, note: string, extra: Record<string, unknown> = {}) => callTool(ctx, "settle_code_task", { run_id: r.id, task: `T${seq}`, action, note, ...extra });
      // Not its decision to make.
      expect((await settle(assistant, scope.seq, "retry", "按新口径")).text).toContain("在等本人决定");
      // Its own: done again twice at most, then only the owner (with options) or not at all.
      for (const n of [1, 2]) {
        const done = await settle(assistant, sync.seq, "retry", `第 ${n} 次：宿主开始前已经拉过，HEAD 就是最新`);
        expect(done.text).toContain("回到待做");
        expect(listTasks(app, r.id)[0]).toMatchObject({ state: "todo", attempts: 0, answer: null });
        expect(listTasks(app, r.id)[0].notes.at(-1)).toMatchObject({ by: "assistant", kind: "assistant" });
        await block();
      }
      expect((await settle(assistant, sync.seq, "retry", "再试一次")).text).toContain("重做过 2 次");
      expect((await settle(assistant, sync.seq, "owner", "常驻服务器上要本人登录一次")).isError).toBe(true);
      expect((await settle(assistant, sync.seq, "owner", "查过：只读的是常驻服务器的 Git 目录", { question: "要不要在常驻服务器上放开工作区的 Git 目录写权限？", options: ["放开", "保持只读，由宿主提交"] })).isError).toBe(false);
      expect(listTasks(app, r.id)[0]).toMatchObject({ state: "owner", options: ["放开", "保持只读，由宿主提交"] });
      expect(listAsks(app, { status: "pending" }).find((a) => a.question.includes("同步远端最新代码"))!.question).toContain("放开工作区的 Git 目录写权限");

      // The owner's own answer in the conversation is relayed.
      const said = "msg_owner";
      run(app.db, "insert into messages(id, conversation_id, role, text, created_at) values(?,?,?,?,?)", said, t.id, "user", "存量按新口径", new Date().toISOString());
      const turn = createRun(app, { kind: "ask", spaceId: "personal", title: "回答", input: { conversationId: t.id, messageIds: [said] } });
      expect((await settle({ ...assistant, runId: turn.id } as ToolContext, scope.seq, "retry", "本人说：存量按新口径")).isError).toBe(false);
      expect(listTasks(app, r.id)[1]).toMatchObject({ state: "todo", answer: "本人说：存量按新口径" });

      // Once the card is out the work waits for the owner: a background turn does not answer it for them,
      // whatever earlier words it quotes.
      updateTask(app, r.id, scope.seq, { state: "owner" });
      expect((await settle(assistant, scope.seq, "retry", "恢复既定口径，继续修复", { existing_authorization: "此前本人已明确：存量按新口径" })).isError).toBe(true);
      expect((await settle(assistant, scope.seq, "skip", "先不做")).isError).toBe(true);
      expect(listTasks(app, r.id)[1].state).toBe("owner");
    } finally {
      app.db.close();
    }
  });

  it("gives a question the coder has for the owner to the assistant first; the owner is asked only when it passes it on, and then waited for", async () => {
    const app = testApp();
    try {
      const t = createThread(app, { channel: "web", spaceId: "personal", userId: OWNER });
      const ask = createRun(app, { kind: "ask", spaceId: "personal", title: "交办", input: { conversationId: t.id } });
      const r = createRun(app, { kind: "code", spaceId: "personal", title: "退款", input: { task: "退款只按未发货的行计算", repos: ["personal"], taskMode: true, round: 1 }, parentId: ask.id, userId: OWNER });
      codeChainFor(app, r);
      run(app.db, "update runs set status = 'running' where id = ?", r.id);
      const test = addTask(app, r.id, { title: "旧测试断言离页后仍发请求", kind: "fix" }, "coder");
      const scope = addTask(app, r.id, { title: "存量订单怎么算", kind: "build" }, "coder");
      for (const x of [test, scope]) updateTask(app, r.id, x.seq, { state: "coding", coderRun: r.id });
      const coder: ToolContext = { app, runId: r.id, spaceId: "personal", spaces: null, tools: null, actor: "agent", role: "coder" } as ToolContext;
      const cards = () => listAsks(app, { status: "pending" }).filter((a) => a.handler === "code-task");
      const wakes = () => all<{ id: string }>(app.db, "select id from runs where kind = 'ask' and json_extract(input, '$.handoff.kind') = 'code-tasks'");
      const options = ["按新行为改写这个用例", "删掉这个用例"];
      const said = await callTool(coder, "report_task", { task: `T${test.seq}`, kind: "owner", reason: "旧用例断言的是要修的缺陷", question: "这个失败的断言怎么处理？", options });
      expect(said.text).toContain("发起交办的助手");
      // The assistant has it, with the coder's question and options; no card, and it is woken now.
      expect(listTasks(app, r.id)[0]).toMatchObject({ state: "assistant", options });
      expect(listTasks(app, r.id)[0].question).toContain("这个失败的断言怎么处理？");
      expect(cards()).toHaveLength(0);
      expect(wakes()).toHaveLength(1);
      await callTool(coder, "report_task", { task: `T${scope.seq}`, kind: "owner", reason: "需求没写存量订单", question: "存量订单按哪个口径？", options: ["旧口径", "新口径"] });
      // The round ends: still no card for either, nothing waits on the owner.
      run(app.db, "update runs set status = 'done' where id = ?", r.id);
      expect(cards()).toHaveLength(0);

      const handoff = createRun(app, { kind: "ask", spaceId: "personal", title: "修改项等助手处理", input: { conversationId: t.id, handoff: { kind: "code-tasks", runId: r.id, workId: r.id } } });
      const assistant: ToolContext = { app, runId: handoff.id, spaceId: "personal", spaces: null, tools: null, actor: "agent", userId: OWNER } as ToolContext;
      const settle = (seq: number, action: string, note: string, extra: Record<string, unknown> = {}) => callTool(assistant, "settle_code_task", { run_id: r.id, task: `T${seq}`, action, note, ...extra });
      // What the requirement already settles, the assistant decides itself: the owner is never asked.
      expect((await settle(test.seq, "retry", "需求要离页不再发请求：按新行为改写这个用例")).isError).toBe(false);
      expect(listTasks(app, r.id)[0].state).toBe("todo");
      expect(listAsks(app, {}).filter((a) => a.handler === "code-task")).toHaveLength(0);
      // A business choice it cannot make goes to the owner, once, as a card.
      expect((await settle(scope.seq, "owner", "需求和之前的对话都没提存量订单", { question: "存量订单按哪个口径？", options: ["旧口径", "新口径"] })).isError).toBe(false);
      expect(listTasks(app, r.id)[1].state).toBe("owner");
      expect(cards()).toHaveLength(1);
      // From then on it waits for the owner: no background turn answers it, the card stays.
      expect((await settle(scope.seq, "retry", "按新口径")).isError).toBe(true);
      expect(listTasks(app, r.id)[1].state).toBe("owner");
      expect(cards()).toHaveLength(1);
      // The owner answers in the conversation and the assistant relays it: the card closes saying so.
      run(app.db, "insert into messages(id, conversation_id, role, text, created_at) values(?,?,?,?,?)", "msg_owner", t.id, "user", "存量按新口径", new Date().toISOString());
      const turn = createRun(app, { kind: "ask", spaceId: "personal", title: "回答", input: { conversationId: t.id, messageIds: ["msg_owner"] } });
      expect((await callTool({ ...assistant, runId: turn.id } as ToolContext, "settle_code_task", { run_id: r.id, task: `T${scope.seq}`, action: "retry", note: "本人说：存量按新口径" })).isError).toBe(false);
      const closedCard = listAsks(app, {}).find((a) => a.handler === "code-task")!;
      expect(closedCard).toMatchObject({ status: "cancelled" });
      expect(closedCard.result).toContain("已由助手转达你在对话里的回答");
    } finally {
      await new Promise((resolve) => setTimeout(resolve, 100));
      app.db.close();
    }
  });

  it("asks the owner directly what the coder cannot decide when no assistant started the work", async () => {
    const app = testApp();
    try {
      const r = createRun(app, { kind: "code", spaceId: "personal", title: "网页交办", input: { task: "退款", repos: ["personal"], taskMode: true, round: 1 }, userId: OWNER });
      run(app.db, "update runs set status = 'running' where id = ?", r.id);
      const x = addTask(app, r.id, { title: "存量订单怎么算", kind: "build" }, "coder");
      updateTask(app, r.id, x.seq, { state: "coding", coderRun: r.id });
      const coder: ToolContext = { app, runId: r.id, spaceId: "personal", spaces: null, tools: null, actor: "agent", role: "coder" } as ToolContext;
      expect((await callTool(coder, "report_task", { task: `T${x.seq}`, kind: "owner", reason: "需求没写", question: "存量订单按哪个口径？", options: ["旧口径", "新口径"] })).text).toContain("交给本人");
      expect(listTasks(app, r.id)[0]).toMatchObject({ state: "owner", question: "存量订单按哪个口径？", options: ["旧口径", "新口径"] });
      // review-lead's question too.
      recordReview(app, { codeRunId: r.id, round: 1, check: "reviewer", verdict: "changes_requested", summary: "", findings: [
        { severity: "major", title: "运费退不退", detail: "", suggestion: "定口径", evidence: [], confidence: "high" },
      ] });
      const [f] = roundFindings(app, r.id, 1);
      const { tasksFromRuling } = await import("../src/agents/code-tasks.ts");
      const [lead] = tasksFromRuling(app, r.id, [f], { by: "host", owner: { [String(f.id)]: { question: "运费退不退？", options: ["退", "不退"] } } });
      expect(lead).toMatchObject({ state: "owner", question: "运费退不退？", options: ["退", "不退"] });
    } finally {
      app.db.close();
    }
  });

  it("hands review-lead's questions to the assistant, which settles them, turns down fixes the work does not need and adds what it misses; only what it passes on reaches the owner", async () => {
    const app = testApp();
    try {
      const t = createThread(app, { channel: "web", spaceId: "personal", userId: OWNER });
      const ask = createRun(app, { kind: "ask", spaceId: "personal", title: "交办", input: { conversationId: t.id } });
      const r = createRun(app, { kind: "code", spaceId: "personal", title: "退款", input: { task: "退款只按未发货的行计算", repos: ["personal"], taskMode: true, round: 1 }, parentId: ask.id, userId: OWNER });
      codeChainFor(app, r);
      run(app.db, "update runs set status = 'done' where id = ?", r.id);
      recordReview(app, { codeRunId: r.id, round: 1, check: "reviewer", verdict: "changes_requested", summary: "", findings: [
        { severity: "major", title: "存量订单的口径没定", detail: "", suggestion: "定口径", evidence: [], confidence: "high" },
        { severity: "minor", title: "退款函数改成类", detail: "", suggestion: "改成 RefundService", evidence: [], confidence: "medium" },
        { severity: "major", title: "部分退款的金额精度", detail: "", suggestion: "按分计算", evidence: [], confidence: "high" },
      ] });
      const [f1, f2, f3] = roundFindings(app, r.id, 1);
      const { tasksFromRuling } = await import("../src/agents/code-tasks.ts");
      const [scope, style, money] = tasksFromRuling(app, r.id, [f1, f2, f3], { by: "host", owner: { [String(f1.id)]: { question: "存量订单按哪个口径？", options: ["旧口径", "新口径"] } } });
      const cards = () => listAsks(app, { status: "pending" }).filter((a) => a.handler === "code-task");
      // review-lead's question waits on the assistant, with the lead's question and options; no card.
      expect(scope).toMatchObject({ state: "assistant", options: ["旧口径", "新口径"] });
      expect(scope.question).toContain("评审负责人认为要本人决定：存量订单按哪个口径？");
      expect(cards()).toHaveLength(0);
      expect([style.state, money.state]).toEqual(["todo", "todo"]);

      const handoff = createRun(app, { kind: "ask", spaceId: "personal", title: "修改项等助手处理", input: { conversationId: t.id, handoff: { kind: "code-tasks", runId: r.id, workId: r.id } } });
      const assistant: ToolContext = { app, runId: handoff.id, spaceId: "personal", spaces: null, tools: null, actor: "agent", userId: OWNER } as ToolContext;
      const settle = (extra: Record<string, unknown>) => callTool(assistant, "settle_code_task", { run_id: r.id, ...extra });
      // A fix the work does not need (a preference) is turned down before it is coded; its finding is rejected.
      expect((await settle({ task: `T${style.seq}`, action: "skip", note: "只是写法偏好，需求没要求重构" })).isError).toBe(false);
      expect(listTasks(app, r.id).find((x) => x.seq === style.seq)!.state).toBe("wontdo");
      expect(roundFindings(app, r.id, 1).find((f) => f.id === f2.id)).toMatchObject({ state: "rejected" });
      // Set aside for later.
      expect((await settle({ task: `T${money.seq}`, action: "later", note: "现在只有整单退款，碰不到部分退款" })).isError).toBe(false);
      // What the requirement asks and nobody does: a new task.
      const added = await settle({ action: "add", title: "已发货的行不计入退款", note: "需求第 1 条：只按未发货的行计算；现在没有哪一项在做" });
      expect(added.isError).toBe(false);
      expect(listTasks(app, r.id).at(-1)).toMatchObject({ title: "已发货的行不计入退款", kind: "build", state: "todo" });
      expect((await settle({ action: "add", note: "缺标题" })).isError).toBe(true);
      // The business choice: passed on, and only now a card.
      expect((await settle({ task: `T${scope.seq}`, action: "owner", note: "需求没写存量订单", question: "存量订单按哪个口径？", options: ["旧口径", "新口径"] })).isError).toBe(false);
      expect(cards()).toHaveLength(1);
      // review-lead's ruling on a dispute that the owner should decide: the assistant first, too.
      const { ruleDispute } = await import("../src/agents/code-loop.ts");
      const disputed = addTask(app, r.id, { title: "退款要不要记日志", kind: "fix" }, "review-lead");
      updateTask(app, r.id, disputed.seq, { state: "disputed" });
      ruleDispute(app, r.id, disputed.seq, { decision: "owner", note: "需求没写", question: "退款要记审计日志吗？", options: ["记", "不记"] });
      expect(listTasks(app, r.id).find((x) => x.seq === disputed.seq)).toMatchObject({ state: "assistant", options: ["记", "不记"] });
      expect(cards()).toHaveLength(1);
      // The lead's reasons the assistant turned down show to the reviews.
      const { taskList } = await import("../src/agents/code-tasks.ts");
      expect(taskList(app, r.id)).toContain("助手驳回：只是写法偏好");
    } finally {
      await new Promise((resolve) => setTimeout(resolve, 100));
      app.db.close();
    }
  });

  it("gives a part the assistant set aside back to it when review-lead raises it again, and to the owner after the second time", async () => {
    const app = testApp();
    try {
      const t = createThread(app, { channel: "web", spaceId: "personal", userId: OWNER });
      const ask = createRun(app, { kind: "ask", spaceId: "personal", title: "交办", input: { conversationId: t.id } });
      const r = createRun(app, { kind: "code", spaceId: "personal", title: "退款", input: { task: "退款", repos: ["personal"], taskMode: true, round: 1 }, parentId: ask.id, userId: OWNER });
      codeChainFor(app, r);
      run(app.db, "update runs set status = 'done' where id = ?", r.id);
      setWorkState(app, r.id, { budget: 1, until: 1 });
      const raise = async (round: number, follows?: number) => {
        recordReview(app, { codeRunId: r.id, round, check: "reviewer", verdict: "changes_requested", summary: "", findings: [
          { severity: "major", title: `第 ${round} 次：并发退款要加锁`, detail: "", suggestion: "加锁", evidence: [], confidence: "high" },
        ] });
        const [f] = roundFindings(app, r.id, round);
        const { tasksFromRuling } = await import("../src/agents/code-tasks.ts");
        return tasksFromRuling(app, r.id, [f], { by: "host", ...(follows ? { follows: { [String(f.id)]: follows } } : {}) })[0];
      };
      {
        // First time: a plain fix, coded unless the assistant turns it down.
        const first = await raise(1);
        expect(first.state).toBe("todo");
        settleTask(app, r.id, first.seq, { action: "skip", text: "只有单人操作，碰不到并发", ownerWords: false }, "assistant");
        // Raised again on the same part: back to the assistant, not coded behind its back.
        const second = await raise(2, first.seq);
        expect(second.state).toBe("assistant");
        expect(second.question).toContain("你之前已经驳回或放下过这一处 1 次");
        settleTask(app, r.id, second.seq, { action: "later", text: "仍然碰不到", ownerWords: false }, "assistant");
        // A third time: the assistant has set it aside twice, so the owner decides.
        const third = await raise(3, second.seq);
        expect(third).toMatchObject({ state: "owner", options: ["照评审的意见改", "不改"] });
        expect(third.question).toContain("助手已经 2 次驳回或放下这一处");
      }
    } finally {
      app.db.close();
    }
  });

  it("at start closes cards of tasks no longer waiting on the owner and wakes the assistant for its own", async () => {
    const app = testApp();
    try {
      const t = createThread(app, { channel: "web", spaceId: "personal", userId: OWNER });
      const ask = createRun(app, { kind: "ask", spaceId: "personal", title: "交办", input: { conversationId: t.id } });
      const r = createRun(app, { kind: "code", spaceId: "personal", title: "退款", input: { task: "退款", repos: ["personal"], taskMode: true }, parentId: ask.id, userId: OWNER });
      codeChainFor(app, r);
      run(app.db, "update runs set status = 'done' where id = ?", r.id);
      const x = addTask(app, r.id, { title: "补审核时间", kind: "build", state: "owner", question: "缺后端字段", options: ["等", "不做"] }, "coder");
      const card = createAsk(app, { runId: r.id, conversationId: t.id, userId: OWNER, question: "补审核时间？", options: [{ label: "等" }], context: { handler: "code-task", workId: r.id, seq: x.seq } });
      setWorkState(app, r.id, { asks: { [String(x.seq)]: card.id } });
      // An upgrade moved it to the assistant (db migration).
      run(app.db, "update code_tasks set state = 'assistant' where work_id = ? and seq = ?", r.id, x.seq);
      expect(reconcileWaiting(app)).toEqual({ closed: 1, woken: 1, moved: 0 });
      expect(listAsks(app, {}).find((a) => a.id === card.id)!.status).toBe("cancelled");
      // Again: nothing left to close, and the turn already queued takes it.
      expect(reconcileWaiting(app)).toEqual({ closed: 0, woken: 0, moved: 0 });
      // Started on the web, no assistant: the owner gets it, with a card.
      const web = createRun(app, { kind: "code", spaceId: "personal", title: "网页交办", input: { task: "退款", repos: ["personal"], taskMode: true }, userId: OWNER });
      run(app.db, "update runs set status = 'done', output = json_set(coalesce(output, '{}'), '$.verdict', 'awaiting-assistant') where id = ?", web.id);
      const y = addTask(app, web.id, { title: "运费按比例退", kind: "build", state: "assistant", question: "改了 3 次没过" }, "coder");
      expect(reconcileWaiting(app)).toEqual({ closed: 0, woken: 0, moved: 1 });
      expect(listTasks(app, web.id)[0]).toMatchObject({ seq: y.seq, state: "owner", options: ["按原来的要求再做一次"] });
      expect(listAsks(app, { status: "pending" }).some((a) => a.question.includes("运费按比例退"))).toBe(true);
      expect(lastRound(app, web.id).output.verdict).toBe("awaiting-owner");
      // Pushed since: the card closes and the task no longer waits on anyone.
      setRunOutput(app, web.id, { appliedAt: new Date().toISOString() });
      expect(reconcileWaiting(app).closed).toBe(1);
      // Never decided: set aside for the next delegation on the branch, not dropped.
      expect(listTasks(app, web.id)[0]).toMatchObject({ state: "wontdo", origin: { later: true } });
      expect(listAsks(app, { status: "pending" }).some((a) => a.question.includes("运费按比例退"))).toBe(false);
    } finally {
      // The owner's card is shown after an import or two; let it land before the database closes.
      await new Promise((resolve) => setTimeout(resolve, 100));
      app.db.close();
    }
  });

  it("lets the assistant start rounds for what it settles only within the budget", () => {
    const app = testApp();
    try {
      const t = createThread(app, { channel: "web", spaceId: "personal", userId: OWNER });
      const ask = createRun(app, { kind: "ask", spaceId: "personal", title: "交办", input: { conversationId: t.id } });
      const r = createRun(app, { kind: "code", spaceId: "personal", title: "退款", input: { task: "退款", repos: ["personal"], taskMode: true, round: 1 }, parentId: ask.id, userId: OWNER });
      codeChainFor(app, r);
      run(app.db, "update runs set status = 'done' where id = ?", r.id);
      const x = addTask(app, r.id, { title: "运费按比例退", kind: "build" }, "coder");
      for (let i = 0; i < 3; i++) retryTask(app, r.id, x.seq, { by: "verify", kind: "verify", text: `第 ${i + 1} 次没过` });
      expect(listTasks(app, r.id)[0]).toMatchObject({ state: "assistant", attempts: 3 });
      // Budget used up (one round): the retry waits for the owner to say go on.
      setWorkState(app, r.id, { budget: 1, until: 1 });
      expect(settleTask(app, r.id, x.seq, { action: "retry", text: "先只改运费的计算", ownerWords: false }, "assistant")).toBeNull();
      expect(listTasks(app, r.id)[0].state).toBe("todo");
      expect(lastRound(app, r.id).id).toBe(r.id);
    } finally {
      app.db.close();
    }
  });

  it("keeps a coder that stops after one task going in the same session until the round's tasks are done", async () => {
    const app = testApp();
    app.config.agents.profiles.push({ id: "fake", name: "fake", transport: "acp", command: process.execPath, args: [resolve("test/fake-acp-agent.ts")], env: { FAKE_MODE: "tasks", FAKE_ONE_PER_TURN: "1" }, idleTimeoutMs: 60000 });
    app.config.agents.default = "fake";
    const dir = mkdtempSync(join(tmpdir(), "omem-loop-keep-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" } });
    git("init", "-q", "-b", "main");
    writeFileSync(join(dir, "refund.ts"), "export const refund = 0;\n");
    git("add", "-A");
    git("commit", "-q", "-m", "init");
    createSpace(app, { id: "shop-api", name: "订单服务", kind: "repo", rootPath: dir });
    const server = await startServer(app, { port: 0, quiet: true });
    try {
      const r1 = createRun(app, { kind: "code", spaceId: "shop-api", title: "退款金额", input: { task: "退款只按未发货的行计算", repos: ["shop-api"], taskMode: true, maxRounds: 1 }, userId: OWNER });
      for (const title of ["退款只算未发货的行", "运费按比例退", "补退款说明"]) addTask(app, r1.id, { title, kind: "build" }, "coder");
      await work(app, r1.id);
      // The three the round was given (the review may add its own after).
      expect(listTasks(app, r1.id).slice(0, 3).map((t) => [t.state, t.attempts])).toEqual([["done", 0], ["done", 0], ["done", 0]]);
      const said = all<{ data: string }>(app.db, "select data from run_events where run_id = ? and type = 'status'", r1.id).map((e) => JSON.parse(e.data).text as string);
      expect(said.filter((t) => t.includes("这一轮还有项没做"))).toHaveLength(2);
    } finally {
      await server.close();
      app.db.close();
    }
  }, 120_000);

  it("leaves a task a round did not get to as it was, and gives it to the assistant after three such rounds", () => {
    const app = testApp();
    try {
      const r = createRun(app, { kind: "code", spaceId: "personal", title: "退款", input: { task: "退款", repos: ["personal"], taskMode: true }, userId: OWNER });
      const t = addTask(app, r.id, { title: "运费按比例退", doneWhen: "部分退款时运费按金额比例退", kind: "build" }, "coder");
      for (const round of [1, 2, 3]) {
        updateTask(app, r.id, t.seq, { state: "coding", coderRun: r.id });
        settleCodingRound(app, r.id, r.id, [], round);
        expect(listTasks(app, r.id)[0]).toMatchObject({ state: round < 3 ? "todo" : "owner", attempts: 0 });
      }
      // Started on the web: no assistant, so the owner gets it, with something to answer.
      const stuck = listTasks(app, r.id)[0];
      expect(stuck.options).toEqual(["按原来的要求再做一次"]);
      expect(stuck.question).toContain("连续 3 轮");
      // What the owner (or the assistant) reads has the task in full, not a cut-off line.
      const text = ownerQuestionText(app, stuck);
      expect(text).toContain("完成标准：部分退款时运费按金额比例退");
      expect(text).toContain("第 3 轮编码 Agent 停下时还没做这一项");
      // A try that failed verification still counts.
      updateTask(app, r.id, t.seq, { state: "todo", origin: {} });
      for (let i = 0; i < 3; i++) retryTask(app, r.id, t.seq, { by: "verify", kind: "verify", text: `第 ${i + 1} 次：部分退款时运费还是全退` });
      const failed = listTasks(app, r.id)[0];
      expect(failed).toMatchObject({ state: "owner", attempts: 3 });
      expect(ownerQuestionText(app, failed)).toContain("第 3 次：部分退款时运费还是全退");
    } finally {
      app.db.close();
    }
  });

  it("gives the assistant's words on how to go on to the next round as instructions, and makes a task only of a new change", async () => {
    const app = testApp();
    try {
      const t = createThread(app, { channel: "web", spaceId: "personal", userId: OWNER });
      const ask = createRun(app, { kind: "ask", spaceId: "personal", title: "交办", input: { conversationId: t.id } });
      const r = createRun(app, { kind: "code", spaceId: "personal", title: "退款", input: { task: "退款只按未发货的行计算", repos: ["personal"], taskMode: true }, parentId: ask.id, userId: OWNER });
      codeChainFor(app, r);
      run(app.db, "update runs set status = 'done' where id = ?", r.id);
      setRunOutput(app, r.id, { coderSummary: "做完了 T1" });
      addTask(app, r.id, { title: "运费按比例退", kind: "build" }, "coder");
      const assistant: ToolContext = { app, runId: ask.id, spaceId: "personal", spaces: null, tools: null, actor: "agent", userId: OWNER } as ToolContext;
      const said = await callTool(assistant, "continue_code_run", { run_id: r.id, task: "接着推进，浏览器环境已经装好了" });
      expect(said.text).toContain("作为这一轮的交代");
      expect(listTasks(app, r.id)).toHaveLength(1);
      const next = lastRound(app, r.id);
      expect(next.id).not.toBe(r.id);
      expect(String(next.input.roundNotes)).toContain("浏览器环境已经装好了");
      // A new change of its own is a task.
      run(app.db, "update runs set status = 'done' where id = ?", next.id);
      expect((await callTool(assistant, "continue_code_run", { run_id: r.id, task: "退款单要显示退款原因", new_item: true })).text).toContain("已记成修改项");
      expect(listTasks(app, r.id).map((x) => x.title)).toContain("退款单要显示退款原因");
    } finally {
      app.db.close();
    }
  });

  it("keeps the AI the owner switched task-driven work to for the rounds after it", async () => {
    const app = testApp();
    try {
      app.config.agents.profiles.push({ id: "other", name: "other", transport: "acp", command: process.execPath, args: [], env: {}, idleTimeoutMs: 60000 });
      const t = createThread(app, { channel: "web", spaceId: "personal", userId: OWNER });
      const ask = createRun(app, { kind: "ask", spaceId: "personal", title: "交办", input: { conversationId: t.id } });
      const r = createRun(app, { kind: "code", spaceId: "personal", title: "退款", input: { task: "退款只按未发货的行计算", repos: ["personal"], taskMode: true }, parentId: ask.id, userId: OWNER });
      codeChainFor(app, r);
      run(app.db, "update runs set status = 'done' where id = ?", r.id);
      setRunOutput(app, r.id, { coderSummary: "做完了 T1" });
      addTask(app, r.id, { title: "运费按比例退", kind: "build" }, "coder");
      const assistant: ToolContext = { app, runId: ask.id, spaceId: "personal", spaces: null, tools: null, actor: "agent", userId: OWNER } as ToolContext;
      const execution = { profile: "other", source: "user", reason: "本人说原来的一直排队，换一个" };
      const said = await callTool(assistant, "continue_code_run", { run_id: r.id, task: "换个 AI 接着做", execution });
      expect(said.text).toContain("编码改用 other");
      const next = lastRound(app, r.id);
      expect(next.id).not.toBe(r.id);
      expect(next.input.execution).toMatchObject({ profile: "other" });
      // The round after it (a new item, no execution given) stays on it.
      run(app.db, "update runs set status = 'done' where id = ?", next.id);
      setRunOutput(app, next.id, { coderSummary: "做完了" });
      await callTool(assistant, "continue_code_run", { run_id: r.id, task: "退款单要显示退款原因", new_item: true });
      const third = lastRound(app, r.id);
      expect(third.id).not.toBe(next.id);
      expect(third.input.execution).toMatchObject({ profile: "other" });
    } finally {
      app.db.close();
    }
  });

  it("finds the item of earlier work on a branch for a new delegation there", async () => {
    const app = testApp();
    try {
      const r = createRun(app, { kind: "code", spaceId: "personal", title: "退款", input: { task: "退款", repos: ["personal"], itemId: "i_refund" }, userId: OWNER });
      setRunOutput(app, r.id, { appliedAt: new Date().toISOString(), worktrees: [{ space: "personal", path: join(tmpdir(), "gone"), branch: "feat/refund", base: "main", targetBranch: "feat/refund", commits: true }] });
      const { itemOnBranch } = await import("../src/agents/review-fix.ts");
      expect(itemOnBranch(app, ["personal"], "origin/feat/refund", OWNER)).toBe("i_refund");
      expect(itemOnBranch(app, ["personal"], "feat/other", OWNER)).toBeNull();
    } finally {
      app.db.close();
    }
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

  it("merges a finding that restates a task still open into that task, not a second one; a done task's problem back is a new task", async () => {
    const app = testApp();
    try {
      const r = createRun(app, { kind: "code", spaceId: "personal", title: "退款", input: { task: "退款只按未发货的行计算", repos: ["personal"], taskMode: true, round: 2 }, userId: OWNER });
      setRunOutput(app, r.id, { reviewPlan: { tier: "ai", tierName: "按改动定", checks: ["review-business"], maxRounds: 6, metrics: {}, reasons: [] } });
      recordReview(app, { codeRunId: r.id, round: 1, check: "review-business", verdict: "approved", summary: "", findings: [
        { severity: "minor", title: "存量订单保存时沿用旧模板", detail: "", suggestion: "请本人定口径", evidence: [], confidence: "high" },
        { severity: "major", title: "空订单会报错", detail: "", suggestion: "判空", evidence: [], confidence: "high" },
      ] });
      const { taskForFinding } = await import("../src/agents/code-tasks.ts");
      const [o1, o2] = roundFindings(app, r.id, 1);
      const owner = taskForFinding(app, r.id, o1, "review-lead", { question: "保存时用哪个模板？", options: ["沿用旧模板", "用当前模板"] });
      const done = updateTask(app, r.id, taskForFinding(app, r.id, o2, "review-lead").seq, { state: "done" });
      // The next stage: the check raises the owner's question again, and the empty order once more.
      recordReview(app, { codeRunId: r.id, round: 2, check: "review-business", verdict: "approved", summary: "", findings: [
        { severity: "minor", title: "【待本人决定·T1】存量订单保存时沿用旧模板", detail: "", suggestion: "", evidence: [], confidence: "high" },
        { severity: "major", title: "T2 没改好：空订单还会报错", detail: "", suggestion: "判空", evidence: [], confidence: "high" },
      ] });
      const [again, back] = roundFindings(app, r.id, 2);
      const ctx = { app, runId: r.id, spaceId: "personal", spaces: null, tools: null, actor: "agent", role: "review-lead" } as ToolContext;
      const rule = (rulings: unknown[]) => callTool(ctx, "rule_review", { rulings, verdict: "revise", summary: "合并重复的问题" });
      const refused = await rule([{ id: back.id, decision: "merge", task: `T${done.seq}` }]);
      expect(refused).toMatchObject({ isError: true });
      expect(refused.text).toContain("已完成");
      expect((await rule([{ id: again.id, decision: "merge", task: `T${owner.seq}` }, { id: back.id, decision: "accept", note: "T2 没改好" }])).isError).toBe(false);
      expect(listTasks(app, r.id).find((t) => t.seq === owner.seq)!.origin.findings).toEqual([o1.id, again.id]);
      expect(roundFindings(app, r.id, 2).find((f) => f.id === again.id)).toMatchObject({ state: "merged", merged_into: null, task_id: owner.id });
      // The review page shows which task a finding is on.
      const { reviewsOf } = await import("../src/agents/review.ts");
      expect(reviewsOf(app, [r.id]).flatMap((x) => x.findings).find((f) => f.id === again.id)).toMatchObject({ task_seq: owner.seq });
      // What checks and review-lead read lists the tasks so far.
      const { taskList } = await import("../src/agents/code-tasks.ts");
      expect(taskList(app, r.id)).toBe("- T1 [等你决定] 存量订单保存时沿用旧模板\n- T2 [已完成] 空订单会报错");
    } finally {
      app.db.close();
    }
  });

  it("sets aside what the current use never meets, and hands a part fixed over and over to the assistant", async () => {
    const app = testApp();
    try {
      const t = createThread(app, { channel: "web", spaceId: "personal", userId: OWNER });
      const ask = createRun(app, { kind: "ask", spaceId: "personal", title: "交办", input: { conversationId: t.id } });
      const r = createRun(app, { kind: "code", spaceId: "personal", title: "退款", input: { task: "退款只按未发货的行计算", repos: ["personal"], taskMode: true, round: 2 }, parentId: ask.id, userId: OWNER });
      codeChainFor(app, r);
      setRunOutput(app, r.id, { reviewPlan: { tier: "ai", tierName: "按改动定", checks: ["reviewer"], maxRounds: 6, metrics: {}, reasons: [] } });
      const t1 = addTask(app, r.id, { title: "退款按行计算", kind: "build", state: "done" }, "coder");
      const t2 = addTask(app, r.id, { title: "T1 没改好：空订单", kind: "fix", state: "done", origin: { follows: t1.seq } }, "review-lead");
      const t3 = addTask(app, r.id, { title: "T2 改出新问题：空行", kind: "fix", state: "done", origin: { follows: t2.seq } }, "review-lead");
      recordReview(app, { codeRunId: r.id, round: 2, check: "reviewer", verdict: "changes_requested", summary: "", findings: [
        { severity: "blocker", title: "两个客户端同时复用请求 ID 时会重复执行", detail: "", suggestion: "加在途表", evidence: [], confidence: "high" },
        { severity: "major", title: "T3 没改好：空行时金额为负", detail: "", suggestion: "判空", evidence: [], confidence: "high" },
        { severity: "minor", title: "金额舍入错了一分", detail: "", suggestion: "四舍五入到分", evidence: [], confidence: "high" },
      ] });
      const [race, again, cent] = roundFindings(app, r.id, 2);
      const ctx = { app, runId: r.id, spaceId: "personal", spaces: null, tools: null, actor: "agent", role: "review-lead" } as ToolContext;
      const rule = (rulings: unknown[]) => callTool(ctx, "rule_review", { rulings, verdict: "revise", summary: "只改需求要的" });
      expect((await rule([{ id: race.id, decision: "defer" }])).text).toContain("以后再做要写");
      expect((await rule([{ id: race.id, decision: "defer", note: "只有一个调用方，碰不到" }, { id: again.id, decision: "accept", follows: `T${t3.seq}` }, { id: cent.id, decision: "accept" }])).isError).toBe(false);
      const { tasksFromRuling, followDepth, isLater, taskList } = await import("../src/agents/code-tasks.ts");
      const made = tasksFromRuling(app, r.id, roundFindings(app, r.id, 2), { ...(getRun(app, r.id).output.reviewLeadDraft as object), by: "lead" } as never);
      const by = (f: { id: number }) => made.find((t) => t.origin.findings?.includes(f.id))!;
      // Real but out of today's use: set aside, in view, not to do.
      expect(isLater(by(race))).toBe(true);
      expect(by(race).answer).toBe("只有一个调用方，碰不到");
      // A fourth layer on the same spot: the assistant decides whether it is worth more rounds.
      expect(followDepth(app, r.id, by(again).seq)).toBe(3);
      expect(by(again)).toMatchObject({ state: "assistant", origin: { follows: t3.seq } });
      expect(by(again).question).toContain(`T${t1.seq} → T${t2.seq} → T${t3.seq} → T${by(again).seq}`);
      // What the use does meet is fixed, whatever its severity.
      expect(by(cent).state).toBe("todo");
      expect(taskList(app, r.id)).toContain(`[以后再做] 两个客户端同时复用请求 ID 时会重复执行`);
      expect(waitingText(app, r.id)).toContain("记成以后再做的（1 项");
      // The assistant may set a review fix aside too, never the requirement's own task on its own.
      expect(settleTask(app, r.id, by(cent).seq, { action: "later", text: "和需求无关", ownerWords: false }, "assistant")).toBeNull();
      expect(isLater(listTasks(app, r.id).find((t) => t.seq === by(cent).seq)!)).toBe(true);
      const own = addTask(app, r.id, { title: "退款单号", kind: "build" }, "coder");
      expect(() => settleTask(app, r.id, own.seq, { action: "later", text: "先不做", ownerWords: false }, "assistant")).toThrow("只有本人");
    } finally {
      app.db.close();
    }
  });

  it("refuses a finding or change point whose text cites a source that does not exist", async () => {
    const app = testApp();
    try {
      const r = createRun(app, { kind: "code", spaceId: "personal", title: "主页模板", input: { task: "切换模板", repos: ["personal"], taskMode: true, round: 1 }, userId: OWNER });
      setRunOutput(app, r.id, { reviewPlan: { tier: "ai", tierName: "按改动定", checks: ["review-business"], maxRounds: 6, metrics: {}, reasons: [] } });
      run(app.db, "insert into sources(id, space_id, kind, uri, title, text, hash, captured_at, updated_at) values('s0prdaaaabbbbccccdddd', 'personal', 'doc', 'prd', '应用模版 PRD', '', 'h', '2026-11-05', '2026-11-05')");
      const ctx = { app, runId: r.id, spaceId: "personal", spaces: null, tools: null, actor: "agent", role: "review-business" } as ToolContext;
      const finding = (detail: string) => ({ severity: "major", title: "往返切换后未提交内容被带回", detail, suggestion: "切换时丢弃草稿" });
      // Three characters dropped from the middle of the id, as a model did.
      const bad = await callTool(ctx, "submit_review", { verdict: "changes_requested", summary: "有问题", findings: [finding("PRD 要求未提交内容不保留 [PRD](src:s0prdaaaacccdddd#L156-L156)")] });
      expect(bad).toMatchObject({ isError: true });
      expect(bad.text).toContain("src:s0prdaaaacccdddd");
      expect((await callTool(ctx, "submit_review", { verdict: "changes_requested", summary: "有问题", findings: [finding("PRD 要求未提交内容不保留 [PRD](src:s0prdaaaabbbbccccdddd#L156-L156)")] })).isError).toBe(false);
      const point = await callTool(ctx, "submit_change_points", { change_points: [{ id: "C1", title: "切换模板", status: "partial", requirement: "见 [PRD](src:s0prdaaaacccdddd#L1)" }] });
      expect(point.text).toContain("src:s0prdaaaacccdddd");
    } finally {
      app.db.close();
    }
  });

  it("stops for the assistant when reviews only polish after the requirement is done, and lets the owner set the rest aside", async () => {
    const app = testApp();
    try {
      const r = createRun(app, { kind: "code", spaceId: "personal", title: "退款", input: { task: "退款只按未发货的行计算", repos: ["personal"], taskMode: true, round: 3 }, userId: OWNER });
      run(app.db, "update runs set status = 'done' where id = ?", r.id);
      addTask(app, r.id, { title: "退款按行计算", kind: "build", state: "done" }, "coder");
      addTask(app, r.id, { title: "并发复用请求 ID", kind: "fix" }, "review-lead");
      // Done at the second stage review; three more that each found something: it stops.
      setWorkState(app, r.id, { budget: 12, until: 12, stages: [0, 1, 2, 1, 3], deliverableAt: 1, stageAt: 0 });
      const rc = { runId: r.id, signal: new AbortController().signal, event: () => {} } as never;
      expect((await taskReview(app, r.id, rc)).verdict).toBe("paused");
      expect(workState(app, r.id)).toMatchObject({ paused: "polishing", polishAt: 4 });
      // The owner sets the rest aside (the card offered at the deliverable point): it comes to its usual confirm.
      const card = createAsk(app, { runId: r.id, userId: OWNER, question: "需求做完了", options: [{ label: "先推送验证" }, { label: "剩下的以后再做" }], context: { handler: "work-deliver", rootId: r.id } });
      await answerAsk(app, card.id, { choice: 1, by: OWNER });
      await new Promise((resolve) => setTimeout(resolve, 50));
      const { isLater } = await import("../src/agents/code-tasks.ts");
      expect(listTasks(app, r.id).filter(isLater).map((x) => x.title)).toEqual(["并发复用请求 ID"]);
      expect(workState(app, r.id).paused).toBeNull();
      expect(lastRound(app, r.id).output.verdict).toBe("approved");
      expect(listAsks(app, { status: "pending" }).some((a) => a.handler === "review-done")).toBe(true);
    } finally {
      await new Promise((resolve) => setTimeout(resolve, 100));
      app.db.close();
    }
  });

  it("counts reviews that only polish from when the requirement, as the owner left it, was done", async () => {
    const app = testApp();
    try {
      const r = createRun(app, { kind: "code", spaceId: "personal", title: "退款", input: { task: "退款只按未发货的行计算", repos: ["personal"], taskMode: true, round: 6 }, userId: OWNER });
      run(app.db, "update runs set status = 'done' where id = ?", r.id);
      addTask(app, r.id, { title: "退款按行计算", kind: "build", state: "done" }, "coder");
      addTask(app, r.id, { title: "并发复用请求 ID", kind: "fix" }, "review-lead");
      const { deliverableStage } = await import("../src/agents/code-tasks.ts");
      expect(deliverableStage(app, r.id, 1, false)).toBeNull();
      expect(deliverableStage(app, r.id, 1, true)).toBe(1);
      setWorkState(app, r.id, { deliverableAt: 1 });
      expect(deliverableStage(app, r.id, 4, false)).toBe(1);
      // The owner adds to the requirement: not deliverable again until that is done too.
      const more = addTask(app, r.id, { title: "退款单号", kind: "owner" }, OWNER);
      expect(deliverableStage(app, r.id, 5, true)).toBeNull();
      updateTask(app, r.id, more.seq, { state: "done" });
      setWorkState(app, r.id, { deliverableAt: null });
      expect(deliverableStage(app, r.id, 6, true)).toBe(6);
      // A polishing stop at stage 4, the requirement grown and done at 6: one review since, not four.
      setWorkState(app, r.id, { budget: 12, until: 12, stages: [0, 1, 2, 1, 3, 2, 1, 1], deliverableAt: 6, polishAt: 4, stageAt: 0 });
      const rc = { runId: r.id, signal: new AbortController().signal, event: () => {} } as never;
      await taskReview(app, r.id, rc);
      expect(workState(app, r.id).paused).not.toBe("polishing");
      expect(getRun(app, r.id).output.reviewStop).not.toBe("polishing");
    } finally {
      await new Promise((resolve) => setTimeout(resolve, 100));
      app.db.close();
    }
  });

  it("comes to its confirm when the assistant sets aside the last fixes of a paused delegation, and closes the push-first card", async () => {
    const app = testApp();
    try {
      const r = createRun(app, { kind: "code", spaceId: "personal", title: "退款", input: { task: "退款只按未发货的行计算", repos: ["personal"], taskMode: true, round: 3 }, userId: OWNER });
      run(app.db, "update runs set status = 'done' where id = ?", r.id);
      addTask(app, r.id, { title: "退款按行计算", kind: "build", state: "done" }, "coder");
      const fix = addTask(app, r.id, { title: "并发复用请求 ID", kind: "fix" }, "review-lead");
      const offered = createAsk(app, { runId: r.id, userId: OWNER, question: "需求做完了", options: [{ label: "剩下的以后再做" }], context: { handler: "work-deliver", rootId: r.id } });
      setWorkState(app, r.id, { budget: 12, until: 12, stages: [0, 1, 2, 1, 3], deliverableAt: 1, stageAt: 0, deliverAsk: offered.id });
      const rc = { runId: r.id, signal: new AbortController().signal, event: () => {} } as never;
      expect((await taskReview(app, r.id, rc)).verdict).toBe("paused");
      // The assistant judges the rest not worth this change: nothing is left to code, the pause does not hold the confirm back.
      expect(settleTask(app, r.id, fix.seq, { action: "later", text: "只有一个调用方，碰不到", ownerWords: false }, "assistant")).toBeNull();
      expect(workState(app, r.id).paused).toBeNull();
      expect(lastRound(app, r.id).output.verdict).toBe("approved");
      const asks = listAsks(app, {});
      expect(asks.find((a) => a.id === offered.id)?.status).toBe("cancelled");
      expect(asks.some((a) => a.handler === "review-done" && a.status === "pending")).toBe(true);
    } finally {
      await new Promise((resolve) => setTimeout(resolve, 100));
      app.db.close();
    }
  });

  it("takes back a deferral when review-lead rules the finding again", async () => {
    const app = testApp();
    try {
      const r = createRun(app, { kind: "code", spaceId: "personal", title: "退款", input: { task: "退款", repos: ["personal"], taskMode: true, round: 2 }, userId: OWNER });
      setRunOutput(app, r.id, { reviewPlan: { tier: "ai", tierName: "按改动定", checks: ["reviewer"], maxRounds: 6, metrics: {}, reasons: [] } });
      recordReview(app, { codeRunId: r.id, round: 2, check: "reviewer", verdict: "changes_requested", summary: "", findings: [
        { severity: "major", title: "空订单退款为负", detail: "", suggestion: "判空", evidence: [], confidence: "high" },
      ] });
      const [f] = roundFindings(app, r.id, 2);
      const ctx = { app, runId: r.id, spaceId: "personal", spaces: null, tools: null, actor: "agent", role: "review-lead" } as ToolContext;
      const rule = (decision: string, note: string) => callTool(ctx, "rule_review", { rulings: [{ id: f.id, decision, note }], verdict: "revise", summary: "改" });
      expect((await rule("defer", "以为碰不到")).isError).toBe(false);
      expect((await rule("accept", "订单列表里就有空订单")).isError).toBe(false);
      const { tasksFromRuling, isLater } = await import("../src/agents/code-tasks.ts");
      const [t] = tasksFromRuling(app, r.id, roundFindings(app, r.id, 2), { ...(getRun(app, r.id).output.reviewLeadDraft as object), by: "lead" } as never);
      expect(isLater(t)).toBe(false);
      expect(t.state).toBe("todo");
    } finally {
      app.db.close();
    }
  });

  it("reports to the conversation the owner last steered the delegation from, not the one it was asked in", async () => {
    const app = testApp();
    try {
      const first = createThread(app, { channel: "web", spaceId: "personal", userId: OWNER });
      const later = createThread(app, { channel: "web", spaceId: "personal", userId: OWNER });
      const ask = createRun(app, { kind: "ask", spaceId: "personal", title: "交办", input: { conversationId: first.id } });
      const r = createRun(app, { kind: "code", spaceId: "personal", title: "退款", input: { task: "退款", repos: ["personal"], taskMode: true, round: 1 }, parentId: ask.id, userId: OWNER });
      codeChainFor(app, r);
      run(app.db, "update runs set status = 'running' where id = ?", r.id);
      // A turn the owner did not speak in (a handoff queued in the first topic) moves nothing.
      const handoff0 = createRun(app, { kind: "ask", spaceId: "personal", title: "交给助手", input: { conversationId: later.id, handoff: { kind: "code", runId: r.id } }, userId: OWNER });
      const quiet = { app, runId: handoff0.id, spaceId: "personal", spaces: null, tools: null, actor: "agent", userId: OWNER } as ToolContext;
      expect((await callTool(quiet, "message_code_run", { run_id: r.id, text: "提醒一下" })).text).not.toContain("之后这次交办的结果");
      // The owner, in a later topic, adds to the delegation.
      run(app.db, "insert into messages(id,conversation_id,role,text,meta,created_at) values('m_owner_later', ?, 'user', '金额字段改成分', '{}', ?)", later.id, new Date().toISOString());
      const turn = createRun(app, { kind: "ask", spaceId: "personal", title: "补充", input: { conversationId: later.id, messageIds: ["m_owner_later"] }, userId: OWNER });
      const ctx = { app, runId: turn.id, spaceId: "personal", spaces: null, tools: null, actor: "agent", userId: OWNER } as ToolContext;
      const res = await callTool(ctx, "message_code_run", { run_id: r.id, text: "金额字段改成分" });
      expect(res.text).toContain("之后这次交办的结果");
      // Said again from there: no second note.
      expect((await callTool(ctx, "message_code_run", { run_id: r.id, text: "再补一句" })).text).not.toContain("之后这次交办的结果");
      // A handoff run still queued in the first topic does not take the reports back there.
      const stale = createRun(app, { kind: "ask", spaceId: "personal", title: "交给助手", input: { conversationId: first.id, handoff: { kind: "code", runId: r.id } }, userId: OWNER });
      await callTool({ ...ctx, runId: stale.id } as ToolContext, "message_code_run", { run_id: r.id, text: "按原需求" });
      // A question for the owner, the round's result and the assistant's turn all go to the later topic.
      const q = addTask(app, r.id, { title: "保存时用哪个模板", kind: "fix", state: "assistant", question: "评审负责人没有裁决" }, "review-lead");
      settleTask(app, r.id, q.seq, { action: "owner", text: "是业务口径", ownerWords: false, question: "用哪个模板？", options: ["旧模板", "新模板"] }, "assistant");
      setRunOutput(app, r.id, { verdict: "awaiting-owner", reviewStop: "owner" });
      run(app.db, "update runs set status = 'done' where id = ?", r.id);
      trySettleCodeChain(app, r.id);
      const card = listAsks(app, { status: "pending" }).find((a) => a.handler === "code-task")!;
      expect(card.conversationId).toBe(later.id);
      const result = all<{ conversation_id: string }>(app.db, "select conversation_id from messages where run_id = ? and json_extract(meta, '$.codeResult') is not null", r.id);
      expect(result.map((m) => m.conversation_id)).toEqual([later.id]);
      const handoff = all<{ input: string }>(app.db, "select input from runs where kind = 'ask' and json_extract(input, '$.handoff.workId') = ?", r.id).map((x) => JSON.parse(x.input).conversationId);
      expect(handoff).toEqual([later.id]);
    } finally {
      await new Promise((resolve) => setTimeout(resolve, 100));
      app.db.close();
    }
  });

  it("carries what a confirmed delegation left into the next one on its branch, once", async () => {
    const app = testApp();
    try {
      const old = createRun(app, { kind: "code", spaceId: "personal", title: "退款", input: { task: "退款", repos: ["personal"], taskMode: true }, userId: OWNER });
      addTask(app, old.id, { title: "退款按行计算", kind: "build", state: "done" }, "coder");
      const open = addTask(app, old.id, { title: "金额舍入错了一分", kind: "fix", doneWhen: "四舍五入到分" }, "review-lead");
      const { carryTasks, deferTask, isLater } = await import("../src/agents/code-tasks.ts");
      deferTask(app, old.id, addTask(app, old.id, { title: "并发复用请求 ID", kind: "fix" }, "review-lead").seq, "只有一个调用方", { by: "review-lead", kind: "lead", text: "以后再做" });
      const next = createRun(app, { kind: "code", spaceId: "personal", title: "接着改", input: { task: "加退款单号", repos: ["personal"], taskMode: true }, userId: OWNER });
      const c = carryTasks(app, next.id, [old.id]);
      expect(c.todo.map((x) => [x.title, x.state])).toEqual([["金额舍入错了一分", "todo"]]);
      expect(c.todo[0].doneWhen).toContain("四舍五入到分");
      expect(c.todo[0].origin.carried).toEqual({ work: old.id, seq: open.seq });
      expect(c.later.map((x) => [x.title, isLater(x), x.answer])).toEqual([["并发复用请求 ID", true, "只有一个调用方"]]);
      expect(listTasks(app, old.id).find((x) => x.seq === open.seq)!.notes.at(-1)!.text).toBe(`接到交办 ${next.id} 的 T${c.todo[0].seq}`);
      // A third delegation does not take them again.
      const third = createRun(app, { kind: "code", spaceId: "personal", title: "再改", input: { task: "x", repos: ["personal"], taskMode: true }, userId: OWNER });
      expect(carryTasks(app, third.id, [old.id])).toEqual({ todo: [], later: [] });
      // One that waited on the owner there: delegated by the assistant, it goes to the assistant first, and the old card lapses.
      const { setWorkState } = await import("../src/agents/code-tasks.ts");
      const { createAsk, getAsk } = await import("../src/agents/asks.ts");
      const asked = addTask(app, third.id, { title: "证据挂回事项", kind: "build", state: "owner", question: "编码 Agent 没有 write_file", options: ["补开"] }, "coder");
      const card = createAsk(app, { runId: third.id, conversationId: null, question: "要补开吗", options: [{ label: "补开" }] });
      setWorkState(app, third.id, { asks: { [String(asked.seq)]: card.id } });
      const fourth = createRun(app, { kind: "code", spaceId: "personal", title: "第四次", input: { task: "y", repos: ["personal"], taskMode: true }, userId: OWNER });
      const moved = carryTasks(app, fourth.id, [third.id], { viaAssistant: true }).todo;
      expect(moved.map((x) => [x.title, x.state])).toEqual([["证据挂回事项", "assistant"]]);
      expect(moved[0].question).toContain("没有 write_file");
      expect(getAsk(app, card.id)).toMatchObject({ status: "cancelled", lapsed: expect.stringContaining(fourth.id) });
    } finally {
      await new Promise((resolve) => setTimeout(resolve, 100));
      app.db.close();
    }
  });

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
      // review-lead's question for the owner waits on the assistant first.
      expect(two.verdict).toBe("awaiting-assistant");
      const task = (seq: number) => listTasks(app, r1.id).find((x) => x.seq === seq)!;
      expect(task(fix.seq)).toMatchObject({ state: "done", attempts: 1, coderRun: r2 });
      expect(task(fix.seq).commits["shop-api"]).toHaveLength(2);
      expect(task(fix.seq).notes.map((n) => n.text)).toEqual(expect.arrayContaining([expect.stringContaining("没改好"), "验证没过，交回这一轮接着改", "验证通过"]));
      const added = listTasks(app, r1.id).find((x) => x.title === "退款要按支付渠道分开算")!;
      expect(added).toMatchObject({ state: "done", verifier: "review-business@复看", coderRun: r2 });
      expect(added.notes.map((n) => n.text)).toContain("复看新发现，交给正在编码的这一轮");
      // Nothing else needed a round of its own: the question for the owner (with the assistant first) is all that is left.
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
      setRunOutput(app, old.id, { worktrees: [{ space: "shop-api", path: dir, branch: "main", targetBranch: "main", base, start: base, commits: true }], verdict: "changes-requested" });
      run(app.db, "update runs set status = 'done' where id = ?", old.id);
      // Asked from a review of the branch it works on: the fix is that delegation's, and it turns too.
      const review = createRun(app, { kind: "code", spaceId: "shop-api", title: "退款分支评审", input: { branches: { "shop-api": { branch: "main" } }, repos: ["shop-api"] } });
      run(app.db, "update runs set status = 'done' where id = ?", review.id);
      const { startFix } = await import("../src/agents/review-fix.ts");
      const next = await startFix(app, review.id, { findingIds: [], text: "看一下 SDK 不支持的字段旧数据会不会保留", review: { checks: ["review-arch"] } }, OWNER);
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

  it("starts a new delegation on the branch a confirmed one landed on, from origin's latest, when asked to change it further", async () => {
    const app = testApp();
    const dir = mkdtempSync(join(tmpdir(), "omem-after-confirm-"));
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: dir, encoding: "utf8" }).trim();
    git("init", "-q", "-b", "main");
    writeFileSync(join(dir, "refund.ts"), "export const refund = 0;\n");
    git("add", "-A");
    git("commit", "-q", "-m", "init");
    git("branch", "feature/refund");
    const base = git("rev-parse", "HEAD");
    createSpace(app, { id: "shop-api", name: "订单服务", kind: "repo", rootPath: dir });
    try {
      const done = createRun(app, { kind: "code", spaceId: "shop-api", title: "退款", input: { task: "退款只按未发货的行计算", repos: ["shop-api"], fromBranches: { "shop-api": "feature/refund" }, taskMode: true } });
      setRunOutput(app, done.id, { worktrees: [{ space: "shop-api", path: join(dir, "gone"), branch: "feature/refund", targetBranch: "feature/refund", base, start: base, commits: true }], appliedAt: new Date().toISOString() });
      run(app.db, "update runs set status = 'done' where id = ?", done.id);
      const { startFix } = await import("../src/agents/review-fix.ts");
      const next = await startFix(app, done.id, { findingIds: [], text: "金额字段改成分" }, OWNER);
      expect(next.id).not.toBe(done.id);
      expect(next.title).toBe("接着改：退款");
      expect(next.input).toMatchObject({ repos: ["shop-api"], fromBranches: { "shop-api": "feature/refund" }, sync: { pull: true }, fromReview: done.id, taskMode: true });
      expect(next.input.continueFrom).toBeUndefined();
      expect(listTasks(app, next.id).map((t) => t.title)).toEqual(["金额字段改成分"]);
      // Asked again before the new one finishes: it goes on there, not in a third delegation.
      setRunOutput(app, next.id, { worktrees: [{ space: "shop-api", path: dir, branch: "feature/refund", targetBranch: "feature/refund", base, start: base, commits: true }] });
      run(app.db, "update runs set status = 'done' where id = ?", next.id);
      const again = await startFix(app, done.id, { findingIds: [], text: "再加个注释" }, OWNER);
      expect(again.input.continueFrom ?? again.id).toBe(next.id);
    } finally {
      app.db.close();
    }
  });
});
