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
});
