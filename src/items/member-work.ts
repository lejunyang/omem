import { capabilityAccess } from "../auth/capabilities.ts";
import { canReadRun } from "../auth/permissions.ts";
import type { App } from "../core/app.ts";
import { all, one } from "../core/db.ts";
import { nameForOthers, OWNER } from "../core/users.ts";
import { HttpError, zonedParts, zoneMidnight } from "../core/util.ts";
import { itemContext } from "../channels/listen.ts";
import { itemAccess } from "./access.ts";
import { CHANGE_COLS, changeLite, refTargets, textTargets, type ChangeLite, type RefTarget } from "./changes.ts";
import { endedLines, endReason, guardsOf, type EndedLine } from "./lifecycle.ts";
import { lineRoutine } from "./member-routine.ts";
import { materialViews } from "./materials.ts";
import { nextOf, type NextLite } from "./lines.ts";
import { pendingView } from "./pending.ts";
import { getItem, isClosed, listItems, type Item } from "./store.ts";
import { ancestorIds, MAX_DEPTH, rootOf } from "./tree.ts";
import { childrenOf, flowLite, type Child, type ItemLite, type Line } from "./work-http.ts";

/**
 * The work page for someone other than the owner (docs/v2/multi-user.md “成员的线”): the lines they
 * may read, whole, and their own “等我的”.
 *
 * Which lines: their own (in the spaces where they may read their own items), and the owner's lines in
 * the spaces where they have 看工作线 (`work.view`; never a personal space). Other members' lines are
 * not shown. Under a line, each item goes by its own space and whose it is: their own; or the owner's
 * in a 看工作线 space that they may read as an item (`items.view`, items/access.ts), not a candidate and
 * not one the owner keeps waiting or snoozed. An item under one they may not see is not seen either.
 *
 * What they may not see does not show and is not counted. A line's state (`now`: the sentence as of
 * today, its people, its weeks, the closing summary), its own next steps and the reason it ended are
 * written over the whole line and may name what they may not see: a line with any such item gives
 * none of them (`partial`), only the items they may read with their own stages. References in changes
 * and next steps that name an item or a run they may not read are left as plain text.
 */
export type Viewer = { userId: string; work: Set<string>; own: Set<string> };
type Row = { id: string; parentId: string | null; userId: string; spaceId: string; status: string };
/** The owner's items a reader of the line does not get to see even with 看事项. */
const PRIVATE_STATUSES = ["candidate", "waiting", "snoozed"];

export function viewerOf(app: App, userId: string): Viewer {
  const access = capabilityAccess(app, userId);
  return { userId, work: new Set(access.range("work.view") ?? []), own: new Set(access.range("items.view", true) ?? []) };
}

/** Whether this person sees this item under a line they see. */
export function seesItem(app: App, v: Viewer, r: Pick<Row, "userId" | "spaceId" | "status">) {
  if (r.userId === v.userId) return v.own.has(r.spaceId);
  if (r.userId !== OWNER || !v.work.has(r.spaceId) || PRIVATE_STATUSES.includes(r.status)) return false;
  return itemAccess(app, v.userId, r, "read");
}

/** Whether this person sees this top-level item as a line at all (its items are checked one by one). */
export function seesLine(v: Viewer, item: Pick<Item, "userId" | "spaceId" | "status" | "parentId">) {
  if (item.parentId) return false;
  if (item.userId === v.userId) return v.own.has(item.spaceId);
  return item.userId === OWNER && v.work.has(item.spaceId) && !PRIVATE_STATUSES.includes(item.status);
}

/** Everything under a line, level by level, and which of it this person sees (an item under a hidden one is hidden). */
export function visibleTree(app: App, v: Viewer, rootId: string) {
  const rows: Row[] = [];
  const visible = new Set<string>([rootId]);
  let level = [rootId];
  const seen = new Set(level);
  for (let depth = 0; depth < MAX_DEPTH + 2 && level.length; depth++) {
    const next = all<Row>(app.db, `select id, parent_id parentId, coalesce(user_id,'owner') userId, space_id spaceId, status from items
      where parent_id in (select value from json_each(?)) order by created_at, id limit 2000`, JSON.stringify(level)).filter((r) => !seen.has(r.id));
    for (const r of next) {
      seen.add(r.id);
      rows.push(r);
      if (visible.has(r.parentId ?? "") && seesItem(app, v, r)) visible.add(r.id);
    }
    level = next.map((r) => r.id);
  }
  return { rows, visible, partial: rows.some((r) => !visible.has(r.id)) };
}

