import { afterEach, describe, expect, it, vi } from "vitest";
import { createRun, listRuns } from "../src/agents/runs.ts";
import { findThread, threadMessages } from "../src/agents/threads.ts";
import { callTool, issueToolToken, toolContextForToken } from "../src/agents/tools.ts";
import { all, one } from "../src/core/db.ts";
import { handleCardAction } from "../src/channels/lark-actions.ts";
import { onLarkReaction } from "../src/channels/lark-feedback.ts";
import { setLarkClient } from "../src/channels/lark-send.ts";
import { routeWatchedMessages } from "../src/channels/lark-watch.ts";
import { contextsOfChat, getContext } from "../src/channels/listen.ts";
import { correctionsSinceBrief, lessonsText } from "../src/channels/watch-trial.ts";
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
const ctxOf = (app: ReturnType<typeof testApp>) => contextsOfChat(app, "oc_oncall")[0];

describe("a 关注 learns before it replies by itself", () => {
  it("drafts the brief for the owner, trials replies as drafts, then asks about going direct", async () => {
    const app = testApp();
    app.config.lark.ownerOpenId = "ou_owner";
    const client = fakeClient();
    setLarkClient(client);
    const ask = createRun(app, { kind: "ask", title: "x", input: { conversationId: "c_none", messageIds: [] }, lane: "test-hold", notBefore: "2999-01-01T00:00:00Z" });
    const owner = toolContextForToken(app, issueToolToken({ runId: ask.id, spaceId: "personal", spaces: null, tools: null, actor: "agent" }))!;

    // Replying needs a brief; asking for direct replies starts a trial.
    expect((await callTool(owner, "set_chat_watch", { chat_id: "oc_oncall", note: "有问题先帮我排查，有效结论才发", reply: "auto", until: "never" })).isError).toBe(true);
    const set = await callTool(owner, "set_chat_watch", { chat_id: "oc_oncall", name: "值班群", note: "有问题先帮我排查，有效结论才发", reply: "auto", until: "never", brief: BRIEF });
    expect(set.text).toMatch(/先试运行/);
    expect(set.text).toMatch(/发给本人确认/);
    expect(ctxOf(app)).toMatchObject({ name: "值班群", knobs: { reply: "draft", wantsAuto: true }, brief: { handle: BRIEF.handle } });
    // The brief card goes to the owner alone (their private chat here: the fake knows no members).
    const briefCard = client.calls.find((c) => c.op === "create")!;
    expect(briefCard.args.data.receive_id).toBe("ou_owner");
    expect(briefCard.args.data.content).toContain("关注「值班群」");
    const confirmed = await click(app, cardOf(app, "watch-brief"), { form_value: { handle: "用户报的页面问题\n- 账号查询", skip: "问本人的", valid: "有依据" } });
    expect(confirmed).toMatchObject({ card: { data: { header: { title: { content: expect.stringMatching(/按这个关注/) } } } } });
    expect(ctxOf(app).brief).toMatchObject({ handle: ["用户报的页面问题", "账号查询"], skip: ["问本人的"], valid: "有依据" });
    expect(ctxOf(app).brief!.confirmedAt).toBeTruthy();

    // What was said well before the 关注 (past its backlog) is not handed over; who a message is for is marked.
    const longAgo = Date.parse(ctxOf(app).since) - 3 * 86400_000;
    expect(await routeWatchedMessages(app, "oc_oncall", "值班群", [{ id: "om_old", time: String(longAgo), sender: "小王", text: "上周的问题" }])).toBe(0);
    await routeWatchedMessages(app, "oc_oncall", "值班群", [
      { id: "om_q1", time: String(Date.now()), sender: "小王", text: "UID 123 打不开页面" },
      { id: "om_q2", time: String(Date.now()), sender: "小李", text: "@本人 要不要提级", mentions: ["ou_owner"] },
      { id: "om_q3", time: String(Date.now()), sender: "小李", text: "@小张的助理 总结一下", mentions: ["ou_other"] },
    ]);
    const watchRun = listRuns(app, { kind: "ask" }).find((r) => r.id !== ask.id)!;
    const conv = String(watchRun.input.conversationId);
    expect(conv).toBe(ctxOf(app).conversationId);
    const texts = threadMessages(app, conv).map((m) => m.text);
    expect(texts.find((t) => t.includes("要不要提级"))).toMatch(/@了本人/);
    expect(texts.find((t) => t.includes("总结一下"))).toMatch(/@了别人/);
    expect(findThread(app, conv)!.settings.lark).toEqual({ chats: ["oc_oncall"], draft: true });

    // The handler's replies are drafts only the owner sees; sending them as drafted counts toward going direct.
    const handler = toolContextForToken(app, issueToolToken({ runId: watchRun.id, spaceId: "personal", spaces: null, tools: null, actor: "agent", larkChats: ["oc_oncall"], larkDraft: true }))!;
    const promoteAfter = ctxOf(app).knobs.promoteAfter;
    for (let i = 0; i < promoteAfter; i++) {
      // A reply claims the message for this 关注; the next draft answers another message.
      const replyTo = i === 0 ? "om_q1" : `om_q1_${i}`;
      if (i > 0) await routeWatchedMessages(app, "oc_oncall", "值班群", [{ id: replyTo, time: String(Date.now()), sender: "小王", text: `第 ${i} 个问题` }]);
      expect((await callTool(handler, "lark_send", { reply_to: replyTo, in_thread: true, markdown: `第 ${i} 条结论` })).text).toMatch(/只有本人看得到/);
      const sent = await click(app, cardOf(app, "watch-draft"), { form_value: { reply: `第 ${i} 条结论` } });
      expect(sent).toMatchObject({ card: { data: { header: { title: { content: "已发送" } } } } });
    }
    expect(client.calls.filter((c) => c.op === "reply")).toHaveLength(promoteAfter);
    expect(all(app.db, "select 1 from reply_samples where context_id = ? and decision = 'sent'", ctxOf(app).id)).toHaveLength(promoteAfter);
    await click(app, cardOf(app, "watch-promote"), { value: { action: "auto" } });
    expect(ctxOf(app).knobs).toMatchObject({ reply: "auto", wantsAuto: false });

    // Posted by itself, then disliked: back to drafts, and the case says so.
    await routeWatchedMessages(app, "oc_oncall", "值班群", [{ id: "om_q9", time: String(Date.now()), sender: "小王", text: "又一个问题" }]);
    const direct = toolContextForToken(app, issueToolToken({ runId: watchRun.id, spaceId: "personal", spaces: null, tools: null, actor: "agent", larkChats: ["oc_oncall"] }))!;
    const out = await callTool(direct, "lark_send", { reply_to: "om_q9", in_thread: true, markdown: "自动的结论" });
    const posted = /已发送 (om_\d+)/.exec(out.text)![1];
    expect(one(app.db, "select decision from reply_samples where reply_id = ?", posted)).toMatchObject({ decision: "auto" });
    onLarkReaction(app, "main", { message_id: posted, reaction_type: { emoji_type: app.config.feedback.emoji.negative[0] }, operator_type: "user", user_id: { open_id: "ou_owner" } }, "created", () => "owner", () => true);
    await vi.waitFor(() => expect(ctxOf(app).knobs.reply).toBe("draft"));
    expect(one(app.db, "select decision from reply_samples where reply_id = ?", posted)).toMatchObject({ decision: "disliked" });
  });

  it("keeps why a draft was not sent, and asks for a new brief after a few corrections", async () => {
    const app = testApp();
    app.config.lark.ownerOpenId = "ou_owner";
    const client = fakeClient();
    setLarkClient(client);
    const ask = createRun(app, { kind: "ask", title: "x", input: { conversationId: "c_none", messageIds: [] }, lane: "test-hold", notBefore: "2999-01-01T00:00:00Z" });
    const owner = toolContextForToken(app, issueToolToken({ runId: ask.id, spaceId: "personal", spaces: null, tools: null, actor: "agent" }))!;
    await callTool(owner, "set_chat_watch", { chat_id: "oc_oncall", reply: "draft", brief: BRIEF });
    const watchRunOf = () => listRuns(app, { kind: "ask" }).find((r) => r.id !== ask.id)!;
    for (const [i, reason] of ["owner-decides", "not-ours", "wrong"].entries()) {
      await routeWatchedMessages(app, "oc_oncall", "值班群", [{ id: `om_q${i}`, time: String(Date.now()), sender: "小李", text: "@本人 要不要提级", mentions: ["ou_owner"] }]);
      const handler = toolContextForToken(app, issueToolToken({ runId: watchRunOf().id, spaceId: "personal", spaces: null, tools: null, actor: "agent", larkChats: ["oc_oncall"], larkDraft: true }))!;
      await callTool(handler, "lark_send", { reply_to: `om_q${i}`, in_thread: true, markdown: "建议先不提级" });
      const dropped = await click(app, cardOf(app, "watch-draft"), { value: { action: `drop:${reason}` } });
      expect(dropped).toMatchObject({ card: { data: { header: { title: { content: "没有发" } } } } });
    }
    expect(client.calls.filter((c) => c.op === "reply")).toHaveLength(0);
    const c = ctxOf(app);
    expect(lessonsText(app, c)).toMatch(/不发（该我来定）回 小李：@本人 要不要提级/);
    expect(correctionsSinceBrief(app, c)).toBe(3);
    // The handler sees the decision in its conversation too.
    expect(threadMessages(app, c.conversationId!).some((m) => m.text.includes("本人没发这条草稿：该我来定"))).toBe(true);
    // A new brief resets the count and goes to the owner again.
    await callTool(owner, "set_chat_watch", { context: c.id, brief: { ...BRIEF, skip: [...BRIEF.skip, "提级、排期"] } });
    expect(correctionsSinceBrief(app, ctxOf(app))).toBe(0);
    expect(client.calls.at(-1)!.args.data.content).toContain("按你最近的决定改了");
    // "别自动回了" is a reply mode, not the end of the 关注.
    await callTool(owner, "set_chat_watch", { context: c.id, reply: "none" });
    expect(getContext(app, c.id)).toMatchObject({ status: "active", knobs: { reply: "none" } });
  });
});
