import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { answerAsk, getAsk } from "../src/agents/asks.ts";
import { createRun, setRunOutput } from "../src/agents/runs.ts";
import { addScope } from "../src/agents/run-scope.ts";
import { all, one, run } from "../src/core/db.ts";
import { listNotifications } from "../src/core/notify.ts";
import { offerDeadlineChecks, queueDeadlineCheck } from "../src/items/deadline-check.ts";
import { deliverDueReminders } from "../src/items/reminders.ts";
import { addItemEvent, getItem, itemEvents, upsertItem, type ItemInput } from "../src/items/store.ts";
import { pendingActions } from "../src/items/pending.ts";
import { testApp } from "./helpers.ts";

const HOUR = 3600_000;
let app: ReturnType<typeof testApp>;
let now: Date;
const at = (hours: number) => new Date(now.getTime() + hours * HOUR).toISOString();
function make(input: ItemInput = {}) {
  const i = upsertItem(app, undefined, { title: "核对项目 A 的材料", dueAt: at(36), ...input });
  run(app.db, "update items set created_at=? where id=?", at(-48), i.id);
  run(app.db, "update item_events set at=? where item_id=?", at(-48), i.id);
  return i;
}
const cards = () => all<{ id: string }>(app.db, "select id from asks where json_extract(context,'$.handler')='item-deadline-check'").map(r => getAsk(app, r.id));
const report = "已查到两张表的字段不同。下一步：助手先核对映射；需本人确认验收范围。";
function finish(id: string) {
  setRunOutput(app, id, { summary: report });
  run(app.db, "update runs set status='done', finished_at=? where id=?", now.toISOString(), id);
}

beforeEach(() => {
  app = testApp();
  app.config.timezone = "UTC";
  app.config.notify.quietStart = app.config.notify.quietEnd = 0;
  now = new Date(Date.now() + 5000);
}, 30_000);
afterEach(async () => {
  // Let the standard fallback ask notification finish before closing the fixture.
  await new Promise(resolve => setImmediate(resolve));
  app.db.close();
  rmSync(app.home, { recursive: true, force: true });
});

