import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { answerAsk, listAsks } from "../src/agents/asks.ts";
import { createRun } from "../src/agents/runs.ts";
import { addMessage, createThread } from "../src/agents/threads.ts";
import { callTool, LARK_TOOL_IDENTITIES, registerTool, toolSchemas, unregisterTools, type ToolContext } from "../src/agents/tools.ts";
import { scopesFor } from "../src/auth/features.ts";
import { storeConnection } from "../src/auth/vault.ts";
import { registerLarkAsks } from "../src/channels/lark-asks.ts";
import { resetLarkAuthForTests } from "../src/channels/lark-auth.ts";
import { larkActor, larkCli, setLarkCliForTests } from "../src/channels/lark-cli.ts";
import { clearRiskCache } from "../src/channels/lark-cli-tools.ts";
import { withLarkDocReader } from "../src/channels/lark-docs.ts";
import { setLarkClient } from "../src/channels/lark-send.ts";
import { getCrawl, resumeCrawls, startCrawl } from "../src/channels/lark-wiki.ts";
import { asRuleLarkUser } from "../src/auth/lark-user.ts";
import { all, one, run } from "../src/core/db.ts";
import { createUser, linkIdentity } from "../src/core/users.ts";
import { decideRunAs, endActing } from "../src/rules/run-as.ts";
import { saveRule } from "../src/rules/store.ts";
import { testApp } from "./helpers.ts";

const origin = "https://tenant.larkoffice.com";
const doc = `${origin}/docx/MemberDoc`;
const shared = `${origin}/sheets/Shared`;
const group = "oc_aabb";
const member = "ann";
const memberOpenId = "ou_ann";
const ownerOpenId = "ou_owner";
let app: ReturnType<typeof testApp>, ctx: ToolContext, ruleId: string;
let calls: { args: string[]; actor?: string; credential?: string }[];
let posted: { target: string; type: string }[];

function connect() {
  storeConnection(app, { userId: member, provider: "lark", accountId: "fixture", accountName: "小安",
    scopes: scopesFor("lark", ["doc-write"]), accessToken: "sample-token", expiresIn: 7200 });
}

beforeEach(() => {
  app = testApp();
  app.config.approvals.waitSeconds = 0;
  app.config.lark.appId = "cli_example";
  app.config.lark.ownerOpenId = ownerOpenId;
  resetLarkAuthForTests();
  clearRiskCache();
  createUser(app, { id: member, name: "小安" });
  linkIdentity(app, member, "lark", memberOpenId, { kind: "alias" });

  calls = [];
  posted = [];
  setLarkClient({ im: { message: {
    create: async (a: { data: { receive_id: string; msg_type: string } }) => {
      posted.push({ target: a.data.receive_id, type: a.data.msg_type });
      return { code: 0, data: { message_id: `om_posted${posted.length}` } };
    },
    patch: async () => ({ code: 0 }),
    list: async () => ({ code: 0, data: { items: [] } }),
  } } });
  registerLarkAsks(app, () => ownerOpenId);
  setLarkCliForTests(async (args, cwd, credential) => {
    const actor = larkActor.getStore()?.userId;
    calls.push({ args, actor, credential });
    const [, command] = args;
    if (args.at(-1) === "--help") return `Risk: ${command === "+cells-clear" ? "high-risk-write" : command === "+cells-get" ? "read" : "write"}`;
    if (command === "status") return { identities: { user: { open_id: ownerOpenId } } };
    if (command === "metas") return { data: { metas: [{ owner_id: args.join(" ").includes("Member") ? memberOpenId : "ou_third", title: "预算表" }] } };
    if (command === "+node-get") {
      const token = args[args.indexOf("--node-token") + 1].split("/").at(-1);
      if (token === "MemberDoc") return { code: 131014, msg: "not in wiki" };
      return { data: { node: { node_token: token, obj_token: "WikiDoc", obj_type: "docx", node_type: "origin", space_id: "7001",
        parent_node_token: token === "Child" ? "Root" : undefined, title: "示例页面" } } };
    }
    if (command === "spaces") return { data: { space: { space_id: "7002", name: "团队知识库" } } };
    if (command === "+fetch") return { data: { document: { document_id: "Doc", title: "示例文档", content: "<p>示例正文</p>", revision_id: 1 } } };
    if (command === "+chat-list") return { data: { chats: [{ chat_id: group, chat_mode: "group", name: "项目 A" }] } };
    if (command === "+messages-mget") {
      const message = { chat_id: group, msg_type: "file", content: '<file key="file_example" name="sample.txt">' };
      if (!args.includes("--download-resources")) return { data: { messages: [message] } };
      writeFileSync(join(cwd!, "sample.txt"), "示例附件");
      return { data: { messages: [{ ...message, resources: [{ key: "file_example", local_path: "sample.txt" }] }] } };
    }
    return { data: { document: { document_id: "NewDoc", content: "", revision_id: 2 }, values: [["示例"]] } };
  });

  const conversation = createThread(app, { spaceId: "personal", channel: "lark", key: group, title: "项目 A", settings: { group: true } });
  const rule = saveRule(app, {
    name: "填周报", description: "用成员自己的身份查数据并整理周报",
    trigger: { event: "schedule", cron: "0 17 * * 5" }, judge: "code",
    actions: [{ type: "agent", spec: "assistant", task: "整理周报", reply: "none", runAs: [member] }],
  }, "user", "owner");
  ruleId = rule.id;
  decideRunAs(app, ruleId, member, true, member);
  const { id: runId } = createRun(app, { kind: "agent", spaceId: "personal", title: "填周报", userId: "owner",
    input: { conversationId: conversation.id, rule: { id: ruleId, runAs: [member] } } });
  ctx = { app, runId, actor: "agent", spaceId: "personal", spaces: null, tools: null, larkChats: [group], userId: "owner" };
});

afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 20));
  endActing(ctx.runId!);
  setLarkCliForTests(null);
  setLarkClient(null);
  vi.unstubAllEnvs();
  resetLarkAuthForTests();
  app.db.close();
  rmSync(app.home, { recursive: true, force: true });
});

const actAs = async (user: string | null) => expect((await callTool(ctx, "act_as", { user })).isError).toBe(false);
const sheetWrite = (target: string) => ({ target, command: ["sheets", "+cells-set", "--url", target], summary: "补齐周报数字" });
const remoteCalls = () => calls.filter(c => c.args.includes("--as"));

it("飞书工具显式声明身份，采集入口也在清单中", () => {
  const names = toolSchemas().map(({ name }) => name);
  const larkNames = names.filter(name => /(^|_)lark(_|$)/.test(name));
  expect(Object.keys(LARK_TOOL_IDENTITIES)).toEqual(expect.arrayContaining([...larkNames, "import_url"]));
  expect(names).toEqual(expect.arrayContaining(Object.keys(LARK_TOOL_IDENTITIES)));
});

it("新增工具漏登记身份时，换身份后禁止落到本人的个人登录", async () => {
  const name = "example_tool";
  registerTool({ name, description: "示例", schema: z.object({}), handler: async () => {
    await larkCli(["im", "+chat-list", "--as", "user"]);
    return "ok";
  } });
  try {
    await actAs(member);
    expect((await callTool(ctx, name, {})).text).toContain("没有声明飞书个人身份");
    expect(calls).toHaveLength(0);
  } finally {
    unregisterTools([name]);
  }
});

it("换身份后读文档、查会话、下载附件和写自己的文件都用成员身份，换回后读走本人的登录", async () => {
  connect();
  await actAs(member);
  expect((await callTool(ctx, "lark_doc_fetch", { doc })).text).toContain("示例正文");
  expect((await callTool(ctx, "import_url", { url: doc, depth: 0 })).text).toContain("已保存原件");
  const imported = one<{ meta: string }>(app.db, "select meta from sources where uri = ?", doc)!;
  const meta = JSON.parse(imported.meta);
  expect(meta).toMatchObject({ capturedBy: member, ruleCapture: true });
  expect(withLarkDocReader(app, "personal", meta, async () => "would refresh")).toBeNull();
  expect((await callTool(ctx, "lark_read", { command: ["sheets", "+cells-get", "--url", shared] })).isError).toBe(false);
  expect((await callTool(ctx, "list_lark_chats", {})).text).toContain("项目 A");
  expect((await callTool(ctx, "lark_message_file", { message_id: "om_sample", file_key: "file_example" })).text).toContain("src:");
  expect((await callTool(ctx, "lark_write", sheetWrite(`${origin}/sheets/MemberSheet`))).text).toContain("已执行");
  expect((await callTool(ctx, "lark_doc_update", { doc, command: "append", content: "补一行" })).text).toContain("已编辑");
  expect(remoteCalls().length).toBeGreaterThan(7);
  expect(remoteCalls().every(({ actor, credential }) => actor === member && credential === member)).toBe(true);
  expect(listAsks(app, { status: "pending" })).toHaveLength(0);
  expect(all(app.db, "select actor from audit_events where action = 'lark.run-as.write'")).toEqual([{ actor: member }, { actor: member }]);
  expect(all(app.db, "select data from run_events where run_id = ? and data like '%以小安的身份写入飞书%'", ctx.runId)).toHaveLength(2);
  expect((await callTool(ctx, "lark_write", { ...sheetWrite(shared), command: ["sheets", "+cells-clear", "--url", shared] })).text).toContain("高风险");

  await actAs(null);
  expect((await callTool(ctx, "lark_doc_fetch", { doc })).isError).toBe(false);
  expect(remoteCalls().at(-1)).toMatchObject({ actor: "owner", credential: undefined });
});

