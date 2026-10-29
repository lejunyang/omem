import { describe, expect, it } from "vitest";
import { addMessage, ensureConversation } from "../src/agents/threads.ts";
import { callTool, type ToolContext } from "../src/agents/tools.ts";
import { all, one, run } from "../src/core/db.ts";
import { createSpace } from "../src/core/spaces.ts";
import { search } from "../src/search/search.ts";
import { addSourceNote, reviewQueue, reviewSourceNote, setNodeLevel, sourceNotes } from "../src/sources/attention.ts";
import { citeBoost, citeCounts } from "../src/sources/cites.ts";
import { locate, hashOf, quoteOf } from "../src/sources/anchor.ts";
import { upsertSource } from "../src/sources/store.ts";
import { testApp } from "./helpers.ts";

const lines = (n: number, f: (i: number) => string) => Array.from({ length: n }, (_, i) => f(i + 1)).join("\n");

describe("annotations anchored to their passage", () => {
  it("finds a passage again after the document changed, and marks it stale when it is gone", () => {
    const text = lines(10, (i) => `第 ${i} 行 普通内容`);
    const passage = "第 4 行 普通内容\n第 5 行 普通内容";
    const moved = `新的开头\n新的第二行\n${text}`;
    expect(locate(moved, { hash: hashOf(passage), quote: quoteOf(passage), len: 2, near: 4 })).toEqual({ lineStart: 6, lineEnd: 7 });
    expect(locate(text.replace("第 4 行", "第四行"), { hash: hashOf(passage), quote: quoteOf(passage), len: 2, near: 4 })).toBeNull();
  });

  it("moves notes with their passage when a document is read again; owner notes are confirmed, agent notes pending", () => {
    const app = testApp();
    const v1 = "# 退款\n退款按订单总额计算。\n审批要财务复核。\n# 其他\n无";
    const id = upsertSource(app, { spaceId: "personal", kind: "doc", uri: "plan.md", title: "退款方案", text: v1 }).id;
    const agent = addSourceNote(app, { sourceId: id, lineStart: 3, lineEnd: 3, kind: "outdated", note: "现在组长审批即可", by: "agent" });
    const owner = addSourceNote(app, { sourceId: id, lineStart: 2, lineEnd: 2, kind: "wrong", note: "按已发货行计算", by: "owner" });
    expect(sourceNotes(app, id).map((n) => [n.id, n.status, n.quote])).toEqual([
      [owner.id, "confirmed", "退款按订单总额计算。"],
      [agent.id, "pending", "审批要财务复核。"],
    ]);
    upsertSource(app, { spaceId: "personal", kind: "doc", uri: "plan.md", title: "退款方案", text: `前言\n\n${v1.replace("退款按订单总额计算。", "退款按已发货行计算。")}` });
    const after = new Map(sourceNotes(app, id).map((n) => [n.id, n]));
    expect(after.get(agent.id)).toMatchObject({ lineStart: 5, lineEnd: 5, staleAt: null });
    expect(after.get(owner.id)?.staleAt).toBeTruthy();
    // A quote can stand in for line numbers.
    const byQuote = addSourceNote(app, { sourceId: id, quote: "退款按已发货行计算", kind: "key", note: "现行口径", by: "agent" });
    expect(sourceNotes(app, id).find((n) => n.id === byQuote.id)).toMatchObject({ lineStart: 4, lineEnd: 4 });
    expect(() => addSourceNote(app, { sourceId: id, quote: "不存在的一句话", kind: "key", note: "x", by: "agent" })).toThrow(/找不到/);
  });
});

