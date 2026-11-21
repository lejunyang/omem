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
 * - `owner`: what the owner settled themselves;
 * - `line`: the line's own life (items/lifecycle.ts): it went into 观察, its watch was extended, it
 *   ended (with its closing summary) or opened again.
 *
 * All but `follow` are written as `noted`: they never ask and never make cards. A line's timeline is its
 * own changes together with those of everything under it.
 */
export type ChangeOrigin = "follow" | "flow" | "metric" | "problem" | "owner" | "line";
export const CHANGE_TYPES = ["scope", "decision", "deadline", "blocker", "info", "stage", "result", "owner", "resolved"] as const;
export type ChangeType = (typeof CHANGE_TYPES)[number];

export type ChangeLite = {
  id: string; at: string; type: string; summary: string; detail: string | null; risk: string | null; next: string | null;
  refs: string[]; status: string; origin: string; noise: boolean; itemId: string; itemTitle: string; lineId: string; lineTitle: string;
  /** The references that are no citation and name an item or a run of the same person (refTargets); only when there are any. */
  refTargets?: Record<string, RefTarget>;
};
type Row = { id: string; item_id: string; at: string; type: string; summary: string; detail: string | null; risk: string | null; next: string | null; refs: string; status: string; origin: string; noise: number; title: string; item_user?: string };

/**
 * What a reference that is no citation names, so the web can link it by name: an item (its page under
 * 工作) or a run, both of the same person. Changes and next steps cite these as `i0…` / `item:i0…` and
 * `r0…` / `run:r0…` / `code-work:r0…`; anything else (a stage, a metric's name, a word) is left out and
 * shown as plain text. One lookup by primary key per such reference; citations (src: / mem: / msg:) cost nothing.
 */
export type RefTarget = { kind: "item" | "run"; id: string; title: string };
const ITEM_REF = /^(?:item:([\w-]+)|(i[0-9a-z]{15,30}))$/;
const RUN_REF = /^(?:(?:run|code-work):([\w-]+)|(r[0-9a-z]{15,30}))$/;
export function refTargets(app: App, refs: string[], userId: string): Record<string, RefTarget> | undefined {
  const out: Record<string, RefTarget> = {};
  for (const ref of refs) {
    const r = ref.trim();
    const item = ITEM_REF.exec(r);
    if (item) {
      const id = item[1] ?? item[2];
      const row = one<{ title: string; u: string }>(app.db, "select title, coalesce(user_id,'owner') u from items where id = ?", id);
      if (row && row.u === userId) out[ref] = { kind: "item", id, title: row.title };
      continue;
    }
    const runRef = RUN_REF.exec(r);
    if (runRef) {
      const id = runRef[1] ?? runRef[2];
      const row = one<{ title: string; kind: string; u: string }>(app.db, "select title, kind, coalesce(user_id,'owner') u from runs where id = ?", id);
      if (row && row.u === userId) out[ref] = { kind: "run", id, title: row.title || row.kind };
    }
  }
  return Object.keys(out).length ? out : undefined;
}

const TEXT_ID = /(?<![0-9A-Za-z_])[ir]0m[0-9a-z]{12,}(?![0-9A-Za-z_])/g;
/**
 * The items and runs named by a bare id inside text an agent wrote (a goal, a line's state, a reason):
 * the page shows the title and a link instead of the id (web/src/lib/work.ts readableIds).
 */
export function textTargets(app: App, texts: (string | null | undefined)[], userId: string) {
  const ids = new Set<string>();
  for (const t of texts) for (const m of (t ?? "").matchAll(TEXT_ID)) if (ids.size < 80) ids.add(m[0]);
  return ids.size ? refTargets(app, [...ids], userId) : undefined;
}

const titleOf = (app: App, id: string) => one<{ title: string }>(app.db, "select title from items where id = ?", id)?.title ?? id;
export function changeLite(app: App, r: Row, lines = new Map<string, { id: string; title: string }>()): ChangeLite {
  let line = lines.get(r.item_id);
  if (!line) {
    const id = rootOf(app, r.item_id);
    line = { id, title: id === r.item_id ? r.title : titleOf(app, id) };
    lines.set(r.item_id, line);
  }
  const refs = json<string[]>(r.refs, []);
  const targets = refTargets(app, refs, r.item_user ?? "owner");
  return {
    id: r.id, at: r.at, type: r.type, summary: r.summary, detail: r.detail, risk: r.risk, next: r.next, refs,
    status: r.status, origin: r.origin ?? "follow", noise: !!r.noise, itemId: r.item_id, itemTitle: r.title, lineId: line.id, lineTitle: line.title,
    ...(targets ? { refTargets: targets } : {}),
  };
}
export const CHANGE_COLS = "c.id, c.item_id, c.at, c.type, c.summary, c.detail, c.risk, c.next, c.refs, c.status, c.origin, c.noise, i.title, coalesce(i.user_id,'owner') item_user";

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
