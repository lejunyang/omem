import { describe, expect, it } from "vitest";
import { callTool } from "../src/agents/tools.ts";
import { createSpace } from "../src/core/spaces.ts";
import { itemEvents, listItems, upsertItem } from "../src/items/store.ts";
import { createCard, dueCards, reviewCard } from "../src/learn/cards.ts";
import { listMemories, memoryHistory, remember, supersede } from "../src/memory/store.ts";
import { search } from "../src/search/search.ts";
import { importText } from "../src/sources/import.ts";
import { appendToSource, deleteSource, readSource, upsertSource } from "../src/sources/store.ts";
import { listPages, pageContext, readPage, writePage } from "../src/wiki/store.ts";
import { testApp } from "./helpers.ts";

describe("sources and search", () => {
  it("finds Chinese text, code symbols and keeps only the latest original", async () => {
    const app = testApp();
    const doc = importText(app, "personal", { title: "项目A 约定", text: "# 项目A\n\n## 预算\n项目A 的预算上限是 80 元，由小王负责。\n" });
    upsertSource(app, { spaceId: "personal", kind: "code", uri: "src/budget.ts", title: "src/budget.ts", text: "export function checkBudget(limit: number) {\n  return limit <= 80;\n}\n" });
    const zh = await search(app, "预算上限是多少");
    expect(zh[0].sourceId).toBe(doc.id);
    expect(zh[0].path).toBe("项目A / 预算");
    const sym = await search(app, "checkBudget");
    expect(sym[0].uri).toBe("src/budget.ts");
    expect(sym[0].via).toContain("符号");

    const again = upsertSource(app, { spaceId: "personal", kind: "note", uri: (readSource(app, doc.id).source.uri), title: "项目A 约定", text: "# 项目A\n\n## 预算\n预算上限改为 120 元。\n" });
    expect(again).toEqual({ id: doc.id, status: "updated" });
    expect((await search(app, "80 元 小王负责")).some((h) => h.sourceId === doc.id && h.snippet.includes("80"))).toBe(false);
    expect(upsertSource(app, { spaceId: "personal", kind: "note", uri: readSource(app, doc.id).source.uri, title: "x", text: "# 项目A\n\n## 预算\n预算上限改为 120 元。\n" }).status).toBe("unchanged");

    deleteSource(app, doc.id);
    expect(readSource(app, doc.id).source.deletedAt).toBeTruthy();
    expect((await search(app, "预算上限")).some((h) => h.sourceId === doc.id)).toBe(false);
  });

  it("keeps spaces apart unless asked", async () => {
    const app = testApp();
    createSpace(app, { id: "english", name: "英语", kind: "learning" });
    importText(app, "english", { title: "words", text: "serendipity 意外发现的好运" });
    expect(await search(app, "serendipity", { spaces: ["personal"] })).toHaveLength(0);
    expect(await search(app, "serendipity", { spaces: ["english"] })).toHaveLength(1);
  });

  it("appends chat lines and remembers where new content starts", () => {
    const app = testApp();
    const a = appendToSource(app, { spaceId: "personal", kind: "chat", uri: "lark:oc_1", title: "群", lines: ["[10:00] 甲: 你好"] });
    appendToSource(app, { spaceId: "personal", kind: "chat", uri: "lark:oc_1", title: "群", lines: ["[10:01] 乙: 收到", "[10:02] 甲: 明天开会"] });
    const r = readSource(app, a.id);
    expect(r.text.split("\n")).toHaveLength(3);
    expect(r.source.meta.appendedFrom).toBe(2);
  });
});

describe("memories", () => {
  it("supersedes without losing history", async () => {
    const app = testApp();
    const m1 = remember(app, { spaceId: "personal", kind: "agreement", subject: "项目A 预算", content: "项目A 预算上限 80 元" });
    const m2 = supersede(app, m1.id, { content: "项目A 预算上限 120 元（由 80 改为 120）" });
    expect(listMemories(app, { status: "active" }).map((m) => m.id)).toEqual([m2.id]);
    const chain = memoryHistory(app, m2.id);
    expect(chain.map((m) => [m.id, m.status])).toEqual([
      [m1.id, "superseded"],
      [m2.id, "active"],
    ]);
    expect(chain[0].validTo).toBe(chain[1].validFrom);
    expect(() => supersede(app, m1.id, { content: "again" })).toThrow(/已不是当前有效/);
    const active = await search(app, "项目A 预算", { types: ["memory"] });
    expect(active.map((h) => h.id)).toEqual([m2.id]);
    const all = await search(app, "项目A 预算", { types: ["memory"], includeHistory: true });
    expect(all).toHaveLength(2);
  });
});

