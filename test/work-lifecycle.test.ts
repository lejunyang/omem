import { rmSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import type { App } from "../src/core/app.ts";
import { all, one, run } from "../src/core/db.ts";
import { answerAsk, getAsk, listAsks } from "../src/agents/asks.ts";
import { sendItemDigests } from "../src/agents/jobs.ts";
import { weeklyTask } from "../src/agents/weekly-report.ts";
import { createRun, getRun, runsInLane } from "../src/agents/runs.ts";
import { getContext, itemContext, saveContext } from "../src/channels/listen.ts";
import { lineStateTask } from "../src/channels/listen-assist.ts";
import { itemDigestCard } from "../src/channels/item-notification.ts";
import { defineMetric, getMetric } from "../src/data/metrics.ts";
import { saveFlow } from "../src/flows/definitions.ts";
import { ownerAction, startFlow } from "../src/flows/engine.ts";
import { addChange } from "../src/items/changes.ts";
import { itemExpiry, keepItem } from "../src/items/expiry.ts";
import { ASKS_PER_DAY, askLineEnd, endLine, lineEndCases, lineLifecycleDue, wrapUpTask } from "../src/items/lifecycle.ts";
import { nextOf, submitLineState } from "../src/items/lines.ts";
import { setParent } from "../src/items/parent.ts";
import { getItem, upsertItem } from "../src/items/store.ts";
import { createApiToken, createUser } from "../src/core/users.ts";
import type { Notification } from "../src/core/notify.ts";
import { startServer } from "../src/server/http.ts";
import { testApp } from "./helpers.ts";

const apps: App[] = [];
const servers: FastifyInstance[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  await new Promise((r) => setImmediate(r));
  for (const app of apps.splice(0)) { app.events.emit("close"); app.db.close(); rmSync(app.home, { force: true, recursive: true }); }
});
const fresh = () => { const app = testApp(); apps.push(app); app.config.flows.autoAdvance = 20; return app; };
const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
const owner = { actor: "owner", userId: "owner" };
const running = (app: App, input: Record<string, unknown>) => {
  const r = createRun(app, { kind: "agent", spaceId: "personal", title: "测试", input });
  run(app.db, "update runs set status = 'running' where id = ?", r.id);
  return r;
};
/** Pretend everything about this tree happened `days` ago (events, changes, the items themselves). */
function age(app: App, ids: string[], days: number) {
  for (const id of ids) {
    run(app.db, "update items set created_at = ?, updated_at = ? where id = ?", ago(days), ago(days), id);
    run(app.db, "update item_events set at = ? where item_id = ?", ago(days), id);
    run(app.db, "update item_changes set at = ? where item_id = ?", ago(days), id);
    run(app.db, "update item_next set created_at = ? where item_id = ?", ago(days), id);
  }
}
/** A line watched since `since` days ago whose window ended `past` days ago. */
function watched(app: App, id: string, since: number, past = 1) {
  run(app.db, "update items set phase = 'watching', phase_since = ?, watch_until = ? where id = ?", ago(since), ago(past), id);
}
/** A line with one done work item, a 关注, a metric on it and one under it, an open next step. */
function shipped(app: App) {
  const line = upsertItem(app, undefined, { kind: "line", title: "示例商城 · 退款改造" }, "user");
  const req = upsertItem(app, undefined, { title: "退款单显示运费" }, "user");
  setParent(app, req.id, line.id);
  const ctx = saveContext(app, { kind: "item", itemId: line.id, note: "只读群" });
  const m1 = defineMetric(app, { name: "退款失败数", query: "示例：退款失败的单数", itemId: line.id });
  const m2 = defineMetric(app, { name: "运费错算数", query: "示例：运费错算的单数", itemId: req.id });
  return { line, req, ctx, m1, m2 };
}

