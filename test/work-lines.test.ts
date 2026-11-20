import { rmSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import type { App } from "../src/core/app.ts";
import { all, one, run } from "../src/core/db.ts";
import { answerAsk, getAsk, listAsks } from "../src/agents/asks.ts";
import { createRun, getRun } from "../src/agents/runs.ts";
import { callTool, type ToolContext } from "../src/agents/tools.ts";
import { CODE_STARTERS } from "../src/agents/tool-help.ts";
import { getContext, itemContext, saveContext } from "../src/channels/listen.ts";
import { foldChildContexts, itemChats } from "../src/channels/listen-items.ts";
import { assistDue, refreshLine } from "../src/channels/listen-assist.ts";
import { trackProblem } from "../src/channels/listen-problems.ts";
import { defineMetric, recordPoints } from "../src/data/metrics.ts";
import { saveFlow } from "../src/flows/definitions.ts";
import { ownerAction, reportStage, startFlow } from "../src/flows/engine.ts";
import { addChange, lineTimeline } from "../src/items/changes.ts";
import { otherRefs } from "../web/src/lib/work.ts";
import { itemExpiry } from "../src/items/expiry.ts";
import { decideNext, lineNextDue, linesCard, nextOf, nextRunDone, proposeLines, submitLineState } from "../src/items/lines.ts";
import { addMaterials } from "../src/items/materials.ts";
import { setParent } from "../src/items/parent.ts";
import { getItem, upsertItem } from "../src/items/store.ts";
import { rootOf } from "../src/items/tree.ts";
import { startServer } from "../src/server/http.ts";
import { addMember, createApiToken, createUser } from "../src/core/users.ts";
import { appendToSource } from "../src/sources/store.ts";
import { testApp } from "./helpers.ts";

const apps: App[] = [];
const servers: FastifyInstance[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
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
    // A line never expires: with everything under it done it goes into 观察, and its lifecycle ends it (items/lifecycle.ts).
    expect(itemExpiry(app, getItem(app, line.id))).toBeNull();
    for (const id of [bug.id, req.id]) upsertItem(app, id, { status: "done" }, "user");
    expect(itemExpiry(app, getItem(app, line.id))).toBeNull();
    expect(getItem(app, line.id).phase).toBe("watching");
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

describe("工作线：现状和下一步", () => {
  it("每天看一次顶层的线（子事项不单独看），交的现状存在线上，旧的没开始的下一步过期", async () => {
    const app = fresh();
    const line = upsertItem(app, undefined, { kind: "line", title: "示例商城 · 退款改造", detail: "12 月上线" }, "user");
    const req = upsertItem(app, undefined, { title: "退款单显示运费" }, "user");
    setParent(app, req.id, line.id);
    saveContext(app, { kind: "item", itemId: line.id });
    const ids = await assistDue(app);
    expect(ids).toHaveLength(1);
    const r = getRun(app, ids[0]);
    expect(r.input.lineState).toBe(line.id);
    expect(String(r.input.task)).toContain("submit_line_state");
    expect(String(r.input.task)).toContain("退款单显示运费");
    expect((r.input.assistantScope as { denyTools: string[] }).denyTools).toEqual(expect.arrayContaining(["notify", "lark_send", "delegate_code"]));
    run(app.db, "update runs set status = 'running' where id = ?", r.id);
    submitLineState(app, r.id, { now: "截至今天，运费一栏做完，等测试账号", people: [{ name: "小王", role: "负责后端" }], weeks: [{ label: "本周·至今3天", text: "做完运费一栏" }], next: [{ text: "读退款回调文档，确认重试次数", why: "测试卡在回调", refs: [], kind: "read" }, { text: "补运费的测试", why: "", refs: [], kind: "test" }] });
    const first = nextOf(app, line.id);
    expect(first).toHaveLength(2);
    expect(getItem(app, line.id).now).toMatchObject({ text: "截至今天，运费一栏做完，等测试账号", people: [{ name: "小王", role: "负责后端" }], runId: r.id });
    submitLineState(app, r.id, { now: "截至今天，等测试账号", next: [{ text: "问小王要测试账号", why: "测试卡住两天", refs: [], kind: "ask" }] });
    expect(nextOf(app, line.id).map((n) => n.text)).toEqual(["问小王要测试账号"]);
    expect(nextOf(app, line.id, ["expired"])).toHaveLength(2);
    expect(all(app.db, "select id from notifications")).toHaveLength(0);
    // A work item under the line has no look of its own, and a line's 关注 is made on 更新.
    expect(() => submitLineState(app, createRun(app, { kind: "agent", title: "x", input: { lineState: req.id } }).id, { now: "x" })).toThrow();
    const lone = upsertItem(app, undefined, { title: "项目 A" }, "user");
    const again = await refreshLine(app, lone.id, "owner");
    expect(getRun(app, again.id).input.lineState).toBe(lone.id);
    expect(itemContext(app, lone.id)!.knobs).toMatchObject({ reply: "none", assist: "suggest" });
    await expect(refreshLine(app, req.id, "owner")).rejects.toThrow(/工作线上更新/);
  });

  it("每天一张卡列各条线的下一步；就这么做起一轮，不用记下来", async () => {
    const app = fresh();
    app.config.notify.laterTimes = ["09:30"];
    const a = upsertItem(app, undefined, { kind: "line", title: "项目 A" }, "user");
    const b = upsertItem(app, undefined, { kind: "line", title: "示例商城 · 退款改造" }, "user");
    for (const [line, steps] of [[a, ["读接口文档", "改重试逻辑"]], [b, ["看退款失败数"]]] as const) {
      const r = running(app, "agent", { lineState: line.id });
      submitLineState(app, r.id, { now: "截至今天", next: steps.map((text, i) => ({ text, why: "依据", refs: [], kind: i === 1 ? "code" : steps.length === 1 ? "data" : "read" })) });
    }
    const morning = new Date("2026-11-20T00:00:00Z"); // 08:00 where the owner is: not yet
    expect(lineNextDue(app, morning)).toBeNull();
    const ask = lineNextDue(app, new Date("2026-11-20T02:00:00Z"))!;
    expect(ask.ui!.fields).toHaveLength(3);
    expect(ask.question).toContain("项目 A");
    expect(ask.question).toContain("示例商城 · 退款改造");
    expect(lineNextDue(app, new Date("2026-11-20T05:00:00Z"))).toBeNull();
    const read = nextOf(app, a.id).find((n) => n.kind === "read")!, code = nextOf(app, a.id).find((n) => n.kind === "code")!, [data] = nextOf(app, b.id);
    await answerAsk(app, ask.id, { value: { [read.id]: "就这么做", [code.id]: "就这么做", [data.id]: "不用" }, by: "owner" });
    const runs = all<{ id: string; lane: string; input: string }>(app.db, "select id, lane, input from runs where json_extract(input, '$.lineNext') is not null order by created_at");
    expect(runs).toHaveLength(2);
    expect(runs.every((r) => r.lane === `line-next:${a.id}`)).toBe(true);
    const readDeny = JSON.parse(runs.find((r) => JSON.parse(r.input).lineNext === read.id)!.input).assistantScope.denyTools as string[];
    const codeDeny = JSON.parse(runs.find((r) => JSON.parse(r.input).lineNext === code.id)!.input).assistantScope.denyTools as string[];
    for (const t of ["lark_send", "lark_card", "lark_write", "lark_invite", "save_rule", "set_chat_watch", ...CODE_STARTERS]) expect(readDeny).toContain(t);
    expect(codeDeny).not.toContain("delegate_code");
    expect(nextOf(app, a.id).map((n) => n.status)).toEqual(["doing", "doing"]);
    // Its run ends: the step is done, the line's 关注 and the owner hear the conclusion.
    saveContext(app, { kind: "item", itemId: a.id });
    const readRun = runs.find((r) => JSON.parse(r.input).lineNext === read.id)!.id;
    await nextRunDone(app, read.id, readRun, "接口文档写了重试三次，间隔一分钟。");
    expect(nextOf(app, a.id, ["done"]).map((n) => n.id)).toEqual([read.id]);
    expect(one<{ title: string; link: string }>(app.db, "select title, link from notifications where title like '%下一步做完了'")).toMatchObject({ link: `#/work/${a.id}` });
    expect(nextOf(app, b.id, ["declined"]).map((n) => n.text)).toEqual(["看退款失败数"]);
    // The next look reads what the owner said 不用 to.
    saveContext(app, { kind: "item", itemId: b.id });
    const look = getRun(app, (await assistDue(app)).find((id) => getRun(app, id).input.lineState === b.id)!);
    expect(String(look.input.task)).toContain("看退款失败数");
    expect(() => decideNext(app, data.id, "declined", "owner")).toThrow();
    expect(getAsk(app, ask.id).status).toBe("answered");
  });
});

describe("工作线：每晚提议", () => {
  it("和已有的线对上的补材料、挂事项；新的发一张卡，建 / 不用 / 并进", async () => {
    const app = fresh();
    const line = upsertItem(app, undefined, { kind: "line", title: "示例商城 · 退款改造" }, "user");
    const req = upsertItem(app, undefined, { title: "退款单显示运费" }, "user");
    const loose = upsertItem(app, undefined, { title: "运费口径" }, "user");
    const other = upsertItem(app, undefined, { title: "项目 A 的接口" }, "user");
    setParent(app, req.id, line.id);
    const doc = appendToSource(app, { spaceId: "personal", kind: "doc", uri: "doc:refund", title: "退款设计", lines: ["设计"] });
    chat(app, other.id, "oc_a");
    const r = running(app, "work-state");
    const said = proposeLines(app, r.id, { lines: [
      { name: "退款改造", goal: "", items: [req.id, loose.id], chats: [], sources: [`src:${doc.id}`] },
      { name: "项目 A 上线", goal: "12 月上线", items: [other.id], chats: ["oc_a"], sources: [] },
      { name: "没人要的线", goal: "", items: [], chats: [], sources: [] },
    ] });
    expect(said).toContain("就是已有的工作线");
    expect(getItem(app, loose.id).parentId).toBe(line.id);
    expect(one(app.db, "select 1 from item_materials where item_id = ? and kind = 'source' and ref = ?", line.id, doc.id)).toBeTruthy();
    const ask = linesCard(app, r.id)!;
    expect(ask.question).toContain("要建成工作线吗");
    expect(ask.ui!.fields!.map((f) => f.label)).toEqual(["项目 A 上线", "没人要的线"]);
    expect((ask.ui!.fields![0] as { options: string[] }).options).toEqual(["建", "不用", "并进「示例商城 · 退款改造」"]);
    expect(linesCard(app, r.id)).toBeNull();
    const [p1, p2] = ask.ui!.fields!.map((f) => f.id);
    await answerAsk(app, ask.id, { value: { [p1]: "建", [p2]: "不用" }, by: "owner" });
    const made = one<{ id: string }>(app.db, "select id from items where kind = 'line' and title = '项目 A 上线'")!;
    expect(getItem(app, other.id).parentId).toBe(made.id);
    expect(getItem(app, made.id).detail).toBe("12 月上线");
    expect(itemContext(app, made.id)).toMatchObject({ status: "active", knobs: { reply: "none", assist: "suggest" } });
    expect(itemContext(app, made.id)!.chats).toEqual(["oc_a"]);
    // 不用: not asked again for two weeks.
    const r2 = running(app, "work-state");
    expect(proposeLines(app, r2.id, { lines: [{ name: "没人要的线", goal: "", items: [], chats: [], sources: [] }] })).toContain("两周内不再问");
    expect(() => proposeLines(app, running(app, "agent").id, { lines: [{ name: "x" }] })).toThrow(/近况整理/);
  });
});

describe("工作线：接口", () => {
  it("GET /api/work 和 /api/work/:id 的形状；挂上层、下一步、对我没用", async () => {
    const app = fresh();
    flow(app);
    const server = await startServer(app, { port: 0, quiet: true }); servers.push(server);
    const line = upsertItem(app, undefined, { kind: "line", title: "示例商城 · 退款改造" }, "user");
    const req = upsertItem(app, undefined, { title: "退款单显示运费" }, "user");
    const loose = upsertItem(app, undefined, { title: "买牛奶" }, "user");
    const started = upsertItem(app, undefined, { title: "项目 A" }, "user");
    chat(app, line.id, "oc_line");
    expect((await server.inject({ method: "PUT", url: `/api/items/${req.id}/parent`, payload: { parent: line.id } })).statusCode).toBe(200);
    await startFlow(app, req.id, "demo", owner);
    await ownerAction(app, req.id, "code", "done", "本人做完了");
    await startFlow(app, started.id, "demo", owner);
    const r = running(app, "agent", { lineState: line.id });
    submitLineState(app, r.id, { now: "截至今天，编码做完", next: [{ text: "补测试", why: "", refs: [], kind: "test" }] });
    const w = (await server.inject("/api/work")).json();
    expect(Object.keys(w).sort()).toEqual(["ended", "endedMore", "lines", "loose", "places", "waiting"]);
    expect(w.lines.map((l: { id: string }) => l.id)).toEqual([line.id, started.id]);
    const l = w.lines[0];
    expect(Object.keys(l).sort()).toEqual(["children", "counts", "dueAt", "id", "kind", "listen", "next", "now", "phase", "phaseSince", "spaceId", "status", "timeline", "title", "watchUntil"]);
    expect(l.now.text).toBe("截至今天，编码做完");
    expect(l.counts.changes).toBeGreaterThan(0);
    expect(l.timeline.at(-1).summary).toContain("「编码」做完");
    expect(l.next.map((n: { text: string }) => n.text)).toEqual(["补测试"]);
    expect(l.children[0]).toMatchObject({ id: req.id, parentId: line.id, flow: { name: "示例交付", current: { id: "test" } } });
    expect(l.children[0].flow.stages.map((s: { state: string }) => s.state)).toEqual(["done", "doing", "pending"]);
    expect(l.listen).toMatchObject({ assist: "suggest" });
    expect(w.loose.map((i: { id: string }) => i.id)).toEqual([loose.id]);
    expect(Object.keys(w.waiting).sort()).toEqual(["asks", "candidates", "changes", "drafts", "gates", "total"]);
    const d = (await server.inject(`/api/work/${req.id}`)).json();
    expect(Object.keys(d).sort()).toEqual(["ancestors", "chats", "children", "ended", "flow", "item", "listen", "materials", "next", "now", "openUnder", "phase", "phaseSince", "summary", "timeline", "watchUntil"]);
    expect(d.ancestors).toEqual([{ id: line.id, title: line.title }]);
    expect(d.flow.current.id).toBe("test");
    const top = (await server.inject(`/api/work/${line.id}`)).json();
    expect(top.chats[0]).toMatchObject({ chatId: "oc_line", total: 1 });
    expect(top.chats[0].perDay).toHaveLength(14);
    expect(top.chats[0].perDay.reduce((a: number, b: number) => a + b, 0)).toBe(1);
    expect(top.materials.length).toBe(1);
    const act = (await server.inject(`/api/work/activities?line=${line.id}`)).json();
    expect(act.days).toHaveLength(30);
    expect(act.items.length).toBe(top.timeline.length);
    const change = top.timeline[0];
    expect((await server.inject({ method: "PUT", url: `/api/item-changes/${change.id}/noise`, payload: { noise: true } })).json()).toEqual({ id: change.id, noise: true });
    expect((await server.inject(`/api/work/${line.id}`)).json().timeline).toHaveLength(top.timeline.length - 1);
    const next = top.next[0];
    const doing = (await server.inject({ method: "PUT", url: `/api/item-next/${next.id}`, payload: { status: "doing" } })).json();
    expect(doing).toMatchObject({ status: "doing" });
    expect(getRun(app, doing.runId).lane).toBe(`line-next:${line.id}`);
    expect((await server.inject({ method: "POST", url: `/api/work/${line.id}/refresh` })).json()).toMatchObject({ status: "queued" });
    expect((await server.inject({ method: "PUT", url: `/api/items/${req.id}/parent`, payload: { parent: req.id } })).statusCode).toBe(400);
    // Owner-only routes.
    createUser(app, { id: "reader", name: "成员甲" }); addMember(app, "personal", "reader", "editor");
    const headers = { authorization: `Bearer ${createApiToken(app, "reader", "test")}` };
    expect((await server.inject({ url: "/api/work", headers })).statusCode).toBe(403);
    expect((await server.inject({ url: `/api/work/${line.id}`, headers })).statusCode).toBe(403);
  });

  it("来源里的事项和运行带上标题（refTargets），认不出的、别人的不给，网页照这个链接", async () => {
    const app = fresh();
    const server = await startServer(app, { port: 0, quiet: true }); servers.push(server);
    const line = upsertItem(app, undefined, { kind: "line", title: "示例商城 · 退款改造" }, "user");
    const req = upsertItem(app, undefined, { title: "退款单显示运费" }, "user");
    setParent(app, req.id, line.id);
    createUser(app, { id: "reader", name: "成员甲" });
    const theirs = upsertItem(app, undefined, { title: "成员甲的事", userId: "reader" }, "user");
    const checked = createRun(app, { kind: "agent", spaceId: "personal", title: "核对退款金额", input: {} });
    const r = running(app, "agent", { lineState: line.id });
    submitLineState(app, r.id, { now: "截至今天，金额口径定了", next: [{ text: "补测试", why: "", refs: [req.id, `run:${checked.id}`, "i0nothere0000000000", theirs.id, "编码阶段"], kind: "test" }] });
    addChange(app, { itemId: req.id, type: "decision", origin: "owner", summary: "运费按实付退", refs: [`item:${req.id}`, checked.id] });
    addChange(app, { itemId: req.id, type: "info", origin: "owner", summary: "只有一句话" });

    const d = (await server.inject(`/api/work/${line.id}`)).json();
    expect(d.next[0].refTargets).toEqual({
      [req.id]: { kind: "item", id: req.id, title: "退款单显示运费" },
      [`run:${checked.id}`]: { kind: "run", id: checked.id, title: "核对退款金额" },
    });
    const decided = d.timeline.find((c: { summary: string }) => c.summary === "运费按实付退");
    expect(decided.refTargets).toEqual({ [`item:${req.id}`]: { kind: "item", id: req.id, title: "退款单显示运费" }, [checked.id]: { kind: "run", id: checked.id, title: "核对退款金额" } });
    expect(d.timeline.find((c: { summary: string }) => c.summary === "只有一句话")).not.toHaveProperty("refTargets");
    // The work page's cards and the timeline by day carry the same.
    const w = (await server.inject("/api/work")).json();
    expect(w.lines[0].next[0].refTargets[req.id].title).toBe("退款单显示运费");
    const act = (await server.inject(`/api/work/activities?line=${line.id}`)).json();
    expect(act.items.find((c: { summary: string }) => c.summary === "运费按实付退").refTargets[checked.id].kind).toBe("run");

    // On the web: those link by name; an id nothing answers to, someone else's item and a word stay text.
    const shown = otherRefs(d.next[0].refs, d.next[0].refTargets);
    expect(shown.map((o) => [o.label, o.link])).toEqual([
      ["事项：退款单显示运费", `#/work/${req.id}`],
      ["运行：核对退款金额", `#/runs/${checked.id}`],
      ["i0nothere0000000000", null],
      [theirs.id, null],
      ["编码阶段", null],
    ]);
  });
});