describe("items", () => {
  it("records every change on the timeline", () => {
    const app = testApp();
    const i = upsertItem(app, undefined, { title: "交报销单", kind: "reminder", remindAt: "2026-10-19T09:00:00+09:00" }, "user");
    upsertItem(app, i.id, { remindAt: "2026-10-20T09:00:00+09:00", note: "本人改期" }, "agent");
    upsertItem(app, i.id, { status: "done" });
    const events = itemEvents(app, i.id);
    expect(events.map((e) => e.kind)).toEqual(["created", "reminder-scheduled", "updated", "updated"]);
    expect(events[2].text).toContain("本人改期");
    expect(events[2].text).toContain("提醒");
    expect(listItems(app, { status: "active" })).toHaveLength(0);
    expect(listItems(app, { status: "all" })[0].closedAt).toBeTruthy();
  });
});

describe("wiki", () => {
  it("indexes links and citations and flags stale sources", async () => {
    const app = testApp();
    const s = upsertSource(app, { spaceId: "personal", kind: "code", uri: "a.ts", title: "a.ts", text: "export const a = 1;\n" });
    writePage(app, "personal", "overview", { meta: { title: "概览", summary: "整体" }, body: "见 [[flows/a|流程]]。定义在 [a.ts:1](src:a.ts#L1-L1)。" });
    writePage(app, "personal", "flows/a", { meta: { title: "流程 A" }, body: "返回 [[overview]]" });
    expect(listPages(app, "personal").map((p) => p.slug).sort()).toEqual(["flows/a", "overview"]);
    const ctx = pageContext(app, "personal", "flows/a");
    expect(ctx.backlinks.map((b) => b.slug)).toEqual(["overview"]);
    const c1 = pageContext(app, "personal", "overview");
    expect(c1.sources).toMatchObject([{ sourceId: s.id, lineStart: 1, stale: false }]);
    upsertSource(app, { spaceId: "personal", kind: "code", uri: "a.ts", title: "a.ts", text: "export const a = 2;\n" });
    expect(pageContext(app, "personal", "overview").sources[0].stale).toBe(true);
    expect(listPages(app, "personal").find((p) => p.slug === "overview")!.staleSources).toBe(1);
    expect((await search(app, "整体 概览", { types: ["page"] }))[0].path).toBe("overview");
    expect(readPage(app, "personal", "overview").meta.title).toBe("概览");
    expect(() => writePage(app, "personal", "../escape", { meta: { title: "x" }, body: "" })).toThrow();
  });
});

describe("tools", () => {
  it("enforces space scope and tool allow-lists", async () => {
    const app = testApp();
    createSpace(app, { id: "secret", name: "secret" });
    const s = importText(app, "secret", { title: "s", text: "机密内容" });
    const ctx = { app, runId: null, spaceId: "personal", spaces: ["personal"], tools: new Set(["read_source", "search"]), actor: "agent" as const };
    expect((await callTool(ctx, "read_source", { source: s.id })).isError).toBe(true);
    expect((await callTool(ctx, "search", { query: "机密", space: "secret" })).text).toMatch(/不能访问/);
    expect((await callTool(ctx, "remember", { content: "x", kind: "fact" })).text).toMatch(/不可用/);
    const { remember } = await import("../src/memory/store.ts");
    const foreign = remember(app, { spaceId: "secret", kind: "fact", content: "外部记忆" });
    const writer = { ...ctx, tools: null };
    expect((await callTool(writer, "supersede", { memory_id: foreign.id, content: "改" })).text).toMatch(/不能修改空间 secret/);
    expect((await callTool(writer, "forget", { memory_id: foreign.id, reason: "x" })).isError).toBe(true);
    const open = { ...ctx, spaces: null, tools: null };
    const r = await callTool(open, "read_source", { source: s.id });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("机密内容");
    expect(r.text).toContain(`src:${s.id}#L1-L1`);
    const w = await callTool(open, "write_page", { page: "notes/x", title: "X", summary: "s", body: "# X\n正文" });
    expect(w.text).toMatch(/已创建页面/);
    expect(readPage(app, "personal", "notes/x").body.startsWith("正文")).toBe(true);
  });
});

describe("cards", () => {
  it("schedules with FSRS and dedupes", () => {
    const app = testApp();
    const { card } = createCard(app, { spaceId: "personal", front: "serendipity", back: "意外发现的好运" });
    expect(createCard(app, { spaceId: "personal", front: "serendipity", back: "x" }).created).toBe(false);
    expect(dueCards(app).map((c) => c.id)).toEqual([card.id]);
    const after = reviewCard(app, card.id, 3);
    expect(new Date(after.dueAt).getTime()).toBeGreaterThan(Date.now());
    expect(dueCards(app)).toHaveLength(0);
  });
});
