import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { executionArgs, validateExecution, type Execution } from "../src/agents/execution.ts";
import { prepareRun, runRole } from "../src/agents/runner.ts";
import { readAgentSpec, saveAgentSpec } from "../src/agents/specs.ts";
import { callTool, revokeToolToken, toolContextForToken } from "../src/agents/tools.ts";
import { createRun, getRun, listRuns, __testHandlers, addRunEvent, setRunOutput } from "../src/agents/runs.ts";
import { startAgentWork, refreshWork, queueAgentRound, saveWork } from "../src/agents/agent-work.ts";
import { codeChainFor, queueNextCodeRound } from "../src/agents/code-chain.ts";
import { createThread } from "../src/agents/threads.ts";
import { saveProbe } from "../src/agents/probe.ts";
import { startServer } from "../src/server/http.ts";
import { testApp } from "./helpers.ts";

function fixture() {
  const app = testApp();
  for (const id of ["first", "second"]) app.config.agents.profiles.push({ id, name: id, transport: "acp", command: process.execPath, args: [resolve("test/fake-acp-agent.ts")], env: { FAKE_TRAE: "1", FAKE_QUEUE: "1" }, idleTimeoutMs: 60000, model: "m1" });
  app.config.agents.default = "first";
  saveAgentSpec(app, { name: "specialist", description: "示例档案", prompt: "完成任务", agent: "first", model: "m2", effort: "high", tools: ["search"], spaces: ["personal"] }, "user");
  for (const id of ["first", "second"]) saveProbe(app, id, { at: new Date().toISOString(), agent: id, models: ["m1", "m2", "m3"], efforts: ["low", "high", "xhigh"], effortsByModel: { m1: [], m2: ["low", "high"], m3: ["low", "xhigh"] } });
  return app;
}
const choice: Execution = { profile: "second", model: "m3", effort: "xhigh", source: "auto", reason: "复杂分析" };

