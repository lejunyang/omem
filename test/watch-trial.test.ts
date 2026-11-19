import { afterEach, describe, expect, it, vi } from "vitest";
import { createRun, listRuns } from "../src/agents/runs.ts";
import { findThread, threadMessages } from "../src/agents/threads.ts";
import { callTool, issueToolToken, toolContextForToken } from "../src/agents/tools.ts";
import { one } from "../src/core/db.ts";
import { handleCardAction } from "../src/channels/lark-actions.ts";
import { onLarkReaction } from "../src/channels/lark-feedback.ts";
import { setLarkClient } from "../src/channels/lark-send.ts";
import { routeWatchedMessages, watchRule } from "../src/channels/lark-watch.ts";
import { correctionsSinceBrief, lessonsText, PROMOTE_AFTER } from "../src/channels/watch-trial.ts";
import { testApp } from "./helpers.ts";

/** Records what the bot would post; every message gets the next om_<n>. */
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
        get: async () => ok({ items: [{ chat_id: "oc_oncall" }] }),
      },
    },
  };
}

afterEach(() => setLarkClient(null));

const BRIEF = { handle: ["用户报的页面问题，带 UID 或截图的"], skip: ["问本人或要本人拍板的", "找别人或别的机器人的"], valid: "有日志或代码依据，说得出原因或该找谁" };
const cardOf = (app: ReturnType<typeof testApp>, purpose: string) => one<{ message_id: string }>(app.db, "select message_id from card_interactions where purpose = ? order by rowid desc limit 1", purpose)!.message_id;
const click = (app: ReturnType<typeof testApp>, messageId: string, action: Record<string, unknown>) =>
  handleCardAction(app, { operator: { open_id: "ou_owner" }, context: { open_message_id: messageId }, action } as never);

