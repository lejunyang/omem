import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import type { App } from "../src/core/app.ts";
import { all, one, run } from "../src/core/db.ts";
import { listAsks } from "../src/agents/asks.ts";
import { createRun } from "../src/agents/runs.ts";
import { callTool, type ToolContext } from "../src/agents/tools.ts";
import { getContext, itemContext, saveContext } from "../src/channels/listen.ts";
import { foldChildContexts, itemChats } from "../src/channels/listen-items.ts";
import { trackProblem } from "../src/channels/listen-problems.ts";
import { defineMetric, recordPoints } from "../src/data/metrics.ts";
import { saveFlow } from "../src/flows/definitions.ts";
import { reportStage, startFlow } from "../src/flows/engine.ts";
import { lineTimeline } from "../src/items/changes.ts";
import { itemExpiry } from "../src/items/expiry.ts";
import { addMaterials } from "../src/items/materials.ts";
import { setParent } from "../src/items/parent.ts";
import { getItem, upsertItem } from "../src/items/store.ts";
import { rootOf } from "../src/items/tree.ts";
import { appendToSource } from "../src/sources/store.ts";
import { testApp } from "./helpers.ts";

const apps: App[] = [];
afterEach(async () => {
  await new Promise((r) => setImmediate(r));
  for (const app of apps.splice(0)) { app.events.emit("close"); app.db.close(); rmSync(app.home, { force: true, recursive: true }); }
});
const fresh = () => { const app = testApp(); apps.push(app); app.config.flows.autoAdvance = 20; return app; };
const owner = { actor: "owner", userId: "owner" };
const agent = { actor: "assistant", userId: "owner" };
const flow = (app: App) => saveFlow(app, YAML.stringify({ id: "demo", name: "示例交付", stages: [{ id: "code", name: "编码", by: "wait" }, { id: "test", name: "测试", by: "wait" }, { id: "end", name: "结束", by: "wait" }] }), "owner");
/** A captured group chat with one message, linked to an item. */
function chat(app: App, itemId: string, chatId: string) {
  const src = appendToSource(app, { spaceId: "personal", kind: "chat", uri: `lark:${chatId}`, title: `${chatId} 讨论`, lines: ["开始"], meta: { chatId } });
  run(app.db, "insert into lark_messages(message_id,chat_id,source_id,line,sender_kind,sender_name,content,create_ms) values(?,?,?,1,'user','小王','开始',?)", `m_${chatId}`, chatId, src.id, Date.now() - 3600_000);
  addMaterials(app, itemId, [{ kind: "source", ref: src.id }], "owner");
  return src;
}
const running = (app: App, kind: Parameters<typeof createRun>[1]["kind"], input: Record<string, unknown> = {}) => {
  const r = createRun(app, { kind, spaceId: "personal", title: "测试", input });
  run(app.db, "update runs set status = 'running' where id = ?", r.id);
  return r;
};

