import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { HttpError, json, now, truncate, zonedParts } from "../core/util.ts";
import { cancelAsk, createAsk, registerAskHandler, type Ask } from "../agents/asks.ts";
import { createRun, runsInLane } from "../agents/runs.ts";
import { getContext, itemContext, saveContext } from "../channels/listen.ts";
import { lineStateDenied } from "../channels/listen-assist.ts";
import { addChange } from "./changes.ts";
import { LINE_ENDED } from "./expiry.ts";
import { addItemEvent, getItem, isClosed, onItemStatus, upsertItem, type Item } from "./store.ts";
import { descendantIds, lineLike, openUnder, rootOf } from "./tree.ts";

/**
 * A work line's life (docs/v2/status.md “工作线”): 进行中 → 观察中 → 已结束. Lines end by themselves and
 * rarely ask the owner.
 *
 * - 观察中 (`items.phase = 'watching'` until `watch_until`, `workLines.watchDays`, 14 by default) comes
 *   without a question: the item's own flow ran to its end with nothing open under it; a line whose
 *   work items are all closed, at least one done; nothing moved for a todo's period with nothing open;
 *   or the daily look at the line (`submit_line_state` with `phase`) judged it with enough confidence.
 *   Its 关注 keeps reading the groups, its metrics keep being taken, the daily look keeps going (its next
 *   steps are about after the launch).
 * - 已结束 is status done (cancelled when dropped). The heartbeat ends a watched line past its window
 *   when nothing under it is open, no recent next step waits, no metric moved past its mark in a week,
 *   nothing new came from its groups or problems in three days, nothing is asked about it and the owner
 *   did not keep it lately; it shows in the next item digest as closed by itself (恢复 there). Fresh
 *   activity keeps it watched another week, silently. Only a genuinely unclear case asks (one card,
 *   结束 / 再看一周 / 还没完), at most once a line in 14 days and twice a day overall.
 * - Ending (any way: here, the page, the item's status) pauses its 关注 and metrics, expires its open
 *   next steps and queues one wrap-up run that writes the closing summary; opening it again restores
 *   them. What the owner did about an ending is kept (`line-end` events) and read by the next looks.
 */

const DAY = 86_400_000;
/** A line the owner kept, restored or said is not done: no automatic 观察, no ending, no question this long. */
export const KEEP_DAYS = 14;
const ASK_EVERY_DAYS = 14;
export const ASKS_PER_DAY = 2;
const EXTEND_DAYS = 7;
const MAX_WATCH_DAYS = 60;
/** Something new from its groups or problems this recent keeps it watched. */
const FRESH_DAYS = 3;
/** A metric past its mark this recent keeps it watched. */
const METRIC_DAYS = 7;
/** Nothing moved this long with something still open: unclear, worth one question. A next step older than this nobody answered no longer holds it. */
const STILL_DAYS = 7;
/** What a look's judgement needs before the host acts on it. */
export const CONFIDENCE = { watch: 0.6, end: 0.8, ask: 0.5 } as const;

const kv = (app: App, key: string) => one<{ value: string }>(app.db, "select value from kv where key = ?", key)?.value ?? null;
const setKv = (app: App, key: string, value: string) => run(app.db, "insert into kv(key,value) values(?,?) on conflict(key) do update set value = excluded.value", key, value);
const dropKv = (app: App, key: string) => run(app.db, "delete from kv where key = ?", key);
const KEEP = (id: string) => `line_keep:${id}`;
const PAUSED = (id: string) => `line_paused:${id}`;
const ASKED = (id: string) => `line_end_ask:${id}`;

export const watchDays = (app: App) => app.config.workLines?.watchDays ?? 14;
/** "12 月 5 日" where the owner is. */
export const md = (app: App, iso: string) => { const p = zonedParts(iso, app.config.timezone); return `${p.month} 月 ${p.day} 日`; };
const daysSince = (iso: string | null | undefined, at = Date.now()) => (iso ? Math.floor((at - Date.parse(iso)) / DAY) : 0);

/** When the owner last kept this line (restored, reopened, said it is not done), within KEEP_DAYS. */
export function keptAt(app: App, id: string, at = Date.now()) {
  const v = kv(app, KEEP(id));
  return v && at - Date.parse(v) < KEEP_DAYS * DAY ? v : null;
}
const keep = (app: App, id: string) => setKv(app, KEEP(id), now());

function setPhase(app: App, id: string, phase: "watching" | null, until: string | null) {
  const at = now();
  run(app.db, "update items set phase = ?, phase_since = ?, watch_until = ?, updated_at = ? where id = ?", phase, at, until, at, id);
  app.emit({ type: "changed", entity: "item", id });
}

// ------------------------------------------------------------------ what holds a line open

export type Guards = {
  /** Items under it still open. */
  openItems: number;
  /** Its next steps being done, or suggested within STILL_DAYS and not answered. */
  openNext: number;
  /** Metrics on it or under it past their mark in the last METRIC_DAYS. */
  flaggedMetrics: number;
  /** Changes its groups or problems brought in the last FRESH_DAYS. */
  fresh: number;
  /** Problems its 关注 follows that are not closed. */
  openProblems: number;
  /** Changes waiting for the owner, and questions about it. */
  pendingAsks: number;
  /** A flow running on it or under it. */
  flowRunning: boolean;
  /** The last time something moved on it or under it (a change, the owner, new evidence). */
  lastMoved: string | null;
};

