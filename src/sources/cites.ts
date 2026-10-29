import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { now } from "../core/util.ts";

/**
 * How often a source is cited: by answers (assistant messages, `source_cites`) and by Wiki pages
 * (`page_cites`). A source that keeps being used as evidence gets a light, bounded ranking boost:
 *
 *   boost = 1 + 0.1 × min(1, ln(1 + n) / ln(1 + 20))
 *
 * n = distinct answers + distinct pages citing it. One citation gives ×1.023, five ×1.059, twenty or
 * more ×1.1 (the cap). It only reorders close hits; levels and notes still decide.
 */

export const CITE_CAP = 0.1;
const CITE_FULL = 20;
export const citeBoost = (n: number) => 1 + CITE_CAP * Math.min(1, Math.log(1 + Math.max(0, n)) / Math.log(1 + CITE_FULL));

/** Record the `src:` ids a text cites, under a reference such as `msg:<id>`. */
export function recordCites(app: App, text: string, ref: string, kind = "answer") {
  const ids = new Set<string>();
  for (const m of text.matchAll(/\bsrc:([A-Za-z0-9_-]+)/g)) ids.add(m[1]);
  if (!ids.size) return 0;
  const at = now();
  const ins = app.db.prepare("insert or ignore into source_cites(source_id, ref, kind, at) select id, ?, ?, ? from sources where id = ?");
  let n = 0;
  for (const id of ids) n += Number(ins.run(ref, kind, at, id).changes);
  return n;
}

/** Citations per source: answers plus pages. */
export function citeCounts(app: App, ids: string[]): Map<string, number> {
  const out = new Map<string, number>();
  if (!ids.length) return out;
  const list = JSON.stringify([...new Set(ids)]);
  for (const r of all<{ source_id: string; n: number }>(app.db, "select source_id, count(*) n from source_cites where source_id in (select value from json_each(?)) group by 1", list))
    out.set(r.source_id, r.n);
  for (const r of all<{ source_id: string; n: number }>(app.db, "select source_id, count(distinct page_id) n from page_cites where source_id in (select value from json_each(?)) group by 1", list))
    out.set(r.source_id, (out.get(r.source_id) ?? 0) + r.n);
  return out;
}

/** Once: the answers already in the library count too (assistant messages that cite sources). */
export function backfillCites(app: App) {
  if (one(app.db, "select 1 from kv where key = 'source_cites_backfill'")) return 0;
  let n = 0;
  for (const m of all<{ id: string; text: string }>(app.db, "select id, text from messages where role = 'assistant' and instr(text, 'src:') > 0")) n += recordCites(app, m.text, `msg:${m.id}`);
  run(app.db, "insert or replace into kv(key, value) values('source_cites_backfill', ?)", now());
  return n;
}
