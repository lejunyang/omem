import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { answerAsk, listAsks } from "../src/agents/asks.ts";
import { confirmCredential } from "../src/agents/credential-confirm.ts";
import { createRun } from "../src/agents/runs.ts";
import { createThread } from "../src/agents/threads.ts";
import { handleCardAction } from "../src/channels/lark-actions.ts";
import { registerLarkAsks } from "../src/channels/lark-asks.ts";
import { setLarkCliForTests } from "../src/channels/lark-cli.ts";
import { rememberPerson } from "../src/channels/lark-people.ts";
import { recordInteraction, setLarkClient } from "../src/channels/lark-send.ts";
import { one } from "../src/core/db.ts";
import { startServer } from "../src/server/http.ts";
import { createApiToken, createUser, linkIdentity } from "../src/core/users.ts";
import { testApp } from "./helpers.ts";

const app = testApp();
const openId = "ou_holder";
const dm = vi.fn(), patch = vi.fn(), ephemeral = vi.fn(), members = vi.fn(), invite = vi.fn(), cli = vi.fn();

let server: Awaited<ReturnType<typeof startServer>>;
let holderToken: string;
beforeAll(async () => {
  createUser(app, { id: "holder", name: "持有人甲" });
  linkIdentity(app, "holder", "lark", openId);
  rememberPerson(app, { botOpenId: openId, cliOpenId: "ou_cli_holder", name: "持有人甲" });
  server = await startServer(app, { port: 0, host: "127.0.0.1", quiet: true });
  holderToken = createApiToken(app, "holder");
  registerLarkAsks(app, () => "ou_owner");
  setLarkClient({ im: { message: { create: dm, patch }, chatMembers: { get: members, create: invite } }, request: ephemeral });
  setLarkCliForTests(cli);
});
afterAll(async () => { await server.close(); setLarkClient(null); setLarkCliForTests(null); app.db.close(); });

