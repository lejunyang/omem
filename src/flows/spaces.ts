import type { App } from "../core/app.ts";
import { findSpace } from "../core/spaces.ts";
import { accessibleSpaces } from "../core/users.ts";
import { itemMaterials } from "../items/materials.ts";
import type { Item } from "../items/store.ts";

export function itemFlowSpaces(app: App, item: Item, extra: string[] = []) {
  const allowed = accessibleSpaces(app, item.userId);
  const spaces = new Set([item.spaceId, ...extra]);
  const readable = (id: string) => !allowed || allowed.includes(id);
  for (const material of itemMaterials(app, item.id)) {
    if (material.kind !== "repo") continue;
    const repo = findSpace(app, material.ref.split("#")[0]);
    if (!repo?.rootPath || !readable(repo.id)) continue;
    spaces.add(repo.id);
    if (repo.parentId) spaces.add(repo.parentId);
  }
  return [...spaces].filter(readable);
}
