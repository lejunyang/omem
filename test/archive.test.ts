import { afterEach, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { importFile } from "../src/sources/import.ts";
import { testApp } from "./helpers.ts";
import { createSpace } from "../src/core/spaces.ts";
import { all, one, run } from "../src/core/db.ts";
import { applyArchivePreview, archiveHistory, moveSource, previewArchive, saveArchiveRule, sourceRoute } from "../src/sources/archive.ts";
import { getSource, sourceText, upsertSource } from "../src/sources/store.ts";
import { vectorIndex } from "../src/search/vectors.ts";
import { createRun, getRun, listRuns, __testHandlers } from "../src/agents/runs.ts";
import { scheduleIngest } from "../src/agents/jobs.ts";
import { callTool, type ToolContext } from "../src/agents/tools.ts";
import { createThread, resolveThread, setChatSettings } from "../src/agents/threads.ts";
import { captureSpace } from "../src/core/capture-space.ts";
import { runActions } from "../src/rules/actions.ts";
import { getRule, saveRule } from "../src/rules/store.ts";
import { persistChatMessages } from "../src/channels/lark-messages.ts";
import { setLarkCliForTests } from "../src/channels/lark-cli.ts";
import { importLarkDocument } from "../src/channels/lark-docs.ts";

const apps: ReturnType<typeof testApp>[] = [];
function setup() {
  const app = testApp(); apps.push(app);
  createSpace(app, { id: "project-a", name: "项目 A", kind: "project" });
  createSpace(app, { id: "project-b", name: "项目 B", kind: "project" });
  return app;
}
afterEach(async () => {
  setLarkCliForTests(null);
  apps.splice(0).forEach(a => a.db.close());
  vectorIndex().clear();
  // Each fixture performs synchronous Git/SQLite work; let the worker report between fixtures.
  await setImmediate();
});
const material = { spaceId: "personal", kind: "doc" as const, uri: "https://example.com/a", title: "项目 A 设计", text: "接口设计与发布计划", archive: true };
const rule = { name: "项目文档", description: "项目 A 标题的材料归到项目 A", target: "project-a", enabled: true, conditions: { field: "title" as const, op: "contains" as const, value: "项目 A" } };

describe("source archiving", () => {
  it("rejects unknown source kinds in saved rules and AI drafts", async () => {
    const app = setup();
    const invalid = { ...rule, conditions: { field: "kind", op: "equals", value: "document" } };
    expect(() => saveArchiveRule(app, invalid)).toThrow("doc");
    const r = createRun(app, { kind: "archive-rule-draft", spaceId: "personal", title: "归档草稿" });
    const ctx: ToolContext = { app, runId: r.id, spaceId: "personal", spaces: null, tools: null, actor: "agent", role: "archive-rule-writer" };
    expect((await callTool(ctx, "propose_archive_rule", invalid)).isError).toBe(true);
    expect(getRun(app, r.id).output.rule).toBeUndefined();
    expect((await callTool(ctx, "propose_archive_rule", { ...invalid, conditions: { field: "kind", op: "in", value: ["doc", "note"] } })).isError).toBe(false);
    expect(getRun(app, r.id).output.rule).toMatchObject({ enabled: false, conditions: { value: ["doc", "note"] } });
  });
  it("groups deferred ingestion by final space when rules resolve a queued batch", async () => {
    const app = setup();
    const a = upsertSource(app, material);
    const b = upsertSource(app, { ...material, uri: "second" });
    const c = upsertSource(app, { ...material, uri: "third", title: "项目 B 设计" });
    scheduleIngest(app, "personal", [a.id, b.id, c.id]);
    saveArchiveRule(app, rule);
    saveArchiveRule(app, { ...rule, target: "project-b", conditions: { field: "title", op: "contains", value: "项目 B" } });
    const archive = listRuns(app, { kind: "archive" })[0];
    await __testHandlers.get("archive")!({ app, run: archive, signal: new AbortController().signal, event() {}, output() {} });
    const ingests = listRuns(app, { kind: "ingest" });
    expect(ingests).toHaveLength(2);
    expect(ingests.find(r => r.spaceId === "project-a")?.input.sourceIds).toEqual([a.id, b.id]);
    expect(ingests.find(r => r.spaceId === "project-b")?.input.sourceIds).toEqual([c.id]);
    expect([a, b, c].map(s => sourceRoute(app, s.id)?.ingest)).toEqual([0, 0, 0]);
  });
  it("routes automatically captured text attachments while preserving explicit imports", async () => {
    const app = setup();
    saveArchiveRule(app, rule);
    const file = join(app.home, "项目 A 说明.md");
    writeFileSync(file, "# 项目 A\n离线编辑功能的说明。");
    const captured = await importFile(app, "personal", file, "attachment:auto", undefined, true);
    const manual = await importFile(app, "personal", file, "attachment:manual");
    expect(getSource(app, captured!.id).spaceId).toBe("project-a");
    expect(sourceRoute(app, captured!.id)?.mode).toBe("rule");
    expect(getSource(app, manual!.id).spaceId).toBe("personal");
    expect(sourceRoute(app, manual!.id)?.mode).toBe("manual");
  });
  it("routes by first enabled rule without an AI run and respects explicit imports and bindings", () => {
    const app = setup();
    const first = saveArchiveRule(app, rule);
    const second = saveArchiveRule(app, { ...rule, target: "project-b", enabled: false });
    saveArchiveRule(app, { ...second, enabled: true }, second.id);
    saveArchiveRule(app, { ...first, description: "修改不改变创建顺序" }, first.id);
    const s = upsertSource(app, material);
    expect(getSource(app, s.id).spaceId).toBe("project-a");
    expect(sourceRoute(app, s.id)?.mode).toBe("rule");
    expect(listRuns(app, { kind: "archive" })).toHaveLength(0);
    expect(getSource(app, upsertSource(app, { ...material, uri: "manual", archive: false }).id).spaceId).toBe("personal");
    expect(getSource(app, upsertSource(app, { ...material, uri: "bound", spaceId: "project-b" }).id).spaceId).toBe("project-b");
    setChatSettings(app, "lark-watch", "oc_example", { spaceId: "project-b" });
    expect(captureSpace(app, "oc_example")).toBe("project-b");
    setChatSettings(app, "lark", "oc_example", { spaceId: "personal" });
    expect(getSource(app, upsertSource(app, { ...material, uri: "lark:oc_example", kind: "chat", meta: { chatId: "oc_example" } }).id).spaceId).toBe("personal");
  });

  it("keeps IDs, citation rows, chunk positions and vectors when moving; reimports update the same original", () => {
    const app = setup();
    const s = upsertSource(app, material);
    const before = all<{ id: number; line_start: number; line_end: number }>(app.db, "select id,line_start,line_end from chunks where source_id=?", s.id);
    const vec = new Float32Array([1, 0]);
    run(app.db, "update chunks set embedding=? where source_id=?", Buffer.from(vec.buffer), s.id);
    run(app.db, "insert into page_cites(page_id,source_id,line_start,line_end,hash) values(?,?,?,?,?)", "personal/notes", s.id, 1, 1, getSource(app, s.id).hash);
    expect(vectorIndex().search(app, vec, ["personal"], 5)).toHaveLength(before.length);
    vectorIndex().search(app, vec, ["project-a"], 5);
    moveSource(app, s.id, "project-a", "本人确认归属");
    expect(sourceText(app, s.id)).toBe(material.text);
    expect(all(app.db, "select id,line_start,line_end from chunks where source_id=?", s.id)).toEqual(before);
    expect(one(app.db, "select source_id from page_cites where page_id='personal/notes'")).toMatchObject({ source_id: s.id });
    expect(vectorIndex().search(app, vec, ["personal"], 5)).toHaveLength(0);
    expect(vectorIndex().search(app, vec, ["project-a"], 5)).toHaveLength(before.length);
    const updated = upsertSource(app, { ...material, text: "接口设计已更新" });
    expect(updated.id).toBe(s.id);
    expect(getSource(app, s.id).spaceId).toBe("project-a");
    expect(all(app.db, "select id from sources where uri=?", material.uri)).toHaveLength(1);
    expect(archiveHistory(app, s.id)).toHaveLength(1);
  });

  it("retains personal until classification, batches candidates and delays ingest to their final spaces", async () => {
    const app = setup();
    const a = upsertSource(app, material);
    const b = upsertSource(app, { ...material, uri: "b" });
    const runs = listRuns(app, { kind: "archive" });
    expect(runs).toHaveLength(1);
    expect(runs[0].input.sourceIds).toEqual([a.id, b.id]);
    expect(getSource(app, a.id).spaceId).toBe("personal");
    expect(scheduleIngest(app, "personal", [a.id, b.id])).toBeNull();
    expect(sourceRoute(app, a.id)?.ingest).toBe(1);
    const ctx: ToolContext = { app, runId: runs[0].id, spaceId: "personal", spaces: null, tools: null, actor: "agent", role: "archivist" };
    expect((await callTool(ctx, "classify_source", { source_id: a.id, hash: getSource(app, a.id).hash, space: "project-a", reason: "项目目标一致" })).isError).toBe(false);
    const ingest = scheduleIngest(app, "personal", [a.id]);
    expect(ingest?.spaceId).toBe("project-a");
    expect((await callTool(ctx, "classify_source", { source_id: b.id, hash: getSource(app, b.id).hash, space: "personal", reason: "混合主题" })).isError).toBe(false);
    run(app.db, "update runs set status='done' where id=?", runs[0].id);
    upsertSource(app, { ...material, uri: "b" });
    expect(listRuns(app, { kind: "archive" })).toHaveLength(1);
  });

  it("previews historical rules and refuses stale, pinned or conflicting moves without losing data", () => {
    const app = setup();
    const a = upsertSource(app, { ...material, archive: false });
    run(app.db, "delete from source_routes where source_id=?", a.id);
    const r = saveArchiveRule(app, rule);
    const rows = previewArchive(app, "personal");
    expect(rows[0]).toMatchObject({ id: a.id, target: "project-a", ruleId: r.id });
    upsertSource(app, { ...material, archive: false, text: "更新正文" });
    expect(applyArchivePreview(app, "personal", [{ id: a.id, hash: rows[0].hash, ruleId: r.id, ruleVersion: rows[0].ruleVersion!, target: rows[0].target }])[0].ok).toBe(false);
    const fresh = previewArchive(app, "personal")[0];
    saveArchiveRule(app, { ...rule, target: "project-b" }, r.id);
    expect(applyArchivePreview(app, "personal", [{ id: a.id, hash: fresh.hash, ruleId: r.id, ruleVersion: fresh.ruleVersion!, target: fresh.target }])[0].ok).toBe(false);
    saveArchiveRule(app, rule, r.id);
    upsertSource(app, { ...material, archive: false, spaceId: "project-a" });
    expect(applyArchivePreview(app, "personal", [{ id: a.id, hash: fresh.hash, ruleId: r.id, ruleVersion: fresh.ruleVersion!, target: fresh.target }])[0].ok).toBe(false);
    expect(getSource(app, a.id).spaceId).toBe("personal");
    expect(sourceText(app, a.id)).toBe("更新正文");
    moveSource(app, a.id, "project-b", "本人手动归属");
    expect(previewArchive(app, "project-b")[0].reason).toBe("已手动指定或绑定");
  });

  it("rechecks rules and permission scopes before the AI can move material", async () => {
    const app = setup();
    const a = upsertSource(app, material);
    const runId = listRuns(app, { kind: "archive" })[0].id;
    const args = { source_id: a.id, hash: getSource(app, a.id).hash, space: "project-a", reason: "相关" };
    const ctx: ToolContext = { app, runId, spaceId: "personal", spaces: ["personal"], tools: null, actor: "agent", role: "archivist" };
    expect((await callTool(ctx, "classify_source", args)).isError).toBe(true);
    expect((await callTool({ ...ctx, spaces: null, role: "assistant" }, "classify_source", args)).isError).toBe(true);
    const outside = upsertSource(app, { ...material, archive: false, uri: "outside" });
    expect((await callTool({ ...ctx, spaces: null }, "classify_source", { ...args, source_id: outside.id })).isError).toBe(true);
    saveArchiveRule(app, { ...rule, target: "project-b" });
    expect((await callTool({ ...ctx, spaces: null }, "classify_source", args)).isError).toBe(true);
    expect(getSource(app, a.id).spaceId).toBe("personal");
    upsertSource(app, material);
    expect(getSource(app, a.id).spaceId).toBe("project-b");
  });

  it("keeps chat message IDs and positions across a binding change and subsequent capture", () => {
    const app = setup();
    const message = { message_id: "om_example", create_time: "1000", msg_type: "text", content: JSON.stringify({ text: "项目 A 的进展" }), sender: { id: "ou_example", name: "小王" } };
    persistChatMessages(app, { chatId: "oc_example", spaceId: "personal", name: "讨论群", messages: [message] });
    const before = one<{ source_id: string; line: number }>(app.db, "select source_id,line from lark_messages where message_id=?", message.message_id)!;
    setChatSettings(app, "lark", "oc_example", { spaceId: "project-b" });
    persistChatMessages(app, { chatId: "oc_example", spaceId: "project-b", name: "讨论群", messages: [message, { ...message, message_id: "om_next", create_time: "2000" }] });
    expect(getSource(app, before.source_id).spaceId).toBe("project-b");
    expect(one(app.db, "select source_id,line from lark_messages where message_id=?", message.message_id)).toEqual(before);
    expect(all(app.db, "select id from sources where uri='lark:oc_example'")).toHaveLength(1);
    expect(captureSpace(app, "oc_example")).toBe("project-b");
    expect(resolveThread(app, { channel: "lark", chatId: "oc_example", userId: "owner" }).thread.spaceId).toBe("project-b");
  });

  it("reimports moved linked documents by alias without duplicating their identity", async () => {
    const app = setup();
    app.config.lark.capture.docLinkDepth = 0;
    let rev = 1;
    setLarkCliForTests(async () => ({ data: { document: { content: `<title>项目 A 设计</title>\n第 ${rev} 版`, revision_id: String(rev) } } }));
    const url = "https://tenant.larkoffice.com/docx/Example";
    const a = await importLarkDocument(app, "personal", url, { archive: true });
    moveSource(app, a.id, "project-a", "属于项目 A", "ai");
    rev++;
    const b = await importLarkDocument(app, "personal", url, { archive: true });
    expect(b.id).toBe(a.id);
    expect(getSource(app, b.id).spaceId).toBe("project-a");
    expect(sourceText(app, b.id)).toContain("第 2 版");
    expect(all(app.db, "select id from sources where uri=?", url)).toHaveLength(1);
  });
});

describe("task rule context", () => {
  it("uses the main assistant and retains the schedule creation space and reply destination", async () => {
    const app = setup();
    const t = createThread(app, { channel: "lark", key: "oc_daily#omt_topic", spaceId: "project-a", userId: "owner" });
    const r = saveRule(app, { name: "每日摘要", description: "每天总结本项目", spaceId: "project-a", conversationId: t.id, trigger: { event: "schedule", cron: "0 18 * * *" }, actions: [{ type: "agent", reply: "auto" }] });
    expect(getRule(app, r.id).spaceId).toBe("project-a");
    const results = await runActions(app, r, { key: "tick", kind: "schedule", at: new Date().toISOString(), via: "schedule" }, "定时");
    const task = getRun(app, results[0].runId!);
    expect(task.spaceId).toBe("project-a");
    expect(task.input).toMatchObject({ spec: "assistant", threadId: t.id, assistantScope: { spaces: ["project-a"] }, lark: { chats: ["oc_daily"], draft: false } });
    expect(listRuns(app, { spaceId: "personal" })).toHaveLength(0);
    expect(listRuns(app, { spaceId: "project-a" })).toHaveLength(1);
  });
});