export function guardsOf(app: App, item: Item, at = Date.now()): Guards {
  const ids = [item.id, ...descendantIds(app, item.id)];
  const marks = ids.map(() => "?").join(",");
  const since = (days: number) => new Date(at - days * DAY).toISOString();
  const n = (sql: string, ...p: (string | number)[]) => one<{ n: number }>(app.db, sql, ...p)?.n ?? 0;
  const c = itemContext(app, item.id);
  const moved = one<{ a: string | null; b: string | null }>(app.db,
    `select (select max(at) from item_changes where item_id in (${marks}) and origin != 'line' and noise = 0) a,
            (select max(at) from item_events where item_id in (${marks}) and kind not in ('line-end','reminded','reminder-failed') and (actor = 'user' or source_refs != '[]')) b`, ...ids, ...ids)!;
  return {
    openItems: openUnder(app, item.id),
    openNext: n("select count(*) n from item_next where item_id = ? and (status = 'doing' or (status = 'open' and created_at > ?))", item.id, since(STILL_DAYS)),
    flaggedMetrics: n(`select count(*) n from item_changes where item_id in (${marks}) and origin = 'metric' and noise = 0 and at > ?`, ...ids, since(METRIC_DAYS)),
    fresh: n(`select count(*) n from item_changes where item_id in (${marks}) and origin in ('follow','problem') and noise = 0 and at > ?`, ...ids, since(FRESH_DAYS)),
    openProblems: c ? n("select count(*) n from listen_problems where context_id = ? and state != 'closed'", c.id) : 0,
    pendingAsks: n(`select count(*) n from item_changes where item_id in (${marks}) and status = 'asked'`, ...ids)
      + n("select count(*) n from asks where status = 'pending' and json_extract(context, '$.lineId') = ?", item.id),
    flowRunning: !!one(app.db, `select 1 from item_flows where ended_at is null and item_id in (${marks}) limit 1`, ...ids),
    lastMoved: [moved.a, moved.b].filter((x): x is string => !!x).sort().at(-1) ?? null,
  };
}
/** Nothing holds it: it may end. */
export const quietGuards = (g: Guards) => !g.openItems && !g.openNext && !g.flaggedMetrics && !g.fresh && !g.openProblems && !g.pendingAsks && !g.flowRunning;
/** Something is still happening on it (not just open things nobody moves): keep watching, ask nothing. */
const busy = (g: Guards) => g.fresh > 0 || g.openProblems > 0 || g.flaggedMetrics > 0 || g.pendingAsks > 0 || g.flowRunning;

/** What still holds the line, in words. */
export function holdText(g: Guards) {
  return [
    g.openItems ? `下面 ${g.openItems} 件没结` : "",
    g.openNext ? `${g.openNext} 条下一步没定或在做` : "",
    g.flaggedMetrics ? `近 ${METRIC_DAYS} 天 ${g.flaggedMetrics} 处指标越过门槛` : "",
    g.fresh ? `近 ${FRESH_DAYS} 天群里或问题有 ${g.fresh} 条新变化` : "",
    g.openProblems ? `${g.openProblems} 个在跟的问题没结` : "",
    g.pendingAsks ? `${g.pendingAsks} 处等你确认` : "",
    g.flowRunning ? "流程还在走" : "",
  ].filter(Boolean).join("、");
}

// ------------------------------------------------------------------ what the owner decided (learning)

export type LineOutcome = "auto-ended" | "restored" | "owner-ended" | "owner-cancelled" | "keep-watching" | "not-done" | "reopened";
const OUTCOME_WORDS: Record<LineOutcome, string> = {
  "auto-ended": "自动结束",
  restored: "本人恢复了自动结束的线",
  "owner-ended": "本人结束了这条线",
  "owner-cancelled": "本人放弃了这条线",
  "keep-watching": "本人选了再看一周",
  "not-done": "本人说还没完，回到进行中",
  reopened: "本人重新打开了这条线",
};
const META = /\n?<!-- line-end (\{.*\}) -->\s*$/;

/**
 * One `line-end` event: what happened and what the line looked like then (its phase, how long it was
 * watched, what was still open). Readable on the item's timeline; the machine part is an HTML comment.
 */
export function recordOutcome(app: App, item: Item, outcome: LineOutcome, actor: "agent" | "user", reason = "", extra: { endedDays?: number } = {}) {
  const g = guardsOf(app, item);
  const watched = item.phase === "watching" && item.phaseSince ? daysSince(item.phaseSince) : null;
  const where = [
    item.phase === "watching" ? `观察了 ${watched} 天` : isClosed(item.status) ? `结束 ${extra.endedDays ?? daysSince(item.closedAt)} 天后` : "在进行中",
    `下面 ${g.openItems} 件没结`, `${g.openNext} 条下一步`, `${g.openProblems} 个问题没结`,
    g.flaggedMetrics ? `近 ${METRIC_DAYS} 天 ${g.flaggedMetrics} 处指标越过门槛` : "",
    g.fresh ? `近 ${FRESH_DAYS} 天 ${g.fresh} 条新变化` : "",
  ].filter(Boolean).join("、");
  const meta = { outcome, phase: item.phase ?? (isClosed(item.status) ? "ended" : "active"), watched, open: { items: g.openItems, next: g.openNext, problems: g.openProblems, metrics: g.flaggedMetrics, fresh: g.fresh } };
  addItemEvent(app, item.id, "line-end", `${OUTCOME_WORDS[outcome]}${reason ? `：${truncate(reason, 200)}` : ""}（${where}）\n<!-- line-end ${JSON.stringify(meta)} -->`, actor);
}

