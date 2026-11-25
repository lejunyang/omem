import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { now } from "../core/util.ts";
import { codeWork, type CodeWorkDetail } from "../agents/code-works.ts";
import { designFeedback, designForWork, designsOfItem } from "../designs/store.ts";
import { addItemEvent, type Item } from "../items/store.ts";
import { continuing } from "../studies/store.ts";
import { pluginObjectKind } from "../plugins/objects.ts";
import { findPluginObject } from "./plugin-objects.ts";
import { codeRework } from "./code-rework.ts";

/** `updated`: a plugin object whose revision moved after the time asked about (a stage done on `status: "updated"`). */
export type FlowObject = { ref: string; title: string; status: string; done: boolean; link: string; statusLabel?: string; fields?: { label: string; value: string }[]; changedAt?: string; disabled?: boolean; updated?: boolean; dropped?: string; reworkRound?: number; reworkBlocked?: string };
export type ObjectKind = { kind: string; label: string; find: (app: App, item: Item) => FlowObject | null };

/** Per-item run materials bound the lookup; codeWork uses the existing continuation indexes. */
export function latestCodeWork(app: App, item: Item, after?: string): CodeWorkDetail | null {
  const runs = all<{ id: string; joined: number | null }>(app.db, `select r.id, json_extract(m.meta, '$.joined') joined from item_materials m join runs r on r.id=m.ref
    where m.item_id=? and m.kind='run' and r.kind='code' and coalesce(r.user_id,'owner')=? order by r.created_at desc, m.id desc`, item.id, item.userId);
  for (const r of runs) {
    const w = codeWork(app, r.id);
    // Its own delegation, or one of another item on the same branch this item's change went into (joinCodeWork).
    if (!w || (w.item?.id !== item.id && !r.joined)) continue;
    if (after && !codeRework(app, item, w, after)) continue;
    const ids = w.roundList.map((x) => x.id);
    if (all<{ id: string }>(app.db, `select id from runs where id in (${ids.map(() => "?").join(",")}) and (json_extract(output,'$.discardedAt') is not null or json_extract(output,'$.supersededBy') is not null)`, ...ids).length) continue;
    return w;
  }
  return null;
}

/**
 * The delegation this item follows, when it moved since `since`: started then, or given a new round
 * (continue_code_run, a change joined into it). A stage's run that handed its work over leaves this.
 */
export function codeWorkSince(app: App, item: Item, since: string, newRoundOnly = false): FlowObject | null {
  const w = latestCodeWork(app, item, newRoundOnly ? since : undefined);
  if (!w) return null;
  if (newRoundOnly) {
    const rework = codeRework(app, item, w, since)!;
    const obj = codeWorkObject(app, item, w);
    return { ...obj, done: rework.verified || obj.done && !rework.blocked, dropped: rework.verified ? undefined : obj.dropped, reworkRound: rework.round, reworkBlocked: rework.blocked };
  }
  const at = one<{ c: string }>(app.db, "select created_at c from runs where id = ?", w.latestId)?.c;
  const joined = one<{ c: string }>(app.db, "select created_at c from item_materials where item_id = ? and kind = 'run' and ref = ?", item.id, w.rootId)?.c;
  return at && at >= since || joined && joined >= since ? codeWorkObject(app, item, w) : null;
}

function codeWorkObject(app: App, item: Item, work: CodeWorkDetail): FlowObject {
  const last = work.roundList.at(-1);
  const done = last?.status === "done" && last.verdict === "approved" && ["done", "review-ok", "ended"].includes(work.stage.key);
  const dropped = done ? droppedFor(app, item, work.rootId) : null;
  return { ref: `code-work:${work.rootId}`, title: work.title, status: work.stage.key, done: done && !dropped, link: `#/runs/${work.latestId}`, ...(dropped ? { dropped } : {}) };
}

/**
 * When the delegation this item follows last finished something: a round, or a review of one (a branch
 * review's conclusion comes from its review runs). A stage stuck before that is behind the object.
 */
