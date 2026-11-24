import { describe, expect, it, vi } from "vitest";
import { dreamSince, dreamStockBatch } from "../src/agents/jobs.ts";
import { createRun, __testHandlers } from "../src/agents/runs.ts";
import { one, run } from "../src/core/db.ts";
import { upsertItem } from "../src/items/store.ts";
import { loadRole } from "../src/agents/runner.ts";
import * as runner from "../src/agents/runner.ts";
import { studyBrief } from "../src/agents/study-brief.ts";
import { CATCH_UP_WITHIN_MS, catchUpSchedules, ensureDefaultSchedules, listSchedules, registerScheduleKind, upsertSchedule } from "../src/core/scheduler.ts";
import { digestExperienceCount, digestMergeGroups, digestMergeText } from "../src/memory/digest-merge.ts";
import { upsertSource } from "../src/sources/store.ts";
import { testApp } from "./helpers.ts";

const vec = (...xs: number[]) => {
  const v = new Float32Array(xs);
  const n = Math.hypot(...xs) || 1;
  return new Uint8Array(v.map((x) => x / n).buffer);
};

describe("daily brief study rounds", () => {
  const since = "2026-11-01T00:00:00.000Z", ended = "2026-11-02T00:00:00.000Z";
  function setup(study = true) {
    const app = testApp();
    const item = upsertItem(app, undefined, { spaceId: "personal", kind: "watch", title: "示例商城研究" }, "user");
    const definition = { id: "demo", name: "示例流程", stages: [{ id: "plan", name: "方向", by: { run: {} }, ...(study ? { tools: ["propose_directions"] } : {}) }] };
    run(app.db, "insert into item_flows(item_id,flow_id,definition,started_at,started_by,updated_at) values(?,'demo',?,'2026-10-30T00:00:00.000Z','owner',?)", item.id, JSON.stringify(definition), since);
    run(app.db, "insert into kv(key,value) values('brief_at',?)", since);
    const close = () => run(app.db, "insert into item_flow_rounds(item_id,started_at,round,ended_at,stages,updated_at) values(?,'2026-10-30T00:00:00.000Z',1,?,'[]',?)", item.id, ended, ended);
    const d = `d-${item.id}`;
    run(app.db, "insert into study_directions(id,item_id,round,goal,approach,acceptance,state,created_at,updated_at) values(?,?,1,'验证退款边界','逐项执行','结果可复现','done',?,?)", d, item.id, since, ended);
    run(app.db, "insert into study_directions(id,item_id,round,goal,approach,acceptance,state,created_at,updated_at) values(?,?,2,'下一轮目标','逐项执行','结果可复现','proposed',?,?)", `next-${d}`, item.id, ended, ended);
    for (const [i, result] of ["passed", "failed", "blocked", "unclear"].entries())
      run(app.db, `insert into study_trials(id,item_id,direction_id,round,seq,object,"check",result,state,created_at,updated_at) values(?,?,?,1,?,'退款','执行',?,'reported',?,?)`, `t-${i}`, item.id, d, i, result, since, ended);
    for (let i = 0; i < 7; i++)
      run(app.db, "insert into study_findings(id,item_id,kind,title,repro,trials,state,round,flow_started_at,created_at,updated_at) values(?,?,'defect',?,'复现步骤','[]',?,1,'2026-10-30T00:00:00.000Z',?,?)", `f-${i}`, item.id, `边界发现 ${i}`, i < 2 ? "confirmed" : i === 2 ? "rejected" : i === 3 ? "later" : "new", since, ended);
    return { app, item, close };
  }
  it("结束一轮才给简报事实，五条发现之后给余数；同一轮只进一次", async () => {
    const { app, item, close } = setup();
    const tasks: string[] = [];
    const fake = vi.spyOn(runner, "runRole").mockImplementation(async (_app, input) => {
      expect(input.role).toBe("brief");
      expect(loadRole("brief", app).tools).not.toContain("read_ledger");
      expect(input.addTools ?? []).not.toContain("read_ledger");
      tasks.push(input.task);
      return { text: "简报已完成", profileId: "fake", ai: { profile: "fake" } } as Awaited<ReturnType<typeof runner.runRole>>;
    });
    const brief = async () => {
      const r = createRun(app, { kind: "brief", title: "每日简报", spaceId: "personal" });
      return __testHandlers.get("brief")!({ app, run: r, signal: new AbortController().signal, event() {}, output() {} });
    };
    try {
      expect(studyBrief(app, since, ended)).toBe("");
      close(); await brief();
      const task = tasks[0];
      expect(task).toContain("## 上一轮的探索");
      expect(task).toContain(`[${item.title}](#/items/${item.id}) · 第 1 轮`);
      expect(task).toContain("方向（目标）：验证退款边界");
      expect(task).toContain("通过 1；没通过 1；跑不了 1；说不清 1");
      expect(task).toContain("边界发现 4；另有 2 条");
      expect(task).not.toContain("边界发现 5");
      expect(task).toContain("4 条发现还没判定（含以后再说）；有方向等着选");
      expect(one<{ value: string }>(app.db, "select value from kv where key='brief_at'")!.value > ended).toBe(true);
      await brief();
      expect(tasks[1]).not.toContain("上一轮的探索");
      expect(studyBrief(app, ended, ended)).toBe("");
    } finally { fake.mockRestore(); app.db.close(); }
  });
  it("没结束的轮次、非研究流程和其他本人的事项都不加入探索", () => {
    const f = setup(false);
    try {
      f.close(); expect(studyBrief(f.app, since, ended)).toBe("");
      run(f.app.db, "update item_flows set definition=?", JSON.stringify({ stages: [{ by: { object: "trials" } }] }));
      expect(studyBrief(f.app, since, ended)).toContain("上一轮的探索");
      run(f.app.db, "update items set user_id='other'");
      expect(studyBrief(f.app, since, ended)).toBe("");
    } finally { f.app.db.close(); }
  });
  it("简报生成失败不推进边界，期间结束的下一轮留给下一份", async () => {
    const { app, close } = setup(); close();
    const fake = vi.spyOn(runner, "runRole").mockRejectedValue(new Error("test failure"));
    try {
      const r = createRun(app, { kind: "brief", title: "每日简报", spaceId: "personal" });
      await expect(__testHandlers.get("brief")!({ app, run: r, signal: new AbortController().signal, event() {}, output() {} })).rejects.toThrow("test failure");
      expect(one<{ value: string }>(app.db, "select value from kv where key='brief_at'")!.value).toBe(since);
      expect(studyBrief(app, since, "2026-11-01T12:00:00.000Z")).toBe("");
      expect(studyBrief(app, since, ended)).toContain("第 1 轮");
    } finally { fake.mockRestore(); app.db.close(); }
  });
});

