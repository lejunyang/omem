import { describe, expect, it } from "vitest";
import { receive } from "../src/agents/inbox.ts";
import { getRun } from "../src/agents/runs.ts";
import { takeSteering } from "../src/agents/steer.ts";
import { callTool, issueToolToken, toolContextForToken } from "../src/agents/tools.ts";
import { one, run } from "../src/core/db.ts";
import { addMember, createUser } from "../src/core/users.ts";
import { createSpace } from "../src/core/spaces.ts";
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

  it("from someone who can see at least as much join another person's turn; narrower people and guests wait for their own", async () => {
    const app = testApp();
    createSpace(app, { id: "shop", name: "示例商城", kind: "project" });
    createSpace(app, { id: "hr", name: "人事", kind: "project" });
    const wang = createUser(app, { id: "wang", name: "小王" }), li = createUser(app, { id: "li", name: "小李" });
    addMember(app, "shop", wang.id); addMember(app, "hr", wang.id); addMember(app, "shop", li.id);
    const chat = { channel: "lark", chatId: "oc_join", isGroup: true, spaceId: "personal", mergeMs: 0 };
    const first = await receive(app, { ...chat, userId: wang.id, text: "查一下首页访问" });
    run(app.db, "update runs set status = 'running' where id = ?", first.runId);
    // The owner adds a note: it reaches 小王's turn, which keeps 小王's permissions.
    const owner = await receive(app, { ...chat, text: "也看下移动端" });
    const taken = takeSteering(app, first.runId!);
    expect(taken).toContain("也看下移动端");
    expect(taken).toContain("按小王的权限进行");
    expect(getRun(app, owner.runId!).output.steeredInto).toBe(first.runId);
    // 小李 sees less than 小王: his words get a turn of his own.
    const li1 = await receive(app, { ...chat, userId: li.id, text: "人事那边也查下" });
    expect(takeSteering(app, first.runId!)).toBeNull();
    expect(getRun(app, li1.runId!).status).toBe("queued");
    app.db.close();
  });

  it("merge into a waiting turn only under the same rule", async () => {
    const app = testApp();
    createSpace(app, { id: "shop", name: "示例商城", kind: "project" });
    const wang = createUser(app, { id: "wang2", name: "小王" });
    addMember(app, "shop", wang.id);
    const chat = { channel: "lark", chatId: "oc_wait", isGroup: true, spaceId: "personal", mergeMs: 60_000 };
    const first = await receive(app, { ...chat, userId: wang.id, text: "查一下首页访问" });
    const owner = await receive(app, { ...chat, text: "也看下移动端" });
    expect(owner).toMatchObject({ merged: true, runId: first.runId });
    // A colleague who is not a user, asking through the owner's turn, never joins someone else's.
    const guest = await receive(app, { ...chat, asker: "访客小张", text: "我也想问" });
    expect(guest.merged).toBe(false);
    app.db.close();
  });
});
