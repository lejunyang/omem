import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { json, newId, now, truncate } from "../core/util.ts";
import { descendantIds, rootOf } from "./tree.ts";

/**
 * The key changes of an item (`item_changes`), one change each: a sentence, why, what it risks, what
 * comes next, where it came from. Several writers share the table (docs/v2/status.md “工作线”):
 *
 * - `follow`: item-follow reading the item's groups and documents (flows/follow.ts), the only one that
 *   asks the owner (status `asked`);
 * - `flow`: a stage done, stuck, or waiting on the owner (flows/store.ts changeStage);
 * - `metric`: a metric of the item moved past its mark (data/metrics.ts);
 * - `problem`: a problem its 关注 was following got its conclusion (channels/listen-problems.ts);
 * - `owner`: what the owner settled themselves.
 *
 * All but `follow` are written as `noted`: they never ask and never make cards. A line's timeline is its
 * own changes together with those of everything under it.
 */
export type ChangeOrigin = "follow" | "flow" | "metric" | "problem" | "owner";
export const CHANGE_TYPES = ["scope", "decision", "deadline", "blocker", "info", "stage", "result", "owner", "resolved"] as const;
export type ChangeType = (typeof CHANGE_TYPES)[number];

export type ChangeLite = {
  id: string; at: string; type: string; summary: string; detail: string | null; risk: string | null; next: string | null;
  refs: string[]; status: string; origin: string; noise: boolean; itemId: string; itemTitle: string; lineId: string; lineTitle: string;
};
type Row = { id: string; item_id: string; at: string; type: string; summary: string; detail: string | null; risk: string | null; next: string | null; refs: string; status: string; origin: string; noise: number; title: string };

const titleOf = (app: App, id: string) => one<{ title: string }>(app.db, "select title from items where id = ?", id)?.title ?? id;
export function changeLite(app: App, r: Row, lines = new Map<string, { id: string; title: string }>()): ChangeLite {
  let line = lines.get(r.item_id);
  if (!line) {
    const id = rootOf(app, r.item_id);
    line = { id, title: id === r.item_id ? r.title : titleOf(app, id) };
    lines.set(r.item_id, line);
  }
  return {
    id: r.id, at: r.at, type: r.type, summary: r.summary, detail: r.detail, risk: r.risk, next: r.next, refs: json<string[]>(r.refs, []),
    status: r.status, origin: r.origin ?? "follow", noise: !!r.noise, itemId: r.item_id, itemTitle: r.title, lineId: line.id, lineTitle: line.title,
  };
}
export const CHANGE_COLS = "c.id, c.item_id, c.at, c.type, c.summary, c.detail, c.risk, c.next, c.refs, c.status, c.origin, c.noise, i.title";

/** A change one of the host's writers saw (never `follow`): noted, no card, on the item's timeline. */
export function addChange(app: App, c: { itemId: string; type: ChangeType; summary: string; detail?: string | null; risk?: string | null; next?: string | null; refs?: string[]; runId?: string | null; origin: Exclude<ChangeOrigin, "follow"> }) {
  if (!one(app.db, "select 1 from items where id = ?", c.itemId)) return null;
  const id = newId("ic"), at = now();
  run(app.db, "insert into item_changes(id,item_id,at,type,summary,detail,refs,run_id,status,updated_at,risk,next,origin) values(?,?,?,?,?,?,?,?,'noted',?,?,?,?)",
    id, c.itemId, at, c.type, truncate(c.summary.replace(/\s+/g, " ").trim(), 300), c.detail?.trim() ? truncate(c.detail.trim(), 4000) : null, JSON.stringify(c.refs ?? []), c.runId ?? "", at, c.risk ?? null, c.next ?? null, c.origin);
  app.emit({ type: "changed", entity: "item", id: c.itemId });
  return id;
}

/**
 * The changes of an item and everything under it, newest first (`before`: older than this time, for
 * paging), with the title of the item each belongs to. Changes the owner marked as of no use are left
 * out unless `noise` is asked for.
 */
export function lineTimeline(app: App, itemId: string, opts: { limit?: number; before?: string; noise?: boolean } = {}): ChangeLite[] {
  const ids = [itemId, ...descendantIds(app, itemId)];
  const rows = all<Row>(app.db, `select ${CHANGE_COLS} from item_changes c join items i on i.id = c.item_id
    where c.item_id in (${ids.map(() => "?").join(",")}) ${opts.before ? "and c.at < ?" : ""} ${opts.noise ? "" : "and c.noise = 0"}
    order by c.at desc, c.id desc limit ?`, ...ids, ...(opts.before ? [opts.before] : []), opts.limit ?? 50);
  const lines = new Map<string, { id: string; title: string }>();
  return rows.map((r) => changeLite(app, r, lines));
}
