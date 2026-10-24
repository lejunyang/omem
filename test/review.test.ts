import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import "../src/agents/jobs.ts";
import { matchesReview, planReview, refineReviewPlan, reviewsOf, validateReviewSettings, type ReviewMetrics } from "../src/agents/review.ts";
import { __testHandlers, addRunEvent, createRun, getRun, setRunOutput } from "../src/agents/runs.ts";
import { saveAgentSpec } from "../src/agents/specs.ts";
import { createThread } from "../src/agents/threads.ts";
import { codeChainFor, type CodeChain } from "../src/agents/code-chain.ts";
import { createSpace } from "../src/core/spaces.ts";
import { run } from "../src/core/db.ts";
import { startServer } from "../src/server/http.ts";
import { testApp } from "./helpers.ts";

const metrics = (m: Partial<ReviewMetrics> = {}): ReviewMetrics => ({ "change.lines": 10, "change.files": 1, "change.repos": 1, "change.paths": ["src/a.ts"], "change.checksPassed": true, "task.text": "改一下", ...m });

describe("review tiers and checks", () => {
  it("picks the first matching tier, honours a named tier, never goes lighter, and adds checks by their own condition", () => {
    const app = testApp();
    saveAgentSpec(app, { name: "security-review", description: "只看鉴权和越权", prompt: "评审", tools: ["search"] }, "user");
    app.config.review.checks = { "security-review": { label: "安全", blocks: "major", guide: "", when: { field: "change.paths", op: "contains", value: "auth" } } };
    expect(planReview(app, metrics()).tier).toBe("light");
    expect(planReview(app, metrics({ "change.lines": 120 }))).toMatchObject({ tier: "standard", checks: ["reviewer", "review-business", "review-style"] });
    expect(planReview(app, metrics({ "change.repos": 2 })).tier).toBe("full");
    expect(planReview(app, metrics(), { tier: "完整" }).tier).toBe("full");
    const standard = planReview(app, metrics({ "change.lines": 120 }));
    expect(planReview(app, metrics(), { previous: standard }).tier).toBe("standard");
    const auth = planReview(app, metrics({ "change.paths": ["src/auth/login.ts"] }));
    expect(auth.checks).toEqual(["reviewer", "security-review"]);
    expect(auth.reasons.join()).toContain("安全");
    expect(() => planReview(app, metrics(), { tier: "没有这档" })).toThrow();
    app.db.close();
  });

  it("lets a model weigh the owner's words: only heavier tiers and extra checks, nothing when it cannot answer", async () => {
    const app = testApp();
    saveAgentSpec(app, { name: "perf-review", description: "只看性能", prompt: "评审", tools: ["search"] }, "user");
    app.config.review.tiers[0].guide = "改到计费、对账这类钱的逻辑";
    app.config.review.checks = { "perf-review": { label: "性能", blocks: "major", when: null, guide: "改了查询或循环里的 IO" } };
    const base = planReview(app, metrics());
    const prompts: string[] = [];
    const refined = await refineReviewPlan(app, base, { task: "退款金额按已发货行计算", diff: "+ for (const l of lines) await db.get(l)" }, async (p) => { prompts.push(p); return '{"tier":"full","checks":["perf-review","nobody"],"reason":"涉及退款金额"}'; });
    expect(prompts[0]).toContain("改到计费、对账这类钱的逻辑");
    expect(prompts[0]).not.toContain("standard（标准）");
    expect(refined).toMatchObject({ tier: "full", maxRounds: 3 });
    expect(refined.checks).toEqual(expect.arrayContaining(["reviewer", "review-business", "review-arch", "perf-review"]));
    expect(refined.checks).not.toContain("nobody");
    expect((await refineReviewPlan(app, base, { task: "改", diff: "", tierNamed: true }, async () => '{"tier":"full","checks":[]}')).tier).toBe("light");
    expect(await refineReviewPlan(app, base, { task: "改", diff: "" }, async () => null)).toMatchObject({ tier: "light", checks: ["reviewer"] });
    app.config.review.tiers[0].guide = "";
    app.config.review.checks = {};
    let asked = false;
    await refineReviewPlan(app, base, { task: "改", diff: "" }, async () => { asked = true; return null; });
    expect(asked).toBe(false);
    app.db.close();
  });

  it("compares numbers only on numeric fields and validates settings before saving", () => {
    const app = testApp();
    expect(matchesReview({ all: [{ field: "change.lines", op: "gte", value: 10 }, { not: { field: "change.checksPassed", op: "is", value: false } }] }, metrics())).toBe(true);
    expect(matchesReview({ field: "change.lines", op: "lte", value: 5 }, metrics())).toBe(false);
    const tiers = [{ id: "big", name: "大", when: { field: "change.lines", op: "gte", value: 100 }, checks: ["reviewer"], maxRounds: 2 }, { id: "rest", name: "其余", when: null, checks: ["reviewer"], maxRounds: 3 }];
    expect(validateReviewSettings(app, { tiers, checks: {} }).tiers).toHaveLength(2);
    expect(() => validateReviewSettings(app, { tiers: [tiers[0]], checks: {} })).toThrow(/兜底/);
    expect(() => validateReviewSettings(app, { tiers: [{ ...tiers[1], checks: ["nobody"] }], checks: {} })).toThrow(/不存在的评审项/);
    expect(() => validateReviewSettings(app, { tiers, checks: { coder: { label: "编码", blocks: "major", when: null } } })).toThrow(/内置角色/);
    expect(() => validateReviewSettings(app, { tiers: [{ ...tiers[0], when: { field: "change.paths", op: "gte", value: 3 } }, tiers[1]], checks: {} })).toThrow();
    app.db.close();
  });

  it("runs each check in its own read-only session, records structured findings and asks the coder only for blocking ones", async () => {
    const app = testApp();
    app.config.agents.profiles.push({ id: "fake", name: "fake", transport: "acp", command: process.execPath, args: [resolve("test/fake-acp-agent.ts")], env: { FAKE_MODE: "review" }, idleTimeoutMs: 60000 });
    app.config.agents.default = "fake";
    const dir = mkdtempSync(join(tmpdir(), "omem-review-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" } });
    git("init", "-q");
    writeFileSync(join(dir, "refund.ts"), "export const refund = 0;\n");
    git("add", "-A");
    git("commit", "-q", "-m", "init");
    createSpace(app, { id: "shop-api", name: "订单服务", kind: "repo", rootPath: dir });
    // A spec that may write and use other tools elsewhere still only reads when it reviews.
    saveAgentSpec(app, { name: "security-review", description: "只看鉴权和越权", prompt: "评审", tools: ["search", "remember"], writes: true, agent: "fake" }, "user");
    app.config.review = {
      tiers: [{ id: "standard", name: "标准", guide: "", when: { field: "change.lines", op: "gte", value: 1 }, checks: ["reviewer", "review-business"], maxRounds: 2 }, { id: "light", name: "轻", guide: "", when: null, checks: ["reviewer"], maxRounds: 3 }],
      checks: { "security-review": { label: "安全", blocks: "major", guide: "", when: { field: "change.paths", op: "contains", value: "refund" } } },
    };
    const server = await startServer(app, { port: 0, quiet: true });
    try {
      const t = createThread(app, { channel: "web", spaceId: "shop-api", userId: "owner" });
      const ask = createRun(app, { kind: "ask", spaceId: "shop-api", title: "交办", input: { conversationId: t.id } });
      const r = createRun(app, { kind: "code", spaceId: "shop-api", title: "退款金额", input: { task: "按已发货行计算退款金额", repos: ["shop-api"] }, parentId: ask.id });
      codeChainFor(app, r);
      run(app.db, "update runs set status = 'running' where id = ?", r.id);
      const texts: Record<string, string> = {};
      const out = await __testHandlers.get("code")!({
        app, run: getRun(app, r.id), signal: new AbortController().signal,
        event: (type, data) => { addRunEvent(app, r.id, type, data); const d = data as { check?: string; text?: string }; if (type === "text" && d.check) texts[d.check] = (texts[d.check] ?? "") + d.text; },
        output: (data) => setRunOutput(app, r.id, data),
      }) as { verdict: string; continuedRunId?: string };

      const done = getRun(app, r.id).output as { reviewPlan: { tier: string; checks: string[] }; verdict: string; review: string; codeChain: CodeChain };
      expect(done.reviewPlan).toMatchObject({ tier: "standard", checks: ["reviewer", "review-business", "security-review"] });
      const reviews = reviewsOf(app, [r.id]);
      expect(reviews.map((x) => [x.check_name, x.verdict]).sort()).toEqual([["review-business", "changes_requested"], ["reviewer", "approved"], ["security-review", "approved"]]);
      expect(reviews.find((x) => x.check_name === "review-business")!.findings.map((f) => f.severity)).toEqual(["major", "nit"]);
      const securityTools = JSON.parse(texts["security-review"].split("\n")[1]).tools as string[];
      expect(securityTools).toContain("submit_review");
      expect(securityTools).not.toContain("remember");
      expect(securityTools).not.toContain("write_file");
      expect(out.verdict).toBe("changes-requested");
      expect(done.review).toContain("### 业务（需要修改）");
      const next = getRun(app, out.continuedRunId!);
      expect(next.input.task).toContain("已发货行不能退");
      expect(next.input.task).not.toContain("命名可以更具体");
      expect((getRun(app, ask.id).output.codeChain as CodeChain).maxRounds).toBe(2);
    } finally {
      await server.close();
      app.db.close();
    }
  }, 120000);
});
