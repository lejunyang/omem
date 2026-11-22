import { describe, expect, it } from "vitest";
import { createRun, listRuns, runAis } from "../src/agents/runs.ts";
import { run } from "../src/core/db.ts";
import { testApp } from "./helpers.ts";

describe("runs by backend and model", () => {
  it("lists the backends and models of recent runs and filters by them", () => {
    const app = testApp();
    const a = createRun(app, { kind: "ingest", title: "整理 A" });
    const b = createRun(app, { kind: "ingest", title: "整理 B" });
    const c = createRun(app, { kind: "ingest", title: "整理 C" });
    const old = createRun(app, { kind: "ingest", title: "更早的" });
    const d = createRun(app, { kind: "ingest", title: "整理 D" });
    run(app.db, "update runs set ai = ? where id = ?", JSON.stringify({ profile: "codex", model: "model-a", effort: "high" }), a.id);
    run(app.db, "update runs set ai = ? where id = ?", JSON.stringify({ profile: "codex", model: "model-b" }), b.id);
    run(app.db, "update runs set ai = ? where id = ?", JSON.stringify({ profile: "codex", model: "model-a" }), d.id);
    run(app.db, "update runs set ai = ? where id = ?", JSON.stringify({ profile: "claude" }), c.id);
    // An older run recorded only the profile it was queued with.
    run(app.db, "update runs set profile_id = 'claude' where id = ?", old.id);

    expect(runAis(app)).toEqual([
      { profile: "codex", runs: 3, models: [{ model: "model-a", runs: 2 }, { model: "model-b", runs: 1 }] },
      { profile: "claude", runs: 2, models: [] },
    ]);
    expect(listRuns(app, { ai: "codex" }).map((r) => r.id).sort()).toEqual([a.id, b.id, d.id].sort());
    expect(listRuns(app, { ai: "codex", model: "model-b" }).map((r) => r.id)).toEqual([b.id]);
    expect(listRuns(app, { ai: "claude" }).map((r) => r.id).sort()).toEqual([c.id, old.id].sort());
  });
});
