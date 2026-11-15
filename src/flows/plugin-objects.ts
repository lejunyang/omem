import type { App } from "../core/app.ts";
import { all, one, run, tx } from "../core/db.ts";
import { accessibleSpaces, canWrite } from "../core/users.ts";
import { HttpError, json, now, sha256 } from "../core/util.ts";
import { addItemEvent, getItem, isClosed, type Item } from "../items/store.ts";
import { pluginObjectKind, pluginObjectKinds, type RegisteredObject } from "../plugins/objects.ts";
import { pluginContext } from "../plugins/blocks.ts";
import type { PluginObjectState } from "../plugins/types.ts";
import type { FlowObject } from "./objects.ts";

type Row = { id: string; kind: string; key: string; title: string; status: string; link: string; fields: string; checked_at: string | null; changed_at: string; error: string | null; updated_at: string };
export type ObjectView = { id: string; kind: string; label: string; title: string; status: string; statusLabel: string; final: boolean; link: string; fields: { label: string; value: string }[]; checkedAt: string | null; changedAt: string; error: string | null; disabled: boolean };
const row = (app: App, id: string) => one<Row>(app.db, "select * from flow_objects where id=?", id);
const view = (r: Row): ObjectView => {
  const def = pluginObjectKind(r.kind);
  return { id: r.id, kind: r.kind, label: def?.label ?? r.kind, title: r.title, status: r.status, statusLabel: def?.statuses[r.status] ?? r.status, final: def?.final.includes(r.status) ?? false, link: r.link, fields: json(r.fields, []), checkedAt: r.checked_at, changedAt: r.changed_at, error: r.error, disabled: !def };
};
export function assertObjectItem(app: App, itemId: string, userId: string, write = false) {
  const item = getItem(app, itemId), spaces = accessibleSpaces(app, userId);
  if (spaces && !spaces.includes(item.spaceId)) throw new HttpError(404, "没有这个事项");
  if (write && (item.userId !== userId || !canWrite(app, userId, item.spaceId))) throw new HttpError(403, "只有事项本人能在可写空间关联对象");
  return item;
}
export function itemObjects(app: App, itemId: string, userId: string) {
  assertObjectItem(app, itemId, userId);
  return all<Row>(app.db, "select o.* from item_materials m join flow_objects o on o.id=m.ref where m.item_id=? and m.kind='object' order by m.id desc", itemId).map(view);
}
export function findPluginObject(app: App, item: Item, kind: string, opts?: { statuses?: string[]; after?: string }): FlowObject | null {
  const r = all<Row>(app.db, "select o.* from item_materials m join flow_objects o on o.id=m.ref where m.item_id=? and m.kind='object' and o.kind=? order by m.id desc", item.id, kind)
    .find((r) => (!opts?.statuses || opts.statuses.includes(r.status)) && (!opts?.after || r.changed_at > opts.after));
  if (!r) return null;
  const v = view(r);
  return { ref: `object:${r.id}`, title: v.title, status: v.status, statusLabel: v.statusLabel, fields: v.fields, link: v.link, done: !v.disabled && v.final, disabled: v.disabled, changedAt: v.changedAt };
}
export function objectMaterialBrief(app: App, id: string) {
  const r = row(app, id);
  if (!r) return "对象不存在";
  const v = view(r);
  return `${v.label}：${v.title}（${v.statusLabel}）${v.link}${v.disabled ? "（来源已停用）" : ""}`;
}