describe("how annotations weigh in search", () => {
  const setup = () => {
    const app = testApp();
    createSpace(app, { id: "proj", name: "项目 A", kind: "project" });
    // Two documents with the same wording; one gets a note on 1 line of its 20-line chunk.
    const body = (tag: string) => `# 发布流程 ${tag}\n${lines(19, (i) => `发布前检查第 ${i} 项 灰度 回滚`)}`;
    const a = upsertSource(app, { spaceId: "proj", kind: "doc", uri: "a.md", title: "发布 A", text: body("A") }).id;
    const b = upsertSource(app, { spaceId: "proj", kind: "doc", uri: "b.md", title: "发布 B", text: body("B") }).id;
    return { app, a, b };
  };
  const scoreOf = async (app: ReturnType<typeof testApp>, id: string) => (await search(app, "发布前检查 灰度 回滚", { spaces: ["proj"] })).find((h) => h.sourceId === id)?.score ?? 0;

  it("weighs a note by how much of the hit it covers, an agent's at half strength until confirmed, none once rejected", async () => {
    const { app, a, b } = setup();
    const base = await scoreOf(app, a);
    const note = addSourceNote(app, { sourceId: a, lineStart: 3, lineEnd: 3, kind: "wrong", note: "第 2 项已取消", by: "agent" });
    const pending = await scoreOf(app, a);
    // One line of twenty: counted as a quarter of the chunk at least, then halved: 0.35^(0.25/2).
    expect(pending / base).toBeCloseTo(Math.pow(0.35, 0.125), 2);
    reviewSourceNote(app, note.id, "confirm");
    expect((await scoreOf(app, a)) / base).toBeCloseTo(Math.pow(0.35, 0.25), 2);
    reviewSourceNote(app, note.id, "reject");
    expect((await scoreOf(app, a)) / base).toBeCloseTo(1, 2);
    // The agent cannot add the rejected note again.
    expect(addSourceNote(app, { sourceId: a, lineStart: 3, lineEnd: 3, kind: "wrong", note: "再标一次", by: "agent" })).toMatchObject({ kept: true, rejected: true });
    expect(await scoreOf(app, b)).toBeGreaterThan(0);
  });

  it("leaves out passages the owner confirmed wrong and passages marked not to search; agent marks only weigh down, with the correction attached", async () => {
    const { app, a, b } = setup();
    const fix = upsertSource(app, { spaceId: "proj", kind: "doc", uri: "fix.md", title: "更正", text: "现在发布前只检查第 1 项。" }).id;
    addSourceNote(app, { sourceId: a, kind: "wrong", note: "整份过时的流程", ref: `src:${fix}#L1-L1`, by: "agent" });
    const hit = (await search(app, "发布前检查 灰度 回滚", { spaces: ["proj"] })).find((h) => h.sourceId === a)!;
    expect(hit.notes?.join(" ")).toContain("现在发布前只检查第 1 项");
    addSourceNote(app, { sourceId: a, kind: "wrong", note: "本人确认有误", by: "owner" });
    addSourceNote(app, { sourceId: b, lineStart: 1, lineEnd: 20, kind: "exclude", note: "测试数据", by: "owner" });
    const ids = (await search(app, "发布前检查 灰度 回滚", { spaces: ["proj"] })).map((h) => h.sourceId);
    expect(ids).not.toContain(a);
    expect(ids).not.toContain(b);
  });

  it("lists agent judgements for review by how often they touched search results", async () => {
    const { app, a, b } = setup();
    const n1 = addSourceNote(app, { sourceId: a, lineStart: 2, lineEnd: 2, kind: "outdated", note: "旧", by: "agent" });
    addSourceNote(app, { sourceId: b, lineStart: 2, lineEnd: 2, kind: "key", note: "关键", by: "agent" });
    await search(app, "发布前检查 灰度 回滚", { spaces: ["proj"] });
    await search(app, "发布前检查 灰度", { spaces: ["proj"] });
    upsertSource(app, { spaceId: "proj", kind: "chat", uri: "lark:oc_n", title: "通知群", text: "机器人通知", meta: { chatId: "oc_n", chatMode: "group" } });
    setNodeLevel(app, "proj", "chat:oc_n", "ignore", "agent", { reason: "刷屏" });
    const q = reviewQueue(app, "proj");
    expect(q.notes.map((n) => n.id)).toEqual([n1.id]);
    expect(q.notes[0].hits).toBe(2);
    expect(q.levels).toEqual([expect.objectContaining({ key: "chat:oc_n", level: "ignore", sources: 1 })]);
    reviewSourceNote(app, n1.id, "confirm");
    expect(reviewQueue(app, "proj").notes).toEqual([]);
  });
});

describe("citations", () => {
  it("counts how often a source is cited in answers and pages, and gives a small bounded boost", () => {
    const app = testApp();
    const id = upsertSource(app, { spaceId: "personal", kind: "doc", uri: "x.md", title: "X", text: "内容" }).id;
    const c = ensureConversation(app, { spaceId: "personal", channel: "web" });
    addMessage(app, c, "assistant", `依据 [x](src:${id}#L1-L1) 和 [x](src:${id})`);
    addMessage(app, c, "assistant", `再次 [x](src:${id})`);
    addMessage(app, c, "user", `src:${id}`);
    expect(citeCounts(app, [id]).get(id)).toBe(2);
    expect(citeBoost(0)).toBe(1);
    expect(citeBoost(2)).toBeGreaterThan(1);
    expect(citeBoost(10_000)).toBeCloseTo(1.1, 5);
    expect(all(app.db, "select kind from source_cites")).toEqual([{ kind: "answer" }, { kind: "answer" }]);
  });

  it("annotate_source takes a quote and the exclude kind; read_source shows the status", async () => {
    const app = testApp();
    const id = upsertSource(app, { spaceId: "personal", kind: "doc", uri: "y.md", title: "Y", text: "第一行\n测试账号 a/b\n第三行" }).id;
    const ctx: ToolContext = { app, runId: null, spaceId: "personal", spaces: ["personal"], tools: null, actor: "agent" };
    const r = await callTool(ctx, "annotate_source", { source: id, kind: "exclude", quote: "测试账号 a/b", note: "测试数据，不要检索" });
    expect(r.text).toMatch(/L2/);
    const read = await callTool(ctx, "read_source", { source: id });
    expect(read.text).toContain("不检索 L2");
    expect(read.text).toContain("待本人确认");
    expect(one(app.db, "select status from source_notes")).toEqual({ status: "pending" });
    run(app.db, "update source_notes set status = 'rejected'");
    expect((await callTool(ctx, "read_source", { source: id })).text).not.toContain("不检索");
  });
});
