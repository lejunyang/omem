import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { answerAsk, listAsks } from "../src/agents/asks.ts";
import { createRun } from "../src/agents/runs.ts";
import { addMessage, createThread } from "../src/agents/threads.ts";
import { callTool, issueToolToken, toolContextForToken, type ToolContext } from "../src/agents/tools.ts";
import { resetLarkAuthForTests } from "../src/channels/lark-auth.ts";
import { setLarkCliForTests } from "../src/channels/lark-cli.ts";
import { inviteOwnBot, knownBots, resolveInvites } from "../src/channels/lark-invite.ts";
import { rememberPerson } from "../src/channels/lark-people.ts";
import { all, run } from "../src/core/db.ts";
import type { App } from "../src/core/app.ts";
import { forgetChatBots } from "../src/rules/engine.ts";
import { testApp } from "./helpers.ts";

const id = (c: string) => `ou_${c.repeat(32)}`;
const WANG = id("a");
const LI1 = id("b");
const LI2 = id("c");
const ZHAO = id("d");
const QIAN = id("e");

/** lark-cli's directory as the owner sees it (open_ids of lark-cli's app). */
const DIRECTORY = [
  { open_id: WANG, localized_name: "小王", enterprise_email: "wang@example.com", department: "研发" },
  { open_id: LI1, localized_name: "小李", enterprise_email: "li1@example.com", department: "研发-前端" },
  { open_id: LI2, localized_name: "小李", enterprise_email: "li2@example.com", department: "销售" },
  { open_id: ZHAO, localized_name: "小赵", enterprise_email: "zhao@example.com", department: "测试" },
  { open_id: QIAN, localized_name: "小钱", enterprise_email: "qian@example.com", department: "已离职" },
];
const CHATS: Record<string, { name: string; chat_mode: string }> = {
  oc_a: { name: "项目 A 讨论群", chat_mode: "group" },
  oc_b: { name: "项目 B 值班群", chat_mode: "topic" },
  oc_other: { name: "日报群", chat_mode: "group" },
  oc_p2p: { name: "", chat_mode: "p2p" },
};

function fakeCli() {
  const calls: string[][] = [];
  setLarkCliForTests(async (args) => {
    calls.push(args);
    const flag = (f: string) => args[args.indexOf(f) + 1];
    if (args[0] === "im" && args[1] === "chats" && args[2] === "get") {
      const c = CHATS[flag("--chat-id")];
      if (!c) throw new Error("232011 operator not in chat");
      return { code: 0, data: c };
    }
    if (args[0] === "contact" && args[1] === "+search-user") {
      if (args.includes("--user-ids")) return { ok: true, data: { users: DIRECTORY.filter((u) => flag("--user-ids").split(",").includes(u.open_id)) } };
      const q = flag("--query");
      return { ok: true, data: { users: DIRECTORY.filter((u) => u.localized_name.includes(q) || u.enterprise_email === q) } };
    }
    if (args[0] === "im" && args[1] === "+chat-members-list") return { ok: true, data: { bots: flag("--chat-id") === "oc_other" ? [{ app_id: "cli_daily", name: "日报助手" }] : [] } };
    if (args[0] === "im" && args[1] === "chat.members" && args[2] === "create") {
      const ids = JSON.parse(flag("--data")).id_list as string[];
      return { code: 0, data: { invalid_id_list: ids.filter((x) => x === QIAN), not_existed_id_list: [], pending_approval_id_list: ids.filter((x) => x === ZHAO) } };
    }
    throw new Error(`unexpected ${args.join(" ")}`);
  });
  return { calls, creates: () => calls.filter((c) => c[1] === "chat.members" && c[2] === "create") };
}

function setup() {
  const app = testApp();
  app.config.approvals.waitSeconds = 0;
  app.config.lark.appId = "cli_omem";
  run(app.db, "insert into kv(key,value) values('lark_bot_name','omem 助手')");
  return app;
}

