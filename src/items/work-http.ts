import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { audit, can } from "../auth/permissions.ts";
import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { accessibleSpaces, findUser, OWNER } from "../core/users.ts";
import { HttpError, json, newId, now, zonedParts, zoneMidnight } from "../core/util.ts";
import { requireItem, writableParents } from "./access.ts";
import { changeFilter, memberDetail, memberEnded, memberOverview, viewerOf } from "./member-work.ts";
import { lineRoutine, ownAccountProblem, setLineRoutine } from "./member-routine.ts";
import { buildToday } from "./today.ts";
// Its answer handler (member-progress) must be in place before any answer comes in.
import "./member-progress.ts";
import { pendingActions, pendingView } from "./pending.ts";
import { chatName } from "../agents/owner-now.ts";
import { itemContext, listContexts } from "../channels/listen.ts";
import { CHANGE_COLS, CHANGE_TYPES, changeLite, lineTimeline, refTargets, textTargets, type ChangeLite } from "./changes.ts";
import { yieldsOf } from "../core/handling.ts";
import { endedLines, endReason, guardsOf, setLinePhase } from "./lifecycle.ts";
import { decideNext, NEXT_KINDS, nextOf, type NextKind, type NextLite } from "./lines.ts";
import { materialViews } from "./materials.ts";
import { setParent } from "./parent.ts";
import { externalView, providerState } from "./providers.ts";
import { addItemEvent, getItem, isClosed, listItems, type Item, type LineNow } from "./store.ts";
import { ancestorIds, descendantIds, openUnder, rootOf } from "./tree.ts";

/**
 * The work page (docs/v2/status.md “工作线”): every line with where it stands, its last key changes ending in its
 * next steps, its work items with their flow stages, and everything waiting for the owner in one place;
 * a line's or work item's own page with its timeline, people, chats and materials. Owner-only routes
 * (auth/routes.ts); everything is the caller's own items in the spaces they may read.
 */
export type ItemLite = { id: string; title: string; kind: string; status: string; dueAt: string | null; remindAt: string | null; waitingOn: string | null; spaceId: string; updatedAt: string };
export type StageLite = { id: string; name: string; state: string; enteredAt: string | null; doneAt: string | null; waitingOn: string | null };
export type FlowLite = { name: string; stages: StageLite[]; current: { id: string; name: string; state: string } | null };
export type Child = { id: string; title: string; kind: string; status: string; dueAt: string | null; parentId: string | null; waitingOn: string | null; flow: FlowLite | null; children?: Child[] };
export type Line = {
  id: string; title: string; kind: string; status: string; dueAt: string | null; spaceId: string; now: LineNow | null;
  counts: { changes: number; today: number; lastAt: string | null }; timeline: ChangeLite[]; next: NextLite[]; children: Child[];
  listen: { id: string; assist: string } | null;
  /** Its phase (items/lifecycle.ts): null 进行中, `watching` 观察中 until `watchUntil`. */
  phase: "watching" | null; phaseSince: string | null; watchUntil: string | null;
  /** While watching, what still holds it: metrics past their mark this week, problems not closed, items not closed. */
  watch?: { flaggedMetrics: number; openProblems: number; openItems: number };
};
export type GateLite = { itemId: string; title: string; flowName: string; stage: { id: string; name: string; state: string }; since: string; askId: string | null };
export type ChatActivity = { chatId: string; name: string; total: number; perDay: number[]; lastAt: string | null };

const lite = (i: Item): ItemLite => ({ id: i.id, title: i.title, kind: i.kind, status: i.status, dueAt: i.dueAt, remindAt: i.remindAt, waitingOn: i.waitingOn, spaceId: i.spaceId, updatedAt: i.updatedAt });
const OPEN = "status not in ('done','cancelled','expired','candidate')";

