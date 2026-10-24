import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import "../src/agents/jobs.ts";
import { answerAsk, getAsk, listAsks } from "../src/agents/asks.ts";
import { codeChainFor, trySettleCodeChain, type CodeChain } from "../src/agents/code-chain.ts";
import { recordReview, roundFindings, stopReason, applyRulings, type LeadResult } from "../src/agents/review.ts";
import { __testHandlers, addRunEvent, createRun, getRun, listRuns, setRunOutput } from "../src/agents/runs.ts";
import { createThread } from "../src/agents/threads.ts";
import { run } from "../src/core/db.ts";
import { createSpace } from "../src/core/spaces.ts";
import { startServer } from "../src/server/http.ts";
import { snapshot } from "../src/channels/lark-code-progress.ts";
import { testApp } from "./helpers.ts";

/** Run a queued run's handler the way the worker does, and mark it finished. */
async function work(app: ReturnType<typeof testApp>, id: string, texts: Record<string, string> = {}) {
  run(app.db, "update runs set status = 'running' where id = ?", id);
  const r = getRun(app, id);
  const out = await __testHandlers.get(r.kind)!({
    app, run: r, signal: new AbortController().signal,
    event: (type, data) => { addRunEvent(app, id, type, data); const d = data as { phase?: string; text?: string }; if (type === "text" && d.phase) texts[d.phase] = (texts[d.phase] ?? "") + d.text; },
    output: (data) => setRunOutput(app, id, data),
  }) as Record<string, unknown>;
  setRunOutput(app, id, out ?? {});
  run(app.db, "update runs set status = 'done' where id = ?", id);
  trySettleCodeChain(app, r.kind === "review" ? String(r.input.codeRunId) : id);
  return out;
}