describe("nightly dream", () => {
  it("looks back a week the first time, then from the last dream", () => {
    const app = testApp();
    const first = Date.parse(dreamSince(app));
    expect(Math.abs(first - (Date.now() - 7 * 86400_000))).toBeLessThan(60_000);
    run(app.db, "insert into kv(key,value) values('dream_at', '2026-10-01T00:00:00.000Z')");
    expect(dreamSince(app)).toBe("2026-10-01T00:00:00.000Z");
  });

  it("is on for a new library and keeps an existing library's choice", () => {
    const app = testApp();
    ensureDefaultSchedules(app);
    expect(listSchedules(app).find((s) => s.id === "dream")!.enabled).toBe(true);
    run(app.db, "update schedules set enabled = 0 where id = 'dream'");
    ensureDefaultSchedules(app);
    expect(listSchedules(app).find((s) => s.id === "dream")!.enabled).toBe(false);
  });

  it("finds the bulk digest's experiences that say nearly the same, across originals, a few groups a night", () => {
    const app = testApp();
    const a = upsertSource(app, { spaceId: "personal", kind: "doc", uri: "a.md", title: "退款流程", text: "x" });
    const b = upsertSource(app, { spaceId: "personal", kind: "doc", uri: "b.md", title: "发布手册", text: "y" });
    const c = upsertSource(app, { spaceId: "personal", kind: "doc", uri: "c.md", title: "退款 FAQ", text: "z" });
    const digest = createRun(app, { kind: "digest", spaceId: "personal", title: "整理存量" });
    const ingest = createRun(app, { kind: "ingest", spaceId: "personal", title: "整理新材料" });
    let n = 0;
    const mem = (src: string, runId: string, embedding: Uint8Array | null, kind = "experience") =>
      run(
        app.db,
        "insert into memories(id, space_id, kind, content, source_refs, created_at, updated_at, run_id, embedding) values(?,?,?,?,?,?,?,?,?)",
        `m_${++n}`, "personal", kind, `经验 ${n}`, JSON.stringify([`src:${src}#L1`]), new Date(Date.now() + n).toISOString(), new Date().toISOString(), runId, embedding,
      );
    // Original a: three close, one far; original b: two close; an ingest one and a fact are left alone.
    mem(a.id, digest.id, vec(1, 0, 0));
    mem(a.id, digest.id, vec(0.98, 0.1, 0));
    mem(a.id, digest.id, vec(0.97, 0.05, 0.1));
    mem(a.id, digest.id, vec(0, 0, 1));
    mem(b.id, digest.id, vec(0, 1, 0));
    mem(b.id, digest.id, vec(0.05, 1, 0));
    mem(a.id, ingest.id, vec(1, 0, 0));
    mem(a.id, digest.id, vec(1, 0, 0), "fact");
    // Another original saying the same joins the first group.
    mem(c.id, digest.id, vec(0.99, 0, 0.05));
    expect(digestExperienceCount(app)).toBe(7);
    const groups = digestMergeGroups(app);
    expect(groups.map((g) => [g.sources.map((x) => x.title), g.memories.map((m) => m.id)])).toEqual([
      [["退款流程", "退款 FAQ"], ["m_1", "m_2", "m_3", "m_9"]],
      [["发布手册"], ["m_5", "m_6"]],
    ]);
    expect(digestMergeGroups(app, { groups: 1 })).toHaveLength(1);
    const text = digestMergeText(app);
    expect(text).toMatch(/还有 7 条有效/);
    expect(text).toMatch(/第 1 组（原件：src:.*「退款流程」、src:.*「退款 FAQ」）/);
    // Merged ones drop out; without vectors the same original is enough.
    run(app.db, "update memories set status = 'superseded' where id in ('m_2','m_3','m_6','m_9')");
    run(app.db, "update memories set embedding = null");
    expect(digestMergeGroups(app).map((g) => g.memories.map((m) => m.id))).toEqual([["m_1", "m_4"]]);
  });

  it("walks the older memories a batch a night and starts over after the newest", () => {
    const app = testApp();
    const since = "2026-11-01T00:00:00.000Z";
    for (let i = 1; i <= 5; i++)
      run(app.db, "insert into memories(id, space_id, kind, content, created_at, updated_at) values(?,?,?,?,?,?)", `m_${i}`, "personal", "fact", `事实 ${i}`, `2026-10-0${i}T00:00:00.000Z`, `2026-10-0${i}T00:00:00.000Z`);
    // Changed since the last dream: that night's own list has it, not the walk.
    run(app.db, "update memories set updated_at = '2026-11-02T00:00:00.000Z' where id = 'm_3'");
    run(app.db, "insert into memories(id, space_id, kind, content, status, created_at, updated_at) values('m_x','personal','fact','撤回的','retracted','2026-10-01T00:00:00.000Z','2026-10-01T00:00:00.000Z')");
    expect(dreamStockBatch(app, since, 2)).toEqual({ ids: ["m_1", "m_2"], total: 4 });
    expect(dreamStockBatch(app, since, 2).ids).toEqual(["m_4", "m_5"]);
    expect(dreamStockBatch(app, since, 2).ids).toEqual(["m_1", "m_2"]);
  });
});

