import type { App } from "../core/app.ts";
import { capabilityAccess } from "../auth/capabilities.ts";
import { all } from "../core/db.ts";
import { accessibleSpaces, OWNER } from "../core/users.ts";
import { toAsk } from "../agents/asks.ts";
import { draftSkillSummary } from "../agents/specs.ts";
import { plainText } from "../search/present.ts";
import { CHANGE_COLS, type changeLite } from "./changes.ts";
import { listItems } from "./store.ts";
import { contentVersion, fingerprint, mayPropose } from "./choices.ts";

export type PendingAction = {
  id: string;
  via: "ask" | "stage" | "change" | "candidate" | "draft" | "metric" | "profile" | "skill" | "item-update";
  group: "ask" | "approve" | "work" | "propose" | "reply";
  label: string;
  title: string;
  itemId?: string; lineId?: string; lineTitle?: string; askId?: string;
  href: string; count?: number; createdAt: string; deadline?: string;
};

function titleOf(text: string) {
  const paragraph = text.trim().split(/\r?\n\s*\n/, 1)[0];
  const plain = plainText(paragraph);
  return plain.match(/^.*?(?:[。！？!?]|\.(?=\s|$)|$)/)?.[0] ?? plain;
}

const askCategories: Record<string, [PendingAction["group"], string]> = {
  "today": ["propose", "今天"], "line-propose": ["propose", "工作线"], "line-next": ["propose", "下一步"], "line-end": ["propose", "工作线"],
  "wiki-questions": ["ask", "提问"], "item-follow": ["propose", "变化"], "flow-stage": ["work", "流程"], "flow-save": ["propose", "流程"],
  "rule-enable": ["propose", "规则"], "reply-promote": ["propose", "回复"], "approval-promote": ["propose", "授权"],
  "flow-gate-promote": ["propose", "授权"], "commit-claim": ["work", "认领"], "study-plan": ["work", "课题"],
};

function askCategory(ask: ReturnType<typeof toAsk>): [PendingAction["group"], string] {
  if (ask.kind === "approval") return ["approve", "审批"];
  if (ask.handler && askCategories[ask.handler]) return askCategories[ask.handler];
  if (ask.handler && /^(code-|review-|work-deliver|design-confirm)/.test(ask.handler)) return ["work", "编码"];
  return ask.kind === "suggestion" ? ["propose", "提议"] : ["ask", "提问"];
}

/** The person's spaces as a `scope` CTE: `visible(col)` keeps rows outside them out. */
function scoped(app: App, userId: string) {
  const spaces = accessibleSpaces(app, userId);
  const visible = (column: string) => spaces ? `(${column} is null or ${column} in (select value from scope))` : "1";
  const rows = <T>(sql: string, ...params: (string | number)[]) => all<T>(app.db, `with recursive scope as (select value from json_each(?)) ${sql}`, JSON.stringify(spaces), ...params);
  return { spaces, visible, rows };
}

export type PendingMetric = { id: string; name: string; why: string; unit: string; itemId: string | null; at: string };

/** The metrics agents proposed that wait for the person (the data page's “等你确认”), newest first. */
export function pendingMetrics(app: App, userId: string, limit = 100): PendingMetric[] {
  const { visible, rows } = scoped(app, userId);
  // A proposal the person put off (以后再说) or said no to in another place stays out until that runs out (items/choices.ts).
  return rows<PendingMetric & { q: string }>(
    `select m.id,m.name,coalesce(m.why,'') why,coalesce(m.unit,'') unit,i.id itemId,m.created_at at,coalesce(m.query,'') q from metrics m left join listen_contexts l on l.id=m.context_id
     left join items i on i.id=coalesce(m.item_id,l.item_id) left join runs r on r.id=m.defined_run
     left join spaces home on home.id=m.space_id and home.kind='personal'
     where m.status='proposed' and coalesce(i.user_id,r.user_id,home.owner_id,'owner')=? and ${visible("m.space_id")}
       and ${visible("l.space_id")} and ${visible("i.space_id")} and ${visible("r.space_id")}
     order by m.created_at desc limit ?`, userId, limit)
    .filter((m) => mayPropose(app, userId, "metric", fingerprint(m.name), fingerprint(m.q)).ok).map(({ q: _q, ...m }) => m);
}

export type PendingProfileProposal = { id: string; target: string; kind: "prompt" | "skill" | "settings"; title: string; reason: string; at: string; noticedAt: string | null };

