import { beforeEach, describe, expect, it } from "vitest";
import { answerAsk, listAsks } from "../src/agents/asks.ts";
import { createRun } from "../src/agents/runs.ts";
import { createThread } from "../src/agents/threads.ts";
import { callTool, issueToolToken, toolContextForToken } from "../src/agents/tools.ts";
import { resetLarkAuthForTests } from "../src/channels/lark-auth.ts";
import { setLarkCliForTests } from "../src/channels/lark-cli.ts";
import { clearRiskCache } from "../src/channels/lark-cli-tools.ts";
import { all } from "../src/core/db.ts";
import { ownWriteOf } from "../src/rules/own-writes.ts";
import { testApp } from "./helpers.ts";

const ORIGIN = "https://tenant.larkoffice.com";
const RISK: Record<string, string> = {
  "sheets +cells-get": "read",
  "sheets +cells-set": "write",
  "sheets +create": "write",
  "sheets +cells-clear": "high-risk-write",
  "task +create": "write",
  "im +messages-search": "read",
  "im +messages-send": "write",
  "drive +add-comment": "write",
  "drive +upload": "write",
  "skills read": "read",
  "base +record-upsert": "write",
};

/** A fake lark-cli: --help gives each command's risk label, sheets are the owner's (MINE) or someone else's. */
function fakeCli() {
  const calls: string[][] = [];
  setLarkCliForTests(async (args) => {
    calls.push(args);
    if (args.at(-1) === "--help") {
      const risk = RISK[args.slice(0, -1).join(" ")];
      return risk ? `Usage …\n\nRisk: ${risk}\n` : "Available Commands: …";
    }
    if (args[0] === "skills") return "# lark-sheets\n读写电子表格。";
    if (args[0] === "auth" && args[1] === "status") return { ok: true, identities: { user: { openId: "ou_me", userName: "本人", scope: "sheets:spreadsheet" } } };
    if (args[0] === "drive" && args[1] === "metas") {
      const token = JSON.parse(args[args.indexOf("--data") + 1]).request_docs[0].doc_token;
      return { ok: true, data: { metas: [{ owner_id: token === "MINE" ? "ou_me" : "ou_other", title: token === "MINE" ? "我的预算" : "团队排期" }] } };
    }
    if (args[0] === "sheets" && args[1] === "+cells-get") return { ok: true, data: { values: [["A", 1]] } };
    if (args[0] === "sheets" || args[0] === "task" || args[0] === "drive") return { ok: true, data: { updated: true } };
    if (args[0] === "base") return { ok: true, data: { record: { record_id: "recMadeNew1" } } };
    throw new Error(`unexpected ${args.join(" ")}`);
  });
  return calls;
}

function task(input: Record<string, unknown> = {}) {
  const app = testApp();
  app.config.approvals.waitSeconds = 0;
  const thread = createThread(app, { spaceId: "personal", channel: "web", userId: "owner" });
  const r = createRun(app, { kind: "ask", spaceId: "personal", title: "改表格", input: { conversationId: thread.id, ...input } });
  const ctx = { ...toolContextForToken(app, issueToolToken({ runId: r.id, spaceId: "personal", spaces: null, tools: null, actor: "agent", larkChats: null }))!, runId: r.id };
  return { app, ctx };
}

