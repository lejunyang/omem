import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { accessibleSpaces } from "../core/users.ts";
import { HttpError, now } from "../core/util.ts";
import { addItemEvent, getItem, isClosed } from "./store.ts";

/**
 * Items hang under one another (docs/v2/status.md “工作线”): requirements, defects and reviews under a work line
 * (kind `line`), a defect under the requirement it belongs to. Three levels at most, one person's own
 * items, the parent in a space its person may read. What a line shows (its timeline, its 关注's groups,
 * its state) is the line together with everything under it.
 */
export const MAX_DEPTH = 3;

export const parentOf = (app: App, id: string) => one<{ parent_id: string | null }>(app.db, "select parent_id from items where id = ?", id)?.parent_id ?? null;

/** The items above, nearest first (never more than the depth limit, whatever the data says). */
export function ancestorIds(app: App, id: string): string[] {
  const out: string[] = [];
  let cur = parentOf(app, id);
  while (cur && !out.includes(cur) && cur !== id && out.length < 10) {
    out.push(cur);
    cur = parentOf(app, cur);
  }
  return out;
}

/** The top-level item a work item belongs to (itself when it hangs under nothing). */
export const rootOf = (app: App, id: string) => ancestorIds(app, id).at(-1) ?? id;

export const childIds = (app: App, id: string) => all<{ id: string }>(app.db, "select id from items where parent_id = ? order by created_at, id", id).map((r) => r.id);

/** Everything under an item, level by level (not the item itself). */
export function descendantIds(app: App, id: string): string[] {
  const out: string[] = [];
  let level = [id];
  for (let depth = 0; depth < MAX_DEPTH + 2 && level.length; depth++) {
    const next = all<{ id: string }>(app.db, `select id from items where parent_id in (${level.map(() => "?").join(",")}) order by created_at, id`, ...level).map((r) => r.id).filter((x) => x !== id && !out.includes(x));
    out.push(...next);
    level = next;
  }
  return out;
}

/** Levels from the item down to its deepest descendant (1 for an item with nothing under it). */
function height(app: App, id: string): number {
  let h = 1, level = [id];
  const seen = new Set(level);
  while (h <= MAX_DEPTH + 1) {
    const next = all<{ id: string }>(app.db, `select id from items where parent_id in (${level.map(() => "?").join(",")})`, ...level).map((r) => r.id).filter((x) => !seen.has(x));
    if (!next.length) break;
    for (const x of next) seen.add(x);
    level = next;
    h++;
  }
  return h;
}

export const hasOpenChildren = (app: App, id: string) => openUnder(app, id) > 0;

/** How many items under one are still open (candidates do not count). */
export function openUnder(app: App, id: string) {
  return descendantIds(app, id).filter((c) => {
    const s = one<{ status: string }>(app.db, "select status from items where id = ?", c)?.status;
    return !!s && !isClosed(s) && s !== "candidate";
  }).length;
}

/**
 * A top-level item the work page shows as a line (items/lifecycle.ts owns its end, not expiry): kind
 * `line`, something hung under it, a flow (running or run), a phase of its own, or an active 关注.
 */
export function lineLike(app: App, item: { id: string; kind: string; parentId: string | null; phase?: string | null }) {
  if (item.parentId) return false;
  if (item.kind === "line" || item.phase) return true;
  return !!one(app.db, `select 1 where exists(select 1 from items where parent_id = ? and status != 'candidate')
      or exists(select 1 from item_flows where item_id = ?)
      or exists(select 1 from listen_contexts where kind = 'item' and item_id = ? and status = 'active')`, item.id, item.id, item.id);
}

/**
 * Whether `id` may hang under `parent`: same person, a parent its person may read, no cycle, three
 * levels at most counting what already hangs under the item. Throws why not.
 */
export function checkParent(app: App, id: string, parent: string) {
  const item = getItem(app, id);
  if (parent === id) throw new HttpError(400, "事项不能挂在自己下面");
  const p = getItem(app, parent);
  if (p.userId !== item.userId) throw new HttpError(403, "只能挂到同一个人的事项下面");
  const allowed = accessibleSpaces(app, item.userId);
  if (allowed && !allowed.includes(p.spaceId)) throw new HttpError(403, `不能访问空间 ${p.spaceId}`);
  const above = ancestorIds(app, parent);
  if (above.includes(id) || descendantIds(app, id).includes(parent)) throw new HttpError(400, "不能挂到它自己下面的事项上（会成环）");
  const h = height(app, id);
  if (above.length + 1 + h > MAX_DEPTH) throw new HttpError(400, `最多三层：「${p.title}」上面已有 ${above.length} 层，这件事下面还有 ${h - 1} 层`);
  return p;
}

/** Write the parent and say so on the timelines of the item, its new parent and its old one. Checks first; no 关注 work (items/parent.ts). */
export function writeParent(app: App, id: string, parent: string | null, actor: "agent" | "user" = "user", runId?: string) {
  const item = getItem(app, id);
  const before = item.parentId;
  if ((parent ?? null) === before) return { item, before, changed: false };
  if (parent) checkParent(app, id, parent);
  run(app.db, "update items set parent_id = ?, updated_at = ? where id = ?", parent, now(), id);
  const title = (x: string | null) => (x ? one<{ title: string }>(app.db, "select title from items where id = ?", x)?.title ?? x : "");
  addItemEvent(app, id, "updated", parent ? `归到「${title(parent)}」下面${before ? `（原来在「${title(before)}」下面）` : ""}` : `从「${title(before)}」下面移出`, actor, [], runId);
  if (parent) addItemEvent(app, parent, "updated", `「${item.title}」归到这里`, actor, [], runId);
  if (before) addItemEvent(app, before, "updated", `「${item.title}」移走了`, actor, [], runId);
  app.emit({ type: "changed", entity: "item", id, spaceId: item.spaceId });
  return { item: getItem(app, id), before, changed: true };
}
