import { z } from "zod";
import { metricProviders } from "../src/plugins/process-hooks.ts";
import type { MetricProvider } from "../packages/plugin-sdk/server.ts";
import { createSpace } from "../src/core/spaces.ts";
import { addMember, createUser } from "../src/core/users.ts";
import { describe, expect, it, vi } from "vitest";
import { createRun, listRuns } from "../src/agents/runs.ts";
import { threadMessages } from "../src/agents/threads.ts";
import { callTool, issueToolToken, toolContextForToken } from "../src/agents/tools.ts";
import { all, METRIC_ORIGIN_MIGRATION, one, openDb, run } from "../src/core/db.ts";
import { saveContext } from "../src/channels/listen.ts";
import { collectDue, defineMetric, getMetric, listMetrics, metricLessons, metricPoints, metricText, readMetric, recordPoints } from "../src/data/metrics.ts";
import { snapshotOmemUsage } from "../src/data/omem-usage.ts";
import { upsertItem } from "../src/items/store.ts";
import { testApp } from "./helpers.ts";

const tool = (app: ReturnType<typeof testApp>, runId: string | null = null) => toolContextForToken(app, issueToolToken({ runId, spaceId: "personal", spaces: null, tools: null, actor: "agent" }))!;
const day = (n: number) => new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);

