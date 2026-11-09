import { describe, expect, it } from "vitest";
import { dreamSince, dreamStockBatch } from "../src/agents/jobs.ts";
import { createRun } from "../src/agents/runs.ts";
import { run } from "../src/core/db.ts";
import { CATCH_UP_WITHIN_MS, catchUpSchedules, ensureDefaultSchedules, listSchedules, registerScheduleKind, upsertSchedule } from "../src/core/scheduler.ts";
import { digestExperienceCount, digestMergeGroups, digestMergeText } from "../src/memory/digest-merge.ts";
import { upsertSource } from "../src/sources/store.ts";
import { testApp } from "./helpers.ts";

const vec = (...xs: number[]) => {
  const v = new Float32Array(xs);
  const n = Math.hypot(...xs) || 1;
  return new Uint8Array(v.map((x) => x / n).buffer);
};

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
