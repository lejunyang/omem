import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { testApp } from "./helpers.ts";
import { createRun, getRun, setRunOutput } from "../src/agents/runs.ts";
import { reviewRound, crossFamilyExecution } from "../src/agents/review-chain.ts";
import { runBackend } from "../src/agents/dispatch.ts";
import { recordReview, reviewFor, coderAI, independenceWarnings, defaultReviewSettings } from "../src/agents/review.ts";
import { addTask, taskList, thirdFixText } from "../src/agents/code-tasks.ts";
import { run } from "../src/core/db.ts";
import { startServer } from "../src/server/http.ts";
import { markDown } from "../src/agents/capacity.ts";
import type { Execution } from "../src/agents/execution.ts";

const metrics = { "change.lines": 40, "change.codeLines": 40, "change.files": 1, "change.repos": 1, "change.paths": ["refund.ts"], "change.checksPassed": true, "task.text": "退款" };

function setup(own = "gpt-6.1-sol", mode: "off" | "prefer" | "require" = "prefer") {
  const app = testApp();
  const log = join(app.home, "prompts.jsonl");
  for (const [id, model] of [["coding", "gpt-6.1-sol"], ["checking", own], ["other", "claude-test"], ["third", "gemini-test"]]) {
    app.config.agents.profiles.push({ id, name: id, model, transport: "acp", command: process.execPath, args: [resolve("test/fake-acp-agent.ts")], env: { FAKE_MODE: "review", FAKE_PROMPT_LOG: log, FAKE_REVIEW_MODELS: "gpt-6.1-sol,claude-test,gemini-test,unrecognised-model" }, idleTimeoutMs: 60000 });
  }
  app.config.agents.default = "coding";
  app.config.agents.roles.reviewer = "checking";
  app.config.review = { ...defaultReviewSettings(), crossFamily: mode, rotation: [{ profile: "checking" }, { profile: "other" }, { profile: "third" }] };
  const r = createRun(app, { kind: "code", spaceId: "personal", title: "退款改造", input: { task: "退款", roundReview: { split: false } } });
  run(app.db, "update runs set ai = ? where id = ?", JSON.stringify({ profile: "coding", model: "gpt-6.1-sol" }), r.id);
  setRunOutput(app, r.id, { reviewPlan: { tier: "light", tierName: "轻量", checks: ["reviewer"], maxRounds: 3, reasons: [], metrics, lead: true }, repos: [] });
  return { app, id: r.id, log };
}

async function check(o: ReturnType<typeof setup>, execution?: Execution, tasks = false) {
  if (execution) run(o.app.db, "update runs set input = ? where id = ?", JSON.stringify({ task: "退款", roundReview: { split: false }, reviewExecution: execution }), o.id);
  const server = await startServer(o.app, { port: 0, quiet: true });
  try {
    await reviewRound(o.app, o.id, { runId: o.id, signal: new AbortController().signal, event() {} }, tasks ? { task: { split: false, tasks: () => taskList(o.app, o.id), session: () => undefined, onSession() {} } } : {});
    return reviewFor(o.app, o.id, 1, "reviewer")!;
  } finally { await server.close(); }
}

