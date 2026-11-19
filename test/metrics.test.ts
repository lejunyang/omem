import { describe, expect, it } from "vitest";
import { createRun, listRuns } from "../src/agents/runs.ts";
import { threadMessages } from "../src/agents/threads.ts";
import { callTool, issueToolToken, toolContextForToken } from "../src/agents/tools.ts";
import { all, one, run } from "../src/core/db.ts";
import { saveContext } from "../src/channels/listen.ts";
import { collectDue, defineMetric, metricPoints, readMetric, recordPoints } from "../src/data/metrics.ts";
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
