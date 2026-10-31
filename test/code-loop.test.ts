import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import "../src/agents/jobs.ts";
import { answerAsk, listAsks } from "../src/agents/asks.ts";
import { codeChainFor, trySettleCodeChain } from "../src/agents/code-chain.ts";
import { worktreesOf } from "../src/agents/code.ts";
import { lastRound, listCheckpoints, listTasks, workPatches, workState } from "../src/agents/code-tasks.ts";
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

      // Round 2: the fix of T3 is verified by the business check, which finds it broke something.
      const two = await work(app, one.continuedRunId!);
      expect(two.verdict).toBe("continuing");
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
});
