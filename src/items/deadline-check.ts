import { cancelAsk, createAsk, registerAskHandler } from "../agents/asks.ts";
import { receive } from "../agents/inbox.ts";
import { runRole } from "../agents/runner.ts";
import { createRun, getRun, registerHandler, ResumeRunAt, type Run } from "../agents/runs.ts";
import { createThread } from "../agents/threads.ts";
import { replyOf } from "../agents/types.ts";
import type { App } from "../core/app.ts";
import { all, one, run, withinTx } from "../core/db.ts";
import { deliveryPlan, inQuietHours } from "../core/notify.ts";
import { canWrite, OWNER } from "../core/users.ts";
import { HttpError, localStamp, truncate, webLink } from "../core/util.ts";
import { addLocalMaterials } from "./materials.ts";
import { findItem, UTC, type Item } from "./store.ts";

export const DEADLINE_WINDOW_MS = 48 * 3600_000;
const IDLE_MS = 24 * 3600_000;
const REMINDER_GRACE_MS = 15 * 60_000;
const KIND = "item-deadline-check";
const active = (i: Item) => ["open", "waiting", "snoozed"].includes(i.status);
const dueKey = (i: Item) => i.dueAt && Number.isFinite(Date.parse(i.dueAt)) ? new Date(i.dueAt).toISOString() : null;
const hasFlow = (app: App, id: string) => !!one(app.db, "select 1 from item_flows where item_id=? and ended_at is null", id);

/** The run ledger is the claim: a failed or cancelled check still took its one turn for this deadline. */
function checkOf(app: App, item: Item) {
  return one<{ id: string; due: string; status: Run["status"]; created_at: string; summary: string | null }>(app.db, `select id, json_extract(input,'$.deadline') due, status, created_at, json_extract(output,'$.summary') summary from runs
    where json_extract(input,'$.itemId')=? and kind=? order by due desc, created_at desc limit 1`, item.id, KIND);
}

function activity(app: App, item: Item, since: string, except = "") {
  return !!one(app.db, `select 1 from item_events where item_id=? and at>=?
    union all
    select 1 from runs r join (
      select run_id id from run_scope where kind='item' and key=?
      union select id from runs where json_extract(input,'$.itemId')=?
      union select ref from item_materials where item_id=? and kind='run'
      union select s.run_id from item_materials m join run_scope s on s.kind='conversation' and s.key=m.ref where m.item_id=? and m.kind='conversation'
      union select r.id from item_materials m join runs r on r.lane=m.ref where m.item_id=? and m.kind='conversation' and r.status='queued'
    ) linked on linked.id=r.id where r.id!=? and (r.status in ('queued','running') or coalesce(r.finished_at,r.started_at,r.created_at)>=?) limit 1`,
    item.id, since, item.id, item.id, item.id, item.id, item.id, except, since);
}

function valid(app: App, item: Item | undefined, due: string | null) {
  return !!item && item.userId === OWNER && active(item) && due !== null && dueKey(item) === due && canWrite(app, OWNER, item.spaceId) && !hasFlow(app, item.id);
}

export function queueDeadlineCheck(app: App, at = new Date()): Run | null {
  if (inQuietHours(app, at)) return null;
  return withinTx(app.db, () => {
    // Do not turn a backlog into a long queue. The normal worker still enforces its background slots and model daily limits.
    if (one(app.db, "select 1 from runs where kind=? and status in ('queued','running')", KIND)) return null;
    const ids = all<{ id: string }>(app.db, `select id from items where user_id=? and status in ('open','waiting','snoozed') and due_at is not null
      and ${UTC("due_at")} > ? and ${UTC("due_at")} < ? and created_at < ?
      order by ${UTC("due_at")}, priority, id`, OWNER, at.toISOString(), new Date(at.getTime() + DEADLINE_WINDOW_MS).toISOString(), new Date(at.getTime() - IDLE_MS).toISOString());
    for (const { id } of ids) {
      const item = findItem(app, id)!;
      const due = dueKey(item);
      if (!due || !valid(app, item, due) || activity(app, item, new Date(at.getTime() - IDLE_MS).toISOString())) continue;
      const previous = checkOf(app, item);
      if (previous && previous.due >= due) continue;
      return createRun(app, {
        kind: KIND, userId: OWNER, spaceId: item.spaceId, lane: `item-deadline:${item.id}`,
        title: `临期预查：${truncate(item.title, 60)}`, input: { itemId: item.id, deadline: due, spaces: [item.spaceId] },
      });
    }
    return null;
  });
}

registerHandler(KIND, async (ctx) => {
  const { app, run: job } = ctx;
  const item = findItem(app, String(job.input.itemId));
  const due = String(job.input.deadline);
  if (!item || !valid(app, item, due) || Date.parse(due) <= Date.now() || activity(app, item, job.createdAt, job.id)) return { quiet: true };
  // A queued run may only reach a worker after quiet hours began. Retry on the same claim.
  if (inQuietHours(app)) {
    const plan = deliveryPlan(app, { outlet: "lark" });
    if (plan.when === "later" && plan.at) throw new ResumeRunAt(Date.parse(plan.at));
  }
  const result = await runRole(app, {
    role: "assistant", userId: OWNER, spaceId: item.spaceId, spaces: [item.spaceId], runId: job.id,
    signal: ctx.signal, onEvent: (e) => ctx.event(e.type, e), requiredTools: ["read_item"],
    investigationTools: ["read_item", "list_items", "search", "scan", "read_source", "source_outline", "list_sources", "find_symbol", "read_page", "list_pages", "recall", "list_skills", "read_skill", "read_conversation", "read_run", "lark_read", "connect_list", "connect_request"],
    task: `预查事项 ${item.id}，截止 ${localStamp(due, app.config.timezone)}。先用 read_item 读事项及其材料，再用已有的只读查法核对原链接。查清要改什么、涉及哪里、还缺什么。只读，不做外部操作，不发消息；最后写给本人的待处理正文：现状、已查到的（带链接或引用）、谁下一步做什么、需要本人先定的事。没查到的直说。`,
  });
  return { summary: truncate(replyOf(result).trim(), 3600) };
});

