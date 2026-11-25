import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { testApp } from "./helpers.ts";
import { answerAsk } from "../src/agents/asks.ts";
import { createRun } from "../src/agents/runs.ts";
import { addMessage, createThread, getThread } from "../src/agents/threads.ts";
import { callTool, type ToolContext } from "../src/agents/tools.ts";
import { handleCardAction } from "../src/channels/lark-actions.ts";
import { setLarkCliForTests } from "../src/channels/lark-cli.ts";
import { setLarkClient } from "../src/channels/lark-send.ts";
import { saveContext, type ListenKnobs } from "../src/channels/listen.ts";
import { registerListenRoutes } from "../src/channels/listen-http.ts";
import { all, one } from "../src/core/db.ts";
import { itemMaterials } from "../src/items/materials.ts";
import { saveRule } from "../src/rules/store.ts";
import { ruleInputSchema } from "../src/rules/types.ts";
import { upsertSource } from "../src/sources/store.ts";
import { requireInstance, startSituation } from "../src/situations/instances.ts";
import { situationPrompt } from "../src/situations/prompt.ts";
import { requireSituation, saveSituation, situationRuleId } from "../src/situations/settings.ts";

const FIRST = "oc_testAlpha";
const NEXT = "oc_testBeta";
const OWNER_ID = "ou_owner";

async function setup(reply?: ListenKnobs["reply"]) {
  const app = testApp();
  app.config.lark.appId = "cli_omem";
  app.config.lark.ownerOpenId = OWNER_ID;
  const context = saveContext(app, { kind: "situation", name: "项目 A 演练", recognize: "群里说演练开始", note: "进展发到这一次的群", spaceId: "personal", knobs: { batchMinutes: 0, ...(reply && { reply }) } });
  saveRule(app, { ...ruleInputSchema.parse({ name: context.name, description: context.recognize, trigger: { event: "message" },
    conditions: { field: "message.text", op: "contains", value: "演练开始" }, actions: [{ type: "context", context: context.id }] }), id: situationRuleId(context.id) },
    "user", "owner", { origin: { kind: "situation", contextId: context.id, name: context.name } });
  const { instance, runId } = await startSituation(app, "owner", context.id, "核对项目 A 的本次演练");
  const ctx: ToolContext = { app, userId: "owner", actor: "agent", role: "assistant", runId, spaceId: "personal", spaces: null, tools: null, larkChats: [], larkDraft: true };
  const cli = vi.fn(async (args: string[]) => {
    if (args[1] === "chats" && args[2] === "get") {
      const chat = args[args.indexOf("--chat-id") + 1];
      return { code: 0, data: { name: "项目 A 演练群", chat_mode: chat === "oc_private" ? "p2p" : chat === NEXT ? "topic" : "group" } };
    }
    if (args[0] === "api" && args[1] === "GET" && args[2].endsWith("/members/is_in_chat") && args.includes("user")) {
      if (args[2].includes("oc_unreadable")) throw new Error("不能读取成员身份");
      return { code: 0, data: { is_in_chat: !args[2].includes("oc_outside") } };
    }
    if (args[1] === "chat.members" && args[2] === "create") return { code: 0, data: {} };
    throw new Error(`意外的调用：${args.join(" ")}`);
  });
  setLarkCliForTests(cli);
  let messageCount = 0;
  const send = vi.fn(async ({ data }: { data: { receive_id: string } }) => ({ code: 0, data: { message_id: `om_${++messageCount}`, chat_id: data.receive_id } }));
  setLarkClient({ im: { message: { create: send } } });
  return { app, context, instance, ctx, cli, send, read: () => requireInstance(app, "owner", instance.id),
    bind: (chat: string) => callTool(ctx, "update_situation", { chat }), post: (chat: string) => callTool(ctx, "lark_send", { chat_id: chat, text: "已核对本轮范围" }),
    approve: (id: string) => handleCardAction(app, { operator: { open_id: OWNER_ID }, context: { open_message_id: id }, action: { value: { action: "send" } } }),
  };
}

afterEach(() => { setLarkCliForTests(null); setLarkClient(null); });