/** The outcome a `line-end` event recorded. */
export const outcomeOf = (text: string): LineOutcome | null => json<{ outcome?: LineOutcome }>(META.exec(text)?.[1] ?? "{}", {}).outcome ?? null;

/** The latest decisions about ending lines across the person's lines, for the daily look (newest first). */
export function lineEndCases(app: App, userId: string, limit = 10) {
  return all<{ text: string; at: string; title: string; item_id: string }>(app.db,
    `select e.text, e.at, i.title, e.item_id from item_events e join items i on i.id = e.item_id
      where e.kind = 'line-end' and coalesce(i.user_id,'owner') = ? order by e.id desc limit ?`, userId, limit)
    .map((r) => ({ at: r.at, itemId: r.item_id, title: r.title, outcome: outcomeOf(r.text), text: r.text.replace(META, "").trim() }));
}

// ------------------------------------------------------------------ 进行中 ⇄ 观察中

/**
 * Into 观察中, no question asked: until `days` from now (the config's watch days by default, 60 at most).
 * Its 关注 goes on reading (one only there for a flow is taken up again). Already watching: only the
 * owner moves its end.
 */
export function enterWatching(app: App, id: string, o: { reason: string; by: "host" | "run" | "user"; days?: number; refs?: string[]; runId?: string | null }) {
  const item = getItem(app, id);
  if (item.parentId || isClosed(item.status) || item.status === "candidate") return null;
  const days = Math.max(1, Math.min(MAX_WATCH_DAYS, Math.round(o.days ?? watchDays(app))));
  const until = new Date(Date.now() + days * DAY).toISOString();
  if (item.phase === "watching") {
    if (o.by !== "user") return item;
    run(app.db, "update items set watch_until = ?, updated_at = ? where id = ?", until, now(), id);
    addChange(app, { itemId: id, type: "info", origin: "line", summary: `观察改到 ${md(app, until)}${o.reason ? `：${o.reason}` : ""}` });
    return getItem(app, id);
  }
  setPhase(app, id, "watching", until);
  addChange(app, {
    itemId: id, type: "stage", origin: "line", summary: `进入观察：${truncate(o.reason, 200)}`,
    detail: `观察到 ${md(app, until)}：这期间关注照读它的群、指标照取，每天的现状只提上线后的事；没有新问题会自动结束。`,
    refs: o.refs ?? [], runId: o.runId ?? null,
  });
  const c = itemContext(app, id);
  if (c && c.status !== "active" && c.byFlow) saveContext(app, { id: c.id, kind: "item", status: "active" });
  return getItem(app, id);
}

/** Back to 进行中 (the owner said 还没完, or the look saw it reopen). */
export function backToActive(app: App, id: string, o: { reason: string; by: "run" | "user"; runId?: string | null }) {
  const item = getItem(app, id);
  if (item.phase !== "watching" || isClosed(item.status)) return item;
  if (o.by === "user") { recordOutcome(app, item, "not-done", "user", o.reason); keep(app, id); }
  setPhase(app, id, null, null);
  addChange(app, { itemId: id, type: "stage", origin: "line", summary: `回到进行中：${truncate(o.reason, 200)}`, runId: o.runId ?? null });
  return getItem(app, id);
}

/** Still watching another week, silently (fresh activity, open problems, a moved metric). */
function extendWatch(app: App, item: Item, why: string) {
  const base = Math.max(Date.now(), Date.parse(item.watchUntil ?? now()));
  const until = new Date(base + EXTEND_DAYS * DAY).toISOString();
  run(app.db, "update items set watch_until = ?, updated_at = ? where id = ?", until, now(), item.id);
  addChange(app, { itemId: item.id, type: "info", origin: "line", summary: `还在观察，延到 ${md(app, until)}：${why}` });
  return until;
}

/** The owner's 再看一周 (card or page): watching until a week from now. */
export function keepWatching(app: App, id: string, days = EXTEND_DAYS) {
  const item = getItem(app, id);
  if (isClosed(item.status)) return item;
  recordOutcome(app, item, "keep-watching", "user");
  if (item.phase !== "watching") return enterWatching(app, id, { reason: `本人说再看 ${days} 天`, by: "user", days });
  const until = new Date(Date.now() + days * DAY).toISOString();
  run(app.db, "update items set watch_until = ?, updated_at = ? where id = ?", until, now(), id);
  addChange(app, { itemId: id, type: "info", origin: "line", summary: `本人说再看 ${days} 天：观察到 ${md(app, until)}` });
  app.emit({ type: "changed", entity: "item", id });
  return getItem(app, id);
}