it.each([
  { source: "在群", group: true, member: true, bot: true, owner: false, groupCard: true },
  { source: "机器人邀请", group: true, member: false, bot: true, owner: false, groupCard: true },
  { source: "机器人被拒", group: true, member: false, bot: false, owner: false, groupCard: false },
  { source: "本人邀请", group: true, member: false, bot: false, owner: true, groupCard: true },
  { source: "网页", group: false, member: false, bot: false, owner: true, groupCard: false },
  { source: "私聊", group: false, member: false, bot: false, owner: true, groupCard: false },
])("$source 的私聊卡、群提醒和邀请身份", async ({ source, group, member, bot, owner, groupCard }) => {
  vi.clearAllMocks();
  const chatId = "oc_trigger", privateId = "dm-" + source, ephemeralId = "ephemeral-" + source;
  const thread = createThread(app, { title: source, key: chatId + "#topic", channel: source === "网页" ? "web" : "lark",
    spaceId: "personal", settings: { group } });
  const run = createRun(app, { kind: "ask", title: "核对项目", input: { conversationId: thread.id } });
  app.config.credentials.confirm.inviteAsOwner = owner;
  dm.mockResolvedValue({ data: { message_id: privateId } });
  patch.mockResolvedValue({ code: 0 });
  members.mockResolvedValue({ data: { items: member ? [{ member_id: openId }] : [], has_more: false } });
  invite.mockResolvedValue({ code: bot ? 0 : 403, data: {} });
  cli.mockResolvedValue({ data: {} });
  ephemeral.mockResolvedValue({ data: { message_id: ephemeralId } });
  const controller = new AbortController();
  const waiting = confirmCredential(app, run.id, "owner", "holder", "sample:key", "project:A", "sample show 'project A'", controller.signal);
  try {
    const ask = listAsks(app, { userId: "holder", status: "pending" })[0];
    expect(ask.question).toContain("来源会话：" + source);
    expect(ask.options.map(o => o.label)).toEqual(["这一次可以", "这次任务里都可以", "不行"]);
    await vi.waitFor(() => expect(dm).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ receive_id: openId }) })));
    if (groupCard) await vi.waitFor(() => expect(ephemeral).toHaveBeenCalledWith(expect.objectContaining({
      url: "/open-apis/ephemeral/v1/send", data: expect.objectContaining({ chat_id: chatId, open_id: openId }) })));
    if (group && !bot) await vi.waitFor(() => expect(one(app.db,
      "select 1 from run_events where run_id=? and data like '%机器人拉持有人进群失败%'", run.id)).toBeTruthy());
    await vi.waitFor(() => expect(one(app.db, "select text from messages where conversation_id=? limit 1", thread.id))
      .toEqual({ text: "已请 持有人甲 确认，等他答复。" }));
    expect(members).toHaveBeenCalledTimes(+group);
    expect(invite).toHaveBeenCalledTimes(+(group && !member));
    const asOwner = group && !member && !bot && owner;
    expect(cli).toHaveBeenCalledTimes(+asOwner);
    if (asOwner) {
      expect(cli.mock.calls[0][0]).toEqual(expect.arrayContaining([chatId, JSON.stringify({ id_list: ["ou_cli_holder"] }), "--as", "user"]));
      expect(one(app.db, "select 1 from audit_events where action='credentials.confirm.invite' and json_extract(detail,'$.askId')=?", ask.id)).toBeTruthy();
      expect(one(app.db, "select 1 from notifications where user_id='owner' and body like ?", "%" + ask.id + "%")).toBeTruthy();
    }
    const click = (message: string, who = openId) => handleCardAction(app, { operator: { open_id: who },
      context: { open_message_id: message }, action: { value: { action: "ask:0" } } });
    if (member) {
      expect((await click(ephemeralId, "ou_other")).toast.type).toBe("error");
      expect((await click(ephemeralId)).card).toBeTruthy();
    } else if (source === "网页") {
      const headers = { authorization: "Bearer " + holderToken };
      const inbox = await server.inject({ url: "/api/asks?status=pending", headers });
      expect(inbox.json()).toEqual([expect.objectContaining({ id: ask.id, userId: "holder" })]);
      const response = await server.inject({ method: "POST", url: `/api/asks/${ask.id}/answer`, headers, payload: { choice: 0 } });
      expect(response.json()).toMatchObject({ status: "answered", choice: 0 });
    } else await answerAsk(app, ask.id, { by: "holder", choice: 0 });
    expect(await waiting).toBe(true);
    await vi.waitFor(() => expect(patch).toHaveBeenCalledWith(expect.objectContaining({ path: { message_id: privateId } })));
    expect(ephemeral).toHaveBeenCalledTimes(+groupCard);
    if (groupCard) expect((await click(member ? privateId : ephemeralId)).toast.content).toContain("处理过");
  } finally { controller.abort(); await waiting; }
});

it.each([true, false])("群卡延迟更新只使用回调 token，有 token=%s", async hasToken => {
  vi.clearAllMocks();
  const messageId = "ephemeral-late-" + hasToken;
  recordInteraction(app, { purpose: "ask", payload: { askId: "sample", ephemeral: true }, messageId, chatId: "oc_trigger",
    conversationId: null, runId: null, allowed: [openId] });
  // Hold the decision past Feishu's response deadline to exercise the delayed update transport.
  let finish!: () => void;
  const response = new Promise<{ toast: string; card: Record<string, unknown> }>(resolve => {
    finish = () => resolve({ toast: "已处理", card: { schema: "2.0" } });
  });
  const handle = vi.spyOn(await import("../src/channels/lark-asks.ts"), "handleAskAction").mockReturnValueOnce(response);
  try {
    const ack = await handleCardAction(app, { operator: { open_id: openId }, context: { open_message_id: messageId },
      ...(hasToken ? { token: "fixture-callback" } : {}), action: { value: { action: "ask:0" } } });
    expect(ack.toast.type).toBe("info");
    finish();
    await new Promise(resolve => setImmediate(resolve));
    if (hasToken) expect(ephemeral).toHaveBeenCalledWith({ method: "POST", url: "/open-apis/interactive/v1/card/update",
      data: { token: "fixture-callback", open_ids: [openId], card: { schema: "2.0" } } });
    else expect(ephemeral).not.toHaveBeenCalled();
    expect(patch).not.toHaveBeenCalled();
  } finally { handle.mockRestore(); }
});
