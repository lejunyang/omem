import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "../src/core/app.ts";
import { testApp } from "./helpers.ts";
import { run } from "../src/core/db.ts";
import { createThread, getThread, updateThread } from "../src/agents/threads.ts";
import { createRun, getRun, setRunOutput } from "../src/agents/runs.ts";
import { codeChainFor, queueNextCodeRound } from "../src/agents/code-chain.ts";
import { flushCodeProgress, retryCodeProgress, registerCodeProgress, settleCodeChain, startCodeProgress } from "../src/channels/lark-code-progress.ts";
import { setLarkClient } from "../src/channels/lark-send.ts";
let app: ReturnType<typeof testApp>;
let dispose: (() => void) | undefined;
const reply = vi.fn();
const patch = vi.fn();
const list = vi.fn();
beforeEach(() => {
  vi.useFakeTimers();
  app = testApp();
  reply.mockReset().mockResolvedValue({ code: 0, data: { message_id: "om_card" } });
  patch.mockReset().mockResolvedValue({ code: 0 });
  list.mockReset().mockResolvedValue({ code: 0, data: { items: [{ message_id: "om_topic_anchor" }] } });
  setLarkClient({ im: { message: { reply, patch, list } } });
});
afterEach(() => { dispose?.(); dispose = undefined; vi.clearAllTimers(); vi.useRealTimers(); setLarkClient(null); app.db.close(); });
function fixture() {
  const t = createThread(app, { spaceId: "personal", channel: "lark", key: "oc_example#omt_example", userId: "owner" });
  updateThread(app, t.id, { settings: { ...t.settings, lastMessageId: "om_original" } });
  const ask = createRun(app, { kind: "ask", title: "实现", input: { conversationId: t.id } });
  const code = createRun(app, { kind: "code", title: "实现", parentId: ask.id, input: { task: "修复", round: 1 } });
  run(app.db, "update runs set status='running' where id=?", code.id);
  return { t, ask, code, chain: codeChainFor(app, getRun(app, code.id))! };
}
it("persists sanitized creation failure, retries the same topic with a stable UUID and leaves the original anchor intact", async () => {
  const { t, ask, chain } = fixture();
  reply.mockRejectedValueOnce(new Error("token=SECRET oc_private private text"));
  await flushCodeProgress(app, ask.id);
  expect(getRun(app, ask.id).output.codeProgress).toMatchObject({ status: "failed", attempts: 1, operation: "create" });
  expect(JSON.stringify(getRun(app, ask.id).output)).not.toContain("SECRET");
  startCodeProgress(app, chain); // repeated start must not block eventual recovery
  await vi.advanceTimersByTimeAsync(3000);
  await flushCodeProgress(app, ask.id);
  expect(reply).toHaveBeenCalledTimes(2);
  expect(reply.mock.calls[0][0]).toEqual(reply.mock.calls[1][0]);
  expect(reply.mock.calls[1][0]).toMatchObject({ path: { message_id: "om_topic_anchor" }, data: { reply_in_thread: true } });
  expect(getThread(app, t.id).settings.lastMessageId).toBe("om_original");
  expect(getRun(app, ask.id).output.codeChain).toMatchObject({ larkMessageId: "om_card" });
});
it("recovers a failed terminal update on restart and deduplicates completed snapshots", async () => {
  const { ask, code } = fixture();
  await flushCodeProgress(app, ask.id);
  setRunOutput(app, code.id, { review: "结论：要求修改。还有两处问题", verdict: "changes-requested" });
  run(app.db, "update runs set status='done' where id=?", code.id);
  patch.mockRejectedValueOnce(Object.assign(new Error("secret"), { code: 230001 }));
  await flushCodeProgress(app, ask.id);
  expect(getRun(app, ask.id).output.codeProgress).toMatchObject({ status: "failed", operation: "update", error: "飞书 API 错误 230001" });
  // All in-memory workers are gone; registration rebuilds solely from DB.
  dispose = registerCodeProgress(app);
  await vi.advanceTimersByTimeAsync(3000);
  await flushCodeProgress(app, ask.id);
  expect(patch).toHaveBeenCalledTimes(2);
  expect(patch.mock.calls[1][0].data.content).toContain("还有两处问题");
  await flushCodeProgress(app, ask.id);
  expect(patch).toHaveBeenCalledTimes(2);
  expect(reply).toHaveBeenCalledTimes(1);
  expect(getRun(app, ask.id).output.codeChain).toMatchObject({ awaitingUser: true, waitReason: "review" });
});
it("creates a missing card after restart, keeps all round reviews and reopens after manual continuation", async () => {
  const { ask, code, chain } = fixture();
  setRunOutput(app, code.id, { review: "第一轮独立评审", verdict: "changes-requested" });
  const next = queueNextCodeRound(app, chain, "改")!;
  setRunOutput(app, next.run.id, { review: "第二轮独立评审", verdict: "approved" });
  run(app.db, "update runs set status='done' where id in (?,?)", code.id, next.run.id);
  // Terminal cards whose delivery failed must be restored too.
  setRunOutput(app, ask.id, { codeProgress: { status: "failed", attempts: 1 } });
  dispose = registerCodeProgress(app);
  await flushCodeProgress(app, ask.id);
  const content = reply.mock.calls[0][0].data.content;
  expect(content).toContain("第一轮独立评审"); expect(content).toContain("第二轮独立评审");
  await vi.advanceTimersByTimeAsync(3000);
  const third = queueNextCodeRound(app, next.chain, "新调整", { manual: true })!;
  await flushCodeProgress(app, ask.id);
  expect(patch.mock.calls.at(-1)![0].data.content).toContain("第 3 轮");
  expect(reply).toHaveBeenCalledTimes(1);
  expect(third.run.input.continueFrom).toBe(code.id);
});
it("limits retries and deduplicates concurrent creation", async () => {
  const { ask } = fixture();
  await Promise.all([flushCodeProgress(app, ask.id), flushCodeProgress(app, ask.id)]);
  expect(reply).toHaveBeenCalledTimes(1);
  setRunOutput(app, (getRun(app, ask.id).output.codeChain as any).lastCodeRunId, { review: "失败", verdict: "changes-requested" });
  patch.mockRejectedValue(new Error("private payload"));
  for (let i = 0; i < 8; i++) { await vi.advanceTimersByTimeAsync(60000); await flushCodeProgress(app, ask.id); }
  expect(patch).toHaveBeenCalledTimes(5);
  expect(getRun(app, ask.id).output.codeProgress).toMatchObject({ status: "failed", attempts: 5 });
});
it("does not fall out of an existing topic when anchor lookup fails", async () => {
  const { ask } = fixture();
  list.mockResolvedValue({ code: 230001 });
  await flushCodeProgress(app, ask.id);
  expect(reply).not.toHaveBeenCalled();
  expect(getRun(app, ask.id).output.codeProgress).toMatchObject({ status: "failed", operation: "anchor" });
});

