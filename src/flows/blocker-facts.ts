import type { App } from "../core/app.ts";
import { all, one } from "../core/db.ts";
import { json, truncate } from "../core/util.ts";
import { accessibleSpaces, identitiesOf, OWNER } from "../core/users.ts";
import { sourceVisible } from "../auth/visibility.ts";
import { deliveryCodeRounds } from "./delivery.ts";
import { itemChats } from "../channels/listen-items.ts";
import type { Item } from "../items/store.ts";

export type ItemFact = { at: string; summary: string; refs: string[]; owner?: boolean; chatKey?: string };
type FactRow = { at: string; summary: string; refs: string; owner: number; chatKey?: string; source?: string | null; space?: string | null };
export const shortFact = (s: string, max = 160) => truncate(s.replace(/\s+/g, " ").trim(), max);

// These queries read the same records used by the work timeline, materials, conversation history,
// and delivery checks. They never refresh an object, fetch a document, or read its body.
export function itemFacts(app: App, item: Item, since: string, through: string, chatSince = since): ItemFact[] {
  const args = { item: item.id, user: item.userId, since, through };
  const local = app.db.prepare(`select * from (
    select coalesce(json_extract(c.added,'$[#-1].at'),c.at) at, substr(c.summary,1,300) summary, c.refs, c.origin='owner' owner, null source, null space
      from item_changes c left join runs r on r.id=c.run_id
      where c.item_id=$item and c.updated_at>$since and c.updated_at<=$through
        and coalesce(r.kind,'') not in ('flow-blocker-check','flow-reconcile')
        and (c.origin!='flow' or c.type!='stage')
    union all
    select e.at,substr(e.text,1,300),e.source_refs,e.actor in ('owner','user'),null,null
      from item_events e left join runs r on r.id=e.run_id
      where e.item_id=$item and e.at>$since and e.at<=$through
        and e.kind not in ('created','stage','reminded','reminder-failed','reminder-scheduled')
        and coalesce(r.kind,'') not in ('flow-blocker-check','flow-reconcile')
    union all
    select l.at, '阶段「' || coalesce(json_extract(d.value,'$.name'),l.stage_id) || '」' ||
      case l.to_state when 'done' then '完成' when 'skipped' then '跳过' else '状态变化' end || '：' || substr(l.note,1,180),
      l.refs,l.actor in ('owner','user'),null,null
      from item_stage_log l join item_flows f on f.item_id=l.item_id
      left join json_each(f.definition,'$.stages') d on json_extract(d.value,'$.id')=l.stage_id
      left join runs r on r.id=l.run_id
      where l.item_id=$item and l.at>$since and l.at<=$through and l.from_state!=l.to_state
        and (l.to_state in ('done','skipped','stale') or l.event='reopen')
        and coalesce(r.kind,'')!='flow-reconcile'
    union all
    select m.created_at, '加入材料：' || substr(m.label,1,180),
      case m.kind when 'source' then json_array('src:' || m.ref) when 'run' then json_array(m.ref)
        when 'object' then json_array('object:' || m.ref) else '[]' end,
      m.added_by='user',s.id,coalesce(s.space_id,c.space_id,r.space_id)
      from item_materials m left join sources s on m.kind='source' and s.id=m.ref and s.deleted_at is null
      left join conversations c on m.kind='conversation' and c.id=m.ref left join runs r on m.kind='run' and r.id=m.ref
      where m.item_id=$item and m.created_at>$since and m.created_at<=$through
        and (m.kind!='source' or s.id is not null) and (m.kind!='conversation' or c.user_id=$user)
        and (m.kind!='run' or coalesce(r.user_id,'owner')=$user)
    union all
    select s.updated_at,'材料有更新：' || substr(s.title,1,180),json_array('src:' || s.id),0,s.id,s.space_id
      from item_materials m join sources s on m.kind='source' and s.id=m.ref
      where m.item_id=$item and s.kind!='chat' and s.deleted_at is null
        and s.updated_at>max($since,m.created_at) and s.updated_at<=$through
    union all
    select n.updated_at,'需求材料有更新：' || substr(n.title,1,180),json_array('req:' || n.id),0,null,n.space_id
      from item_materials m join req_nodes n on m.kind='req' and n.id=m.ref
      where m.item_id=$item and n.updated_at>max($since,m.created_at) and n.updated_at<=$through
    union all
    select msg.created_at,'本人在关联会话说：' || substr(msg.text,1,200),json_array('msg:' || msg.id),1,null,c.space_id
      from item_materials m join conversations c on m.kind='conversation' and c.id=m.ref and c.user_id=$user
      join messages msg on msg.conversation_id=c.id
      where m.item_id=$item and msg.created_at>$since and msg.created_at<=$through and msg.role='user'
        and coalesce(json_extract(msg.meta,'$.command'),0)=0 and json_extract(msg.meta,'$.speaker') is null
        and json_extract(msg.meta,'$.asker') is null and coalesce(json_extract(msg.meta,'$.backlog'),0)=0
        and (c.channel not like 'lark%' or not exists(
          select 1 from lark_messages l where l.message_id=json_extract(msg.meta,'$.externalId') and l.sender_kind='owner' and $user='owner'
          and not exists(select 1 from identities i where i.channel like 'lark%' and i.external_id=l.sender_id and i.user_id!=$user)))
    union all
    select a.answered_at,'本人已处理提问：' || substr(coalesce(nullif(a.answer,''),a.question),1,180),'[]',1,null,null
      from asks a where a.status='answered' and a.user_id=$user and a.answered_at>$since and a.answered_at<=$through
        and json_extract(a.context,'$.itemId')=$item
  ) where at>$since order by at desc limit 100`).all(args) as FactRow[];

  const coding = deliveryCodeRounds(app, item, since, through).map(r => {
    const outcome = r.status === "done" && r.verdict === "approved" ? "评审通过" : ({ done: "结束", cancelled: "取消" }[r.status] ?? "失败");
    return { at: r.at, summary: `编码第 ${r.round} 轮${outcome}：${r.summary}`, refs: JSON.stringify([r.id]), owner: 0, space: r.space };
  });
  return visibleFacts(app, item, [...local, ...coding, ...chatFacts(app, item, chatSince, through)]);
}