/** The references this person may follow: their items and the ones they see, the runs they may read. */
export function scrubTargets(app: App, v: Viewer, targets: Record<string, RefTarget> | undefined) {
  if (!targets) return undefined;
  const out: Record<string, RefTarget> = {};
  for (const [ref, t] of Object.entries(targets)) {
    if (t.kind === "item") {
      const r = one<Row>(app.db, "select id, parent_id parentId, coalesce(user_id,'owner') userId, space_id spaceId, status from items where id = ?", t.id);
      if (r && seesItem(app, v, r)) out[ref] = t;
    } else if (canReadRun(app, v.userId, t.id)) out[ref] = t;
  }
  return Object.keys(out).length ? out : undefined;
}

function scrubChange(app: App, v: Viewer, c: ChangeLite): ChangeLite {
  const { refTargets: t, runId, ...rest } = c;
  const targets = scrubTargets(app, v, t);
  return { ...rest, ...(targets ? { refTargets: targets } : {}), ...(runId && canReadRun(app, v.userId, runId) ? { runId } : {}) };
}

function nextFor(app: App, v: Viewer, item: Item): NextLite[] {
  return nextOf(app, item.id, ["open", "doing"]).map(({ refTargets: _t, runId, ...n }) => {
    const targets = scrubTargets(app, v, refTargets(app, n.refs, item.userId));
    return { ...n, runId: runId && canReadRun(app, v.userId, runId) ? runId : null, ...(targets ? { refTargets: targets } : {}) };
  });
}

function changesOf(app: App, v: Viewer, ids: string[], limit: number) {
  const rows = all<Parameters<typeof changeLite>[1]>(app.db, `select ${CHANGE_COLS} from item_changes c join items i on i.id = c.item_id
    where c.item_id in (select value from json_each(?)) and c.noise = 0 and c.status in ('noted','confirmed') order by c.at desc, c.id desc limit ?`, JSON.stringify(ids), limit);
  const lines = new Map<string, { id: string; title: string }>();
  return rows.map((r) => scrubChange(app, v, changeLite(app, r, lines)));
}

function prune(list: Child[], visible: Set<string>): Child[] {
  return list.filter((c) => visible.has(c.id)).map(({ children, ...c }) => {
    const kids = children ? prune(children, visible) : [];
    return { ...c, ...(kids.length ? { children: kids } : {}) };
  });
}

const todayStart = (app: App) => zoneMidnight(zonedParts(new Date(), app.config.timezone).date, app.config.timezone).toISOString();
/** How someone other than the owner sees a person named: the owner by their own name (“本人” is the owner's word for themselves). */
export const displayName = (app: App, id: string) => nameForOthers(app, id);
const person = (app: App, id: string) => ({ id, name: displayName(app, id) });

export type MemberLine = Line & { partial: boolean; mine: boolean; person: { id: string; name: string }; can: { edit: boolean; operate: boolean } };

export function memberLineView(app: App, v: Viewer, item: Item): MemberLine {
  const tree = visibleTree(app, v, item.id);
  const ids = [...tree.visible];
  const counts = one<{ n: number; today: number; last: string | null }>(app.db,
    `select count(*) n, coalesce(sum(at >= ?), 0) today, max(at) last from item_changes where item_id in (select value from json_each(?)) and noise = 0 and status in ('noted','confirmed')`,
    todayStart(app), JSON.stringify(ids))!;
  const mine = item.userId === v.userId;
  const c = mine ? itemContext(app, item.id) : null;
  const g = item.phase === "watching" && !tree.partial ? guardsOf(app, item) : null;
  return {
    id: item.id, title: item.title, kind: item.kind, status: item.status, dueAt: item.dueAt, spaceId: item.spaceId,
    now: tree.partial ? null : item.now,
    counts: { changes: counts.n, today: counts.today, lastAt: counts.last },
    timeline: changesOf(app, v, ids, 6).reverse(),
    next: tree.partial ? [] : nextFor(app, v, item),
    children: prune(childrenOf(app, item.id), tree.visible),
    listen: c && c.status === "active" ? { id: c.id, assist: c.knobs.assist ?? "off" } : null,
    phase: item.phase, phaseSince: item.phaseSince, watchUntil: item.watchUntil,
    ...(g ? { watch: { flaggedMetrics: g.flaggedMetrics, openProblems: g.openProblems, openItems: g.openItems } } : {}),
    partial: tree.partial, mine, person: person(app, item.userId),
    can: { edit: itemAccess(app, v.userId, item, "write"), operate: itemAccess(app, v.userId, item, "operate") },
  };
}

