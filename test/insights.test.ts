import { afterEach, expect, it } from "vitest";
import { readFileSync, rmSync } from "node:fs";
import { all, run } from "../src/core/db.ts";
import { createSpace } from "../src/core/spaces.ts";
import { addMember, createUser, removeMember } from "../src/core/users.ts";
import { sceneOf, scenes, sceneTable } from "../src/insights/scenes.ts";
import { clearInsightsCache, DAILY_SQL, exportInsights, insightRecords, insights, normalizeFilters, type Filters } from "../src/insights/insights.ts";
import { testApp } from "./helpers.ts";
import { upsertItem } from "../src/items/store.ts";

const apps: ReturnType<typeof testApp>[] = [];
afterEach(() => { for (const a of apps.splice(0)) { a.db.close(); rmSync(a.home, { recursive: true, force: true }); } });
function setup() { const a = testApp(); a.config.timezone = "Asia/Tokyo"; apps.push(a); return a; }
const filters: Filters = { from: "2026-11-01", to: "2026-11-15" };
let n = 0;
function seed(a: ReturnType<typeof setup>, kind = "ask", opts: { id?: string; at?: string; user?: string; space?: string; by?: string; via?: string; status?: string; seconds?: number; input?: object; output?: object; quiet?: boolean; place?: string; ai?: object; roles?: string } = {}) {
  const id = opts.id ?? `insight-${++n}`, at = opts.at ?? "2026-11-05T02:00:00.000Z";
  run(a.db, `insert into runs(id,kind,created_at,started_at,finished_at,status,space_id,user_id,trigger_by,trigger,input,output,quiet,ai,roles) values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, kind, at, at, new Date(Date.parse(at) + (opts.seconds ?? 60) * 1000).toISOString(), opts.status ?? "done", opts.space ?? "personal", opts.user ?? null, opts.by ?? null,
    JSON.stringify({ via: opts.via ?? (kind === "guest" ? "guest" : "chat"), where: opts.place ?? "示例会话", by: opts.by ? { key: opts.by, name: "示例身份" } : undefined }), JSON.stringify(opts.input ?? {}), JSON.stringify(opts.output ?? {}), opts.quiet ? 1 : 0, JSON.stringify(opts.ai ?? { profile: "test-backend", model: "model-a" }), opts.roles ?? null);
  clearInsightsCache(a); return id;
}
function report(a: ReturnType<typeof setup>, f: Filters = {}, viewer = "owner") { return insights(a, viewer, { ...filters, ...f }); }
function metric(a: ReturnType<typeof setup>, key: string, f: Filters = {}, viewer = "owner") { const r = report(a, f, viewer); expect(r.sections.filter(s => s.error)).toEqual([]); return r.sections.flatMap(s => s.metrics).find(m => m.key === key)!; }
function sample(a: ReturnType<typeof setup>, id: string, decision: string | null = null, delay?: number, handle?: string) {
  run(a.db, `insert into reply_samples(id,handle_run,channel,chat_id,chat_kind,ask,last_ms,created_at,decision,owner_reply_at) values(?,?,?,?,?,?,?,?,?,?)`, id, handle ?? null, "lark", "chat-a", "group", "不应返回的本人问题正文", Date.parse("2026-11-05T02:00:00Z"), "2026-11-05T02:00:00.000Z", decision, delay === undefined ? null : new Date(Date.parse("2026-11-05T02:00:00Z") + delay * 1000).toISOString());
  clearInsightsCache(a);
}
function study(a: ReturnType<typeof setup>, space = "personal") {
  const item = upsertItem(a, undefined, { spaceId: space, title: "示例商城课题", kind: "watch" }, "user");
  const at = "2026-11-05T02:00:00.000Z", d = `d-${item.id}`;
  run(a.db, "insert into study_directions(id,item_id,round,goal,approach,acceptance,state,created_at,updated_at) values(?,?,1,'核验退款','逐项验证','可复现','done',?,?)", d, item.id, at, at);
  for (const [i, result] of ["passed", "failed", "blocked", "unclear"].entries()) {
    const rid = i === 3 ? null : seed(a, "study-trial", { space, input: { itemId: item.id }, at: i === 0 ? "2026-10-31T02:00:00.000Z" : at });
    run(a.db, `insert into study_trials(id,item_id,direction_id,round,seq,object,"check",state,result,run_id,created_at,updated_at) values(?,?,?,1,?,'退款','核验','reported',?,?,?,?)`, `t-${item.id}-${i}`, item.id, d, i, result, rid, "2026-10-31T02:00:00.000Z", at);
  }
  for (const [i, state] of ["new", "confirmed", "rejected", "later", "duplicate"].entries())
    run(a.db, "insert into study_findings(id,item_id,kind,title,repro,trials,state,created_at,updated_at) values(?,?,'defect',?,'复现步骤','[]',?,?,?)", `f-${item.id}-${i}`, item.id, `发现 ${i}`, state, at, at);
  run(a.db, "insert into study_findings(id,item_id,kind,title,repro,trials,state,created_at,updated_at) values(?,?,'defect','旧发现刚判定','复现步骤','[]','confirmed','2026-10-31T02:00:00.000Z',?)", `old-${item.id}`, item.id, at);
  run(a.db, "insert into study_directions(id,item_id,round,goal,approach,acceptance,state,created_at,updated_at) values(?,?,1,'核验通知','逐项验证','可复现','dropped',?,?)", `drop-${item.id}`, item.id, at, at);
  clearInsightsCache(a);
  return item;
}
it("课题只数期间台账，结果表、事项与运行明细、模型次数和导出可核对", () => {
  const a = setup(), item = study(a);
  seed(a, "study-trial", { input: { itemId: item.id }, ai: { model: "model-b" } });
  const s = report(a).sections.find(s => s.id === "study")!;
  expect(report(a).sections.map(s => s.id).slice(5, 8)).toEqual(["delivery", "study", "knowledge"]);
  expect(s.description).toContain("发现多少不代表做得好坏");
  for (const [key, value] of Object.entries({ trials: 4, findings: 5, "findings:confirmed": 1, "findings:rejected": 1, "findings:pending": 2, directions: 2, "directions:done": 1, "directions:dropped": 1, "model:model-a": 2, "model:model-b": 1 }))
    expect(metric(a, `study:${key}`).value).toBe(value);
  for (const result of ["passed", "failed", "blocked", "unclear"]) {
    const m = metric(a, `study:result:${item.id}:${result}`);
    expect(m.value).toBe(1); expect(m.cell).toMatchObject({ table: "试验结果", row: item.title });
  }
  expect(insightRecords(a, "owner", filters, "study:trials").records.map(r => r.link)).toEqual([expect.stringMatching(/^#\/runs\//), expect.stringMatching(/^#\/runs\//), expect.stringMatching(/^#\/runs\//), `#/items/${item.id}`]);
  for (const m of s.metrics) expect(insightRecords(a, "owner", filters, m.key).total).toBe(m.value);
  expect(insightRecords(a, "owner", filters, "study:findings").records.every(r => r.link === `#/items/${item.id}`)).toBe(true);
  expect(insightRecords(a, "owner", filters, "study:directions").records.every(r => r.link === `#/items/${item.id}`)).toBe(true);
  expect(exportInsights(a, "owner", filters, "md")).toContain("## 课题");
  expect(exportInsights(a, "owner", filters, "csv")).toContain('"课题","试验数","4"');
  const specific = report(a, { model: "model-a" }).sections.find(s => s.id === "study")!;
  expect(specific.metrics.find(m => m.key === "study:trials")?.value).toBe(3);
  expect(specific.metrics.some(m => m.key === "study:findings")).toBe(false);
});
it("课题按事项可读空间隔离，权限撤销后不复用缓存，没有已交试验就不出现", () => {
  const a = setup();
  expect(report(a).sections.some(s => s.id === "study")).toBe(false);
  const space = createSpace(a, { name: "共享课题" });
  const user = createUser(a, { name: "示例成员" });
  addMember(a, space.id, user.id, "reader");
  const item = study(a, space.id), hidden = study(a);
  expect(metric(a, "study:trials", {}, user.id).value).toBe(4);
  expect(JSON.stringify(report(a, {}, user.id))).not.toContain(hidden.id);
  expect(insightRecords(a, user.id, filters, "study:findings").records.every(r => r.link === `#/items/${item.id}`)).toBe(true);
  expect(report(a, { space: "personal" }, user.id).sections.some(s => s.id === "study")).toBe(false);
  removeMember(a, space.id, user.id);
  expect(report(a, {}, user.id).sections.some(s => s.id === "study")).toBe(false);
  expect(report(a, { from: "2026-11-10" }).sections.some(s => s.id === "study")).toBe(false);
  run(a.db, "update study_trials set result=null,state='queued'"); clearInsightsCache(a);
  expect(report(a).sections.some(s => s.id === "study")).toBe(false);
});
it("场景表精确覆盖 RunKind，新类型必须有场景", () => {
  const source = readFileSync(new URL("../src/agents/runs.ts", import.meta.url), "utf8");
  const kinds = [...source.match(/export type RunKind = ([^;]+);/)![1].matchAll(/"([^"]+)"/g)].map(m => m[1]);
  expect(Object.keys(sceneTable).sort()).toEqual(kinds.sort());
  expect(sceneOf({ kind: "agent", spec: "wiki-writer" })).toBe("文档与知识");
  expect(sceneOf({ kind: "agent", spec: "custom" })).toBe("排查");
  expect(sceneOf({ kind: "agent", via: "mention" })).toBe("提醒与跟进");
  expect(sceneOf({ kind: "agent", roles: "|meeting-assistant|" })).toBe("会议");
  expect(scenes).toContain("其他");
});
it("定时的空转不算使用：安静结束的巡检、唤醒归后台，提醒了人的才算提醒与跟进", () => {
  for (const kind of ["heartbeat", "wake", "item-settle", "work-state"]) {
    expect(sceneOf({ kind, quiet: 1 })).toBe("整理（后台）");
    expect(sceneOf({ kind, quiet: 0 })).toBe("提醒与跟进");
  }
  // A quiet answer or handling is still someone's request.
  expect(sceneOf({ kind: "ask", quiet: 1 })).toBe("问答");
  expect(sceneOf({ kind: "mention", quiet: 1 })).toBe("提醒与跟进");
});

