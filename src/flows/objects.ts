import type { App } from "../core/app.ts";
import { all } from "../core/db.ts";
import { codeWork, type CodeWorkDetail } from "../agents/code-works.ts";
import { designFeedback, designForWork, designsOfItem } from "../designs/store.ts";
import type { Item } from "../items/store.ts";

export type FlowObject = { ref: string; title: string; status: string; done: boolean; link: string };
export type ObjectKind = { kind: string; label: string; find: (app: App, item: Item) => FlowObject | null };

/** Per-item run materials bound the lookup; codeWork uses the existing continuation indexes. */
export function latestCodeWork(app: App, item: Item): CodeWorkDetail | null {
  const runs = all<{ id: string }>(app.db, `select r.id from item_materials m join runs r on r.id=m.ref
    where m.item_id=? and m.kind='run' and r.kind='code' and coalesce(r.user_id,'owner')=? order by r.created_at desc, m.id desc`, item.id, item.userId);
  for (const r of runs) {
    const w = codeWork(app, r.id);
    if (!w || w.item?.id !== item.id) continue;
    const ids = w.roundList.map((x) => x.id);
    if (all<{ id: string }>(app.db, `select id from runs where id in (${ids.map(() => "?").join(",")}) and (json_extract(output,'$.discardedAt') is not null or json_extract(output,'$.supersededBy') is not null)`, ...ids).length) continue;
    return w;
  }
  return null;
}

/** Built-in registry. Plugin registration is deliberately left to a later phase. */
export const flowObjects: readonly ObjectKind[] = [
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
export const objectKind = (kind: string) => flowObjects.find((x) => x.kind === kind);
export const findObject = (app: App, item: Item, kind: string) => objectKind(kind)?.find(app, item) ?? null;
