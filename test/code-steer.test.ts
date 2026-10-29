import { afterEach, describe, expect, it } from "vitest";
import { codeChainFor, queueNextCodeRound } from "../src/agents/code-chain.ts";
import { addCodeNote, setRoundReview, stopCodeWork, takeCodeSteering } from "../src/agents/code-steer.ts";
import { startFix } from "../src/agents/review-fix.ts";
import { createRun, getRun, setRunOutput } from "../src/agents/runs.ts";
import { createThread } from "../src/agents/threads.ts";
import { all, run } from "../src/core/db.ts";
import { testApp } from "./helpers.ts";

const apps: ReturnType<typeof testApp>[] = [];
afterEach(() => {
  for (const a of apps.splice(0)) a.db.close();
});

/** A delegation in a conversation, its first round running in a worktree that lands on feature/a. */
function delegation(status = "running") {
  const app = testApp();
  apps.push(app);
  const thread = createThread(app, { spaceId: "personal", channel: "web", userId: "owner" });
  const ask = createRun(app, { kind: "ask", spaceId: "personal", title: "改退款", input: { conversationId: thread.id }, lane: thread.id });
  const code = createRun(app, { kind: "code", spaceId: "personal", title: "退款只按未发货行", input: { task: "退款只按未发货的行计算", repos: ["personal"] }, parentId: ask.id });
  run(app.db, "update runs set status=? where id=?", status, code.id);
  setRunOutput(app, code.id, { worktrees: [{ space: "personal", path: app.home, branch: `omem/${code.id}`, base: "abc", start: "abc", targetBranch: "feature/a" }] });
  codeChainFor(app, getRun(app, code.id));
  return { app, ask, code };
}

function finding(app: ReturnType<typeof testApp>, codeRunId: string, severity: string, title: string) {
  const reviewId = `rv_${codeRunId}_${severity}`;
  run(app.db, "insert or ignore into reviews(id, code_run_id, round, check_name, verdict, summary, created_at) values(?,?,?,?,?,?,?)", reviewId, codeRunId, 1, "reviewer", "changes_requested", "", new Date().toISOString());
  return Number(run(app.db, "insert into review_findings(review_id, severity, title) values(?,?,?)", reviewId, severity, title).lastInsertRowid);
}

describe("steering a delegation while it runs", () => {
  it("a note reaches the coder at its next omem tool call; after the coding it goes with the next round", () => {
    const { app, ask, code } = delegation();
    expect(addCodeNote(app, ask.id, "空态要等分页全部拉完再显示", "owner")).toMatchObject({ runId: code.id, stage: "coding" });
    const text = takeCodeSteering(app, code.id);
    expect(text).toContain("空态要等分页全部拉完再显示");
    expect(takeCodeSteering(app, code.id)).toBeNull();
    // Coding done, the review runs: the note waits for the next round's task.
    setRunOutput(app, code.id, { coderSummary: "改完了" });
    expect(addCodeNote(app, code.id, "删除弹窗文案不要改", "owner").stage).toBe("review");
    expect(takeCodeSteering(app, code.id)).toBeNull();
    run(app.db, "update runs set status='done' where id=?", code.id);
    const chain = getRun(app, ask.id).output.codeChain as Parameters<typeof queueNextCodeRound>[1];
    const next = queueNextCodeRound(app, chain, "按评审修改", { manual: true })!;
    expect(String(next.run.input.task)).toMatch(/按评审修改[\s\S]*本人在你工作期间补充的要求[\s\S]*删除弹窗文案不要改/);
    expect(String(next.run.input.task)).not.toContain("空态要等分页");
  });

  it("the review the owner sets holds for the round still coding and the rounds after it; a stop ends the chain", () => {
    const { app, ask, code } = delegation();
    expect(setRoundReview(app, code.id, { tier: "light", split: false })).toMatchObject({ runId: code.id, current: true });
    expect(getRun(app, code.id).input.roundReview).toEqual({ tier: "light", split: false });
    run(app.db, "update runs set status='done' where id=?", code.id);
    const chain = getRun(app, ask.id).output.codeChain as Parameters<typeof queueNextCodeRound>[1];
    const next = queueNextCodeRound(app, chain, "再改一处", { manual: true })!;
    expect(next.run.input.roundReview).toEqual({ tier: "light", split: false });
    expect(stopCodeWork(app, ask.id, "先停").stopped).toEqual([next.run.id]);
    expect(getRun(app, next.run.id).status).toBe("cancelled");
    expect((getRun(app, ask.id).output.codeChain as { waitReason?: string; awaitingUser: boolean })).toMatchObject({ awaitingUser: true, waitReason: "stopped" });
  });
});

