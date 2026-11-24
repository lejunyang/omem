import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { json, newId, now, truncate } from "../core/util.ts";
import { descendantIds, rootOf } from "./tree.ts";
import { handlerOfOrigin, noteHandling } from "../core/handling.ts";
import { CHANGE_TYPES, stepBrief, stepViews } from "./change-step-store.ts";

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
 * - `meeting`: a decision, a to-do or an open question a meeting's summary handed in for an item it is
 *   linked to (agents/meeting-outcomes.ts);
 * - `review`: a review of the item's coding came to its verdict (agents/review-chain.ts);
 * - `commit`: the owner said commits on a branch belong to the item (flows/commits.ts).
 * - `member`: a member answered what the assistant asked them for the owner (items/member-progress.ts).
 *
 * All but `follow` are written as `noted`: they never ask and never make cards. A line's timeline is its
 * own changes together with those of everything under it.
 *
 * One ledger, each change once (recordChange). A change is keyed by where it came from, the item and its
 * type: the same message read by item-follow and by the main assistant, or the same meeting handled
 * twice, is one row. What each writer can name its source by (`source_key`, canonical, see sourceKeys):
 *
 * | writer                         | source it has                                  | key                                 |
 * | ------------------------------ | ---------------------------------------------- | ----------------------------------- |
 * | item-follow (`follow`)         | `src:<chat>#L…` lines of its batch, doc lines   | `lark:<message id>` / `src:<doc>#h<hash of the lines>` |
 * | upsert_item change_type (`owner`) | source_refs the agent cites                 | same as above                       |
 * | track_problem (`problem`)      | the problem row                                | `problem:<id>`                      |
 * | metrics (`metric`)             | the metric and its newest point                | `metric:<id>@<point time>`          |
 * | flow stage (`flow`)            | the stage and the time it turned               | `stage:<stage>:<state>@<since>`     |
 * | review verdict (`review`)      | the review run                                 | `review:<run id>`                   |
 * | commit claim (`commit`)        | repo, branch and the run that found them        | `commits:<repo>/<branch>@<run id>`  |
 * | meeting summary (`meeting`)    | meeting id and the cited lines of its record   | `meeting:<id>#L<first line>`        |
 * | line's life (`line`)           | nothing outside the host                       | none (every row is its own)         |
 * | a member's answer (`member`)   | the question asked for the owner (member-progress.ts) | `ask:<ask id>`               |
 *
 * A chat line is keyed by its Feishu message (the same message kept in two copies is one key); a document's
 * lines by a hash of their text (an edit that only moves them keeps the key). The row keeps who noted it
 * first (`origin`, `run_id`, `at`) and who added to it later (`added`).
 */
export type ChangeOrigin = "follow" | "flow" | "metric" | "problem" | "owner" | "line" | "meeting" | "review" | "commit" | "member";
export { CHANGE_TYPES } from "./change-step-store.ts";
export type ChangeType = (typeof CHANGE_TYPES)[number];

/** Someone who added to a change after it was first noted: who, in which run, when, and which parts. */
export type ChangeAddition = { origin: string; runId: string | null; at: string; fields: string[] };
export type ChangeLite = {
  id: string; at: string; type: string; summary: string; detail: string | null; risk: string | null; next: string | null;
  refs: string[]; status: string; origin: string; noise: boolean; itemId: string; itemTitle: string; lineId: string; lineTitle: string;
  /** The references that are no citation and name an item or a run of the same person (refTargets); only when there are any. */
  refTargets?: Record<string, RefTarget>;
  /** The run that first noted it (empty for the host's own). */
  runId?: string;
  /** Where it came from (sourceKeys); absent on rows written before the ledger had keys. */
  sourceKey?: string;
  /** Who added to it after it was first noted. */
  added?: ChangeAddition[];
  steps?: ReturnType<typeof stepViews>;
};
type Row = { id: string; item_id: string; at: string; type: string; summary: string; detail: string | null; risk: string | null; next: string | null; refs: string; status: string; origin: string; noise: number; title: string; item_user?: string; run_id?: string; source_key?: string | null; added?: string | null };

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
  const added = r.added ? json<ChangeAddition[]>(r.added, []) : [];
  const steps = stepViews(app, r.id), detail = steps.length ? [r.detail, stepBrief(steps)].filter(Boolean).join("\n\n") : r.detail;
  return {
    id: r.id, at: r.at, type: r.type, summary: r.summary, detail, risk: r.risk, next: r.next, refs,
    status: r.status, origin: r.origin ?? "follow", noise: !!r.noise, itemId: r.item_id, itemTitle: r.title, lineId: line.id, lineTitle: line.title,
    ...(targets ? { refTargets: targets } : {}),
    ...(r.run_id ? { runId: r.run_id } : {}),
    ...(r.source_key ? { sourceKey: r.source_key } : {}),
    ...(added.length ? { added } : {}),
    ...(steps.length ? { steps } : {}),
  };
}
export const CHANGE_COLS = "c.id, c.item_id, c.at, c.type, c.summary, c.detail, c.risk, c.next, c.refs, c.status, c.origin, c.noise, c.run_id, c.source_key, c.added, i.title, coalesce(i.user_id,'owner') item_user";