describe("temporary AI choices", () => {
  it("keeps spec defaults and permissions while applying per-run model and effort", () => {
    const app = fixture(); app.baseUrl = "http://127.0.0.1:1";
    const spec = readAgentSpec(app, "specialist");
    const prepare = (execution?: Execution) => prepareRun(app, { actor: { spec }, runId: null, spaceId: "personal", ...executionArgs(execution) });
    const base = prepare(); const changed = prepare(choice); const same = prepare({ ...choice, profile: "first" });
    expect(base.profile).toMatchObject({ id: "first", model: "m2", effort: "high" });
    expect(changed.profile).toMatchObject({ id: "second", model: "m3", effort: "xhigh" });
    expect(same.profile).toMatchObject({ id: "first", model: "m3", effort: "xhigh" });
    expect(toolContextForToken(app, changed.token)?.tools).toEqual(toolContextForToken(app, base.token)?.tools);
    expect(toolContextForToken(app, changed.token)?.spaces).toEqual(["personal"]);
    expect(changed.allowWrites).toBe(false);
    expect(readAgentSpec(app, "specialist")).toEqual(spec);
    for (const p of [base, changed, same]) revokeToolToken(p.token);
    const other = prepare({ ...choice, model: undefined, effort: undefined });
    expect(other.profile).toMatchObject({ id: "second", model: "m1" });
    expect(other.profile.effort).toBeUndefined(); revokeToolToken(other.token);
  });

  it("enforces automatic selection switch and detected backend/model/effort capabilities", () => {
    const app = fixture();
    expect(validateExecution(app, choice)).toEqual(choice);
    expect(() => validateExecution(app, { ...choice, profile: "missing" })).toThrow(/不可用/);
    expect(() => validateExecution(app, { ...choice, model: "unknown" })).toThrow(/检测结果/);
    expect(() => validateExecution(app, { ...choice, model: "m1" })).toThrow(/思考强度/);
    expect(() => validateExecution(app, { ...choice, effort: "high" })).toThrow(/思考强度/);
    app.config.agents.routing.automatic = false;
    expect(() => validateExecution(app, choice)).toThrow(/关闭/);
    expect(validateExecution(app, { ...choice, source: "user" })?.profile).toBe("second");
  });

  it("persists choices for ordinary delegation and independent work rounds", async () => {
    const app = fixture();
    const t = createThread(app, { channel: "web", spaceId: "personal" });
    const r = createRun(app, { kind: "ask", spaceId: "personal", title: "任务", input: { conversationId: t.id } });
    const ctx = { app, runId: r.id, spaceId: "personal", spaces: null, tools: null, actor: "agent" as const };
    expect((await callTool(ctx, "run_agent", { name: "specialist", task: "分析", execution: choice })).isError).toBe(false);
    expect(listRuns(app, { parentId: r.id })[0].input.execution).toEqual(choice);
    expect((await callTool(ctx, "run_agent", { name: "specialist", task: "分析", own_topic: true, execution: choice })).isError).toBe(false);
    const children = listRuns(app, { parentId: r.id });
    expect(children.some((r) => r.input.agentWorkId && JSON.stringify(r.input.execution) === JSON.stringify(choice))).toBe(true);
    expect((await callTool(ctx, "continue_agent_work", { work_id: r.id, task: "再核对", execution: { ...choice, model: "m2", effort: "low" } })).isError).toBe(false);
    expect(listRuns(app, { parentId: r.id }).some((r) => (r.input.execution as Execution)?.model === "m2")).toBe(true);
  });

  it("uses the assistant role without creating a profile and retains the caller's limits", async () => {
    const app = fixture(); const server = await startServer(app, { port: 0, quiet: true });
    try {
      const t = createThread(app, { channel: "web", spaceId: "personal" });
      const parent = createRun(app, { kind: "ask", title: "临时任务", spaceId: "personal", input: { conversationId: t.id } });
      const result = await callTool({ app, runId: parent.id, spaceId: "personal", spaces: ["personal"], tools: new Set(["run_agent", "search"]), actor: "agent", larkChats: ["chat-a"] }, "run_agent", { name: "assistant", task: "核对", execution: choice });
      expect(result.isError).toBe(false);
      const child = listRuns(app, { parentId: parent.id })[0];
      const scope = child.input.assistantScope as { spaces: string[]; denyTools: string[]; lark: { chats: string[] } };
      expect(scope.spaces).toEqual(["personal"]); expect(scope.denyTools).toContain("run_agent"); expect(scope.denyTools).toContain("lark_send");
      const prep = prepareRun(app, { actor: { role: "assistant" }, spaceId: "personal", runId: child.id, ...scope, ...executionArgs(choice) });
      expect(toolContextForToken(app, prep.token)?.tools?.has("lark_send")).toBe(false); revokeToolToken(prep.token);
      const output = await __testHandlers.get("agent")!({ app, run: child, signal: new AbortController().signal, event: (type, data) => addRunEvent(app, child.id, type, data), output: (data) => setRunOutput(app, child.id, data) });
      expect(output).toMatchObject({ answer: "queued-ok m3", ai: { profile: "second", model: "m3", effort: "xhigh" } });
      expect(() => readAgentSpec(app, "assistant")).toThrow();
    } finally { await server.close(); }
  }, 60000);

  it("resumes a matching AI but opens a fresh session when returning to the profile default", async () => {
    const app = fixture();
    for (const p of app.config.agents.profiles) p.env = { FAKE_MODE: "thread", FAKE_TRAE: "1" };
    const server = await startServer(app, { port: 0, quiet: true });
    try {
      const t = createThread(app, { channel: "web", spaceId: "personal" });
      const parent = createRun(app, { kind: "ask", title: "工作", spaceId: "personal", input: { conversationId: t.id } });
      const first = startAgentWork(app, { askRunId: parent.id, rootConversationId: t.id, spaceId: "personal", title: "工作", agent: "specialist", task: "第一轮", startMessage: "核对", execution: choice });
      async function finish(id: string) {
        const out = await __testHandlers.get("agent")!({ app, run: getRun(app, id), signal: new AbortController().signal, event: (type, data) => addRunEvent(app, id, type, data), output: (data) => setRunOutput(app, id, data) }) as Record<string, unknown>;
        setRunOutput(app, id, out); app.db.prepare("update runs set status='done' where id=?").run(id);
        const work = refreshWork(app, parent.id)!; work.rounds.find((r) => r.runId === id)!.status = "done"; saveWork(app, work, [parent.id, ...work.rounds.map((r) => r.runId)]);
        return JSON.parse(String(out.answer)) as { resumed: boolean };
      }
      expect((await finish(first.runId)).resumed).toBe(false);
      const second = queueAgentRound(app, refreshWork(app, parent.id)!, { agent: "specialist", task: "第二轮", execution: choice });
      expect((await finish(second)).resumed).toBe(true);
      const third = queueAgentRound(app, refreshWork(app, parent.id)!, { agent: "specialist", task: "第三轮" });
      expect((await finish(third)).resumed).toBe(false);
      expect(getRun(app, third).output.ai).toMatchObject({ profile: "first", model: "m2", effort: "high" });
    } finally { await server.close(); }
  }, 60000);

  it("carries coding and review choices to later rounds independently", () => {
    const app = fixture(); const t = createThread(app, { channel: "web", spaceId: "personal" });
    const parent = createRun(app, { kind: "ask", spaceId: "personal", title: "编码", input: { conversationId: t.id } });
    const review = { ...choice, profile: "first", model: "m2", effort: "low" };
    const first = createRun(app, { kind: "code", spaceId: "personal", title: "编码", input: { task: "修改", execution: choice, reviewExecution: review }, parentId: parent.id });
    app.db.prepare("update runs set status='running' where id=?").run(first.id);
    const chain = codeChainFor(app, first)!;
    const next = queueNextCodeRound(app, chain, "修正", { resumeSessionId: "session-a" })!;
    expect(next.run.input).toMatchObject({ execution: choice, reviewExecution: review, resumeSessionId: "session-a" });
    app.db.prepare("update runs set status='done' where id=?").run(next.run.id);
    const third = queueNextCodeRound(app, next.chain, "换编码模型", { manual: true, execution: review, resumeSessionId: "session-a" })!;
    expect(third.run.input).toMatchObject({ execution: review, reviewExecution: review });
    expect(third.run.input.resumeSessionId).toBeUndefined();
  });

  it("dispatches the selected model over real ACP for specs and built-in roles; HTTP defaults stay compatible", async () => {
    const app = fixture(); const server = await startServer(app, { port: 0, quiet: true });
    try {
      const saved = await server.inject({ method: "PUT", url: "/api/roles/reviewer/defaults", payload: { agent: "first", profile: "first", model: "m2", effort: "low" } });
      expect(saved.statusCode).toBe(200);
      expect((await server.inject("/api/roles/reviewer")).json().defaults).toMatchObject({ agent: "first", byBackend: { first: { model: "m2", effort: "low" } } });
      expect(app.config.agents.roleModels.reviewer.first.model).toBe("m2");
      for (const spec of [undefined, readAgentSpec(app, "specialist")]) {
        const events: string[] = [];
        const result = await runRole(app, { role: "reviewer", spec, spaceId: "personal", task: "只回复选中的模型", runId: null, execution: choice, onEvent: (e) => { if (e.type === "text") events.push(e.text); } });
        expect(result.profileId).toBe("second"); expect(events.join("")).toContain("queued-ok m3");
      }
      saveProbe(app, "second", { at: new Date().toISOString(), agent: "second", models: ["removed-model"], efforts: [] });
      await expect(runRole(app, { role: "reviewer", spaceId: "personal", task: "核对", runId: null, execution: { ...choice, model: "removed-model", effort: undefined } })).rejects.toThrow(/不可用/);
      saveProbe(app, "second", { at: new Date().toISOString(), agent: "second", models: ["m1", "m2", "m3"], efforts: ["xhigh"] });
      const result = await callTool({ app, runId: null, spaceId: "personal", spaces: null, tools: null, actor: "agent" }, "ask_agent", { name: "specialist", question: "检查", execution: choice });
      expect(result.isError).toBe(false); expect(result.text).toContain("queued-ok m3");
      expect(listRuns(app, { kind: "agent" }).some((r) => (r.input.execution as Execution)?.model === "m3")).toBe(true);
    } finally { await server.close(); }
  }, 60000);
});
