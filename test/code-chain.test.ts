import { afterEach, describe, expect, it } from "vitest";
import { codeChainFor, codeChainRounds, queueNextCodeRound, maxCodeRounds } from "../src/agents/code-chain.ts";
import { createThread } from "../src/agents/threads.ts";
import { createRun, getRun, runUser, setRunOutput } from "../src/agents/runs.ts";
import { createUser } from "../src/core/users.ts";
import { requestSplit } from "../src/agents/review-chain.ts";
import { run } from "../src/core/db.ts";
import { callTool } from "../src/agents/tools.ts";
import { settleCodeChain } from "../src/channels/lark-code-progress.ts";
import { testApp } from "./helpers.ts";

const apps: ReturnType<typeof testApp>[] = [];
afterEach(() => {
  for (const a of apps.splice(0)) a.db.close();
});

function fixture() {
  const app = testApp();
  apps.push(app);
  const thread = createThread(app, { spaceId: "personal", channel: "lark", key: "oc_chat#topic", userId: "owner" });
  const ask = createRun(app, { kind: "ask", spaceId: "personal", title: "修个 bug", input: { conversationId: thread.id }, lane: thread.id });
  const code = createRun(app, { kind: "code", spaceId: "personal", title: "交办", input: { task: "修", repos: ["personal"] }, parentId: ask.id });
  run(app.db, "update runs set status='running' where id=?", code.id);
  return { app, thread, ask, code };
}

