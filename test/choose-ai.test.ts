import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setKey } from "../src/core/ai-keys.ts";
import { setDecisionFetchForTests } from "../src/core/decision.ts";
import { allProfiles } from "../src/core/config.ts";
import { downReason, noteFailure } from "../src/agents/capacity.ts";
import { receive } from "../src/agents/inbox.ts";
import { runEvents, waitForRun } from "../src/agents/runs.ts";
import { breakdownKind, isBackendDown, runRole } from "../src/agents/runner.ts";
import { releaseAll } from "../src/agents/sessions.ts";
import { saveAgentSpec } from "../src/agents/specs.ts";
import { getThread } from "../src/agents/threads.ts";
import { boot } from "../src/main.ts";
import type { App } from "../src/core/app.ts";
import type { AgentEvent } from "../src/agents/types.ts";
import { testApp } from "./helpers.ts";

afterEach(() => setDecisionFetchForTests(null));

const fakeAgent = (id: string, env: Record<string, string> = {}) => ({ id, name: id, transport: "acp" as const, command: process.execPath, args: [resolve("test/fake-acp-agent.ts")], env: { FAKE_MODE: "thread", ...env }, idleTimeoutMs: 60000, model: "m1" });

function withDecision(app: App, answer: (body: any) => unknown, status = 200) {
  app.config.ai.providers = [{ id: "d", name: "决策", kind: "openai" as never, backends: [] }];
  app.config.ai.decision = { provider: "d", model: "", fallback: "general", gatekeeper: true };
  setKey(app.home, "d", "key-1");
  const bodies: any[] = [];
  setDecisionFetchForTests((async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    bodies.push(body);
    return new Response(JSON.stringify(answer(body)), { status });
  }) as unknown as typeof fetch);
  return bodies;
}
const statuses = (events: AgentEvent[]) => events.filter((e) => e.type === "status").map((e) => (e as { text: string }).text);

