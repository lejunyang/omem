import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRun, listRuns } from "../src/agents/runs.ts";
import { saveAgentSpec } from "../src/agents/specs.ts";
import { createThread, findThread, threadMessages } from "../src/agents/threads.ts";
import { callTool, issueToolToken, toolContextForToken } from "../src/agents/tools.ts";
import { all } from "../src/core/db.ts";
import { createSpace } from "../src/core/spaces.ts";
import { handleCardAction } from "../src/channels/lark-actions.ts";
import { setLarkCliForTests } from "../src/channels/lark-cli.ts";
import { pollLark } from "../src/channels/lark-personal.ts";
import { buildCard, setLarkClient } from "../src/channels/lark-send.ts";
import { routeWatchedMessages, setWatchRule } from "../src/channels/lark-watch.ts";
import { recordCodeActivity } from "../src/sources/activity.ts";
import { testApp } from "./helpers.ts";

/** A stand-in for the Feishu SDK client that records what the bot would do. */
function fakeClient() {
  const calls: { op: string; args: any }[] = [];
  let n = 0;
  const ok = (data: any) => ({ code: 0, data });
  return {
    calls,
    im: {
      message: {
        create: async (args: any) => (calls.push({ op: "create", args }), ok({ message_id: `om_${++n}` })),
        reply: async (args: any) => (calls.push({ op: "reply", args }), ok({ message_id: `om_${++n}`, thread_id: args.data.reply_in_thread ? "omt_1" : undefined })),
        patch: async (args: any) => (calls.push({ op: "patch", args }), ok({})),
        get: async (args: any) => ok({ items: [{ chat_id: args.path.message_id.startsWith("om_g") ? "oc_g" : "oc_other" }] }),
      },
      messageReaction: { create: async (args: any) => (calls.push({ op: "react", args }), ok({ reaction_id: "r1" })), delete: async () => ok({}) },
    },
  };
}

afterEach(() => {
  setLarkClient(null);
  setLarkCliForTests(null);
});

describe("feishu bot messaging", () => {
  it("builds Card 2.0 with buttons and forms", () => {
    const card = buildCard({
      title: "告警",
      color: "red",
      blocks: [{ fields: [{ label: "服务", value: "api" }] }, { buttons: [{ text: "认领", value: "claim", style: "primary" }] }, { form: { fields: [{ type: "select", name: "level", options: [{ text: "P0", value: "p0" }] }, { type: "input", name: "note" }] } }],
    }) as any;
    expect(card.schema).toBe("2.0");
    expect(card.header.template).toBe("red");
    const json = JSON.stringify(card);
    expect(json).toContain('"behaviors":[{"type":"callback","value":{"action":"claim"}}]');
    expect(json).toContain('"tag":"form"');
    expect(json).toContain('"form_action_type":"submit"');
    expect(json).toContain('"tag":"select_static"');
  });

  it("posts within scope, restricts who may act, and routes actions back to the conversation", async () => {
    const app = testApp();
    const client = fakeClient();
    setLarkClient(client);
    const t = createThread(app, { spaceId: "personal", channel: "lark-watch", key: "oc_g" });
    const run = createRun(app, { kind: "ask", title: "x", input: { conversationId: t.id, messageIds: [] }, lane: "test-hold", notBefore: "2999-01-01T00:00:00Z" });
    const ctx = toolContextForToken(app, issueToolToken({ runId: run.id, spaceId: "personal", spaces: null, tools: null, actor: "agent", larkChats: ["oc_g"] }))!;

    expect((await callTool(ctx, "lark_send", { chat_id: "oc_other", text: "hi" })).text).toMatch(/不能往这个飞书会话发消息/);
    expect((await callTool(ctx, "lark_react", { message_id: "om_g1", emoji: "OnIt" })).text).toBe("已加表情");
    const sent = await callTool(ctx, "lark_card", { reply_to: "om_g1", in_thread: true, title: "认领", blocks: [{ buttons: [{ text: "我来", value: "claim" }] }], allowed: ["ou_a"] });
    expect(sent.text).toMatch(/已发送 om_\d+（话题 omt_1）/);
    const cardId = /已发送 (om_\d+)/.exec(sent.text)![1];
    expect(client.calls.find((c) => c.op === "reply")!.args.data.reply_in_thread).toBe(true);

    expect(await handleCardAction(app, { operator: { open_id: "ou_b" }, context: { open_message_id: cardId }, action: { tag: "button", value: { action: "claim" } } })).toMatchObject({ toast: { type: "error" } });
    const ok = await handleCardAction(app, { operator: { open_id: "ou_a" }, context: { open_message_id: cardId }, action: { tag: "button", value: { action: "claim" } } });
    expect(ok).toMatchObject({ toast: { content: "已收到，处理中" } });
    const last = threadMessages(app, t.id).pop()!;
    expect(last.text).toMatch(/\[卡片操作\] ou_a（ou_a）在卡片 om_\d+ 上点击按钮「claim」/);
    expect(last.meta.speaker).toBe("ou_a");
  });

  it("turns posts into drafts the owner approves", async () => {
    const app = testApp();
    app.config.lark.ownerOpenId = "ou_owner";
    const client = fakeClient();
    setLarkClient(client);
    const ctx = toolContextForToken(app, issueToolToken({ runId: null, spaceId: "personal", spaces: null, tools: null, actor: "agent", larkChats: ["oc_g"], larkDraft: true }))!;
    expect((await callTool(ctx, "lark_send", { chat_id: "oc_g", markdown: "**已处理**" })).text).toMatch(/草稿/);
    const draft = client.calls.find((c) => c.op === "create")!;
    expect(draft.args.data.receive_id).toBe("ou_owner");
    const draftId = "om_1";
    expect(await handleCardAction(app, { operator: { open_id: "ou_x" }, context: { open_message_id: draftId }, action: { value: { action: "send" } } })).toMatchObject({ toast: { type: "error" } });
    await handleCardAction(app, { operator: { open_id: "ou_owner" }, context: { open_message_id: draftId }, action: { value: { action: "send" } } });
    const real = client.calls.filter((c) => c.op === "create")[1];
    expect(real.args.data.receive_id).toBe("oc_g");
    expect(JSON.parse(real.args.data.content).body.elements[0].content).toBe("**已处理**");
    expect(await handleCardAction(app, { operator: { open_id: "ou_owner" }, context: { open_message_id: draftId }, action: { value: { action: "send" } } })).toMatchObject({ toast: { content: "已经处理过了" } });
  });
});

