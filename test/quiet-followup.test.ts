import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkQuietFollowup } from "../src/agents/quiet-followup.ts";
import { createRun, getRun } from "../src/agents/runs.ts";
import { recordRunStart } from "../src/agents/run-scope.ts";
import { callTool } from "../src/agents/tools.ts";
import { scheduleWake, cancelWake } from "../src/agents/wakes.ts";
import { saveContext } from "../src/channels/listen.ts";
import { listNotifications } from "../src/core/notify.ts";
import { run } from "../src/core/db.ts";
import { testApp } from "./helpers.ts";

describe("unresolved quiet runs", () => {
  let app: ReturnType<typeof testApp>;
  beforeEach(() => { app = testApp(); }, 45_000);
  afterEach(() => app.db.close());
  const make = (messageId = "om_test", input = {}, parentId?: string) => createRun(app, { kind: "agent", title: "复查项目 A", input: { rule: { name: "定时检查" }, triggers: [{ messageId, summary: "页面仍然打不开" }], ...input }, parentId }).id;
  const quiet = async (id: string, state?: "nothing-new" | "resolved" | "unresolved") => {
    run(app.db, "update runs set status='done' where id=?", id);
    const result = await callTool({ app, runId: id, actor: "agent", spaceId: "personal", spaces: null, tools: null }, "stay_quiet", { reason: "查过仍未恢复", ...(state ? { state } : {}) });
    expect(result.isError, result.text).toBe(false);
  };
  it("keeps the old default and does not notify for resolved or nothing-new", async () => {
    for (const state of [undefined, "resolved", "nothing-new"] as const) {
      const id = make();
      await quiet(id, state);
      expect(getRun(app, id).output.stayQuietState).toBe(state ?? "nothing-new");
      checkQuietFollowup(app, id);
    }
    expect(listNotifications(app)).toHaveLength(0);
  });
  it("notifies once across wake rounds and independent runs for the same triggering message", async () => {
    const first = make();
    const second = make("", { wake: true, triggers: [] }, first);
    for (const r of [second, first, make()]) {
      await quiet(r, "unresolved");
      checkQuietFollowup(app, r);
    }
    expect(listNotifications(app)).toMatchObject([{ urgency: "normal", title: expect.stringContaining("定时检查"), body: expect.stringContaining("om_test") }]);
  });
  it("checks live wake, problem recheck, and an active run in the same scope", async () => {
    const id = make();
    const wake = scheduleWake(app, { note: "回查", target: { spec: "assistant" }, setBy: { runId: id, agent: "assistant" }, at: new Date(Date.now() + 3600_000).toISOString() });
    await quiet(id, "unresolved");
    checkQuietFollowup(app, id);
    expect(listNotifications(app)).toHaveLength(0);
    cancelWake(app, wake.id);
    const watch = saveContext(app, { kind: "place", chats: ["oc_watch"], name: "项目 A" });
    run(app.db, `insert into listen_problems(id,context_id,chat_id,topic_id,title,state,recheck_at,run_id,created_at,updated_at)
      values('lp_test',?,'oc_watch','','打不开','open',?,?,datetime('now'),datetime('now'))`, watch.id, new Date(Date.now() + 3600_000).toISOString(), id);
    checkQuietFollowup(app, id);
    expect(listNotifications(app)).toHaveLength(0);
    run(app.db, "update listen_problems set recheck_at=null where id='lp_test'");
    const other = make("om_test", {}, id);
    run(app.db, "update runs set status='running' where id=?", other);
    recordRunStart(app, other);
    checkQuietFollowup(app, id);
    expect(listNotifications(app)).toHaveLength(0);
    run(app.db, "update runs set status='done' where id=?", other);
    checkQuietFollowup(app, id);
    const recheck = make("om_other", { problemId: "lp_test" });
    await quiet(recheck, "unresolved");
    checkQuietFollowup(app, recheck);
    expect(listNotifications(app)).toHaveLength(1);
  });
});
