import type { App } from "../core/app.ts";
import { enqueuePluginEvent } from "../plugins/event-store.ts";
import { lapseItemAsks } from "../agents/ask-expiry.ts";
import { all, one, run, withinTx } from "../core/db.ts";
import { HttpError, json, newId, now } from "../core/util.ts";
import { emitOmem } from "../rules/omem-events.ts";
import { noteAutoOutcome } from "./auto-cases.ts";

/** `line`: a work line (items/lines.ts): what the owner is pushing on these weeks, with its work items hung under it. */
export type ItemKind = "todo" | "waiting" | "reminder" | "watch" | "decision" | "line";
export const ITEM_KINDS = ["todo", "waiting", "reminder", "watch", "decision", "line"] as const;
/** Where a line stands (items/lines.ts submitLineState): one sentence as of today, the people and what each does, the last weeks. */
export type LineNow = {
  text: string; people: { name: string; openId?: string; role: string }[]; weeks: { label: string; text: string }[]; at: string; runId: string | null;
  /** The closing summary written once the line ended (items/lifecycle.ts): what shipped, key decisions, the numbers after launch, what is left. */
  summary?: string; summaryAt?: string;
};
/** Where a line is in its life (items/lifecycle.ts): null 进行中, `watching` 观察中 until `watchUntil`; 已结束 is a closed status. */
export type LinePhase = "watching";
/**
 * expired: closed by itself after its period passed with no progress (src/items/expiry.ts), not done.
 * candidate: made by the assistant on its own and not yet wanted (src/items/auto.ts): out of the lists,
 * no reminders, until the owner keeps it (open) or not (cancelled).
 */