describe("a watched group learns before it replies by itself", () => {
  it("drafts the brief for the owner, trials replies as drafts, then asks about going direct", async () => {
    const app = testApp();
    app.config.lark.ownerOpenId = "ou_owner";
    const client = fakeClient();
    setLarkClient(client);
    const ask = createRun(app, { kind: "ask", title: "x", input: { conversationId: "c_none", messageIds: [] }, lane: "test-hold", notBefore: "2999-01-01T00:00:00Z" });
    const owner = toolContextForToken(app, issueToolToken({ runId: ask.id, spaceId: "personal", spaces: null, tools: null, actor: "agent" }))!;

    // Replying needs a brief; asking for direct replies starts a trial.
    expect((await callTool(owner, "set_chat_watch", { chat_id: "oc_oncall", note: "有问题先帮我排查，有效结论才发", reply: "auto", until: "never" })).isError).toBe(true);
    const set = await callTool(owner, "set_chat_watch", { chat_id: "oc_oncall", note: "有问题先帮我排查，有效结论才发", reply: "auto", until: "never", brief: BRIEF });
    expect(set.text).toMatch(/先试运行/);
    expect(set.text).toMatch(/发给本人确认/);
    expect(watchRule(app, "oc_oncall")).toMatchObject({ reply: "draft", wantsAuto: true, brief: { handle: BRIEF.handle } });
    expect(watchRule(app, "oc_oncall")!.since).toBeTruthy();
    // The brief card goes to the owner alone (their private chat here: the fake knows no members).
    const briefCard = client.calls.find((c) => c.op === "create")!;
    expect(briefCard.args.data.receive_id).toBe("ou_owner");
    expect(briefCard.args.data.content).toContain("盯「");
    const confirmed = await click(app, cardOf(app, "watch-brief"), { form_value: { handle: "用户报的页面问题\n- 账号查询", skip: "问本人的", valid: "有依据" } });
    expect(confirmed).toMatchObject({ card: { data: { header: { title: { content: expect.stringMatching(/按这个盯/) } } } } });
    expect(watchRule(app, "oc_oncall")!.brief).toMatchObject({ handle: ["用户报的页面问题", "账号查询"], skip: ["问本人的"], valid: "有依据" });
    expect(watchRule(app, "oc_oncall")!.brief!.confirmedAt).toBeTruthy();

    // What was said before the watch is not handed over; who a message is for is marked.
    const before = Date.parse(watchRule(app, "oc_oncall")!.since!) - 60_000;
    expect(await routeWatchedMessages(app, "oc_oncall", "值班群", [{ id: "om_old", time: String(before), sender: "小王", text: "昨天的问题" }])).toBe(0);
    await routeWatchedMessages(app, "oc_oncall", "值班群", [
      { id: "om_q1", time: String(Date.now()), sender: "小王", text: "UID 123 打不开页面" },
      { id: "om_q2", time: String(Date.now()), sender: "小李", text: "@本人 要不要提级", mentions: ["ou_owner"] },
      { id: "om_q3", time: String(Date.now()), sender: "小李", text: "@小张的助理 总结一下", mentions: ["ou_other"] },
    ]);
    const watchRun = listRuns(app, { kind: "ask" }).find((r) => r.id !== ask.id)!;
    const conv = String(watchRun.input.conversationId);
    const texts = threadMessages(app, conv).map((m) => m.text);
    expect(texts.find((t) => t.includes("要不要提级"))).toMatch(/@了本人/);
    expect(texts.find((t) => t.includes("总结一下"))).toMatch(/@了别人/);
    expect(findThread(app, conv)!.settings.lark).toEqual({ chats: ["oc_oncall"], draft: true });

    // The handler's replies are drafts only the owner sees; sending them as drafted counts toward going direct.
    const handler = toolContextForToken(app, issueToolToken({ runId: watchRun.id, spaceId: "personal", spaces: null, tools: null, actor: "agent", larkChats: ["oc_oncall"], larkDraft: true }))!;
    for (let i = 0; i < PROMOTE_AFTER; i++) {
      expect((await callTool(handler, "lark_send", { reply_to: "om_q1", in_thread: true, markdown: `第 ${i} 条结论` })).text).toMatch(/只有本人看得到/);
      const draftId = cardOf(app, "watch-draft");
      expect(client.calls.at(-1)!.args.data.content).toContain("小王");
      const sent = await click(app, draftId, { form_value: { reply: `第 ${i} 条结论` } });
      expect(sent).toMatchObject({ card: { data: { header: { title: { content: "已发送" } } } } });
      expect(client.calls.at(-2)!.op === "reply" || client.calls.at(-1)!.op === "reply").toBe(true);
    }
    expect(watchRule(app, "oc_oncall")!.log!.filter((d) => d.decision === "sent")).toHaveLength(PROMOTE_AFTER);
    const promote = cardOf(app, "watch-promote");
    await click(app, promote, { value: { action: "auto" } });
    expect(watchRule(app, "oc_oncall")).toMatchObject({ reply: "auto", wantsAuto: false });

    // Posted by itself, then disliked: back to drafts, and the record says so.
    const direct = toolContextForToken(app, issueToolToken({ runId: watchRun.id, spaceId: "personal", spaces: null, tools: null, actor: "agent", larkChats: ["oc_oncall"] }))!;
    const out = await callTool(direct, "lark_send", { reply_to: "om_q1", in_thread: true, markdown: "自动的结论" });
    const posted = /已发送 (om_\d+)/.exec(out.text)![1];
    expect(watchRule(app, "oc_oncall")!.log!.at(-1)).toMatchObject({ decision: "auto", messageId: posted });
    onLarkReaction(app, "main", { message_id: posted, reaction_type: { emoji_type: app.config.feedback.emoji.negative[0] }, operator_type: "user", user_id: { open_id: "ou_owner" } }, "created", () => "owner", () => true);
    await vi.waitFor(() => expect(watchRule(app, "oc_oncall")!.reply).toBe("draft"));
    expect(watchRule(app, "oc_oncall")!.log!.at(-1)).toMatchObject({ decision: "disliked", messageId: posted });
  });

  it("keeps why a draft was not sent, and asks for a new brief after a few corrections", async () => {
    const app = testApp();
    app.config.lark.ownerOpenId = "ou_owner";
    const client = fakeClient();
    setLarkClient(client);
    const ask = createRun(app, { kind: "ask", title: "x", input: { conversationId: "c_none", messageIds: [] }, lane: "test-hold", notBefore: "2999-01-01T00:00:00Z" });
    const owner = toolContextForToken(app, issueToolToken({ runId: ask.id, spaceId: "personal", spaces: null, tools: null, actor: "agent" }))!;
    await callTool(owner, "set_chat_watch", { chat_id: "oc_oncall", reply: "draft", brief: BRIEF });
    await routeWatchedMessages(app, "oc_oncall", "值班群", [{ id: "om_q1", time: String(Date.now()), sender: "小李", text: "@本人 要不要提级", mentions: ["ou_owner"] }]);
    const watchRun = listRuns(app, { kind: "ask" }).find((r) => r.id !== ask.id)!;
    const handler = toolContextForToken(app, issueToolToken({ runId: watchRun.id, spaceId: "personal", spaces: null, tools: null, actor: "agent", larkChats: ["oc_oncall"], larkDraft: true }))!;
    for (const reason of ["owner-decides", "not-ours", "wrong"]) {
      await callTool(handler, "lark_send", { reply_to: "om_q1", in_thread: true, markdown: "建议先不提级" });
      const dropped = await click(app, cardOf(app, "watch-draft"), { value: { action: `drop:${reason}` } });
      expect(dropped).toMatchObject({ card: { data: { header: { title: { content: "没有发" } } } } });
    }
    expect(client.calls.filter((c) => c.op === "reply")).toHaveLength(0);
    const w = watchRule(app, "oc_oncall")!;
    expect(lessonsText(w)).toMatch(/不发（该我来定）回 小李：@本人 要不要提级：建议先不提级/);
    expect(correctionsSinceBrief(w)).toBe(3);
    // The handler sees the decision in its conversation too.
    expect(threadMessages(app, String(watchRun.input.conversationId)).some((m) => m.text.includes("本人没发这条草稿：该我来定"))).toBe(true);
    // A new brief resets the count and goes to the owner again.
    await callTool(owner, "set_chat_watch", { chat_id: "oc_oncall", brief: { ...BRIEF, skip: [...BRIEF.skip, "提级、排期"] } });
    expect(correctionsSinceBrief(watchRule(app, "oc_oncall")!)).toBe(0);
    expect(client.calls.at(-1)!.args.data.content).toContain("按你最近的决定改了");
    // "别自动回了" is a reply mode, not the end of the watch.
    await callTool(owner, "set_chat_watch", { chat_id: "oc_oncall", reply: "none" });
    expect(watchRule(app, "oc_oncall")).toMatchObject({ reply: "none" });
  });
});
