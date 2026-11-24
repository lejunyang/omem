import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { seedBundledTaskRules } from "../src/agents/rule-packs.ts";
import { createRun } from "../src/agents/runs.ts";
import { readSkill, seedBuiltinSkills } from "../src/agents/specs.ts";
import { ASSIGNED_SWEEP_RULE, assignedInput, notifyAssignedSweep, syncAssigned } from "../src/items/assigned-sweep.ts";
import { buildToday } from "../src/items/today.ts";
import { getItem, itemEvents, listItems } from "../src/items/store.ts";
import { listNotifications } from "../src/core/notify.ts";
import { nextRuns } from "../src/core/scheduler.ts";
import { deleteRule, getRule, saveRule } from "../src/rules/store.ts";
import { testApp } from "./helpers.ts";

const root = resolve(".");
function enable(app: ReturnType<typeof testApp>) {
  const { temporary: _temporary, ...r } = getRule(app, ASSIGNED_SWEEP_RULE);
  saveRule(app, { ...r, enabled: true }, "user", "owner");
}

describe("指派清点", () => {
  it("在已有库播种技能和默认关闭的普通定时规则，不覆盖本人启停或删除", () => {
    const app = testApp();
    try {
      expect(seedBuiltinSkills(app, root)).toContain("assigned-sweep");
      expect(readSkill(app, "assigned-sweep").body).toContain("没有查这个平台的技能");
      expect(seedBuiltinSkills(app, root)).toEqual([]);
      seedBundledTaskRules(app, root);
      expect(getRule(app, ASSIGNED_SWEEP_RULE)).toMatchObject({ enabled: false, trigger: { event: "schedule", cron: "0 9 * * 1-5" }, actions: [{ type: "agent", spec: "assistant", reply: "none" }] });
      expect(nextRuns(app)[`rule:${ASSIGNED_SWEEP_RULE}`]).toBeNull();
      enable(app);
      seedBundledTaskRules(app, root);
      expect(getRule(app, ASSIGNED_SWEEP_RULE).enabled).toBe(true);
      expect(nextRuns(app)[`rule:${ASSIGNED_SWEEP_RULE}`]).not.toBeNull();
      deleteRule(app, ASSIGNED_SWEEP_RULE);
      seedBundledTaskRules(app, root);
      expect(nextRuns(app)[`rule:${ASSIGNED_SWEEP_RULE}`]).toBeUndefined();
    } finally { app.db.close(); rmSync(app.home, { recursive: true, force: true }); }
  });

  it("只在已启用的规则运行写入，重查不重复建，改期和结束落在同一件", async () => {
    const app = testApp();
    try {
      seedBundledTaskRules(app, root);
      const job = createRun(app, { kind: "agent", title: "清点", input: { rule: { id: ASSIGNED_SWEEP_RULE }, spec: "assistant" } });
      const ctx = { spaceId: "personal", runId: job.id, userId: "owner", spaces: ["personal"] };
      const commit = (args: unknown) => syncAssigned(app, assignedInput.parse(args), ctx);
      const item = (n: number, days: number) => ({ action: "save", key: `example.org:${n}`, url: `https://example.org/work/${n}`, title: `项目 A 的工作 ${n}`, state: "open", due_at: new Date(Date.now() + days * 86_400_000).toISOString(), evidence: "查询结果显示指派给本人。" });
      const soon = item(1, 1);
      expect(() => commit(soon)).toThrow("已启用");
      enable(app);
      expect(() => syncAssigned(app, assignedInput.parse(soon), { ...ctx, spaces: [] })).toThrow("范围");
      const made = commit(soon);
      expect(made).toMatchObject({ result: "created", notify: true });
      const id = (made as { id: string }).id;
      expect(getItem(app, id)).toMatchObject({ status: "open", dueAt: soon.due_at, detail: `原链接：${soon.url}`, sourceRefs: [expect.stringMatching(/^src:/)] });
      expect(commit(soon)).toEqual({ result: "unchanged", id });
      expect(itemEvents(app, id)).toHaveLength(1);
      expect(commit(item(2, 2))).toMatchObject({ result: "created", notify: true });
      expect(commit(item(3, 6))).toMatchObject({ result: "created", notify: false });
      notifyAssignedSweep(app, job.id);
      notifyAssignedSweep(app, job.id);
      expect(listNotifications(app)).toHaveLength(1);
      expect(listNotifications(app)[0].title).toContain("新发现 2 件");
      expect(listNotifications(app)[0].body).not.toContain("工作 3");
      expect((await buildToday(app))?.question).toContain("项目 A 的工作 3");
      const changed = item(1, 8);
      expect(commit(changed)).toMatchObject({ result: "updated", id });
      expect(getItem(app, id).dueAt).toBe(changed.due_at);
      expect(commit({ ...changed, state: "done" })).toMatchObject({ result: "updated", id });
      expect(getItem(app, id).status).toBe("done");
      expect(listItems(app, { status: "all" })).toHaveLength(3);
      expect(commit({ action: "list" })).toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ key: "example.org:3" })]) });
    } finally { deleteRule(app, ASSIGNED_SWEEP_RULE); app.db.close(); rmSync(app.home, { recursive: true, force: true }); }
  });
});