describe("review-lead", () => {
  it("stops on a stalemate: the same blocking problem reported in three rounds in a row", () => {
    const app = testApp();
    const ids = [1, 2, 3].map((round) => {
      const r = createRun(app, { kind: "code", spaceId: "personal", title: "改", input: { task: "改", round } });
      recordReview(app, { codeRunId: r.id, round, check: "reviewer", verdict: "changes_requested", summary: "要改", findings: [
        { severity: "major", file: "a.ts", line: round, title: "金额 没有 四舍五入。", detail: "", suggestion: "", evidence: [], confidence: "high" },
        ...(round === 1 ? [{ severity: "major" as const, file: "b.ts", title: "另一个问题", detail: "", suggestion: "", evidence: [], confidence: "high" as const }] : []),
      ] });
      applyRulings(app, r.id, round, roundFindings(app, r.id, round).map((f) => ({ id: f.id, decision: "accept" as const })));
      return { runId: r.id, round };
    });
    expect(stopReason(app, ids.slice(0, 2), 5, "revise")).toBeNull();
    expect(stopReason(app, ids, 5, "revise")).toBe("stalemate");
    expect(stopReason(app, ids, 3, "revise")).toBe("auto-limit");
    expect(stopReason(app, ids.slice(0, 1), 5, "escalate")).toBe("escalated");
    app.db.close();
  });

  it("confirms the plan, rules on findings, re-reviews only what is affected and escalates when fixes do not converge", async () => {
    const app = testApp();
    app.config.agents.profiles.push({ id: "fake", name: "fake", transport: "acp", command: process.execPath, args: [resolve("test/fake-acp-agent.ts")], env: { FAKE_MODE: "review" }, idleTimeoutMs: 60000 });
    app.config.agents.default = "fake";
    const dir = mkdtempSync(join(tmpdir(), "omem-lead-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" } });
    git("init", "-q");
    writeFileSync(join(dir, "refund.ts"), "export const refund = 0;\n");
    git("add", "-A");
    git("commit", "-q", "-m", "init");
    createSpace(app, { id: "shop-api", name: "订单服务", kind: "repo", rootPath: dir });
    app.config.review = {
      tiers: [
        { id: "standard", name: "标准", guide: "", when: { field: "change.lines", op: "gte", value: 1 }, checks: ["reviewer", "review-business", "review-style"], maxRounds: 4, lead: true, confirmPlan: true },
        { id: "light", name: "轻", guide: "", when: null, checks: ["reviewer"], maxRounds: 3, lead: false, confirmPlan: false },
      ],
      checks: {},
      rereviewAllEvery: 3,
    };
    const server = await startServer(app, { port: 0, quiet: true });
    try {
      const t = createThread(app, { channel: "web", spaceId: "shop-api", userId: "owner" });
      const ask = createRun(app, { kind: "ask", spaceId: "shop-api", title: "交办", input: { conversationId: t.id } });
      const r1 = createRun(app, { kind: "code", spaceId: "shop-api", title: "退款金额", input: { task: "按已发货行计算退款金额", repos: ["shop-api"] }, parentId: ask.id });
      codeChainFor(app, r1);

      // Round 1 codes, plans the review and waits for the owner.
      expect((await work(app, r1.id)).verdict).toBe("awaiting-plan");
      const planAsk = getAsk(app, String(getRun(app, r1.id).output.reviewAskId));
      expect(planAsk.question).toContain("「标准」档");
      expect((getRun(app, ask.id).output.codeChain as CodeChain)).toMatchObject({ awaitingUser: true, waitReason: "plan" });
      expect(getRun(app, r1.id).output.codeResultMessageId).toBeUndefined();
      expect(JSON.stringify(snapshot(app, getRun(app, ask.id).output.codeChain as CodeChain))).toContain("评审计划等你确认");

      // Confirming starts a review run on the same worktree.
      await answerAsk(app, planAsk.id, { choice: 0, by: "owner" });
      const review = listRuns(app, { kind: "review" })[0];
      expect(review.input).toMatchObject({ codeRunId: r1.id });
      const texts: Record<string, string> = {};
      const reviewed = await work(app, review.id, texts);
      expect(reviewed.verdict).toBe("changes-requested");
      const leadTools = JSON.parse(texts.lead.split("\n")[1]).tools as string[];
      expect(leadTools).toContain("rule_review");
      expect(leadTools).not.toContain("submit_review");
      const out1 = getRun(app, r1.id).output as { reviewLead: LeadResult; codeChain: CodeChain };
      expect(out1.reviewLead).toMatchObject({ by: "lead", verdict: "revise", rerun: ["review-business"] });
      const states = roundFindings(app, r1.id, 1).map((f) => [f.check_name, f.severity, f.state]);
      expect(states).toContainEqual(["review-business", "major", "accepted"]);
      expect(states.filter(([, , s]) => s === "rejected").length).toBeGreaterThan(0);

      // Round 2 re-reviews business only; the same problem again does not converge: ask the owner.
      const r2 = getRun(app, (getRun(app, ask.id).output.codeChain as CodeChain).lastCodeRunId!);
      expect(r2.input).toMatchObject({ round: 2, reviewOnly: ["review-business"] });
      expect(r2.input.task).toContain("过滤已发货行");
      await work(app, r2.id);
      const out2 = getRun(app, r2.id).output as { reviewPlan: { checks: string[] }; reviewLead: LeadResult; reviewStop: string; reviewAskId: string };
      expect(out2.reviewPlan.checks).toEqual(["review-business"]);
      expect(out2.reviewStop).toBe("not-converging");
      expect((getRun(app, ask.id).output.codeChain as CodeChain)).toMatchObject({ awaitingUser: true, waitReason: "not-converging" });
      const card = JSON.stringify(snapshot(app, getRun(app, ask.id).output.codeChain as CodeChain));
      expect(card).toContain("停下来等你决定");
      expect(card).toContain("业务：要求修改");
      expect(card).toContain("负责人：");
      const decide = getAsk(app, out2.reviewAskId);
      expect(decide.question).toContain("没有收敛");
      expect(listAsks(app, { status: "pending" }).map((a) => a.id)).toContain(decide.id);

      // The owner accepts the change as it is.
      await answerAsk(app, decide.id, { choice: decide.options.findIndex((o) => o.label === "接受现在的改动"), by: "owner" });
      expect(getRun(app, r2.id).output).toMatchObject({ verdict: "approved", acceptedByOwner: true });
      expect((getRun(app, ask.id).output.codeChain as CodeChain).awaitingUser).toBe(false);
    } finally {
      await server.close();
      app.db.close();
    }
  }, 180000);
});