describe("one delegation per branch", () => {
  it("fixing a branch review continues the open delegation on that branch; unpicked findings wait as “暂不改”", async () => {
    const { app, code } = delegation("done");
    setRunOutput(app, code.id, { coderSessionId: "coder-1" });
    const review = createRun(app, { kind: "code", spaceId: "personal", title: "评审 feature/a", input: { branches: { personal: { branch: "origin/feature/a" } }, repos: ["personal"] } });
    run(app.db, "update runs set status='done' where id=?", review.id);
    const major = finding(app, review.id, "major", "已发货行不能退");
    const minor = finding(app, review.id, "minor", "可以补一条测试");
    const nit = finding(app, review.id, "nit", "命名可以更具体");
    const next = await startFix(app, review.id, { findingIds: [major], review: { tier: "light", split: false } }, "owner");
    expect(next.input).toMatchObject({ continueFrom: code.id, resumeSessionId: "coder-1", fromReview: review.id, roundReview: { tier: "light", split: false }, round: 2 });
    const decisions = Object.fromEntries(all<{ id: number; decision: string | null }>(app.db, "select id, decision from review_findings").map((f) => [f.id, f.decision]));
    expect(decisions).toEqual({ [major]: "fix", [minor]: "later", [nit]: null });
    // While that round works, another fix on the branch waits for it instead of opening a second worktree.
    run(app.db, "update runs set status='running' where id=?", next.id);
    await expect(startFix(app, review.id, { findingIds: [], text: "再改一处" }, "owner")).rejects.toThrow(/正在改同一个分支/);
  });
});

describe("fixing chosen findings", () => {
  it("re-reviews only the checks that raised them, all of them every few rounds or with the owner's own words", async () => {
    const { app, code } = delegation("done");
    setRunOutput(app, code.id, { coderSessionId: "coder-1" });
    app.config.review.rereviewAllEvery = 3;
    const arch = finding(app, code.id, "major", "接口两边对不上");
    run(app.db, "update reviews set check_name = 'review-arch' where id = (select review_id from review_findings where id = ?)", arch);
    const next = await startFix(app, code.id, { findingIds: [arch] }, "owner");
    expect(next.input).toMatchObject({ round: 2, reviewOnly: ["review-arch"] });
    run(app.db, "update runs set status='done' where id=?", next.id);
    // Round 3 of every 3: everything again.
    const third = await startFix(app, next.id, { findingIds: [arch] }, "owner");
    expect(third.input.reviewOnly).toBeUndefined();
    run(app.db, "update runs set status='done' where id=?", third.id);
    const fourth = await startFix(app, third.id, { findingIds: [arch], text: "顺便把空态也改了" }, "owner");
    expect(fourth.input.reviewOnly).toBeUndefined();
  });
});

describe("another model each review round", () => {
  it("keeps each check's own model in round 1, then walks the rotation, offset per check", async () => {
    const app = testApp();
    apps.push(app);
    const { rotatedExecution, validateReviewSettings, defaultReviewSettings } = await import("../src/agents/review.ts");
    app.config.review.rotation = [{ profile: "codex", model: "m-a" }, { profile: "claude", model: "m-b" }, { profile: "codex", model: "m-c" }];
    expect(rotatedExecution(app, 1, 0, true)).toBeNull();
    expect(rotatedExecution(app, 2, 1, false)).toBeNull();
    expect([0, 1, 2].map((i) => rotatedExecution(app, 2, i, true)?.model)).toEqual(["m-a", "m-b", "m-c"]);
    expect([0, 1, 2].map((i) => rotatedExecution(app, 3, i, true)?.model)).toEqual(["m-b", "m-c", "m-a"]);
    const s = validateReviewSettings(app, { ...defaultReviewSettings(), rotation: app.config.review.rotation });
    expect(s.rotation).toHaveLength(3);
    expect(s.tiers.every((t) => t.rotateModels === false)).toBe(true);
  });
});
