import { createEmptyCard, fsrs, type Card, type CardInput, type Grade } from "ts-fsrs";
import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { HttpError, json, newId, now } from "../core/util.ts";

/**
 * Spaced repetition with FSRS. A card is generated from material (by the tutor
 * role or by hand) and keeps its source references so a review can open the
 * original sentence or explanation.
 */
const scheduler = fsrs({ enable_fuzz: true });

export type StudyCard = {
  id: string;
  spaceId: string;
  front: string;
  back: string;
  sourceRefs: string[];
  dueAt: string;
  createdAt: string;
  suspended: boolean;
  reps: number;
  lapses: number;
  state: number;
  userId: string;
  goalId: string | null;
};
type Row = { id: string; space_id: string; front: string; back: string; source_refs: string; state: string; due_at: string; created_at: string; suspended: number; user_id: string; goal_id: string | null };

const toCard = (r: Row): StudyCard => {
  const s = json<Partial<Card>>(r.state, {});
  return {
    id: r.id,
    spaceId: r.space_id,
    front: r.front,
    back: r.back,
    sourceRefs: json(r.source_refs, []),
    dueAt: r.due_at,
    createdAt: r.created_at,
    suspended: !!r.suspended,
    reps: s.reps ?? 0,
    lapses: s.lapses ?? 0,
    state: (s.state as number) ?? 0,
    userId: r.user_id ?? "owner",
    goalId: r.goal_id ?? null,
  };
};

export function createCard(app: App, input: { spaceId: string; front: string; back: string; sourceRefs?: string[]; userId?: string; goalId?: string | null }) {
  const front = input.front.trim();
  if (!front) throw new HttpError(400, "卡片正面不能为空");
  const userId = input.userId ?? "owner";
  const dup = one<{ id: string }>(app.db, "select id from cards where space_id = ? and front = ? and user_id = ?", input.spaceId, front, userId);
  if (dup) return { card: getCard(app, dup.id), created: false };
  const id = newId("c");
  const card = createEmptyCard(new Date());
  run(
    app.db,
    "insert into cards(id,space_id,front,back,source_refs,state,due_at,created_at,user_id,goal_id) values(?,?,?,?,?,?,?,?,?,?)",
    id,
    input.spaceId,
    front,
    input.back.trim(),
    JSON.stringify(input.sourceRefs ?? []),
    JSON.stringify(card),
    card.due.toISOString(),
    now(),
    userId,
    input.goalId ?? null,
  );
  app.emit({ type: "changed", entity: "card", id, spaceId: input.spaceId });
  return { card: getCard(app, id), created: true };
}

export function getCard(app: App, id: string) {
  const r = one<Row>(app.db, "select * from cards where id = ?", id);
  if (!r) throw new HttpError(404, "卡片不存在");
  return toCard(r);
}

export type CardFilter = { spaceId?: string; userId?: string; goalId?: string };
function where(f: CardFilter, extra: string[] = []) {
  const w = [...extra];
  const p: string[] = [];
  if (f.spaceId) w.push("space_id = ?"), p.push(f.spaceId);
  if (f.goalId) w.push("goal_id = ?"), p.push(f.goalId);
  w.push("user_id = ?"), p.push(f.userId ?? "owner");
  return { sql: `where ${w.join(" and ")}`, params: p };
}
const filterOf = (f?: string | CardFilter): CardFilter => (typeof f === "string" ? { spaceId: f } : (f ?? {}));

export function dueCards(app: App, filter?: string | CardFilter, limit = 50) {
  const w = where(filterOf(filter), ["suspended = 0", "due_at <= ?"]);
  return all<Row>(app.db, `select * from cards ${w.sql} order by due_at limit ?`, now(), ...w.params, limit).map(toCard);
}

export function listCards(app: App, filter?: string | CardFilter) {
  const w = where(filterOf(filter));
  return all<Row>(app.db, `select * from cards ${w.sql} order by created_at desc limit 1000`, ...w.params).map(toCard);
}

/** rating: 1 again, 2 hard, 3 good, 4 easy */
export function reviewCard(app: App, id: string, rating: 1 | 2 | 3 | 4) {
  const r = one<Row>(app.db, "select * from cards where id = ?", id);
  if (!r) throw new HttpError(404, "卡片不存在");
  const stored = json<CardInput>(r.state, createEmptyCard() as unknown as CardInput);
  const at = new Date();
  const next = scheduler.next(stored, at, rating as Grade).card;
  run(app.db, "update cards set state = ?, due_at = ? where id = ?", JSON.stringify(next), next.due.toISOString(), id);
  run(app.db, "insert into card_reviews(card_id, at, rating, user_id) values(?,?,?,?)", id, at.toISOString(), rating, r.user_id ?? "owner");
  return getCard(app, id);
}

export function updateCard(app: App, id: string, patch: { front?: string; back?: string; suspended?: boolean }) {
  const c = getCard(app, id);
  run(app.db, "update cards set front=?, back=?, suspended=? where id=?", patch.front ?? c.front, patch.back ?? c.back, (patch.suspended ?? c.suspended) ? 1 : 0, id);
  return getCard(app, id);
}

function startOfToday() {
  return new Date(new Date().setHours(0, 0, 0, 0)).toISOString();
}

export function studyStats(app: App, filter?: string | CardFilter) {
  const f = filterOf(filter);
  const all_ = where(f);
  const due = where(f, ["suspended = 0", "due_at <= ?"]);
  const total = one<{ n: number }>(app.db, `select count(*) n from cards ${all_.sql}`, ...all_.params)?.n ?? 0;
  const dueN = one<{ n: number }>(app.db, `select count(*) n from cards ${due.sql}`, now(), ...due.params)?.n ?? 0;
  const today = one<{ n: number }>(app.db, `select count(*) n from card_reviews r join cards c on c.id = r.card_id ${where(f).sql.replace(/\b(space_id|goal_id|user_id)\b/g, "c.$1")} and r.at >= ?`, ...where(f).params, startOfToday())?.n ?? 0;
  return { total, due: dueN, reviewedToday: today };
}

/**
 * How learning is going: recall rate (share of reviews rated good/easy), cards
 * that keep being forgotten, consecutive study days.
 */
export function learningProgress(app: App, filter: CardFilter = {}, days = 30) {
  const f = where(filter);
  const cw = f.sql.replace(/\b(space_id|goal_id|user_id)\b/g, "c.$1");
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const reviews = all<{ at: string; rating: number }>(app.db, `select r.at, r.rating from card_reviews r join cards c on c.id = r.card_id ${cw} and r.at >= ? order by r.at`, ...f.params, since);
  const recall = reviews.length ? reviews.filter((r) => r.rating >= 3).length / reviews.length : null;
  const dayset = new Set(reviews.map((r) => new Date(r.at).toDateString()));
  let streak = 0;
  for (let d = new Date(); dayset.has(d.toDateString()); d = new Date(d.getTime() - 86400_000)) streak++;
  const cards = all<Row>(app.db, `select * from cards ${f.sql}`, ...f.params).map(toCard);
  const weak = cards.filter((c) => c.lapses >= 2).sort((a, b) => b.lapses - a.lapses).slice(0, 15);
  const mature = cards.filter((c) => c.state === 2 && c.reps >= 4).length;
  return { reviews: reviews.length, recall, streak, cards: cards.length, mature, weak: weak.map((c) => ({ id: c.id, front: c.front, lapses: c.lapses })) };
}