export type ItemStatus = "open" | "waiting" | "snoozed" | "done" | "cancelled" | "expired" | "candidate";
export const CLOSED_STATUSES: readonly ItemStatus[] = ["done", "cancelled", "expired"];
export const isClosed = (s: string) => (CLOSED_STATUSES as readonly string[]).includes(s);
export type Item = {
  id: string;
  spaceId: string;
  kind: ItemKind;
  title: string;
  detail: string;
  status: ItemStatus;
  priority: number;
  dueAt: string | null;
  remindAt: string | null;
  waitingOn: string | null;
  watch: { query?: string; spaces?: string[]; sources?: string[]; lastCheckedAt?: string } | null;
  sourceRefs: string[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  /** Whose item it is (the owner unless omem has more users). */
  userId: string;
  /** The item it hangs under (a line, or a requirement a defect belongs to): items/tree.ts. */
  parentId: string | null;
  /** A line's state as last written (items/lines.ts). */
  now: LineNow | null;
  /** A line's phase and since when; while watching, until when (items/lifecycle.ts). */
  phase: LinePhase | null;
  phaseSince: string | null;
  watchUntil: string | null;
};
export type ItemEvent = { id: number; itemId: string; at: string; kind: string; text: string; sourceRefs: string[]; actor: string };

type Row = {
  id: string;
  space_id: string;
  kind: string;
  title: string;
  detail: string;
  status: string;
  priority: number;
  due_at: string | null;
  remind_at: string | null;
  waiting_on: string | null;
  watch: string | null;
  source_refs: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  user_id: string;
  parent_id: string | null;
  now: string | null;
  phase: string | null;
  phase_since: string | null;
  watch_until: string | null;
};
const toItem = (r: Row): Item => ({
  id: r.id,
  spaceId: r.space_id,
  kind: r.kind as ItemKind,
  title: r.title,
  detail: r.detail,
  status: r.status as ItemStatus,
  priority: r.priority,
  dueAt: r.due_at,
  remindAt: r.remind_at,
  waitingOn: r.waiting_on,
  watch: json(r.watch, null),
  sourceRefs: json(r.source_refs, []),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  closedAt: r.closed_at,
  userId: r.user_id ?? "owner",
  parentId: r.parent_id ?? null,
  now: json<LineNow | null>(r.now, null),
  phase: r.phase === "watching" ? "watching" : null,
  phaseSince: r.phase_since ?? null,
  watchUntil: r.watch_until ?? null,
});

export function getItem(app: App, id: string): Item {
  const r = one<Row>(app.db, "select * from items where id = ?", id);
  if (!r) throw new HttpError(404, `事项不存在：${id}`);
  return toItem(r);
}

export function itemEvents(app: App, id: string): ItemEvent[] {
  return all<{ id: number; item_id: string; at: string; kind: string; text: string; source_refs: string; actor: string }>(
    app.db,
    "select * from item_events where item_id = ? order by id",
    id,
  ).map((e) => ({ id: e.id, itemId: e.item_id, at: e.at, kind: e.kind, text: e.text, sourceRefs: json(e.source_refs, []), actor: e.actor }));
}

export function addItemEvent(app: App, itemId: string, kind: string, text: string, actor = "agent", sourceRefs: string[] = [], runId?: string) {
  run(app.db, "insert into item_events(item_id,at,kind,text,source_refs,actor,run_id) values(?,?,?,?,?,?,?)", itemId, now(), kind, text, JSON.stringify(sourceRefs), actor, runId ?? null);
}

export type ItemInput = Partial<Omit<Item, "id" | "createdAt" | "updatedAt" | "closedAt" | "parentId" | "now" | "phase" | "phaseSince" | "watchUntil">> & { providerUrl?: string; note?: string; sourceRefsMode?: "merge" | "replace" | "remove"; expectedSourceRefs?: string[] };

const FIELD_LABEL: Record<string, string> = {
  title: "标题",
  detail: "详情",
  status: "状态",
  priority: "优先级",
  dueAt: "截止",
  remindAt: "提醒",
  waitingOn: "等待对象",
  kind: "类型",
};

/**
 * Who hears of an item's status moving (after it is written): a line's lifecycle (items/lifecycle.ts)
 * pauses its 关注 and metrics when it ends and restores them when it opens again. A hook that throws is
 * logged and never undoes the change.
 */
export type StatusHook = (app: App, before: Item, after: Item, actor: "agent" | "user") => void;
const statusHooks: StatusHook[] = [];
export function onItemStatus(fn: StatusHook) {
  if (!statusHooks.includes(fn)) statusHooks.push(fn);
}

function itemFact(app: App, item: Pick<Item, "spaceId" | "id" | "kind" | "status" | "title" | "parentId" | "userId">, from: ItemStatus | null, actor: "user" | "agent", createdUrl?: string) {
  enqueuePluginEvent(app, from === null ? "item.created" : "item.status", item.spaceId, () => {
    const providerUrl = createdUrl ?? one<{ url: string }>(app.db, `select json_extract(l.snapshot,'$.url') as url
      from external_item_links l join item_provider_targets t on t.id=l.target_id
      where l.item_id=? and l.user_id=? and t.space_id=?`, item.id, item.userId, item.spaceId)?.url;
    const materials = all<{ link: string }>(app.db, `select o.link from item_materials m join flow_objects o on o.id=m.ref
      where m.item_id=? and m.kind='object' order by m.id limit 100`, item.id);
    const links = [...new Set([...(providerUrl ? [providerUrl] : []), ...materials.map(o => o.link)])];
    return {
      entity: { kind: "item", id: item.id }, actor: { kind: actor }, userId: item.userId,
      data: { title: item.title, kind: item.kind, from, status: item.status, parentId: item.parentId, links },
    };
  });
}

/** Create or update an item; every change is recorded on its timeline with who made it. */
export function upsertItem(app: App, id: string | undefined, input: ItemInput, actor: "agent" | "user" = "agent", runId?: string): Item {
  const at = now();
  if (input.sourceRefsMode && input.sourceRefsMode !== "merge" && !id) throw new HttpError(400, "来源纠正必须指定已有事项");
  if (!id) {
    if (!input.title) throw new HttpError(400, "事项需要标题");
    const newIdValue = newId("i");
    const kind = input.kind ?? "todo";
    const status = input.status ?? (kind === "waiting" ? "waiting" : "open");
    withinTx(app.db, () => {
      run(
        app.db,
        "insert into items(id,space_id,kind,title,detail,status,priority,due_at,remind_at,waiting_on,watch,source_refs,created_at,updated_at,user_id) values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        newIdValue,
        input.spaceId ?? "personal",
        kind,
        input.title!,
        input.detail ?? "",
        status,
        input.priority ?? 2,
        input.dueAt ?? null,
        input.remindAt ?? null,
        input.waitingOn ?? null,
        input.watch ? JSON.stringify(input.watch) : null,
        JSON.stringify(input.sourceRefs ?? []),
        at,
        at,
        input.userId ?? "owner",
      );
      itemFact(app, { id: newIdValue, kind, status, title: input.title!, parentId: null, spaceId: input.spaceId ?? "personal", userId: input.userId ?? "owner" }, null, actor, input.providerUrl);
      addItemEvent(app, newIdValue, "created", input.note || `创建：${input.title}`, actor, input.sourceRefs ?? [], runId);
    });
    app.emit({ type: "changed", entity: "item", id: newIdValue, spaceId: input.spaceId ?? "personal" });
    const made = getItem(app, newIdValue);
    // A candidate is not an item yet: rules hear of it when the owner keeps it (item.status).
    if (made.status !== "candidate") emitOmem(app, { type: "item.created", id: made.id, title: made.title, kind: made.kind, status: made.status, space: made.spaceId, item: { id: made.id, title: made.title }, ...(runId ? { runId } : {}) });
    return made;
  }
  const old = getItem(app, id);
  const mode = input.sourceRefsMode ?? "merge";
  if (mode !== "merge") {
    if (!input.note?.trim() || !input.sourceRefs?.length || !input.expectedSourceRefs)
      throw new HttpError(400, "来源纠正需要原因、非空来源和 expectedSourceRefs；清空请逐条 remove");
    if (JSON.stringify([...old.sourceRefs].sort()) !== JSON.stringify([...input.expectedSourceRefs].sort()))
      throw new HttpError(409, "事项来源已变化，请重读后重试");
    if (mode === "remove" && input.sourceRefs.some((r) => !old.sourceRefs.includes(r))) throw new HttpError(400, "只能移除该事项已有的来源");
  }
  const nextRefs = mode === "replace" ? [...new Set(input.sourceRefs)] : mode === "remove" ? old.sourceRefs.filter((r) => !input.sourceRefs!.includes(r)) : [...new Set([...old.sourceRefs, ...(input.sourceRefs ?? [])])];
  const next = { ...old, ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) } as Item;
  // An item that expired for lack of progress opens again when progress arrives: new evidence or a note.
  const revived = old.status === "expired" && input.status === undefined && (!!input.note?.trim() || (input.sourceRefs ?? []).some((r) => !old.sourceRefs.includes(r)));
  if (revived) next.status = next.kind === "waiting" ? "waiting" : "open";
  const changes: string[] = [];
  for (const key of Object.keys(FIELD_LABEL) as (keyof Item)[])
    if (input[key as keyof ItemInput] !== undefined && JSON.stringify(old[key]) !== JSON.stringify(next[key]))
      changes.push(`${FIELD_LABEL[key]}：${fmt(old[key])} → ${fmt(next[key])}`);
  if (revived) changes.push(`状态：expired → ${next.status}（有新进展，重新打开）`);
  const closing = isClosed(next.status) && !isClosed(old.status);
  const reopening = !isClosed(next.status) && isClosed(old.status);
  withinTx(app.db, () => {
    run(
      app.db,
      "update items set kind=?, title=?, detail=?, status=?, priority=?, due_at=?, remind_at=?, waiting_on=?, watch=?, source_refs=?, updated_at=?, closed_at=? where id=?",
      next.kind,
      next.title,
      next.detail,
      next.status,
      next.priority,
      next.dueAt,
      next.remindAt,
      next.waitingOn,
      next.watch ? JSON.stringify(next.watch) : null,
      JSON.stringify(nextRefs),
      at,
      closing ? at : reopening ? null : old.closedAt,
      id,
    );
    if (next.status !== old.status) itemFact(app, { ...next, userId: old.userId, spaceId: old.spaceId }, old.status, actor);
    if (input.remindAt && input.remindAt !== old.remindAt) addItemEvent(app, id, "reminder-scheduled", `提醒：${input.remindAt}`, actor, input.sourceRefs ?? [], runId);
    if (mode !== "merge") addItemEvent(app, id, "sources-corrected", JSON.stringify({ reason: input.note, mode, before: old.sourceRefs, after: nextRefs }), actor, [], runId);
    if (changes.length || input.note || JSON.stringify(nextRefs) !== JSON.stringify(old.sourceRefs)) addItemEvent(app, id, changes.length ? "updated" : "note", [input.note, changes.join("；")].filter(Boolean).join("\n"), actor, mode === "remove" ? [] : input.sourceRefs ?? [], runId);
  });
  app.emit({ type: "changed", entity: "item", id, spaceId: old.spaceId });
  // What the owner did with an item the assistant made on its own teaches the roles that make them (items/auto-cases.ts).
  if (next.status !== old.status) {
    try { noteAutoOutcome(app, old, next.status, actor); } catch (e) { console.warn(`[omem] 记录自动事项的取舍失败：${(e as Error).message}`); }
  }
  if (next.status !== old.status) emitOmem(app, { type: "item.status", id, title: next.title, kind: next.kind, status: next.status, from: old.status, space: old.spaceId, item: { id, title: next.title }, ...(runId ? { runId } : {}) });
  if (next.status !== old.status && statusHooks.length) {
    const after = getItem(app, id);
    for (const h of statusHooks) {
      try { h(app, old, after, actor); } catch (e) { console.warn(`[omem] 事项状态变化的后续处理失败：${(e as Error).message}`); }
    }
  }
  // An item that ended gives back the workspaces its delegations still hold (their branches stay).
  if (closing) void import("../agents/code-branch.ts").then((m) => m.releaseItemWorkspaces(app, id)).catch(() => {});
  // …and what its runs still ask lapses, its notifications count as read (agents/ask-expiry.ts).
  if (closing) lapseItemAsks(app, id);
  return getItem(app, id);
}