/** State changes and attachments share a per-object lock, including explicit concurrent requests. */
const locks = new WeakMap<App, Map<string, Promise<unknown>>>();
function serial<T>(app: App, id: string, fn: () => Promise<T>) {
  let map = locks.get(app); if (!map) locks.set(app, map = new Map());
  const next = (map.get(id) ?? Promise.resolve()).catch(() => {}).then(fn);
  map.set(id, next);
  void next.finally(() => { if (map!.get(id) === next) map!.delete(id); }).catch(() => {});
  return next;
}
async function timed<T>(fn: () => T | Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([Promise.resolve().then(fn), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("读取对象超过 15 秒")), 15000); })]); }
  finally { clearTimeout(timer); }
}
const retryKey = (id: string) => `flow-object-retry:${id}`;
function retry(app: App, id: string) { return json<{ failures: number; next: number }>(one<{ value: string }>(app.db, "select value from kv where key=?", retryKey(id))?.value, { failures: 0, next: 0 }); }
function linkedItems(app: App, id: string) { return all<{ item_id: string }>(app.db, "select item_id from item_materials where kind='object' and ref=?", id).map((x) => x.item_id); }
async function wake(app: App, ids: string[]) {
  const { advance } = await import("./engine.ts");
  for (const id of new Set(ids)) await advance(app, id, "关联对象变化");
}
async function readObject(app: App, def: RegisteredObject, key: string, item: Item, at: Date) {
  const id = `fo_${sha256(JSON.stringify([def.kind, key]))}`;
  const old = row(app, id);
  try {
    const { getPlugin } = await import("../plugins/registry.ts");
    const ctx = pluginContext(app, getPlugin(def.plugin).env, { userId: item.userId, spaceId: item.spaceId, runId: null, actor: "user" });
    const value: PluginObjectState = await timed(() => def.read(ctx, key));
    if (!value || typeof value.status !== "string" || !Object.hasOwn(def.statuses, value.status)) throw new Error(`对象返回了不认识的状态：${value?.status}`);
    if (typeof value.title !== "string" || typeof value.link !== "string" || value.fields && (!Array.isArray(value.fields) || value.fields.some((f) => !f || typeof f.label !== "string" || typeof f.value !== "string"))) throw new Error("对象的标题、链接或字段格式不对");
    if (pluginObjectKind(def.kind) !== def) throw new Error("来源已停用");
    assertObjectItem(app, item.id, item.userId, true);
    const stamp = at.toISOString(), changed = !!old && old.status !== value.status;
    const ids = changed ? linkedItems(app, id) : [];
    tx(app.db, () => {
      run(app.db, `insert into flow_objects(id,kind,key,title,status,link,fields,checked_at,changed_at,error,updated_at) values(?,?,?,?,?,?,?,?,?,null,?)
        on conflict(kind,key) do update set title=excluded.title,status=excluded.status,link=excluded.link,fields=excluded.fields,checked_at=excluded.checked_at,changed_at=excluded.changed_at,error=null,updated_at=excluded.updated_at`,
      id, def.kind, key, value.title, value.status, value.link, JSON.stringify(value.fields ?? []), stamp, !old || changed ? stamp : old.changed_at, stamp);
      run(app.db, "delete from kv where key=?", retryKey(id));
      if (changed) {
        run(app.db, "insert into flow_signals(at,type,keys,item_id,stage_id,outcome) values(?,?,?,?,'',?)", stamp, `object.${def.kind}.${value.status}`, JSON.stringify({ object: id, items: ids }), ids[0] ?? "", `${old.status} → ${value.status}`);
        for (const itemId of ids) addItemEvent(app, itemId, "updated", `${def.label}《${value.title}》：${def.statuses[old.status] ?? old.status} → ${def.statuses[value.status]} ${value.link}`, "host");
      }
    });
    return { id, changedItems: ids };
  } catch (e) {
    const error = (e as Error).message, failures = retry(app, id).failures + 1;
    if (old) run(app.db, "update flow_objects set checked_at=?,error=?,updated_at=? where id=?", at.toISOString(), error, at.toISOString(), id);
    run(app.db, "insert or replace into kv(key,value) values(?,?)", retryKey(id), JSON.stringify({ failures, next: at.getTime() + [5, 15, 60][Math.min(2, failures - 1)] * 60000 }));
    throw new HttpError(400, `读取对象失败：${error}`);
  }
}
export async function attachObject(app: App, itemId: string, url: string, userId: string, by: "user" | "agent" = "user") {
  assertObjectItem(app, itemId, userId, true);
  if (typeof url !== "string" || !url.trim() || url.length > 4000) throw new HttpError(400, "请给对象的链接");
  for (const def of pluginObjectKinds()) {
    const key = await timed(() => def.match(url.trim()));
    if (!key) continue;
    if (typeof key !== "string" || key.length > 4000) throw new HttpError(400, "对象的键格式不对");
    const result = await serial(app, `${def.kind}:${key}`, async () => {
      const item = assertObjectItem(app, itemId, userId, true);
      const r = await readObject(app, def, key, item, new Date());
      assertObjectItem(app, itemId, userId, true);
      const o = row(app, r.id)!;
      const added = run(app.db, "insert or ignore into item_materials(item_id,kind,ref,label,meta,added_by,created_at) values(?,'object',?,?,'{}',?,?)", itemId, r.id, o.title, by, now()).changes;
      if (added) addItemEvent(app, itemId, "updated", `关联${def.label}《${o.title}》 ${o.link}`, by);
      return r;
    });
    await wake(app, [...result.changedItems, itemId]);
    return view(row(app, result.id)!);
  }
  throw new HttpError(400, "没有哪种对象认识这个链接；请先启用对应的插件");
}
export function detachObject(app: App, itemId: string, id: string, userId: string) {
  assertObjectItem(app, itemId, userId, true);
  const removed = run(app.db, "delete from item_materials where item_id=? and kind='object' and ref=?", itemId, id).changes > 0;
  if (removed) addItemEvent(app, itemId, "updated", `解除对象关联：${row(app, id)?.title ?? id}`, "user");
  return { removed };
}

const polling = new WeakMap<App, Promise<void>>();
export function pollObjects(app: App, at = new Date()): Promise<void> {
  const active = polling.get(app); if (active) return active;
  const p = (async () => {
    let count = 0;
    const candidates = all<Row>(app.db, `select o.* from flow_objects o where exists(select 1 from item_materials m join items i on i.id=m.item_id
      where m.kind='object' and m.ref=o.id and i.status not in ('done','cancelled','expired')) order by coalesce(o.checked_at,''),o.id`);
    for (const r of candidates) {
      if (count >= 20) break;
      const def = pluginObjectKind(r.kind);
      if (!def || def.final.includes(r.status) || retry(app, r.id).next > at.getTime() || r.checked_at && at.getTime() - Date.parse(r.checked_at) < (def.poll?.minutes ?? 5) * 60000) continue;
      const item = linkedItems(app, r.id).map((id) => getItem(app, id)).find((i) => !isClosed(i.status) && canWrite(app, i.userId, i.spaceId));
      if (!item) continue;
      count++;
      try {
        const result = await serial(app, `${r.kind}:${r.key}`, async () => {
          const fresh = row(app, r.id)!;
          if (pluginObjectKind(r.kind) !== def || def.final.includes(fresh.status) || fresh.checked_at && at.getTime() - Date.parse(fresh.checked_at) < (def.poll?.minutes ?? 5) * 60000) return null;
          return readObject(app, def, r.key, assertObjectItem(app, item.id, item.userId, true), at);
        });
        if (result) await wake(app, result.changedItems);
      } catch { /* Each object's error is retained; the next one still gets checked. */ }
    }
  })().finally(() => { if (polling.get(app) === p) polling.delete(app); });
  polling.set(app, p);
  return p;
}