describe("watched chats", () => {
  it("hands matching messages to the handler once, in a thread that may post only there", async () => {
    const app = testApp();
    saveAgentSpec(app, { name: "alert-handler", description: "处理报警", prompt: "按告警处理技能处理。" }, "user");
    expect(() => setWatchRule(app, "oc_alert", { spec: "nope", on: "all", reply: "draft" })).toThrow(/没有 Agent 档案/);
    setWatchRule(app, "oc_alert", { spec: "alert-handler", on: "keyword", pattern: "P[01]", reply: "draft" });
    const msgs = [
      { id: "om_a1", time: String(Date.now()), sender: "监控", text: "【P1】订单服务 5xx 升高" },
      { id: "om_a2", time: String(Date.now()), sender: "监控", text: "【P3】磁盘 70%" },
    ];
    expect(await routeWatchedMessages(app, "oc_alert", "报警群", msgs)).toBe(1);
    expect(await routeWatchedMessages(app, "oc_alert", "报警群", msgs)).toBe(0);
    const runs = listRuns(app, { kind: "ask" });
    expect(runs).toHaveLength(1);
    const thread = findThread(app, (runs[0].input as { conversationId: string }).conversationId)!;
    expect(thread.channel).toBe("lark-watch");
    expect(thread.settings.spec).toBe("alert-handler");
    expect(thread.settings.lark).toEqual({ chats: ["oc_alert"], draft: true });
    expect(threadMessages(app, thread.id)[0].meta.speaker).toBe("监控");
  });
});