describe("metrics", () => {
  it("defines a metric on an item, records points and tells a change past its threshold", async () => {
    const app = testApp();
    const item = upsertItem(app, undefined, { spaceId: "personal", kind: "todo", title: "新版消息中心上线" } as never, "user");
    const ctx = saveContext(app, { kind: "place", name: "值班群", chats: ["oc_ops"], knobs: { reply: "none" } });
    const t = tool(app);
    expect((await callTool(t, "metric_define", { name: "消息中心 JS 报错" })).isError).toBe(true);
    const made = await callTool(t, "metric_define", { name: "消息中心 JS 报错", unit: "次", source: "前端监控", query: "前端监控技能：按页面 /message 查 JS 报错数，按天", item: item.id, context: ctx.id, direction: "down-good", threshold: 0.5 });
    expect(made.isError).toBe(false);
    const id = /（(m[0-9a-z]+)）/.exec(made.text)![1];
    for (const [i, v] of [10, 12, 11, 9, 10].entries()) await recordPoints(app, id, [{ value: v, at: day(6 - i) }]);
    expect(all(app.db, "select 1 from notifications where title like '%消息中心 JS 报错%'")).toHaveLength(0);
    const out = await callTool(t, "metric_record", { metric: "消息中心 JS 报错", points: [{ value: 25, at: day(0) }] });
    expect(out.text).toContain("超过门槛");
    expect(out.text).toContain("变差");
    expect(one(app.db, "select body from notifications where title like '%消息中心 JS 报错%'")).toBeTruthy();
    expect(threadMessages(app, ctx.conversationId!).some((m) => m.text.includes("指标变化"))).toBe(true);
    expect(one(app.db, "select text from item_events where item_id = ? and text like '指标变化%'", item.id)).toBeTruthy();
    // Read with a chart for a report.
    const read = await callTool(t, "metric_read", { metric: id, chart: true });
    expect(read.text).toContain("```chart");
    expect(read.text).toContain("基线 10次，+150%");
    expect((await callTool(t, "metric_read", { item: item.id })).text).toContain("消息中心 JS 报错");
  });

  it("keeps dimensions apart and replaces a point recorded again", async () => {
    const app = testApp();
    const m = defineMetric(app, { name: "提交成功率", unit: "%", query: "BI 看板 X 的成功率，按平台" });
    await recordPoints(app, m.id, [{ value: 90, at: day(1), dims: { 平台: "旧" } }, { value: 95, at: day(1), dims: { 平台: "新" } }]);
    await recordPoints(app, m.id, [{ value: 96, at: day(1), dims: { 平台: "新" } }]);
    expect(metricPoints(app, m.id, { dims: { 平台: "新" } }).map((p) => p.value)).toEqual([96]);
    const r = readMetric(app, m.id);
    expect(r.chart.series.map((s) => s.name).sort()).toEqual(["新", "旧"]);
  });

  it("starts one read-only collection run per space for metrics whose time came", async () => {
    const app = testApp();
    defineMetric(app, { name: "入口点击", query: "埋点平台：事件 entry_click 的日 PV", schedule: "daily" });
    defineMetric(app, { name: "接口错误率", query: "后端监控：服务 X 的错误率", schedule: "hourly" });
    defineMetric(app, { name: "按需的", query: "不定时" });
    const ids = await collectDue(app);
    expect(ids).toHaveLength(1);
    const r = listRuns(app, { kind: "agent" })[0];
    expect(r.input.metricCollect).toHaveLength(2);
    expect(String(r.input.task)).toContain("metric_record");
    expect((r.input.assistantScope as { denyTools: string[] }).denyTools).toContain("lark_send");
    // Queued already: no second run.
    expect(await collectDue(app)).toHaveLength(0);
  });

  it("waits a full period after a collection round that recorded nothing", async () => {
    const app = testApp();
    const m = defineMetric(app, { name: "新端有效活跃", query: "数仓：新端去重 UID（还没有读权限）", schedule: "daily" });
    const start = Date.now();
    expect(await collectDue(app, start)).toHaveLength(1);
    // The round ends without a value: no permission yet.
    run(app.db, "update runs set status = 'done' where kind = 'agent'");
    expect(getMetric(app, m.id)).toMatchObject({ lastAt: null, lastAttemptAt: new Date(start).toISOString() });
    for (const later of [15 * 60_000, 6 * 3600_000, 20 * 3600_000]) expect(await collectDue(app, start + later)).toEqual([]);
    expect(await collectDue(app, start + 86400_000)).toHaveLength(1);
  });

  it("configures a provider through the tool and HTTP and batches queries separately from agent runs", async () => {
    const app = testApp();
    const providerId = "sample:requests";
    const collect = vi.fn<MetricProvider["collect"]>(async (_ctx, req) =>
      req.metrics.map(m => ({ metricId: m.id, at: req.to, value: Number(m.query), dims: { kind: "requests" }, source: "daily report" })));
    metricProviders.set(providerId, {
      plugin: "sample", spaces: [], def: { id: "requests", label: "请求计数", querySchema: z.number().int(), collect },
      context: (_app, userId, spaceId, signal) => ({ userId, spaceId, signal, connection: async () => null }),
    });
    const { startServer } = await import("../src/server/http.ts");
    const server = await startServer(app, { port: 0, quiet: true });
    try {
      expect((await server.inject("/api/metrics/providers")).json()).toContainEqual(expect.objectContaining({
        id: providerId, label: "请求计数", querySchema: expect.objectContaining({ type: "integer" }),
      }));
      const t = tool(app);
      const args = { name: "请求总数", providerId, schedule: "daily" };
      expect((await callTool(t, "metric_define", { ...args, providerQuery: "bad" })).isError).toBe(true);
      expect((await callTool(t, "metric_define", { ...args, providerQuery: 3 })).isError).toBe(false);
      const m = defineMetric(app, { name: "失败次数", query: "按日报取数", schedule: "daily" });
      const url = `/api/metrics/${m.id}`;
      expect((await server.inject({ method: "PUT", url, payload: { providerId, providerQuery: "bad" } })).statusCode).toBe(400);
      expect((await server.inject({ method: "PUT", url, payload: { providerId, providerQuery: 2 } })).json()).toMatchObject({ providerId, providerQuery: 2 });
      const legacy = defineMetric(app, { name: "访问人数", query: "读取访问日报", schedule: "daily" });
      createSpace(app, { id: "project", name: "示例项目" });
      createUser(app, { id: "editor", name: "编辑" });
      addMember(app, "project", "editor", "editor");
      for (const [userId, value] of [["owner", 4], ["editor", 5]] as const) {
        defineMetric(app, { name: `项目请求 ${value}`, spaceId: "project", providerId, providerQuery: value, schedule: "daily" }, { by: "owner", userId });
      }
      await Promise.all([collectDue(app), collectDue(app)]);
      expect(collect.mock.calls.map(([ctx, req]) => [ctx.userId, ctx.spaceId, req.metrics.map(row => row.query).sort()])).toEqual(expect.arrayContaining([
        ["owner", "personal", [2, 3]], ["owner", "project", [4]], ["editor", "project", [5]],
      ]));
      expect(collect).toHaveBeenCalledTimes(3);
      expect(listRuns(app, { kind: "agent" }).map(r => r.input.metricCollect)).toEqual([[legacy.id]]);
      expect(metricPoints(app, m.id)).toMatchObject([{ value: 2, dims: { kind: "requests" }, note: "daily report" }]);
      expect((await callTool(t, "metric_read", { metric: m.id })).text).toContain("请求计数");
      expect((await server.inject({ method: "PUT", url, payload: { providerId: null } })).json().providerId).toBeUndefined();
    } finally {
      metricProviders.delete(providerId);
      await server.close();
    }
  });

  it("rejects invalid provider batches before writing and records one notification until recovery", async () => {
    const app = testApp();
    const providerId = "sample:daily";
    const collect = vi.fn<MetricProvider["collect"]>();
    metricProviders.set(providerId, {
      plugin: "sample", spaces: [], def: { id: "daily", label: "日报", querySchema: z.string(), collect },
      context: (_app, userId, spaceId, signal) => ({ userId, spaceId, signal, connection: async () => null }),
    });
    try {
      const m = defineMetric(app, { name: "完成次数", providerId, providerQuery: "done", schedule: "daily" });
      const start = Date.now();
      const p = { metricId: m.id, at: day(0), value: 1 };
      collect.mockResolvedValueOnce([p, { ...p, metricId: "unrequested" }])
        .mockResolvedValueOnce([p, { ...p, at: "invalid" }])
        .mockRejectedValueOnce(new Error("数据源离线")).mockResolvedValueOnce([p]);
      for (let i = 0; i < 3; i++) {
        const at = start + i * 86400_000;
        expect(await collectDue(app, at)).toEqual([]);
        expect(getMetric(app, m.id)).toMatchObject({ lastAt: null, lastErrorAt: new Date(at).toISOString(), lastError: expect.any(String) });
        expect(metricPoints(app, m.id)).toEqual([]);
        await collectDue(app, at + 60_000);
        expect(collect).toHaveBeenCalledTimes(i + 1);
      }
      expect(getMetric(app, m.id)?.lastError).toBe("数据源离线");
      expect(all(app.db, "select 1 from notifications where title like '指标采集失败%'")).toHaveLength(1);
      await collectDue(app, start + 3 * 86400_000);
      expect(getMetric(app, m.id)?.lastError).toBeUndefined();
      expect(metricPoints(app, m.id)).toMatchObject([{ value: 1 }]);
    } finally {
      metricProviders.delete(providerId);
    }
  });

  it("keeps omem's own use day by day, once per day", () => {
    const app = testApp();
    const yesterday = new Date(Date.now() - 86400_000).toISOString();
    createRun(app, { kind: "ask", title: "a", input: {} });
    run(app.db, "update runs set created_at = ?, started_at = ?, finished_at = ?, status = 'done'", yesterday, yesterday, yesterday);
    const days = snapshotOmemUsage(app, { maxDays: 3 });
    expect(days.length).toBeGreaterThan(0);
    const pts = metricPoints(app, "omem.runs");
    expect(pts.some((p) => p.dims.kind === "ask" && p.value === 1)).toBe(true);
    expect(snapshotOmemUsage(app, { maxDays: 3 })).toEqual([]);
  });

  it("keeps how a run came in, not its whole trigger, and reads older whole triggers as their via", () => {
    const app = testApp();
    const yesterday = new Date(Date.now() - 86400_000).toISOString();
    for (const where of ["示例群 A", "示例群 B"]) createRun(app, { kind: "ask", title: "a", input: {}, trigger: { via: "chat", where, by: { key: "user:owner", name: "你" } } } as never);
    run(app.db, "update runs set created_at = ?, started_at = ?, finished_at = ?, status = 'done'", yesterday, yesterday, yesterday);
    snapshotOmemUsage(app, { maxDays: 3 });
    const pts = metricPoints(app, "omem.runs").filter((p) => p.dims.kind === "ask");
    expect(pts).toEqual([expect.objectContaining({ value: 2, dims: { kind: "ask", status: "done", trigger: "chat" } })]);
    // Points kept before: one per whole trigger. They read as the via, added up.
    for (const where of ["示例群 A", "示例群 B"])
      run(app.db, "insert into metric_points(metric_id,at,value,dims,created_at) values(?,?,?,?,?)", "omem.runs", "2026-01-02", 3, JSON.stringify({ kind: "ask", status: "done", trigger: JSON.stringify({ via: "lark", where }) }), yesterday);
    const old = metricPoints(app, "omem.runs").filter((p) => p.at === "2026-01-02");
    expect(old).toEqual([expect.objectContaining({ value: 6, dims: { kind: "ask", status: "done", trigger: "lark" } })]);
    expect(JSON.stringify(readMetric(app, "omem.runs", { days: 400 }).table)).not.toContain("示例群");
  });

  it("shows one tile per metric: the total of a count split by dimensions, the focus group of a comparison", async () => {
    const app = testApp();
    const counts = defineMetric(app, { name: "退款单数", unit: "单", query: "订单库：每天的退款单，按端" });
    await recordPoints(app, counts.id, [{ value: 3, at: day(1), dims: { 端: "PC" } }, { value: 4, at: day(1), dims: { 端: "手机" } }, { value: 5, at: day(0), dims: { 端: "PC" } }, { value: 1, at: day(0), dims: { 端: "手机" } }]);
    const rate = defineMetric(app, { name: "完成率", unit: "%", query: "埋点：完成率，按端", view: { kind: "compare", compareBy: "端", focus: "手机" } });
    await recordPoints(app, rate.id, [{ value: 70, at: day(0), dims: { 端: "PC" } }, { value: 50, at: day(0), dims: { 端: "手机" } }]);
    const { startServer } = await import("../src/server/http.ts");
    const server = await startServer(app, { port: 0, quiet: true });
    try {
      const list = (await server.inject({ method: "GET", url: "/api/metrics" })).json() as { id: string; spark: number[]; figure: string | null; groups: number }[];
      expect(list.find((m) => m.id === counts.id)).toMatchObject({ spark: [7, 6], figure: null, groups: 2 });
      expect(list.find((m) => m.id === rate.id)).toMatchObject({ spark: [50], figure: "手机", groups: 2 });
    } finally {
      await server.close();
    }
  });

  it("decides several proposals at once, all or nothing", async () => {
    const app = testApp();
    const by = { by: "agent" as const };
    const a = defineMetric(app, { name: "接口报错率", unit: "%", query: "监控：报错率", why: "上线后有没有更容易出错" }, by);
    const b = defineMetric(app, { name: "页面曝光", unit: "次", query: "埋点：曝光", why: "有没有人看" }, by);
    const c = defineMetric(app, { name: "提交数", unit: "单", query: "订单库：提交数", why: "量追上了没有" }, by);
    const { startServer } = await import("../src/server/http.ts");
    const server = await startServer(app, { port: 0, quiet: true });
    try {
      const kept = (await server.inject({ method: "POST", url: "/api/metrics/decide", payload: { ids: [a.id, b.id], status: "active" } })).json();
      expect(kept.changed).toEqual([{ id: a.id, status: "active" }, { id: b.id, status: "active" }]);
      expect(getMetric(app, a.id)?.confirmedAt).toBeTruthy();
      expect((await server.inject({ method: "POST", url: "/api/metrics/decide", payload: { ids: [c.id, "no-such-metric"], status: "dropped" } })).statusCode).toBe(404);
      expect(getMetric(app, c.id)?.status).toBe("proposed");
      expect((await server.inject({ method: "POST", url: "/api/metrics/decide", payload: { ids: [c.id], status: "dropped", note: "看提交数就够了" } })).json().changed[0].status).toBe("dropped");
      expect(getMetric(app, c.id)?.ownerNote).toBe("看提交数就够了");
      expect((await server.inject({ method: "POST", url: "/api/metrics/decide", payload: { ids: [], status: "active" } })).statusCode).toBe(400);
    } finally {
      await server.close();
    }
  });

  it("serves an item's metrics to the web", async () => {
    const app = testApp();
    const item = upsertItem(app, undefined, { spaceId: "personal", kind: "todo", title: "迁移" } as never, "user");
    const m = defineMetric(app, { name: "新平台流量占比", unit: "%", query: "BI：新旧平台 PV 占比", itemId: item.id });
    await recordPoints(app, m.id, [{ value: 20, at: day(1) }, { value: 35, at: day(0) }]);
    const { startServer } = await import("../src/server/http.ts");
    const server = await startServer(app, { port: 0, quiet: true });
    try {
      const list = (await server.inject({ method: "GET", url: `/api/metrics?item=${item.id}` })).json();
      expect(list[0]).toMatchObject({ name: "新平台流量占比", spark: [20, 35] });
      expect((await server.inject({ method: "GET", url: `/api/metrics/${m.id}` })).json().chart.series[0].values).toEqual([20, 35]);
      expect((await server.inject({ method: "PUT", url: `/api/metrics/${m.id}`, payload: { schedule: "daily" } })).json().schedule).toBe("daily");
    } finally {
      await server.close();
    }
  });
});

