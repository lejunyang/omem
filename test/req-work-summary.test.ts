import { describe, expect, it, vi } from "vitest";
import { createRun, setRunOutput } from "../src/agents/runs.ts";
import { addMaterials } from "../src/items/materials.ts";
import { itemWork } from "../src/items/work.ts";
import { upsertItem } from "../src/items/store.ts";
import { run } from "../src/core/db.ts";
import { OWNER } from "../src/core/users.ts";
import { testApp } from "./helpers.ts";

describe("coding summaries for requirements", () => {
  it("loads many rounds with large patches in bounded queries and without returning their bodies to JavaScript", () => {
    const app = testApp();
    try {
      const item = upsertItem(app, undefined, { spaceId: "personal", kind: "todo", title: "退款改造", userId: OWNER }, "user");
      const patch = "+退款明细\n".repeat(30_000);
      for (let i = 0; i < 12; i++) {
        const root = createRun(app, { kind: "code", spaceId: "personal", title: `退款项 ${i}`, input: { task: patch, fromBranches: { repo: `feature/refund-${i}` } } });
        setRunOutput(app, root.id, { patches: [{ patch }], coderSummary: patch, worktrees: [{ space: "personal", path: "work", commits: true, branch: "work" }] });
        const round = createRun(app, { kind: "code", spaceId: "personal", title: `复验 ${i}`, input: { continueFrom: root.id, task: patch, round: 2 } });
        setRunOutput(app, round.id, { patches: [{ patch }], verdict: "approved", repos: [{ check: { output: patch } }] });
        run(app.db, "update runs set status = 'done' where id in (?, ?)", root.id, round.id);
        addMaterials(app, item.id, [{ kind: "run", ref: root.id }, { kind: "run", ref: round.id }], OWNER, "user");
      }
      const prepare = app.db.prepare.bind(app.db);
      let largestResult = 0;
      const spy = vi.spyOn(app.db, "prepare").mockImplementation((sql) => {
        const stmt = prepare(sql);
        return new Proxy(stmt, {
          get(target, key) {
            const value = Reflect.get(target, key, target);
            if (key === "all" || key === "get") return (...args: unknown[]) => {
              const rows = value.apply(target, args);
              largestResult = Math.max(largestResult, JSON.stringify(rows)?.length ?? 0);
              return rows;
            };
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      });
      try {
        const works = itemWork(app, item);
        expect(works).toHaveLength(12);
        expect(works.every((w) => w.rounds.length === 2 && w.verdict === "approved" && w.branchWork && w.stage === "owner")).toBe(true);
        expect(new Set(works.map((w) => w.branch)).size).toBe(12);
        expect(spy.mock.calls.length).toBeLessThanOrEqual(6);
        expect(largestResult).toBeLessThan(32_000);
      } finally { spy.mockRestore(); }
    } finally { app.db.close(); }
  });

  it("keeps legacy worktrees, older application records and review stages in the summary", () => {
    const app = testApp();
    try {
      const item = upsertItem(app, undefined, { spaceId: "personal", kind: "todo", title: "退款验收", userId: OWNER }, "user");
      const root = createRun(app, { kind: "code", spaceId: "personal", title: "旧交办", input: {} });
      setRunOutput(app, root.id, { worktree: "legacy-work", branch: "feature/refund", base: "main" });
      const round = createRun(app, { kind: "code", spaceId: "personal", title: "复验", input: { continueFrom: root.id } });
      run(app.db, "update runs set status = 'done' where id in (?, ?)", root.id, round.id);
      addMaterials(app, item.id, [{ kind: "run", ref: round.id }], OWNER, "user");
      expect(itemWork(app, item)[0]).toMatchObject({ branch: "feature/refund", branchWork: false, stage: "owner", rounds: [root.id, round.id] });
      const review = createRun(app, { kind: "review", spaceId: "personal", title: "评审", input: {}, parentId: round.id });
      expect(itemWork(app, item)[0].stage).toBe("reviewing");
      run(app.db, "update runs set status = 'done' where id = ?", review.id);
      setRunOutput(app, root.id, { appliedAt: "2026-10-01T00:00:00Z" });
      expect(itemWork(app, item)[0].stage).toBe("applied");
    } finally { app.db.close(); }
  });
});