describe("工作线：进入观察，不问本人", () => {
  it("顶层事项的流程走完、下面没有没结的事：进入观察", async () => {
    const app = fresh();
    saveFlow(app, YAML.stringify({ id: "demo", name: "示例交付", stages: [{ id: "code", name: "编码", by: "wait" }] }), "owner");
    const item = upsertItem(app, undefined, { title: "项目 A 上线" }, "user");
    await startFlow(app, item.id, "demo", owner);
    await ownerAction(app, item.id, "code", "done", "本人做完了");
    const after = getItem(app, item.id);
    expect(after.phase).toBe("watching");
    expect(after.status).toBe("open");
    expect(Date.parse(after.watchUntil!) - Date.now()).toBeGreaterThan(13 * DAY);
    // The 关注 the flow made is not stopped while the line is watched.
    expect(itemContext(app, item.id)!.status).toBe("active");
    expect(one<{ summary: string; origin: string }>(app.db, "select summary, origin from item_changes where item_id = ? and origin = 'line'", item.id)).toMatchObject({ summary: "进入观察：流程走完了" });
    expect(listAsks(app, { status: "pending" }).filter((a) => a.handler === "line-end")).toHaveLength(0);
  });

  it("工作线下面的工作项都结了、至少一件做完：进入观察；都取消的不算", () => {
    const app = fresh();
    const { line, req } = shipped(app);
    const other = upsertItem(app, undefined, { title: "导出对账" }, "user");
    setParent(app, other.id, line.id);
    upsertItem(app, other.id, { status: "cancelled" }, "user");
    expect(getItem(app, line.id).phase).toBeNull();
    upsertItem(app, req.id, { status: "done" }, "user");
    expect(getItem(app, line.id).phase).toBe("watching");
    const dropped = upsertItem(app, undefined, { kind: "line", title: "项目 B" }, "user");
    const c = upsertItem(app, undefined, { title: "调研" }, "user");
    setParent(app, c.id, dropped.id);
    upsertItem(app, c.id, { status: "cancelled" }, "user");
    expect(getItem(app, dropped.id).phase).toBeNull();
    expect(lineLifecycleDue(app).watching).toEqual([]);
  });

  it("每天的现状按把握判断：观察 0.6 以上，结束 0.8 以上且有依据、线下没有没结的事", () => {
    const app = fresh();
    app.config.workLines.watchDays = 10;
    const { line, req } = shipped(app);
    const look = () => running(app, { lineState: line.id });
    submitLineState(app, look().id, { now: "截至今天，开发中", phase: { state: "watching", reason: "群里说下周发布", confidence: 0.5 } });
    expect(getItem(app, line.id).phase).toBeNull();
    const said = submitLineState(app, look().id, { now: "截至今天，已全量", phase: { state: "watching", reason: "群里说已全量", confidence: 0.7, days: 90 } });
    expect(said).toContain("已进入观察");
    const w = getItem(app, line.id);
    expect(w.phase).toBe("watching");
    // The run's days, capped at 60.
    expect(Math.round((Date.parse(w.watchUntil!) - Date.now()) / DAY)).toBe(60);
    // Done but unsure while the requirement is still open: one question, at most.
    const first = submitLineState(app, look().id, { now: "截至今天，已全量", phase: { state: "done", reason: "需求系统里显示已发布", refs: [], confidence: 0.7 } });
    expect(first).toContain("问了本人一次");
    submitLineState(app, look().id, { now: "截至今天，已全量", phase: { state: "done", reason: "需求系统里显示已发布", refs: [], confidence: 0.7 } });
    expect(listAsks(app, { status: "pending" }).filter((a) => a.handler === "line-end")).toHaveLength(1);
    // Confident with evidence, but an item is still open: not ended.
    submitLineState(app, look().id, { now: "截至今天", phase: { state: "done", reason: "需求已关闭", refs: [req.id], confidence: 0.9 } });
    expect(getItem(app, line.id).status).toBe("open");
    // Confident, with evidence, nothing open: ended, no question.
    upsertItem(app, req.id, { status: "done" }, "user");
    for (const a of listAsks(app, { status: "pending" }).filter((x) => x.handler === "line-end")) run(app.db, "update asks set status = 'cancelled' where id = ?", a.id);
    run(app.db, "update item_changes set at = ? where item_id in (?, ?)", ago(5), line.id, req.id);
    run(app.db, "update item_next set status = 'done' where item_id = ?", line.id);
    const done = submitLineState(app, look().id, { now: "截至今天，已结束", phase: { state: "done", reason: "需求在需求系统里关了", refs: [req.id], confidence: 0.9 } });
    expect(done).toContain("已结束");
    expect(getItem(app, line.id).status).toBe("done");
  });
});