describe("持续跟进这一次的群", () => {
  it("默认不发，不查群、不绑定，提示只私下通知", async () => {
    const { app, context, read, bind, cli } = await setup();
    expect(context.knobs.reply).toBe("none");
    expect(await bind(FIRST)).toMatchObject({ isError: true, text: expect.stringContaining("只能私下告诉本人") });
    expect(cli).not.toHaveBeenCalled();
    expect(read().chatId).toBeNull();
    const prompt = situationPrompt(app, read(), "新线索", false, true);
    expect(prompt).toContain("不允许在群里发。有要本人知道的用 notify 私下说");
    expect(prompt).not.toContain("用 lark_send");
  });

  it("拒绝单聊、话题 ID、未加入或无法确认的群，以及不是本回处理的运行", async () => {
    const { app, ctx, instance, read, bind } = await setup("auto");
    for (const [chat, reason] of [["oc_private", "是单聊"], ["om_topic", "不是群的 chat_id"], ["oc_outside", "无法确认本人在群"], ["oc_unreadable", "无法确认本人在群"]]) {
      expect(await bind(chat)).toMatchObject({ isError: true, text: expect.stringContaining(reason) });
    }
    const unrelated = createRun(app, { kind: "ask", title: "另一轮", lane: "other", input: { conversationId: instance.conversationId } });
    expect(await callTool({ ...ctx, runId: unrelated.id }, "update_situation", { chat: FIRST })).toMatchObject({ isError: true, text: expect.stringContaining("只能更新本次运行") });
    expect(read().chatId).toBeNull();
  });

  it.each(["draft", "auto"] as const)("%s：绑定后本轮立刻可用，换群只留新范围并记时间线", async reply => {
    const { app, ctx, instance, read, bind, post, approve, send } = await setup(reply);
    const source = upsertSource(app, { spaceId: "personal", kind: "chat", uri: `lark:${FIRST}`, title: "项目 A 演练群", text: "演练消息" });
    const archive = upsertSource(app, { spaceId: "personal", kind: "chat", uri: `lark:${NEXT}@2026-10`, title: "项目 A 演练群历史", text: "先前的消息" });
    const prompt = situationPrompt(app, read(), "新线索", false, true);
    expect(prompt).toContain("还没绑定这一次的群");
    expect(prompt).toContain("update_situation(chat=");
    expect(prompt).toContain("找不到或拿不准是哪个群就不绑");
    expect(await post(FIRST)).toMatchObject({ isError: true });
    expect(await bind(FIRST)).toMatchObject({ isError: false, text: expect.stringContaining("未发消息") });
    expect(send).not.toHaveBeenCalled();
    expect(itemMaterials(app, instance.itemId)).toContainEqual(expect.objectContaining({ kind: "source", ref: source.id }));
    expect(all(app.db, "select distinct run_id from situation_feedback where instance_id=?", instance.id)).toEqual([{ run_id: ctx.runId }]);
    expect(read().chatId).toBe(FIRST);
    expect(getThread(app, instance.conversationId).settings.lark).toEqual({ chats: [FIRST], draft: reply === "draft" });
    const boundPrompt = situationPrompt(app, read(), "新线索", false, true);
    expect(boundPrompt).toContain(`这一次的群是 ${FIRST}`);
    expect(boundPrompt).toContain("用 lark_send 发到这一次的群");
    expect(boundPrompt.includes("先变成给本人的确认卡片")).toBe(reply === "draft");
    expect(await post(FIRST)).toMatchObject({ isError: false });
    expect(send.mock.calls[0][0].data.receive_id).toBe(reply === "draft" ? OWNER_ID : FIRST);
    expect(await bind(NEXT)).toMatchObject({ isError: false });
    expect(itemMaterials(app, instance.itemId)).toContainEqual(expect.objectContaining({ kind: "source", ref: archive.id }));
    expect(getThread(app, instance.conversationId).settings.lark).toEqual({ chats: [NEXT], draft: reply === "draft" });
    expect(await post(FIRST)).toMatchObject({ isError: true });
    if (reply === "draft") expect(await approve("om_1")).toMatchObject({ toast: { type: "error", content: expect.stringContaining("群或回复档已改") } });
    expect(send).toHaveBeenCalledTimes(1);
    expect(await post(NEXT)).toMatchObject({ isError: false });
    if (reply === "draft") {
      expect(await approve("om_2")).toMatchObject({ toast: { type: "success" } });
      expect(send.mock.calls[2][0].data.receive_id).toBe(NEXT);
    }
    const history = all<{ text: string; run_id: string }>(app.db, "select text,run_id from item_events where item_id=? and kind='situation-chat' order by id", instance.itemId);
    expect(history).toEqual([
      { text: expect.stringContaining(FIRST), run_id: ctx.runId },
      { text: expect.stringContaining(`${FIRST} 换成「项目 A 演练群」（${NEXT}）`), run_id: ctx.runId },
    ]);
    const beforeClose = send.mock.calls.length;
    expect(situationPrompt(app, read(), "已有材料", true, true)).toContain("结束本身不发群消息");
    expect(await callTool(ctx, "update_situation", { summary: "演练已结束" })).toMatchObject({ isError: false });
    expect(send).toHaveBeenCalledTimes(beforeClose);
    expect(await post(NEXT)).toMatchObject({ isError: true });
  });

  it("发送时报机器人不在群的处理方法，只允许邀请自己的机器人到本回群", async () => {
    const { app, ctx, bind, post, cli, send } = await setup("auto");
    expect(await bind(FIRST)).toMatchObject({ isError: false });
    send.mockResolvedValueOnce({ code: 230002, data: { message_id: "", chat_id: FIRST } });
    expect(await post(FIRST)).toMatchObject({ isError: true, text: expect.stringContaining('lark_invite（bots: ["self"]）') });
    send.mockResolvedValueOnce({ code: 230002, data: { message_id: "", chat_id: FIRST } });
    expect(await callTool({ ...ctx, tools: new Set(["lark_send"]) }, "lark_send", { chat_id: FIRST, text: "本回进展" })).toMatchObject({ isError: true, text: expect.stringContaining("本次运行没有 lark_invite") });
    const invite = (chat_id: string, people?: string[]) => callTool(ctx, "lark_invite", { invites: [{ chat_id, bots: ["self"], people }], reason: "向本回群发进展" });
    expect(await invite(NEXT)).toMatchObject({ isError: true });
    expect(await invite(FIRST, ["小王"])).toMatchObject({ isError: true });
    expect(await invite(FIRST)).toMatchObject({ isError: false });
    expect(cli.mock.calls.filter(([args]) => args[1] === "chat.members" && args[2] === "create")).toHaveLength(1);
    expect(one(app.db, "select 1 from audit_events where action='lark.invite' and target=?", FIRST)).toBeTruthy();
  });

  it("本人明确要求才直接改回复档，否则只在卡片批准后改；关闭马上拦本轮", async () => {
    const { app, ctx, context, bind, post, send } = await setup("draft");
    expect(await bind(FIRST)).toMatchObject({ isError: false });
    const thread = createThread(app, { spaceId: "personal", channel: "web" });
    const messageId = addMessage(app, thread.id, "user", "请改这条持续跟进的回复档");
    const ownerRun = createRun(app, { kind: "ask", title: "设置持续跟进", lane: thread.id, input: { conversationId: thread.id, messageIds: [messageId] } });
    const owner = { ...ctx, runId: ownerRun.id };
    expect(await callTool(owner, "save_situation", { id: context.id, reply: "auto" })).toMatchObject({ isError: false, text: expect.stringContaining("先给你看 → 直接发") });
    expect(requireSituation(app, "owner", context.id).knobs.reply).toBe("draft");
    const ask = one<{ id: string; question: string }>(app.db, "select id,question from asks where run_id=? and status='pending'", ownerRun.id)!;
    expect(ask.question).toContain("在这一次的群里：先给你看 → 直接发");
    await answerAsk(app, ask.id, { choice: 0, by: "owner" });
    expect(requireSituation(app, "owner", context.id).knobs.reply).toBe("auto");
    expect(await post(FIRST)).toMatchObject({ isError: false });
    expect(send.mock.calls[0][0].data.receive_id).toBe(FIRST);
    expect(await callTool(owner, "save_situation", { id: context.id, reply: "none", owner_requested: true })).toMatchObject({ isError: false });
    expect(requireSituation(app, "owner", context.id).knobs.reply).toBe("none");
    expect(await post(FIRST)).toMatchObject({ isError: true });
    expect(send).toHaveBeenCalledTimes(1);
    expect(await saveSituation(app, "owner", { id: context.id, note: "另写说明" })).toMatchObject({ context: { knobs: { reply: "none" } } });
  });

  it("网页设置经关注接口保存并读回回复档，不把群写成固定关注", async () => {
    const { app, context } = await setup();
    const server = Fastify();
    registerListenRoutes(server, app, () => "owner");
    try {
      for (const reply of ["draft", "auto", "none"]) {
        const changed = await server.inject({ method: "PUT", url: `/api/listen/${context.id}`, payload: { knobs: { reply }, chats: [FIRST] } });
        expect(changed.statusCode).toBe(200);
        const detail = await server.inject({ method: "GET", url: `/api/listen/${context.id}` });
        expect(detail.json()).toMatchObject({ context: { chats: [], knobs: { reply } } });
      }
    } finally { await server.close(); }
  });
});