export function codeWorkSettledAt(app: App, item: Item, after?: string): string | null {
  const w = latestCodeWork(app, item, after);
  if (!w) return null;
  const ids = w.roundList.map((x) => x.id);
  const marks = ids.map(() => "?").join(",");
  return one<{ at: string | null }>(app.db, `select max(finished_at) at from runs where finished_at is not null and (id in (${marks}) or parent_id in (${marks}))`, ...ids, ...ids)?.at ?? null;
}

/**
 * This item's change went into another item's delegation on the same branch (continue_code_run when=now with
 * item_id): the delegation is listed on this item too, and its flow follows it like its own.
 */
export function joinCodeWork(app: App, item: Item, rootId: string) {
  const title = one<{ title: string }>(app.db, "select title from runs where id = ?", rootId)?.title ?? rootId;
  run(app.db, `insert into item_materials(item_id, kind, ref, label, meta, added_by, created_at) values(?, 'run', ?, ?, ?, 'agent', ?)
    on conflict(item_id, kind, ref) do update set meta = json_set(coalesce(item_materials.meta, '{}'), '$.joined', 1)`, item.id, rootId, title, JSON.stringify({ joined: 1, note: "这件的修改并在同一分支的这次交办里" }), now());
  addItemEvent(app, item.id, "updated", `修改并进同一分支的交办「${title}」`, "agent");
  app.emit({ type: "changed", entity: "item", id: item.id });
}

/**
 * A change this item put into another item's delegation (continue_code_run with item_id and new_item,
 * its tasks carry `origin.item`) that was all declined or put off: the delegation finishing is not this
 * item fixed. Returns why, from the tasks' answers; null when any of them was done, or none is known.
 */
export function droppedFor(app: App, item: Item, rootId: string): string | null {
  const rows = all<{ seq: number; state: string; answer: string | null }>(app.db,
    "select seq, state, answer from code_tasks where work_id = ? and json_extract(origin, '$.item') = ?", rootId, item.id);
  if (!rows.length || rows.some((t) => t.state !== "wontdo")) return null;
  return rows.map((t) => `T${t.seq}${t.answer ? `：${t.answer}` : ""}`).join("；");
}

/** Built-in object lifecycles stay in their own stores. */
export const flowObjects: readonly ObjectKind[] = [
  { kind: "fixes", label: "改", find: () => null },
  { kind: "trials", label: "试验", find: (app, item) => {
    const c = continuing(app, item.id);
    return c ? { ref: `trials:${c.direction.id}`, title: c.direction.goal, status: c.direction.state, done: false, link: `#/items/${item.id}` } : null;
  } },
  { kind: "code-work", label: "编码交办", find: (app, item) => {
    const w = latestCodeWork(app, item);
    return w ? codeWorkObject(app, item, w) : null;
  } },
  { kind: "design", label: "方案", find: (app, item) => {
    const w = latestCodeWork(app, item);
    const d = (w ? designForWork(app, w.rootId) : null) ?? designsOfItem(app, item.id)[0];
    if (!d || d.userId && d.userId !== item.userId) return null;
    const done = d.status === "approved" && designFeedback(app, d.id).some((f) => f.revision === d.revision && f.action === "approve" && f.by === item.userId);
    return { ref: `design:${d.id}`, title: d.title, status: d.status, done, link: `#/design/${d.id}` };
  } },
];
export const objectKind = (kind: string): ObjectKind | undefined => {
  const def = pluginObjectKind(kind);
  return kind.includes(":") ? def ? { kind, label: def.label, find: (app, item) => findPluginObject(app, item, kind) } : undefined : flowObjects.find((x) => x.kind === kind);
};
export const findObject = (app: App, item: Item, kind: string, opts?: { statuses?: string[]; after?: string; updatedAfter?: string }): FlowObject | null => kind.includes(":") ? findPluginObject(app, item, kind, opts) : objectKind(kind)?.find(app, item) ?? null;
