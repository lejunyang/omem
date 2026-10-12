import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { deliverToThread, receive, registerThreadSender } from "../src/agents/inbox.ts";
import { getRun, waitForRun } from "../src/agents/runs.ts";
import { releaseAll, releaseThreadSession } from "../src/agents/sessions.ts";
import { saveAgentSpec, saveSkill, skillIndex } from "../src/agents/specs.ts";
import { getThread, threadMessages, updateThread } from "../src/agents/threads.ts";
import { run } from "../src/core/db.ts";
import { boot } from "../src/main.ts";

type Echo = { session: string; turn: number; resumed: boolean; cold: boolean; msgs: string[]; role: string; summary: string | null; context: boolean };

describe("threads: continuity, merging, lanes, commands", async () => {
  const home = mkdtempSync(join(tmpdir(), "omem-threads-"));
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      agents: { default: "fake", profiles: [{ id: "fake", transport: "acp", command: process.execPath, args: [resolve("test/fake-acp-agent.ts")], env: { FAKE_MODE: "thread", FAKE_DELAY: "300" } }] },
      sessions: { mergeMs: 400, liveMinutes: 5, maxLive: 2, maxTurns: 40, idleHours: 12 },
    }),
  );
  const { app, server } = await boot(home, { port: 0, quiet: true, background: false });
  afterAll(() => {
    releaseAll();
    server.close();
  });
  const answer = async (runId: string | null) => {
    const r = await waitForRun(app, runId!);
    expect(r.error).toBeNull();
    return JSON.parse(String((getRun(app, runId!).output as { answer: string }).answer)) as Echo;
  };

  it("keeps the agent session across turns, resumes it after release, cold-starts with the summary", async () => {
    const a = await receive(app, { channel: "lark", chatId: "oc_dm", text: "第一句" });
    const first = await answer(a.runId);
    expect(first).toMatchObject({ turn: 1, cold: true, msgs: ["第一句"], resumed: false });
    const b = await receive(app, { channel: "lark", chatId: "oc_dm", text: "第二句" });
    expect(b.thread.id).toBe(a.thread.id);
    const second = await answer(b.runId);
    expect(second).toMatchObject({ session: first.session, turn: 2, cold: false, msgs: ["第二句"] });

    // Process released (idle / restart): the agent's own session is resumed.
    releaseThreadSession(a.thread.id);
    const third = await answer((await receive(app, { channel: "lark", chatId: "oc_dm", text: "第三句" })).runId);
    expect(third).toMatchObject({ session: first.session, resumed: true, cold: false });

    // Session gone (other agent / too many turns): a fresh session gets the summary and recent messages.
    releaseThreadSession(a.thread.id);
    updateThread(app, a.thread.id, { agentSession: null, summary: "在讨论第一、二、三句", summaryAt: new Date().toISOString() });
    const fourth = await answer((await receive(app, { channel: "lark", chatId: "oc_dm", text: "第四句" })).runId);
    expect(fourth).toMatchObject({ cold: true, resumed: false, summary: "在讨论第一、二、三句" });
    expect(fourth.session).not.toBe(first.session);
  }, 60000);

  it("merges a burst of messages into one turn and runs one turn per thread at a time", async () => {
    const x = await receive(app, { channel: "lark", chatId: "oc_burst", text: "第一条" });
    const y = await receive(app, { channel: "lark", chatId: "oc_burst", text: "第二条" });
    expect(y.merged).toBe(true);
    expect(y.runId).toBe(x.runId);
    const merged = await answer(x.runId);
    expect(merged.msgs).toEqual(["第一条", "第二条"]);

    // While a turn runs, the next message waits in the lane; another thread runs in parallel.
    const p1 = await receive(app, { channel: "web", conversationId: "c_lane", text: "A1" });
    await new Promise((r) => setTimeout(r, 100));
    const p2 = await receive(app, { channel: "web", conversationId: "c_lane", text: "A2" });
    const q1 = await receive(app, { channel: "web", conversationId: "c_other", text: "B1" });
    expect(p2.runId).not.toBe(p1.runId);
    const [r1, r2, s1] = await Promise.all([answer(p1.runId), answer(p2.runId), answer(q1.runId)]);
    expect(r2.turn).toBe(r1.turn + 1);
    expect(r2.session).toBe(r1.session);
    expect(s1.session).not.toBe(r1.session);
    const t1 = getRun(app, p1.runId!);
    const t2 = getRun(app, p2.runId!);
    expect(Date.parse(t2.startedAt!)).toBeGreaterThanOrEqual(Date.parse(t1.finishedAt!));
  }, 60000);

  it("separates topics, honours /mode, renews idle chats and passes group context", async () => {
    const t1 = await receive(app, { channel: "lark", chatId: "oc_g", topicId: "omt_1", isGroup: true, text: "话题一", context: "[10:00 · 话题 omt_1] 小王: 接口改了" });
    const t2 = await receive(app, { channel: "lark", chatId: "oc_g", topicId: "omt_2", isGroup: true, text: "话题二" });
    expect(t1.thread.id).not.toBe(t2.thread.id);
    expect((await answer(t1.runId)).context).toBe(true);
    await answer(t2.runId);

    const set = await receive(app, { channel: "lark", chatId: "oc_g", topicId: "omt_1", isGroup: true, text: "/mode chat" });
    expect(set.reply).toMatch(/共用一个会话/);
    const t3 = await receive(app, { channel: "lark", chatId: "oc_g", topicId: "omt_3", isGroup: true, text: "合并后" });
    const t4 = await receive(app, { channel: "lark", chatId: "oc_g", text: "群里直接说" });
    expect(t3.thread.id).toBe(t4.thread.id);
    expect(t3.thread.key).toBe("oc_g");
    await answer(t3.runId);

    // Idle past the limit: a new thread that points back to the old one.
    run(app.db, "update conversations set updated_at = ? where id = ?", new Date(Date.now() - 13 * 3600_000).toISOString(), t4.thread.id);
    const later = await receive(app, { channel: "lark", chatId: "oc_g", text: "第二天" });
    expect(later.started).toBe("renewed");
    expect(later.thread.parentId).toBe(t4.thread.id);
    expect(getThread(app, t4.thread.id).status).toBe("archived");
    await answer(later.runId);
  }, 60000);

  it("handles commands without a model", async () => {
    const st = await receive(app, { channel: "lark", chatId: "oc_cmd", text: "/status" });
    expect(st.runId).toBeNull();
    expect(st.reply).toMatch(/空间：personal/);
    expect((await receive(app, { channel: "lark", chatId: "oc_cmd", text: "/space nope" })).reply).toMatch(/没有空间/);
    expect((await receive(app, { channel: "lark", chatId: "oc_cmd", text: "/todo 交报销单" })).reply).toMatch(/已加待办/);
    const n = await receive(app, { channel: "lark", chatId: "oc_cmd", text: "/new 新话题" });
    expect(n.reply).toMatch(/已开始新会话/);
    const after = await receive(app, { channel: "lark", chatId: "oc_cmd", text: "/status" });
    expect(after.thread.id).not.toBe(st.thread.id);
    const back = await receive(app, { channel: "lark", chatId: "oc_cmd", text: `/resume ${st.thread.id}` });
    expect(back.reply).toMatch(/已切换/);
    expect((await receive(app, { channel: "lark", chatId: "oc_cmd", text: "/status" })).thread.id).toBe(st.thread.id);
    // Unknown commands go to the assistant as text.
    const unknown = await receive(app, { channel: "lark", chatId: "oc_cmd", text: "/whatever 这是什么" });
    expect(unknown.runId).toBeTruthy();
    await answer(unknown.runId);
    // Commands are kept in the thread but not indexed as conversation content.
    expect(threadMessages(app, st.thread.id).some((m) => m.meta.command)).toBe(true);
  }, 60000);

  it("answers with an agent spec, delegates to it and delivers back to the thread", async () => {
    saveSkill(app, { name: "weekly-report", description: "写周报时用", body: "1. 列出本周完成的事\n2. 下周计划" }, "user");
    saveAgentSpec(app, { name: "reporter", description: "写周报的 Agent", prompt: "你负责写周报。", skills: ["weekly-report"] }, "user");
    expect(skillIndex(app, ["weekly-report"])).toMatch(/weekly-report：写周报时用/);
    const sent: string[] = [];
    registerThreadSender("test", async (_t, md) => void sent.push(md));
    const as = await receive(app, { channel: "test", chatId: "room", text: "/as reporter" });
    expect(as.reply).toMatch(/改由 reporter 回答/);
    const r = await answer((await receive(app, { channel: "test", chatId: "room", text: "写本周周报" })).runId);
    expect(r.role).toBe("写周报的 Agent");
    const once = await receive(app, { channel: "test", chatId: "room", text: "/as reporter 只写标题" });
    expect(once.reply).toMatch(/已交给 reporter/);
    const runId = /（(r[0-9a-z]+)）/.exec(once.reply!)![1];
    await waitForRun(app, runId);
    expect(sent.some((m) => m.includes("reporter") && m.includes("只写标题"))).toBe(true);
    expect(await deliverToThread(app, as.thread.id, "后来的结果")).toBe(true);
  }, 60000);
});
