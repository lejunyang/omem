import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ask } from "../src/agents/jobs.ts";
import { ownerContextParts } from "../src/agents/owner-now.ts";
import { createRun, waitForRun } from "../src/agents/runs.ts";
import { OWNER } from "../src/core/users.ts";
import { releaseAll } from "../src/agents/sessions.ts";
import { callTool, type ToolContext } from "../src/agents/tools.ts";
import { keepOwnerSection, personCard, personLine, sectionOf, workStateBrief } from "../src/agents/work-state.ts";
import { peopleDue, workFacts, workFactsText } from "../src/agents/work-state-job.ts";
import { guestSpaces } from "../src/channels/lark-guest.ts";
import { persistChatMessages, type LarkMessage } from "../src/channels/lark-messages.ts";
import { noteOpenedDocs } from "../src/channels/lark-personal.ts";
import { rememberPerson } from "../src/channels/lark-people.ts";
import "../src/channels/lark-mentions.ts";
import { one, run } from "../src/core/db.ts";
import { createSpace } from "../src/core/spaces.ts";
import { upsertItem } from "../src/items/store.ts";
import { mentionChannel } from "../src/mentions/channel.ts";
import { triageMaterial } from "../src/mentions/triage.ts";
import { upsertSource } from "../src/sources/store.ts";
import { readPage, writePage } from "../src/wiki/store.ts";
import { boot } from "../src/main.ts";

const fake = (id: string, env: Record<string, string>) => ({ id, transport: "acp", command: process.execPath, args: [resolve("test/fake-acp-agent.ts")], env });

describe("the owner's section of a page", () => {
  it("is put back word for word where the agent's rewrite has it, or at the end", () => {
    const before = "## 摘要\n\n旧的\n\n## 本人补充\n\n- 工单 X：用技能 ticket-status 查\n";
    expect(keepOwnerSection(before, "## 摘要\n\n新的\n\n## 本人补充\n\n（空）\n\n## 尾\n\n尾巴")).toBe("## 摘要\n\n新的\n\n## 本人补充\n\n- 工单 X：用技能 ticket-status 查\n\n## 尾\n\n尾巴");
    expect(keepOwnerSection(before, "## 摘要\n\n新的")).toBe("## 摘要\n\n新的\n\n## 本人补充\n\n- 工单 X：用技能 ticket-status 查");
    // Nothing of the owner's before: the agent may open the section.
    expect(keepOwnerSection("## 摘要\n\n旧的", "## 摘要\n\n新的\n\n## 本人补充\n\n（本人在这里补充）")).toContain("（本人在这里补充）");
    expect(sectionOf("## 甲\n\na\n\n## 乙\n\nb", "甲")?.text).toBe("## 甲\n\na");
  });
});

