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
};
type Row = { id: string; space_id: string; front: string; back: string; source_refs: string; state: string; due_at: string; created_at: string; suspended: number };

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
  };
};

export function createCard(app: App, input: { spaceId: string; front: string; back: string; sourceRefs?: string[] }) {
  const front = input.front.trim();
  if (!front) throw new HttpError(400, "卡片正面不能为空");
  const dup = one<{ id: string }>(app.db, "select id from cards where space_id = ? and front = ?", input.spaceId, front);
  if (dup) return { card: getCard(app, dup.id), created: false };
  const id = newId("c");
  const card = createEmptyCard(new Date());
  run(
    app.db,
    "insert into cards(id,space_id,front,back,source_refs,state,due_at,created_at) values(?,?,?,?,?,?,?,?)",
    id,
    input.spaceId,
    front,
    input.back.trim(),
    JSON.stringify(input.sourceRefs ?? []),
    JSON.stringify(card),
    card.due.toISOString(),
    now(),
  );
  app.emit({ type: "changed", entity: "card", id, spaceId: input.spaceId });
  return { card: getCard(app, id), created: true };
}

export function getCard(app: App, id: string) {
  const r = one<Row>(app.db, "select * from cards where id = ?", id);
  if (!r) throw new HttpError(404, "卡片不存在");
  return toCard(r);
}

export function dueCards(app: App, spaceId?: string, limit = 50) {
  return all<Row>(
    app.db,
    `select * from cards where suspended = 0 and due_at <= ? ${spaceId ? "and space_id = ?" : ""} order by due_at limit ?`,
    now(),
    ...(spaceId ? [spaceId] : []),
    limit,
  ).map(toCard);
}

export function listCards(app: App, spaceId?: string) {
  return all<Row>(app.db, `select * from cards ${spaceId ? "where space_id = ?" : ""} order by created_at desc limit 1000`, ...(spaceId ? [spaceId] : [])).map(toCard);
}

/** rating: 1 again, 2 hard, 3 good, 4 easy */
export function reviewCard(app: App, id: string, rating: 1 | 2 | 3 | 4) {
  const r = one<Row>(app.db, "select * from cards where id = ?", id);
  if (!r) throw new HttpError(404, "卡片不存在");
  const stored = json<CardInput>(r.state, createEmptyCard() as unknown as CardInput);
  const at = new Date();
  const next = scheduler.next(stored, at, rating as Grade).card;
  run(app.db, "update cards set state = ?, due_at = ? where id = ?", JSON.stringify(next), next.due.toISOString(), id);
  run(app.db, "insert into card_reviews(card_id, at, rating) values(?,?,?)", id, at.toISOString(), rating);
  return getCard(app, id);
}

export function updateCard(app: App, id: string, patch: { front?: string; back?: string; suspended?: boolean }) {
  const c = getCard(app, id);
  run(app.db, "update cards set front=?, back=?, suspended=? where id=?", patch.front ?? c.front, patch.back ?? c.back, (patch.suspended ?? c.suspended) ? 1 : 0, id);
  return getCard(app, id);
}

export function studyStats(app: App, spaceId?: string) {
  const filter = spaceId ? "where space_id = ?" : "";
  const params = spaceId ? [spaceId] : [];
  const total = one<{ n: number }>(app.db, `select count(*) n from cards ${filter}`, ...params)?.n ?? 0;
  const due = one<{ n: number }>(app.db, `select count(*) n from cards ${filter ? filter + " and" : "where"} suspended = 0 and due_at <= ?`, ...params, now())?.n ?? 0;
  const today = one<{ n: number }>(app.db, "select count(*) n from card_reviews where at >= ?", new Date(new Date().setHours(0, 0, 0, 0)).toISOString())?.n ?? 0;
  return { total, due, reviewedToday: today };
}
