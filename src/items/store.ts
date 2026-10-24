import type { App } from "../core/app.ts";
import { all, one, run, tx } from "../core/db.ts";
import { HttpError, json, newId, now } from "../core/util.ts";

export type ItemKind = "todo" | "waiting" | "reminder" | "watch" | "decision";
/** expired: closed by itself after its period passed with no progress (src/items/expiry.ts), not done. */
export type ItemStatus = "open" | "waiting" | "snoozed" | "done" | "cancelled" | "expired";
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

export function addItemEvent(app: App, itemId: string, kind: string, text: string, actor = "agent", sourceRefs: string[] = []) {
  run(app.db, "insert into item_events(item_id,at,kind,text,source_refs,actor) values(?,?,?,?,?,?)", itemId, now(), kind, text, JSON.stringify(sourceRefs), actor);
}

export type ItemInput = Partial<Omit<Item, "id" | "createdAt" | "updatedAt" | "closedAt">> & { note?: string; sourceRefsMode?: "merge" | "replace" | "remove"; expectedSourceRefs?: string[] };

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

function itemTx<T>(app: App, fn: () => T): T {
  return app.db.isTransaction ? fn() : tx(app.db, fn);
}

/** Create or update an item; every change is recorded on its timeline with who made it. */
export function upsertItem(app: App, id: string | undefined, input: ItemInput, actor: "agent" | "user" = "agent"): Item {
  const at = now();
  if (input.sourceRefsMode && input.sourceRefsMode !== "merge" && !id) throw new HttpError(400, "来源纠正必须指定已有事项");
  if (!id) {
    if (!input.title) throw new HttpError(400, "事项需要标题");
    const newIdValue = newId("i");
    const kind = input.kind ?? "todo";
    const status = input.status ?? (kind === "waiting" ? "waiting" : "open");
    itemTx(app, () => {
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
      addItemEvent(app, newIdValue, "created", input.note || `创建：${input.title}`, actor, input.sourceRefs ?? []);
    });
    app.emit({ type: "changed", entity: "item", id: newIdValue, spaceId: input.spaceId ?? "personal" });
    return getItem(app, newIdValue);
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
  itemTx(app, () => {
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
    if (input.remindAt && input.remindAt !== old.remindAt) addItemEvent(app, id, "reminder-scheduled", `提醒：${input.remindAt}`, actor, input.sourceRefs ?? []);
    if (mode !== "merge") addItemEvent(app, id, "sources-corrected", JSON.stringify({ reason: input.note, mode, before: old.sourceRefs, after: nextRefs }), actor, []);
    if (changes.length || input.note || JSON.stringify(nextRefs) !== JSON.stringify(old.sourceRefs)) addItemEvent(app, id, changes.length ? "updated" : "note", [input.note, changes.join("；")].filter(Boolean).join("\n"), actor, mode === "remove" ? [] : input.sourceRefs ?? []);
  });
  app.emit({ type: "changed", entity: "item", id, spaceId: old.spaceId });
  return getItem(app, id);
}

function fmt(v: unknown) {
  if (v === null || v === undefined || v === "") return "无";
  return String(v);
}

export function listItems(app: App, opts: { spaceIds?: string[]; spaceId?: string; status?: string; kind?: string; q?: string; limit?: number; userId?: string }) {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (opts.userId) where.push("user_id = ?"), params.push(opts.userId);
  if (opts.spaceIds) { where.push(`space_id in (${opts.spaceIds.map(() => "?").join(",") || "NULL"})`); params.push(...opts.spaceIds); }
  if (opts.spaceId) where.push("space_id = ?"), params.push(opts.spaceId);
  if (opts.status === "active") where.push("status in ('open','waiting','snoozed')");
  else if (opts.status && opts.status !== "all") where.push("status = ?"), params.push(opts.status);
  if (opts.kind) where.push("kind = ?"), params.push(opts.kind);
  if (opts.q) where.push("(title like ? or detail like ? or waiting_on like ?)"), params.push(`%${opts.q}%`, `%${opts.q}%`, `%${opts.q}%`);
  return all<Row>(
    app.db,
    `select * from items ${where.length ? "where " + where.join(" and ") : ""}
     order by case status when 'open' then 0 when 'waiting' then 1 when 'snoozed' then 2 else 3 end, priority, coalesce(due_at, remind_at, updated_at) limit ?`,
    ...params,
    opts.limit ?? 300,
  ).map(toItem);
}

/** Items whose reminder time has passed and are not closed. */
export function dueReminders(app: App, at = now()) {
  return all<Row>(app.db, "select * from items where status in ('open','waiting','snoozed') and remind_at is not null and remind_at <= ?", at).map(toItem);
}

/** Reminder evidence belongs to the scheduling event, not the item's later progress. */
export function reminderSourceRefs(app: App, item: Item) {
  return [...itemEvents(app, item.id)].reverse().find((e) => e.kind === "reminder-scheduled" || (e.kind === "updated" && e.text.includes("提醒：")) || e.kind === "created")?.sourceRefs.filter((r) => item.sourceRefs.includes(r)) ?? [];
}
