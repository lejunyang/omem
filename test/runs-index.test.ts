import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { App } from "../src/core/app.ts";
import { migrations } from "../src/core/db.ts";
import { ensurePersonalSpace } from "../src/core/spaces.ts";
import { codeChainRounds } from "../src/agents/code-chain.ts";
import { lastRound } from "../src/agents/code-tasks.ts";
import { createRun } from "../src/agents/runs.ts";

// The shapes the coding loop uses (code-tasks.ts lastRound, code-loop.ts advanceWork and the split
// check, code-branch.ts rounds, code-chain.ts codeChainRounds).
const SHAPES = [
  "select id from runs where kind = 'code' and (id = ? or json_extract(input, '$.continueFrom') = ?) order by created_at desc limit 1",
  "select output from runs where kind = 'code' and (id = ? or json_extract(input, '$.continueFrom') = ?)",
  "select 1 from runs where (id = ? or json_extract(input, '$.continueFrom') = ?) and json_extract(output, '$.changePoints') is not null",
  "select id, status from runs where id = ? or (kind = 'code' and json_extract(input, '$.continueFrom') = ?) order by created_at",
  "select x.id from runs x where json_extract(x.input, '$.continueFrom') = ?",
  "select id from runs where parent_id = ? order by created_at",
];

it("upgrades existing libraries so a delegation's rounds and a chain's runs are found by index", () => {
  const home = mkdtempSync(join(tmpdir(), "omem-runs-index-"));
  const old = new DatabaseSync(join(home, "omem.db"));
  for (const migration of migrations.slice(0, -1)) old.exec(migration);
  old.exec(`pragma user_version=${migrations.length - 1}`);
  old.close();
  const app = App.open(home);
  try {
    ensurePersonalSpace(app);
    const ask = createRun(app, { kind: "ask", spaceId: "personal", title: "交办", input: {} });
    const root = createRun(app, { kind: "code", spaceId: "personal", title: "退款", input: { task: "退款", round: 1 }, parentId: ask.id });
    const second = createRun(app, { kind: "code", spaceId: "personal", title: "第 2 轮", input: { task: "退款", round: 2, continueFrom: root.id }, parentId: ask.id });
    createRun(app, { kind: "review", spaceId: "personal", title: "评审", input: { codeRunId: second.id }, parentId: second.id });
    const other = createRun(app, { kind: "code", spaceId: "personal", title: "另一次", input: { task: "别的" } });
    createRun(app, { kind: "code", spaceId: "personal", title: "另一次第 2 轮", input: { task: "别的", continueFrom: other.id } });
    for (const sql of SHAPES) {
      const args = sql.split("?").length - 1 === 2 ? [root.id, root.id] : [root.id];
      const plan = app.db.prepare(`explain query plan ${sql}`).all(...args).map((row) => String(row.detail));
      expect(plan.some((d) => d.includes("SCAN runs") || d.includes("SCAN x")), `${sql}\n${plan.join("\n")}`).toBe(false);
      expect(plan.some((d) => d.includes("runs_continue_from") || d.includes("runs_parent")), sql).toBe(true);
    }
    // Same answers as before: the last round of this delegation only, and the chain's code runs in order.
    expect(lastRound(app, root.id).id).toBe(second.id);
    expect(lastRound(app, other.id).title).toBe("另一次第 2 轮");
    expect(codeChainRounds(app, ask.id).map((r) => r.id)).toEqual([root.id, second.id]);
  } finally {
    app.db.close();
    rmSync(home, { recursive: true, force: true });
  }
});