describe("where metrics come from and what the owner decides", () => {
  const background = (app: ReturnType<typeof testApp>) => tool(app, createRun(app, { kind: "agent", title: "写观测计划", input: { spec: "assistant", task: "写观测计划" } }).id);

  it("a background agent proposes (taken, never told); the owner's own tools define outright", async () => {
    const app = testApp();
    const item = upsertItem(app, undefined, { spaceId: "personal", kind: "todo", title: "退款申请页改版" } as never, "user");
    const bg = background(app);
    expect((await callTool(bg, "metric_define", { name: "退款接口报错率", query: "前端监控：/refund/apply 的接口失败率", item: item.id })).text).toMatch(/why/);
    const made = await callTool(bg, "metric_define", { name: "退款接口报错率", why: "上线后退款接口有没有更容易出错", plan_ref: "src:s0abc#L3-L8", query: "前端监控：/refund/apply 的接口失败率", item: item.id, schedule: "daily", direction: "down-good" });
    expect(made.text).toContain("等本人在数据页");
    const id = /（(m[0-9a-z]+)）/.exec(made.text)![1];
    expect(getMetric(app, id)).toMatchObject({ status: "proposed", definedBy: "agent", confirmedAt: null, why: "上线后退款接口有没有更容易出错", planRef: "src:s0abc#L3-L8" });
    expect(getMetric(app, id)!.definedRun).toBeTruthy();
    // Still taken on schedule…
    expect(await collectDue(app)).toHaveLength(1);
    // …but a change past the threshold is not told.
    for (const [i, v] of [0.4, 0.42, 0.41].entries()) await recordPoints(app, id, [{ value: v, at: day(4 - i) }]);
    const out = await callTool(bg, "metric_record", { metric: id, points: [{ value: 1.2, at: day(0) }] });
    expect(out.text).toContain("待本人确认，没有通知");
    expect(all(app.db, "select 1 from notifications where title like '%退款接口报错率%'")).toHaveLength(0);
    expect(one(app.db, "select 1 from item_events where item_id = ? and text like '指标变化%'", item.id)).toBeUndefined();
    // A background agent cannot keep or drop it.
    expect((await callTool(bg, "metric_define", { id, name: "退款接口报错率", status: "active" })).isError).toBe(false);
    expect(getMetric(app, id)!.status).toBe("proposed");
    expect((await callTool(bg, "metric_define", { id, name: "退款接口报错率", status: "dropped" })).isError).toBe(true);
    // The owner's own tools (no run): active at once.
    const own = await callTool(tool(app), "metric_define", { name: "部分退款占比", why: "部分发货退款有多少", query: "订单库：部分退款占比" });
    expect(getMetric(app, "部分退款占比")).toMatchObject({ status: "active", definedBy: "owner" });
    expect(own.text).toContain("在看");
  });

  it("keeps, changes and drops through the page; a drop stops it and teaches the next proposals", async () => {
    const app = testApp();
    const item = upsertItem(app, undefined, { spaceId: "personal", kind: "todo", title: "新版退款" } as never, "user");
    const bg = background(app);
    await callTool(bg, "metric_define", { name: "退款接口报错率", why: "上线后接口有没有更容易出错", query: "前端监控：失败率", item: item.id, direction: "down-good", schedule: "daily" });
    await callTool(bg, "metric_define", { name: "入口曝光 PV", why: "新入口有没有被看到", query: "埋点平台：entry_expose 的 PV", item: item.id, schedule: "daily" });
    const kept = getMetric(app, "退款接口报错率")!;
    const dropped = getMetric(app, "入口曝光 PV")!;
    const { startServer } = await import("../src/server/http.ts");
    const server = await startServer(app, { port: 0, quiet: true });
    try {
      const list = (await server.inject({ method: "GET", url: `/api/metrics?item=${item.id}` })).json() as { id: string; status: string; why: string; nextAt: string | null }[];
      expect(list.map((m) => m.status)).toEqual(["proposed", "proposed"]);
      expect(list[0].nextAt).toBeTruthy();
      // 保留 (and 改 at once).
      const k = (await server.inject({ method: "PUT", url: `/api/metrics/${kept.id}`, payload: { status: "active", why: "部分发货上线后退款接口有没有更容易出错", threshold: 0.5, view: { kind: "bar" } } })).json();
      expect(k).toMatchObject({ status: "active", why: "部分发货上线后退款接口有没有更容易出错", threshold: 0.5, view: { kind: "bar" } });
      expect(k.confirmedAt).toBeTruthy();
      expect((await server.inject({ method: "PUT", url: `/api/metrics/${kept.id}`, payload: { view: { kind: "spiral" } } })).statusCode).toBe(400);
      // 不要, with a word why.
      const d = (await server.inject({ method: "PUT", url: `/api/metrics/${dropped.id}`, payload: { status: "dropped", note: "曝光不说明问题，看完成率" } })).json();
      expect(d).toMatchObject({ status: "dropped", ownerNote: "曝光不说明问题，看完成率" });
      expect((await server.inject({ method: "GET", url: `/api/metrics?item=${item.id}` })).json().map((m: { id: string }) => m.id)).toEqual([kept.id]);
      expect((await server.inject({ method: "GET", url: `/api/metrics?item=${item.id}&dropped=1` })).json()).toHaveLength(2);
    } finally {
      await server.close();
    }
    // Kept: its changes are told now.
    for (const [i, v] of [0.4, 0.42, 0.41].entries()) await recordPoints(app, kept.id, [{ value: v, at: day(4 - i) }]);
    await recordPoints(app, kept.id, [{ value: 1.3, at: day(0) }]);
    expect(one(app.db, "select 1 from notifications where title like '%退款接口报错率%'")).toBeTruthy();
    // Dropped: not taken, not recorded, not proposed again.
    run(app.db, "update metrics set last_at = null");
    const ids = await collectDue(app);
    expect(listRuns(app, { kind: "agent" }).find((r) => r.id === ids[0])?.input.metricCollect).toEqual([kept.id]);
    await expect(recordPoints(app, dropped.id, [{ value: 3 }])).rejects.toThrow(/不要/);
    const again = await callTool(bg, "metric_define", { name: "入口曝光 PV", why: "再看看", query: "埋点平台" });
    expect(again.isError).toBe(true);
    expect(again.text).toContain("曝光不说明问题");
    // The decisions go to the next proposals.
    const lessons = metricLessons(app);
    expect(lessons).toContain("留下「退款接口报错率」");
    expect(lessons).toContain("不要「入口曝光 PV」");
    expect(lessons).toContain("本人说：曝光不说明问题");
    expect((await callTool(bg, "metric_read", {})).text).toContain("本人对 AI 提议的指标最近是这么定的");
    const next = await callTool(bg, "metric_define", { name: "申请完成率", why: "改版后用户能不能顺利提交", query: "埋点平台：apply_submit / apply_open" });
    expect(next.text).toContain("不要「入口曝光 PV」");
  });

  it("draws by the metric's view: series by a dimension, their shares, the newest parts", async () => {
    const app = testApp();
    const m = defineMetric(app, { name: "新旧平台下单量", unit: "单", query: "BI：按平台的下单量", view: { kind: "compare", compareBy: "side", ratio: true, focus: "新" } });
    await recordPoints(app, m.id, [
      { value: 300, at: day(1), dims: { side: "旧" } }, { value: 100, at: day(1), dims: { side: "新" } },
      { value: 200, at: day(0), dims: { side: "旧", 端: "PC" } }, { value: 100, at: day(0), dims: { side: "旧", 端: "H5" } }, { value: 300, at: day(0), dims: { side: "新" } },
    ]);
    const r = readMetric(app, m.id);
    expect(r.kind).toBe("compare");
    expect(r.charts).toHaveLength(2);
    expect(r.charts[0].series.map((s) => [s.name, s.values])).toEqual([["新", [100, 300]], ["旧", [300, 300]]]);
    expect(r.charts[1]).toMatchObject({ unit: "%", series: [{ name: "新 占比", values: [25, 50] }] });
    expect(r.latest).toEqual({ label: day(0).slice(5, 10), values: [{ name: "新", value: 300 }, { name: "旧", value: 300 }] });
    // The text for a report carries both charts.
    expect(metricText(app, m.id, { chart: true }).match(/```chart/g)).toHaveLength(2);
    // Parts of the newest day as a dial; a figure only draws no chart.
    defineMetric(app, { id: m.id, name: m.name, view: { kind: "pie", compareBy: "side" } });
    const pie = readMetric(app, m.id).charts[0];
    expect(pie.kind).toBe("pie");
    expect([...pie.labels].sort()).toEqual(["新", "旧"].sort());
    defineMetric(app, { id: m.id, name: m.name, view: { kind: "number" } });
    expect(readMetric(app, m.id).charts).toEqual([]);
    const { startServer } = await import("../src/server/http.ts");
    const server = await startServer(app, { port: 0, quiet: true });
    try {
      const listed = (await server.inject({ method: "GET", url: "/api/metrics" })).json()[0];
      expect(listed).toMatchObject({ view: { kind: "number" }, status: "active", definedBy: "owner" });
      expect(listed.latest.values).toHaveLength(3);
    } finally {
      await server.close();
    }
  });

  it("migrates: work metrics defined before become proposals, omem's own count as kept", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const path = join(mkdtempSync(join(tmpdir(), "omem-metrics-")), "omem.db");
    // The metrics table as it was before this migration, with three metrics in it; then the migration.
    const db = openDb(path);
    for (const c of ["why", "plan_ref", "defined_by", "defined_run", "confirmed_at", "dropped_at", "owner_note", "view"]) db.exec(`alter table metrics drop column ${c}`);
    const at = new Date().toISOString();
    for (const [id, source, status] of [["m1", "前端监控", "active"], ["m2", "埋点平台", "paused"], ["omem.runs", "omem", "active"]]) db.prepare("insert into metrics(id,name,source,query,status,created_at,updated_at) values(?,?,?,?,?,?,?)").run(id, id, source, "q", status, at, at);
    db.exec(METRIC_ORIGIN_MIGRATION);
    expect(db.prepare("select id, status, defined_by, confirmed_at is not null confirmed from metrics order by id").all().map((r) => ({ ...r }))).toEqual([
      { id: "m1", status: "proposed", defined_by: "agent", confirmed: 0 },
      { id: "m2", status: "paused", defined_by: "agent", confirmed: 0 },
      { id: "omem.runs", status: "active", defined_by: "omem", confirmed: 1 },
    ]);
    db.close();
  });

  it("lists reports: files under 数据/报表/ and work files with charts, an item's and those under it", async () => {
    const app = testApp();
    const { createLine } = await import("../src/items/lines.ts");
    const { setParent } = await import("../src/items/parent.ts");
    const { writeWorkFile } = await import("../src/sources/work.ts");
    const line = await createLine(app, { name: "示例商城 · 退款改造", goal: "部分发货只退已发货的行" }, "owner");
    const req = upsertItem(app, undefined, { spaceId: "personal", kind: "todo", title: "退款申请页改版" } as never, "user");
    setParent(app, req.id, line.id);
    const chart = '```chart\n{"kind":"pie","labels":["整单","部分"],"series":[{"name":"退款单","values":[3,1]}]}\n```';
    writeWorkFile(app, { spaceId: "personal", path: "数据/报表/退款构成.md", title: "退款构成", text: `# 退款构成\n\n${chart}`, links: { item: req.id } });
    writeWorkFile(app, { spaceId: "personal", path: "笔记/上线一周.md", title: "上线一周", text: `结论\n\n${chart}`, links: { item: line.id } });
    writeWorkFile(app, { spaceId: "personal", path: "笔记/别的.md", title: "别的", text: "没有图" });
    const { startServer } = await import("../src/server/http.ts");
    const server = await startServer(app, { port: 0, quiet: true });
    try {
      const files = (await server.inject({ method: "GET", url: "/api/metrics/files" })).json() as { path: string; kind: string; charts: boolean }[];
      expect(files.map((f) => [f.path, f.kind]).sort()).toEqual([["数据/报表/退款构成.md", "report"], ["笔记/上线一周.md", "report"]]);
      const forLine = (await server.inject({ method: "GET", url: `/api/metrics/files?item=${line.id}` })).json() as { path: string }[];
      expect(forLine).toHaveLength(2);
      const forReq = (await server.inject({ method: "GET", url: `/api/metrics/files?item=${req.id}` })).json() as { path: string }[];
      expect(forReq.map((f) => f.path)).toEqual(["数据/报表/退款构成.md"]);
    } finally {
      await server.close();
    }
  });

  it("a line that ends stops its proposals too, and opened again they are proposals again", async () => {
    const app = testApp();
    const { createLine } = await import("../src/items/lines.ts");
    const line = await createLine(app, { name: "示例商城 · 退款改造", goal: "部分发货只退已发货的行" }, "owner");
    const bg = background(app);
    await callTool(bg, "metric_define", { name: "退款接口报错率", why: "接口有没有更容易出错", query: "前端监控：失败率", item: line.id, schedule: "daily" });
    defineMetric(app, { name: "部分退款占比", query: "订单库", itemId: line.id, schedule: "daily" });
    upsertItem(app, line.id, { status: "done" } as never, "user");
    expect(listMetrics(app, { itemId: line.id }).map((m) => m.status)).toEqual(["paused", "paused"]);
    const { keepItem } = await import("../src/items/expiry.ts");
    keepItem(app, line.id, "user");
    expect(Object.fromEntries(listMetrics(app, { itemId: line.id }).map((m) => [m.name, m.status]))).toEqual({ 退款接口报错率: "proposed", 部分退款占比: "active" });
  });
});

describe("metrics on the data page", () => {
  it("groups work metrics by their line, lists the data work files, and a change on a brand-new item still records and tells", async () => {
    const app = testApp();
    app.config.notify.firstNudgeDelayMinutes = 30;
    const { createLine } = await import("../src/items/lines.ts");
    const { setParent } = await import("../src/items/parent.ts");
    const { writeWorkFile } = await import("../src/sources/work.ts");
    const line = await createLine(app, { name: "示例商城 · 退款改造", goal: "部分发货只退已发货的行" }, "owner");
    const req = upsertItem(app, undefined, { spaceId: "personal", kind: "todo", title: "退款申请页改版" } as never, "user");
    setParent(app, req.id, line.id);
    const m = defineMetric(app, { name: "退款接口报错率", unit: "%", query: "前端监控：/refund/apply 的接口失败率", itemId: req.id, direction: "down-good" });
    defineMetric(app, { name: "omem 运行数", unit: "次", source: "omem", query: "omem 自己按天存" });
    // Points into a matter made a minute ago: no first-nudge grace for a change in the numbers.
    for (const [i, v] of [0.4, 0.42, 0.39, 0.41].entries()) await recordPoints(app, m.id, [{ value: v, at: new Date(Date.now() - (5 - i) * 86400_000).toISOString() }]);
    await expect(recordPoints(app, m.id, [{ value: 0.9 }])).resolves.toBeTruthy();
    expect(one(app.db, "select link from notifications where title like '%退款接口报错率%'")).toMatchObject({ link: `#/work/${req.id}` });
    writeWorkFile(app, { spaceId: "personal", path: "数据/数据源目录.md", title: "数据源目录", text: "# 目录" });
    writeWorkFile(app, { spaceId: "personal", path: "观测/退款改造.md", title: "退款改造", text: "# 计划", links: { item: line.id } });
    const { startServer } = await import("../src/server/http.ts");
    const server = await startServer(app, { port: 0, quiet: true });
    try {
      const list = (await server.inject({ method: "GET", url: "/api/metrics" })).json() as { name: string; itemTitle: string | null; lineId: string | null; lineTitle: string | null; source: string }[];
      expect(list.find((x) => x.name === "退款接口报错率")).toMatchObject({ itemTitle: "退款申请页改版", lineId: line.id, lineTitle: "示例商城 · 退款改造" });
      expect(list.find((x) => x.name === "omem 运行数")).toMatchObject({ source: "omem", lineId: null });
      const files = (await server.inject({ method: "GET", url: "/api/metrics/files" })).json() as { path: string; kind: string; itemId: string | null }[];
      expect(files.map((f) => [f.path, f.kind]).sort()).toEqual([["数据/数据源目录.md", "catalog"], ["观测/退款改造.md", "plan"]]);
      expect(files.find((f) => f.kind === "plan")?.itemId).toBe(line.id);
    } finally {
      await server.close();
    }
  });
});