describe("missed schedules", () => {
  it("makes up a daily task the timer missed, once, and leaves frequent, new and long-missed ones", () => {
    const app = testApp();
    app.config.timezone = "Asia/Shanghai";
    const fired: string[] = [];
    registerScheduleKind("test-nightly", (_app, s) => fired.push(s.id));
    upsertSchedule(app, { id: "nightly", kind: "test-nightly", cron: "30 3 * * *", enabled: true });
    upsertSchedule(app, { id: "often", kind: "test-nightly", cron: "*/10 * * * *", enabled: true });
    upsertSchedule(app, { id: "fresh", kind: "test-nightly", cron: "30 3 * * *", enabled: true });
    run(app.db, "update schedules set last_run_at = '2026-11-07T19:30:00.800Z' where id in ('nightly','often')");
    // 03:30 Shanghai on 11-09 is 19:30Z on 11-08. Within the timer's own minute and a half: left to it.
    expect(catchUpSchedules(app, new Date("2026-11-08T19:30:40Z"))).toEqual([]);
    expect(catchUpSchedules(app, new Date("2026-11-08T19:35:00Z"))).toEqual(["nightly"]);
    expect(fired).toEqual(["nightly"]);
    expect(catchUpSchedules(app, new Date("2026-11-08T19:36:00Z"))).toEqual([]);
    // Missed by more than CATCH_UP_WITHIN_MS: waits for the next night.
    run(app.db, "update schedules set last_run_at = '2026-11-07T19:30:00.800Z' where id = 'nightly'");
    expect(catchUpSchedules(app, new Date(Date.parse("2026-11-08T19:30:00Z") + CATCH_UP_WITHIN_MS + 60_000))).toEqual([]);
  });
});
