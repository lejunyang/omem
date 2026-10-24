import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { App } from "../src/core/app.ts";

type Request = { method: string; url: string; data?: any; params?: any };
type Event = { event_type: string; content: string };
const app = {} as App;
let cot: typeof import("../src/channels/lark-cot.ts");
let requests: Request[];
let respond: (r: Request) => Promise<any>;
let info: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;
const accepted = (r: Request) => r.method === "POST" && !r.url.includes("/complete/")
  ? { code: 0, data: { cot_id: "cot_test", message_id: "om_test" } } : { code: 0 };
const events = (): Event[] => requests.flatMap((r) => r.data?.events ?? []);
const types = () => events().map((e) => e.event_type);
const text = () => events().filter((e) => e.event_type === "REASONING_MESSAGE_CONTENT").map((e) => JSON.parse(e.content).delta).join("");
function holdNextPut() {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let first = true;
  respond = async (r) => {
    if (r.method === "PUT" && first) { first = false; await held; }
    return accepted(r);
  };
  return release;
}
function start(title = "开始") {
  expect(cot.startCot(app, "run_test", { chatId: "oc_test", title })).toBe(true);
}
const delta = (value: string) => cot.cotEvent(app, "run_test", { type: "text-delta", data: { text: value } });
const tool = (status: string) => cot.cotEvent(app, "run_test", { type: "tool", data: { id: "tool_test", kind: "read", input: "PRIVATE_ARGS", status } });
function expectClosed() {
  const open = new Set<string>();
  for (const e of events()) {
    const data = JSON.parse(e.content);
    if (e.event_type === "REASONING_MESSAGE_START") {
      expect(open.has(data.messageId)).toBe(false);
      open.add(data.messageId);
    }
    if (e.event_type === "REASONING_MESSAGE_CONTENT") expect(open.has(data.messageId)).toBe(true);
    if (e.event_type === "REASONING_MESSAGE_END") expect(open.delete(data.messageId)).toBe(true);
    if (e.event_type === "RUN_FINISHED") expect(open.size).toBe(0);
  }
  expect(open.size).toBe(0);
  expect(types().filter((t) => t === "RUN_FINISHED")).toHaveLength(1);
}
const logs = () => [...info.mock.calls, ...warn.mock.calls].map(([line]) => JSON.parse(String(line).split("lark-cot ")[1]));

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  info = vi.spyOn(console, "info").mockImplementation(() => {});
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  requests = [];
  respond = async (r) => accepted(r);
  cot = await import("../src/channels/lark-cot.ts");
  cot.setCotSdk({ request: async (r) => { requests.push(structuredClone(r)); return respond(r); } });
});
afterEach(() => {
  cot.setCotSdk(null);
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("drains text arriving during an upload without needing another input event", async () => {
  const release = holdNextPut();
  start();
  await vi.advanceTimersByTimeAsync(300);
  delta("末尾文字");
  release();
  await vi.advanceTimersByTimeAsync(700);
  expect(text()).toBe("开始\n\n末尾文字");
  expect(types()).not.toContain("RUN_FINISHED");
  cot.finishCot(app, "run_test", true);
  await vi.advanceTimersByTimeAsync(700);
  expectClosed();
});

it("flushes the final delta and closes its reasoning node before finishing an in-flight upload", async () => {
  const release = holdNextPut();
  start();
  await vi.advanceTimersByTimeAsync(300);
  delta("最后一段");
  cot.finishCot(app, "run_test", true);
  release();
  await vi.advanceTimersByTimeAsync(0);
  expect(text()).toBe("开始\n\n最后一段");
  expectClosed();
  const count = requests.length;
  cot.finishCot(app, "run_test", true);
  delta("已结束后的迟到事件");
  await vi.advanceTimersByTimeAsync(120_000);
  expect(requests).toHaveLength(count);
  expect(cot.hasCot("run_test")).toBe(false);
});

it("opens a new reasoning node for text arriving while the prior node's END is uploading", async () => {
  const release = holdNextPut();
  start();
  cot.finishCot(app, "run_test", true);
  await vi.advanceTimersByTimeAsync(300);
  delta("迟到的正文");
  release();
  await vi.advanceTimersByTimeAsync(0);
  expect(text()).toBe("开始\n\n迟到的正文");
  expectClosed();
});

it("drains new tools and their results before the terminal event", async () => {
  const release = holdNextPut();
  start();
  await vi.advanceTimersByTimeAsync(300);
  tool("running");
  cot.finishCot(app, "run_test", true);
  tool("completed");
  release();
  await vi.advanceTimersByTimeAsync(0);
  expectClosed();
  expect(types().indexOf("TOOL_CALL_START")).toBeLessThan(types().indexOf("TOOL_CALL_END"));
  expect(types().indexOf("TOOL_CALL_RESULT")).toBeLessThan(types().indexOf("RUN_FINISHED"));
});

it("waits for a late tool result and clears the fallback after completion", async () => {
  start(); tool("running"); cot.finishCot(app, "run_test", true);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(types()).not.toContain("RUN_FINISHED");
  tool("done");
  await vi.advanceTimersByTimeAsync(700);
  expectClosed();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(logs().some((l) => l.action === "settle-timeout")).toBe(false);
});

it("preserves a failed turn across repeated finish calls and completes it once", async () => {
  start();
  cot.finishCot(app, "run_test", false);
  cot.finishCot(app, "run_test", true);
  await vi.advanceTimersByTimeAsync(700);
  expect(types()).toContain("REASONING_MESSAGE_END");
  expect(types()).toContain("REASONING_END");
  expect(types()).not.toContain("RUN_FINISHED");
  expect(requests.filter((r) => r.url.includes("/complete/"))).toHaveLength(1);
  expect(logs()).toContainEqual(expect.objectContaining({ action: "settled", outcome: "error" }));
  const count = requests.length;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(requests).toHaveLength(count);
});

it("ends a missing tool result after 30 seconds without renewing the deadline", async () => {
  start(); tool("running"); cot.finishCot(app, "run_test", true);
  await vi.advanceTimersByTimeAsync(20_000);
  cot.finishCot(app, "run_test", true);
  await vi.advanceTimersByTimeAsync(9999);
  expect(types()).not.toContain("RUN_FINISHED");
  await vi.advanceTimersByTimeAsync(2);
  expectClosed();
  const result = events().find((e) => e.event_type === "TOOL_CALL_RESULT")!;
  expect(JSON.parse(JSON.parse(result.content).content).code).toBe("未收到工具完成事件");
  expect(logs()).toContainEqual(expect.objectContaining({ action: "settle-timeout", missingTools: 1 }));
  const count = requests.length;
  await vi.advanceTimersByTimeAsync(120_000);
  expect(requests).toHaveLength(count);
});

it("keeps long content and multi-batch uploads ordered while finish arrives", async () => {
  const release = holdNextPut();
  start("");
  delta("文".repeat(60_000));
  await vi.advanceTimersByTimeAsync(300);
  delta("结尾"); cot.finishCot(app, "run_test", true);
  release();
  await vi.advanceTimersByTimeAsync(0);
  expect(text()).toBe("文".repeat(60_000) + "结尾");
  expectClosed();
  expect(requests.filter((r) => r.method === "PUT").every((r) => r.data.events.length <= 50)).toBe(true);
  expect(events().filter((e) => e.event_type === "REASONING_MESSAGE_CONTENT").every((e) => JSON.parse(e.content).delta.length <= 1000)).toBe(true);
});

it.each(["create", "append", "finish", "complete"])("records %s failures with correlation and no payload", async (phase) => {
  respond = async (r) => {
    const current = r.url.includes("/complete/") ? "complete" : r.method === "POST" ? "create" : r.data.events.some((e: Event) => e.event_type === "REASONING_END") ? "finish" : "append";
    if (current === phase) throw Object.assign(new Error("PRIVATE_BODY"), { response: { status: 400, data: { code: 41050, msg: "invalid event[2] PRIVATE_BODY", log_id: "TEST_TRACE" } }, config: { headers: { Authorization: "PRIVATE_TOKEN" } } });
    return accepted(r);
  };
  start("PRIVATE_REASONING"); tool("done"); cot.finishCot(app, "run_test", phase !== "complete");
  await vi.advanceTimersByTimeAsync(700);
  const records = logs();
  expect(records).toContainEqual(expect.objectContaining({ action: "rejected", phase, runId: "run_test", requestSeq: expect.any(Number), httpStatus: 400, code: 41050, logId: "TEST_TRACE", reason: "invalid-data", eventIndex: "2" }));
  if (phase !== "create") expect(records).toContainEqual(expect.objectContaining({ action: "rejected", cotId: "cot_test", messageId: "om_test" }));
  expect(JSON.stringify(records)).not.toMatch(/PRIVATE_|oc_test/);
  expect(cot.startCot(app, "run_next", { chatId: "oc_test" })).toBe(true);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(cot.hasCot("run_test")).toBe(false);
});

it("recognizes business-response content limits and logs cleanup failures separately", async () => {
  respond = async (r) => {
    if (r.method === "PUT") return { code: 41050, msg: "event[3] content too long PRIVATE_BODY", log_id: "TEST_LIMIT" };
    if (r.method === "DELETE") throw Object.assign(new Error("timeout PRIVATE_BODY"), { code: "ETIMEDOUT" });
    return accepted(r);
  };
  start();
  await vi.advanceTimersByTimeAsync(300);
  expect(logs()).toContainEqual(expect.objectContaining({ action: "rejected", phase: "append", reason: "content-too-long", logId: "TEST_LIMIT", eventIndex: "3", eventTypes: expect.any(Array), contentBytes: expect.any(Array) }));
  expect(logs()).toContainEqual(expect.objectContaining({ action: "rejected", phase: "cleanup", code: "ETIMEDOUT" }));
  expect(logs()).toContainEqual(expect.objectContaining({ action: "disabled", reason: "content-too-long", cooldownMs: 0 }));
  expect(JSON.stringify(logs())).not.toContain("PRIVATE_");
  expect(cot.startCot(app, "run_next", { chatId: "oc_test" })).toBe(true);
});

it("recalls a broken bubble without reporting task failure or cooling down the next turn", async () => {
  const { testApp } = await import("./helpers.ts");
  const { createRun, getRun } = await import("../src/agents/runs.ts");
  const real = testApp();
  const r = createRun(real, { kind: "agent", title: "处理消息", input: {} });
  real.db.prepare("update runs set status='running' where id=?").run(r.id);
  respond = async (req) => {
    if (req.method === "PUT") throw Object.assign(new Error("timeout"), { code: "ECONNABORTED" });
    return accepted(req);
  };
  cot.startCot(real, r.id, { chatId: "oc_test", title: "处理消息" });
  await vi.advanceTimersByTimeAsync(300);
  expect(requests.some((req) => req.method === "DELETE" && req.url.endsWith("/messages/om_test"))).toBe(true);
  expect(requests.some((req) => req.url.includes("/complete/"))).toBe(false);
  expect(getRun(real, r.id)).toMatchObject({ status: "running", error: null, output: { thinkingDelivery: { status: "failed", reason: "timeout" } } });
  expect(cot.startCot(real, "next", { chatId: "oc_test" })).toBe(true);
  real.db.close();
});

it("limits an authority cooldown to the affected chat", async () => {
  respond = async () => ({ code: 41050, msg: "no user authority error" });
  start();
  await vi.advanceTimersByTimeAsync(300);
  expect(cot.startCot(app, "same", { chatId: "oc_test" })).toBe(false);
  expect(cot.startCot(app, "other", { chatId: "oc_other" })).toBe(true);
  await vi.advanceTimersByTimeAsync(30 * 60_000);
  expect(cot.startCot(app, "after", { chatId: "oc_test" })).toBe(true);
});

it("a deferred bubble that ends quiet is never created", async () => {
  expect(cot.startCot(app, "run_test", { chatId: "oc_test", title: "复查", defer: true })).toBe(true);
  delta("看了最新窗口，没有变化");
  tool("completed");
  await vi.advanceTimersByTimeAsync(5000);
  expect(requests).toHaveLength(0);
  await cot.endCot(app, "run_test", { ok: true, quiet: true });
  expect(requests).toHaveLength(0);
  expect(logs().map((l) => l.action)).toContain("discarded");
});

it("a deferred bubble with something to say is sent whole and settled before endCot returns", async () => {
  expect(cot.startCot(app, "run_test", { chatId: "oc_test", title: "复查", defer: true })).toBe(true);
  delta("错误率回升");
  tool("completed");
  await vi.advanceTimersByTimeAsync(5000);
  expect(requests).toHaveLength(0);
  const ended = cot.endCot(app, "run_test", { ok: true });
  await vi.advanceTimersByTimeAsync(1000);
  await ended;
  expect(requests[0].method).toBe("POST");
  expect(text()).toContain("错误率回升");
  expectClosed();
});

it("a live bubble whose turn ends quiet is recalled", async () => {
  start();
  delta("查看中");
  await vi.advanceTimersByTimeAsync(1000);
  expect(types()).toContain("RUN_STARTED");
  cot.finishCot(app, "run_test", true, true);
  await vi.advanceTimersByTimeAsync(1000);
  expect(requests.at(-1)).toMatchObject({ method: "DELETE", url: "/open-apis/im/v1/messages/om_test" });
  expect(types()).not.toContain("RUN_FINISHED");
});