// ------------------------------------------------------------------ ending

/** The reason the owner gave for an ending in progress, read by the status hook. */
const ending = new Map<string, string>();

/** Ended by the host (a watched line past its window, or a confident look): it shows in the next digest with 恢复. */
function autoEnd(app: App, item: Item, o: { status: "done" | "cancelled"; reason: string; runId?: string | null }) {
  recordOutcome(app, item, "auto-ended", "agent", o.reason);
  ending.set(item.id, o.reason);
  try {
    upsertItem(app, item.id, { status: o.status, note: `${LINE_ENDED}：${o.reason}。不对的话在工作页或清点卡片上恢复。` }, "agent", o.runId ?? undefined);
  } finally { ending.delete(item.id); }
  return getItem(app, item.id);
}

/**
 * The owner ends a line (the page, the card): done or dropped. With items still open under it, they are
 * closed with it only when asked to (`closeChildren`); otherwise 409.
 */
export function endLine(app: App, id: string, o: { status: "done" | "cancelled"; by: string; reason?: string; closeChildren?: boolean }) {
  const item = getItem(app, id);
  if (item.userId !== o.by) throw new HttpError(403, "只有这条线本人能结束它");
  if (item.parentId) throw new HttpError(400, "这件事挂在上层下面：在它的工作线上结束");
  if (isClosed(item.status)) throw new HttpError(409, "这条线已经结束了");
  const open = descendantIds(app, id).filter((c) => { const s = one<{ status: string }>(app.db, "select status from items where id = ?", c)?.status; return !!s && !isClosed(s) && s !== "candidate"; });
  if (open.length && !o.closeChildren) throw new HttpError(409, `下面还有 ${open.length} 件没结：一起结束，或先把它们移出这条线`);
  const reason = o.reason?.trim() || (o.status === "cancelled" ? "不做了" : "");
  ending.set(id, reason);
  try {
    upsertItem(app, id, { status: o.status, note: `${o.status === "cancelled" ? "本人放弃了这条线" : "本人结束了这条线"}${reason ? `：${reason}` : ""}` }, "user");
  } finally { ending.delete(id); }
  // The line first: its items closing then do not put it into 观察.
  for (const c of open.reverse()) upsertItem(app, c, { status: o.status, note: `随工作线「${truncate(item.title, 40)}」一起结束` }, "user");
  return getItem(app, id);
}

/** Opened again by the owner from the web (重新打开): status open; the status hook restores the rest. */
export function reopenLine(app: App, id: string, by: string) {
  const item = getItem(app, id);
  if (item.userId !== by) throw new HttpError(403, "只有这条线本人能重新打开它");
  if (!isClosed(item.status)) return item;
  return upsertItem(app, id, { status: "open", note: "本人重新打开了这条线" }, "user");
}

type Paused = { context: string | null; note: string; metrics: string[]; change: string | null };
const ENDED_NOTE = "这条线结束了";

/** What ending a line stops: its 关注 (with a note), its metrics and those under it, its open next steps, a pending question; then the wrap-up. */
function lineClosed(app: App, before: Item, after: Item, actor: "agent" | "user") {
  const paused: Paused = { context: null, note: "", metrics: [], change: null };
  const c = itemContext(app, after.id);
  if (c && c.status === "active") {
    paused.context = c.id;
    paused.note = c.note ?? "";
    saveContext(app, { id: c.id, kind: "item", status: "paused", note: `${ENDED_NOTE}（${md(app, now())}），关注先停下；重新打开这条线会接着读。${c.note ? ` 原来的说明：${c.note}` : ""}` });
  }
  const ids = [after.id, ...descendantIds(app, after.id)];
  // Proposals stop being taken too; opened again, they are proposals again (the owner has not decided).
  paused.metrics = all<{ id: string }>(app.db, `select id from metrics where status in ('active','proposed') and (item_id in (${ids.map(() => "?").join(",")}) or (? is not null and context_id = ?))`, ...ids, c?.id ?? null, c?.id ?? null).map((r) => r.id);
  if (paused.metrics.length) run(app.db, `update metrics set status = 'paused', updated_at = ? where id in (${paused.metrics.map(() => "?").join(",")})`, now(), ...paused.metrics);
  run(app.db, "update item_next set status = 'expired', updated_at = ? where item_id = ? and status = 'open'", now(), after.id);
  for (const a of all<{ id: string }>(app.db, "select id from asks where status = 'pending' and json_extract(context, '$.handler') = 'line-end' and json_extract(context, '$.lineId') = ?", after.id)) cancelAsk(app, a.id, "这条线已经结束了");
  const reason = ending.get(after.id) ?? "";
  const cancelled = after.status === "cancelled";
  if (actor === "user") recordOutcome(app, before, cancelled ? "owner-cancelled" : "owner-ended", "user", reason);
  paused.change = addChange(app, { itemId: after.id, type: "resolved", origin: "line", summary: `结束：${reason || (actor === "user" ? (cancelled ? "本人放弃了这条线" : "本人结束了这条线") : cancelled ? "取消了" : "标了完成")}` });
  setKv(app, PAUSED(after.id), JSON.stringify(paused));
  if (after.kind === "line" || descendantIds(app, after.id).length || one(app.db, "select 1 from item_flows where item_id = ?", after.id)) queueWrapUp(app, after);
}