/** A work item's flow: every stage with its state and dates, and the one it is at (waiting on the owner first, then under way, then next). */
export function flowLite(app: App, itemId: string): FlowLite | null {
  const f = one<{ definition: string; ended_at: string | null }>(app.db, "select definition, ended_at from item_flows where item_id = ?", itemId);
  if (!f) return null;
  const def = json<{ name?: string; stages?: { id: string; name: string }[] }>(f.definition, {});
  const rows = new Map(all<{ stage_id: string; state: string; entered_at: string | null; done_at: string | null; waiting_on: string | null; by: string | null }>(app.db, `select stage_id, state, entered_at, done_at, waiting_on, "by" from item_stages where item_id = ?`, itemId).map((r) => [r.stage_id, r]));
  const stages = (def.stages ?? []).map((s) => {
    const r = rows.get(s.id);
    return { id: s.id, name: s.name, state: r?.state ?? "pending", enteredAt: r?.entered_at ?? null, doneAt: r?.done_at ?? null, waitingOn: r?.waiting_on ?? null, by: r?.by ?? null };
  });
  const pick = f.ended_at ? undefined
    : stages.find((s) => s.state === "gated" || s.state === "blocked" || s.waitingOn === "owner" || (s.state === "doing" && s.by === "owner"))
      ?? stages.find((s) => s.state === "doing") ?? stages.find((s) => s.state === "pending" || s.state === "stale");
  return { name: def.name ?? "", stages: stages.map(({ by: _by, ...s }) => s), current: pick ? { id: pick.id, name: pick.name, state: pick.state } : null };
}

/** The items under one, level by level (candidates left out), open ones first. */
export function childrenOf(app: App, id: string, depth = 0): Child[] {
  if (depth > 3) return [];
  const rows = all<{ id: string; title: string; kind: string; status: string; due_at: string | null; parent_id: string | null; waiting_on: string | null }>(app.db,
    `select id, title, kind, status, due_at, parent_id, waiting_on from items where parent_id = ? and status != 'candidate'
      order by case when status in ('done','cancelled','expired') then 1 else 0 end, created_at, id`, id);
  return rows.map((r) => {
    const kids = childrenOf(app, r.id, depth + 1);
    return { id: r.id, title: r.title, kind: r.kind, status: r.status, dueAt: r.due_at, parentId: r.parent_id, waitingOn: r.waiting_on, flow: flowLite(app, r.id), ...(kids.length ? { children: kids } : {}) };
  });
}

/** The next steps of an item as the work pages show them: with what their references name (an item, a run). */
function nextView(app: App, itemId: string, userId: string): NextLite[] {
  return nextOf(app, itemId, ["open", "doing"]).map((n) => {
    const targets = refTargets(app, n.refs, userId);
    return targets ? { ...n, refTargets: targets } : n;
  });
}

/** Midnight of today where the owner is, as an ISO time. */
const todayStart = (app: App) => zoneMidnight(zonedParts(new Date(), app.config.timezone).date, app.config.timezone).toISOString();

function lineView(app: App, item: Item): Line {
  const ids = [item.id, ...descendantIds(app, item.id)];
  const marks = ids.map(() => "?").join(",");
  const counts = one<{ n: number; today: number; last: string | null }>(app.db, `select count(*) n, coalesce(sum(at >= ?), 0) today, max(at) last from item_changes where item_id in (${marks}) and noise = 0`, todayStart(app), ...ids)!;
  const c = itemContext(app, item.id);
  const g = item.phase === "watching" ? guardsOf(app, item) : null;
  return {
    id: item.id, title: item.title, kind: item.kind, status: item.status, dueAt: item.dueAt, spaceId: item.spaceId, now: item.now,
    counts: { changes: counts.n, today: counts.today, lastAt: counts.last },
    timeline: lineTimeline(app, item.id, { limit: 6 }).reverse(),
    next: nextView(app, item.id, item.userId),
    children: childrenOf(app, item.id),
    listen: c && c.status === "active" ? { id: c.id, assist: c.knobs.assist ?? "off" } : null,
    phase: item.phase, phaseSince: item.phaseSince, watchUntil: item.watchUntil,
    ...(g ? { watch: { flaggedMetrics: g.flaggedMetrics, openProblems: g.openProblems, openItems: g.openItems } } : {}),
  };
}

/** The caller's open items in spaces they may read. */
function myItems(app: App, userId: string, opts: { status?: string } = {}) {
  const allowed = accessibleSpaces(app, userId);
  return listItems(app, { status: opts.status ?? "active", userId, limit: 2000, ...(allowed ? { spaceIds: allowed } : {}) });
}

