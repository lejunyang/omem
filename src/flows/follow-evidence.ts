import type { App } from "../core/app.ts";
import { all } from "../core/db.ts";
import { accessibleSpaces } from "../core/users.ts";
import { json } from "../core/util.ts";
import type { Item } from "../items/store.ts";

/** Follow batches and mention handlers can race even when the engine serializes individual reopens. */
const pending = new WeakMap<App, Map<string, Promise<unknown>>>();
export function withFollowEvidence<T>(app: App, userId: string, work: () => T | Promise<T>): Promise<T> {
  let lanes = pending.get(app);
  if (!lanes) pending.set(app, lanes = new Map());
  const before = lanes.get(userId);
  const result = before ? before.catch(() => {}).then(work) : Promise.resolve(work());
  lanes.set(userId, result);
  const clear = () => { if (lanes.get(userId) === result) lanes.delete(userId); };
  void result.then(clear, clear);
  return result;
}

const lineRef = /^src:([^#\s]+)#L(\d+)(?:-L?(\d+))?$/;
function ranges(refs: string[]) {
  return refs.flatMap(ref => {
    const m = lineRef.exec(ref);
    return m ? [{ source: m[1], first: Number(m[2]), last: Number(m[3] ?? m[2]) }] : [];
  });
}
export function overlappingRefs(app: App, refs: string[]) {
  const own = ranges(refs);
  const messages = (rr: ReturnType<typeof ranges>) => rr.flatMap(r =>
    all<{ message_id: string }>(app.db, `select message_id from lark_message_lines where source_id=? and line between ? and ?
      union select message_id from lark_messages where source_id=? and line between ? and ?`,
    r.source, r.first, r.last, r.source, r.first, r.last).map(m => m.message_id));
  const keys = new Set(messages(own));
  return (otherRefs: string[]) => {
    const other = ranges(otherRefs);
    return own.some(a => other.some(b => a.source === b.source && a.first <= b.last && b.first <= a.last))
      || keys.size > 0 && messages(other).some(id => keys.has(id));
  };
}

/** Only reopens in this instance of the flow count. The log is written before the engine advances. */
export function reopenForEvidence(app: App, itemId: string, startedAt: string, refs: string[], stageId?: string) {
  const overlaps = overlappingRefs(app, refs);
  return all<{ stage_id: string; refs: string }>(app.db, `select stage_id,refs from item_stage_log
    where item_id=? and event='reopen' and at>=? and (? is null or stage_id=?) order by at`, itemId, startedAt, stageId ?? null, stageId ?? null)
    .find(row => overlaps(json<string[]>(row.refs, [])));
}

/** A different open item of the same person has already taken this evidence. */
export function otherItemForEvidence(app: App, item: Item, refs: string[]) {
  const overlaps = overlappingRefs(app, refs), allowed = accessibleSpaces(app, item.userId);
  const sources = [...new Set(ranges(refs).flatMap(r => [r.source, ...all<{ id: string }>(app.db, `select id from sources
    where uri=(select uri from sources where id=? and kind='chat') and kind='chat'`, r.source).map(s => s.id)]))];
  const candidates = all<{ id: string; title: string; refs: string }>(app.db, `with other as (
    select id,title from items where user_id=? and id<>? and status in ('open','waiting','snoozed')
      and (${allowed ? "space_id in (select value from json_each(?))" : "1"})
  ), actions as (
    select i.id,i.title,c.refs,c.updated_at at from other i join item_changes c on c.item_id=i.id
      where c.type in ('scope','decision','blocker') and (c.status in ('merged','asked') or c.ask_id is not null)
    union all
    select i.id,i.title,l.refs,l.at from other i join item_flows f on f.item_id=i.id join item_stage_log l on l.item_id=i.id
      where l.event='reopen' and l.at>=f.started_at
  )
  select id,title,refs from actions
    where exists (select 1 from json_each(?) where instr(actions.refs,value)>0)
    order by at,id`, item.userId, item.id, ...(allowed ? [JSON.stringify(allowed)] : []), JSON.stringify(sources.map(id => `src:${id}#L`)));
  return candidates.find(row => overlaps(json<string[]>(row.refs, [])));
}
