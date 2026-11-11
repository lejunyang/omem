/**
 * Open questions of Wiki pages: what a writer or the checker was not sure of. They are kept here,
 * not in the page — readers see only what holds. docs/v2/wiki-verify.md §5.
 *
 * Status: `open` (nobody has looked yet) → an agent investigates (`wiki-resolve`, or a later writing
 * run of the page) → `resolved` (it found the answer and wrote it into the page) or `needs-owner` (only
 * the owner can say) → `asked` (put to the owner, a few at a time) → `answered` (a writer is putting the
 * answer into the page) → `resolved`. `dropped`: the owner said it does not matter.
 */
import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { json, newId, now } from "../core/util.ts";

export type QuestionStatus = "open" | "needs-owner" | "asked" | "answered" | "resolved" | "dropped";
export type WikiQuestion = {
  id: string;
  spaceId: string;
  page: string;
  question: string;
  why: string;
  refs: string[];
  source: "writer" | "checker" | "migration";
  status: QuestionStatus;
  /** 1 low – 3 high: what to put to the owner first. */
  importance: number;
  answer: string | null;
  note: string;
  askId: string | null;
  runId: string | null;
  createdAt: string;
  updatedAt: string;
};
export type QuestionInput = { question: string; why?: string; refs?: string[] };

/** Still waiting on someone (an agent or the owner). */
export const UNSETTLED: QuestionStatus[] = ["open", "needs-owner", "asked", "answered"];
/** Questions one investigation run takes on; questions put to the owner at the end of one generation. */
export const RESOLVE_LIMIT = 20;
export const ASK_LIMIT = 5;

type Row = { id: string; space_id: string; page: string; question: string; why: string; refs: string; source: string; status: string; importance: number; answer: string | null; note: string; ask_id: string | null; run_id: string | null; created_at: string; updated_at: string };
const toQuestion = (r: Row): WikiQuestion => ({
  id: r.id, spaceId: r.space_id, page: r.page, question: r.question, why: r.why, refs: json<string[]>(r.refs, []), source: r.source as WikiQuestion["source"],
  status: r.status as QuestionStatus, importance: r.importance, answer: r.answer, note: r.note, askId: r.ask_id, runId: r.run_id, createdAt: r.created_at, updatedAt: r.updated_at,
});

/** `src:…` references in a piece of text (a migrated item, a finding's basis). */
export const refsIn = (text: string) => [...new Set([...text.matchAll(/src:[^\s)\]，。、；]+/g)].map((m) => m[0]))];

/** Add questions to a page; one already there and unsettled (same text) is not added twice. Returns the ids. */
export function addQuestions(app: App, spaceId: string, page: string, items: QuestionInput[], opts: { source: WikiQuestion["source"]; runId?: string | null }) {
  const ids: string[] = [];
  const marks = UNSETTLED.map(() => "?").join(",");
  for (const it of items) {
    const question = it.question.trim();
    if (!question) continue;
    const have = one<{ id: string }>(app.db, `select id from wiki_questions where space_id = ? and page = ? and question = ? and status in (${marks})`, spaceId, page, question, ...UNSETTLED);
    if (have) {
      ids.push(have.id);
      continue;
    }
    const id = newId("wq");
    const at = now();
    run(app.db, "insert into wiki_questions(id,space_id,page,question,why,refs,source,status,importance,run_id,created_at,updated_at) values(?,?,?,?,?,?,?,'open',2,?,?,?)",
      id, spaceId, page, question.slice(0, 1000), (it.why ?? "").trim().slice(0, 1000), JSON.stringify([...new Set([...(it.refs ?? []), ...refsIn(question)])].slice(0, 20)), opts.source, opts.runId ?? null, at, at);
    ids.push(id);
  }
  if (ids.length) app.emit({ type: "changed", entity: "page", id: `${spaceId}/${page}`, spaceId });
  return ids;
}

export function getQuestion(app: App, id: string): WikiQuestion | null {
  const r = one<Row>(app.db, "select * from wiki_questions where id = ?", id);
  return r ? toQuestion(r) : null;
}

export function listQuestions(app: App, opts: { spaceId: string; page?: string; status?: QuestionStatus[]; ids?: string[]; limit?: number }): WikiQuestion[] {
  const where = ["space_id = ?"];
  const params: (string | number)[] = [opts.spaceId];
  if (opts.page) where.push("page = ?"), params.push(opts.page);
  const status = opts.status ?? UNSETTLED;
  where.push(`status in (${status.map(() => "?").join(",")})`), params.push(...status);
  if (opts.ids) {
    if (!opts.ids.length) return [];
    where.push(`id in (${opts.ids.map(() => "?").join(",")})`), params.push(...opts.ids);
  }
  return all<Row>(app.db, `select * from wiki_questions where ${where.join(" and ")} order by importance desc, created_at limit ?`, ...params, opts.limit ?? 500).map(toQuestion);
}

/** Unsettled questions per page of a space (what the web shows next to each page). */
export function questionCounts(app: App, spaceId: string): Record<string, number> {
  const marks = UNSETTLED.map(() => "?").join(",");
  return Object.fromEntries(all<{ page: string; n: number }>(app.db, `select page, count(*) n from wiki_questions where space_id = ? and status in (${marks}) group by page`, spaceId, ...UNSETTLED).map((r) => [r.page, r.n]));
}

export function updateQuestion(app: App, id: string, patch: { status?: QuestionStatus; importance?: number; answer?: string | null; note?: string; askId?: string | null }) {
  const q = getQuestion(app, id);
  if (!q) return null;
  run(app.db, "update wiki_questions set status = ?, importance = ?, answer = ?, note = ?, ask_id = ?, updated_at = ? where id = ?",
    patch.status ?? q.status, Math.min(3, Math.max(1, patch.importance ?? q.importance)), patch.answer === undefined ? q.answer : patch.answer, patch.note ?? q.note, patch.askId === undefined ? q.askId : patch.askId, now(), id);
  app.emit({ type: "changed", entity: "page", id: `${q.spaceId}/${q.page}`, spaceId: q.spaceId });
  return getQuestion(app, id);
}

/** For a writer's or checker's task: the page's unsettled questions, numbered by id. */
export function questionsText(qs: WikiQuestion[]) {
  return qs.map((q) => `- ${q.id}：${q.question}${q.why ? `（为什么拿不准：${q.why}）` : ""}${q.refs.length ? ` 相关：${q.refs.join(" ")}` : ""}${q.answer ? `\n  本人的回答：${q.answer}` : ""}`).join("\n");
}