/** A turn of the assistant: answering the owner's own message, or not (a wake-up, a rule…). */
function turn(app: App, opts: { ownerAsked: boolean }): ToolContext {
  const thread = createThread(app, { spaceId: "personal", channel: "web", userId: "owner" });
  const messageIds = opts.ownerAsked ? [addMessage(app, thread.id, "user", "把机器人拉进项目 A 讨论群", null, {})] : [];
  const r = createRun(app, { kind: "ask", spaceId: "personal", title: "拉人", input: { conversationId: thread.id, messageIds }, lane: "test-hold", notBefore: "2999-01-01T00:00:00Z" });
  return { ...toolContextForToken(app, issueToolToken({ runId: r.id, spaceId: "personal", spaces: null, tools: null, actor: "agent", larkChats: null }))!, runId: r.id };
}

const audits = (app: App) => all<{ action: string; target: string; detail: string }>(app.db, "select action, target, detail from audit_events where action = 'lark.invite' order by id");

describe("lark_invite: people and bots into the owner's groups, as the owner", () => {
  beforeEach(() => {
    resetLarkAuthForTests();
    for (const c of Object.keys(CHATS)) forgetChatBots(c);
  });
  afterEach(() => setLarkCliForTests(null));

  it("resolves people by unique name, email or open_id, and lists every problem at once", async () => {
    const app = setup();
    fakeCli();
    const [r] = await resolveInvites(app, [{ chat_id: "oc_a", people: ["小王", "li2@example.com", ZHAO] }]);
    expect(r).toMatchObject({ chatId: "oc_a", chatName: "项目 A 讨论群" });
    expect(r.people).toEqual([
      { openId: WANG, name: "小王", email: "wang@example.com" },
      { openId: LI2, name: "小李", email: "li2@example.com" },
      { openId: ZHAO, name: "小赵", email: "zhao@example.com" },
    ]);
    // Remembered: next time from lark_people, with lark-cli's open_id.
    expect(all(app.db, "select cli_open_id from lark_people where name = '小王'")).toEqual([{ cli_open_id: WANG }]);

    // (A fresh library: 小李 above is now known locally, and a name known once is taken from there.)
    const err = await resolveInvites(setup(), [
      { chat_id: "oc_a", people: ["小李", "小孙", id("f")] },
      { chat_id: "oc_p2p", people: ["小王"] },
      { chat_id: "oc_gone", bots: ["不认识的机器人"] },
    ]).catch((e: Error) => e);
    const msg = (err as Error).message;
    // Same name: candidates with email, department and open_id; no guessing.
    expect(msg).toContain("“小李”有 2 个人");
    expect(msg).toContain("li1@example.com，研发-前端");
    expect(msg).toContain(LI2);
    expect(msg).toContain("没有叫“小孙”的人");
    expect(msg).toContain("取不到名字");
    expect(msg).toContain("单聊");
    expect(msg).toContain("读不到群 oc_gone");
    expect(msg).toContain("bots_seen_in");
  });

  it("knows omem's bot as self and other bots by name once seen in a group", async () => {
    const app = setup();
    fakeCli();
    expect((await resolveInvites(app, [{ chat_id: "oc_a", bots: ["self"] }]))[0].bots).toEqual([{ appId: "cli_omem", name: "omem 助手" }]);
    expect((await resolveInvites(app, [{ chat_id: "oc_a", bots: ["cli_daily"] }]).catch((e: Error) => e.message))).toContain("不知道 cli_daily 是哪个机器人");
    const [r] = await resolveInvites(app, [{ chat_id: "oc_a", bots: ["日报助手"] }], ["oc_other"]);
    expect(r.bots).toEqual([{ appId: "cli_daily", name: "日报助手" }]);
    expect(knownBots(app)).toEqual({ cli_daily: "日报助手" });
    // Learned: the app_id works from now on, without bots_seen_in.
    expect((await resolveInvites(app, [{ chat_id: "oc_a", bots: ["cli_daily"] }]))[0].bots[0].name).toBe("日报助手");
  });

  it("asks the owner once for people, runs the approved list in batches, and reports each group", async () => {
    const app = setup();
    const cli = fakeCli();
    const ctx = turn(app, { ownerAsked: true });
    const args = { invites: [{ chat_id: "oc_a", people: ["小王", "小赵", QIAN], bots: ["self"] }, { chat_id: "oc_b", people: ["wang@example.com"] }], reason: "项目 A 下周开始联调" };
    const held = await callTool(ctx, "lark_invite", args);
    expect(held.text).toContain("需要本人批准");
    expect(cli.creates()).toHaveLength(0);
    const asks = listAsks(app);
    expect(asks).toHaveLength(1);
    const q = asks[0].question;
    for (const s of ["项目 A 讨论群", "项目 B 值班群", "小王（wang@example.com）", "小赵（zhao@example.com）", "小钱", "机器人 omem 助手", "项目 A 下周开始联调", "一次全部执行"]) expect(q).toContain(s);
    // Held as ids only: approving runs exactly what the card showed.
    expect(asks[0].args).toEqual({ invites: [{ chat_id: "oc_a", people: [WANG, ZHAO, QIAN], bots: ["cli_omem"] }, { chat_id: "oc_b", people: [WANG] }], reason: "项目 A 下周开始联调" });

    // The same call again: no second card.
    expect((await callTool(ctx, "lark_invite", args)).text).toContain("正在等本人批准");
    expect(listAsks(app)).toHaveLength(1);

    const answered = await answerAsk(app, asks[0].id, { approved: true, by: "owner" });
    const creates = cli.creates();
    expect(creates.map((c) => [c[c.indexOf("--chat-id") + 1], c[c.indexOf("--member-id-type") + 1]])).toEqual([["oc_a", "open_id"], ["oc_a", "app_id"], ["oc_b", "open_id"]]);
    expect(creates.every((c) => c.includes("--succeed-type") && c.at(-1) === "user")).toBe(true);
    expect(answered.result).toContain("已用本人身份把 小王（wang@example.com）、机器人 omem 助手 拉进「项目 A 讨论群」");
    expect(answered.result).toContain("等群主或管理员审批：小赵（zhao@example.com）");
    expect(answered.result).toContain("无效（离职、不可见或应用未启用）：小钱（qian@example.com）");
    expect(answered.result).toContain("拉进「项目 B 值班群」");
    const log = audits(app);
    expect(log.map((a) => a.target)).toEqual(["oc_a", "oc_b"]);
    expect(JSON.parse(log[0].detail)).toMatchObject({ runId: ctx.runId, approved: true, result: { pending: ["小赵（zhao@example.com）"] } });
  });

  it("splits more than 50 people into batches", async () => {
    const app = setup();
    const cli = fakeCli();
    const many = Array.from({ length: 60 }, (_, i) => `ou_${String(i).padStart(32, "0")}`);
    for (const [i, x] of many.entries()) rememberPerson(app, { cliOpenId: x, name: `同事${i}`, email: `p${i}@example.com` });
    const ctx = turn(app, { ownerAsked: true });
    await callTool(ctx, "lark_invite", { invites: [{ chat_id: "oc_a", people: many }], reason: "全组进群" });
    await answerAsk(app, listAsks(app)[0].id, { approved: true, by: "owner" });
    expect(cli.creates().map((c) => JSON.parse(c[c.indexOf("--data") + 1]).id_list.length)).toEqual([50, 10]);
  });

  it("does nothing when the owner refuses", async () => {
    const app = setup();
    const cli = fakeCli();
    const ctx = turn(app, { ownerAsked: true });
    await callTool(ctx, "lark_invite", { invites: [{ chat_id: "oc_a", people: ["小王"] }], reason: "联调" });
    await answerAsk(app, listAsks(app)[0].id, { approved: false, by: "owner", text: "先别拉" });
    expect(cli.creates()).toHaveLength(0);
    expect(audits(app)).toHaveLength(0);
  });

  it("adds bots it can name directly, tells the agent to report it, and audits", async () => {
    const app = setup();
    const cli = fakeCli();
    // Not a turn the owner asked in: bots still join directly by default.
    const ctx = turn(app, { ownerAsked: false });
    const out = await callTool(ctx, "lark_invite", { invites: [{ chat_id: "oc_a", bots: ["日报助手", "self"] }], reason: "日报发到这个群", bots_seen_in: ["oc_other"] });
    expect(out.isError).toBe(false);
    expect(out.text).toContain("已用本人身份把 机器人 日报助手、机器人 omem 助手 拉进「项目 A 讨论群」");
    expect(out.text).toContain("告诉本人");
    expect(listAsks(app)).toHaveLength(0);
    expect(JSON.parse(cli.creates()[0][cli.creates()[0].indexOf("--data") + 1]).id_list).toEqual(["cli_daily", "cli_omem"]);
    expect(JSON.parse(audits(app)[0].detail)).toMatchObject({ approved: false, bots: [{ appId: "cli_daily", name: "日报助手" }, { appId: "cli_omem", name: "omem 助手" }] });
    // A bare app_id omem has never seen is refused, not added.
    const bare = await callTool(ctx, "lark_invite", { invites: [{ chat_id: "oc_a", bots: ["cli_unknown"] }], reason: "试试" });
    expect(bare.isError).toBe(true);
    expect(bare.text).toContain("bots_seen_in");
    expect(cli.creates()).toHaveLength(1);
  });

  it("with botApproval, bots wait too, except omem's own bot in a turn the owner asked for", async () => {
    const app = setup();
    app.config.lark.invite.botApproval = true;
    const cli = fakeCli();
    expect((await callTool(turn(app, { ownerAsked: false }), "lark_invite", { invites: [{ chat_id: "oc_a", bots: ["self"] }], reason: "回复群里的问题" })).text).toContain("需要本人批准");
    expect(cli.creates()).toHaveLength(0);
    const asked = turn(app, { ownerAsked: true });
    expect((await callTool(asked, "lark_invite", { invites: [{ chat_id: "oc_a", bots: ["self"] }], reason: "回复群里的问题" })).text).toContain("拉进「项目 A 讨论群」");
    expect(cli.creates()).toHaveLength(1);
    // Another bot, even when the owner asked: waits.
    expect((await callTool(asked, "lark_invite", { invites: [{ chat_id: "oc_a", bots: ["日报助手"] }], reason: "日报", bots_seen_in: ["oc_other"] })).text).toContain("需要本人批准");
    expect(listAsks(app)).toHaveLength(2);
  });

  it("asks for the whole call when people and bots are mixed, even in a turn the owner asked for", async () => {
    const app = setup();
    const cli = fakeCli();
    const out = await callTool(turn(app, { ownerAsked: true }), "lark_invite", { invites: [{ chat_id: "oc_a", bots: ["self"] }, { chat_id: "oc_b", people: ["小王"] }], reason: "联调" });
    expect(out.text).toContain("需要本人批准");
    expect(cli.creates()).toHaveLength(0);
    expect(listAsks(app)[0].question).toContain("机器人 omem 助手");
  });

  it("is the owner's only, and not for outside agents", async () => {
    const app = setup();
    const cli = fakeCli();
    const ctx = turn(app, { ownerAsked: true });
    const other = await callTool({ ...ctx, userId: "u_other" }, "lark_invite", { invites: [{ chat_id: "oc_a", bots: ["self"] }], reason: "x" });
    expect(other.isError).toBe(true);
    const outside = await callTool({ ...ctx, larkChats: undefined }, "lark_invite", { invites: [{ chat_id: "oc_a", bots: ["self"] }], reason: "x" });
    expect(outside.text).toContain("omem 自己的运行");
    expect(cli.creates()).toHaveLength(0);
  });

  it("rules bring omem's bot in through the same call", async () => {
    const app = setup();
    const cli = fakeCli();
    await inviteOwnBot(app, "oc_a");
    expect(cli.creates()[0]).toEqual(expect.arrayContaining(["--member-id-type", "app_id", "--as", "user"]));
    expect(JSON.parse(cli.creates()[0][cli.creates()[0].indexOf("--data") + 1]).id_list).toEqual(["cli_omem"]);
  });
});
