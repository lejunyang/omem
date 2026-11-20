import { can } from "../auth/permissions.ts";
import { capabilityAccess } from "../auth/capabilities.ts";
import type { App } from "../core/app.ts";
import { OWNER, scopeFor } from "../core/users.ts";
import { HttpError } from "../core/util.ts";
import { getItem, type Item } from "./store.ts";

export function itemScope(app: App, userId: string, spaces: string[] | null = null) {
  const access = capabilityAccess(app, userId);
  const requested = scopeFor(app, userId, spaces);
  const readable = access.range("items.view", true);
  const spaceIds = requested ? requested.filter(id => !readable || readable.includes(id)) : readable;
  return { userId: userId === OWNER ? undefined : userId, spaceIds: spaceIds ?? undefined, sharedSpaces: access.range("items.view") ?? undefined };
}

type Mode = "read" | "write" | "operate" | "flow";
export function itemAccess(app: App, userId: string, item: Pick<Item, "userId" | "spaceId">, mode: Mode) {
  const cap = { read: "items.view", write: "items.edit", operate: "items.operate", flow: "flows.operate" } as const;
  return can(app, userId, cap[mode], item);
}

export function requireItem(app: App, id: string, userId: string, mode: Mode) {
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