it("rejects a stale automatic caller while a newer round is running with progress registered", async () => {
  const { chain, ask } = fixture();
  dispose = registerCodeProgress(app);
  await flushCodeProgress(app, ask.id);
  const second = queueNextCodeRound(app, chain, "第二轮")!;
  expect(second).not.toBeNull();
  run(app.db, "update runs set status='running' where id=?", second.run.id);
  expect(queueNextCodeRound(app, chain, "旧轮迟到的回调")).toBeNull();
  expect(getRun(app, ask.id).output.codeChain).toMatchObject({ round: 2 });
});
it("can explicitly retry an exhausted delivery without another coding round", async () => {
  const { ask, code } = fixture();
  reply.mockRejectedValue(new Error("timeout"));
  for (let i = 0; i < 5; i++) { await flushCodeProgress(app, ask.id); await vi.advanceTimersByTimeAsync(60000); }
  expect(reply).toHaveBeenCalledTimes(5);
  reply.mockResolvedValue({ code: 0, data: { message_id: "om_card" } });
  expect(await retryCodeProgress(app, ask.id)).toMatchObject({ status: "sent", attempts: 0 });
  expect((getRun(app, ask.id).output.codeChain as any).lastCodeRunId).toBe(code.id);
});
it("refreshes an explicitly rejected anchor and skips deleted topic messages", async () => {
  const { ask } = fixture();
  reply.mockResolvedValueOnce({ code: 230001, msg: "message unavailable" });
  await flushCodeProgress(app, ask.id);
  list.mockResolvedValue({ code: 0, data: { items: [{ message_id: "om_deleted", deleted: true }, { message_id: "om_fresh" }] } });
  await vi.advanceTimersByTimeAsync(3000);
  await flushCodeProgress(app, ask.id);
  expect(reply.mock.calls[1][0].path.message_id).toBe("om_fresh");
  expect(reply.mock.calls[1][0].data.reply_in_thread).toBe(true);
});
it("leases creation across two app instances sharing the database", async () => {
  const { ask } = fixture();
  const other = App.open(app.home);
  let release!: (v: unknown) => void;
  reply.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
  const first = flushCodeProgress(app, ask.id);
  await vi.waitFor(() => expect(reply).toHaveBeenCalledTimes(1));
  await flushCodeProgress(other, ask.id);
  expect(reply).toHaveBeenCalledTimes(1);
  release({ code: 0, data: { message_id: "om_card" } });
  await first;
  other.db.close();
});
it("uses an ordinary reply for a private chat based on chat_mode", async () => {
  const { ask, chain } = fixture();
  const privateChain = { ...chain, larkKey: "oc_private" };
  const { saveCodeChain } = await import("../src/agents/code-chain.ts");
  saveCodeChain(app, privateChain, ask.id, ...chain.rounds);
  setLarkClient({ im: { message: { reply, patch, list }, chat: { get: vi.fn().mockResolvedValue({ code: 0, data: { chat_mode: "p2p", chat_type: "private" } }) } } });
  await flushCodeProgress(app, ask.id);
  expect(reply.mock.calls[0][0].data.reply_in_thread).toBe(false);
});
it("recovers a creation accepted before process death without creating another card", async () => {
  const { ask } = fixture();
  setRunOutput(app, ask.id, { codeProgress: { status: "pending", operation: "create", attempts: 1, leaseUntil: Date.now() - 1 } });
  list.mockResolvedValue({ code: 0, data: { items: [{ message_id: "om_accepted", msg_type: "interactive", sender: { sender_type: "app" }, body: { content: `交办标识：${ask.id}` } }] } });
  await flushCodeProgress(app, ask.id);
  expect(reply).not.toHaveBeenCalled();
  expect(patch.mock.calls[0][0].path.message_id).toBe("om_accepted");
  expect(getRun(app, ask.id).output.codeChain).toMatchObject({ larkMessageId: "om_accepted" });
});
it("persists reconciliation pagination instead of repeatedly searching only the first page", async () => {
  const { ask } = fixture();
  setRunOutput(app, ask.id, { codeProgress: { status: "pending", operation: "create", attempts: 1 } });
  list.mockResolvedValueOnce({ code: 0, data: { items: [], has_more: true, page_token: "page-2" } });
  await flushCodeProgress(app, ask.id);
  expect(reply).not.toHaveBeenCalled();
  expect(getRun(app, ask.id).output.codeProgress).toMatchObject({ reconciliationPageToken: "page-2" });
  list.mockResolvedValueOnce({ code: 0, data: { items: [{ message_id: "om_old_card", msg_type: "interactive", sender: { sender_type: "app" }, body: { content: ask.id } }] } });
  await retryCodeProgress(app, ask.id);
  expect(list.mock.calls[1][0].params.page_token).toBe("page-2");
  expect(reply).not.toHaveBeenCalled();
  expect(patch.mock.calls[0][0].path.message_id).toBe("om_old_card");
});
it("gives an exhausted missing card one finite retry budget per startup", async () => {
  const { ask, code } = fixture();
  setRunOutput(app, ask.id, { codeProgress: { status: "failed", operation: "create", attempts: 5, checkpoint: `${code.id}:active` } });
  reply.mockRejectedValue(new Error("offline"));
  dispose = registerCodeProgress(app);
  await flushCodeProgress(app, ask.id);
  await vi.advanceTimersByTimeAsync(120000);
  expect(reply).toHaveBeenCalledTimes(5);
  expect(getRun(app, ask.id).output.codeProgress).toMatchObject({ attempts: 5, status: "failed" });
  await vi.advanceTimersByTimeAsync(60000);
  expect(reply).toHaveBeenCalledTimes(5); // polling must not replenish the budget
  dispose?.();
  reply.mockResolvedValue({ code: 0, data: { message_id: "om_recovered" } });
  dispose = registerCodeProgress(app);
  await flushCodeProgress(app, ask.id);
  expect(reply).toHaveBeenCalledTimes(6);
  expect(getRun(app, ask.id).output.codeChain).toMatchObject({ larkMessageId: "om_recovered" });
});
it.each(["recalled", "not-found"])("replaces a confirmed %s card with a new UUID in the original topic", async (reason) => {
  const { ask } = fixture();
  await flushCodeProgress(app, ask.id);
  const originalUuid = reply.mock.calls[0][0].data.uuid;
  if (reason === "recalled") patch.mockResolvedValueOnce({ code: 230011, msg: "The message is recalled." });
  else patch.mockRejectedValueOnce(Object.assign(new Error("Not Found"), { response: { status: 404 } }));
  await retryCodeProgress(app, ask.id); // explicit retry must verify even an unchanged snapshot
  expect(getRun(app, ask.id).output.codeChain).toMatchObject({ larkMessageId: null });
  expect(getRun(app, ask.id).output.codeProgress).toMatchObject({ cardGeneration: 1, operation: "create", status: "failed" });
  list.mockResolvedValue({ code: 0, data: { items: [
    { message_id: "om_card", deleted: true, msg_type: "interactive", sender: { sender_type: "app" }, body: { content: ask.id } },
    { message_id: "om_anchor" },
  ] } });
  reply.mockResolvedValueOnce({ code: 0, data: { message_id: "om_replacement" } });
  await retryCodeProgress(app, ask.id);
  expect(reply).toHaveBeenCalledTimes(2);
  expect(reply.mock.calls[1][0]).toMatchObject({ path: { message_id: "om_anchor" }, data: { reply_in_thread: true } });
  expect(reply.mock.calls[1][0].data.uuid).not.toBe(originalUuid);
  expect(getRun(app, ask.id).output.codeChain).toMatchObject({ larkMessageId: "om_replacement" });
});
it.each([230001, 230002, 230020])("keeps the card ID on API error %s rather than creating duplicates", async (code) => {
  const { ask } = fixture();
  await flushCodeProgress(app, ask.id);
  patch.mockResolvedValueOnce({ code, msg: "API error" });
  await retryCodeProgress(app, ask.id);
  expect(getRun(app, ask.id).output.codeChain).toMatchObject({ larkMessageId: "om_card" });
  expect(reply).toHaveBeenCalledTimes(1);
});
it("isolates a corrupt historical chain so later chains still recover on startup and polling", async () => {
  const broken = fixture();
  setRunOutput(app, broken.ask.id, { codeChain: { ...broken.chain, lastCodeRunId: "r_missing" } });
  const healthy = fixture();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect(() => { dispose = registerCodeProgress(app); }).not.toThrow();
    await flushCodeProgress(app, healthy.ask.id);
    expect(getRun(app, healthy.ask.id).output.codeChain).toMatchObject({ larkMessageId: "om_card" });
    await vi.advanceTimersByTimeAsync(3000);
    expect(reply).toHaveBeenCalledTimes(1);
  } finally { warn.mockRestore(); }
});
it("does not interrupt later event listeners and retries failed handoff after the final card was sent", async () => {
  const { ask, code } = fixture();
  setRunOutput(app, code.id, { verdict: "approved", review: "结论：通过" });
  run(app.db, "update runs set status='done' where id=?", code.id);
  setRunOutput(app, ask.id, { codeProgress: { status: "pending", attempts: 0 } });
  app.db.exec(`create trigger reject_handoff before insert on messages
    when json_extract(new.meta,'$.codeResult') is not null
    begin select raise(abort,'private failure'); end`);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const later = vi.fn();
  try {
    dispose = registerCodeProgress(app);
    app.events.on("event", later);
    expect(() => app.emit({ type: "run", runId: code.id, status: "done" })).not.toThrow();
    expect(later).toHaveBeenCalledWith({ type: "run", runId: code.id, status: "done" });
    await flushCodeProgress(app, ask.id);
    expect(getRun(app, ask.id).output.codeProgress).toMatchObject({ status: "sent" });
    expect(getRun(app, code.id).output.codeResultMessageId).toBeUndefined();
    app.db.exec("drop trigger reject_handoff");
    await vi.advanceTimersByTimeAsync(3000);
    expect(getRun(app, code.id).output.codeResultMessageId).toBeTruthy();
    expect(getRun(app, code.id)).toMatchObject({ status: "done", error: null });
    expect(reply).toHaveBeenCalledTimes(1);
    expect(patch).not.toHaveBeenCalled();
  } finally { app.events.off("event", later); warn.mockRestore(); }
});
it("shows a cancelled run as awaiting handling even if its review was already approved", async () => {
  const { ask, code } = fixture();
  setRunOutput(app, code.id, { verdict: "approved", review: "结论：通过" });
  run(app.db, "update runs set status='cancelled' where id=?", code.id);
  dispose = registerCodeProgress(app);
  await flushCodeProgress(app, ask.id);
  const card = reply.mock.calls[0][0].data.content;
  expect(card).toContain("运行cancelled，等本人处理");
  expect(card).not.toContain("完成，评审通过");
  expect(getRun(app, ask.id).output.codeChain).toMatchObject({ awaitingUser: true, waitReason: "failed" });
  const message = app.db.prepare("select text from messages where run_id=?").get(code.id) as { text: string };
  expect(message.text).toContain("已结束：cancelled");
  expect(message.text).toContain("等待本人处理");
});