/** Opened again: its 关注 and metrics as they were, back to 进行中, and (the owner's doing) kept from ending for a while. */
function lineReopened(app: App, before: Item, after: Item, actor: "agent" | "user") {
  const rec = json<Paused | null>(kv(app, PAUSED(after.id)) ?? "null", null);
  const c = rec?.context ? getContext(app, rec.context) : itemContext(app, after.id);
  if (c && c.status !== "active" && (rec?.context === c.id || c.note?.startsWith(ENDED_NOTE))) saveContext(app, { id: c.id, kind: "item", status: "active", note: rec?.context === c.id ? rec.note : "" });
  if (rec?.metrics.length) run(app.db, `update metrics set status = case when confirmed_at is null and defined_by = 'agent' then 'proposed' else 'active' end, updated_at = ? where status = 'paused' and id in (${rec.metrics.map(() => "?").join(",")})`, now(), ...rec.metrics);
  dropKv(app, PAUSED(after.id));
  setPhase(app, after.id, null, null);
  if (actor === "user") {
    const last = lineEndCases(app, after.userId, 50).find((x) => x.itemId === after.id && ["auto-ended", "owner-ended", "owner-cancelled"].includes(x.outcome ?? ""));
    recordOutcome(app, before, last?.outcome === "auto-ended" ? "restored" : "reopened", "user");
    keep(app, after.id);
  }
  addChange(app, { itemId: after.id, type: "stage", origin: "line", summary: actor === "user" ? "本人重新打开了这条线：关注和指标接着来" : "重新打开了：关注和指标接着来" });
}

/** A work item closed: a line whose items are now all closed, at least one done, goes into 观察. */
function childClosed(app: App, child: Item) {
  const root = rootOf(app, child.id);
  if (root === child.id) return;
  const line = getItem(app, root);
  if (line.kind !== "line" || line.phase || isClosed(line.status) || line.status === "candidate" || keptAt(app, root)) return;
  if (allItemsDone(app, root)) enterWatching(app, root, { reason: "下面的工作项都结了", by: "host" });
}

/** Everything under it closed, at least one done. */
function allItemsDone(app: App, id: string) {
  const rows = descendantIds(app, id).map((c) => one<{ status: string }>(app.db, "select status from items where id = ?", c)?.status).filter((s): s is string => !!s && s !== "candidate");
  return rows.length > 0 && rows.every(isClosed) && rows.includes("done");
}

onItemStatus((app, before, after, actor) => {
  const closing = isClosed(after.status) && !isClosed(before.status);
  const reopening = isClosed(before.status) && !isClosed(after.status) && after.status !== "candidate";
  if (!closing && !reopening) return;
  if (after.parentId) {
    if (closing) childClosed(app, after);
    return;
  }
  if (!lineLike(app, before) && !lineLike(app, after) && !kv(app, PAUSED(after.id))) return;
  if (closing) lineClosed(app, before, after, actor);
  else lineReopened(app, before, after, actor);
});

/** The flow of a top-level item ran to its end: with nothing open under it, 观察. (flows/engine.ts end) */
export function flowCompleted(app: App, itemId: string) {
  if (rootOf(app, itemId) !== itemId) return null;
  const item = getItem(app, itemId);
  if (isClosed(item.status) || item.phase || keptAt(app, itemId) || openUnder(app, itemId)) return null;
  return enterWatching(app, itemId, { reason: "流程走完了", by: "host" });
}

// ------------------------------------------------------------------ the wrap-up

/** One run after a line ended: it writes the closing summary (submit_line_state with `summary`). */
export function queueWrapUp(app: App, item: Item) {
  const lane = `line-wrap:${item.id}`;
  if (runsInLane(app, lane).length) return null;
  return createRun(app, {
    kind: "agent", spaceId: item.spaceId, lane, userId: item.userId,
    title: `收尾「${truncate(item.title, 40)}」`,
    input: {
      spec: "assistant", task: wrapUpTask(app, item), lineState: item.id, lineWrapUp: true,
      assistantScope: { spaces: [...new Set([item.spaceId, "personal"])], userId: item.userId, denyTools: [...lineStateDenied("suggest"), "upsert_item"], lark: { chats: [], draft: true } },
    },
  });
}