it("每个板块有明确空状态，不用零冒充结果", () => {
  const r = report(setup()); expect(r.sections).toHaveLength(8);
  for (const s of r.sections) { expect(s.empty).toBeTruthy(); expect(s.error).toBeUndefined(); expect(s.metrics).toEqual([]); }
});
it("用量按本地天分场景、周内身份去重，整理单列且不进入成功率", () => {
  const a = setup();
  seed(a, "ask", { by: "user:owner", at: "2026-11-04T16:00:00.000Z" });
  seed(a, "ask", { by: "user:owner", status: "failed" }); seed(a, "ingest", { status: "failed" });
  seed(a, "guest", { by: "bot:example", output: { verdict: "answer" } });
  seed(a, "agent", { by: "user:member-a", status: "cancelled" });
  expect(metric(a, "usage:total").value).toBe(4); expect(metric(a, "usage:upkeep").value).toBe(1);
  expect(metric(a, "usage:success").value).toBe(66.7);
  expect(metric(a, "usage:total", { housekeeping: true }).value).toBe(5);
  expect(metric(a, "usage:success", { housekeeping: true }).value).toBe(66.7);
  expect(metric(a, "usage:week:2026-11-02:0").value).toBe(1);
  expect(metric(a, "usage:week:2026-11-02:1").value).toBe(1);
  const chart = report(a).sections[0].charts[0]; const i = chart.labels.indexOf("2026-11-05");
  expect(chart.series.find(s => s.name === "问答")!.values[i]).toBe(3);
});
it("覆盖按场景、空间、档案、会话计数，过滤器可组合", () => {
  const a = setup(); seed(a, "agent", { input: { spec: "writer", lark: { bot: "example-bot" } }, place: "示例文档群", by: "user:owner" }); seed(a, "code");
  expect(metric(a, "coverage:scene:文档与知识").value).toBe(1);
  expect(metric(a, "coverage:space:personal").value).toBe(2);
  expect(metric(a, "coverage:profile:writer").value).toBe(1);
  expect(metric(a, "coverage:chat:示例文档群").value).toBe(1);
  expect(metric(a, "usage:total", { profile: "writer", bot: "example-bot", by: "user:owner", scene: "文档与知识", model: "model-a", chat: "示例文档群" }).value).toBe(1);
});
it("有人找你漏斗区分预筛、分诊、代查、代答、通知反应和等待重试", () => {
  const a = setup();
  seed(a, "mention", { quiet: true }); seed(a, "mention", { quiet: true, input: { waited: 1 } });
  seed(a, "mention", { output: { triage: { action: "ignore" } } });
  const handle = seed(a, "agent", { via: "mention" });
  const source = seed(a, "mention", { via: "mention", output: { triage: { action: "handle" }, handleRun: handle } });
  sample(a, source, "sent", undefined, handle);
  run(a.db, "insert into notifications(id,at,title,body,context,user_id,outcome) values(?,?,?,?,?,?,?)", "notice-a", "2026-11-05T03:00:00.000Z", "不返回的标题", "不返回的通知正文", JSON.stringify({ runId: handle }), "owner", "acted");
  clearInsightsCache(a);
  expect(metric(a, "shield:reached").value).toBe(3); expect(metric(a, "shield:screened").value).toBe(1);
  expect(metric(a, "shield:triaged").value).toBe(2); expect(metric(a, "shield:handled").value).toBe(1);
  expect(metric(a, "shield:delivered").value).toBe(1); expect(metric(a, "shield:answered").value).toBe(1);
  expect(metric(a, "shield:outcome:acted").value).toBe(1);
});
it("访客不足十个样本不画时间对比，拒答和忽略不算回答用时", () => {
  const a = setup(); seed(a, "guest", { by: "lark:example", seconds: 80, output: { verdict: "answer" } }); seed(a, "guest", { by: "lark:example", seconds: 5, output: { verdict: "ignore" } });
  expect(metric(a, "others:questions").value).toBe(2); expect(metric(a, "others:people").value).toBe(1);
  expect(metric(a, "others:median")).toMatchObject({ value: 80, samples: 1 });
  expect(report(a).sections.find(s => s.id === "others")!.charts.some(c => c.title.startsWith("已完成样本"))).toBe(false);
});
it("十个有效访客回答和十个本人样本才画基线条，计算中位数和P90", () => {
  const a = setup();
  for (let i = 1; i <= 10; i++) { seed(a, "guest", { by: "lark:example", seconds: i * 10, output: { verdict: "answer" } }); sample(a, seed(a, "mention"), null, i * 100); }
  expect(metric(a, "others:median").value).toBe(55); expect(metric(a, "others:p90").value).toBe(90); expect(metric(a, "others:owner").value).toBe(550);
  expect(report(a).sections.find(s => s.id === "others")!.charts[0].series[0].values).toEqual([55, 550]);
});
it("质量按有反馈的不同运行算率，草稿裁决不混入自动代答", () => {
  const a = setup(), first = seed(a), second = seed(a);
  for (const [i, runId, polarity] of [[1, first, "negative"], [2, first, "negative"], [3, second, "positive"]] as const) run(a.db, "insert into feedback(id,message_id,run_id,actor_id,actor_kind,emoji,polarity,at) values(?,?,?,?,?,?,?,?)", `f${i}`, `msg${i}`, runId, "example", "owner", "test", polarity, "2026-11-05T03:00:00.000Z");
  for (const decision of ["sent", "edited", "dropped", "auto"]) sample(a, seed(a, "mention"), decision);
  expect(metric(a, "quality:negative").value).toBe(2); expect(metric(a, "quality:negativeRate").value).toBe(50); expect(metric(a, "quality:draft:rate").value).toBe(33.3);
});
it("质量评审按check计采纳与拒绝，抽检排除未核完，复盘和决策不读材料", () => {
  const a = setup(), id = seed(a, "code");
  run(a.db, "insert into reviews(id,code_run_id,check_name,verdict,created_at) values(?,?,?,?,?)", "r1", id, "功能", "issues", "2026-11-05T03:00:00.000Z");
  for (const state of ["accepted", "rejected", "merged", "open"]) run(a.db, "insert into review_findings(review_id,severity,title,state) values(?,?,?,?)", "r1", "normal", "不返回问题正文", state);
  for (const [i, verdict] of ["ok", "style", "wrong", "unchecked"].entries()) run(a.db, "insert into quality_audits(id,at,pipeline,space_id,target,written_at,audit_run,verdict) values(?,?,?,?,?,?,?,?)", `audit${i}`, "2026-11-05T03:00:00.000Z", "ingest", "personal", "page-a", "2026-11-05T03:00:00.000Z", id, verdict);
  for (const [i, verdict] of ["win", "tie", "loss"].entries()) run(a.db, "insert into replays(id,signal,axis,as_of,base_run_id,at,verdict,variant) values(?,?,?,?,?,?,?,?)", `replay${i}`, "normal", "K1", "2026-11-05", id, "2026-11-05T03:00:00.000Z", verdict, JSON.stringify({ skillName: "example-skill" }));
  run(a.db, `insert into decisions(id,at,scene,"by",question,material,probabilities,choice,taken,threshold,label,ref) values(?,?,?,?,?,?,?,?,?,?,?,?)`, "d1", "2026-11-05T03:00:00.000Z", "triage", "test", "不返回问题", "不返回材料", "{}", "ignore", "notify", .6, "needed", id);
  expect(metric(a, "quality:check:功能:accepted").value).toBe(1); expect(metric(a, "quality:check:功能:rejected").value).toBe(1);
  expect(metric(a, "quality:audit:page").value).toBe(66.7); expect(metric(a, "quality:replay:win").value).toBe(1); expect(metric(a, "quality:lowered").value).toBe(1); expect(metric(a, "quality:misses").value).toBe(0);
  expect(metric(a, "knowledge:skill:example-skill:all").value).toBe(3);
});
it("交付按首轮合并后续轮次和状态，延迟以发起至应用计", () => {
  const a = setup(), root = seed(a, "code");
  seed(a, "code", { at: "2026-11-06T02:00:00.000Z", input: { continueFrom: root }, output: { verdict: "approved", appliedAt: "2026-11-06T02:00:00.000Z" } });
  seed(a, "code", { output: { discardedAt: "2026-11-07T02:00:00.000Z" } });
  expect(metric(a, "delivery:started").value).toBe(2); expect(metric(a, "delivery:approved").value).toBe(1); expect(metric(a, "delivery:applied").value).toBe(1); expect(metric(a, "delivery:discarded").value).toBe(1); expect(metric(a, "delivery:rounds").value).toBe(1.5); expect(metric(a, "delivery:time").value).toBe(24);
});
it("知识按purpose计召回与used引用率，没有阅读用途时说清楚", () => {
  const a = setup(), id = seed(a);
  for (const [purpose, used] of [["answer", 1], ["answer", 0], ["upkeep", 1]] as const) run(a.db, "insert into memory_recalls(memory_id,run_id,purpose,used,at) values(?,?,?,?,?)", "not-a-real-memory", id, purpose, used, "2026-11-05T03:00:00.000Z");
  run(a.db, "insert into page_reads(space_id,slug,day,n) values(?,?,?,?)", "personal", "page-a", "2026-11-05", 2);
  expect(metric(a, "knowledge:recall:answer").value).toBe(2); expect(metric(a, "knowledge:hit:answer").value).toBe(50); expect(metric(a, "knowledge:recall:upkeep").value).toBe(1);
  expect(metric(a, "knowledge:read").note).toContain("无法区分");
  expect(report(a, { by: "user:owner" }).sections.find(s => s.id === "knowledge")!.metrics.find(m => m.key === "knowledge:read")).toBeUndefined();
});
it("成本按后端、模型与场景计时，缺失AI独立列出，后台默认排除", () => {
  const a = setup(); seed(a, "ask", { seconds: 3600 }); seed(a, "ingest", { seconds: 7200 });
  expect(metric(a, "cost:backend:test-backend").value).toBe(1); expect(metric(a, "cost:backend:hours:test-backend").value).toBe(1);
  expect(metric(a, "cost:model:hours:model-a", { housekeeping: true }).value).toBe(3);
});
it("比较使用紧邻同跨度的本地日期，仅compare开启时有previous", () => {
  const a = setup(); seed(a); seed(a, "ask", { at: "2026-10-25T01:00:00.000Z" });
  expect(metric(a, "usage:total").previous).toBeUndefined(); expect(metric(a, "usage:total", { compare: true }).previous).toBe(1);
  expect(metric(a, "usage:total", { compare: "false" }).previous).toBeUndefined();
});
it("成员只见自己触发或拥有且有可读空间的运行，导出与明细不泄露访客正文", () => {
  const a = setup(); createUser(a, { id: "member-a", name: "示例成员" }); createSpace(a, { id: "shared", name: "示例共享空间" }); addMember(a, "shared", "member-a");
  seed(a, "ask", { space: "shared", by: "user:owner" }); seed(a, "ask", { user: "member-a", space: "shared", by: "user:member-a" }); seed(a, "ask", { user: "member-a", space: "personal" });
  seed(a, "guest", { space: "shared", by: "lark:example", input: { text: "绝不返回的访客正文" }, output: { answer: "绝不返回的访客答案", verdict: "answer" } });
  expect(metric(a, "usage:total", {}, "member-a").value).toBe(1);
  const member = report(a, {}, "member-a"); expect(member.options.people).toEqual(["user:member-a"]);
  const owner = report(a); const m = owner.sections.flatMap(s => s.metrics).find(m => m.key === "others:questions")!;
  const rows = insightRecords(a, "owner", filters, m.key);
  for (const serialized of [JSON.stringify(owner), JSON.stringify(member), JSON.stringify(rows), exportInsights(a, "owner", filters, "md"), exportInsights(a, "owner", filters, "csv")]) expect(serialized).not.toMatch(/绝不返回|不应返回|不返回的/);
  const root = seed(a, "code", { user: "member-a", space: "shared" });
  const hidden = seed(a, "code", { user: "owner", space: "personal", input: { continueFrom: root }, output: { appliedAt: "2026-11-06T02:00:00.000Z" } });
  expect(metric(a, "delivery:applied", {}, "member-a").value).toBe(0);
  expect(JSON.stringify(insightRecords(a, "member-a", filters, "delivery:rounds"))).not.toContain(hidden);
});
it("本地日期边界、DST、180天上限、无效日期与默认30天", () => {
  const a = setup(), f = normalizeFilters(a, filters);
  expect(f.start).toBe("2026-10-31T15:00:00.000Z"); expect(f.end).toBe("2026-11-15T15:00:00.000Z");
  expect(normalizeFilters(a).days).toBe(30);
  expect(() => normalizeFilters(a, { from: "2026-01-01", to: "2026-07-01" })).toThrow("180");
  expect(() => normalizeFilters(a, { from: "2026-02-30", to: "2026-03-01" })).toThrow("日期");
  expect(() => normalizeFilters(a, { from: "2026-11-16", to: "2026-11-15" })).toThrow("180");
  a.config.timezone = "America/New_York"; const dst = normalizeFilters(a, { from: "2026-11-01", to: "2026-11-01" });
  expect(Date.parse(dst.end) - Date.parse(dst.start)).toBe(25 * 3600_000);
});
it("Markdown逐板块成表、CSV转义公式，导出图表数据和空态", () => {
  const a = setup(); seed(a, "ask", { place: '=HYPERLINK("example")' });
  const md = exportInsights(a, "owner", filters, "md"), csv = exportInsights(a, "owner", filters, "csv");
  expect(md).toContain("## 用了多少"); expect(md).toContain("## 花了多少时间");
  expect(csv.startsWith("\uFEFF")).toBe(true); expect(csv).toContain('""example""'); expect(csv).toContain("图表数据");
  expect(md).toContain("还没有人直接问过机器人");
});
it("日聚合查询使用唯一的新覆盖索引，SQLite字节码不读runs表或解析JSON", () => {
  const a = setup(); seed(a);
  const plan = all<{ detail: string }>(a.db, `explain query plan ${DAILY_SQL}`, "2026-11-01", "2026-11-16");
  expect(plan.map(p => p.detail).join(" ")).toMatch(/USING (COVERING )?INDEX runs_insights/);
  const ops = all<{ opcode: string; p1: number; p2: number; p4: string | null }>(a.db, `explain ${DAILY_SQL}`, "2026-11-01", "2026-11-16");
  const tableCursor = ops.find(o => o.opcode === "OpenRead" && o.p4?.match(/^\d+$/))?.p1;
  expect(ops.filter(o => o.opcode === "Function")).toEqual([]);
  expect(ops.filter(o => o.opcode === "Column" && o.p1 === tableCursor)).toEqual([]);
});
it("短时缓存复用同筛选结果，权限变更立即失效，单一板块错误不清空页面", () => {
  const a = setup(); seed(a); const first = report(a); expect(report(a)).toBe(first);
  createUser(a, { id: "member-b", name: "示例成员" }); createSpace(a, { id: "shared", name: "示例共享空间" }); addMember(a, "shared", "member-b");
  seed(a, "ask", { user: "member-b", space: "shared" });
  expect(metric(a, "usage:total", {}, "member-b").value).toBe(1);
  removeMember(a, "shared", "member-b");
  expect(report(a, {}, "member-b").sections[0].empty).toBeTruthy();
  a.db.exec("drop table review_findings"); clearInsightsCache(a);
  const r = report(a); expect(r.sections.find(s => s.id === "quality")!.error).toBeTruthy(); expect(r.sections[0].metrics[0].value).toBe(2);
});