describe("工作线：观察期满", () => {
  it("安静的线自动结束：关注和指标停下、下一步过期、进清点、排一轮收尾，不问本人", async () => {
    const app = fresh();
    const { line, req, ctx, m1, m2 } = shipped(app);
    upsertItem(app, req.id, { status: "done" }, "user");
    // An old next step nobody answered does not hold it.
    const r = running(app, { lineState: line.id });
    submitLineState(app, r.id, { now: "截至今天，已上线", next: [{ text: "看上线后的退款失败数", why: "", refs: [], kind: "data" }] });
    age(app, [line.id, req.id], 20);
    watched(app, line.id, 15);
    const out = lineLifecycleDue(app);
    expect(out.ended).toEqual([line.id]);
    expect(out.asked).toEqual([]);
    const ended = getItem(app, line.id);
    expect(ended.status).toBe("done");
    expect(getContext(app, ctx.id)!.status).toBe("paused");
    expect(getContext(app, ctx.id)!.note).toContain("这条线结束了");
    expect([getMetric(app, m1.id)!.status, getMetric(app, m2.id)!.status]).toEqual(["paused", "paused"]);
    expect(nextOf(app, line.id, ["open"])).toHaveLength(0);
    expect(nextOf(app, line.id, ["expired"])).toHaveLength(1);
    expect(listAsks(app, { status: "pending" }).filter((a) => a.handler === "line-end")).toHaveLength(0);
    // One wrap-up run: same scope as the daily look, it hands in the closing summary.
    const wraps = runsInLane(app, `line-wrap:${line.id}`);
    expect(wraps).toHaveLength(1);
    const wrap = getRun(app, wraps[0].id);
    expect(wrap.input).toMatchObject({ lineState: line.id, lineWrapUp: true, spec: "assistant" });
    expect((wrap.input.assistantScope as { denyTools: string[] }).denyTools).toEqual(expect.arrayContaining(["notify", "lark_send", "delegate_code", "upsert_item"]));
    expect(String(wrap.input.task)).toContain("summary");
    run(app.db, "update runs set status = 'running' where id = ?", wrap.id);
    expect(() => submitLineState(app, wrap.id, { now: "截至结束" })).toThrow(/summary/);
    submitLineState(app, wrap.id, { now: "截至结束，退款改造已全量", summary: "做成了：按已发货行退款，12 月 2 日全量。\n上线后退款失败数持平。" });
    expect(getItem(app, line.id).now).toMatchObject({ summary: expect.stringContaining("12 月 2 日全量") });
    const closing = all<{ summary: string; detail: string | null; type: string }>(app.db, "select summary, detail, type from item_changes where item_id = ? and origin = 'line' and type = 'resolved'", line.id);
    expect(closing).toHaveLength(1);
    expect(closing[0].summary).toContain("结束：观察了 15 天");
    expect(closing[0].detail).toContain("12 月 2 日全量");
    // The weekly report reads it.
    const weekly = weeklyTask(app, ago(7), new Date().toISOString(), "2026-W47");
    expect(weekly).toContain("本周结束和进入观察的工作线");
    expect(weekly).toMatch(/「示例商城 · 退款改造」结束了[\s\S]*收尾小结：做成了：按已发货行退款/);
    // The daily digest offers to reopen it.
    run(app.db, "insert into kv(key,value) values(?,?) on conflict(key) do update set value = excluded.value", "item_digest:owner", ago(1));
    await sendItemDigests(app);
    const n = one<{ title: string; body: string; context: string }>(app.db, "select title, body, context from notifications where title like '事项清点%' order by at desc limit 1")!;
    expect(n.title).toContain("1 条工作线结束");
    expect(n.body).toContain("工作线已结束");
    const digest = JSON.parse(n.context).digest as Notification["digest"];
    expect(digest!.closed).toContain(line.id);
    const card = JSON.stringify(itemDigestCard(app, { title: n.title, body: n.body, digest } as Notification));
    expect(card).toContain(`item:reopen:${line.id}`);
  });

  it("群里还有新变化、指标越过门槛：悄悄延一周；只开着东西又不动的，观察两倍时间后才问一次", () => {
    const app = fresh();
    const { line, req } = shipped(app);
    upsertItem(app, req.id, { status: "done" }, "user");
    age(app, [line.id, req.id], 20);
    watched(app, line.id, 15);
    addChange(app, { itemId: line.id, type: "info", origin: "problem", summary: "上线后有人问运费怎么退" });
    const out = lineLifecycleDue(app);
    expect(out.extended).toEqual([line.id]);
    const after = getItem(app, line.id);
    expect(after.status).toBe("open");
    expect(Date.parse(after.watchUntil!)).toBeGreaterThan(Date.now() + 6 * DAY);
    expect(one<{ summary: string }>(app.db, "select summary from item_changes where item_id = ? and origin = 'line' and summary like '还在观察%'", line.id)!.summary).toContain("新变化");
    expect(listAsks(app, { status: "pending" })).toHaveLength(0);
    // Not past the window again: nothing happens.
    expect(lineLifecycleDue(app)).toEqual({ watching: [], ended: [], extended: [], asked: [] });
    // A metric past its mark this week keeps it watched too.
    watched(app, line.id, 22);
    run(app.db, "update item_changes set at = ? where item_id = ?", ago(5), line.id);
    addChange(app, { itemId: req.id, type: "result", origin: "metric", summary: "指标变化：运费错算数 +80%" });
    expect(lineLifecycleDue(app).extended).toEqual([line.id]);
    expect(one<{ summary: string }>(app.db, "select summary from item_changes where item_id = ? and origin = 'line' order by at desc, rowid desc limit 1", line.id)!.summary).toContain("指标越过门槛");

    // Something stays open and nothing moves: the window passes once without a question (not yet twice as long)…
    const b = upsertItem(app, undefined, { kind: "line", title: "客服工单提效" }, "user");
    const t = upsertItem(app, undefined, { title: "话术库整理" }, "user");
    setParent(app, t.id, b.id);
    age(app, [b.id, t.id], 40);
    watched(app, b.id, 20);
    expect(lineLifecycleDue(app).extended).toEqual([b.id]);
    // …then, watched for more than twice the window, one card.
    watched(app, b.id, 30);
    expect(lineLifecycleDue(app).asked).toEqual([b.id]);
    const ask = listAsks(app, { status: "pending" }).find((a) => a.handler === "line-end")!;
    expect(ask.options.map((o) => o.label)).toEqual(["结束", "再看一周", "还没完（回到进行中）"]);
    expect(ask.question).toContain("下面 1 件没结");
    // At most one per line in 14 days: the next pass keeps watching instead.
    run(app.db, "update asks set status = 'cancelled' where id = ?", ask.id);
    watched(app, b.id, 31);
    expect(lineLifecycleDue(app)).toMatchObject({ asked: [], extended: [b.id] });
  });

  it("每天最多问两条线", () => {
    const app = fresh();
    const lines = [0, 1, 2].map((i) => upsertItem(app, undefined, { kind: "line", title: `线 ${i}` }, "user"));
    expect(lines.map((l) => !!askLineEnd(app, l, "看起来做完了"))).toEqual([true, true, false]);
    expect(ASKS_PER_DAY).toBe(2);
  });

  it("卡片上的三个选项：结束（连下面的一起）、再看一周、还没完（两周内不再自动结束、不再问）", async () => {
    const app = fresh();
    const mk = (title: string) => {
      const line = upsertItem(app, undefined, { kind: "line", title }, "user");
      const t = upsertItem(app, undefined, { title: `${title} 的待办` }, "user");
      setParent(app, t.id, line.id);
      return { line, t };
    };
    const a = mk("线甲"), b = mk("线乙"), c = mk("线丙");
    run(app.db, "update kv set value = ? where key like 'line_end_ask:%'", ago(30));
    const ask = (id: string) => askLineEnd(app, getItem(app, id), "观察了很久")!;
    const qa = ask(a.line.id), qb = ask(b.line.id);
    await answerAsk(app, qa.id, { choice: 0, by: "owner" });
    expect(getItem(app, a.line.id).status).toBe("done");
    expect(getItem(app, a.t.id).status).toBe("done");
    watched(app, b.line.id, 20);
    await answerAsk(app, qb.id, { choice: 1, by: "owner" });
    const bb = getItem(app, b.line.id);
    expect(bb.phase).toBe("watching");
    expect(Math.round((Date.parse(bb.watchUntil!) - Date.now()) / DAY)).toBe(7);
    // The third, on another day.
    run(app.db, "update asks set created_at = ? where id in (?, ?)", ago(2), qa.id, qb.id);
    watched(app, c.line.id, 40);
    const qc = ask(c.line.id);
    await answerAsk(app, qc.id, { choice: 2, by: "owner" });
    expect(getItem(app, c.line.id).phase).toBeNull();
    age(app, [c.line.id, c.t.id], 40);
    upsertItem(app, c.t.id, { status: "done" }, "user");
    expect(getItem(app, c.line.id).phase).toBeNull();
    expect(lineLifecycleDue(app).watching).not.toContain(c.line.id);
    expect(askLineEnd(app, getItem(app, c.line.id), "再问")).toBeNull();
    // Each decision is a case the next look reads.
    const cases = lineEndCases(app, "owner");
    expect(cases.map((x) => x.outcome)).toEqual(expect.arrayContaining(["owner-ended", "keep-watching", "not-done"]));
    const task = await lineStateTask(app, saveContext(app, { kind: "item", itemId: b.line.id }), getItem(app, b.line.id), "suggest");
    expect(task).toContain("本人以前怎么定的");
    expect(task).toContain("本人选了再看一周");
    expect(task).toContain("在观察中");
    expect(task).toContain("phase");
    expect(() => getAsk(app, qa.id)).not.toThrow();
  });
});

