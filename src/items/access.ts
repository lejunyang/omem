import type { App } from "../core/app.ts";
import { canWrite, OWNER, scopeFor } from "../core/users.ts";
import { HttpError } from "../core/util.ts";
import { getItem, type Item } from "./store.ts";

export function itemScope(app: App, userId: string, spaces: string[] | null = null) {
  return { userId: userId === OWNER ? undefined : userId, spaceIds: scopeFor(app, userId, spaces) ?? undefined };
}

export function itemAccess(app: App, userId: string, item: Pick<Item, "userId" | "spaceId">, mode: "read" | "write") {
  const scope = itemScope(app, userId);
  if ((scope.userId && item.userId !== scope.userId) || (scope.spaceIds && !scope.spaceIds.includes(item.spaceId))) return false;
  return mode === "read" || canWrite(app, userId, item.spaceId);
}

export function requireItem(app: App, id: string, userId: string, mode: "read" | "write") {
  const item = getItem(app, id);
  if (!itemAccess(app, userId, item, mode)) {
    if (mode === "read") throw new HttpError(404, "事项不存在");
    throw new HttpError(403, "不能修改他人或不可写空间的事项");
  }
  return item;
}

/** Moving a child writes an event to the old and new parent's timelines. */
export function writableParents(app: App, userId: string, before: string | null, after: string | null | undefined) {
  if (after === undefined || before === after) return [];
  return [before, after].flatMap(id => id ? [requireItem(app, id, userId, "write")] : []);
}
