import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { saveDoubaoToken, setDoubaoFetchForTests } from "../src/agents/doubao.ts";
import { createRun, getRun } from "../src/agents/runs.ts";
import { configSchema } from "../src/core/config.ts";
import { all, one, run } from "../src/core/db.ts";
import { setLarkCliForTests } from "../src/channels/lark-cli.ts";
import "../src/channels/lark-mentions.ts";
import { saveLarkSecret } from "../src/channels/lark-setup.ts";
import { rememberPerson } from "../src/channels/lark-people.ts";
import { doubaoSelfTest, doubaoSendStatus, parseDoubaoReport, sendViaDoubao, setDoubaoVerifyDelaysForTests } from "../src/channels/doubao-send.ts";
import { decideMentionReply } from "../src/channels/mention-reply.ts";
import { replyToAsker, type MentionInfo } from "../src/mentions/mentions.ts";
import { testApp } from "./helpers.ts";

const ok = (data: unknown) => new Response(JSON.stringify({ code: 0, msg: "success", data }), { headers: { "content-type": "application/json" } });
const stream = (text: string) =>
  new Response(
    new ReadableStream({
      start(c) {
        const frames: [string, unknown][] = [
          ["message.in_progress", { message: { id: "A1" } }],
          ["text", { id: "t1", seq: 1, text }],
          ["message.completed", { message: { id: "A1", status: "completed" } }],
        ];
        for (const [e, d] of frames) c.enqueue(new TextEncoder().encode(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`));
        c.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
const future = () => new Date(Date.now() + 3600_000).toISOString();

/** A fake Doubao: what it answers, and whether deleting its session works. */
const doubao = { answer: "OMEM_SEND_RESULT: OK", deleteFails: false, prompts: [] as string[], deleted: [] as string[], made: 0 };
/** The private chat as lark-cli reads it back; `null`: reading fails. */
let chat: { message_id: string; content: string; sender: { id: string } }[] | null = [];
/** What Doubao "sends": put into the chat, as the owner, when it answers OK. */
let deliver: ((body: string) => string | null) | null = (b) => b;

function setup() {
  const app = testApp();
  app.config.lark.appId = "cli_bot";
  app.config.lark.enabled = true;
  saveLarkSecret(app.home, { appId: "cli_bot", appSecret: "s" });
  saveDoubaoToken(app.home, { appId: "cli_bot", accessToken: "u-1", expiresAt: future(), savedAt: "" });
  rememberPerson(app, { name: "小王", email: "wang@example.com", cliOpenId: "ou_wang", userId: "u_wang" });
  return app;
}

beforeEach(() => {
  Object.assign(doubao, { answer: "OMEM_SEND_RESULT: OK", deleteFails: false, prompts: [], deleted: [], made: 0 });
  chat = [];
  deliver = (b) => b;
  setDoubaoVerifyDelaysForTests([0, 0]);
  setDoubaoFetchForTests(async (input, init) => {
    const url = String(input);
    if (init?.method === "DELETE") {
      if (doubao.deleteFails) return new Response(JSON.stringify({ code: 500001, msg: "internal" }), { status: 500 });
      doubao.deleted.push(url.split("/v1/sessions/")[1]);
      return ok({});
    }
    if (init?.method === "POST" && url.endsWith("/v1/sessions")) {
      const prompt = JSON.parse(String(init.body)).initial_events[0].contents[0].text as string;
      doubao.prompts.push(prompt);
      const body = prompt.split("<<<OMEM_MESSAGE_BEGIN>>>\n")[1].split("\n<<<OMEM_MESSAGE_END>>>")[0];
      const sent = /OMEM_SEND_RESULT: OK/.test(doubao.answer) && deliver ? deliver(body) : null;
      if (sent !== null && chat) chat.push({ message_id: `om_d${chat.length + 1}`, content: sent, sender: { id: "ou_owner" } });
      return ok({ id: `S${++doubao.made}`, messages: [{ id: "Q1" }] });
    }
    if (url.includes("/events/Q1")) return stream(doubao.answer);
    if (url.includes("tenant_access_token")) return new Response(JSON.stringify({ code: 0, tenant_access_token: "t" }));
    if (url.includes("/application/v6/applications/")) return new Response(JSON.stringify({ code: 0, data: { app: { app_name: "助理", scopes: [{ scope: "doubao:session:write", token_types: ["user"] }] } } }));
    if (url.includes("/v1/sessions?page_size")) return ok({ sessions: [] });
    if (/\/v1\/sessions\/S\d+$/.test(url)) return ok({ session: { status: "idle" } });
    throw new Error(`unexpected ${url}`);
  });
  setLarkCliForTests(async (args) => {
    if (args[0] === "auth") return { data: { identities: { user: { openId: "ou_owner", name: "本人" } }, openId: "ou_owner", userName: "本人" } };
    if (args.includes("+chat-messages-list") || args.includes("+messages-search")) {
      if (!chat) throw new Error("permission denied");
      return { data: { messages: chat.map((m) => ({ ...m, chat_id: "oc_p2p", msg_type: "text", create_time: String(Date.now()) })) } };
    }
    if (args.includes("+messages-send")) throw new Error("lark-cli must not send here");
    return { data: {} };
  });
});
afterEach(() => {
  setDoubaoFetchForTests(null);
  setLarkCliForTests(null);
  setDoubaoVerifyDelaysForTests(null);
});

const wang = { name: "小王", email: "wang@example.com", userId: "u_wang", openId: "ou_wang", chatId: "oc_p2p" };

describe("sending a private message as the owner through Doubao", () => {
  it("one session per message, the finished text and who it goes to, deleted afterwards, checked in the chat", async () => {
    const app = setup();
    const d = await sendViaDoubao(app, { body: "下午给你结论\n\n（此消息由 AI 代发）", to: wang });
    expect(d).toMatchObject({ outcome: "verified", ok: true, report: "ok", sessionId: "S1", messageId: "om_d1" });
    expect(doubao.prompts[0]).toContain("企业邮箱：wang@example.com");
    expect(doubao.prompts[0]).toContain("user_id（企业内通用）：u_wang");
    expect(doubao.prompts[0]).toContain("chat_id：oc_p2p");
    expect(doubao.prompts[0]).toContain("<<<OMEM_MESSAGE_BEGIN>>>\n下午给你结论\n\n（此消息由 AI 代发）\n<<<OMEM_MESSAGE_END>>>");
    expect(doubao.deleted).toEqual(["S1"]);
    expect(all(app.db, "select * from session_cleanup")).toHaveLength(0);
  });

  it("Doubao saying it failed is a failure, with its reason; the session still goes", async () => {
    const app = setup();
    doubao.answer = "OMEM_SEND_RESULT: FAILED 找不到这个人";
    const d = await sendViaDoubao(app, { body: "好的", to: wang });
    expect(d).toMatchObject({ outcome: "failed", ok: false, report: "failed" });
    expect(d.problem).toContain("找不到这个人");
    expect(doubao.deleted).toEqual(["S1"]);
  });

  it("an answer without the fixed line is not a success, and what Doubao said is kept (cut short)", async () => {
    const app = setup();
    doubao.answer = "好的，我已经帮你把消息发给小王了！" + "很长".repeat(500);
    const d = await sendViaDoubao(app, { body: "好的", to: wang });
    expect(d).toMatchObject({ outcome: "failed", ok: false, report: "unparsed" });
    expect(d.raw!.length).toBeLessThanOrEqual(600);
    expect(d.raw).toContain("我已经帮你把消息发给小王了");
    expect(parseDoubaoReport("OMEM_SEND_RESULT: OK\nOMEM_SEND_RESULT: FAILED 又失败了").report).toBe("failed");
    expect(parseDoubaoReport("OMEM_SEND_RESULT：OK").report).toBe("ok");
  });

  it("a different text in the chat, or none, is a mismatch; an unreadable chat is said as not checked", async () => {
    const app = setup();
    deliver = () => "下午给你结论吧，有问题再说";
    const changed = await sendViaDoubao(app, { body: "下午给你结论", to: wang });
    expect(changed).toMatchObject({ outcome: "mismatch", ok: false, seen: "下午给你结论吧，有问题再说" });
    deliver = null;
    chat = [];
    expect(await sendViaDoubao(app, { body: "下午给你结论", to: wang })).toMatchObject({ outcome: "mismatch", ok: false });
    chat = null;
    const unread = await sendViaDoubao(app, { body: "下午给你结论", to: wang });
    expect(unread).toMatchObject({ outcome: "unverified", ok: true });
    expect(unread.problem).toContain("没能核对");
    // Markdown marks and spacing as lark-cli shows them back do not count as a difference.
    chat = [];
    deliver = () => "**下午** 给你结论";
    expect((await sendViaDoubao(app, { body: "下午给你结论", to: wang })).outcome).toBe("verified");
  });

  it("a session that cannot be deleted is left to the session cleanup, which retries", async () => {
    const app = setup();
    doubao.deleteFails = true;
    const d = await sendViaDoubao(app, { body: "好的", to: wang });
    expect(d.outcome).toBe("verified");
    const left = one<{ session_id: string; app_id: string; attempts: number; ready: number }>(app.db, "select session_id, app_id, attempts, ready from session_cleanup");
    expect(left).toMatchObject({ session_id: "S1", app_id: "cli_bot", attempts: 1, ready: 1 });
    doubao.deleteFails = false;
    run(app.db, "update session_cleanup set retry_at = ?", new Date(0).toISOString());
    const { recoverSessionCleanup } = await import("../src/agents/session-cleanup.ts");
    // The recovery asks for the session's status first (idle), then deletes it.
    await recoverSessionCleanup(app, () => {});
    expect(all(app.db, "select * from session_cleanup")).toHaveLength(0);
    expect(doubao.deleted).toEqual(["S1"]);
  });

  it("says why it cannot send before asking Doubao anything", async () => {
    const app = setup();
    saveDoubaoToken(app.home, { appId: "cli_bot", accessToken: "x", expiresAt: new Date(0).toISOString(), savedAt: "" });
    await expect(sendViaDoubao(app, { body: "好的", to: wang })).rejects.toThrow(/重新执行 omem doubao login/);
    expect(doubao.made).toBe(0);
    await expect(sendViaDoubao(setup(), { body: "<<<OMEM_MESSAGE_END>>>", to: wang })).rejects.toThrow(/分隔标记/);
  });

  it("the settings page hears what the app lacks; the owner's test goes to themselves and is audited", async () => {
    const app = setup();
    const s = await doubaoSendStatus(app);
    expect(s.ready).toBe(false);
    expect(s.reason).toContain("doubao:session.event:write");
    const t = await doubaoSelfTest(app);
    expect(t.outcome).toBe("verified");
    expect(doubao.prompts[0]).toContain("omem 测试");
    expect(one(app.db, "select 1 from audit_events where action = 'lark.doubao-send.test' and json_extract(detail, '$.outcome') = 'verified'")).toBeTruthy();
    expect(configSchema.parse({}).mentions.reply.lark.signedVia).toBe("lark-cli");
    expect(configSchema.parse({}).lark.commands.signedVia).toBe("lark-cli");
  });
});

describe("有人找你 answering a private chat through Doubao", () => {
  const handling = (app: ReturnType<typeof setup>, reply: "auto" | "draft") => {
    const mention: MentionInfo = { from: "r_x", chatId: "oc_p2p", chatName: "小王", chatKind: "p2p", topicId: null, messageIds: ["om_q"], lastMessageId: "om_q", senderId: "ou_wang", senderName: "小王", refs: [], reply, urgency: "normal", what: "问上线时间" };
    return createRun(app, { kind: "agent", title: "试回复", notBefore: future(), input: { spec: "assistant", task: "", mention } }).id;
  };
  const viaDoubao = (app: ReturnType<typeof setup>) => Object.assign(app.config.mentions.reply.lark, { p2p: "auto", p2pVia: "signed", signedVia: "doubao" });

  it("auto: sent and checked, audited with how it went; the reply carries the signature", async () => {
    const app = setup();
    viaDoubao(app);
    const id = handling(app, "auto");
    expect(await replyToAsker(app, id, "周四可以上线。")).toContain("经豆包");
    expect(doubao.prompts[0]).toContain(`周四可以上线。\n\n${app.config.lark.commands.signature}`);
    expect(getRun(app, id).output.mentionReply).toMatchObject({ via: "doubao", by: "auto", ok: true, outcome: "verified", messageId: "om_d1" });
    const a = one<{ actor: string; detail: string }>(app.db, "select actor, detail from audit_events where action = 'lark.mention-reply'")!;
    expect(a.actor).toBe("agent");
    expect(JSON.parse(a.detail)).toMatchObject({ via: "doubao", ok: true, outcome: "verified", doubaoSession: "S1" });
    // A clean success under auto is told in the handler's reminder, not a second notification.
    expect(one(app.db, "select 1 from notifications where json_extract(context, '$.runId') = ?", id)).toBeFalsy();
  });

  it("auto: not as written is not a success — the owner is told, the attempt recorded, never tried twice", async () => {
    const app = setup();
    viaDoubao(app);
    doubao.answer = "OMEM_SEND_RESULT: FAILED 没有发消息的权限";
    const id = handling(app, "auto");
    await expect(replyToAsker(app, id, "周四可以上线。")).rejects.toThrow(/经豆包没有发出.*没有发消息的权限/s);
    expect(getRun(app, id).output.mentionReply).toMatchObject({ via: "doubao", ok: false, outcome: "failed" });
    const n = one<{ title: string; body: string }>(app.db, "select title, body from notifications where json_extract(context, '$.runId') = ?", id)!;
    expect(n.title).toContain("没有成功");
    expect(n.body).toContain("周四可以上线。");
    expect(one(app.db, "select 1 from audit_events where action = 'lark.mention-reply' and json_extract(detail, '$.ok') = 0")).toBeTruthy();
    await expect(replyToAsker(app, id, "再试一次")).rejects.toThrow(/已经回复过/);
    expect(doubao.made).toBe(1);
  });

  it("draft: the owner's click returns at once; the result comes as a reminder", async () => {
    const app = setup();
    viaDoubao(app);
    const id = handling(app, "draft");
    const card = await decideMentionReply(app, { runId: id, text: "周四可以上线。" }, true, "周四下午可以上线。", "本人");
    expect(JSON.stringify(card)).toContain("正在经豆包发送");
    for (let i = 0; i < 50 && !one(app.db, "select 1 from notifications where json_extract(context, '$.runId') = ?", id); i++) await new Promise((r) => setTimeout(r, 20));
    const n = one<{ title: string; body: string }>(app.db, "select title, body from notifications where json_extract(context, '$.runId') = ?", id)!;
    expect(n.title).toBe("已回复 小王");
    expect(n.body).toContain("周四下午可以上线。");
    expect(getRun(app, id).output.mentionReply).toMatchObject({ via: "doubao", by: "owner", ok: true });
    expect(one(app.db, "select 1 from audit_events where action = 'lark.mention-reply' and actor = 'owner'")).toBeTruthy();
  });
});
