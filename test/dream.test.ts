import { describe, expect, it } from "vitest";
import { dreamSince } from "../src/agents/jobs.ts";
import { createRun } from "../src/agents/runs.ts";
import { run } from "../src/core/db.ts";
import { ensureDefaultSchedules, listSchedules } from "../src/core/scheduler.ts";
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

  it("finds the bulk digest's experiences from one original that say nearly the same, a few groups a night", () => {
    const app = testApp();
    const a = upsertSource(app, { spaceId: "personal", kind: "doc", uri: "a.md", title: "退款流程", text: "x" });
    const b = upsertSource(app, { spaceId: "personal", kind: "doc", uri: "b.md", title: "发布手册", text: "y" });
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
    expect(digestExperienceCount(app)).toBe(6);
    const groups = digestMergeGroups(app);
    expect(groups.map((g) => [g.title, g.memories.map((m) => m.id)])).toEqual([
      ["退款流程", ["m_1", "m_2", "m_3"]],
      ["发布手册", ["m_5", "m_6"]],
    ]);
    expect(digestMergeGroups(app, { groups: 1 })).toHaveLength(1);
    const text = digestMergeText(app);
    expect(text).toMatch(/还有 6 条有效/);
    expect(text).toMatch(/src:.*「退款流程」/);
    // Merged ones drop out; without vectors the same original is enough.
    run(app.db, "update memories set status = 'superseded' where id in ('m_2','m_3','m_6')");
    run(app.db, "update memories set embedding = null");
    expect(digestMergeGroups(app).map((g) => g.memories.map((m) => m.id))).toEqual([["m_1", "m_4"]]);
  });
});