describe("feishu capture (lark-cli)", () => {
  it("reads every active chat incrementally, follows topics, and captures calendar and minutes", async () => {
    const app = testApp();
    app.config.lark.capture = { ...app.config.lark.capture, mode: "all", attachments: false, docs: false, quietStop: 2 };
    const t0 = Date.now() - 3600_000;
    const msgs: Record<string, any[]> = {
      oc_a: [
        { message_id: "om_1", msg_type: "text", content: JSON.stringify({ text: "明天发版" }), create_time: String(t0), sender: { name: "小王" }, thread_id: "omt_9" },
        { message_id: "om_2", msg_type: "text", content: JSON.stringify({ text: "收到" }), create_time: String(t0 + 1000), sender: { name: "我" } },
      ],
      oc_p2p: [{ message_id: "om_3", msg_type: "text", content: "周五一起吃饭", create_time: String(t0 + 2000), sender: { name: "小李" } }],
    };
    const thread = [{ message_id: "om_t1", msg_type: "text", content: JSON.stringify({ text: "回滚方案已准备" }), create_time: String(t0 + 3000), sender: { name: "小张" } }];
    const calls: string[][] = [];
    setLarkCliForTests(async (args) => {
      calls.push(args);
      const sub = args.slice(0, 2).join(" ");
      if (sub === "im +chat-list") return { data: { chats: [{ chat_id: "oc_a", name: "项目群", chat_mode: "group" }, { chat_id: "oc_p2p", name: "小李", chat_mode: "p2p" }, { chat_id: "oc_quiet", name: "安静群", chat_mode: "group" }] } };
      if (sub === "im +chat-messages-list") {
        const chat = args[args.indexOf("--chat-id") + 1];
        const start = Date.parse(args[args.indexOf("--start") + 1]);
        return { data: { messages: (msgs[chat] ?? []).filter((m) => Number(m.create_time) >= start - 1000) } };
      }
      if (sub === "im +threads-messages-list") return { data: { messages: thread } };
      if (sub === "calendar +agenda") return { data: { events: [{ event_id: "ev1", summary: "需求评审", start_time: { date_time: "2026-10-15T10:00:00+08:00" }, end_time: { date_time: "2026-10-15T11:00:00+08:00" }, attendees: [{ display_name: "小王" }] }] } };
      if (sub === "minutes +search") return { data: { items: [{ minute_token: "obc1", title: "周会" }] } };
      if (sub === "minutes +detail") return { data: { minutes: [{ minute_token: "obc1", title: "周会", artifacts: { summary: "确定 10 月底上线", todos: [{ content: "小王整理发布清单" }] } }] } };
      throw new Error(`unexpected ${args.join(" ")}`);
    });
    const r = await pollLark(app);
    expect(r.messages).toBe(4);
    const chats = all<{ uri: string; text: string; kind: string }>(app.db, "select uri, text, kind from sources where uri like 'lark:%' order by uri");
    const group = chats.find((c) => c.uri === "lark:oc_a")!;
    expect(group.text).toMatch(/小王: 明天发版 \(om_1\)/);
    expect(group.text).toMatch(/话题 omt_9\] 小张: 回滚方案已准备/);
    expect(chats.find((c) => c.uri === "lark:oc_p2p")!.text).toMatch(/小李: 周五一起吃饭/);
    expect(chats.find((c) => c.uri === "lark:calendar:ev1")).toMatchObject({ kind: "event" });
    expect(chats.find((c) => c.uri === "lark:minutes:obc1")!.text).toMatch(/小王整理发布清单/);
    expect(listRuns(app, { kind: "ingest" }).length).toBeGreaterThan(0);

    // Second poll: nothing new is appended twice.
    calls.length = 0;
    const again = await pollLark(app);
    expect(again.messages).toBe(0);
    expect(all<{ text: string }>(app.db, "select text from sources where uri = 'lark:oc_a'")[0].text.match(/om_1/g)).toHaveLength(1);
  });
});

describe("code activity", () => {
  it("records new commits and the shape of uncommitted work", () => {
    const app = testApp();
    const dir = mkdtempSync(join(tmpdir(), "omem-act-"));
    const g = (...a: string[]) => execFileSync("git", a, { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: "me", GIT_COMMITTER_NAME: "me", GIT_AUTHOR_EMAIL: "m@x", GIT_COMMITTER_EMAIL: "m@x" } });
    g("init", "-q", "-b", "main");
    writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
    g("add", ".");
    g("commit", "-qm", "first");
    createSpace(app, { id: "repo", name: "repo", kind: "repo", rootPath: dir });
    recordCodeActivity(app);
    writeFileSync(join(dir, "b.ts"), "export const b = 2;\n");
    g("add", ".");
    g("commit", "-qm", "add b");
    writeFileSync(join(dir, "a.ts"), "export const a = 3;\n");
    const r = recordCodeActivity(app);
    expect(r).toHaveLength(1);
    const text = all<{ text: string }>(app.db, "select text from sources where kind = 'activity'")[0].text;
    expect(text).toMatch(/提交 [0-9a-f]+（me，main）：add b｜1 file changed/);
    expect(text).toMatch(/未提交改动 1 个文件.*a\.ts/);
    expect(recordCodeActivity(app)).toHaveLength(0);
  });
});

describe("progress card", () => {
  it("shows steps while the agent works and ends with the answer", async () => {
    const { startProgress } = await import("../src/channels/lark-progress.ts");
    const app = testApp();
    const client = fakeClient();
    setLarkClient(client);
    const p = await startProgress(app, { messageId: "om_q", inThread: false }, "r_x");
    expect(client.calls.map((c) => c.op)).toEqual(["react", "reply"]);
    app.emit({ type: "run-event", runId: "r_x", seq: 1, event: { type: "tool", data: { id: "t1", title: "mcp__omem__search", status: "in_progress" }, at: "" } } as never);
    app.emit({ type: "run-event", runId: "r_x", seq: -1, event: { type: "text-delta", data: { text: "部分答案" }, at: "" } } as never);
    await new Promise((r) => setTimeout(r, 2300));
    const live = client.calls.filter((c) => c.op === "patch").pop()!;
    expect(live.args.data.content).toContain("… 检索");
    expect(live.args.data.content).toContain("部分答案");
    await p.finish("最终答案");
    const final = JSON.parse(client.calls.filter((c) => c.op === "patch").pop()!.args.data.content);
    expect(final.body.elements[0].content).toBe("最终答案");
    expect(client.calls.filter((c) => c.op === "react").map((c) => c.args.data.reaction_type.emoji_type)).toEqual(["OnIt", "DONE"]);
  });
});
