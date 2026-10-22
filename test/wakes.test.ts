import { describe, expect, it } from "vitest";
import { saveAgentSpec } from "../src/agents/specs.ts";
import { callTool, issueToolToken, toolContextForToken } from "../src/agents/tools.ts";
import { addMessage, createThread, threadMessages } from "../src/agents/threads.ts";
import { expireTemporaryRules, fireWake, pendingWakes, wakeTime, type WakeInput } from "../src/agents/wakes.ts";
import { all, one, run } from "../src/core/db.ts";
import { dispatchRuleEvent } from "../src/rules/engine.ts";
import { listRules, saveRule } from "../src/rules/store.ts";
import type { RuleEvent } from "../src/rules/types.ts";
import { testApp } from "./helpers.ts";

/** A conversation with a run of the assistant (or of a profile) in it. */
function working(input: Record<string, unknown> = {}) {
  const app = testApp();
  const t = createThread(app, { spaceId: "personal", channel: "web", userId: "owner" });
  const runId = `r_${Math.random().toString(36).slice(2, 10)}`;
  run(app.db, "insert into runs(id,kind,space_id,status,title,input,created_at) values(?,?,?,?,?,?,?)", runId, "ask", "personal", "running", "t", JSON.stringify({ conversationId: t.id, ...input }), new Date().toISOString());
  const ctx = toolContextForToken(app, issueToolToken({ runId, spaceId: "personal", spaces: null, tools: null, actor: "agent" }))!;
  return { app, thread: t, runId, ctx };
}
const message = (text: string, sender: RuleEvent["sender"] = { name: "小王", kind: "user" }): RuleEvent => ({
  key: `lark:${Math.random()}`,
  kind: "message",
  at: new Date().toISOString(),
  chat: { id: "oc_release", name: "项目 A 发布群", kind: "group" },
  sender,
  message: { id: `om_${Math.random().toString(36).slice(2, 8)}`, text, type: "text", mentionsOwner: false, mentionsBot: false, topicId: null },
  via: "capture",
});
const inputOf = (app: ReturnType<typeof testApp>, id: string) => JSON.parse(one<{ input: string }>(app.db, "select input from runs where id = ?", id)!.input);

describe("wake-ups", () => {
  it("wakes the conversation's agent later with its note, at most five pending, cancellable", async () => {
    const { app, thread, ctx } = working();
    const r = await callTool(ctx, "wake_later", { after: "20m", note: "看 CI 有没有跑完，跑完了告诉本人结果" });
    expect(r.text).toMatch(/已设唤醒 (\S+)：/);
    const id = /已设唤醒 (\S+)：/.exec(r.text)![1];
    const queued = one<{ status: string; not_before: string }>(app.db, "select status, not_before from runs where id = ?", id)!;
    expect(queued.status).toBe("queued");
    expect(Date.parse(queued.not_before) - Date.now()).toBeGreaterThan(19 * 60_000);
    expect((await callTool(ctx, "cancel_wake", {})).text).toContain("看 CI 有没有跑完");
    for (let i = 0; i < 4; i++) await callTool(ctx, "wake_later", { after: "1h", note: `第 ${i} 个` });
    expect((await callTool(ctx, "wake_later", { after: "1h", note: "第六个" })).isError).toBe(true);
    await callTool(ctx, "cancel_wake", { id });
    expect(pendingWakes(app, { conversationId: thread.id })).toHaveLength(4);
    expect(() => wakeTime("8d")).toThrow(/7 天/);
    expect(() => wakeTime("10s")).toThrow(/一分钟/);

    // Time is up: a note in the conversation (not the owner's words) and a turn for its agent.
    const w = inputOf(app, id) as WakeInput;
    const fired = fireWake(app, w);
    const turn = inputOf(app, fired.runId!);
    expect(turn).toMatchObject({ conversationId: thread.id, wake: true });
    const note = threadMessages(app, thread.id).at(-1)!;
    expect(note).toMatchObject({ role: "assistant", meta: { wake: { note: "看 CI 有没有跑完，跑完了告诉本人结果" } } });
    expect(turn.messageIds).toEqual([note.id]);
  });

  it("does not wake when the owner already replied (if asked), and can wake another agent with the result coming back here", async () => {
    const { app, thread, ctx, runId } = working();
    saveAgentSpec(app, { name: "release-checker", description: "看发布", prompt: "看发布。" }, "user");
    const w: WakeInput = { note: "半小时没回就再问一次", target: { conversationId: thread.id }, setBy: { runId, agent: "助理" }, setAt: new Date(Date.now() - 60_000).toISOString(), skipIfOwnerSpoke: true };
    addMessage(app, thread.id, "user", "我看到了，晚点回", null, {});
    expect(fireWake(app, w)).toEqual({ skipped: "本人之后已经说过话" });
    const other = await callTool(ctx, "wake_later", { after: "2h", note: "检查发布单状态", agent: "release-checker" });
    const id = /已设唤醒 (\S+)：/.exec(other.text)![1];
    const r = fireWake(app, inputOf(app, id));
    expect(inputOf(app, r.runId!)).toMatchObject({ spec: "release-checker", threadId: thread.id });
    expect(inputOf(app, r.runId!).task).toContain("检查发布单状态");
  });

  it("wakes on a matching message through a temporary rule, once, and the rule disappears", async () => {
    const { app, thread, ctx } = working();
    const r = await callTool(ctx, "wake_on_message", { chat_id: "oc_release", contains: "发布单", note: "小王发了发布单就检查里面的回滚方案" });
    expect(r.isError).toBeFalsy();
    const [rule] = listRules(app).filter((x) => x.temporary);
    expect(rule.temporary).toMatchObject({ once: true, setBy: { agent: "助理" } });
    expect(pendingWakes(app)).toEqual([expect.objectContaining({ id: rule.id, kind: "event" })]);
    // Bots and messages without the words do not wake it.
    await dispatchRuleEvent(app, message("发布单在这里", { name: "发布机器人", kind: "bot" }));
    await dispatchRuleEvent(app, message("今天不发了"));
    expect(all(app.db, "select id from runs where json_extract(input, '$.wake') = 1")).toHaveLength(0);
    await dispatchRuleEvent(app, message("发布单：https://example.com/r/1"));
    const turns = all<{ input: string }>(app.db, "select input from runs where kind = 'ask' and json_extract(input, '$.wake') = 1");
    expect(turns).toHaveLength(1);
    expect(JSON.parse(turns[0].input).conversationId).toBe(thread.id);
    expect(threadMessages(app, thread.id).at(-1)!.text).toContain("发布单：https://example.com/r/1");
    expect(listRules(app).filter((x) => x.temporary)).toHaveLength(0);
  });

  it("drops expired temporary rules and keeps wake actions out of ordinary rules", async () => {
    const { app, ctx } = working();
    await callTool(ctx, "wake_on_message", { chat_id: "oc_release", from: "小王", note: "看他说什么", expires: "2h" });
    expect(await expireTemporaryRules(app, new Date(Date.now() + 3 * 3600_000).toISOString())).toBe(1);
    expect(listRules(app)).toHaveLength(0);
    expect(() => saveRule(app, { name: "x", description: "x", enabled: true, conditions: { field: "chat.id", op: "equals", value: "oc_x" }, judge: "code", actions: [{ type: "wake", note: "x", target: {} }] })).toThrow(/临时规则/);
    expect((await callTool(ctx, "wake_on_message", { chat_id: "oc_release", note: "没条件" })).isError).toBe(true);
  });
});
