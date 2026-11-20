import { afterEach, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { run } from "../src/core/db.ts";
import { createSpace } from "../src/core/spaces.ts";
import { addMember, createUser } from "../src/core/users.ts";
import { clearInsightsCache, insightBreakdown, insightRecords, type Filters } from "../src/insights/insights.ts";
import { testApp } from "./helpers.ts";

const apps: ReturnType<typeof testApp>[] = [];
afterEach(() => { for (const a of apps.splice(0)) { a.db.close(); rmSync(a.home, { recursive: true, force: true }); } });
function setup() { const a = testApp(); a.config.timezone = "Asia/Tokyo"; apps.push(a); return a; }
const filters: Filters = { from: "2026-11-01", to: "2026-11-15" };
let n = 0;
function seed(a: ReturnType<typeof setup>, kind = "ask", opts: { at?: string; user?: string; space?: string; by?: string; status?: string; seconds?: number; place?: string; model?: string; output?: object } = {}) {
  const id = `bd-${++n}`, at = opts.at ?? "2026-11-05T02:00:00.000Z";
  run(a.db, `insert into runs(id,kind,created_at,started_at,finished_at,status,space_id,user_id,trigger_by,trigger,input,output,quiet,ai) values(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, kind, at, at, new Date(Date.parse(at) + (opts.seconds ?? 60) * 1000).toISOString(), opts.status ?? "done", opts.space ?? "personal", opts.user ?? null, opts.by ?? null,
    JSON.stringify({ via: kind === "guest" ? "guest" : "chat", where: opts.place ?? "示例会话" }), JSON.stringify({ question: "不应返回的提问正文" }), JSON.stringify(opts.output ?? {}), 0, JSON.stringify({ profile: "test-backend", model: opts.model ?? "model-a" }));
  clearInsightsCache(a);
  return id;
}

it("拆开一个数：按天、按维度，记录和明细同一套，带上谁触发、用时和结果", () => {
  const a = setup();
  seed(a, "ask", { by: "user:owner", at: "2026-11-03T02:00:00.000Z", seconds: 30 });
  seed(a, "ask", { by: "user:owner", at: "2026-11-05T02:00:00.000Z", model: "model-b", place: "示例群" });
  seed(a, "agent", { by: "user:member-a", at: "2026-11-05T03:00:00.000Z", status: "failed" });
  seed(a, "ask", { by: "user:owner", at: "2026-10-20T02:00:00.000Z" });
  const b = insightBreakdown(a, "owner", filters, "usage:total");
  expect(b).toMatchObject({ key: "usage:total", label: "做了多少件", value: 3, all: 3, total: 3, from: "2026-11-01", to: "2026-11-15" });
  // The same records as the record list.
  expect(b.records.map(r => r.id).sort()).toEqual(insightRecords(a, "owner", filters, "usage:total").records.map(r => r.id).sort());
  expect(b.daily!.labels).toHaveLength(15);
  expect(b.daily!.values.reduce((x, y) => x + y, 0)).toBe(3);
  expect(b.daily!.values[b.daily!.labels.indexOf("2026-11-05")]).toBe(2);
  // Only splits that say something: one space and one agent-less kind are left out.
  const dim = (key: string) => b.dims.find(d => d.key === key);
  expect(dim("space")).toBeUndefined();
  expect(dim("model")!.rows).toEqual([{ value: "model-a", label: "model-a", count: 2 }, { value: "model-b", label: "model-b", count: 1 }]);
  expect(dim("by")!.rows[0]).toEqual({ value: "user:owner", label: "你", count: 2 });
  expect(dim("status")!.rows.map(r => r.label)).toEqual(["做完", "失败"]);
  // Newest first, with who, how long and how it ended; never what was asked.
  expect(b.records[0]).toMatchObject({ by: "user:member-a", result: "失败" });
  expect(b.records.at(-1)).toMatchObject({ by: "你", seconds: 30, result: "做完" });
  expect(JSON.stringify(b)).not.toContain("不应返回的提问正文");
  // The period before (October 17–31) is counted for the comparison.
  expect(b.previous).toBe(1);
});

it("抽屉里的筛选和搜索只收窄记录和拆分，不改这个数", () => {
  const a = setup();
  seed(a, "ask", { model: "model-a" });
  seed(a, "ask", { model: "model-b" });
  seed(a, "code", { model: "model-b" });
  const b = insightBreakdown(a, "owner", filters, "usage:total", { picks: ["model:model-b"] });
  expect(b).toMatchObject({ value: 3, all: 3, total: 2 });
  expect(b.picks).toEqual([{ dim: "model", value: "model-b", label: "模型：model-b" }]);
  // A picked split stays (with its one group) so the pick can be seen and removed.
  expect(b.dims.find(d => d.key === "model")!.rows).toEqual([{ value: "model-b", label: "model-b", count: 2 }]);
  expect(b.dims.find(d => d.key === "scene")!.rows.map(r => r.count)).toEqual([1, 1]);
  const searched = insightBreakdown(a, "owner", filters, "usage:total", { picks: ["model:model-b"], q: "编码" });
  expect(searched.total).toBe(1);
  // Unknown splits are ignored, unknown numbers are a 404.
  expect(insightBreakdown(a, "owner", filters, "usage:total", { picks: ["nope:x", "model"] }).total).toBe(3);
  expect(() => insightBreakdown(a, "owner", filters, "usage:nope")).toThrow("没有这项统计的明细");
});

it("成员只看到自己触发的部分，通知按它所属的运行拆开", () => {
  const a = setup();
  const member = createUser(a, { name: "示例成员" });
  createSpace(a, { id: "shared", name: "示例共享空间" });
  addMember(a, "shared", member.id);
  seed(a, "ask", { user: member.id, by: `user:${member.id}`, space: "shared" });
  seed(a, "ask", { by: "user:owner", space: "shared" });
  const own = insightBreakdown(a, member.id, filters, "usage:total");
  expect(own.value).toBe(1);
  expect(own.records).toHaveLength(1);
  expect(own.dims.find(d => d.key === "by")).toBeUndefined();
  // A mention that ended in a notification: the notification's record splits by its run.
  const m = seed(a, "mention", { output: { triage: { action: "notify" } } });
  run(a.db, "insert into notifications(id,user_id,at,title,body,context,outcome) values(?,?,?,?,?,?,?)", "nt-1", "owner", "2026-11-05T02:10:00.000Z", "有人找你", "", JSON.stringify({ runId: m }), "acted");
  clearInsightsCache(a);
  const acted = insightBreakdown(a, "owner", filters, "shield:outcome:acted");
  expect(acted.records).toEqual([expect.objectContaining({ link: "#/notifications", run: m, result: "做完" })]);
});

it("一次读出这段时间的运行，记录里提到的段外运行分批补读，不逐条查库", () => {
  const a = setup();
  for (let i = 0; i < 40; i++) seed(a, "ask", { at: `2026-11-0${1 + (i % 9)}T02:00:00.000Z` });
  const queries: string[] = [];
  const prepare = a.db.prepare.bind(a.db);
  (a.db as { prepare: typeof a.db.prepare }).prepare = ((sql: string) => { queries.push(sql); return prepare(sql); }) as typeof a.db.prepare;
  insightBreakdown(a, "owner", filters, "usage:total");
  const before = queries.length;
  insightBreakdown(a, "owner", filters, "usage:total", { picks: ["scene:问答"] });
  // The second look is served from the report's cache: no query per record.
  expect(queries.length - before).toBeLessThan(5);
});