describe("临期预查", () => {
  it("只选本人有未来截止、未结束、少于 48 小时且超过 24 小时没有动静的事项", () => {
    make({ dueAt: null });
    make({ dueAt: at(-1) });
    make({ dueAt: at(48) });
    make({ status: "done" });
    make({ status: "candidate" });
    make({ userId: "member-example" });
    const newItem = upsertItem(app, undefined, { title: "新建事项", dueAt: at(1) });
    const withEvent = make();
    addItemEvent(app, withEvent.id, "note", "已核对", "agent");
    const withRun = make();
    const job = createRun(app, { kind: "ask", title: "核对过" });
    addScope(app, job.id, "item", withRun.id);
    run(app.db, "update runs set status='done',finished_at=? where id=?", at(-2), job.id);
    const withQueuedRun = make();
    createRun(app, { kind: "code", title: "排队", input: { itemId: withQueuedRun.id } });
    const withFlow = make();
    run(app.db, "insert into item_flows(item_id,flow_id,definition,started_at,started_by,updated_at) values(?,'sample','{}',?,'owner',?)", withFlow.id, at(-40), at(-40));
    expect(queueDeadlineCheck(app, now)).toBeNull();
    const ok = make({ dueAt: new Date(at(20)).toISOString().replace(/Z$/, "+00:00") });
    expect(queueDeadlineCheck(app, now)?.input).toMatchObject({ itemId: ok.id, deadline: at(20) });
    expect(itemEvents(app, newItem.id)).toHaveLength(1);
  });

  it("免打扰不排队，同一截止无论成败只触发一次，延后才可再查", () => {
    const item = make();
    const hour = now.getUTCHours();
    app.config.notify.quietStart = hour;
    app.config.notify.quietEnd = (hour + 1) % 24;
    expect(queueDeadlineCheck(app, now)).toBeNull();
    app.config.notify.quietStart = app.config.notify.quietEnd = 0;
    const first = queueDeadlineCheck(app, now)!;
    expect(queueDeadlineCheck(app, now)).toBeNull();
    run(app.db, "update runs set status='failed', created_at=?, finished_at=? where id=?", at(-26), at(-26), first.id);
    expect(queueDeadlineCheck(app, now)).toBeNull();
    run(app.db, "update items set due_at=? where id=?", at(30), item.id);
    expect(queueDeadlineCheck(app, now)).toBeNull();
    upsertItem(app, item.id, { dueAt: at(40) }, "user");
    expect(queueDeadlineCheck(app, now)).toBeNull();
    run(app.db, "update item_events set at=? where item_id=?", at(-25), item.id);
    expect(queueDeadlineCheck(app, now)?.input).toMatchObject({ itemId: item.id, deadline: at(40) });
  });

  it("已有定时提醒时只发一张带结论的卡，只有本人可继续原事项会话", async () => {
    const item = make({ remindAt: at(1) });
    const job = queueDeadlineCheck(app, now)!;
    finish(job.id);
    offerDeadlineChecks(app, now);
    expect(cards()).toHaveLength(0);
    const hour = new Date(at(1)).getUTCHours();
    app.config.notify.quietStart = hour;
    app.config.notify.quietEnd = (hour + 1) % 24;
    expect(deliverDueReminders(app, new Date(at(1))).map(i => i.id)).toEqual([item.id]);
    expect(deliverDueReminders(app, new Date(at(1)))).toEqual([]);
    offerDeadlineChecks(app, now);
    const [card] = cards();
    expect(cards()).toHaveLength(1);
    expect(card.question).toContain(report);
    expect(one(app.db, "select 1 from asks where id=? and json_extract(context,'$.scheduledReminder')=1", card.id)).toBeTruthy();
    expect(card.options.map(o => o.label)).toEqual(["按这个开始", "先不用"]);
    expect(itemEvents(app, item.id).find(e => e.kind === "reminded")?.text).toBe("提醒已并入临期预查卡");
    expect(listNotifications(app).filter(n => n.entityId === item.id)).toEqual([]);
    expect((await pendingActions(app, "owner")).some(a => a.askId === card.id && a.itemId === item.id)).toBe(true);
    await expect(answerAsk(app, card.id, { by: "member-example", choice: 0 })).rejects.toThrow();
    await answerAsk(app, card.id, { by: "owner", choice: 0 });
    const thread = one<{ id: string }>(app.db, "select id from conversations where json_extract(settings,'$.itemId')=?", item.id)!;
    expect(one(app.db, "select 1 from item_materials where item_id=? and kind='conversation' and ref=?", item.id, thread.id)).toBeTruthy();
    expect(one(app.db, "select 1 from runs where lane=? and kind='ask'", thread.id)).toBeTruthy();
  });

  it("提醒等不及预查时仍照常发，迟到的结果不再发第二条", () => {
    const item = make({ remindAt: at(1) });
    const job = queueDeadlineCheck(app, now)!;
    expect(deliverDueReminders(app, new Date(at(1)))).toEqual([]);
    expect(deliverDueReminders(app, new Date(at(2))).map(i => i.id)).toEqual([item.id]);
    // In production the reminder event is recorded at the time of delivery.
    run(app.db, "update item_events set at=? where item_id=? and kind='reminded'", at(2), item.id);
    finish(job.id);
    offerDeadlineChecks(app, new Date(at(2)));
    expect(cards()).toEqual([]);
    expect(listNotifications(app).filter(n => n.entityId === item.id)).toHaveLength(1);
  });

  it("无定时提醒的结论也进入待处理；改期后不能用旧卡继续", async () => {
    const item = make();
    finish(queueDeadlineCheck(app, now)!.id);
    offerDeadlineChecks(app, now);
    offerDeadlineChecks(app, now);
    const [card] = cards();
    expect(cards()).toHaveLength(1);
    upsertItem(app, item.id, { dueAt: at(47) });
    await expect(answerAsk(app, card.id, { choice: 0, by: "owner" })).rejects.toThrow("已改期");
    offerDeadlineChecks(app, now);
    expect(getAsk(app, card.id).status).not.toBe("pending");
    expect(getItem(app, item.id).status).toBe("open");
  });
});