const IS_LINE = `(i.kind='line' or i.phase='watching' or exists(select 1 from item_flows f where f.item_id=i.id and f.ended_at is null)
  or exists(select 1 from items c where c.parent_id=i.id and c.status!='candidate')
  or exists(select 1 from listen_contexts l where l.item_id=i.id and l.kind='item' and l.status='active'))`;

/** The person's ended lines and the owner's they may read, newest first; a search on a partial line's summary does not count. */
export function memberEnded(app: App, v: Viewer, opts: { before?: string; q?: string; limit?: number } = {}): { items: EndedLine[]; more: boolean } {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const own = endedLines(app, v.userId, { ...opts, limit, spaces: [...v.own] });
  const owner = v.userId === OWNER ? { items: [], more: false } : endedLines(app, OWNER, { ...opts, limit, spaces: [...v.work] });
  const q = opts.q?.trim().toLowerCase();
  const rows = [...own.items, ...owner.items.flatMap((e) => {
    const item = getItem(app, e.id);
    if (!seesLine(v, item)) return [];
    if (!visibleTree(app, v, e.id).partial) return [e];
    // What the summary or the reason says is not theirs to read, nor to find by.
    if (q && !`${item.title}\n${item.detail}`.toLowerCase().includes(q)) return [];
    return [{ ...e, summary: null, reason: null }];
  })].sort((a, b) => (b.closedAt ?? "").localeCompare(a.closedAt ?? "") || b.id.localeCompare(a.id));
  return { items: rows.slice(0, limit), more: own.more || owner.more || rows.length > limit };
}

/** GET /api/work for someone other than the owner: the same shape as the owner's, kept to what they may read. */
export async function memberOverview(app: App, userId: string) {
  const v = viewerOf(app, userId);
  const ownTop = v.own.size ? listItems(app, { status: "active", userId, limit: 2000, spaceIds: [...v.own], topLevel: true }) : [];
  const ownerTop = v.work.size ? all<{ id: string }>(app.db, `select i.id from items i where coalesce(i.user_id,'owner')='owner' and i.parent_id is null and i.status='open'
      and i.space_id in (select value from json_each(?)) and ${IS_LINE} order by i.updated_at desc limit 200`, JSON.stringify([...v.work])).map((r) => getItem(app, r.id)) : [];
  const ownLineIds = new Set(all<{ id: string }>(app.db, `select i.id from items i where i.id in (select value from json_each(?)) and ${IS_LINE}`, JSON.stringify(ownTop.map((i) => i.id))).map((r) => r.id));
  const lite = (i: Item): ItemLite => ({ id: i.id, title: i.title, kind: i.kind, status: i.status, dueAt: i.dueAt, remindAt: i.remindAt, waitingOn: i.waitingOn, spaceId: i.spaceId, updatedAt: i.updatedAt });
  const lines = [...ownTop.filter((i) => ownLineIds.has(i.id)), ...ownerTop.filter((i) => seesLine(v, i))]
    .sort((a, b) => Number(b.kind === "line") - Number(a.kind === "line") || b.updatedAt.localeCompare(a.updatedAt))
    .map((i) => memberLineView(app, v, i));
  const loose = ownTop.filter((i) => !ownLineIds.has(i.id)).map(lite);
  const { pending, asks, gates, candidates, changes, drafts, roots } = await pendingView(app, userId);
  const ended = memberEnded(app, v, { limit: 20 });
  return {
    lines, loose, pending,
    waiting: { total: pending.length, asks, gates, candidates: candidates.map(lite), changes: changes.map((r) => changeLite(app, r, roots)), drafts },
    places: [], ended: ended.items, endedMore: ended.more,
    // The routine work on their own lines, and why it does not run (items/member-routine.ts).
    routine: lineRoutine(app, userId),
  };
}