describe("work state: facts, the nightly write-up, and where it is read", async () => {
  const home = mkdtempSync(join(tmpdir(), "omem-work-state-"));
  const prompts = join(home, "prompts.log");
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      lark: { ownerOpenId: "ou_owner", appId: "cli_bot" },
      agents: { default: "ws", roles: { heartbeat: "echo", assistant: "echo" }, profiles: [fake("ws", { FAKE_MODE: "work-state" }), fake("echo", { FAKE_MODE: "thread", FAKE_PROMPT_LOG: prompts })] },
      sessions: { mergeMs: 0 },
    }),
  );
  const { app, server } = await boot(home, { port: 0, quiet: true, background: false });
  afterAll(() => {
    releaseAll();
    server.close();
  });

  const base = Date.now() - 2 * 86400_000;
  let seq = 0;
  const msg = (chat: string, from: "owner" | "wang" | "li", text: string, minutes: number, mentionsOwner = false): LarkMessage => ({
    message_id: `om_${++seq}`,
    chat_id: chat,
    msg_type: "text",
    content: text,
    create_time: String(base + minutes * 60_000),
    sender: from === "owner" ? { id: "ou_owner", name: "本人", sender_type: "user" } : from === "wang" ? { id: "ou_wang", name: "小王", sender_type: "user" } : { id: "ou_li", name: "小李", sender_type: "user" },
    mentions: mentionsOwner ? [{ id: "ou_owner", name: "本人" }] : [],
  });
  const store = (chat: string, name: string, messages: LarkMessage[]) => persistChatMessages(app, { chatId: chat, spaceId: "personal", name, messages, owner: "ou_owner" });

  // A private chat with 小王, a group where 小李 talks near the owner, and older talk outside the window.
  run(app.db, "insert into lark_cursors(chat_id, name, kind) values('oc_wang', '小王', 'p2p'), ('oc_team', '项目 A 讨论群', 'group')");
  rememberPerson(app, { cliOpenId: "ou_wang", name: "小王", email: "wang@example.com" });
  rememberPerson(app, { cliOpenId: "ou_li", name: "小李", email: "li@example.com" });
  store("oc_wang", "小王", [msg("oc_wang", "wang", "退款字段 refund_amount 的口径是什么？", 0), msg("oc_wang", "owner", "按未发货的行算，文档 https://tenant.larkoffice.com/docx/RefundPlan", 5), msg("oc_wang", "wang", "好的，那对账那边也改吗", 10)]);
  store("oc_team", "项目 A 讨论群", [msg("oc_team", "li", "@本人 周四评审退款改造方案", 20, true), msg("oc_team", "owner", "可以", 22), msg("oc_team", "li", "我订会议室", 25)]);
  const doc = upsertSource(app, { spaceId: "personal", uri: "https://tenant.larkoffice.com/docx/RefundPlan", title: "退款改造方案", kind: "doc", text: "# 退款改造方案\n\n部分退款按未发货行计算。" });
  const opened = upsertSource(app, { spaceId: "personal", uri: "https://tenant.larkoffice.com/docx/Travel", title: "差旅报销制度", kind: "doc", text: "住宿标准……" });
  noteOpenedDocs(app, ["https://tenant.larkoffice.com/docx/Travel"]);
  const item = upsertItem(app, undefined, { spaceId: "personal", kind: "todo", title: "周四前给出退款接口文档", status: "open" });
  run(app.db, "insert into lark_meetings(meeting_id, topic, status, started_at, ended_at, updated_at) values('m1', '退款改造评审', 'ended', ?, ?, ?)", new Date(base).toISOString(), new Date(base + 3600_000).toISOString(), new Date().toISOString());
  const asked = createRun(app, { kind: "ask", spaceId: "personal", title: "查一下退款对账的报表在哪", input: {}, userId: "owner" });
  run(app.db, "update runs set status = 'done' where id = ?", asked.id);

  it("gathers the facts of the window: chats, documents, items, meetings, asks", () => {
    const f = workFacts(app, { since: new Date(base - 86400_000).toISOString() });
    expect(f.chats.map((c) => c.name)).toEqual(expect.arrayContaining(["小王", "项目 A 讨论群"]));
    expect(f.chats.find((c) => c.chatId === "oc_wang")).toMatchObject({ kind: "p2p", owner: 1 });
    expect(f.docs.map((d) => [d.id, d.how])).toEqual(expect.arrayContaining([[doc.id, "发过链接"], [opened.id, "打开过"]]));
    expect(f.items.map((i) => i.id)).toContain(item.id);
    expect(f.meetings[0].topic).toBe("退款改造评审");
    expect(f.asks.map((a) => a.title)).toContain("查一下退款对账的报表在哪");
    const text = workFactsText(app, f);
    expect(text).toContain("「小王」（私聊");
    expect(text).toContain(`src:${doc.id}`);
    // Outside the window, nothing.
    expect(workFacts(app, { since: new Date().toISOString() }).chats).toEqual([]);
  });

  it("picks the people the owner deals with, with their lines and where their card goes", () => {
    const due = peopleDue(app, { since: new Date(base - 86400_000).toISOString(), limit: 8 });
    expect(due.map((p) => p.name)).toEqual(["小王", "小李"]);
    expect(due[0]).toMatchObject({ slug: "people/小王", email: "wang@example.com", p2p: 2, hasCard: false });
    expect(due[0].lines.join("\n")).toMatch(/本人：按未发货的行算.*src:\w+#L\d+/);
    expect(due[1]).toMatchObject({ mentions: 1 });
    expect(peopleDue(app, { since: new Date(base - 86400_000).toISOString(), limit: 1 })).toHaveLength(1);
  });

  it("writes the page and the cards each night, keeps the owner's section, and skips a night with nothing new", async () => {
    writePage(app, "personal", "state/work", { meta: { title: "工作近况", kind: "topic" }, body: "## 摘要\n\n（还没整理）\n\n## 本人补充\n\n- 项目 A 的上线单：用技能 release-status 查状态" }, { actor: "user" });
    const r = await waitForRun(app, createRun(app, { kind: "work-state", spaceId: "personal", title: "整理工作近况与人物卡" }).id);
    expect(r.status).toBe("done");
    const said = JSON.parse(String(r.output.summary).replace(/^近况已更新 /, ""));
    expect(said).toMatchObject({ state: "ok", cards: ["people/小王", "people/小李"], hasOwner: true });
    const page = readPage(app, "personal", "state/work");
    expect(page.body).toContain("退款改造：接口联调中");
    expect(page.body).toContain("- 项目 A 的上线单：用技能 release-status 查状态");
    expect(page.body).not.toContain("应被替换");
    expect(readPage(app, "personal", "people/小王").meta).toMatchObject({ kind: "person", summary: "项目 A 后端，常找本人确认退款字段" });
    expect(workStateBrief(app)).toContain("退款改造：接口联调中");
    expect(personCard(app, { id: "ou_wang" })?.slug).toBe("people/小王");
    expect(personLine(app, { name: "小李" })).toContain("人物卡 personal:people/小李");

    // Nothing new since: no model run.
    const quiet = await waitForRun(app, createRun(app, { kind: "work-state", spaceId: "personal", title: "整理工作近况与人物卡" }).id);
    expect(quiet.output).toMatchObject({ quiet: true });
    // A new message from 小王: only his card is due.
    store("oc_wang", "小王", [msg("oc_wang", "wang", "对账报表也按这个改", 2 * 24 * 60 - 30)]);
    expect(peopleDue(app, { since: new Date(base - 86400_000).toISOString(), limit: 8 }).map((p) => [p.name, p.hasCard])).toEqual([["小王", true]]);
  });

  it("goes into the triage of 有人找你: the summary and the sender's card", async () => {
    const m = one<{ message_id: string; source_id: string; line: number }>(app.db, "select message_id, source_id, line from lark_messages where chat_id = 'oc_team' and sender_id = 'ou_li' order by create_ms limit 1")!;
    const material = await triageMaterial(app, mentionChannel("lark"), {
      chatId: "oc_team", chatName: "项目 A 讨论群", chatKind: "group", topicId: null, spaceId: "personal",
      messages: [{ id: m.message_id, sender: "小李", senderId: "ou_li", atMs: base + 20 * 60_000, text: "@本人 周四评审退款改造方案", topicId: null, quoted: null, sourceId: m.source_id, ref: `src:${m.source_id}#L${m.line}` }],
    });
    expect(material.本人近况).toContain("退款改造：接口联调中");
    expect(material.发送人).toContain("项目 A 后端，常找本人确认退款字段（人物卡 personal:people/小李）");
    expect(material.本人在这个会话里).toContain("发了 1 条消息");
    expect(material.本人给这个会话设的规则).toBeUndefined();
    // A rule naming the chat, and an earlier handling there, go in as well.
    const { saveRule } = await import("../src/rules/store.ts");
    saveRule(app, { name: "讨论群评审", description: "讨论群里有人约评审就看日历", enabled: true, trigger: { event: "message" }, conditions: { all: [{ field: "chat.id", op: "equals", value: "oc_team" }] }, judge: "code", actions: [{ type: "notify" }] } as never, "user", OWNER);
    const handled = createRun(app, { kind: "agent", spaceId: "personal", title: "处理", input: { mention: { chatId: "oc_team" } } });
    run(app.db, "update runs set status = 'done', output = ? where id = ?", JSON.stringify({ answer: "小李约了周三的评审，已经回复" }), handled.id);
    const again = await triageMaterial(app, mentionChannel("lark"), { chatId: "oc_team", chatName: "项目 A 讨论群", chatKind: "group", topicId: null, spaceId: "personal", messages: [] });
    expect(again.本人给这个会话设的规则).toContain("讨论群评审");
    expect(again.最近在这个会话里的处理).toContain("小李约了周三的评审");
    app.config.workState.inject = false;
    expect(ownerContextParts(app, { state: true })).toEqual({});
    app.config.workState.inject = true;
  });

  it("goes into the patrol and the owner's conversation turns", async () => {
    upsertItem(app, undefined, { spaceId: "personal", kind: "watch", title: "盯退款改造", status: "open" });
    upsertSource(app, { spaceId: "personal", uri: "note://fresh", title: "新笔记", kind: "note", text: "新的进展" });
    run(app.db, "delete from kv where key = 'heartbeat_at'");
    const hb = await waitForRun(app, createRun(app, { kind: "heartbeat", spaceId: "personal", title: "巡检" }).id);
    expect(hb.status).toBe("done");
    const r = await ask(app, { text: "这周我该先做什么？" });
    await waitForRun(app, r.runId!);
    const log = readFileSync(prompts, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string);
    expect(log.find((p) => p.includes("关注/等待中的事项"))).toContain("本人近况（本人这几周在推进的事");
    const turn = log.find((p) => p.includes("这周我该先做什么"))!;
    expect(turn).toContain("## 本人近况");
    expect(turn).toContain("退款改造：接口联调中");
  });

  it("is out of reach of guests: their spaces leave out personal, and reading a card is refused", async () => {
    createSpace(app, { id: "project-a", name: "项目 A", kind: "project" });
    const spaces = guestSpaces(app, "personal");
    expect(spaces).not.toContain("personal");
    const ctx: ToolContext = { app, runId: null, spaceId: "project-a", spaces: ["project-a"], tools: new Set(["read_page", "list_pages"]), actor: "agent" };
    const r = await callTool(ctx, "read_page", { space: "personal", page: "people/小王" });
    expect(r.isError).toBe(true);
    expect((await callTool(ctx, "list_pages", { space: "personal" })).isError).toBe(true);
  });
});