describe("delegated coding chains", () => {
  it("builds the first round from the parent ask and remembers the lark topic", () => {
    const { app, ask, code } = fixture();
    const chain = codeChainFor(app, getRun(app, code.id))!;
    expect(chain).toMatchObject({ askRunId: ask.id, round: 1, rounds: [code.id], larkKey: "oc_chat#topic" });
    // Saved on both runs; the ask run is what later rounds and tools look up.
    expect(codeChainRounds(app, ask.id).map((r) => r.id)).toEqual([code.id]);
  });

  it("queues the next round on the same ask with the reviewer's request and the coder session", () => {
    const { app, code } = fixture();
    let chain = codeChainFor(app, getRun(app, code.id))!;
    setRunOutput(app, code.id, { worktrees: [{ space: "r1", path: "/tmp/wt", branch: "b", base: "h" }], coderSessionId: "sess-1" });
    const next = queueNextCodeRound(app, chain, "评审：这里要改", { resumeSessionId: "sess-1" })!;
    expect(next.chain.round).toBe(2);
    const r = getRun(app, next.run.id);
    expect(r.parentId).toBe(chain.askRunId);
    expect(r.input).toMatchObject({ continueFrom: code.id, resumeSessionId: "sess-1", repos: ["personal"] });
    expect(r.input.task).toContain("评审：这里要改");
    expect(codeChainRounds(app, chain.askRunId).map((x) => x.id)).toEqual([code.id, r.id]);
  });

  it("keeps the delegation initiator on historical children, manual rounds and resplits", async () => {
    const { app, code } = fixture();
    const member = createUser(app, { name: "成员 A", id: "member-a" }).id;
    run(app.db, "update runs set user_id=?,status='done' where id=?", member, code.id);
    const review = createRun(app, { kind: "review", title: "评审", parentId: code.id });
    run(app.db, "update runs set user_id=null where id=?", review.id);
    expect(runUser(app, review.id)).toBe(member);
    const chain = codeChainFor(app, code)!;
    const next = queueNextCodeRound(app, chain, "继续", { manual: true })!.run;
    expect(runUser(app, next.id)).toBe(member);
    // On old rounds the parent is the coordinating ask, while continueFrom identifies the delegation.
    run(app.db, "update runs set user_id=null where id=?", next.id);
    expect(runUser(app, next.id)).toBe(member);
    setRunOutput(app, next.id, { reviewPlan: {} });
    const split = await requestSplit(app, next.id, { userId: "owner" });
    expect(runUser(app, split.id)).toBe(member);
  });

  it("stops queuing automatic rounds after the limit, and never while waiting for the owner", () => {
    const { app, code } = fixture();
    // The limit is a setting (agents.autoAdvance.codeRounds).
    app.config.agents.autoAdvance = { ...app.config.agents.autoAdvance, codeRounds: 4 };
    const MAX_AUTO_ROUNDS = maxCodeRounds(app);
    let chain = codeChainFor(app, getRun(app, code.id))!;
    setRunOutput(app, code.id, { coderSessionId: "s" });
    let prev = code.id;
    // Round 1 exists; rounds up to the limit are queued automatically, the next attempt stops.
    for (let i = 2; i <= MAX_AUTO_ROUNDS + 1; i++) {
      const next = queueNextCodeRound(app, chain, `第 ${i} 轮意见`, { resumeSessionId: "s" });
      if (i <= MAX_AUTO_ROUNDS) expect(next).not.toBeNull();
      else expect(next).toBeNull();
      if (next) {
        chain = next.chain;
        prev = next.run.id;
        setRunOutput(app, prev, { coderSessionId: "s" });
        run(app.db, "update runs set status='done' where id=?", prev);
      }
    }
    expect(chain.round).toBe(MAX_AUTO_ROUNDS);
    expect(queueNextCodeRound(app, { ...chain, awaitingUser: true }, "x")).toBeNull();
  });
  it("continues round four through the tool and hands the concurrent request to the same round", async () => {
    const { app, code, ask } = fixture();
    let chain = codeChainFor(app, getRun(app, code.id))!;
    for (let round = 2; round <= 3; round++) {
      chain = queueNextCodeRound(app, chain, "修改", { resumeSessionId: "coder-session" })!.chain;
      setRunOutput(app, chain.lastCodeRunId!, { coderSessionId: "coder-session", verdict: "changes-requested", review: "两处待修复" });
      run(app.db, "update runs set status='done' where id=?", chain.lastCodeRunId!);
    }
    settleCodeChain(app, chain.lastCodeRunId!);
    expect(getRun(app, ask.id).output.codeChain).toMatchObject({ awaitingUser: true, waitReason: "auto-limit" });
    const ctx = { app, runId: null, spaceId: "personal", spaces: null, tools: null, actor: "agent" as const };
    const results = await Promise.all(["修复评审的问题", "补充退款验证"].map(task => callTool(ctx, "continue_code_run", { run_id: chain.lastCodeRunId, task })));
    expect(results.every(result => !result.isError)).toBe(true);
    expect(results.filter(result => result.text.includes("已交给第 4 轮"))).toHaveLength(1);
    const latest = getRun(app, (getRun(app, ask.id).output.codeChain as typeof chain).lastCodeRunId!);
    expect(latest.input).toMatchObject({ round: 4, continueFrom: code.id, resumeSessionId: "coder-session" });
    expect(getRun(app, ask.id).output.codeChain).toMatchObject({ awaitingUser: false, round: 4 });
    expect(latest.output.notes).toMatchObject([{ acceptedInRound: true }]);
    expect([latest.input.task, ...(latest.output.notes as { text: string }[]).map(note => note.text)]).toEqual(expect.arrayContaining(["修复评审的问题", "补充退款验证"]));
    run(app.db, "update runs set status='running' where id=?", latest.id);
    setRunOutput(app, latest.id, { coderSummary: "已交评审" });
    // In review the request is no longer refused: it is recorded for the next coding turn, no extra round is queued.
    const inReview = await callTool(ctx, "continue_code_run", { run_id: latest.id, task: "再补一项" });
    expect(inReview).toMatchObject({ isError: false, text: expect.stringContaining("在评审中") });
    expect((getRun(app, latest.id).output.notes as { text: string }[]).map(note => note.text)).toContain("再补一项");
    expect(queueNextCodeRound(app, chain, "自动再试")).toBeNull();
  });

});
