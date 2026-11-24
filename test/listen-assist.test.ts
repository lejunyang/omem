import { describe, expect, it } from "vitest";
import { getRun, listRuns } from "../src/agents/runs.ts";
import { mayStayQuiet } from "../src/agents/quiet.ts";
import { run } from "../src/core/db.ts";
import { saveContext } from "../src/channels/listen.ts";
import { assistDue } from "../src/channels/listen-assist.ts";
import { defineMetric } from "../src/data/metrics.ts";
import { setParent } from "../src/items/parent.ts";
import { upsertItem } from "../src/items/store.ts";
import { testApp } from "./helpers.ts";

describe("where a line stands (item 关注 assist)", () => {
  it("looks at a live matter about once a day, hands in its state instead of notifying, and never codes or posts", async () => {
    const app = testApp();
    const item = upsertItem(app, undefined, { spaceId: "personal", kind: "todo", title: "新版消息中心", dueAt: new Date(Date.now() + 2 * 86400_000).toISOString() } as never, "user");
    const c = saveContext(app, { kind: "item", itemId: item.id, name: "新版消息中心" });
    expect(c.knobs.assist).toBe("act");
    saveContext(app, { id: c.id, kind: "item", knobs: { assist: "suggest" } });
    defineMetric(app, { name: "消息中心报错", query: "前端监控：/message 的 JS 报错", itemId: item.id });
    const ids = await assistDue(app);
    expect(ids).toHaveLength(1);
    const r = getRun(app, ids[0]);
    expect(r.input.lineState).toBe(item.id);
    const task = String(r.input.task);
    expect(task).toContain("新版消息中心");
    expect(task).toContain("消息中心报错");
    expect(task).toContain("还没有观测计划");
    expect(task).toContain("submit_line_state");
    expect(task).toContain("只看不动手");
    expect(task).not.toContain("用 notify 发");
    const deny = (r.input.assistantScope as { denyTools: string[] }).denyTools;
    for (const t of ["delegate_code", "lark_send", "save_rule", "metric_define", "notify"]) expect(deny).toContain(t);
    expect(mayStayQuiet(app, r)).toBe(true);
    // Not again within the day, even once its run is done.
    run(app.db, "update runs set status = 'done' where id = ?", r.id);
    expect(await assistDue(app)).toHaveLength(0);
  });

  it("does the read-only part itself when set to act, and leaves closed, quiet or child matters alone", async () => {
    const app = testApp();
    const live = upsertItem(app, undefined, { spaceId: "personal", kind: "todo", title: "旧平台迁移" } as never, "user");
    const done = upsertItem(app, undefined, { spaceId: "personal", kind: "todo", title: "做完的" } as never, "user");
    run(app.db, "update items set status = 'done' where id = ?", done.id);
    saveContext(app, { kind: "item", itemId: live.id, knobs: { assist: "act" } });
    saveContext(app, { kind: "item", itemId: done.id });
    const off = upsertItem(app, undefined, { spaceId: "personal", kind: "todo", title: "不推进的" } as never, "user");
    saveContext(app, { kind: "item", itemId: off.id, knobs: { assist: "off" } });
    // A work item under a line has no look of its own (its 关注 folded into the line's, which is off here).
    const line = upsertItem(app, undefined, { spaceId: "personal", kind: "line", title: "项目 A" } as never, "user");
    const child = upsertItem(app, undefined, { spaceId: "personal", kind: "todo", title: "项目 A 的接口" } as never, "user");
    saveContext(app, { kind: "item", itemId: line.id, knobs: { assist: "off" } });
    saveContext(app, { kind: "item", itemId: child.id });
    setParent(app, child.id, line.id);
    const ids = await assistDue(app);
    expect(ids).toHaveLength(1);
    const r = getRun(app, ids[0]);
    expect(String(r.input.task)).toContain("能只读完成的先做");
    expect((r.input.assistantScope as { denyTools: string[] }).denyTools).not.toContain("metric_define");
    expect(listRuns(app, { kind: "agent" }).every((x) => x.input.listenAssist)).toBe(true);
  });
});
