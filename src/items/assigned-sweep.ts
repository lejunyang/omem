import { z } from "zod";
import { getRun } from "../agents/runs.ts";
import type { App } from "../core/app.ts";
import { all, one, withinTx } from "../core/db.ts";
import { can } from "../auth/permissions.ts";
import { OWNER, scopeFor } from "../core/users.ts";
import { notify } from "../core/notify.ts";
import { HttpError, localStamp, truncate, webLink } from "../core/util.ts";
import { upsertSource } from "../sources/store.ts";
import { getItem, upsertItem, UTC } from "./store.ts";

export const ASSIGNED_SWEEP_RULE = "builtin-assigned-sweep";
const prefix = "assigned:";
const urgencyWindow = 3 * 86_400_000;
const key = z.string().trim().min(1).max(500).regex(/^[^\s:]+:.+$/, "用平台（含实例）和该对象的稳定编号，不用标题");
const url = z.httpUrl().max(2000).refine(s => !new URL(s).username && !new URL(s).password, "原链接不能含登录凭据");
const objectInput = z.object({ key, url, title: z.string().trim().min(1).max(250),
  state: z.enum(["open", "waiting", "done", "cancelled"]), due_at: z.iso.datetime({ offset: true }).optional(), evidence: z.string().trim().min(1).max(4000) });
export const assignedInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list"), after: z.string().optional() }),
  objectInput.extend({ action: z.literal("save") }),
]);
export const assignedToolInput = objectInput.partial().extend({ action: z.enum(["list", "save"]), after: z.string().optional() });
type AssignedInput = z.infer<typeof assignedInput>;

export function isAssignedSweepRule(app: App, id: unknown) {
  return id === ASSIGNED_SWEEP_RULE && !!one(app.db, "select 1 from rules where id=? and enabled=1 and json_extract(trigger,'$.event')='schedule'", ASSIGNED_SWEEP_RULE);
}

// The source URI is the platform object's stable identity, the item's existing source_refs is the association.
// The snapshot retains the latest evidence and original link, without fetching or writing to the platform here.
const ASSIGNED_REFS = `from sources s join items i on exists(select 1 from json_each(i.source_refs) where value='src:'||s.id or substr(value,1,length(s.id)+5)='src:'||s.id||'#')
  where i.user_id=? and s.uri glob 'assigned:*'`;