function fmt(v: unknown) {
  if (v === null || v === undefined || v === "") return "无";
  return String(v);
}

export function listItems(app: App, opts: { spaceIds?: string[]; spaceId?: string; status?: string; kind?: string; q?: string; limit?: number; userId?: string; parentId?: string; topLevel?: boolean }) {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (opts.userId) where.push("user_id = ?"), params.push(opts.userId);
  if (opts.parentId) where.push("parent_id = ?"), params.push(opts.parentId);
  if (opts.topLevel) where.push("parent_id is null");
  if (opts.spaceIds) { where.push(`space_id in (${opts.spaceIds.map(() => "?").join(",") || "NULL"})`); params.push(...opts.spaceIds); }
  if (opts.spaceId) where.push("space_id = ?"), params.push(opts.spaceId);
  if (opts.status === "active") where.push("status in ('open','waiting','snoozed')");
  else if (opts.status && opts.status !== "all") where.push("status = ?"), params.push(opts.status);
  if (opts.kind) where.push("kind = ?"), params.push(opts.kind);
  if (opts.q) where.push("(title like ? or detail like ? or waiting_on like ?)"), params.push(`%${opts.q}%`, `%${opts.q}%`, `%${opts.q}%`);
  return all<Row>(
    app.db,
    `select * from items ${where.length ? "where " + where.join(" and ") : ""}
     order by case status when 'open' then 0 when 'waiting' then 1 when 'snoozed' then 2 else 3 end, priority, coalesce(${UTC("due_at")}, ${UTC("remind_at")}, updated_at) limit ?`,
    ...params,
    opts.limit ?? 300,
  ).map(toItem);
}

/**
 * A due or reminder time as UTC in SQL. They are stored as written (`2026-10-28T17:00:00+08:00`, which
 * the agents read back as the owner's time); compared as text with `now()` (UTC, `…Z`) a time with
 * an offset east of UTC would come out hours late.
 */
export const UTC = (col: string) => `strftime('%Y-%m-%dT%H:%M:%fZ', ${col})`;

/** Items whose reminder time has passed and are not closed. */
export function dueReminders(app: App, at = now()) {
  return all<Row>(app.db, `select * from items where status in ('open','waiting','snoozed') and remind_at is not null and ${UTC("remind_at")} <= ?`, at).map(toItem);
}

/** Reminder evidence belongs to the scheduling event, not the item's later progress. */
export function reminderSourceRefs(app: App, item: Item) {
  return [...itemEvents(app, item.id)].reverse().find((e) => e.kind === "reminder-scheduled" || (e.kind === "updated" && e.text.includes("提醒：")) || e.kind === "created")?.sourceRefs.filter((r) => item.sourceRefs.includes(r)) ?? [];
}