/** What profile reviews proposed for the owner's agents and roles (agents/proposals.ts), oldest notice first, then newest. Only the owner's. */
export function pendingProfileProposals(app: App, userId: string, limit = 100): PendingProfileProposal[] {
  if (userId !== OWNER) return [];
  const { visible, rows } = scoped(app, userId);
  // Put off or said no to in another place (items/choices.ts): left out until that runs out or the change reads differently.
  return rows<PendingProfileProposal & { body: string }>(`select p.id,p.target,p.kind,p.title,coalesce(p.reason,'') reason,p.created_at at,p.expiry_notice_at noticedAt,p.body
    from profile_proposals p left join runs r on r.id=p.run_id
    where p.status='pending' and coalesce(r.user_id,'owner')=? and ${visible("r.space_id")}
    order by p.expiry_notice_at is null, p.created_at desc limit ?`, userId, limit)
    .filter((p) => mayPropose(app, userId, "profile", `${p.target}:${p.kind}:${fingerprint(p.title)}`, contentVersion(p.body)).ok).map(({ body: _b, ...p }) => p);
}

/** Both endpoints use these same visible source rows, including the per-change card association. */
export async function pendingView(app: App, userId: string) {
  const { spaces, visible, rows } = scoped(app, userId);
  const itemOwner = "coalesce(i.user_id,'owner') = ?";
  const askRows = rows<Parameters<typeof toAsk>[0] & { itemId: string | null; deadline: string | null }>(
    `select a.*, i.id itemId, coalesce(json_extract(a.context,'$.deadline'),json_extract(a.context,'$.expiresAt')) deadline
     from asks a left join runs r on r.id=coalesce(a.run_id,json_extract(a.context,'$.runId')) left join conversations t on t.id=a.conversation_id
     left join items i on i.id=coalesce(json_extract(a.context,'$.itemId'),json_extract(a.context,'$.lineId'),json_extract(r.input,'$.itemId'),json_extract(r.input,'$.lineState'))
     where a.status='pending' and a.user_id=? and (i.id is null or ${itemOwner}) and ${visible("i.space_id")}
       and ${visible("r.space_id")} and ${visible("t.space_id")} and ${visible("json_extract(a.context,'$.spaceId')")}
       and ${visible("json_extract(a.context,'$.repo')")}
       ${spaces ? `and (coalesce(json_extract(a.context,'$.handler'),'') not in ('line-next','line-propose') or not exists (
         select 1 from (
           select n.item_id id from json_each(a.context,'$.next') refs join item_next n on n.id=refs.value
           union all select json_extract(l.value,'$.id') from json_each(a.context,'$.lines') l
           union all select ref.value from json_each(a.context,'$.proposals') p join json_each(p.value,'$.items') ref
         ) linked join items related on related.id=linked.id
         where related.user_id!=a.user_id or related.space_id not in (select value from scope)
       ))` : ""}
     order by a.created_at desc, a.id limit 100`, userId, userId);
  const actions: PendingAction[] = [];
  // An item opens on its work page for whoever may open the work pages (their own lines there), else on 事项.
  const workPage = userId === OWNER || !!capabilityAccess(app, userId).range("work.view")?.length;
  function add(via: PendingAction["via"], key: string, group: PendingAction["group"], label: string, title: string, createdAt: string,
    extra: Partial<Pick<PendingAction, "itemId" | "lineId" | "lineTitle" | "askId" | "href" | "count" | "deadline">> = {}) {
    actions.push({ id: `${via}:${key}`, via, group, label, title: titleOf(title), createdAt,
      href: extra.itemId ? `#/${workPage ? "work" : "items"}/${encodeURIComponent(extra.itemId)}` : "#/work", ...extra });
  }
  const asks = askRows.map(row => toAsk(row, userId));
  const askIds = new Set(asks.map(a => a.id));
  for (const [n, ask] of asks.entries()) {
    const { itemId, deadline } = askRows[n];
    const [group, label] = askCategory(ask);
    add("ask", ask.id, group, label, ask.question, ask.createdAt, { askId: ask.id, href: `#/ui/${ask.id}`, ...(itemId && { itemId }), ...(deadline && { deadline }) });
  }

  const gates = rows<{ itemId: string; title: string; flowName: string; stageId: string; name: string; state: string; since: string; askId: string | null }>(
    `select i.id itemId, i.title, json_extract(f.definition,'$.name') flowName, s.stage_id stageId,
       json_extract(d.value,'$.name') name, s.state, s.since, s.ask_id askId
     from item_stages s join items i on i.id=s.item_id join item_flows f on f.item_id=s.item_id
     join json_each(f.definition,'$.stages') d on json_extract(d.value,'$.id')=s.stage_id
     where f.ended_at is null and ${itemOwner} and ${visible("i.space_id")}
       and (s.state='gated' or s.waiting_on='owner' or (s.state='doing' and s."by"='owner'))
     order by s.since limit 100`, userId)
    .map(r => ({ itemId: r.itemId, title: r.title, flowName: r.flowName ?? "", stage: { id: r.stageId, name: r.name ?? r.stageId, state: r.state }, since: r.since, askId: r.askId }));
  for (const g of gates) if (!g.askId || !askIds.has(g.askId))
    add("stage", `${g.itemId}:${g.stage.id}`, "work", "流程", `${g.title} · ${g.stage.name}`, g.since, { itemId: g.itemId });

  const changes = rows<Parameters<typeof changeLite>[1]>(`select ${CHANGE_COLS} from item_changes c join items i on i.id=c.item_id
    where c.status='asked' and ${itemOwner} and ${visible("i.space_id")}
    and (c.ask_id is null or c.ask_id not in (select value from json_each(?))) order by c.at desc limit 100`, userId, JSON.stringify([...askIds]));
  for (const c of changes) add("change", c.id, "propose", "变化", c.summary, c.at, { itemId: c.item_id });

  const candidates = listItems(app, { userId, status: "candidate", spaceIds: spaces ?? undefined, limit: 100 });
  for (const c of candidates) add("candidate", c.id, "propose", "候选", c.title, c.createdAt, { itemId: c.id, href: `#/items/${c.id}`, ...(c.dueAt && { deadline: c.dueAt }) });

  const updates = rows<{ id: string; itemId: string; note: string; at: string }>(
    `select p.id,p.item_id itemId,p.note,p.created_at at from item_update_proposals p join items i on i.id=p.item_id
     where p.status='pending' and p.user_id=? and ${itemOwner} and ${visible("p.from_space")} and ${visible("i.space_id")}
     order by p.created_at desc limit 100`, userId, userId);
  for (const p of updates) add("item-update", p.id, "propose", "更新", p.note, p.at, { itemId: p.itemId });

  const metrics = pendingMetrics(app, userId);

  const itemIds = [...new Set([...actions, ...metrics].map(a => a.itemId).filter(Boolean))];
  const roots = new Map(rows<{ seed: string; id: string; title: string }>(`, ancestors(seed,id,title,parent,depth) as (
    select i.id,i.id,i.title,i.parent_id,0 from json_each(?) seed join items i on i.id=seed.value
    union all select a.seed,i.id,i.title,i.parent_id,a.depth+1 from ancestors a join items i on i.id=a.parent
      where a.depth<10 and ${itemOwner} and ${visible("i.space_id")}
    ) select seed,id,title from ancestors order by depth`, JSON.stringify(itemIds), userId).map(r => [r.seed, { id: r.id, title: r.title }]));
  const metricGroups = new Map<string, { count: number; at: string; root?: { id: string; title: string } }>();
  for (const m of metrics) {
    const root = roots.get(m.itemId ?? "");
    const key = root?.id ?? "unassigned";
    const g = metricGroups.get(key);
    if (g) g.count++;
    else metricGroups.set(key, { count: 1, at: m.at, root });
  }
  for (const [key, { count, at, root }] of metricGroups) {
    add("metric", key, "propose", "指标", `${count} 个指标等确认`, at, {
      count, ...(root && { itemId: root.id, lineId: root.id, lineTitle: root.title }), href: "#/insights?tab=work",
    });
  }
  for (const a of actions) {
    const root = roots.get(a.itemId ?? "");
    if (root) Object.assign(a, { lineId: root.id, lineTitle: root.title });
  }

  let drafts = 0;
  if (userId === OWNER) {
    const draftSince = new Date(Date.now() - 2 * 86_400_000).toISOString();
    const cards = rows<{ purpose: string; at: string; count: number }>(`select purpose,max(at) at,count(*) count from (
      select c.purpose,c.created_at at from card_interactions c left join runs r on r.id=c.run_id left join conversations t on t.id=c.conversation_id
      where c.status='open' and c.purpose in ('draft','mention-reply','watch-draft','meeting-answer')
        and c.created_at >= ? and coalesce(r.user_id,t.user_id,'owner')=? and ${visible("r.space_id")} and ${visible("t.space_id")}
      order by c.created_at desc limit 100) group by purpose`, draftSince, userId);
    for (const c of cards) {
      drafts += c.count;
      add("draft", c.purpose, "reply", "草稿", `${c.count} 条回复草稿在飞书里等你点发送`, c.at, { count: c.count, href: app.config.lark.appId ? `https://applink.feishu.cn/client/bot/open?appId=${encodeURIComponent(app.config.lark.appId)}` : "#/work" });
    }
    const profiles = pendingProfileProposals(app, userId);
    if (profiles.length) add("profile", "pending", "propose", "档案", `${profiles.length} 个档案或角色修改等确认`, profiles.reduce((a, p) => (p.at > a ? p.at : a), ""), { count: profiles.length, href: "#/agents?tab=agents" });
    const skills = await draftSkillSummary(app);
    if (skills) add("skill", "drafts", "propose", "技能", `${skills.count} 个技能草稿等确认`, skills.at, { count: skills.count, href: "#/agents?tab=skills" });
  }
  const pending = actions.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  return { pending, asks: asks.filter(a => a.kind !== "suggestion"), candidates, changes, gates, drafts, roots };
}

export async function pendingActions(app: App, userId: string) {
  return (await pendingView(app, userId)).pending;
}