describe("lark-cli commands run as the owner", () => {
  beforeEach(() => {
    clearRiskCache();
    resetLarkAuthForTests();
  });

  it("reads only what lark-cli labels read, plus its guides, as the owner", async () => {
    const { ctx } = task();
    const calls = fakeCli();
    expect((await callTool(ctx, "lark_read", { command: ["skills", "read", "lark-sheets"] })).text).toContain("读写电子表格");
    const read = await callTool(ctx, "lark_read", { command: ["sheets", "+cells-get", "--url", `${ORIGIN}/sheets/MINE`, "--range", "A1:B2"] });
    expect(read.text).toContain('"A"');
    expect(calls.find((c) => c[1] === "+cells-get" && c.at(-1) !== "--help")).toEqual(expect.arrayContaining(["--as", "user"]));
    expect((await callTool(ctx, "lark_read", { command: ["sheets", "+cells-set", "--url", `${ORIGIN}/sheets/MINE`] })).text).toContain("lark_write");
    expect((await callTool(ctx, "lark_read", { command: ["im", "+messages-send", "--chat-id", "oc_1"] })).text).toContain("写操作");
    expect((await callTool(ctx, "lark_read", { command: ["api", "GET", "/open-apis/x"] })).text).toContain("不能用 api");
    expect((await callTool(ctx, "lark_read", { command: ["sheets", "+nope"] })).text).toContain("没有命令");
    expect((await callTool(ctx, "lark_read", { command: ["sheets", "+cells-get", "--as", "bot"] })).text).toContain("不要传 --as");
  });

  it("writes the owner's own file directly; someone else's waits for one approval per file; tasks always ask", async () => {
    const { app, ctx } = task();
    const calls = fakeCli();
    const writes = () => calls.filter((c) => c.at(-1) !== "--help" && (c[1] === "+cells-set" || c[1] === "+create" || c[1] === "+add-comment"));
    const mine = await callTool(ctx, "lark_write", { command: ["sheets", "+cells-set", "--url", `${ORIGIN}/sheets/MINE`, "--range", "B2", "--values", "[[42]]"], target: `${ORIGIN}/sheets/MINE`, summary: "把预算表 B2 改成 42。" });
    expect(mine.text).toContain("已执行");
    expect(listAsks(app)).toHaveLength(0);
    // The approval is for the target: a command that writes another file is refused.
    expect((await callTool(ctx, "lark_write", { command: ["sheets", "+cells-set", "--url", `${ORIGIN}/sheets/OTHER`], target: `${ORIGIN}/sheets/MINE`, summary: "改表" })).text).toContain("没有 target");
    const theirs = { command: ["sheets", "+cells-set", "--url", `${ORIGIN}/sheets/OTHER`, "--range", "C3", "--values", "[[\"完成\"]]"], target: `${ORIGIN}/sheets/OTHER`, summary: "把排期表里本人那一行标成完成。" };
    expect((await callTool(ctx, "lark_write", theirs)).text).toContain("需要本人批准");
    const ask = listAsks(app)[0];
    expect(ask.question).toContain("别人的表格《团队排期》");
    expect(ask.question).toContain(theirs.summary);
    // Approving runs the held write; a later write to the same file reuses the approval.
    expect((await answerAsk(app, ask.id, { approved: true, by: "owner" })).result).toContain("已执行");
    expect((await callTool(ctx, "lark_write", { ...theirs, command: [...theirs.command.slice(0, 4), "D3"] })).text).toContain("已执行");
    expect(listAsks(app)).toHaveLength(1);
    // A new file in the owner's own Drive needs no target.
    expect((await callTool(ctx, "lark_write", { command: ["sheets", "+create", "--title", "周报数据"], summary: "新建一张周报数据表。" })).text).toContain("已执行");
    expect(writes()).toHaveLength(4);
    expect((await callTool(ctx, "lark_write", { command: ["task", "+create", "--summary", "交周报"], summary: "给本人建一个交周报的任务。" })).text).toContain("需要本人批准");
    expect(listAsks(app)).toHaveLength(2);
  });

  it("refuses high-risk writes, docs, messages and Drive beyond comments", async () => {
    const { ctx } = task();
    fakeCli();
    const sheet = `${ORIGIN}/sheets/MINE`;
    expect((await callTool(ctx, "lark_write", { command: ["sheets", "+cells-clear", "--url", sheet], target: sheet, summary: "清空" })).text).toContain("高风险");
    expect((await callTool(ctx, "lark_write", { command: ["docs", "+update", "--doc", `${ORIGIN}/docx/D`], target: `${ORIGIN}/docx/D`, summary: "改文档" })).text).toContain("lark_doc_update");
    expect((await callTool(ctx, "lark_write", { command: ["im", "+messages-send", "--chat-id", "oc_1"], summary: "发消息" })).text).toContain("不能以本人身份发");
    expect((await callTool(ctx, "lark_write", { command: ["drive", "+upload", "--file", "a.txt"], summary: "上传" })).text).toContain("只能写评论");
    expect((await callTool(ctx, "lark_write", { command: ["sheets", "+cells-set", "--url", sheet, "--yes"], target: sheet, summary: "改" })).text).toContain("不要传 --yes");
  });

  it("notes what a rule's run wrote, so the change it causes does not fire that rule again", async () => {
    const { app, ctx } = task({ rule: { id: "rule_table", name: "表格新行" } });
    fakeCli();
    const base = `${ORIGIN}/base/MINE`;
    const out = await callTool(ctx, "lark_write", { command: ["base", "+record-upsert", "--base-token", "MINE", "--table-id", "tbl1", "--record-id", "recRowOne1", "--json", "{}"], target: base, summary: "把查询结果写回这一行。" });
    expect(out.text).toContain("已执行");
    const change = (recordId: string, byOwner = true) => ({ key: "k", kind: "doc" as const, at: new Date().toISOString(), via: "doc" as const, doc: { token: "MINE", type: "bitable", title: "", url: base }, change: { kind: "record" as const, text: "", recordId, mentions: [], mentionsOwner: false, mentionsBot: false, heardAt: new Date().toISOString(), byOwner } });
    // The record it named and the one it made (from the output) are its own; another rule, another record or another editor are not.
    expect(ownWriteOf(app, "rule_table", change("recRowOne1"))?.runId).toBe(ctx.runId);
    expect(ownWriteOf(app, "rule_table", change("recMadeNew1"))).toBeTruthy();
    expect(ownWriteOf(app, "rule_other", change("recRowOne1"))).toBeUndefined();
    expect(ownWriteOf(app, "rule_table", change("recSomeoneElse"))).toBeUndefined();
    expect(ownWriteOf(app, "rule_table", change("recRowOne1", false))).toBeUndefined();
    // A run no rule started notes nothing.
    const plain = task();
    fakeCli();
    await callTool(plain.ctx, "lark_write", { command: ["base", "+record-upsert", "--base-token", "MINE", "--table-id", "tbl1", "--json", "{}"], target: base, summary: "改一行。" });
    expect(all(plain.app.db, "select 1 from kv where key like 'rule_own_writes:%'")).toHaveLength(0);
  });
});
