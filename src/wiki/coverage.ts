import type { App } from "../core/app.ts";
import { all, one, run, tx } from "../core/db.ts";
import { getSpace, listSpaces } from "../core/spaces.ts";
import { OWNER } from "../core/users.ts";
import { HttpError, now } from "../core/util.ts";
import { effectiveLevel, levelSql } from "../sources/attention.ts";
import { citeCounts } from "../sources/cites.ts";
import { docTokens } from "../sources/doc-links.ts";
import { generateWiki } from "./generate.ts";

const DAY = 86400_000;
const RETRY_DAYS = 30;
const RECENT_DAYS = 90;
const POST_WEIGHT = 1, PEOPLE_WEIGHT = 2, CITE_WEIGHT = 3, ITEM_WEIGHT = 3, OWNER_WEIGHT = 2, RECENT_WEIGHT = 1;
// 分数 = 贴链接次数 + 2×发帖人数 + 3×引用次数 + 3×关联事项数 + 本人定级×2 + 近90天修改×1。
const important = `s.space_id = ? and s.kind in ('doc','web','note') and s.deleted_at is null
  and ${levelSql()} = 'focus'
  and not exists (select 1 from source_notes n where n.source_id = s.id and n.line_start is null
    and n.kind in ('exclude','wrong') and n.stale_at is null and n.status != 'rejected' and (n.by = 'owner' or n.status = 'confirmed'))`;
const uncited = "not exists (select 1 from page_cites pc where pc.source_id = s.id)";

export function coverage(app: App, spaceId: string) {
  return one<{ total: number; covered: number }>(app.db,
    `select count(*) total, coalesce(sum(case when ${uncited} then 0 else 1 end), 0) covered from sources s where ${important}`, spaceId)!;
}

export type Uncovered = {
  sourceId: string; title: string; updatedAt: string; score: number;
  posts: number; people: number; cites: number; items: number; ownerSet: boolean; recent: boolean;
};

/** No source text, runs or chunks: indexed links/cites and one set pass over item references. */
export function uncovered(app: App, spaceId: string, limit: number): Uncovered[] {
  if (limit <= 0) return [];
  const at = Date.now();
  const rows = all<{ id: string; title: string; uri: string; meta: string; updated_at: string; attention: string | null; attention_by: string | null; node_level: string | null; node_level_by: string | null }>(app.db,
    `select s.id, s.title, s.uri, s.meta, s.updated_at, s.attention, s.attention_by, s.node_level, s.node_level_by
     from sources s where ${important} and ${uncited} and not exists
     (select 1 from wiki_coverage_tries t where t.space_id = s.space_id and t.source_id = s.id and t.at > ?)`,
    spaceId, new Date(at - RETRY_DAYS * DAY).toISOString());
  if (!rows.length) return [];
  const ids = JSON.stringify(rows.map((r) => r.id));
  // Both the /wiki/ node token and the underlying /docx/ token can name the same original.
  const tokens = rows.flatMap((r) => {
    const meta = JSON.parse(r.meta) as { documentId?: string; wikiNodeToken?: string };
    return [...new Set([...docTokens(r.uri), meta.documentId, meta.wikiNodeToken].filter((t): t is string => !!t))].map((token) => ({ id: r.id, token }));
  });
  const links = new Map(all<{ id: string; posts: number; people: number }>(app.db,
    `with tokens as (select json_extract(value, '$.id') id, json_extract(value, '$.token') token from json_each(?))
     select t.id, count(distinct l.message_id) posts,
       count(distinct case when m.sender_kind in ('user','owner') then nullif(m.sender_id, '') end) people
     from tokens t join lark_doc_links l on l.token = t.token
     left join lark_messages m on m.message_id = l.message_id group by t.id`, JSON.stringify(tokens)).map((r) => [r.id, r]));
  const items = new Map(all<{ source_id: string; n: number }>(app.db,
    `with refs as materialized (
       select i.id item_id, case when j.type = 'object' then coalesce(json_extract(j.value, '$.sourceId'), json_extract(j.value, '$.id'), json_extract(j.value, '$.ref')) else j.value end ref
       from items i, json_each(i.source_refs) j where i.status != 'cancelled' and i.source_refs != '[]'
     ), normalized as (
       select item_id, case when ref like 'src:%' then substr(ref, 5, instr(substr(ref,5) || '#', '#') - 1) else ref end source_id from refs
       union select m.item_id, m.ref from item_materials m join items i on i.id = m.item_id where m.kind = 'source' and i.status != 'cancelled'
     ) select source_id, count(distinct item_id) n from normalized where source_id in (select value from json_each(?)) group by source_id`, ids).map((r) => [r.source_id, r.n]));
  const counts = citeCounts(app, rows.map((r) => r.id));
  return rows.map((r): Uncovered => {
    const posts = links.get(r.id)?.posts ?? 0, people = links.get(r.id)?.people ?? 0;
    const cites = counts.get(r.id) ?? 0, itemCount = items.get(r.id) ?? 0;
    const ownerSet = effectiveLevel(r).by === 'owner';
    const recent = Date.parse(r.updated_at) >= at - RECENT_DAYS * DAY;
    return { sourceId: r.id, title: r.title, updatedAt: r.updated_at, posts, people, cites, items: itemCount, ownerSet, recent,
      score: posts * POST_WEIGHT + people * PEOPLE_WEIGHT + cites * CITE_WEIGHT + itemCount * ITEM_WEIGHT + Number(ownerSet) * OWNER_WEIGHT + Number(recent) * RECENT_WEIGHT };
  }).sort((a, b) => b.score - a.score || b.updatedAt.localeCompare(a.updatedAt) || a.sourceId.localeCompare(b.sourceId)).slice(0, limit);
}

/** Manual runs use the same candidates, retry window and per-space cap; autoOrganize gates nightly runs only. */
export function runCoverage(app: App, opts: { spaceId?: string; userId?: string } = {}) {
  const { nightly, perSpace } = app.config.wiki.coverage;
  const spaces = opts.spaceId ? [getSpace(app, opts.spaceId)] : listSpaces(app).filter((s) => s.settings.autoOrganize !== false);
  if (opts.spaceId && ['repo', 'worktree'].includes(spaces[0].kind)) throw new HttpError(400, "代码空间不运行重点文档补写");
  const budget = opts.spaceId ? perSpace : nightly;
  if (!budget || !perSpace) return [];
  const chosen = spaces.filter((s) => !['repo', 'worktree'].includes(s.kind)).flatMap((s) =>
    uncovered(app, s.id, perSpace).map((doc) => ({ ...doc, spaceId: s.id })))
    .sort((a, b) => b.score - a.score || b.updatedAt.localeCompare(a.updatedAt) || a.sourceId.localeCompare(b.sourceId)).slice(0, budget);
  const groups = new Map<string, string[]>();
  for (const doc of chosen) groups.set(doc.spaceId, [...(groups.get(doc.spaceId) ?? []), doc.sourceId]);
  return [...groups].map(([spaceId, sourceIds]) => tx(app.db, () => {
    const generation = generateWiki(app, { spaceId, sourceIds, userId: opts.userId ?? OWNER, autoWrite: true,
      focus: "把这几份重点文档的内容写进 Wiki：已有讲这件事的页面就补进去并引用它，没有再建新页面。只规划这些材料涉及的内容。" });
    for (const id of sourceIds) run(app.db, "insert into wiki_coverage_tries(space_id,source_id,at,generation_id) values(?,?,?,?)", spaceId, id, now(), generation.id);
    return { spaceId, sourceIds, generationId: generation.id };
  }));
}
