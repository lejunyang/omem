import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { mayStayQuiet } from "../src/agents/quiet.ts";
import { loadRole } from "../src/agents/runner.ts";
import { createRun, getRun, runEvents, waitForRun, type Run } from "../src/agents/runs.ts";
import { saveAgentSpec } from "../src/agents/specs.ts";
import { releaseAll } from "../src/agents/sessions.ts";
import { addMessage, createThread, threadMessages, updateThread } from "../src/agents/threads.ts";
import { expandTools } from "../src/agents/tool-help.ts";
import { callTool, issueToolToken, toolContextForToken } from "../src/agents/tools.ts";
import { one, run } from "../src/core/db.ts";
import { newId } from "../src/core/util.ts";
import { boot } from "../src/main.ts";
import { testApp } from "./helpers.ts";

const fake = (id: string, env: Record<string, string>) => ({ id, transport: "acp", command: process.execPath, args: [resolve("test/fake-acp-agent.ts")], env });

describe("which runs may end saying nothing", () => {
  const app = testApp();
  afterAll(() => app.db.close());
  const t = createThread(app, { spaceId: "personal", channel: "web", userId: "owner" });
  // Rows only: createRun would hand them to the run worker the booted app below has started, and
  // they would still be running against this database when it closes.
  const held = (kind: string, input: Record<string, unknown> = {}) => {
    const id = newId("r");
    run(app.db, "insert into runs(id,kind,space_id,status,title,input,created_at) values(?,?,?,?,?,?,?)", id, kind, "personal", "done", kind, JSON.stringify(input), new Date().toISOString());
    return getRun(app, id);
  };
  const turn = (messages: { role: "user" | "assistant"; meta?: Record<string, unknown> }[], input: Record<string, unknown> = {}) => {
    const ids = messages.map((m) => addMessage(app, t.id, m.role, "消息", null, m.meta ?? {}));
    return held("ask", { conversationId: t.id, messageIds: ids, ...input });
  };
  const may = (r: Run) => mayStayQuiet(app, r);

  it("only runs nobody waits on", () => {
    // Someone's message to it: an answer is owed.
    expect(may(turn([{ role: "user" }]))).toBe(false);
    expect(may(turn([{ role: "user" }, { role: "assistant", meta: { wake: { note: "复查" } } }], { wake: true }))).toBe(false);
    expect(may(turn([{ role: "user" }], { fromAsk: true }))).toBe(false);
    expect(may(turn([{ role: "assistant", meta: { codeResult: "r_x" } }], { handoff: { kind: "code" } }))).toBe(false);
    // Its own wake-up, a watched group's batch, tasks a delegation handed back.
    expect(may(turn([{ role: "assistant", meta: { wake: { note: "复查" } } }], { wake: true }))).toBe(true);
    expect(may(turn([{ role: "user", meta: { speaker: "小王" } }, { role: "user", meta: { speaker: "小李" } }]))).toBe(true);
    expect(may(turn([{ role: "assistant", meta: { codeTasks: "r_x" } }], { handoff: { kind: "code-tasks" } }))).toBe(true);
    // Agent runs: a rule's, a wake-up's, a silent check, a meeting; not a delegated round someone waits for.
    const agent = (input: Record<string, unknown>) => held("agent", { spec: "assistant", task: "t", ...input });
    for (const input of [{ rule: { id: "x", name: "x" } }, { wake: true }, { silent: { chatId: "oc_g" } }, { meeting: { id: "m1" } }]) expect(may(agent(input))).toBe(true);
    expect(may(agent({ threadId: t.id }))).toBe(false);
    // Background roles yes; a guest's question no.
    expect(may(held("heartbeat"))).toBe(true);
    expect(may(held("guest"))).toBe(false);
  });

  it("the tool refuses a turn answering someone and records the reason where it may", async () => {
    const ctxFor = (runId: string) => toolContextForToken(app, issueToolToken({ runId, spaceId: "personal", spaces: null, tools: null, actor: "agent" }))!;
    const answering = turn([{ role: "user" }]);
    const refused = await callTool(ctxFor(answering.id), "stay_quiet", { reason: "不想回" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("不能不回");
    expect(getRun(app, answering.id).output.stayQuiet).toBeUndefined();
    const check = held("heartbeat");
    expect((await callTool(ctxFor(check.id), "stay_quiet", { reason: "事项都没有新变化" })).isError).toBeFalsy();
    expect(getRun(app, check.id).output.stayQuiet).toBe("事项都没有新变化");
  });

  it("comes with the roles that may use it, never with a tool group to the guest", () => {
    expect(expandTools(["group:ask"])).toContain("stay_quiet");
    for (const role of ["heartbeat", "ingest", "distiller", "triager", "coach", "curator", "item-keeper", "memory-organizer", "wiki-linter", "wiki-organizer"]) expect(loadRole(role).tools).toContain("stay_quiet");
    for (const role of ["guest", "gatekeeper", "summarizer"]) expect(loadRole(role).tools).not.toContain("stay_quiet");
  });
});

describe("staying quiet end to end", async () => {
  const home = mkdtempSync(join(tmpdir(), "omem-quiet-"));
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({ agents: { default: "fake", profiles: [fake("fake", { FAKE_MODE: "thread" }), fake("quiet", { FAKE_SAY: "没有新变化。", FAKE_QUIET: "查过了，没有新变化" }), fake("emptyq", { FAKE_SAY: "没有新变化。", FAKE_QUIET: "查过了，没有新变化", FAKE_EMPTY_STREAM: "1" })] }, sessions: { mergeMs: 0 } }),
  );
  const { app, server } = await boot(home, { port: 0, quiet: true, background: false });
  afterAll(() => {
    releaseAll();
    server.close();
  });
  const t = createThread(app, { spaceId: "personal", channel: "web", userId: "owner" });
  updateThread(app, t.id, { settings: { profile: "quiet" } });
  const replies = () => threadMessages(app, t.id).filter((m) => m.role === "assistant" && !m.meta.wake);

  it("a wake-up turn that stays quiet posts nothing and leaves the run list", async () => {
    const note = addMessage(app, t.id, "assistant", "助理设的唤醒到了。备注：看看 CI 跑完没有", null, { wake: { note: "看看 CI" }, record: true });
    const r = createRun(app, { kind: "ask", spaceId: "personal", title: "唤醒", input: { conversationId: t.id, messageIds: [note], wake: true }, lane: t.id });
    const done = await waitForRun(app, r.id);
    expect(done.status).toBe("done");
    expect(done.output).toMatchObject({ quiet: true, stayQuiet: "查过了，没有新变化" });
    expect(one<{ quiet: number }>(app.db, "select quiet from runs where id = ?", r.id)?.quiet).toBe(1);
    expect(replies()).toHaveLength(0);
  }, 60_000);

  it("a turn answering the owner cannot stay quiet: the answer goes out", async () => {
    const message = addMessage(app, t.id, "user", "CI 跑完了吗？", null, {});
    const r = createRun(app, { kind: "ask", spaceId: "personal", title: "问", input: { conversationId: t.id, messageIds: [message] }, lane: t.id });
    const done = await waitForRun(app, r.id);
    expect(done.output.quiet).toBeUndefined();
    expect(done.output.stayQuiet).toBeUndefined();
    const answer = replies().at(-1)!;
    expect(answer.text).toContain("stay_quiet 不能用");
    expect(answer.text).toContain("没有新变化。");
  }, 60_000);

  // Some providers fail the empty final message after stay_quiet ("llm response empty stream"): the
  // work was done, so the run is too — not failed, and not redone on another backend.
  it("a quiet turn whose backend fails only on its empty last message is done", async () => {
    const q = createThread(app, { spaceId: "personal", channel: "web", userId: "owner" });
    updateThread(app, q.id, { settings: { profile: "emptyq" } });
    const note = addMessage(app, q.id, "assistant", "助理设的唤醒到了。备注：看看 CI", null, { wake: { note: "看看 CI" }, record: true });
    const r = createRun(app, { kind: "ask", spaceId: "personal", title: "唤醒", input: { conversationId: q.id, messageIds: [note], wake: true }, lane: q.id });
    const done = await waitForRun(app, r.id);
    expect(done.error).toBeNull();
    expect(done.status).toBe("done");
    expect(done.output).toMatchObject({ quiet: true, stayQuiet: "查过了，没有新变化" });
    expect(runEvents(app, r.id).some((e) => e.type === "status" && /按已完成处理/.test(String((e.data as { text?: string }).text)))).toBe(true);
  }, 60_000);

  it("so is an Agent 档案 run that stays quiet the same way", async () => {
    saveAgentSpec(app, { name: "watcher-a", description: "看看", prompt: "看看", status: "active", agent: "emptyq" }, "user");
    const r = createRun(app, { kind: "agent", spaceId: "personal", title: "唤醒", input: { spec: "watcher-a", task: "看看 CI 跑完没有", wake: true } });
    const done = await waitForRun(app, r.id);
    expect(done.error).toBeNull();
    expect(done.status).toBe("done");
    expect(done.output.stayQuiet).toBe("查过了，没有新变化");
    expect(runEvents(app, r.id).some((e) => e.type === "status" && /按已完成处理/.test(String((e.data as { text?: string }).text)))).toBe(true);
  }, 60_000);
});