export async function workOverview(app: App, userId: string) {
  const items = myItems(app, userId);
  const top = items.filter((i) => !i.parentId);
  const withChildren = new Set(all<{ parent_id: string }>(app.db, `select distinct parent_id from items where parent_id is not null and ${OPEN}`).map((r) => r.parent_id));
  const flowing = new Set(all<{ item_id: string }>(app.db, "select item_id from item_flows where ended_at is null").map((r) => r.item_id));
  const listened = new Set(listContexts(app, { kind: "item", activeOnly: true }).map((c) => c.itemId).filter((x): x is string => !!x));
  const isLine = (i: Item) => i.kind === "line" || i.phase === "watching" || withChildren.has(i.id) || flowing.has(i.id) || listened.has(i.id);
  const lines = top.filter(isLine).sort((a, b) => Number(b.kind === "line") - Number(a.kind === "line") || b.updatedAt.localeCompare(a.updatedAt)).map((i) => lineView(app, i));
  const loose = top.filter((i) => !isLine(i)).map(lite);

  const allowed = accessibleSpaces(app, userId);
  const { pending, asks, gates, candidates, changes, drafts, roots } = await pendingView(app, userId);
  const changeViews = changes.map(r => changeLite(app, r, roots));
  const places = listContexts(app, { kind: "place", activeOnly: true }).map((c) => ({
    id: c.id, name: c.name, openProblems: one<{ n: number }>(app.db, "select count(*) n from listen_problems where context_id = ? and state != 'closed'", c.id)?.n ?? 0,
  }));
  // Lines that ended lately (items/lifecycle.ts); older ones page through /api/work/ended.
  const ended = endedLines(app, userId, { limit: 20, spaces: allowed });
  return { lines, loose, pending, waiting: { total: pending.length, asks, gates, candidates: candidates.map(lite), changes: changeViews, drafts }, places, ended: ended.items, endedMore: ended.more };
}