export function syncAssigned(app: App, a: AssignedInput, ctx: { runId: string | null; userId?: string; spaceId: string; spaces?: string[] | null; writable?: string[] }) {
  const job = ctx.runId && getRun(app, ctx.runId);
  if (!job || job.kind !== "agent" || (ctx.userId ?? OWNER) !== OWNER || job.input.spec !== "assistant"
    || !isAssignedSweepRule(app, (job.input.rule as { id?: string } | undefined)?.id)) throw new HttpError(403, "只由本人已启用的指派清点规则运行使用");
  const scope = scopeFor(app, OWNER, ctx.spaces ?? null);
  const readable = (space: string) => (!scope || scope.includes(space)) && can(app, OWNER, "items.view", space);
  const writable = (space: string) => readable(space) && (!ctx.writable || ctx.writable.includes(space)) && can(app, OWNER, "items.edit", space) && can(app, OWNER, "sources.edit", space);
  if (a.action === "list") {
    const rows = all<{ id: string; uri: string; url: string; title: string; dueAt: string; space: string; sourceSpace: string }>(app.db, `select i.id,s.uri,json_extract(s.meta,'$.url') url,i.title,i.due_at dueAt,i.space_id space,s.space_id sourceSpace ${ASSIGNED_REFS}
      and i.status in ('open','waiting','snoozed','expired') and s.uri>?
      and (? is null or (i.space_id in (select value from json_each(?)) and s.space_id in (select value from json_each(?)))) order by s.uri limit 101`, OWNER, a.after ? prefix + a.after : prefix, ...Array<string | null>(3).fill(scope && JSON.stringify(scope)));
    const items = rows.slice(0, 100).filter(r => readable(r.space) && readable(r.sourceSpace)).map(({ uri, sourceSpace: _, ...r }) => ({ ...r, key: uri.slice(prefix.length) }));
    return { items, ...(rows.length > 100 && { after: rows[99].uri.slice(prefix.length) }) };
  }

  const uri = prefix + a.key;
  const tracked = one<{ id: string; space_id: string; url: string | null }>(app.db, `select i.id,s.space_id,json_extract(s.meta,'$.url') url ${ASSIGNED_REFS} and s.uri=? order by i.created_at,i.id limit 1`, OWNER, uri);
  // Reuse an item already linked through a provider or an attached platform object, if unambiguous.
  const linked = tracked ? [] : all<{ id: string }>(app.db, `select distinct i.id from items i where i.user_id=? and (
    exists(select 1 from external_item_links l where l.item_id=i.id and l.user_id=i.user_id and json_extract(l.snapshot,'$.url')=?)
    or exists(select 1 from item_materials m join flow_objects o on o.id=m.ref where m.item_id=i.id and m.kind='object' and o.link=?)) limit 2`, OWNER, a.url, a.url);
  if (linked.length > 1) throw new HttpError(409, "同一原链接已挂在多个事项上，先由本人确认要沿用哪一件");
  const id = tracked?.id ?? linked[0]?.id;
  const item = id ? getItem(app, id) : null;
  const space = item?.spaceId ?? ctx.spaceId;
  const sourceSpace = tracked?.space_id ?? space;
  if (!writable(space) || !writable(sourceSpace)) throw new HttpError(403, "不能在本次运行的范围内同步这个对象");
  const ended = a.state === "done" || a.state === "cancelled";
  if (!item && ended) return { result: "skipped" };
  if (item && (item.status === "cancelled" || item.status === "done" || item.status === "candidate")) return { result: "skipped", id: item.id };
  if (!ended && !a.due_at) throw new HttpError(400, "在办对象需要有据可查的截止时间（带时区）");
  const dueAt = a.due_at ? new Date(a.due_at).toISOString() : undefined;
  const src = upsertSource(app, { spaceId: sourceSpace, kind: "note", uri, title: a.title,
    text: `# ${a.title}\n\n原链接：${a.url}\n状态：${a.state}${dueAt ? `\n截止：${dueAt}` : ""}\n\n${a.evidence}`,
    meta: { originKey: uri, url: a.url } });
  const ref = `src:${src.id}`;
  // Do not count unchanged polls as progress; they must not keep a stale item out of the precheck.
  // A provider owns its state machine and may write status changes back. Never drive it from a sweep.
  const providerManaged = item && one(app.db, "select 1 from external_item_links where item_id=?", item.id);
  const status = providerManaged || (!ended && item?.status === "snoozed") ? item!.status : a.state;
  if (item && item.status === status && (!dueAt || (item.dueAt && Date.parse(item.dueAt) === Date.parse(dueAt))) && item.sourceRefs.includes(ref) && src.status === "unchanged")
    return { result: "unchanged", id: item.id };
  const saved = withinTx(app.db, () => {
    // Check the association again under the write lock before creating a new item.
    const existing = item?.id ?? one<{ id: string }>(app.db, `select i.id ${ASSIGNED_REFS} and s.uri=? order by i.created_at,i.id limit 1`, OWNER, uri)?.id;
    if (!item && existing) return { item: getItem(app, existing), created: false };
    return { item: upsertItem(app, existing, {
      ...(existing ? (tracked?.url && item?.detail === `原链接：${tracked.url}` ? { detail: `原链接：${a.url}` } : {})
        : { title: a.title, spaceId: space, userId: OWNER, detail: `原链接：${a.url}`, providerUrl: a.url }),
      status, dueAt, sourceRefs: [ref], note: ended && !providerManaged ? "清点指派：原平台确认已结束" : "清点指派：已核对原平台的状态和期限",
    }, "agent", job.id), created: !existing };
  });
  const ms = dueAt ? Date.parse(dueAt) - Date.now() : Infinity;
  return { result: saved.created ? "created" : "updated", id: saved.item.id, ...(saved.created && { notify: ms > 0 && ms <= urgencyWindow }) };
}

/** The morning card also includes standalone assigned items, not only work under a line. */
export function assignedForToday(app: App, userId: string) {
  if (userId !== OWNER) return [];
  return all<{ id: string; title: string; due_at: string }>(app.db, `select i.id,i.title,i.due_at from items i where i.user_id=?
    and i.status in ('open','waiting','snoozed') and i.due_at is not null and exists(
      select 1 from json_each(i.source_refs) j join sources s on ('src:'||s.id=j.value or 'src:'||s.id||'#'=substr(j.value,1,length(s.id)+5)) where s.uri glob 'assigned:*' and s.deleted_at is null)
    order by ${UTC("i.due_at")}, i.id limit 6`, userId);
}

/** Only newly created and still active items within three days go on the one notification. */
export function notifyAssignedSweep(app: App, runId: string, at = new Date()) {
  if (one(app.db, "select 1 from notifications where json_extract(context,'$.runId')=?", runId)) return;
  const rows = all<{ id: string; title: string; due_at: string }>(app.db, `select i.id,i.title,i.due_at from item_events e join items i on i.id=e.item_id
    where e.run_id=? and e.kind='created' and i.user_id=? and i.status in ('open','waiting','snoozed') and ${UTC("i.due_at")}>? and ${UTC("i.due_at")}<=?
    order by ${UTC("i.due_at")}, i.id`, runId, OWNER, at.toISOString(), new Date(at.getTime() + urgencyWindow).toISOString());
  if (!rows.length) return;
  notify(app, { title: `新发现 ${rows.length} 件三天内到期的指派`, userId: OWNER, runId, link: "#/items",
    body: [...rows.slice(0, 10).map(i => `- [${truncate(i.title.replace(/\s+/g, " "), 60)}](${webLink(app, `#/items/${i.id}`)})：${localStamp(i.due_at, app.config.timezone)} 截止`),
      ...(rows.length > 10 ? [`还有 ${rows.length - 10} 件，见事项页。`] : [])].join("\n") });
}
