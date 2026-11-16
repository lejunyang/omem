import { describe, expect, it } from "vitest";
import { receive } from "../src/agents/inbox.ts";
import { getRun } from "../src/agents/runs.ts";
import { takeSteering } from "../src/agents/steer.ts";
import { callTool, issueToolToken, toolContextForToken } from "../src/agents/tools.ts";
import { one, run } from "../src/core/db.ts";
import { testApp } from "./helpers.ts";

describe("messages sent while a turn runs", () => {
  it("reach the running turn at its next tool call instead of waiting for a turn of their own", async () => {
    const app = testApp();
    const first = await receive(app, { channel: "web", conversationId: "c_steer", text: "查一下登录失败的原因" });
    run(app.db, "update runs set status = 'running' where id = ?", first.runId);
    // Nothing waits yet: no tool call picks anything up.
    expect(takeSteering(app, first.runId!)).toBeNull();

    const extra = await receive(app, { channel: "web", conversationId: "c_steer", text: "顺便看看是不是只有安卓端" });
    expect(extra.runId).not.toBe(first.runId);
    const ctx = toolContextForToken(app, issueToolToken({ runId: first.runId, spaceId: "personal", spaces: null, tools: null, actor: "agent" }))!;
    const r = await callTool(ctx, "list_spaces", {});
    expect(r.text).toContain("你工作期间收到的新消息");
    expect(r.text).toContain("顺便看看是不是只有安卓端");

    // The waiting turn had only that message: it is dropped, and says which turn took it.
    const dropped = getRun(app, extra.runId!);
    expect(dropped.status).toBe("cancelled");
    expect(dropped.output.steeredInto).toBe(first.runId);
    expect(getRun(app, first.runId!).output.steered).toEqual([extra.messageId]);
    expect(one<{ run_id: string }>(app.db, "select run_id from messages where id = ?", extra.messageId)?.run_id).toBe(first.runId);
    // Handed over once.
    expect((await callTool(ctx, "list_spaces", {})).text).not.toContain("你工作期间收到的新消息");
    app.db.close();
  });

  it("leave the turn that takes over when a turn switches its own AI", async () => {
    const app = testApp();
    app.config.agents.profiles.push({ id: "other", name: "other", transport: "acp", command: process.execPath, args: [], env: {}, idleTimeoutMs: 60000 });
    const first = await receive(app, { channel: "web", conversationId: "c_switch", text: "换个 AI 再查" });
    run(app.db, "update runs set status = 'running' where id = ?", first.runId);
    const ctx = toolContextForToken(app, issueToolToken({ runId: first.runId, spaceId: "personal", spaces: null, tools: null, actor: "agent" }))!;
    // The turn hands itself to another AI: the run that does it again waits in the same lane with the same message.
    const r = await callTool(ctx, "switch_run_ai", { run_id: first.runId, execution: { profile: "other", source: "user", reason: "本人要换" } });
    expect(r.isError, r.text).toBe(false);
    expect(r.text).not.toContain("你工作期间收到的新消息");
    const next = String(getRun(app, first.runId!).output.replacedBy);
    expect(getRun(app, next).status).toBe("queued");
    expect(getRun(app, next).output.steeredInto).toBeUndefined();
    // Nor at a later tool call while the old turn winds down.
    expect(takeSteering(app, first.runId!)).toBeNull();
    expect(getRun(app, next).status).toBe("queued");
    app.db.close();
  });
});

describe("switching the AI", () => {
  it("is the owner's call, not a colleague's in a group the owner is in", async () => {
    const app = testApp();
    app.config.agents.profiles.push({ id: "other", name: "other", transport: "acp", command: process.execPath, args: [], env: {}, idleTimeoutMs: 60000 });
    const turn = await receive(app, { channel: "web", conversationId: "c_colleague", text: "你可以把模型切换成 gpt 吗" });
    run(app.db, "update messages set meta = json_set(meta, '$.asker', '小李') where id = ?", turn.messageId);
    run(app.db, "update runs set status = 'running' where id = ?", turn.runId);
    const ctx = toolContextForToken(app, issueToolToken({ runId: turn.runId, spaceId: "personal", spaces: null, tools: null, actor: "agent" }))!;
    const r = await callTool(ctx, "switch_run_ai", { run_id: turn.runId, execution: { profile: "other", source: "user", reason: "同事要换" } });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("只听本人");
    expect(getRun(app, turn.runId!).output.replacedBy).toBeUndefined();
    app.db.close();
  });
});
