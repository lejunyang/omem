import { describe, expect, it } from "vitest";
import { codeWork, listCodeWorks } from "../src/agents/code-works.ts";
import { addTask } from "../src/agents/code-tasks.ts";
import { createRun, listRuns, setRunOutput } from "../src/agents/runs.ts";
import { run } from "../src/core/db.ts";
import { OWNER } from "../src/core/users.ts";
import { addMaterials } from "../src/items/materials.ts";
import { saveReqs } from "../src/items/requirements.ts";
import { upsertItem } from "../src/items/store.ts";
import { testApp } from "./helpers.ts";

const done = (app: ReturnType<typeof testApp>, ...ids: string[]) => { for (const id of ids) run(app.db, "update runs set status = 'done', finished_at = created_at where id = ?", id); };
const wt = (space: string, branch: string) => ({ space, path: "work", branch, targetBranch: branch, base: "abc", cutFrom: "main", newBranch: true, commits: true });

describe("coding work for the run page", () => {
  it("puts each delegation in one entry with who it waits on and what comes next", () => {
    const app = testApp();
    try {
      // Coding now.
      const coding = createRun(app, { kind: "code", spaceId: "personal", title: "退款只按已发货的行计算", input: { task: "退款按行算", taskMode: true, repos: ["personal"] } });
      setRunOutput(app, coding.id, { worktrees: [wt("personal", "feat/refund-shipped")] });
      run(app.db, "update runs set status = 'running' where id = ?", coding.id);
      addTask(app, coding.id, { title: "可退金额只算未发货的行", kind: "build", state: "done" }, "coder");
      addTask(app, coding.id, { title: "优惠券按行均摊", kind: "build", state: "coding" }, "coder");
      addTask(app, coding.id, { title: "重复提交只退一次", kind: "fix", state: "todo" }, "review-lead");
      // Done, waiting to be confirmed (two rounds).
      const ready = createRun(app, { kind: "code", spaceId: "personal", title: "取消后恢复重新申请入口", input: { task: "恢复入口", taskMode: true } });
      setRunOutput(app, ready.id, { worktrees: [wt("personal", "feat/refund-reapply")] });
      const round2 = createRun(app, { kind: "code", spaceId: "personal", title: "交办第 2 轮：修改项 T2", input: { continueFrom: ready.id, round: 2, taskMode: true } });
      setRunOutput(app, round2.id, { verdict: "approved" });
      done(app, ready.id, round2.id);
      // Stopped by the owner on the web.
      const stopped = createRun(app, { kind: "code", spaceId: "personal", title: "清理旧的退款接口", input: { task: "清理" } });
      setRunOutput(app, stopped.id, { stoppedByOwner: "本人在网页上停下", worktrees: [wt("personal", "chore/drop-old-api")] });
      run(app.db, "update runs set status = 'cancelled' where id = ?", stopped.id);
      // A question for the owner, but nothing has happened for a week.
      const asked = createRun(app, { kind: "code", spaceId: "personal", title: "订单导出加上售后状态", input: { task: "导出", taskMode: true } });
      addTask(app, asked.id, { title: "部分退款的导出状态", kind: "build", state: "owner", question: "写什么？", options: ["部分退款", "按最后一笔"] }, "coder");
      done(app, asked.id);
      run(app.db, "update runs set created_at = '2026-01-01T00:00:00Z', finished_at = '2026-01-01T00:00:00Z' where id = ?", asked.id);
      // Pushed long ago.
      const pushed = createRun(app, { kind: "code", spaceId: "personal", title: "售后单列表加筛选", input: { task: "筛选" } });
      setRunOutput(app, pushed.id, { verdict: "approved", appliedAt: "2026-10-01T00:00:00Z", worktrees: [wt("personal", "feat/filter")], pushed: [{ space: "personal", branch: "feat/filter", at: "2026-10-01T00:00:00Z" }] });
      done(app, pushed.id);

      const works = listCodeWorks(app);
      const by = (id: string) => works.find((w) => w.rootId === id)!;
      expect(works).toHaveLength(5);
      expect(by(coding.id)).toMatchObject({ stage: { key: "running", text: "编码中", group: "active" }, progress: { build: [1, 2], fix: [0, 1] }, next: { actions: ["stop"] }, repos: [{ branch: "feat/refund-shipped", cutFrom: "main" }] });
      expect(by(ready.id)).toMatchObject({ latestId: round2.id, rounds: 2, branchWork: true, stage: { text: "完成，等你确认", group: "owner" }, next: { actions: ["confirm", "discard"] } });
      expect(by(ready.id).next.text).toContain("feat/refund-reapply");
      expect(by(stopped.id)).toMatchObject({ stage: { text: "你停下的", group: "idle" }, next: { actions: ["retry", "discard"] } });
      expect(by(asked.id).stage).toMatchObject({ key: "owner-tasks", group: "idle" });
      expect(by(asked.id).stage.text).toMatch(/^等你决定 1 项 · \d+ 天没动$/);
      expect(by(pushed.id)).toMatchObject({ stage: { text: "已推送", group: "ended" }, repos: [{ pushedAt: "2026-10-01T00:00:00Z" }] });
      // Ended work comes last.
      expect(works.at(-1)!.rootId).toBe(pushed.id);
      // Searching finds a work by one of its later rounds.
      expect(listCodeWorks(app, { q: "修改项 T2" }).map((w) => w.rootId)).toEqual([ready.id]);
    } finally { app.db.close(); }
  });

  it("finds work by the repository it changes and opens it from any round with its requirement points", () => {
    const app = testApp();
    try {
      const { keys } = saveReqs(app, [{ op: "add", key: "m", kind: "module", title: "售后" }, { op: "add", key: "f", parent: "$m", kind: "feature", title: "可退金额只算未发货的行" }], { by: "user", label: "本人" }, { canWrite: () => {}, canRead: () => {}, defaultSpace: "personal" });
      const item = upsertItem(app, undefined, { spaceId: "personal", kind: "todo", title: "退款改造", userId: OWNER }, "user");
      addMaterials(app, item.id, [{ kind: "req", ref: keys.m }], OWNER, "user");
      const root = createRun(app, { kind: "code", spaceId: "personal", title: "退款", input: { task: "退款按行算", itemId: item.id, repos: ["mall-web"] } });
      const round = createRun(app, { kind: "code", spaceId: "personal", title: "交办第 2 轮", input: { continueFrom: root.id, round: 2 } });
      done(app, root.id, round.id);
      expect(listCodeWorks(app, { spaces: ["mall-web"] }).map((w) => w.rootId)).toEqual([root.id]);
      expect(listCodeWorks(app, { spaces: ["english"] })).toEqual([]);
      const w = codeWork(app, round.id)!;
      expect(w).toMatchObject({ rootId: root.id, task: "退款按行算", item: { id: item.id, title: "退款改造" }, reqs: [{ id: keys.m, title: "售后" }] });
      expect(w.roundList.map((r) => r.id)).toEqual([root.id, round.id]);
      expect(w.points).toEqual([{ id: keys.f, title: "可退金额只算未发货的行", status: null, at: null }]);
      // Someone else sees only their own work and the spaces they may read.
      expect(codeWork(app, root.id, { userId: "u-guest", spaces: [] })).toBeNull();
    } finally { app.db.close(); }
  });

  it("leaves coding and review runs out of the plain run list when asked", () => {
    const app = testApp();
    try {
      const code = createRun(app, { kind: "code", spaceId: "personal", title: "交办", input: {} });
      createRun(app, { kind: "review", spaceId: "personal", title: "评审", input: {}, parentId: code.id });
      createRun(app, { kind: "ask", spaceId: "personal", title: "问答", input: {} });
      expect(listRuns(app, { exclude: "code,review" }).map((r) => r.kind)).toEqual(["ask"]);
      expect(listRuns(app, { exclude: "code,review", id: code.id })).toEqual([]);
    } finally { app.db.close(); }
  });
});