export function wrapUpTask(app: App, item: Item) {
  const tz = app.config.timezone;
  const ids = [item.id, ...descendantIds(app, item.id)];
  const kids = all<{ id: string; title: string; kind: string; status: string }>(app.db, `select id, title, kind, status from items where parent_id is not null and id in (${ids.map(() => "?").join(",")}) order by created_at`, ...ids);
  const changes = all<{ at: string; type: string; origin: string; summary: string; title: string }>(app.db,
    `select c.at, c.type, c.origin, c.summary, i.title from item_changes c join items i on i.id = c.item_id where c.item_id in (${ids.map(() => "?").join(",")}) and c.noise = 0 order by c.at desc limit 30`, ...ids);
  const metrics = all<{ id: string; name: string }>(app.db, `select id, name from metrics where item_id in (${ids.map(() => "?").join(",")})`, ...ids);
  const why = ending.get(item.id) ?? one<{ text: string }>(app.db, "select text from item_events where item_id = ? order by id desc limit 1", item.id)?.text ?? "";
  return [
    `# 给结束的工作线写收尾：${item.title}（${item.id}）`,
    "",
    `这条线 ${item.closedAt ? md(app, item.closedAt) : "今天"}结束了（状态 ${item.status}${why ? `；${truncate(why.split("\n")[0], 200)}` : ""}）。`,
    item.detail ? `\n目标：${truncate(item.detail, 600)}` : "",
    kids.length ? `\n## 下面的工作项\n\n${kids.map((k) => `- ${k.id}「${truncate(k.title, 60)}」[${k.kind}/${k.status}]`).join("\n")}` : "",
    changes.length ? `\n## 关键变化（新的在前）\n\n${changes.map((c) => `- ${new Date(c.at).toLocaleDateString("sv-SE", { timeZone: tz }).slice(5)} [${c.type}·${c.origin}]「${truncate(c.title, 30)}」${truncate(c.summary, 160)}`).join("\n")}` : "",
    `\n## 数据\n\n${metrics.length ? `指标：${metrics.map((m) => `${m.name}（${m.id}）`).join("、")}，用 metric_read 看上线前后的变化。` : "这条线没有挂指标。"}`,
    item.now ? `\n## 最后一次写的现状\n\n${item.now.text}` : "",
    "",
    "# 要你做的",
    "",
    "读这条线和下面的工作项、关键变化、材料和关注的会话（read_item、list_items parent=…、read_source、metric_read），用 submit_line_state 交：",
    "1. now：一句“截至结束……”，120 字以内。",
    "2. summary：收尾小结，分四小段：做成了什么（上线了什么、哪天）；关键的决定；上线后数字怎么样（有指标写数和变化，没有就写没挂指标）；还剩什么（没做的、转给谁、还要盯的）。只写有依据的，带引用（src:…#L…）。",
    "3. next 不填：线已经结束，不再提下一步。",
    "不发消息、不改事项、不建指标：宿主把小结放在这条线的页面和时间线上，周报会用到它。",
  ].filter((x) => x !== "").join("\n");
}

/** The wrap-up handed in its summary: kept on the line and on its closing change. */
export function saveWrapUp(app: App, item: Item, text: string, summary: string, runId: string) {
  const at = now();
  const state = { ...(item.now ?? { people: [], weeks: [] }), text, at, runId, summary, summaryAt: at };
  run(app.db, "update items set now = ? where id = ?", JSON.stringify(state), item.id);
  const rec = json<Paused | null>(kv(app, PAUSED(item.id)) ?? "null", null);
  if (rec?.change && one(app.db, "select 1 from item_changes where id = ?", rec.change)) run(app.db, "update item_changes set detail = ?, run_id = ?, updated_at = ? where id = ?", truncate(summary, 4000), runId, at, rec.change);
  else addChange(app, { itemId: item.id, type: "resolved", origin: "line", summary: `结束：${truncate(summary.split("\n").find((l) => l.trim()) ?? "", 120)}`, detail: summary, runId });
  app.emit({ type: "changed", entity: "item", id: item.id, spaceId: item.spaceId });
}

// ------------------------------------------------------------------ the look's judgement

export type PhaseJudgement = { state: "active" | "watching" | "done" | "cancelled"; reason: string; refs: string[]; confidence: number; days?: number };

/**
 * What the daily look judged about where the line is (submit_line_state `phase`). The host acts only
 * with enough confidence: 观察 at 0.6; ended at 0.8 with evidence and nothing holding it; a done it
 * is unsure of (0.5–0.8) while something holds the line is one question. Returns what it did, in words.
 */
export function judgePhase(app: App, id: string, p: PhaseJudgement, runId: string | null = null): string {
  const item = getItem(app, id);
  if (isClosed(item.status)) return "这条线已经结束了。";
  const kept = keptAt(app, id);
  if (kept && p.confidence < CONFIDENCE.end) return `本人 ${md(app, kept)} 说过还没完，这次先不改阶段。`;
  if (p.state === "active") {
    if (item.phase === "watching" && p.confidence >= CONFIDENCE.end) { backToActive(app, id, { reason: p.reason, by: "run", runId }); return "已回到进行中。"; }
    return "";
  }
  if (p.state === "watching") {
    if (!item.phase && p.confidence >= CONFIDENCE.watch) { enterWatching(app, id, { reason: p.reason, by: "run", days: p.days, refs: p.refs, runId }); return `已进入观察（${p.days ?? watchDays(app)} 天）。`; }
    return "";
  }
  const g = guardsOf(app, item);
  if (p.confidence >= CONFIDENCE.end && p.refs.length && quietGuards(g) && !kept) {
    autoEnd(app, item, { status: p.state === "cancelled" ? "cancelled" : "done", reason: p.reason, runId });
    return "依据够、线下也没有没结的事：已结束，明天的事项清点里会告诉本人，本人可以恢复。";
  }
  let did = "";
  if (!item.phase && p.confidence >= CONFIDENCE.watch) { enterWatching(app, id, { reason: p.reason, by: "run", days: p.days, refs: p.refs, runId }); did = "已进入观察。"; }
  if (p.confidence >= CONFIDENCE.ask && p.confidence < CONFIDENCE.end && !quietGuards(g)) {
    const a = askLineEnd(app, getItem(app, id), p.reason);
    if (a) did += "拿不准，问了本人一次。";
  }
  return did;
}