describe("choosing the AI before a run", () => {
  it("asks the decision model among the candidates, and keeps the run's own AI when choice is off or fails", async () => {
    const app = testApp();
    app.baseUrl = "http://127.0.0.1:1";
    app.config.agents.profiles.push(fakeAgent("slow"), fakeAgent("fast"));
    app.config.agents.default = "slow";
    app.config.agents.routing = { automatic: true, guidance: "简单的活用快模型", candidates: [{ profile: "fast", model: "m1", when: "简单整理、总结" }], choose: { conversation: "decision", rules: "decision", tasks: "decision" }, pinnedFallback: "unavailable" };
    const bodies = withDecision(app, () => ({ answers: [{ type: "choice", name: "q", choice: "c1", probabilities: [{ value: "keep", probability: 0.2 }, { value: "c1", probability: 0.8 }] }] }));
    const events: AgentEvent[] = [];
    const r = await runRole(app, { role: "summarizer", spaceId: "personal", runId: null, task: "总结一下这段话", onEvent: (e) => events.push(e) });
    expect(r.profileId).toBe("fast");
    expect(statuses(events).some((t) => /自动选 AI：fast · m1（决策模型（决策 · .*）：fast · m1 0\.80）/.test(t))).toBe(true);
    const q = bodies[0].questions[0];
    expect(q.choices.map((c: { value: string }) => c.value)).toEqual(["keep", "c1"]);
    expect(q.choices[1].description).toContain("简单整理、总结");
    expect(JSON.stringify(bodies[0].input)).toContain("简单的活用快模型");

    // Off for this kind of run: no question asked.
    app.config.agents.routing.choose.tasks = "off";
    expect((await runRole(app, { role: "summarizer", spaceId: "personal", runId: null, task: "再总结" })).profileId).toBe("slow");
    expect(bodies).toHaveLength(1);

    // The decision model fails: the run keeps its own AI and says why.
    app.config.agents.routing.choose.tasks = "decision";
    withDecision(app, () => ({ error: "boom" }), 500);
    const failed: AgentEvent[] = [];
    expect((await runRole(app, { role: "summarizer", spaceId: "personal", runId: null, task: "又一段", onEvent: (e) => failed.push(e) })).profileId).toBe("slow");
    expect(statuses(failed).some((t) => /自动选 AI 没有选成，用原来的 slow · m1（决策模型：出错/.test(t))).toBe(true);
  }, 60_000);

  it("records every choice in the run, also when there was none and why", async () => {
    const app = testApp();
    app.baseUrl = "http://127.0.0.1:1";
    app.config.agents.profiles.push(fakeAgent("slow"), fakeAgent("fast"), fakeAgent("flaky"));
    app.config.agents.default = "slow";
    app.config.agents.routing = { automatic: true, guidance: "", candidates: [{ profile: "fast", model: "", effort: "", when: "什么都行" }, { profile: "flaky", when: "也行" }], choose: { conversation: "decision", rules: "decision", tasks: "off" }, pinnedFallback: "unavailable" };
    const choices = (events: AgentEvent[]) => events.flatMap((e) => (e.type === "status" && e.choice ? [e] : []));
    // Off for this kind of run.
    const off: AgentEvent[] = [];
    await runRole(app, { role: "summarizer", spaceId: "personal", runId: null, task: "总结", onEvent: (e) => off.push(e) });
    expect(choices(off)).toHaveLength(1);
    expect(choices(off)[0]).toMatchObject({ text: expect.stringContaining("没有自动选 AI，用 slow · m1：这类运行（交办和后台任务）设成了“不选”"), choice: { outcome: "skipped", scene: "tasks" } });
    // Named by the owner.
    const named: AgentEvent[] = [];
    await runRole(app, { role: "summarizer", spaceId: "personal", runId: null, task: "总结", execution: { profile: "fast", source: "user", reason: "本人要快的" }, onEvent: (e) => named.push(e) });
    expect(choices(named)[0].type === "status" && choices(named)[0]).toMatchObject({ text: expect.stringContaining("本人指定了 fast（本人要快的）") });
    // The chooser keeps the run's own AI: that is recorded too, with what it was offered. A candidate
    // that just broke down is not offered (it would only be set aside after the pick), and one written
    // with an empty model is the backend's own model, not a model named "".
    app.config.agents.routing.choose.tasks = "decision";
    noteFailure(app, allProfiles(app.config).find((p) => p.id === "flaky")!, "crash", "Agent 进程退出（1）");
    const bodies = withDecision(app, () => ({ answers: [{ type: "choice", name: "q", choice: "keep", probabilities: [{ value: "keep", probability: 0.7 }] }] }));
    const kept: AgentEvent[] = [];
    expect((await runRole(app, { role: "summarizer", spaceId: "personal", runId: null, task: "总结", onEvent: (e) => kept.push(e) })).profileId).toBe("slow");
    const rec = choices(kept)[0] as unknown as { text: string; choice: { outcome: string; options: string[]; left: string[] } };
    expect(rec.text).toMatch(/^自动选 AI：按原来的设置用 slow · m1（决策模型/);
    expect(rec.choice.outcome).toBe("kept");
    expect(rec.choice.left.join()).toContain("flaky · m1：刚出过故障");
    expect(bodies[0].questions[0].choices.map((c: { value: string }) => c.value)).toEqual(["keep", "c1"]);
    expect(bodies[0].questions[0].choices[1].description).toMatch(/^fast · m1：/);
  }, 60_000);

  it("never re-chooses an AI the caller named", async () => {
    const app = testApp();
    app.baseUrl = "http://127.0.0.1:1";
    app.config.agents.profiles.push(fakeAgent("slow"), fakeAgent("fast"));
    app.config.agents.default = "slow";
    app.config.agents.routing = { automatic: true, guidance: "", candidates: [{ profile: "fast", when: "什么都行" }], choose: { conversation: "decision", rules: "decision", tasks: "decision" }, pinnedFallback: "unavailable" };
    const bodies = withDecision(app, () => ({ answers: [{ type: "choice", name: "q", choice: "c1", probabilities: [] }] }));
    const r = await runRole(app, { role: "summarizer", spaceId: "personal", runId: null, task: "总结", execution: { profile: "slow", source: "user", reason: "规则指定" } });
    expect(r.profileId).toBe("slow");
    expect(bodies).toHaveLength(0);
  }, 60_000);
});

