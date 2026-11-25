import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkQuietFollowup } from "../src/agents/quiet-followup.ts";
import { createAsk } from "../src/agents/asks.ts";
import { addMessage } from "../src/agents/threads.ts";
import { createRun, getRun } from "../src/agents/runs.ts";
import { recordRunStart } from "../src/agents/run-scope.ts";
import { callTool } from "../src/agents/tools.ts";
import { scheduleWake, cancelWake } from "../src/agents/wakes.ts";
import { saveContext } from "../src/channels/listen.ts";
import { recordLarkSent } from "../src/channels/lark-feedback.ts";
import { recordInteraction } from "../src/channels/lark-send.ts";
import { listNotifications, notify } from "../src/core/notify.ts";
import { run } from "../src/core/db.ts";
import { addItemEvent, upsertItem } from "../src/items/store.ts";
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
    const second = createRun(app, { kind: "agent", title: "唤醒复查", input: { wake: true }, parentId: first }).id;
    run(app.db, "insert into lark_messages(message_id,chat_id,position,create_ms) values('om_test','oc_fixture',23,?)", Date.now());
    for (const r of [second, first, make()]) {
      await quiet(r, "unresolved");
      checkQuietFollowup(app, r);
    }
    expect(listNotifications(app)).toMatchObject([{
      urgency: "normal", title: "规则「定时检查」：问题还在，这次没有告诉任何人",
      body: expect.stringMatching(/^页面仍然打不开\n\n最后判断：查过仍未恢复\n\n\[打开原消息\].*&position=23/),
    }]);
  });
  it.each(["heartbeat", "digest", "agent", "item-follow", "flow-reconcile", "wiki-write", "memory-organize"] as const)(
    "never notifies for %s without a rule or watched context", async kind => {
      const id = createRun(app, { kind, title: "后台整理", input: {} }).id;
      run(app.db, "update runs set status='done', output=? where id=?", JSON.stringify({ stayQuiet: "查过仍未恢复", stayQuietState: "unresolved" }), id);
      checkQuietFollowup(app, id);
      expect(listNotifications(app)).toHaveLength(0);
    },
  );
  it("also notifies for a watched conversation without a rule", async () => {
    const watch = saveContext(app, { kind: "place", chats: ["oc_watch"], name: "项目 A" });
    const messageId = addMessage(app, watch.conversationId!, "user", "页面仍然打不开", null, { speaker: "小王", chatId: "oc_watch", externalId: "om_watch", larkPosition: 7 });
    const id = createRun(app, { kind: "ask", title: "看这批消息", input: { conversationId: watch.conversationId, messageIds: [messageId] } }).id;
    await quiet(id, "unresolved");
    checkQuietFollowup(app, id);
    expect(listNotifications(app)).toMatchObject([{ title: "关注「项目 A」：问题还在，这次没有告诉任何人", body: expect.stringContaining("&position=7") }]);
  });
  it.each([
    ["notification", (id: string) => notify(app, { title: "已经告知本人", runId: id }, { push: false })],
    ["pending ask", (id: string) => createAsk(app, { runId: id, question: "是否继续？", context: { notificationOnly: true } })],
    ["bot reply", (id: string) => recordLarkSent(app, { messageId: "om_sent", chatId: "oc_another", runId: id, purpose: "answer", bot: "main" })],
    ["private card", (id: string) => recordInteraction(app, { messageId: "om_card", runId: id, chatId: "oc_another", conversationId: null, purpose: "draft", allowed: [], payload: {} })],
    ["item change", (id: string) => addItemEvent(app, upsertItem(app, undefined, { title: "项目 A 的页面" }).id, "note", "已请小王复查", "agent", [], id)],
    ["queued wake", (id: string) => scheduleWake(app, { note: "已安排复查", target: { spec: "assistant" }, setBy: { runId: id, agent: "assistant" }, at: new Date(Date.now() + 3600_000).toISOString() })],
  ] as const)("does not add a reminder after a %s anywhere on the lineage", async (_kind, recorded) => {
    const root = make();
    recorded(root);
    const before = listNotifications(app).map(n => n.id);
    const middle = createRun(app, { kind: "agent", title: "第一次复查", input: { wake: true }, parentId: root }).id;
    const id = createRun(app, { kind: "agent", title: "第二次复查", input: { wake: true }, parentId: middle }).id;
    await quiet(id, "unresolved");
    checkQuietFollowup(app, id);
    expect(listNotifications(app).map(n => n.id)).toEqual(before);
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
