import type { App } from "../core/app.ts";
import { foldChildContexts, syncRootContext } from "../channels/listen-items.ts";
import { rootOf, writeParent } from "./tree.ts";

/**
 * Hang an item under another, or take it out (`parent` null), checked as items/tree.ts checkParent
 * says. The item's own 关注 folds into its top-level one, and the groups of the line it went to and of
 * the one it left follow (channels/listen-items.ts).
 */
export function setParent(app: App, id: string, parent: string | null, actor: "agent" | "user" = "user", runId?: string) {
  const { item, before, changed } = writeParent(app, id, parent, actor, runId);
  if (!changed) return item;
  try {
    foldChildContexts(app);
    for (const x of new Set([rootOf(app, id), ...(before ? [rootOf(app, before)] : [])])) syncRootContext(app, x);
  } catch (e) {
    console.warn(`[omem] 事项归到上层后关注没有并好：${(e as Error).message}`);
  }
  return item;
}
