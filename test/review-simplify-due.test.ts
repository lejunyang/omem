import { describe, expect, it } from "vitest";
import { simplifyDue } from "../src/agents/code-loop.ts";
import { createRun } from "../src/agents/runs.ts";
import { run } from "../src/core/db.ts";
import { testApp } from "./helpers.ts";

/** When the host asks the simplify check to look at a stage of a delegation without being asked. */
describe("the simplify check looks where patching piles up", () => {
  const task = (app: ReturnType<typeof testApp>, work: string, seq: number, follows: number | null, at: string) =>
    run(app.db, "insert into code_tasks(work_id, seq, title, kind, origin, state, created_by, created_at, updated_at) values(?,?,?,?,?,?,?,?,?)", work, seq, `修改项 ${seq}`, follows ? "fix" : "build", JSON.stringify(follows ? { follows } : {}), "todo", "review-lead", at, at);
  const reviewed = (app: ReturnType<typeof testApp>, work: string, at: string) =>
    run(app.db, "insert into reviews(id, code_run_id, check_name, verdict, created_at) values(?,?,?,?,?)", `rv-${at}`, work, "review-simplify", "approve", at);

  it("looks once when the change has grown large, then again only after a fix lands on a fix", () => {
    const app = testApp();
    const work = createRun(app, { kind: "code", spaceId: "personal", title: "退款改造", input: { task: "退款只按已发货行计算" } }).id;
    task(app, work, 1, null, "2026-01-01T00:00:00.000Z");
    expect(simplifyDue(app, work, 120)).toBeNull();
    expect(simplifyDue(app, work, 260)).toContain("260 行");
    reviewed(app, work, "2026-01-02T00:00:00.000Z");
    // It has looked: size alone does not bring it back.
    expect(simplifyDue(app, work, 900)).toBeNull();
    // A fix of the first task: one layer, still nothing.
    task(app, work, 2, 1, "2026-01-03T00:00:00.000Z");
    expect(simplifyDue(app, work, 900)).toBeNull();
    // A fix of that fix: the spot is being patched over and over.
    task(app, work, 3, 2, "2026-01-04T00:00:00.000Z");
    expect(simplifyDue(app, work, 900)).toContain("T3");
    reviewed(app, work, "2026-01-05T00:00:00.000Z");
    expect(simplifyDue(app, work, 900)).toBeNull();
    app.db.close();
  });
});