// ------------------------------------------------------------------ the one way in

const SRC_REF = /^src:([^#\s]+)(?:#L(\d+)(?:-L?(\d+))?)?$/;
/** Event keys the host names its own sources by (see the table above); taken as they are. */
const EVENT_KEY = /^(?:lark|msg|meeting|metric|problem|review|commits|stage|event|run):\S+$/;
/** Lines of a document hashed into its key: a few hundred thousand characters are read at most. */
const KEY_DOC_CHARS = 200_000;
function textHash(text: string) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

/**
 * The canonical keys of the sources a change cites, at most eight, each once: a chat line becomes the
 * Feishu message it is (`lark:<message id>`), a document's lines a hash of their text, a conversation's
 * line stays as it is; event keys (`meeting:…`, `metric:…`) are kept. Memories, items and words are no
 * source and are left out. Indexed lookups only.
 */
export function sourceKeys(app: App, refs: readonly string[] = []): string[] {
  const out = new Set<string>();
  for (const raw of refs.slice(0, 12)) {
    if (out.size >= 8) break;
    const ref = raw.trim();
    if (EVENT_KEY.test(ref)) { out.add(ref); continue; }
    const m = SRC_REF.exec(ref);
    if (!m) continue;
    const id = m[1], from = m[2] ? Number(m[2]) : null, to = m[3] ? Number(m[3]) : from;
    const s = one<{ kind: string }>(app.db, "select kind from sources where id = ?", id);
    if (!s || from === null) { out.add(`src:${id}${from === null ? "" : `#L${from}`}`); continue; }
    if (s.kind === "chat") {
      const msg = one<{ message_id: string }>(app.db, "select message_id from lark_message_lines where source_id = ? and line = ?", id, from)
        ?? one<{ message_id: string }>(app.db, "select message_id from lark_messages where source_id = ? and line = ?", id, from);
      out.add(msg ? `lark:${msg.message_id}` : `src:${id}#L${from}`);
      continue;
    }
    if (s.kind !== "conversation" && to !== null && to >= from && to - from < 80) {
      const text = one<{ t: string }>(app.db, "select substr(text,1,?) t from sources where id = ?", KEY_DOC_CHARS, id)?.t ?? "";
      const lines = text.split("\n").slice(from - 1, to).map((l) => l.trim()).filter(Boolean);
      if (lines.length) { out.add(`src:${id}#h${textHash(lines.join("\n"))}`); continue; }
    }
    out.add(`src:${id}#L${from}${to !== null && to !== from ? `-L${to}` : ""}`);
  }
  return [...out];
}

export type ChangeInput = {
  itemId: string; type: ChangeType; summary: string; detail?: string | null; risk?: string | null; next?: string | null;
  refs?: string[]; runId?: string | null; origin: ChangeOrigin;
  /** The event it came from when no citation names it (`meeting:<id>#L3`, `metric:<id>@<at>`, `review:<run>`…): the key before any cited source. */
  source?: string | null;
  req?: string | null; stages?: string[]; due?: string | null;
};
type LedgerRow = { id: string; item_id: string; type: string; summary: string; detail: string | null; risk: string | null; next: string | null; refs: string; status: string; origin: string; run_id: string; due: string | null; req: string | null; stages: string; source_key: string | null; sources: string | null; added: string | null };
export type Recorded = { id: string; created: boolean; updated: boolean; origin: string; status: string };
/** Settled by the owner: a later writer leaves the words as they are (it is still counted as having seen it). */
const SETTLED = new Set(["dismissed", "merged", "split"]);
const clean = (s: string, n: number) => truncate(s.replace(/\s+/g, " ").trim(), n);

/** The changes already in the ledger for one of these keys, on this item and of this type, oldest first. */
function keyedChanges(app: App, itemId: string, type: string, keys: string[]): LedgerRow[] {
  if (!keys.length) return [];
  const marks = keys.map(() => "?").join(",");
  return all<LedgerRow>(app.db, `select * from item_changes where item_id = ? and type = ? and source_key is not null
      and (source_key in (${marks}) or exists (select 1 from json_each(coalesce(sources,'[]')) j where j.value in (${marks})))
    order by at limit 10`, itemId, type, ...keys, ...keys);
}
/**
 * Which of those this change is. Not one the same run handed in with other words (one writer naming two
 * changes from one message means two), nor one proposing another date: those are changes of their own.
 */
function sameChange(rows: LedgerRow[], c: ChangeInput, summary: string): LedgerRow | undefined {
  return rows.find((r) => !(r.origin === c.origin && (r.run_id || "") === (c.runId ?? "") && r.summary !== summary) && !(r.due && c.due && r.due !== c.due));
}

/**
 * Note a change: every writer comes through here. A change keyed by the same source, item and type as one
 * already noted adds to it instead of making a second: the same words do nothing; more specific ones (a
 * date where there was none, a detail, a risk, a fuller sentence) update that row and say who added what.
 * A change the owner settled keeps its words. With no source to key it by, it is a row of its own (the
 * line's own life, and rows from before the ledger had keys). Returns null when the item is gone.
 */
export function recordChange(app: App, c: ChangeInput): Recorded | null {
  if (!one(app.db, "select 1 from items where id = ?", c.itemId)) return null;
  const cited = sourceKeys(app, c.refs ?? []).sort();
  // A host event names itself: only that key finds the row (its evidence lines are kept, not matched on).
  const keys = [...new Set([...(c.source ? [c.source] : []), ...cited])];
  const match = c.source ? [c.source] : cited;
  const summary = clean(c.summary, 300), detail = c.detail?.trim() ? truncate(c.detail.trim(), 4000) : null;
  const at = now();
  const merge = (old: LedgerRow): Recorded => {
    const fields: string[] = [];
    const set: Record<string, string | null> = {};
    const take = (col: "detail" | "risk" | "next" | "due" | "req", v: string | null | undefined) => { if (v && !old[col]) { set[col] = v; fields.push(col); } };
    if (!SETTLED.has(old.status)) {
      take("detail", detail); take("risk", c.risk ?? null); take("next", c.next ?? null); take("due", c.due ?? null); take("req", c.req ?? null);
      // A fuller sentence about the same thing, or one that came with something the first lacked.
      if (summary !== old.summary && (fields.length || summary.length >= old.summary.length + 4)) { set.summary = summary; fields.push("summary"); }
      const stages = [...new Set([...json<string[]>(old.stages, []), ...(c.stages ?? [])])];
      if (stages.length !== json<string[]>(old.stages, []).length) { set.stages = JSON.stringify(stages); fields.push("stages"); }
    }
    const refs = [...new Set([...json<string[]>(old.refs, []), ...(c.refs ?? [])])].slice(0, 50);
    const sources = [...new Set([...json<string[]>(old.sources ?? "[]", []), ...keys])].slice(0, 16);
    if (!fields.length && refs.length === json<string[]>(old.refs, []).length) return { id: old.id, created: false, updated: false, origin: old.origin, status: old.status };
    if (!fields.length) fields.push("refs");
    const added = [...json<ChangeAddition[]>(old.added ?? "[]", []), { origin: c.origin, runId: c.runId ?? null, at, fields }].slice(-20);
    const cols = Object.keys(set);
    run(app.db, `update item_changes set ${cols.map((k) => `${k} = ?,`).join(" ")} refs = ?, sources = ?, added = ?, updated_at = ? where id = ?`,
      ...cols.map((k) => set[k]), JSON.stringify(refs), JSON.stringify(sources), JSON.stringify(added), at, old.id);
    app.emit({ type: "changed", entity: "item", id: c.itemId });
    noteHandled(app, c, keys, old.id);
    return { id: old.id, created: false, updated: true, origin: old.origin, status: old.status };
  };
  const near = keyedChanges(app, c.itemId, c.type, match);
  const found = sameChange(near, c, summary);
  if (found) return merge(found);
  const id = newId("ic");
  // A second change of its own from the same source keeps the source among its keys and a numbered key of its own.
  const own = keys[0] && near.length ? `${keys[0]}~${near.length + 1}` : keys[0] ?? null;
  try {
    run(app.db, `insert into item_changes(id,item_id,at,type,summary,detail,req,stages,refs,run_id,status,updated_at,due,risk,next,origin,source_key,sources)
      values(?,?,?,?,?,?,?,?,?,?,'noted',?,?,?,?,?,?,?)`,
      id, c.itemId, at, c.type, summary, detail, c.req ?? null, JSON.stringify(c.stages ?? []), JSON.stringify(c.refs ?? []), c.runId ?? "", at,
      c.due ?? null, c.risk || null, c.next || null, c.origin, own, keys.length ? JSON.stringify(keys) : null);
  } catch (e) {
    // Another writer noted it between the look and the insert (the unique key): add to theirs.
    const again = sameChange(keyedChanges(app, c.itemId, c.type, match.length ? match : keys), c, summary);
    if (again) return merge(again);
    throw e;
  }
  app.emit({ type: "changed", entity: "item", id: c.itemId });
  noteHandled(app, c, keys, id);
  return { id, created: true, updated: false, origin: c.origin, status: "noted" };
}
/** The messages and meetings a change came from now say what they became (core/handling.ts). */
function noteHandled(app: App, c: ChangeInput, keys: string[], changeId: string) {
  const actor = handlerOfOrigin(c.origin);
  if (!actor) return;
  for (const k of keys) {
    const event = k.startsWith("lark:") ? k.slice(5) : k.startsWith("meeting:") ? k.split("#")[0] : null;
    if (event) noteHandling(app, { event, actor, decision: "noted", runId: c.runId ?? null, changeId });
  }
}

/** A change one of the host's writers saw (never `follow`): noted, no card, on the item's timeline. Returns its id. */
export function addChange(app: App, c: Omit<ChangeInput, "origin"> & { origin: Exclude<ChangeOrigin, "follow"> }) {
  return recordChange(app, c)?.id ?? null;
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
