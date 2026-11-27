import { rmSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setKey } from "../src/core/ai-keys.ts";
import { all, one, run } from "../src/core/db.ts";
import { decisionReport, decisionReportText, replayDecisions } from "../src/core/decision-log.ts";
import { resetDecisionCooldownForTests, setDecisionFetchForTests } from "../src/core/decision.ts";
import { addRunEvent, createRun, setRunOutput } from "../src/agents/runs.ts";
import { routeGroups } from "../src/agents/route-groups.ts";
import { testApp } from "./helpers.ts";

let app: ReturnType<typeof testApp>;
beforeEach(() => {
  app = testApp();
  app.config.ai.providers = [{ id: "d", name: "测试", kind: "openai", backends: [] }];
  app.config.ai.decision.provider = "d";
  setKey(app.home, "d", "test-key");
});
afterEach(() => {
  vi.restoreAllMocks();
  resetDecisionCooldownForTests();
  setDecisionFetchForTests(null);
  app.db.close();
  rmSync(app.home, { recursive: true, force: true });
});

const options = {
  classId: "writing" as const, task: "撰写报告", conversation: false,
  groups: [{ id: "standard", name: "标准", items: [{}] }, { id: "strong", name: "强", items: [{ note: "适合长文" }] }, { id: "cheap", name: "省", items: [{}] }],
};
const defaultOrder = options.groups.map(g => g.id);
function answer(choice: string, probabilities: Record<string, number>) {
  const fetch = vi.fn(async (_url: unknown, _init?: RequestInit) => Response.json({ answers: [{ name: "q", type: "choice", choice,
    probabilities: Object.entries(probabilities).map(([value, probability]) => ({ value, probability })) }] }));
  setDecisionFetchForTests(fetch);
  return fetch;
}

it.each([
  { first: 0.54, second: 0.28, by: "static" },
  { first: 0.55, second: 0.401, by: "static" },
  { first: 0.55, second: 0.40, by: "decision" },
  { first: 0.71, second: 0.20, by: "decision" },
])("首选 $first、第二 $second，排序依据为 $by", async ({ first, second, by }) => {
  app.config.agents.routing.guidance = "长报告优先";
  const fetch = answer("strong", { strong: first, cheap: second, standard: 1 - first - second });
  const result = await routeGroups(app, { ...options, task: "文".repeat(1500) + "省略这段", runId: "r1" });
  expect(result.by).toBe(by);
  expect(result.order).toEqual(by === "static" ? defaultOrder : ["strong", "cheap", "standard"]);
  expect(result.reason).toContain("强 " + first.toFixed(2));
  const request = JSON.parse(String(fetch.mock.calls[0][1]!.body));
  expect(request.input[0].content[0].data).toEqual({ 类别: expect.stringContaining("写作"), 任务: "文".repeat(1500), 本人的总体偏好: "长报告优先" });
  expect(request.questions[0].choices).toEqual([{ value: "standard", description: "标准" }, { value: "strong", description: "强：适合长文" }, { value: "cheap", description: "省" }]);
  expect(one(app.db, 'select ref,choice,taken,threshold,"by" from decisions')).toMatchObject({ ref: "r1", choice: "strong", taken: result.order[0], threshold: 0.55, by: expect.stringContaining("测试") });
  expect(JSON.parse(one<{ route: string }>(app.db, "select route from decisions")!.route)).toEqual({ classId: "writing", defaultOrder, ...result });
});

it("提高门槛后回退；缺少第二名分数或模型选择了范围外的组也回退", async () => {
  app.config.ai.decision.thresholds!.route = 0.8;
  for (const [choice, p] of [
    ["strong", { strong: 0.79, cheap: 0.11, standard: 0.1 }],
    ["strong", { strong: 0.91 }],
    ["other", { other: 0.91, standard: 0.04, cheap: 0.03, strong: 0.02 }],
  ] as const) {
    answer(choice, p as Record<string, number>);
    expect(await routeGroups(app, options)).toMatchObject({ by: "static", order: defaultOrder });
  }
});