describe("工作线：结束与重新打开", () => {
  it("本人从清点卡片恢复：关注和指标接着来，两周内不再自动结束", () => {
    const app = fresh();
    const { line, req, ctx, m1, m2 } = shipped(app);
    upsertItem(app, req.id, { status: "done" }, "user");
    age(app, [line.id, req.id], 20);
    watched(app, line.id, 15);
    lineLifecycleDue(app);
    expect(getItem(app, line.id).status).toBe("done");
    keepItem(app, line.id, "user");
    const back = getItem(app, line.id);
    expect(back.status).toBe("open");
    expect(back.phase).toBeNull();
    expect(getContext(app, ctx.id)).toMatchObject({ status: "active", note: "只读群" });
    expect([getMetric(app, m1.id)!.status, getMetric(app, m2.id)!.status]).toEqual(["active", "active"]);
    expect(lineEndCases(app, "owner")[0]).toMatchObject({ outcome: "restored", itemId: line.id });
    expect(one<{ summary: string }>(app.db, "select summary from item_changes where item_id = ? and summary like '本人重新打开%'", line.id)).toBeTruthy();
    // Kept: not into 观察 again, not ended, not asked for two weeks.
    age(app, [line.id, req.id], 20);
    watched(app, line.id, 15);
    expect(lineLifecycleDue(app)).toEqual({ watching: [], ended: [], extended: [], asked: [] });
    expect(askLineEnd(app, getItem(app, line.id), "x")).toBeNull();
    run(app.db, "update kv set value = ? where key = ?", ago(15), `line_keep:${line.id}`);
    expect(lineLifecycleDue(app).ended).toEqual([line.id]);
  });

  it("本人自己结束：下面还开着的要确认才一起结束；放弃是取消；编辑里改状态也一样收尾", () => {
    const app = fresh();
    const { line, req } = shipped(app);
    expect(() => endLine(app, line.id, { status: "done", by: "owner" })).toThrow(/一起结束/);
    expect(() => endLine(app, line.id, { status: "done", by: "member" })).toThrow();
    endLine(app, line.id, { status: "cancelled", by: "owner", closeChildren: true });
    expect([getItem(app, line.id).status, getItem(app, req.id).status]).toEqual(["cancelled", "cancelled"]);
    expect(lineEndCases(app, "owner")[0]).toMatchObject({ outcome: "owner-cancelled" });
    // Its items closing after it did not put it into 观察.
    expect(getItem(app, line.id).phase).toBeNull();
    const other = upsertItem(app, undefined, { kind: "line", title: "项目 A" }, "user");
    const c = saveContext(app, { kind: "item", itemId: other.id });
    upsertItem(app, other.id, { status: "done" }, "user");
    expect(getContext(app, c.id)!.status).toBe("paused");
    expect(runsInLane(app, `line-wrap:${other.id}`)).toHaveLength(1);
    expect(lineEndCases(app, "owner")[0]).toMatchObject({ outcome: "owner-ended", itemId: other.id });
    expect(wrapUpTask(app, getItem(app, other.id))).toContain("收尾");
  });

  it("工作线不再自动过期：结束由生命周期管", () => {
    const app = fresh();
    const line = upsertItem(app, undefined, { kind: "line", title: "项目 A" }, "user");
    expect(itemExpiry(app, getItem(app, line.id))).toBeNull();
    const watchedTodo = upsertItem(app, undefined, { title: "跟进运费口径" }, "user");
    saveContext(app, { kind: "item", itemId: watchedTodo.id });
    expect(itemExpiry(app, getItem(app, watchedTodo.id))).toBeNull();
    const plain = upsertItem(app, undefined, { title: "买牛奶" }, "user");
    expect(itemExpiry(app, plain)?.text).toContain("14 天");
    // Nothing moved for a todo's period with nothing open: into 观察 (then ended by the window).
    age(app, [line.id], 20);
    expect(lineLifecycleDue(app).watching).toContain(line.id);
  });
});

