import { expect, it } from "vitest";
import { testApp } from "./helpers.ts";
import { createRun, setRunOutput } from "../src/agents/runs.ts";
import { startFix, workRuns } from "../src/agents/review-fix.ts";
import { run } from "../src/core/db.ts";

it("continues a standalone branch-review fix in the same workspace, preserving execution and rejecting duplicate clicks", async () => {
  const app = testApp();
  try {
    const review = createRun(app, { kind: "code", spaceId: "personal", title: "项目 A 评审", input: { branches: { "project-a": { branch: "feature/a" } }, repos: ["project-a"], reviewTier: "full", readSpaces: ["personal"] } });
    run(app.db, "update runs set status='done' where id=?", review.id);
    const first = await startFix(app, review.id, { findingIds: [], text: "修复边界条件" }, "owner");
    expect(first.parentId).toBeNull();
    setRunOutput(app, first.id, { worktrees: [{ space: "project-a", path: app.home, branch: "omem/example", base: "abc" }], coderSessionId: "session-one" });
    run(app.db, "update runs set status='done' where id=?", first.id);
    run(app.db, "update runs set input=json_set(input,'$.execution',json(?),'$.checks',json(?)) where id=?", JSON.stringify({ profile: "codex", model: "test-model" }), JSON.stringify({ "project-a": "npm test" }), first.id);
    const next = await startFix(app, first.id, { findingIds: [], text: "再处理空值" }, "owner");
    expect(next.input).toMatchObject({ continueFrom: first.id, resumeSessionId: "session-one", round: 2, repos: ["project-a"], fromReview: review.id, reviewTier: "full", readSpaces: ["personal"], checks: { "project-a": "npm test" }, execution: { profile: "codex", model: "test-model" } });
    await expect(startFix(app, first.id, { findingIds: [], text: "重复点击" }, "owner")).rejects.toThrow(/已有修改轮次/);
    run(app.db, "update runs set status='done' where id=?", next.id);
    setRunOutput(app, next.id, { coderSessionId: "session-two" });
    const third = await startFix(app, next.id, { findingIds: [], text: "第三轮" }, "owner");
    expect(third.input).toMatchObject({ continueFrom: first.id, resumeSessionId: "session-two", round: 3 });
    expect(workRuns(app, third.id)).toEqual([first.id, next.id, third.id]);
    run(app.db, "update runs set status='done' where id=?", third.id);
    setRunOutput(app, first.id, { appliedAt: new Date().toISOString() });
    await expect(startFix(app, third.id, { findingIds: [], text: "不能修改已释放工作区" }, "owner")).rejects.toThrow(/已应用或丢弃/);
  } finally { app.db.close(); }
});

it("does not recreate a missing standalone workspace", async () => {
  const app = testApp();
  try {
    const r = createRun(app, { kind: "code", spaceId: "personal", title: "项目 A 修改", input: { task: "修改" } });
    run(app.db, "update runs set status='done' where id=?", r.id);
    await expect(startFix(app, r.id, { findingIds: [], text: "继续" }, "owner")).rejects.toThrow(/原工作区缺失/);
    expect(workRuns(app, r.id)).toEqual([r.id]);
  } finally { app.db.close(); }
});
