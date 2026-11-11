/**
 * One-time move of the "还没查清" sections the old page template asked for: out of the page body, into
 * the page's open questions (questions.ts). The rest of the page is left exactly as it is: its other
 * citations keep their recorded state, the old version stays in the library's Git history.
 *
 * The section is found by its heading alone (HEADING): from that heading to the next heading of the
 * same or a higher level, or the end of the page. Each list item (or paragraph) becomes one question,
 * with the `src:` references it had. A page without such a heading is not touched. Running it again
 * finds nothing left to move, so a run cut short simply goes on: progress is counted in kv.
 * docs/v2/wiki-verify.md §6.
 */
import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { commitLibrary } from "../core/git.ts";
import { json, now } from "../core/util.ts";
import { createRun, registerHandler } from "../agents/runs.ts";
import { addQuestions, refsIn } from "./questions.ts";
import { pageExists, readPage, rewritePageBody } from "./store.ts";

/** The headings the old template and writers following it used for what they had not settled. */
export const HEADING = /^(#{2,4})\s*(还没查清|尚未查清|未查清|没查清|还没确认|待确认|需确认|待核实|待查清|待查|待补充|未决问题|存疑)\s*[：:]?\s*$/;
/** Pages one migration run goes through before it queues the next one. */
export const MIGRATE_BATCH = 200;
const KEY = "wiki-migrate-unresolved";

export type MigrateState = { pages: number; questions: number; looked: number; done: boolean; startedAt: string; updatedAt: string; last?: string };
export const migrateState = (app: App) => json<MigrateState | null>(one<{ value: string }>(app.db, "select value from kv where key = ?", KEY)?.value, null);
function saveState(app: App, s: MigrateState) {
  run(app.db, "insert into kv(key,value) values(?,?) on conflict(key) do update set value = excluded.value", KEY, JSON.stringify({ ...s, updatedAt: now() }));
}

/** The section and what stays: `body` without it, and its items (one question each). Null when the page has none. */
export function splitUnresolved(body: string): { body: string; heading: string; items: string[] } | null {
  const lines = body.split("\n");
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) fence = !fence;
    const m = fence ? null : HEADING.exec(lines[i].trim());
    if (!m) continue;
    const level = m[1].length;
    let end = i + 1;
    let inner = false;
    for (; end < lines.length; end++) {
      if (/^\s*```/.test(lines[end])) inner = !inner;
      const h = inner ? null : /^(#{1,6})\s/.exec(lines[end]);
      if (h && h[1].length <= level) break;
    }
    const section = lines.slice(i + 1, end);
    const items: string[] = [];
    let cur: string[] = [];
    const flush = () => {
      const t = cur.join(" ").replace(/\s+/g, " ").trim();
      if (t) items.push(t);
      cur = [];
    };
    for (const l of section) {
      const item = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(l);
      if (item && !/^\s{2,}/.test(l.replace(/^\t/, "  "))) {
        flush();
        cur.push(item[1]);
      } else if (!l.trim()) flush();
      else cur.push(l.trim());
    }
    flush();
    const rest = [...lines.slice(0, i), ...lines.slice(end)].join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
    return { body: rest, heading: m[2], items };
  }
  return null;
}

/** Move one page's section; null when it has none. */
export function migratePage(app: App, spaceId: string, slug: string, opts: { commit?: boolean } = {}) {
  if (!pageExists(app, spaceId, slug)) return null;
  const page = readPage(app, spaceId, slug);
  const split = splitUnresolved(page.body);
  if (!split) return null;
  // Questions first: if the run stops before the page is rewritten, the next run adds none twice (same text).
  const ids = addQuestions(app, spaceId, slug, split.items.map((t) => ({ question: t, why: `旧页面“${split.heading}”一节的条目，迁移时移出正文`, refs: refsIn(t) })), { source: "migration" });
  rewritePageBody(app, spaceId, slug, split.body, { message: `omem: move “${split.heading}” of ${spaceId}/${slug} to open questions`, commit: opts.commit });
  return { questions: ids.length };
}

/** Go through up to `limit` pages (all spaces, path order, after `after`); returns where it stopped. */
export function migrateUnresolved(app: App, opts: { limit?: number; after?: string } = {}) {
  const state: MigrateState = migrateState(app) ?? { pages: 0, questions: 0, looked: 0, done: false, startedAt: now(), updatedAt: now() };
  const limit = opts.limit ?? MIGRATE_BATCH;
  const after = opts.after ?? state.last ?? "";
  const rows = all<{ id: string; space_id: string; slug: string; body: string }>(app.db, "select id, space_id, slug, body from pages where id > ? order by id limit ?", after, limit);
  let moved = 0;
  for (const r of rows) {
    state.looked++;
    state.last = r.id;
    // Cheap test first: most pages have no such heading.
    if (!r.body.split("\n").some((l) => HEADING.test(l.trim()))) continue;
    const res = migratePage(app, r.space_id, r.slug, { commit: false });
    if (!res) continue;
    moved++;
    state.pages++;
    state.questions += res.questions;
    if (moved % 50 === 0) commitLibrary(app.libraryDir, `omem: move unsettled sections of ${moved} pages to open questions`);
    saveState(app, state);
  }
  if (moved % 50) commitLibrary(app.libraryDir, `omem: move unsettled sections of ${moved % 50} pages to open questions`);
  if (rows.length < limit) state.done = true;
  saveState(app, state);
  return { moved, looked: rows.length, done: state.done, state };
}

registerHandler("wiki-migrate", async (ctx) => {
  const r = migrateUnresolved(ctx.app);
  // Not done yet: the next batch is its own run (a restart in between goes on from `last`).
  if (!r.done) createRun(ctx.app, { kind: "wiki-migrate", title: "迁移旧页面的“还没查清”（续）", parentId: ctx.run.parentId ?? ctx.run.id });
  return { quiet: r.moved === 0, summary: `看了 ${r.looked} 页，移出 ${r.moved} 页的“还没查清”；累计 ${r.state.pages} 页、${r.state.questions} 个未决问题${r.done ? "，已全部完成" : ""}`, ...r.state };
});

/** At startup: queue the migration once (until it has been done), unless one is waiting already. */
export function queueMigration(app: App) {
  if (migrateState(app)?.done) return null;
  if (one(app.db, "select 1 from runs where kind = 'wiki-migrate' and status in ('queued','running')")) return null;
  if (!one(app.db, "select 1 from pages limit 1")) {
    saveState(app, { pages: 0, questions: 0, looked: 0, done: true, startedAt: now(), updatedAt: now() });
    return null;
  }
  return createRun(app, { kind: "wiki-migrate", title: "迁移旧页面的“还没查清”到未决问题" });
}