it("消息仍走机器人，拉人要先换回，成员没登录会被提醒且不会用本人的凭据", async () => {
  await actAs(member);
  expect((await callTool(ctx, "lark_send", { chat_id: group, text: "规则结果" })).isError).toBe(false);
  expect(posted.at(-1)).toMatchObject({ target: group, type: "text" });
  expect((await callTool(ctx, "lark_chat_history", { chat_id: group })).text).toContain("没有读到更早的消息");
  expect((await callTool(ctx, "lark_invite", { invites: [{ chat_id: group, bots: ["self"] }], reason: "接收项目消息" })).text).toContain("act_as(null)");
  for (const [tool, args] of [
    ["lark_doc_fetch", { doc }], ["lark_write", sheetWrite(shared)],
    ["lark_message_file", { message_id: "om_sample" }],
  ] as const) {
    const result = await callTool(ctx, tool, args);
    expect(result).toMatchObject({ isError: true, text: expect.stringMatching(/小安没有可用的飞书个人登录.*跳过/s) });
  }
  expect(calls).toHaveLength(0);
  expect(one(app.db, "select 1 from notifications where user_id = ? and title like '飞书授权%'", member)).toBeTruthy();
});

it("机器人发消息时要补读引用位置，只用当前成员的连接读取", async () => {
  connect();
  await actAs(member);
  const thread = createThread(app, { spaceId: "personal", channel: "lark", key: "oc_bbcc", title: "项目 B" });
  const source = addMessage(app, thread.id, "user", "核对周报数据", null, { externalId: "om_reference" });
  const out = await callTool(ctx, "lark_send", { chat_id: group, text: `已核对[原始消息](msg:${source})。` });
  expect(out.isError).toBe(false);
  expect(posted.at(-1)).toMatchObject({ target: group, type: "text" });
  expect(remoteCalls()).toMatchObject([{ args: expect.arrayContaining(["+messages-mget", "om_reference"]), actor: member, credential: member }]);
});

it("文档审批只给当前成员；批准延迟执行时仍绑定申请时的身份，两边各自复用批准", async () => {
  connect();
  const pending = () => listAsks(app, { status: "pending", runId: ctx.runId! })[0];
  expect((await callTool(ctx, "lark_write", sheetWrite(shared))).text).toContain("需要本人批准");
  const ownerAsk = pending();
  expect((await answerAsk(app, ownerAsk.id, { by: "owner", approved: true })).result).toContain("已执行");
  await actAs(member);

  expect((await callTool(ctx, "lark_write", sheetWrite(shared))).text).toContain("需要小安批准");
  const memberAsk = pending();
  expect(memberAsk).toMatchObject({ userId: member, askedBy: "owner", conversationId: null });
  await expect.poll(() => one<{ allowed: string }>(app.db, "select allowed from card_interactions where json_extract(payload,'$.askId') = ?", memberAsk.id)?.allowed)
    .toBe(JSON.stringify([memberOpenId]));
  expect(posted.at(-1)).toMatchObject({ target: memberOpenId, type: "interactive" });
  await expect(answerAsk(app, memberAsk.id, { by: "owner", approved: true })).rejects.toThrow(/只有.*成员能批准/);
  expect(listAsks(app, { status: "pending", runId: ctx.runId! })).toHaveLength(1);

  await actAs(null);
  expect((await answerAsk(app, memberAsk.id, { by: member, approved: true })).result).toContain("已执行");
  expect(remoteCalls().at(-1)).toMatchObject({ actor: member, credential: member });
  expect((await callTool(ctx, "lark_write", sheetWrite(shared))).text).toContain("已执行");
  expect(remoteCalls().at(-1)).toMatchObject({ actor: "owner" });
  await actAs(member);
  expect((await callTool(ctx, "lark_write", sheetWrite(shared))).text).toContain("已执行");
  expect(remoteCalls().at(-1)).toMatchObject({ actor: member });
  expect(pending()).toBeUndefined();

  const comment = { target: doc, command: ["drive", "+add-comment", "--url", doc], summary: "补充说明" };
  expect((await callTool(ctx, "lark_write", comment)).text).toContain("已执行");
  await actAs(null);
  expect((await callTool(ctx, "lark_write", comment)).text).toContain("需要本人批准");
});