function chatFacts(app: App, item: Item, since: string, through: string): FactRow[] {
  const chats = itemChats(app, item.id);
  if (!chats.length) return [];
  const ownIds = identitiesOf(app, item.userId).filter(i => i.channel.startsWith("lark")).map(i => i.external_id);
  if (item.userId === OWNER && app.config.lark.ownerOpenId) ownIds.push(app.config.lark.ownerOpenId);
  for (const bot of app.config.lark.bots) if ((bot.userId ?? OWNER) === item.userId && bot.ownerOpenId) ownIds.push(bot.ownerOpenId);
  return chats.flatMap(chat => all<FactRow>(app.db, `select
    strftime('%Y-%m-%dT%H:%M:%fZ',create_ms/1000.0,'unixepoch') at,
    '本人在关联群说：' || substr(content,1,200) summary,
    case when source_id is not null and line is not null then json_array('src:' || source_id || '#L' || line)
      else json_array('lark:' || message_id) end refs,1 owner,source_id source,message_id chatKey
    from lark_messages l where chat_id=? and create_ms>? and create_ms<=?
      and msg_type in ('text','post') and trim(content)!=''
      and (sender_id in (select value from json_each(?)) or (?='owner' and sender_kind='owner'
        and not exists(select 1 from identities i where i.channel like 'lark%' and i.external_id=l.sender_id and i.user_id!='owner')))
      and (?='owner' or source_id is not null)
    order by create_ms desc limit 30`, chat, Date.parse(since), Date.parse(through), JSON.stringify(ownIds), item.userId, item.userId));
}

function visibleFacts(app: App, item: Item, rows: FactRow[]) {
  const spaces = accessibleSpaces(app, item.userId);
  const seen = new Set<string>();
  return rows.sort((a, b) => a.at.localeCompare(b.at)).flatMap((r): ItemFact[] => {
    const refs = json<string[]>(r.refs, []);
    const sources = r.source ? [r.source] : [];
    for (const ref of refs) if (ref.startsWith("src:")) sources.push(ref.slice(4).split("#")[0]);
    if (r.space && spaces && !spaces.includes(r.space) || sources.some(id => sourceVisible(app, item.userId, id) !== true)) return [];
    const summary = shortFact(r.summary);
    const key = `${r.at}:${summary}`;
    if (!summary || seen.has(key)) return [];
    seen.add(key);
    return [{ at: r.at, summary, refs: refs.slice(0, 4), ...(r.owner ? { owner: true } : {}), ...(r.chatKey ? { chatKey: r.chatKey } : {}) }];
  });
}

/** Owner activity can predate the new-facts cursor and still shorten today's interval. */
export function lastBlockerOwnerAction(app: App, item: Item, since: string, through: string) {
  const event = one<{ at: string }>(app.db, `select max(at) at from (
    select at from item_events where item_id=? and actor in ('owner','user') and at>? and at<=?
    union all select at from item_changes where item_id=? and origin='owner' and noise=0 and at>? and at<=?
  )`, item.id, since, through, item.id, since, through)?.at;
  // Only used once a new batch is ready, or before applying its decision.
  const speech = itemFacts(app, item, since, through).findLast(f => f.owner)?.at;
  return [event, speech].sort().filter(Boolean).at(-1);
}