describe("工作线：接口", () => {
  it("线带阶段，已结束的分页搜索，改阶段；成员 403", async () => {
    const app = fresh();
    const server = await startServer(app, { port: 0, quiet: true }); servers.push(server);
    const { line, req } = shipped(app);
    const put = (id: string, payload: Record<string, unknown>) => server.inject({ method: "PUT", url: `/api/work/${id}/phase`, payload });
    expect((await put(line.id, { phase: "watching", days: 5 })).json()).toMatchObject({ phase: "watching", status: "open" });
    const w = (await server.inject("/api/work")).json();
    const l = w.lines.find((x: { id: string }) => x.id === line.id);
    expect(l).toMatchObject({ phase: "watching", watch: { flaggedMetrics: 0, openProblems: 0, openItems: 1 } });
    expect(Math.round((Date.parse(l.watchUntil) - Date.now()) / DAY)).toBe(5);
    expect(w.ended).toEqual([]);
    expect((await put(line.id, { phase: "done" })).statusCode).toBe(409);
    expect((await put(line.id, { phase: "done", closeChildren: true, reason: "已全量" })).json()).toMatchObject({ status: "done" });
    expect(getItem(app, req.id).status).toBe("done");
    for (const [i, title] of ["客服工单提效", "导出改造", "运费口径统一"].entries()) {
      const x = upsertItem(app, undefined, { kind: "line", title }, "user");
      upsertItem(app, x.id, { status: "done" }, "user");
      run(app.db, "update items set closed_at = ? where id = ?", ago(10 + i), x.id);
    }
    const w2 = (await server.inject("/api/work")).json();
    expect(w2.ended[0]).toMatchObject({ id: line.id, status: "done", reason: expect.stringContaining("已全量") });
    expect(Object.keys(w2.ended[0]).sort()).toEqual(["closedAt", "id", "reason", "spaceId", "status", "summary", "title"]);
    const page1 = (await server.inject("/api/work/ended?limit=2")).json();
    expect(page1.items).toHaveLength(2);
    expect(page1.more).toBe(true);
    const page2 = (await server.inject(`/api/work/ended?limit=2&before=${encodeURIComponent(page1.items[1].closedAt)}`)).json();
    expect(page2.items.map((x: { title: string }) => x.title)).toEqual(["导出改造", "运费口径统一"]);
    expect((await server.inject(`/api/work/ended?q=${encodeURIComponent("工单")}`)).json().items.map((x: { title: string }) => x.title)).toEqual(["客服工单提效"]);
    const d = (await server.inject(`/api/work/${line.id}`)).json();
    expect(d).toMatchObject({ ended: { status: "done", reason: expect.stringContaining("已全量") }, summary: null, openUnder: 0 });
    // 重新打开.
    expect((await put(line.id, { phase: "active" })).json()).toMatchObject({ status: "open", phase: null });
    expect((await put(req.id, { phase: "watching" })).statusCode).toBe(400);
    createUser(app, { id: "reader", name: "成员甲" });
    const headers = { authorization: `Bearer ${createApiToken(app, "reader", "test")}` };
    expect((await server.inject({ url: "/api/work/ended", headers })).statusCode).toBe(403);
    expect((await server.inject({ method: "PUT", url: `/api/work/${line.id}/phase`, headers, payload: { phase: "done" } })).statusCode).toBe(403);
  });
});