describe("moving on when a backend breaks down", () => {
  it("tells a breakdown from other failures", () => {
    expect(isBackendDown(new Error("Agent 进程退出（1）"))).toBe(true);
    expect(isBackendDown(new Error("ACP connection closed"))).toBe(true);
    expect(isBackendDown(new Error("Agent 超过 600 秒没有任何活动，已停止"))).toBe(true);
    expect(isBackendDown(new Error("指定模型 x 不可用"))).toBe(false);
    // The upstream model stream broke off: the backend lives on, another try or backend usually works.
    const cut = new Error('Internal error：{"message":"stream disconnected before completion: llm response empty stream","will_retry":false}');
    expect(breakdownKind(cut)).toBe("transient");
    expect(breakdownKind(new Error("命令行后端退出码 1：rpc error: code = 13 desc = stream terminated by RST_STREAM with error code: INTERNAL_ERROR"))).toBe("transient");
    expect(breakdownKind(new Error("Agent 进程退出（1）"))).toBe("crash");
    expect(breakdownKind(new Error("Internal error：model `x` is unavailable because its metadata could not be resolved"))).toBeNull();
  });

  it("sets a model aside after upstream errors in a row or a queue past the limit, and a backend after a crash", () => {
    const app = testApp();
    const p = (model: string) => ({ id: "acct", transport: "acp" as const, command: "x", args: [], env: {}, idleTimeoutMs: 1000, model });
    const now = Date.now();
    expect(noteFailure(app, p("a"), "transient", "stream disconnected", now)).toBeNull();
    expect(downReason(app, p("a"), now)).toBeNull();
    expect(noteFailure(app, p("a"), "transient", "stream disconnected", now + 1000)).toContain("上游出错 2 次");
    expect(downReason(app, p("a"), now + 2000)).toBeTruthy();
    expect(downReason(app, p("b"), now + 2000)).toBeNull();
    expect(downReason(app, p("a"), now + 20 * 60_000)).toBeNull();
    noteFailure(app, p("b"), "queue", "排队超过 10 分钟仍未开始，已停止", now);
    expect(downReason(app, p("b"), now + 1000)).toContain("排队");
    noteFailure(app, p("c"), "crash", "Agent 进程退出（1）", now);
    expect(downReason(app, p("zzz"), now + 1000)).toContain("进程退出");
  });

  it("a run whose AI was named moves on when that AI breaks down, saying so; with fallback off it fails", async () => {
    const app = testApp();
    app.baseUrl = "http://127.0.0.1:1";
    app.config.agents.profiles.push(fakeAgent("dying", { FAKE_DIE: "1" }), fakeAgent("spare"));
    app.config.agents.default = "spare";
    app.config.agents.fallback = [{ profile: "spare" }];
    const events: AgentEvent[] = [];
    const r = await runRole(app, { role: "summarizer", spaceId: "personal", runId: null, task: "总结", execution: { profile: "dying", source: "user", reason: "规则指定" }, onEvent: (e) => events.push(e) });
    expect(r.profileId).toBe("spare");
    const moved = events.find((e) => e.type === "status" && !!e.failover) as { text: string; failover: Record<string, unknown> };
    expect(moved.text).toMatch(/^原指定的 AI（dying）没有开始工作就失败了（(Agent 进程退出|ACP connection closed).*改用 spare/);
    expect(moved.failover).toMatchObject({ from: "dying · m1", to: "spare · m1", pinned: true });
    app.config.agents.routing.pinnedFallback = "never";
    await expect(runRole(app, { role: "summarizer", spaceId: "personal", runId: null, task: "再总结", execution: { profile: "dying", source: "user", reason: "规则指定" } })).rejects.toThrow(/进程退出|connection closed/);
  }, 60_000);

  it("an Agent 档案 run moves to the fallback when its backend dies, and later runs try that backend last", async () => {
    const app = testApp();
    app.baseUrl = "http://127.0.0.1:1";
    app.config.agents.profiles.push(fakeAgent("dying", { FAKE_DIE: "1" }), fakeAgent("spare"));
    app.config.agents.default = "dying";
    app.config.agents.fallback = [{ profile: "spare" }];
    const spec = saveAgentSpec(app, { name: "helper-a", description: "帮忙", prompt: "帮忙", status: "active", agent: "dying" }, "user");
    const events: AgentEvent[] = [];
    const r = await runRole(app, { role: "assistant", spec, spaceId: "personal", runId: null, task: "看一下", onEvent: (e) => events.push(e) });
    expect(r.profileId).toBe("spare");
    expect(statuses(events).some((t) => /改用 spare/.test(t))).toBe(true);
    const dying = allProfiles(app.config).find((p) => p.id === "dying")!;
    expect(downReason(app, dying)).toBeTruthy();
    const later: AgentEvent[] = [];
    expect((await runRole(app, { role: "assistant", spec, spaceId: "personal", runId: null, task: "再看", onEvent: (e) => later.push(e) })).profileId).toBe("spare");
  }, 60_000);

  it("a conversation turn moves to the fallback when the backend dies, and the next turn stays there", async () => {
    const home = mkdtempSync(join(tmpdir(), "omem-down-"));
    const agent = (id: string, env: Record<string, string>) => ({ id, transport: "acp", command: process.execPath, args: [resolve("test/fake-acp-agent.ts")], env: { FAKE_MODE: "thread", ...env } });
    writeFileSync(join(home, "config.json"), JSON.stringify({ agents: { default: "dying", fallback: [{ profile: "spare" }], profiles: [agent("dying", { FAKE_DIE: "1" }), agent("spare", {})] } }));
    const { app, server } = await boot(home, { port: 0, quiet: true, background: false });
    try {
      const turn = async (text: string) => {
        const { runId } = await receive(app, { channel: "web", chatId: "down", text, mergeMs: 0 });
        const r = await waitForRun(app, runId!);
        expect(r.error).toBeNull();
        return { r, texts: runEvents(app, runId!).filter((e) => e.type === "status").map((e) => String((e.data as { text?: string }).text ?? "")) };
      };
      const first = await turn("你好");
      expect(first.texts.some((t) => /dying 出错/.test(t) && /改用 spare/.test(t))).toBe(true);
      releaseAll();
      const second = await turn("再问一句");
      expect(second.texts.some((t) => /出错/.test(t))).toBe(false);
      expect(second.r.profileId).toBe("spare");
    } finally {
      releaseAll();
      server.close();
    }
  }, 60_000);
});