it("没有选择空间时跳过判断；服务限流或未配置时记录默认先后", async () => {
  const fetch = vi.fn(async () => new Response("", { status: 429 }));
  setDecisionFetchForTests(fetch);
  for (const count of [0, 1]) expect((await routeGroups(app, { ...options, groups: options.groups.slice(0, count) })).order).toEqual(defaultOrder.slice(0, count));
  expect(fetch).not.toHaveBeenCalled();
  app.config.ai.decision.others = [{ provider: "d", model: "other" }];
  expect(await routeGroups(app, options)).toMatchObject({ by: "static", order: defaultOrder, reason: expect.stringContaining("429") });
  app.config.ai.decision.others = [];
  app.config.ai.decision.provider = "";
  expect(await routeGroups(app, options)).toMatchObject({ by: "static", order: defaultOrder });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(all(app.db, "select id from decisions where taken='standard'")).toHaveLength(2);
});

it.each([[true, 8000], [false, 20000]] as const)("对话=%s 的整次判断限时 %i 毫秒", async (conversation, ms) => {
  const clock = new AbortController();
  const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(clock.signal);
  setDecisionFetchForTests(async () => new Promise<Response>(() => {}));
  const routing = routeGroups(app, { ...options, conversation });
  expect(timeout.mock.calls[0]).toEqual([ms]);
  clock.abort();
  expect(await routing).toMatchObject({ by: "static", order: defaultOrder, reason: expect.stringContaining("超时") });
});

it("按运行追踪五种结局和延迟反馈；按类别和实际采用方式比较已知结果", async () => {
  const runs: string[] = [];
  for (const [i, status] of ["done", "failed", "done", "cancelled", "done", "running"].entries()) {
    const ref = createRun(app, { kind: "ask", title: "示例任务" }).id;
    runs.push(ref);
    answer("standard", i < 3 ? { standard: 0.65, cheap: 0.20, strong: 0.15 } : { standard: 0.41, cheap: 0.35, strong: 0.24 });
    await routeGroups(app, { ...options, runId: ref, classId: i === 5 ? "chat" : "writing" });
    run(app.db, "update runs set status=? where id=?", status, ref);
  }
  addRunEvent(app, runs[2], "status", { failover: { from: "A", to: "B" } });
  setRunOutput(app, runs[3], { replacedBy: runs[5] });
  const rate = () => decisionReport(app).routes.find(r => r.classId === "writing")!;
  expect(rate().static.completed).toBe(1);
  const react = (actor: string) => run(app.db, `insert into feedback(id,message_id,actor_id,actor_kind,emoji,polarity,at,run_id)
    values(?,'reply','actor',?,'NO','negative','now',?)`, actor, actor, runs[4]);
  react("guest");
  expect(rate().static.completed).toBe(1);
  react("owner");
  expect(all<{ outcome: string | null }>(app.db, "select outcome from route_decision_outcomes order by at, ref").map(r => r.outcome))
    .toEqual(expect.arrayContaining(["completed", "failed", "replaced", "rerun", "negative", null]));
  expect(rate()).toMatchObject({ decision: { completed: 1, settled: 3 }, static: { completed: 0, settled: 2 } });
  expect(decisionReport(app).routes.find(r => r.classId === "chat")!.static).toEqual({ completed: 0, settled: 0, pending: 1 });
  run(app.db, "update feedback set removed_at=at where id='owner'");
  expect(decisionReportText(decisionReport(app))).toContain("写作完成率：采用模型的选择 33%（1/3），按默认先后 50%（1/2）");
  run(app.db, "update decisions set at='2000-01-01' where ref=?", runs[0]);
  expect(rate().decision).toMatchObject({ completed: 0, settled: 2 });
});

it("离线回放同样按当前门槛与差距比较采用的组", async () => {
  answer("strong", { standard: 0.40, strong: 0.56, cheap: 0.04 });
  await routeGroups(app, options);
  answer("strong", { standard: 0.41, strong: 0.55, cheap: 0.04 });
  expect(await replayDecisions(app, { scene: "route", model: "d:other" })).toMatchObject({ compared: 1, agreement: 1, takenAgreement: 0 });
});
