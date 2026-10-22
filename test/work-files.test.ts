import { describe, expect, it } from "vitest";
import { saveAgentSpec } from "../src/agents/specs.ts";
import { callTool, issueToolToken, toolContextForToken } from "../src/agents/tools.ts";
import { createThread } from "../src/agents/threads.ts";
import { one, run } from "../src/core/db.ts";
import { upsertItem } from "../src/items/store.ts";
import { shortcomings, shortcomingsText } from "../src/memory/gaps.ts";
import { fireScheduledRule } from "../src/rules/engine.ts";
import { listFirings, saveRule } from "../src/rules/store.ts";
import { getSource, sourceText } from "../src/sources/store.ts";
import { expireWorkFiles, expiryFrom, listWorkFiles } from "../src/sources/work.ts";
import { testApp } from "./helpers.ts";

const agentCtx = (app: ReturnType<typeof testApp>, runId: string | null = null) =>
  toolContextForToken(app, issueToolToken({ runId, spaceId: "personal", spaces: null, tools: null, actor: "agent" }))!;
const idOf = (text: string) => /src:(\S+?)（/.exec(text)![1];

describe("working files", () => {
  it("keeps a long task's results on its item: create, append, read back from the item", async () => {
    const app = testApp();
    const item = upsertItem(app, undefined, { spaceId: "personal", kind: "todo", title: "统计一年内的报警群", userId: "owner" });
    const ctx = agentCtx(app);
    const first = await callTool(ctx, "write_file", { path: "alerts/一年内的群", title: "报警群清单", content: "## 已扫描\n- 群 A：12 条报警", item: item.id });
    expect(first.text).toMatch(/已新建工作文件 src:\S+（work\/alerts\/一年内的群，.*永久，挂在事项/);
    const id = idOf(first.text);
    const second = await callTool(ctx, "write_file", { path: "/alerts/一年内的群", content: "- 群 B：3 条报警", mode: "append" });
    expect(second.text).toContain("已追加到");
    expect(sourceText(app, id)).toBe("## 已扫描\n- 群 A：12 条报警\n\n- 群 B：3 条报警");
    // The link survives a write that does not repeat it; the item shows the file and one timeline entry.
    const read = JSON.parse((await callTool(ctx, "read_item", { item_id: item.id })).text);
    expect(read.files).toEqual([expect.objectContaining({ id: `src:${id}`, path: "work/alerts/一年内的群", title: "报警群清单" })]);
    expect(read.events.filter((e: { text: string }) => e.text.includes("工作文件"))).toHaveLength(1);
    expect(getSource(app, id)).toMatchObject({ kind: "work", meta: { writes: 2 } });
    // Searchable like any original.
    expect((await callTool(ctx, "search", { query: "报警群清单" })).text).toContain(id);
    app.db.close();
  });

  it("expires temporary files into tombstones and leaves permanent ones", async () => {
    const app = testApp();
    const ctx = agentCtx(app);
    const draft = idOf((await callTool(ctx, "write_file", { path: "weekly/2026-W43", content: "周一：…", expires: "14d" })).text);
    const keep = idOf((await callTool(ctx, "write_file", { path: "reports/2026-Q4", content: "季度报告" })).text);
    expect(listWorkFiles(app).map((f) => f.id).sort()).toEqual([draft, keep].sort());
    expect(expireWorkFiles(app, new Date(Date.now() + 15 * 86400_000).toISOString())).toBe(1);
    expect(getSource(app, draft).deletedAt).not.toBeNull();
    expect(getSource(app, keep).deletedAt).toBeNull();
    // Writing the same path again brings it back as a new file (fresh expiry, nothing appended to the old text).
    const again = await callTool(ctx, "write_file", { path: "weekly/2026-W43", content: "下一轮", mode: "append", expires: "never" });
    expect(again.text).toContain("已新建");
    expect(sourceText(app, draft)).toBe("下一轮");
    expect(expiryFrom("2w", 0)).toBe(new Date(14 * 86400_000).toISOString());
    expect(() => expiryFrom("下周")).toThrow(/看不懂/);
    app.db.close();
  });

  it("a scheduled rule's agent files its report under the rule, and the next firing is shown it", async () => {
    const app = testApp();
    saveAgentSpec(app, { name: "reporter", description: "整理周报", prompt: "整理周报。" }, "user");
    const rule = saveRule(app, { name: "周报素材", description: "每天把今天的进展追加到本周周报草稿", enabled: true, trigger: { event: "schedule", once: "event", cron: "0 18 * * 1-5" }, judge: "code", conditions: null, actions: [{ type: "agent", spec: "reporter", task: "追加今天的进展", ownTopic: false, reply: "none" }] });
    await fireScheduledRule(app, rule.id);
    const runId = listFirings(app, rule.id)[0].results[0].runId!;
    const firstTask = JSON.parse(one<{ input: string }>(app.db, "select input from runs where id = ?", runId)!.input).task as string;
    expect(firstTask).not.toContain("这条规则的工作文件");
    // The agent writes without naming the rule: the run it is in ties the file to it.
    const r = await callTool(agentCtx(app, runId), "write_file", { path: "weekly/2026-W43", content: "周一：上线了 A", expires: "30d" });
    expect(r.text).toContain(`挂在规则 ${rule.id}`);
    run(app.db, "delete from rule_handled");
    await new Promise((res) => setTimeout(res, 5));
    await fireScheduledRule(app, rule.id);
    const next = listFirings(app, rule.id)[0].results[0].runId!;
    const task = JSON.parse(one<{ input: string }>(app.db, "select input from runs where id = ?", next)!.input).task as string;
    expect(task).toContain("这条规则的工作文件");
    expect(task).toContain("work/weekly/2026-W43");
    app.db.close();
  });

  it("suggests a case page when an item with a history of progress is closed", async () => {
    const app = testApp();
    const ctx = agentCtx(app);
    const item = upsertItem(app, undefined, { spaceId: "personal", kind: "todo", title: "排查登录超时", userId: "owner" });
    for (const note of ["复现：只在内网", "怀疑 DNS", "确认是代理超时"]) await callTool(ctx, "upsert_item", { id: item.id, note });
    const done = await callTool(ctx, "upsert_item", { id: item.id, status: "done", note: "调大代理超时后恢复" });
    expect(done.text).toContain("kind=case");
    const small = upsertItem(app, undefined, { spaceId: "personal", kind: "todo", title: "交报销单", userId: "owner" });
    expect((await callTool(ctx, "upsert_item", { id: small.id, status: "done" })).text).not.toContain("kind=case");
    app.db.close();
  });
});