describe("cross-family review", () => {
  it.each([
    ["gpt-6.1-sol", "prefer", "other", "claude-test", "other"],
    ["claude-test", "prefer", "checking", "claude-test", "other"],
    ["unrecognised-model", "prefer", "checking", "unrecognised-model", "unknown"],
    ["gpt-6.1-sol", "off", "checking", "gpt-6.1-sol", "same"],
  ] as const)("runs and records %s with %s", async (own, mode, profile, model, relation) => {
    const o = setup(own, mode);
    try {
      const row = await check(o);
      expect(row).toMatchObject({ profile_id: profile, model, independence: relation });
      const prompts = readFileSync(o.log, "utf8");
      expect(prompts).toContain(model);
      if (relation === "same") expect(prompts).toContain("（和编码同一家模型）");
    } finally { o.app.db.close(); }
  }, 90_000);

  it.each(["prefer", "require"] as const)("%s keeps own AI when nothing else is available; depth three reaches the lead", async (mode) => {
    const o = setup("gpt-6.1-sol", mode);
    o.app.config.review.rotation = [];
    for (let n = 1; n <= 3; n++) addTask(o.app, o.id, { title: `修改位置 ${n}`, kind: n === 1 ? "build" : "fix", origin: n === 1 ? {} : { follows: n - 1 } }, "review-lead");
    try {
      expect(thirdFixText(o.app, o.id)).toBe("");
      addTask(o.app, o.id, { title: "修改位置 4", kind: "fix", origin: { follows: 3 } }, "review-lead");
      const row = await check(o, undefined, true);
      expect(row).toMatchObject({ profile_id: "checking", independence: "same" });
      const line = "功能 和编码是同一家模型，没有别家的可换：这一项不算独立评审";
      if (mode === "require") {
        expect(getRun(o.app, o.id).output.review).toContain(line);
        expect(getRun(o.app, o.id).output.reviewLead).toMatchObject({ summary: expect.stringContaining(line) });
        expect(readFileSync(o.log, "utf8")).toContain(line);
        expect(independenceWarnings(o.app, o.id, 1)).toBe(line);
      } else expect(independenceWarnings(o.app, o.id, 1)).toBe("");
      expect(readFileSync(o.log, "utf8")).toContain("已经修到第三次的位置");
      // A task-driven round supplies the chain to the same ruling builder.
      expect(thirdFixText(o.app, o.id)).toContain("T1 修改位置 1 → T2 修改位置 2 → T3 修改位置 3 → T4 修改位置 4");
    } finally { o.app.db.close(); }
  }, 90_000);

  it("never replaces the owner's explicit reviewExecution", async () => {
    const o = setup();
    try {
      expect(await check(o, { profile: "checking", model: "gpt-6.1-sol", source: "user", reason: "本人指定" })).toMatchObject({ profile_id: "checking", model: "gpt-6.1-sol", independence: "same" });
    } finally { o.app.db.close(); }
  }, 90_000);

  it("records the actual fallback reviewer without replacing the coder's recorded AI", async () => {
    const o = setup("gpt-6.1-sol", "off");
    o.app.config.agents.profiles.find((p) => p.id === "checking")!.env.FAKE_DIE = "1";
    o.app.config.agents.fallback = [{ profile: "other" }];
    try {
      expect(await check(o)).toMatchObject({ profile_id: "other", model: "claude-test", independence: "other" });
      expect(getRun(o.app, o.id).ai).toEqual({ profile: "coding", model: "gpt-6.1-sol" });
    } finally { o.app.db.close(); }
  }, 90_000);

  it("skips an excluded fallback after the reviewer crashes", async () => {
    const o = setup("gpt-6.1-sol", "off");
    o.app.config.review.excludedModels = ["CLAUDE"];
    const profiles = o.app.config.agents.profiles;
    profiles.find(p => p.id === "checking")!.env.FAKE_DIE = "1";
    o.app.config.agents.fallback = [{ profile: "other" }, { profile: "third" }];
    try {
      expect(await check(o)).toMatchObject({ profile_id: "third", model: "gemini-test" });
      expect(getRun(o.app, o.id).ai?.profile).toBe("coding");
    } finally { o.app.db.close(); }
  }, 90_000);

  it("checks ACP's resolved model before prompting and leaves ordinary calls and a cleared list alone", async () => {
    const o = setup();
    const profile = o.app.config.agents.profiles.find(p => p.id === "other")!;
    profile.model = "claude";
    profile.env.FAKE_REVIEW_MODELS = "claude-opus-test,claude-sonnet-test";
    profile.env.FAKE_MODE = "thread";
    const request = { cwd: o.app.home, prompt: "检查模型选择", allowWrites: false };
    const call = (codeReview: boolean) => runBackend(o.app, profile, { ...request, codeReview }, () => {});
    try {
      o.app.config.review.excludedModels = ["Opus"];
      await expect(call(true)).rejects.toThrow(/编码评审.*claude-opus-test/);
      await expect(call(false)).resolves.toBeDefined();
      o.app.config.review.excludedModels = [];
      await expect(call(true)).resolves.toBeDefined();
      expect(readFileSync(o.log, "utf8").trim().split("\n")).toHaveLength(2);
    } finally { o.app.db.close(); }
  }, 90_000);

  it("filters unavailable and excluded backends, preserves order and uses routing candidates afterwards", () => {
    const o = setup();
    try {
      o.app.config.agents.profiles.push({ id: "missing", name: "missing", model: "claude-test", transport: "acp", command: "omem-missing-backend-command", args: [], env: {}, idleTimeoutMs: 60000 });
      o.app.config.review.rotation = [{ profile: "missing" }, { profile: "other" }];
      o.app.config.agents.routing.candidates = [{ profile: "third", when: "通用" }];
      const pick = () => crossFamilyExecution(o.app, o.id, { role: "reviewer" });
      expect(pick()).toMatchObject({ profile: "other", model: "claude-test", source: "auto", reason: "和编码不是同一家模型" });
      o.app.config.agents.routing.automatic = false;
      expect(pick()).toBeUndefined();
      o.app.config.agents.routing.automatic = true;
      o.app.config.agents.capacity.limits.push({ profile: "other", max: 0 });
      expect(pick()).toMatchObject({ profile: "third" });
      markDown(o.app, o.app.config.agents.profiles.find((p) => p.id === "third")!, "暂不可用");
      expect(pick()).toBeUndefined();
    } finally { o.app.db.close(); }
  });

  it("falls back to the work execution before a code run recorded AI; peer reviews remain null", () => {
    const o = setup();
    try {
      run(o.app.db, "update runs set ai = null, input = ? where id = ?", JSON.stringify({ execution: { profile: "coding", model: "claude-test" } }), o.id);
      expect(coderAI(o.app, o.id)).toEqual({ profile: "coding", model: "claude-test" });
      recordReview(o.app, { codeRunId: o.id, round: 1, check: "reviewer", verdict: "approved", summary: "外部评审", findings: [], ai: { profile: "peer:device", model: "claude-test" } });
      expect(reviewFor(o.app, o.id, 1, "reviewer")!.independence).toBeNull();
    } finally { o.app.db.close(); }
  });
});
