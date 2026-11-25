import { cancelAsk } from "../agents/asks.ts";
import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { notifyChange } from "./change-notice.ts";
import { json, now } from "../core/util.ts";
import { refExcerpt } from "./evidence.ts";
import { getItem, upsertItem } from "./store.ts";

type Deadline = { id: string; item_id: string; due: string | null; summary: string; refs: string; ask_id: string | null };

export function applyDeadline(app: App, c: Deadline, actor: "agent" | "user", runId?: string) {
  const item = getItem(app, c.item_id), refs = json<string[]>(c.refs, []);
  const changed = item.dueAt !== c.due && !(item.dueAt?.includes("T") && c.due?.includes("T") && Date.parse(item.dueAt) === Date.parse(c.due));
  if (changed) upsertItem(app, c.item_id, { dueAt: c.due, sourceRefs: refs, note: `${c.summary}（依据：${refs.join(" ")}）` }, actor, runId);
  run(app.db, "update item_changes set status='merged',updated_at=? where id=?", now(), c.id);
  if (actor === "agent" && c.ask_id) cancelAsk(app, c.ask_id, "截止时间已经更新");
  if (changed) for (const other of all<{ id: string; ask_id: string | null }>(app.db, "select id,ask_id from item_changes where item_id=? and type='deadline' and status='asked' and id!=?", c.item_id, c.id)) {
    run(app.db, "update item_changes set status='dismissed',updated_at=? where id=?", now(), other.id);
    if (other.ask_id) cancelAsk(app, other.ask_id, "截止时间已经另外定了");
  }
  return changed;
}

export function decidedDeadline(app: App, c: Deadline, runId?: string) {
  const item = getItem(app, c.item_id), refs = json<string[]>(c.refs, []);
  if (!applyDeadline(app, c, "agent", runId)) return false;
  const title = `「${item.title}」截止时间变了`;
  const previous = one<{ id: string }>(app.db, "select id from notifications where title=? and json_extract(context,'$.entityId')=? order by rowid desc limit 1", title, item.id);
  const quotes = refs.map((ref, i) => {
    const text = refExcerpt(app, ref, 160, item.userId)?.text;
    return `[${i + 1}](${ref})${text ? ` 「${text.replace(/[\[\]*_`<>]/g, "")}」` : ""}`;
  });
  notifyChange(app, { userId: item.userId, title, body: `${c.summary}\n截止时间：${item.dueAt ?? "未定"} → ${c.due}\n原话：${quotes.join(" ")}`,
    entity: "item", entityId: item.id, sourceRefs: refs, runId, link: `#/items/${item.id}`, ...(previous ? { replaces: previous.id } : {}) });
  return true;
}