// ------------------------------------------------------------------ the one question

const CHOICES = ["结束", "再看一周", "还没完（回到进行中）"] as const;

function asksToday(app: App) {
  const p = zonedParts(new Date(), app.config.timezone);
  const start = new Date(Date.now() - (p.hour * 60 + p.minute) * 60_000).toISOString();
  return one<{ n: number }>(app.db, "select count(*) n from asks where json_extract(context, '$.handler') = 'line-end' and created_at >= ?", start)?.n ?? 0;
}

/** Whether this line may be asked about now: not kept lately, none pending, none in 14 days, under two today. */
export function mayAsk(app: App, id: string) {
  if (keptAt(app, id)) return false;
  if (one(app.db, "select 1 from asks where status = 'pending' and json_extract(context, '$.handler') = 'line-end' and json_extract(context, '$.lineId') = ?", id)) return false;
  const last = kv(app, ASKED(id));
  if (last && Date.now() - Date.parse(last) < ASK_EVERY_DAYS * DAY) return false;
  return asksToday(app) < ASKS_PER_DAY;
}

/** One card: 结束 / 再看一周 / 还没完 (host-handled, `line-end`). Null when the limits say not now. */
export function askLineEnd(app: App, item: Item, why: string): Ask | null {
  if (isClosed(item.status) || !mayAsk(app, item.id)) return null;
  const g = guardsOf(app, item);
  const hold = holdText(g);
  setKv(app, ASKED(item.id), now());
  return createAsk(app, {
    runId: null, conversationId: null, userId: item.userId, allowText: false,
    question: `「${item.title}」看起来差不多结束了：${truncate(why, 200)}。${hold ? `\n\n还开着的：${hold}。` : ""}\n\n要结束这条线吗？${g.openItems ? `点“结束”会把下面 ${g.openItems} 件没结的一起结束。` : ""}“再看一周”之后没有新问题会自动结束；“还没完”两周内不再问。`,
    options: CHOICES.map((label) => ({ label })),
    context: { handler: "line-end", lineId: item.id, why },
  });
}

registerAskHandler("line-end", async (app, ask, ctx) => {
  const id = String(ctx.lineId ?? "");
  const item = one(app.db, "select 1 from items where id = ?", id) ? getItem(app, id) : null;
  if (!item || isClosed(item.status)) return;
  const by = ask.answeredBy ?? ask.userId;
  const picked = ask.choice === null ? null : CHOICES[ask.choice];
  if (picked === "结束") endLine(app, id, { status: "done", by, reason: "本人在卡片上点了结束", closeChildren: true });
  else if (picked === "再看一周") keepWatching(app, id, EXTEND_DAYS);
  else if (picked === CHOICES[2]) {
    if (item.phase === "watching") backToActive(app, id, { reason: "本人在卡片上说还没完", by: "user" });
    else { recordOutcome(app, item, "not-done", "user", "本人在卡片上说还没完"); keep(app, id); }
  }
}, (_app, ask, _ctx, by) => {
  if (by !== ask.userId) throw new HttpError(403, "只有本人能定这条线要不要结束");
});

// ------------------------------------------------------------------ the heartbeat

/** Open top-level items shown as lines (the SQL twin of tree.ts lineLike). */
function liveLines(app: App) {
  return all<{ id: string }>(app.db,
    `select i.id from items i where i.parent_id is null and i.status in ('open','waiting','snoozed')
       and (i.kind = 'line' or i.phase is not null
         or exists(select 1 from items c where c.parent_id = i.id and c.status != 'candidate')
         or exists(select 1 from item_flows f where f.item_id = i.id)
         or exists(select 1 from listen_contexts x where x.kind = 'item' and x.item_id = i.id and x.status = 'active'))
     order by i.created_at`).map((r) => getItem(app, r.id));
}

/** Why a line that is not watched yet should be (no question): its items all closed, its flow ran to its end, or nothing moved in a todo's period. */
function readyToWatch(app: App, item: Item, at: number): string | null {
  if (item.kind === "line" && allItemsDone(app, item.id)) return "下面的工作项都结了";
  const open = openUnder(app, item.id);
  if (!open) {
    const f = one<{ ended_at: string | null }>(app.db, "select ended_at from item_flows where item_id = ?", item.id);
    if (f?.ended_at && one<{ how: string }>(app.db, "select how from item_flow_reviews where item_id = ? order by ended_at desc limit 1", item.id)?.how === "completed") return "流程走完了";
  }
  const period = app.config.items.days.todo;
  if (!open && at - Date.parse(item.createdAt) > period * DAY) {
    const g = guardsOf(app, item, at);
    if (!g.flowRunning && !g.pendingAsks && (!g.lastMoved || at - Date.parse(g.lastMoved) > period * DAY)) return `${period} 天没有新动静，下面也没有没结的事`;
  }
  return null;
}