/** Changes of the caller's items by day, filtered by type, origin and line; the days of the range with their counts. */
export function workActivities(app: App, userId: string, q: { from?: string; to?: string; type?: string; origin?: string; line?: string; noise?: boolean }) {
  const tz = app.config.timezone;
  const today = zonedParts(new Date(), tz).date;
  const to = q.to ?? today;
  const from = q.from ?? new Date(Date.parse(`${to}T00:00:00Z`) - 29 * 86400_000).toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) throw new HttpError(400, "from / to 用 YYYY-MM-DD，from 不晚于 to");
  const start = zoneMidnight(from, tz).toISOString();
  const end = zoneMidnight(new Date(Date.parse(`${to}T00:00:00Z`) + 86400_000).toISOString().slice(0, 10), tz).toISOString();
  const types = q.type ? q.type.split(",").filter((t) => (CHANGE_TYPES as readonly string[]).includes(t)) : [];
  const origins = q.origin ? q.origin.split(",").filter(Boolean) : [];
  const member = userId !== OWNER;
  // Someone else: the owner's lines in their 看工作线 spaces and their own, item by item (items/member-work.ts).
  const viewer = member ? viewerOf(app, userId) : null;
  const sees = viewer ? changeFilter(app, viewer) : null;
  const allowed = viewer ? [...new Set([...viewer.work, ...viewer.own])] : null;
  const ids = q.line ? [q.line, ...descendantIds(app, q.line, allowed ?? undefined)] : null;
  if (q.line && (sees ? !sees(q.line) : getItem(app, q.line).userId !== OWNER)) throw new HttpError(403, "不能查看他人的工作线");
  const rows = all<Parameters<typeof changeLite>[1] & { space_id: string }>(app.db,
    `select ${CHANGE_COLS}, i.space_id from item_changes c join items i on i.id = c.item_id
      where coalesce(i.user_id,'owner') in (?, ?) and c.at >= ? and c.at < ?
        ${allowed ? "and i.space_id in (select value from json_each(?)) and i.status not in ('candidate','waiting','snoozed') and c.status in ('noted','confirmed')" : ""}
        ${types.length ? `and c.type in (${types.map(() => "?").join(",")})` : ""}
        ${origins.length ? `and c.origin in (${origins.map(() => "?").join(",")})` : ""}
        ${ids ? `and c.item_id in (${ids.map(() => "?").join(",")})` : ""}
        ${q.noise ? "" : "and c.noise = 0"}
      order by c.at desc, c.id desc limit 2000`, OWNER, member ? userId : OWNER, start, end, ...(allowed ? [JSON.stringify(allowed)] : []), ...types, ...origins, ...(ids ?? []))
    .filter((r) => !sees || sees(r.item_id));
  const byDay = new Map<string, number>();
  for (const r of rows) { const d = zonedParts(r.at, tz).date; byDay.set(d, (byDay.get(d) ?? 0) + 1); }
  // Every row counts in its day; only the ones shown are looked up further (their line, what their references name).
  const lines = new Map<string, { id: string; title: string }>();
  const items = rows.slice(0, 300).map(r => viewer ? { id: r.id, at: r.at, type: r.type, summary: r.summary, itemId: r.item_id, itemTitle: r.title } : changeLite(app, r, lines));
  const days: { date: string; count: number }[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`) && days.length < 400; t += 86400_000) {
    const d = new Date(t).toISOString().slice(0, 10);
    days.push({ date: d, count: byDay.get(d) ?? 0 });
  }
  return { days, items };
}

/** Message counts of the line's groups: all of them, and day by day over the last 14 days where the owner is, by the (chat_id, create_ms) index. */
export function chatActivity(app: App, chats: string[]): ChatActivity[] {
  const tz = app.config.timezone;
  const today = zonedParts(new Date(), tz).date;
  const first = zoneMidnight(new Date(Date.parse(`${today}T00:00:00Z`) - 13 * 86400_000).toISOString().slice(0, 10), tz).getTime();
  return chats.map((chatId) => {
    const sum = one<{ n: number; last: number | null }>(app.db, "select count(*) n, max(create_ms) last from lark_messages where chat_id = ?", chatId)!;
    const perDay = Array.from({ length: 14 }, () => 0);
    for (const r of all<{ d: number; n: number }>(app.db, "select cast((create_ms - ?) / 86400000 as integer) d, count(*) n from lark_messages where chat_id = ? and create_ms >= ? group by d", first, chatId, first))
      if (r.d >= 0 && r.d < 14) perDay[r.d] += r.n;
    return { chatId, name: chatName(app, chatId), total: sum.n, perDay, lastAt: sum.last ? new Date(sum.last).toISOString() : null };
  }).sort((a, b) => (b.lastAt ?? "").localeCompare(a.lastAt ?? ""));
}

export async function workDetail(app: App, id: string, userId: string) {
  const item = getItem(app, id);
  if (item.userId !== userId) throw new HttpError(403, "不能查看他人的事项");
  const allowed = accessibleSpaces(app, userId);
  if (allowed && !allowed.includes(item.spaceId)) throw new HttpError(403, `不能访问空间 ${item.spaceId}`);
  const ancestors = ancestorIds(app, id).reverse().map((a) => ({ id: a, title: one<{ title: string }>(app.db, "select title from items where id = ?", a)?.title ?? a }));
  const root = rootOf(app, id);
  const { contextChats } = await import("../channels/listen-items.ts");
  const c = itemContext(app, root);
  // The groups its 关注 reads (the items' chats, with the owner's additions and removals on the line page).
  let chats: string[] = [];
  try { chats = contextChats(app, root, c); } catch { /* the line is gone */ }
  const f = flowLite(app, id);
  const closed = isClosed(item.status);
  // The platform entry it was brought in from (items/providers.ts), for its subscriber only.
  let external: ReturnType<typeof externalView> | null = null;
  try { const synced = providerState(app, userId, id); external = synced && externalView(synced); } catch { /* the subscription is gone, or is someone else's */ }
  const next = nextView(app, id, userId), reason = closed ? endReason(app, id) : null;
  // Each change says who noted it and who added to it (items/changes.ts); the paths that stepped aside on
  // the messages behind them, and why (core/handling.ts), on the change and counted for the line.
  const timeline: (ChangeLite & { yields?: { label: string; to: string; reason: string; at: string }[] })[] = lineTimeline(app, id, { limit: 200 });
  const yields = yieldsOf(app, timeline.flatMap((c) => c.sourceKey?.startsWith("lark:") ? [c.sourceKey.replace(/~\d+$/, "")] : []), 60);
  for (const c of timeline) {
    const mine = yields.filter((y) => `lark:${y.event}` === c.sourceKey?.replace(/~\d+$/, "")).map(({ event: _e, actor: _a, ...y }) => y);
    if (mine.length) c.yields = mine;
  }
  return {
    item, ...(external ? { external } : {}), ancestors, now: item.now, next,
    // Items and runs named by id inside the page's own text (the goal, the state, reasons), with their titles.
    refTargets: textTargets(app, [
      item.detail, item.now?.text, item.now?.summary, reason, ...(item.now?.weeks ?? []).map((w) => w.text),
      ...next.flatMap((n) => [n.text, n.why]), ...timeline.flatMap((c) => [c.summary, c.detail, c.risk, c.next]),
    ], userId),
    // Its life (items/lifecycle.ts): the phase, when it ended and why, its closing summary, how many under it are open.
    phase: item.phase, phaseSince: item.phaseSince, watchUntil: item.watchUntil,
    summary: item.now?.summary ?? null,
    ended: closed ? { at: item.closedAt, status: item.status, reason } : null,
    openUnder: openUnder(app, id),
    children: childrenOf(app, id),
    timeline,
    yielded: { count: yields.length, recent: yields.slice(0, 10).map(({ event: _e, actor: _a, ...y }) => y) },
    chats: chatActivity(app, chats),
    materials: await materialViews(app, id, userId),
    listen: c ? { id: c.id, status: c.status } : null,
    flow: f ? { ...f, waitingOn: f.stages.find((s) => s.id === f.current?.id)?.waitingOn ?? null } : null,
  };
}

function body<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const r = schema.safeParse(input ?? {});
  if (!r.success) throw new HttpError(400, `参数不对：${r.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("；")}`);
  return r.data;
}


/** A next step the person writes on their own line (or work item) by hand: no run, no card. */
export function addNext(app: App, itemId: string, userId: string, n: { text: string; why?: string; kind?: NextKind }) {
  const item = requireItem(app, itemId, userId, "write");
  if (item.userId !== userId) throw new HttpError(403, "只能给自己的事项写下一步");
  if (isClosed(item.status)) throw new HttpError(409, "这件事已经结束了");
  const id = newId("nx"), at = now();
  run(app.db, "insert into item_next(id,item_id,text,why,refs,kind,status,run_id,created_at,updated_at) values(?,?,?,?,'[]',?,'open',null,?,?)", id, item.id, n.text.trim(), n.why?.trim() ?? "", n.kind ?? "read", at, at);
  addItemEvent(app, item.id, "note", `写了下一步：${n.text.trim()}`, "user");
  app.emit({ type: "changed", entity: "item", id: item.id, spaceId: item.spaceId });
  return nextOf(app, item.id).find((x) => x.id === id)!;
}

export function registerWorkRoutes(server: FastifyInstance, app: App, who: (req: FastifyRequest) => string) {
  server.get("/api/pending", async (req) => pendingActions(app, who(req)));
  // Someone other than the owner: the lines they may read and their own (items/member-work.ts).
  server.get("/api/work", async (req) => (who(req) === OWNER ? workOverview(app, OWNER) : memberOverview(app, who(req))));
  server.get("/api/work/activities", async (req) => {
    const q = body(z.object({ from: z.string().optional(), to: z.string().optional(), type: z.string().optional(), origin: z.string().optional(), line: z.string().optional(), noise: z.coerce.boolean().optional() }), req.query);
    return workActivities(app, who(req), q);
  });
  server.get("/api/work/ended", async (req) => {
    const q = body(z.object({ before: z.string().max(40).optional(), q: z.string().max(100).optional(), limit: z.coerce.number().int().min(1).max(100).optional() }), req.query);
    return who(req) === OWNER ? endedLines(app, OWNER, q) : memberEnded(app, viewerOf(app, who(req)), q);
  });
  // “今天” as it reads for this person now (items/today.ts), without the choices: those are on the work page.
  server.get("/api/work/today", async (req) => {
    const built = await buildToday(app, new Date(), who(req));
    return { text: built ? built.question.replace(/\n\n下面能选的选了再提交[^\n]*$/, "") : null };
  });
  // The routine work on one's own lines (items/member-routine.ts): theirs to turn on, or the owner's for them.
  server.get("/api/work/routine", async (req) => {
    const q = body(z.object({ user: z.string().max(100).optional() }), req.query);
    const target = q.user ?? who(req);
    if (target !== who(req) && who(req) !== OWNER && !can(app, who(req), "settings.members")) throw new HttpError(403, "只能看自己的");
    return lineRoutine(app, target);
  });
  server.put("/api/work/routine", async (req) => {
    const b = body(z.object({ on: z.boolean(), user: z.string().max(100).optional() }), req.body);
    const target = b.user ?? who(req);
    if (target !== who(req) && who(req) !== OWNER && !can(app, who(req), "settings.members")) throw new HttpError(403, "只能改自己的");
    if (!findUser(app, target)) throw new HttpError(404, "没有这个人");
    const r = setLineRoutine(app, target, b.on);
    audit(app, who(req), b.on ? "line-routine.on" : "line-routine.off", target);
    return r;
  });
  server.get("/api/work/:id", async (req) => {
    const id = (req.params as { id: string }).id;
    if (who(req) !== OWNER) return memberDetail(app, id, who(req));
    return { ...(await workDetail(app, id, OWNER)), can: { edit: true, operate: true } };
  });
  // 进行中 / 观察中 / 结束 / 放弃 from the line's page (items/lifecycle.ts); ending with items open under it needs closeChildren.
  server.put("/api/work/:id/phase", async (req) => {
    const id = (req.params as { id: string }).id;
    const b = body(z.object({ phase: z.enum(["active", "watching", "done", "cancelled"]), closeChildren: z.boolean().optional(), days: z.number().int().min(1).max(60).optional(), reason: z.string().max(300).optional() }), req.body);
    const before = requireItem(app, id, who(req), "operate");
    const allowed = accessibleSpaces(app, who(req));
    if (allowed && !allowed.includes(before.spaceId)) throw new HttpError(403, `不能访问空间 ${before.spaceId}`);
    const it = setLinePhase(app, id, who(req), b);
    return { id: it.id, status: it.status, phase: it.phase, phaseSince: it.phaseSince, watchUntil: it.watchUntil, closedAt: it.closedAt };
  });
  server.post("/api/work/:id/refresh", async (req) => {
    const id = (req.params as { id: string }).id;
    requireItem(app, id, who(req), "operate");
    const { refreshLine } = await import("../channels/listen-assist.ts");
    const r = await refreshLine(app, id, who(req));
    return { runId: r.id, status: r.status };
  });
  server.post("/api/work/:id/next", async (req) => {
    const b = body(z.object({ text: z.string().trim().min(1).max(300), why: z.string().max(500).optional(), kind: z.enum(NEXT_KINDS).optional() }), req.body);
    return addNext(app, (req.params as { id: string }).id, who(req), b);
  });
  server.put("/api/items/:id/parent", async (req) => {
    const id = (req.params as { id: string }).id;
    const b = body(z.object({ parent: z.string().nullable() }), req.body);
    const item = requireItem(app, id, who(req), "write");
    if (item.userId !== who(req)) throw new HttpError(403, "不能修改他人的事项");
    writableParents(app, who(req), item.parentId, b.parent);
    return setParent(app, id, b.parent, "user");
  });
  server.put("/api/item-next/:id", async (req) => {
    const b = body(z.object({ status: z.enum(["doing", "declined", "done"]) }), req.body);
    const id = (req.params as { id: string }).id;
    const n = one<{ item_id: string }>(app.db, "select item_id from item_next where id = ?", id);
    if (!n) throw new HttpError(404, `没有这条下一步：${id}`);
    const line = requireItem(app, n.item_id, who(req), "operate");
    // A member's “就这么做” runs on their own AI account (items/member-routine.ts).
    if (b.status === "doing" && line.userId !== OWNER) {
      const problem = ownAccountProblem(app, line.userId);
      if (problem) throw new HttpError(409, problem);
    }
    return decideNext(app, id, b.status, who(req));
  });
  // “对我没用”: the change stays, the timeline leaves it out (and follow learns from it).
  server.put("/api/item-changes/:id/noise", async (req) => {
    const id = (req.params as { id: string }).id;
    const b = body(z.object({ noise: z.boolean() }), req.body);
    const c = one<{ item_id: string }>(app.db, "select item_id from item_changes where id = ?", id);
    if (!c) throw new HttpError(404, "没有这条变化");
    const item = requireItem(app, c.item_id, who(req), "operate");
    if (item.userId !== who(req)) throw new HttpError(403, "不能修改他人的事项");
    run(app.db, "update item_changes set noise = ?, updated_at = ? where id = ?", b.noise ? 1 : 0, now(), id);
    app.emit({ type: "changed", entity: "item", id: item.id, spaceId: item.spaceId });
    return { id, noise: b.noise };
  });
}
