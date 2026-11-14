import { describe, expect, it } from "vitest";
import { checkHistory, simplifyDue } from "../src/agents/code-loop.ts";
import { recordReview } from "../src/agents/review.ts";
import { createSpace } from "../src/core/spaces.ts";
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
    expect(simplifyDue(app, work, 39)).toBeNull();
    expect(simplifyDue(app, work, 40)).toContain("40 行");
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


describe("repository review history", () => {
  it("counts the last 30 days in repository spaces, excluding this work, unrelated spaces and non-code runs", () => {
    const app = testApp();
    try {
      createSpace(app, { id: "repo-a", name: "仓库 A", kind: "repo" });
      createSpace(app, { id: "repo-b", name: "仓库 B", kind: "repo" });
      const root = createRun(app, { kind: "code", spaceId: "repo-a", title: "本次", input: {} });
      const sample = (space: string, state: string, opts: { kind?: "code" | "ask"; days?: number; continueFrom?: string; id?: string } = {}) => {
        const r = opts.id ? { id: opts.id } : createRun(app, { kind: opts.kind ?? "code", spaceId: space, title: "改退款", input: { continueFrom: opts.continueFrom } });
        run(app.db, "update runs set created_at = ? where id = ?", new Date(Date.now() - (opts.days ?? 1) * 86400_000).toISOString(), r.id);
        const review = recordReview(app, { codeRunId: r.id, round: 1, check: "review-style", verdict: "changes_requested", summary: "检查", findings: [{ severity: "minor", title: "约定", detail: "", suggestion: "", evidence: [], confidence: "high" }] });
        run(app.db, "update review_findings set state = ? where review_id = ?", state, review);
      };
      sample("repo-a", "accepted");
      sample("repo-b", "rejected");
      sample("repo-a", "open");
      sample("repo-a", "accepted", { days: 31 });
      sample("personal", "accepted");
      sample("repo-a", "accepted", { kind: "ask" });
      sample("repo-a", "accepted", { id: root.id });
      sample("repo-a", "accepted", { continueFrom: root.id });
      expect(checkHistory(app, root.id, ["repo-a", "repo-b"]).get("review-style")).toEqual({ raised: 3, accepted: 1, rejected: 1 });
      expect(checkHistory(app, root.id).get("review-style")).toEqual({ raised: 2, accepted: 2, rejected: 0 });
      expect(checkHistory(app, root.id, [])).toEqual(new Map());
      const plan = app.db.prepare("explain query plan select r.check_name, f.state from runs x join reviews r on r.code_run_id = x.id join review_findings f on f.review_id = r.id where x.kind = 'code' and x.space_id in (?, ?) and x.created_at >= ? and x.id != ? and coalesce(json_extract(x.input, '$.continueFrom'), '') != ?").all("repo-a", "repo-b", new Date(Date.now() - 30 * 86400_000).toISOString(), root.id, root.id) as { detail: string }[];
      expect(plan.map((p) => p.detail).join("\n")).not.toMatch(/SCAN [rf]\b/);
      expect(plan.map((p) => p.detail).join("\n")).toContain("runs_code_history");
    } finally { app.db.close(); }
  });
});
