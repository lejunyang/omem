import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRun } from "../src/agents/runs.ts";
import { cotEvent, finishCot, setCotSdk } from "../src/channels/lark-cot.ts";
import { startReplyProgress } from "../src/channels/lark-progress.ts";
import { setLarkClient } from "../src/channels/lark-send.ts";
import { testApp } from "./helpers.ts";

let app: ReturnType<typeof testApp>;
let replies: any[];
let patches: any[];
let removed: number;
let reply: () => Promise<any>;
let reaction: () => Promise<any>;
const at = { chatId: "oc_test", messageId: "om_question", inThread: true };
function task(status = "running") {
  const r = createRun(app, { kind: "ask", title: "问题", input: {} });
  app.db.prepare("update runs set status=? where id=?").run(status, r.id);
  return r.id;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  app = testApp(); replies = []; patches = []; removed = 0;
  reply = async () => ({ code: 0, data: { message_id: "om_progress" } });
  reaction = async () => ({ code: 0, data: { reaction_id: "reaction" } });
  setLarkClient({ im: {
    message: { reply: async (args: any) => { replies.push(args); return reply(); }, patch: async (args: any) => { patches.push(args); return { code: 0 }; } },
    messageReaction: { create: () => reaction(), delete: async () => { removed++; return { code: 0 }; } },
  } });
});
afterEach(() => {
  setCotSdk(null); setLarkClient(null);
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); app.db.close();
});

it("waits for a late fallback card and reaction before settling the answer", async () => {
  let releaseCard!: () => void;
  let releaseReaction!: () => void;
  reply = async () => { await new Promise<void>((resolve) => { releaseCard = resolve; }); return { code: 0, data: { message_id: "om_progress" } }; };
  reaction = async () => { await new Promise<void>((resolve) => { releaseReaction = resolve; }); return { code: 0, data: { reaction_id: "reaction" } }; };
  const p = startReplyProgress(app, at, task());
  let settled = false;
  const closing = p.close().then(async (card) => { settled = true; await card!.finish("最终答案"); });
  await vi.advanceTimersByTimeAsync(0);
  expect(settled).toBe(false);
  reaction = async () => ({ code: 0, data: { reaction_id: "done" } });
  releaseReaction(); releaseCard();
  await closing;
  expect(replies).toHaveLength(1);
  expect(patches[0].data.content).toContain("最终答案");
  expect(removed).toBe(1);
  expect(app.events.listenerCount("event")).toBe(0);
});

it("shows no fallback for a healthy bubble and clears its delayed work on close", async () => {
  setCotSdk({ request: async (req) => req.method === "POST" ? { code: 0, data: { cot_id: "cot_progress", message_id: "om_native" } } : { code: 0 } });
  const id = task();
  const p = startReplyProgress(app, at, id);
  await vi.advanceTimersByTimeAsync(16_000);
  expect(replies).toHaveLength(0);
  finishCot(app, id, true);
  expect(await p.close()).toBeNull();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(replies).toHaveLength(0);
  expect(removed).toBe(1);
  expect(app.events.listenerCount("event")).toBe(0);
});

it("falls back once if the native bubble fails after its first successful upload", async () => {
  let failed = false;
  setCotSdk({ request: async (req) => {
    if (req.method === "POST") return { code: 0, data: { cot_id: "cot_late", message_id: "om_native" } };
    if (failed && req.method === "PUT") throw new Error("timeout");
    return { code: 0 };
  } });
  const id = task();
  const p = startReplyProgress(app, at, id);
  await vi.advanceTimersByTimeAsync(16_000);
  failed = true;
  cotEvent(app, id, { type: "thought-delta", data: { text: "PRIVATE_REASONING" } });
  await vi.advanceTimersByTimeAsync(30_000);
  expect(replies).toHaveLength(1);
  expect(replies[0].data.content).not.toContain("PRIVATE_REASONING");
  await (await p.close())!.fail("实际任务失败");
  expect(patches[0].data.content).toContain("实际任务失败");
});

it("never starts presentation for a queued turn closed before it runs", async () => {
  const id = task("queued");
  const p = startReplyProgress(app, at, id);
  expect(await p.close()).toBeNull();
  app.emit({ type: "run", runId: id, status: "running" });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(replies).toHaveLength(0);
  expect(app.events.listenerCount("event")).toBe(0);
});