it("撤回后正在等待批准的写入和后续读取都不会改用本人的登录", async () => {
  connect();
  await actAs(member);
  await callTool(ctx, "lark_write", sheetWrite(shared));
  const pending = listAsks(app, { status: "pending", runId: ctx.runId! })[0];
  decideRunAs(app, ruleId, member, false, member);
  const before = calls.length;
  expect((await answerAsk(app, pending.id, { by: member, approved: true })).result).toContain("已撤回");
  expect((await callTool(ctx, "lark_doc_fetch", { doc })).text).toContain("已撤回");
  expect(calls).toHaveLength(before);
});

it("文档目录授权由成员批准，新建、复制和移动写入记在该成员名下", async () => {
  connect();
  await actAs(member);
  const under = `${origin}/wiki/Root`;
  const child = `${origin}/wiki/Child`;
  const grant = { under, operations: ["create", "copy", "move"], summary: "整理周报目录" };
  expect((await callTool(ctx, "lark_doc_authorize", grant)).text).toContain("需要小安批准");
  const ask = listAsks(app, { userId: member, status: "pending", runId: ctx.runId! })[0];
  expect((await answerAsk(app, ask.id, { by: member, approved: true })).result).toContain("已批准");
  expect(all(app.db, "select 1 from audit_events where action = 'lark.run-as.write'")).toHaveLength(0);
  expect((await callTool(ctx, "lark_doc_create", { parent: under, title: "周报", content: "本周进展" })).text).toContain("新建《周报》");
  expect((await callTool(ctx, "lark_doc_copy", { doc: child, target: under, summary: "备份周报" })).text).toContain("已完整复制");
  expect((await callTool(ctx, "lark_doc_move", { doc: child, target: under })).text).toMatch(/已把 .* 移到/);
  expect(remoteCalls().every(({ actor }) => actor === member)).toBe(true);
  expect(all(app.db, "select actor from audit_events where action = 'lark.run-as.write'")).toEqual(Array(3).fill({ actor: member }));

  await actAs(null);
  expect((await callTool(ctx, "lark_doc_create", { parent: under, title: "周报", content: "本周进展" })).text).toContain("需要本人批准");
});

it("显式机器人文档工具在成员没有个人登录时仍能用机器人凭据", async () => {
  vi.stubEnv("OMEM_LARK_APP_SECRET", "sample-secret");
  await actAs(member);
  expect((await callTool(ctx, "lark_doc_fetch", { doc, identity: "bot" })).text).toContain("示例正文");
  expect((await callTool(ctx, "lark_doc_update", { doc, identity: "bot", command: "append", content: "追加结论" })).text).toContain("已用机器人的身份编辑");
  expect(remoteCalls().map(({ credential }) => credential)).toEqual(["bot:cli_example", "bot:cli_example"]);
  expect(all(app.db, "select 1 from audit_events where action = 'lark.run-as.write'")).toHaveLength(0);
});

it("知识库爬取保存读取者，恢复后台读取时仍用成员身份", async () => {
  connect();
  const actor = { userId: member, ruleId, runId: ctx.runId! };
  const crawl = await asRuleLarkUser(app, actor, () =>
    startCrawl(app, { spaceId: "personal", url: `${origin}/wiki/Root`, depth: 0 }, { background: false }));
  expect(getCrawl(app, crawl.id).reader).toEqual(actor);
  // Start the worker outside the tool's async context, like a server restarting.
  calls.length = 0;
  expect(larkActor.getStore()).toBeUndefined();
  resumeCrawls(app);
  await expect.poll(() => getCrawl(app, crawl.id).status).toBe("done");
  expect(remoteCalls().some(({ args }) => args.includes("+fetch"))).toBe(true);
  expect(remoteCalls().every(({ actor }) => actor === member)).toBe(true);
});