describe("shortcomings", () => {
  it("collects answers that found nothing, corrections, failures and rejected writes", () => {
    const app = testApp();
    const t = createThread(app, { spaceId: "personal", channel: "web", userId: "owner" });
    const at = (m: number) => new Date(Date.now() - 3600_000 + m * 1000).toISOString();
    const msg = (id: string, role: string, text: string, m: number) => run(app.db, "insert into messages(id,conversation_id,role,text,created_at) values(?,?,?,?,?)", id, t.id, role, text, at(m));
    msg("m1", "user", "项目 A 的发布窗口是什么时候？", 1);
    msg("m2", "assistant", "知识库里没有找到项目 A 发布窗口的记录。", 2);
    msg("m3", "user", "报销上限是多少", 3);
    msg("m4", "assistant", "报销上限是 500 元。", 4);
    msg("m5", "user", "不对，去年就改成 800 了", 5);
    msg("m6", "user", "好的谢谢", 6);
    run(app.db, "insert into runs(id,kind,status,title,error,created_at) values('r1','ingest','failed','整理','ACP connection closed',?)", at(7));
    run(app.db, "insert into memory_rejections(id,space_id,tool,kind,content,codes,at) values('x1','personal','remember','fact','今天看了文档','[\"diary\"]',?)", at(8));
    const s = shortcomings(app);
    expect(s.notFound).toEqual([expect.objectContaining({ messageId: "m2", question: "项目 A 的发布窗口是什么时候？" })]);
    expect(s.corrections).toEqual([expect.objectContaining({ messageId: "m5", answer: "报销上限是 500 元。" })]);
    expect(s.failedRuns).toEqual([expect.objectContaining({ kind: "ingest", n: 1, lastRunId: "r1" })]);
    expect(s.rejectedWrites).toMatchObject({ n: 1, codes: { diary: 1 } });
    const text = shortcomingsText(s);
    expect(text).toContain("msg:m2");
    expect(text).toContain("msg:m5");
    app.db.close();
  });
});