describe("工作线：上下层", () => {
  it("挂到工作线下面，最多三层，不能成环，不能挂到别人的事项下", () => {
    const app = fresh();
    const line = upsertItem(app, undefined, { kind: "line", title: "示例商城 · 退款改造" }, "user");
    const req = upsertItem(app, undefined, { title: "退款单显示运费" }, "user");
    const bug = upsertItem(app, undefined, { title: "运费退了两次" }, "user");
    const deeper = upsertItem(app, undefined, { title: "再下一层" }, "user");
    setParent(app, req.id, line.id);
    setParent(app, bug.id, req.id);
    expect(getItem(app, bug.id).parentId).toBe(req.id);
    expect(rootOf(app, bug.id)).toBe(line.id);
    expect(() => setParent(app, deeper.id, bug.id)).toThrow(/最多三层/);
    expect(() => setParent(app, line.id, bug.id)).toThrow(/成环/);
    expect(() => setParent(app, line.id, line.id)).toThrow(/自己/);
    const other = upsertItem(app, undefined, { title: "别人的", userId: "member" } as never, "user");
    expect(() => setParent(app, other.id, line.id)).toThrow(/同一个人/);
    // A line with something open under it does not expire; with nothing left it goes by a todo's period.
    expect(itemExpiry(app, getItem(app, line.id))).toBeNull();
    for (const id of [bug.id, req.id]) upsertItem(app, id, { status: "done" }, "user");
    expect(itemExpiry(app, getItem(app, line.id))?.text).toContain("14 天");
    expect(all(app.db, "select text from item_events where item_id = ? and text like '归到「%'", req.id)).toEqual([{ text: "归到「示例商城 · 退款改造」下面" }]);
    expect(all(app.db, "select text from item_events where item_id = ? and text like '%归到这里'", req.id)).toEqual([{ text: "「运费退了两次」归到这里" }]);
  });

  it("upsert_item 带 parent；后台运行不能自己建工作线", async () => {
    const app = fresh();
    const line = upsertItem(app, undefined, { kind: "line", title: "项目 A 上线" }, "user");
    const own: ToolContext = { app, runId: null, spaceId: "personal", spaces: null, tools: null, actor: "user", userId: "owner" };
    const made = await callTool(own, "upsert_item", { title: "接口联调", parent: line.id });
    expect(made.isError).toBe(false);
    expect(made.text).toContain("归到");
    const id = /事项 (i\w+)/.exec(made.text)![1];
    expect(getItem(app, id).parentId).toBe(line.id);
    const r = createRun(app, { kind: "agent", spaceId: "personal", title: "后台", input: { spec: "assistant", task: "x" } });
    const bg: ToolContext = { ...own, runId: r.id, actor: "agent" };
    const refused = await callTool(bg, "upsert_item", { kind: "line", title: "助手自己想的线", why: "本人近况里的线" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("工作线只由本人建");
    const listed = await callTool(own, "list_items", { parent: line.id });
    expect(listed.text).toContain("上层");
    const read = JSON.parse((await callTool(own, "read_item", { item_id: line.id })).text);
    expect(read.children.map((c: { id: string }) => c.id)).toEqual([id]);
  });
});

describe("工作线：关注只建在顶层", () => {
  it("子事项开始流程，建的是工作线的关注，群连子事项的一起收", async () => {
    const app = fresh();
    flow(app);
    const line = upsertItem(app, undefined, { kind: "line", title: "示例商城 · 退款改造" }, "user");
    const req = upsertItem(app, undefined, { title: "退款单显示运费" }, "user");
    chat(app, line.id, "oc_line");
    chat(app, req.id, "oc_req");
    setParent(app, req.id, line.id);
    await startFlow(app, req.id, "demo", owner);
    expect(itemContext(app, req.id)).toBeNull();
    const top = itemContext(app, line.id)!;
    expect(top.status).toBe("active");
    expect(top.chats.sort()).toEqual(["oc_line", "oc_req"]);
    expect(itemChats(app, line.id).sort()).toEqual(["oc_line", "oc_req"]);
  });

  it("挂到线下以后，子事项原来的关注把案例搬到顶层并暂停；再跑一遍不变", () => {
    const app = fresh();
    const line = upsertItem(app, undefined, { kind: "line", title: "项目 A" }, "user");
    const bug = upsertItem(app, undefined, { title: "缺陷一" }, "user");
    chat(app, bug.id, "oc_bug");
    const own = saveContext(app, { kind: "item", itemId: bug.id, name: "缺陷一", chats: ["oc_bug"] });
    run(app.db, "insert into reply_samples(id, channel, chat_id, chat_kind, ask, last_ms, created_at, context_id) values('case_1','lark','oc_bug','group','怎么退运费',?,?,?)", Date.now(), new Date().toISOString(), own.id);
    setParent(app, bug.id, line.id);
    const top = itemContext(app, line.id)!;
    expect(top).toBeTruthy();
    expect(top.knobs.reply).toBe("none");
    expect(top.chats).toEqual(["oc_bug"]);
    expect(one<{ context_id: string }>(app.db, "select context_id from reply_samples where id = 'case_1'")!.context_id).toBe(top.id);
    const paused = getContext(app, own.id)!;
    expect(paused.status).toBe("paused");
    expect(paused.note).toContain("已并进");
    expect(foldChildContexts(app)).toBe(0);
  });
});

describe("工作线：时间线", () => {
  it("把线和下面各项的变化合在一起：阶段做完、卡住、指标越过门槛、在跟的问题有了结论", async () => {
    const app = fresh();
    flow(app);
    const line = upsertItem(app, undefined, { kind: "line", title: "示例商城 · 退款改造" }, "user");
    const req = upsertItem(app, undefined, { title: "退款单显示运费" }, "user");
    setParent(app, req.id, line.id);
    await startFlow(app, req.id, "demo", owner);
    await reportStage(app, req.id, "code", { state: "done", note: "退款单加了运费一栏", evidence: [createRun(app, { kind: "agent", title: "编码" }).id] }, agent);
    await reportStage(app, req.id, "test", { state: "blocked", note: "测试环境起不来", waitingOn: "本人给测试账号" }, agent);
    const m = defineMetric(app, { name: "退款失败数", query: "示例：退款失败的单数", itemId: line.id, direction: "down-good", threshold: 0.5 } as never);
    for (const [i, v] of [10, 12, 11, 9, 10].entries()) await recordPoints(app, m.id, [{ value: v, at: new Date(Date.now() - (6 - i) * 86400_000).toISOString() }]);
    await recordPoints(app, m.id, [{ value: 30 }]);
    const c = saveContext(app, { kind: "item", itemId: line.id, chats: ["oc_line"] });
    const r = running(app, "agent", { conversationId: c.conversationId });
    trackProblem(app, r.id, { chat_id: "oc_line", title: "运费口径", state: "waiting", awaiting: "小王确认", done_when: "小王回复" });
    trackProblem(app, r.id, { chat_id: "oc_line", title: "运费口径", state: "closed", conclusion: "按实付运费退" });
    const t = lineTimeline(app, line.id);
    const summaries = t.map((x) => x.summary);
    expect(summaries).toContain("「编码」做完");
    expect(summaries.some((s) => s.startsWith("「测试」卡住"))).toBe(true);
    expect(t.find((x) => x.summary.startsWith("「测试」卡住"))!.next).toBe("在工作页上处理这一段");
    expect(t.filter((x) => x.origin === "flow").every((x) => x.itemId === req.id && x.itemTitle === "退款单显示运费" && x.lineId === line.id && x.type === "stage")).toBe(true);
    expect(t.some((x) => x.origin === "metric" && x.type === "result")).toBe(true);
    expect(t.find((x) => x.origin === "problem")).toMatchObject({ type: "resolved", itemId: line.id });
    expect(t.every((x) => x.status === "noted")).toBe(true);
    expect(t.map((x) => x.at)).toEqual([...t.map((x) => x.at)].sort().reverse());
    // No card asks about any of these; only the stage waiting on the owner sends the progress card.
    expect(listAsks(app, { status: "pending" }).filter((a) => a.handler === "item-follow")).toHaveLength(0);
    const cards = all<{ body: string; link: string }>(app.db, "select body, link from notifications where json_extract(context, '$.view') = 'flow'");
    expect(cards).toHaveLength(1);
    expect(cards[0].link).toBe(`#/work/${req.id}`);
  });
});