/** GET /api/work/:id for someone other than the owner: one line or work item they may read, kept to what they may read. */
export async function memberDetail(app: App, id: string, userId: string) {
  const v = viewerOf(app, userId);
  const item = one(app.db, "select 1 from items where id = ?", id) ? getItem(app, id) : null;
  if (!item) throw new HttpError(404, "工作线不存在");
  const root = getItem(app, rootOf(app, id));
  if (!seesLine(v, root)) throw new HttpError(404, "工作线不存在");
  const tree = visibleTree(app, v, root.id);
  if (!tree.visible.has(id)) throw new HttpError(404, "工作线不存在");
  const can = { edit: itemAccess(app, userId, item, "write"), operate: itemAccess(app, userId, item, "operate") };
  const who = person(app, item.userId);
  // Their own line with nothing of anyone else under it: the owner's page as it is, for them.
  if (root.userId === userId && !tree.partial) {
    const { workDetail } = await import("./work-http.ts");
    return { ...(await workDetail(app, id, userId)), partial: false, mine: true, person: who, can };
  }
  // The part of the tree under this item, and whether any of it is hidden.
  const under = new Set<string>();
  const walk = (p: string) => { for (const r of tree.rows) if (r.parentId === p && !under.has(r.id)) { under.add(r.id); walk(r.id); } };
  walk(id);
  const partial = tree.partial && (id === root.id || [...under].some((x) => !tree.visible.has(x)));
  const ids = [id, ...[...under].filter((x) => tree.visible.has(x))];
  const closed = isClosed(item.status);
  const next = partial ? [] : nextFor(app, v, item);
  const reason = closed && !partial ? endReason(app, id) : null;
  const timeline = changesOf(app, v, ids, 200);
  const shown: Item = { ...item, watch: null, sourceRefs: [], now: partial ? null : item.now };
  let materials: Awaited<ReturnType<typeof materialViews>> = [];
  try { materials = await materialViews(app, id, userId); } catch { /* not an item they may read as one: no materials */ }
  const f = flowLite(app, id);
  return {
    item: shown, ancestors: ancestorIds(app, id).reverse().map((a) => ({ id: a, title: one<{ title: string }>(app.db, "select title from items where id = ?", a)?.title ?? a })),
    now: shown.now, next,
    refTargets: scrubTargets(app, v, textTargets(app, [item.detail, shown.now?.text, shown.now?.summary, reason, ...(shown.now?.weeks ?? []).map((w) => w.text),
      ...next.flatMap((n) => [n.text, n.why]), ...timeline.flatMap((c) => [c.summary, c.detail, c.risk, c.next])], item.userId)),
    phase: item.phase, phaseSince: item.phaseSince, watchUntil: item.watchUntil,
    summary: partial ? null : item.now?.summary ?? null,
    ended: closed ? { at: item.closedAt, status: item.status, reason } : null,
    openUnder: ids.filter((x) => x !== id).filter((x) => { const s = tree.rows.find((r) => r.id === x)?.status; return !!s && !isClosed(s) && s !== "candidate"; }).length,
    children: prune(childrenOf(app, id), tree.visible),
    timeline,
    yielded: { count: 0, recent: [] },
    chats: [],
    materials,
    listen: null,
    flow: f ? { ...f, waitingOn: f.stages.find((s) => s.id === f.current?.id)?.waitingOn ?? null } : null,
    partial, mine: item.userId === userId, person: who, can,
  };
}

/**
 * Whether the changes of an item are this person's to see on 按时间 (the same test as the line pages),
 * each line's tree read once.
 */
export function changeFilter(app: App, v: Viewer) {
  const roots = new Map<string, string>(), trees = new Map<string, Set<string> | null>();
  return (itemId: string) => {
    let root = roots.get(itemId);
    if (!root) { root = rootOf(app, itemId); roots.set(itemId, root); }
    if (!trees.has(root)) {
      const r = one(app.db, "select 1 from items where id = ?", root) ? getItem(app, root) : null;
      trees.set(root, r && seesLine(v, r) ? visibleTree(app, v, root).visible : null);
    }
    return !!trees.get(root)?.has(itemId);
  };
}