/**
 * Heartbeat (agents/jobs.ts): lines ready for 观察 go there; watched lines past their window end
 * when nothing holds them, are watched another week when something is still happening, and are asked
 * about once when something stays open but nothing moves.
 */
export function lineLifecycleDue(app: App, at = Date.now()) {
  const out = { watching: [] as string[], ended: [] as string[], extended: [] as string[], asked: [] as string[] };
  for (const item of liveLines(app)) {
    if (keptAt(app, item.id, at)) continue;
    if (item.phase !== "watching") {
      const why = readyToWatch(app, item, at);
      if (why && enterWatching(app, item.id, { reason: why, by: "host" })) out.watching.push(item.id);
      continue;
    }
    if (item.watchUntil && Date.parse(item.watchUntil) > at) continue;
    const g = guardsOf(app, item, at);
    const watched = daysSince(item.phaseSince, at);
    if (quietGuards(g)) {
      autoEnd(app, item, { status: "done", reason: `观察了 ${watched} 天，没有新问题` });
      out.ended.push(item.id);
      continue;
    }
    const still = !g.lastMoved || at - Date.parse(g.lastMoved) >= STILL_DAYS * DAY;
    if (!busy(g) && watched > 2 * watchDays(app) && still && askLineEnd(app, item, `观察了 ${watched} 天，最近 ${STILL_DAYS} 天没有动静`)) {
      out.asked.push(item.id);
      continue;
    }
    extendWatch(app, item, holdText(g) || "还有没结的事");
    out.extended.push(item.id);
  }
  return out;
}

// ------------------------------------------------------------------ for the pages

/** The reason a line ended, as its latest ending said it. */
export function endReason(app: App, id: string) {
  const e = one<{ text: string }>(app.db, "select text from item_events where item_id = ? and kind = 'line-end' order by id desc limit 1", id)?.text;
  if (e && ["auto-ended", "owner-ended", "owner-cancelled"].includes(outcomeOf(e) ?? "")) return e.replace(META, "").trim().replace(/（[^（）]*）$/, "");
  return null;
}

export type EndedLine = { id: string; title: string; status: string; closedAt: string | null; summary: string | null; reason: string | null; spaceId: string };

/** The person's ended lines, newest first; `before` pages, `q` searches titles, goals and summaries. */
export function endedLines(app: App, userId: string, opts: { before?: string; q?: string; limit?: number; spaces?: string[] | null } = {}): { items: EndedLine[]; more: boolean } {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const q = opts.q?.trim();
  const rows = all<{ id: string; title: string; status: string; closed_at: string | null; now: string | null; space_id: string }>(app.db,
    `select i.id, i.title, i.status, i.closed_at, i.now, i.space_id from items i
      where i.parent_id is null and i.status in ('done','cancelled','expired') and coalesce(i.user_id,'owner') = ?
        and (i.kind = 'line' or i.phase is not null
          or exists(select 1 from items c where c.parent_id = i.id and c.status != 'candidate')
          or exists(select 1 from item_flows f where f.item_id = i.id)
          or exists(select 1 from item_events e where e.item_id = i.id and e.kind = 'line-end'))
        ${opts.before ? "and coalesce(i.closed_at, i.updated_at) < ?" : ""}
        ${q ? "and (i.title like ? or i.detail like ? or i.now like ?)" : ""}
        ${opts.spaces ? `and i.space_id in (${opts.spaces.map(() => "?").join(",") || "''"})` : ""}
      order by coalesce(i.closed_at, i.updated_at) desc, i.id desc limit ?`,
    userId, ...(opts.before ? [opts.before] : []), ...(q ? [`%${q}%`, `%${q}%`, `%${q}%`] : []), ...(opts.spaces ?? []), limit + 1);
  return {
    items: rows.slice(0, limit).map((r) => ({
      id: r.id, title: r.title, status: r.status, closedAt: r.closed_at, spaceId: r.space_id,
      summary: json<{ summary?: string } | null>(r.now, null)?.summary ?? null,
      reason: endReason(app, r.id),
    })),
    more: rows.length > limit,
  };
}

/** The owner sets a line's phase from the web (PUT /api/work/:id/phase). */
export function setLinePhase(app: App, id: string, by: string, b: { phase: "active" | "watching" | "done" | "cancelled"; closeChildren?: boolean; days?: number; reason?: string }) {
  const item = getItem(app, id);
  if (item.userId !== by) throw new HttpError(403, "只有这条线本人能改它的阶段");
  if (item.parentId) throw new HttpError(400, "这件事挂在上层下面：在它的工作线上改");
  if (b.phase === "done" || b.phase === "cancelled") return endLine(app, id, { status: b.phase, by, reason: b.reason, closeChildren: b.closeChildren });
  if (isClosed(item.status)) reopenLine(app, id, by);
  if (b.phase === "watching") return enterWatching(app, id, { reason: b.reason?.trim() || "本人说先观察", by: "user", days: b.days }) ?? getItem(app, id);
  const now2 = getItem(app, id);
  return now2.phase === "watching" ? backToActive(app, id, { reason: b.reason?.trim() || "本人说还没完", by: "user" }) : now2;
}
