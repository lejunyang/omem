import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { now } from "../core/util.ts";
import { codeWork, type CodeWorkDetail } from "../agents/code-works.ts";
import { designFeedback, designForWork, designsOfItem } from "../designs/store.ts";
import { addItemEvent, type Item } from "../items/store.ts";
import { continuing } from "../studies/store.ts";
import { pluginObjectKind } from "../plugins/objects.ts";
import { findPluginObject } from "./plugin-objects.ts";

/** `updated`: a plugin object whose revision moved after the time asked about (a stage done on `status: "updated"`). */
export type FlowObject = { ref: string; title: string; status: string; done: boolean; link: string; statusLabel?: string; fields?: { label: string; value: string }[]; changedAt?: string; disabled?: boolean; updated?: boolean };
export type ObjectKind = { kind: string; label: string; find: (app: App, item: Item) => FlowObject | null };

/** Per-item run materials bound the lookup; codeWork uses the existing continuation indexes. */
export function latestCodeWork(app: App, item: Item): CodeWorkDetail | null {
  const runs = all<{ id: string; joined: number | null }>(app.db, `select r.id, json_extract(m.meta, '$.joined') joined from item_materials m join runs r on r.id=m.ref
    where m.item_id=? and m.kind='run' and r.kind='code' and coalesce(r.user_id,'owner')=? order by r.created_at desc, m.id desc`, item.id, item.userId);
  for (const r of runs) {
    const w = codeWork(app, r.id);
    // Its own delegation, or one of another item on the same branch this item's change went into (joinCodeWork).
    if (!w || (w.item?.id !== item.id && !r.joined)) continue;
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
export function codeWorkSince(app: App, item: Item, since: string): FlowObject | null {
  const w = latestCodeWork(app, item);
  const at = w ? one<{ c: string }>(app.db, "select created_at c from runs where id = ?", w.latestId)?.c : undefined;
  const joined = w ? one<{ c: string }>(app.db, "select created_at c from item_materials where item_id = ? and kind = 'run' and ref = ?", item.id, w.rootId)?.c : undefined;
  if (!w || !(at && at >= since || joined && joined >= since)) return null;
  return objectKind("code-work")!.find(app, item);
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

/** Built-in object lifecycles stay in their own stores. */
export const flowObjects: readonly ObjectKind[] = [
  { kind: "fixes", label: "改", find: () => null },
  { kind: "trials", label: "试验", find: (app, item) => {
    const c = continuing(app, item.id);
    return c ? { ref: `trials:${c.direction.id}`, title: c.direction.goal, status: c.direction.state, done: false, link: `#/items/${item.id}` } : null;
  } },
  { kind: "code-work", label: "编码交办", find: (app, item) => {
    const w = latestCodeWork(app, item);
    if (!w) return null;
    const last = w.roundList.at(-1);
    // `stage.key` is the view's state; the verdict in roundList preserves review approval after apply.
    const done = last?.status === "done" && last.verdict === "approved" && ["done", "review-ok", "ended"].includes(w.stage.key);
    return { ref: `code-work:${w.rootId}`, title: w.title, status: w.stage.key, done, link: `#/runs/${w.latestId}` };
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