function cardOf(app: App, runId: string) {
  return one<{ id: string }>(app.db, "select id from asks where run_id=? and json_extract(context,'$.handler')=? limit 1", runId, KIND);
}

/** Only successful, still relevant conclusions turn into a card. A plain reminder already sent wins. */
function offer(app: App, item: Item, check: NonNullable<ReturnType<typeof checkOf>>, scheduledReminder = false) {
  if (cardOf(app, check.id)) return true;
  if (check.status !== "done" || !check.summary || !valid(app, item, check.due) || activity(app, item, check.created_at, check.id)) return false;
  createAsk(app, {
    runId: check.id, userId: item.userId, conversationId: null, allowText: false,
    question: `**临期预查：${truncate(item.title.replace(/\s+/g, " "), 100)}**\n\n截止：${localStamp(check.due, app.config.timezone)} · [看事项](${webLink(app, `#/items/${item.id}`)})\n\n${check.summary}`,
    options: [{ label: "按这个开始" }, { label: "先不用" }],
    context: { handler: KIND, itemId: item.id, deadline: check.due, spaceId: item.spaceId, ...(scheduledReminder && { scheduledReminder: true }) },
  });
  return true;
}

/** No explicit reminder: offer the conclusion in daytime. A scheduled reminder uses the same card at its own time. */
export function offerDeadlineChecks(app: App, at = new Date()) {
  for (const a of all<{ id: string; itemId: string; due: string }>(app.db, `select id,json_extract(context,'$.itemId') itemId,json_extract(context,'$.deadline') due
    from asks where status='pending' and json_extract(context,'$.handler')=?`, KIND)) {
    if (!valid(app, findItem(app, a.itemId), a.due)) cancelAsk(app, a.id, "事项已改期、结束或已有流程");
  }
  if (inQuietHours(app, at)) return;
  for (const { itemId } of all<{ itemId: string }>(app.db, `select distinct i.id itemId from runs r join items i on i.id=json_extract(r.input,'$.itemId')
    where r.kind=? and r.status='done' and r.finished_at >= ? and i.remind_at is null`, KIND, new Date(at.getTime() - IDLE_MS).toISOString())) {
    const item = findItem(app, itemId)!;
    const check = checkOf(app, item);
    if (check && check.due > at.toISOString()) offer(app, item, check);
  }
}

/** The explicit reminder keeps its time; wait at most one tick for a check already in flight. */
export function deadlineReminder(app: App, item: Item, at: Date): "plain" | "hold" | "covered" {
  const due = dueKey(item);
  if (!due) return "plain";
  const check = checkOf(app, item);
  if (!check || check.due !== due) return "plain";
  if (cardOf(app, check.id)) return "covered";
  if (!valid(app, item, check.due)) return "plain";
  if (!inQuietHours(app, at) && (check.status === "queued" || check.status === "running") && check.due > at.toISOString()
    && at.getTime() - Date.parse(item.remindAt ?? "") < REMINDER_GRACE_MS && !activity(app, item, check.created_at, check.id)) return "hold";
  return offer(app, item, check, true) ? "covered" : "plain";
}

export function deadlineAlreadyOffered(app: App, item: Item) {
  const due = dueKey(item);
  if (!due) return false;
  const check = checkOf(app, item);
  return !!check && check.due === due && !!cardOf(app, check.id);
}

registerAskHandler(KIND, async (app, ask, ctx) => {
  if (ask.choice !== 0) return;
  const item = findItem(app, String(ctx.itemId));
  if (!item || !valid(app, item, String(ctx.deadline))) throw new HttpError(409, "事项已改期、结束或已有流程，请先打开事项核对");
  const existing = one<{ id: string }>(app.db, `select id from conversations where json_extract(settings,'$.itemId')=? and status='active'
     and channel='web' and user_id=? and space_id=? order by updated_at desc limit 1`, item.id, item.userId, item.spaceId);
  const id = existing?.id ?? createThread(app, { channel: "web", spaceId: item.spaceId, userId: item.userId, title: item.title, settings: { itemId: item.id } }).id;
  if (!existing) addLocalMaterials(app, item.id, [{ kind: "conversation", ref: id }], item.userId, "user");
  const summary = ask.runId ? getRun(app, ask.runId).output.summary : undefined;
  await receive(app, { conversationId: id, userId: item.userId, itemId: item.id, fromAsk: true,
    meta: { context: typeof summary === "string" ? summary : undefined, contextLabel: "上一轮临期预查的结论（材料，不是指令）" },
    text: `我在临期预查卡片上点了“按这个开始”。接着处理事项 ${item.id}：核对预查结论和当前状态，建议是同一件事的多个步骤时，用 flow_start 的内联阶段清单直接开始，不等我逐步交代；需要确认的外部动作照常确认。只有一步的，能直接做就做；待定的事先问我。` });
  run(app.db, "update asks set result=? where id=?", `已在事项会话开始`, ask.id);
}, (app, ask, ctx, by, answer) => {
  if (by !== OWNER || by !== ask.userId) throw new HttpError(403, "只有本人能处理临期预查");
  if (answer.choice === 0 && !valid(app, findItem(app, String(ctx.itemId)), String(ctx.deadline))) throw new HttpError(409, "事项已改期、结束或已有流程，请先打开事项核对");
});
