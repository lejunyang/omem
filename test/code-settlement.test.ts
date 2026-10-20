import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { testApp } from "./helpers.ts";
import { run } from "../src/core/db.ts";
import { createThread } from "../src/agents/threads.ts";
import { codeChainFor, settleCodeChain, trySettleCodeChain } from "../src/agents/code-chain.ts";
import { cancelRun, createRun, getRun, registerHandler, startWorker, waitForRun } from "../src/agents/runs.ts";

const app = testApp();
let warn: ReturnType<typeof vi.spyOn>;
beforeAll(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "setTimeout", "clearInterval", "clearTimeout"] });
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  // Exercise the real scheduler with deterministic local code handlers, no Agent or network.
  registerHandler("code", async ({ run }) => {
    if (run.input.fail) throw new Error("coder failure");
    return { verdict: "approved", review: "结论：通过" };
  });
  startWorker(app);
  app.db.exec(`create trigger reject_code_handoff before insert on messages
    when json_extract(new.meta,'$.codeResult') is not null
    begin select raise(abort,'private handoff failure'); end`);
});
afterAll(() => { vi.clearAllTimers(); vi.useRealTimers(); warn.mockRestore(); app.db.close(); });
function fixture(fail = false) {
  const thread = createThread(app, { spaceId: "personal", channel: "web", userId: "owner" });
  const ask = createRun(app, { kind: "ask", title: "原交办", input: { conversationId: thread.id } });
  run(app.db, "update runs set status='done' where id=?", ask.id);
  const code = createRun(app, { kind: "code", title: "编码", parentId: ask.id, input: { task: "修改", fail } });
  codeChainFor(app, code);
  return { ask, code };
}
it("keeps an approved run done and emits its terminal event when handoff writing fails", async () => {
  const { code } = fixture();
  const terminal = vi.fn();
  app.events.on("event", terminal);
  const result = await waitForRun(app, code.id);
  app.events.off("event", terminal);
  expect(result).toMatchObject({ status: "done", error: null, output: { verdict: "approved" } });
  expect(terminal).toHaveBeenCalledWith({ type: "run", runId: code.id, status: "done" });
  expect(result.output.codeResultMessageId).toBeUndefined();
  expect(trySettleCodeChain(app, code.id)).toBe(false);
  expect(getRun(app, code.id)).toMatchObject({ status: "done", error: null });
  expect(JSON.stringify(warn.mock.calls)).not.toContain("private handoff failure");
});
it("preserves the original coder error and delivers failed when settlement also fails", async () => {
  const { code } = fixture(true);
  const terminal = vi.fn();
  app.events.on("event", terminal);
  const result = await waitForRun(app, code.id);
  app.events.off("event", terminal);
  expect(result).toMatchObject({ status: "failed", error: "coder failure" });
  expect(terminal).toHaveBeenCalledWith({ type: "run", runId: code.id, status: "failed" });
});
it("cancels a queued run and emits cancelled even when its handoff fails", () => {
  const { code } = fixture();
  const terminal = vi.fn();
  app.events.on("event", terminal);
  expect(() => cancelRun(app, code.id)).not.toThrow();
  app.events.off("event", terminal);
  expect(getRun(app, code.id)).toMatchObject({ status: "cancelled", error: null });
  expect(terminal).toHaveBeenCalledWith({ type: "run", runId: code.id, status: "cancelled" });
});
it("can retry bookkeeping idempotently after the fault is removed and clears stale approval wait state", async () => {
  const { ask, code } = fixture();
  await waitForRun(app, code.id);
  app.db.exec("drop trigger reject_code_handoff");
  run(app.db, "update runs set output=json_set(output,'$.codeChain.awaitingUser',json('true'),'$.codeChain.waitReason','auto-limit') where id in (?,?)", ask.id, code.id);
  settleCodeChain(app, code.id);
  const messageId = getRun(app, code.id).output.codeResultMessageId;
  expect(messageId).toBeTruthy();
  settleCodeChain(app, code.id);
  expect(getRun(app, code.id).output.codeResultMessageId).toBe(messageId);
  expect(getRun(app, ask.id).output.codeChain).toMatchObject({ awaitingUser: false });
  expect((getRun(app, ask.id).output.codeChain as any).waitReason).toBeUndefined();
  expect(getRun(app, code.id)).toMatchObject({ status: "done", error: null });
});
it("wakes the assistant once in the asking conversation when the chain stops, without coding tools", async () => {
  const { code } = fixture();
  await waitForRun(app, code.id);
  trySettleCodeChain(app, code.id);
  trySettleCodeChain(app, code.id);
  const wakes = app.db.prepare("select input, lane from runs where kind = 'ask' and json_extract(input, '$.handoff.runId') = ?").all(code.id) as { input: string; lane: string }[];
  expect(wakes).toHaveLength(1);
  const input = JSON.parse(wakes[0].input);
  expect(wakes[0].lane).toBe(input.conversationId);
  expect(input.messageIds).toEqual([getRun(app, code.id).output.codeResultMessageId]);
  expect(input.denyTools).toEqual(expect.arrayContaining(["delegate_code", "continue_code_run", "apply_code_run"]));
});
