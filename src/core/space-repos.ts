import type { App } from "./app.ts";
import { all } from "./db.ts";
import { listSpaces } from "./spaces.ts";

/**
 * Which existing repositories probably belong to a business space (docs/v2/coding-work.md 4.4), for
 * the owner to confirm in the space's settings: a relation the owner made, delegations filed there
 * that changed the repository, items there that list it, a relation an agent made. Only repositories
 * that belong to no business space yet.
 */
export type RepoSuggestion = { space: string; name: string; reasons: string[]; score: number };

export function repoSuggestions(app: App, parentId: string): RepoSuggestion[] {
  const repos = listSpaces(app).filter((s) => s.kind === "repo" && s.rootPath && !s.parentId && s.id !== parentId);
  if (!repos.length) return [];
  const out: RepoSuggestion[] = [];
  for (const r of repos) {
    const reasons: string[] = [];
    let score = 0;
    const rel = all<{ origin: string; note: string }>(app.db, "select origin, note from space_relations where status = 'active' and ((space_a = ? and space_b = ?) or (space_a = ? and space_b = ?))", r.id, parentId, parentId, r.id)[0];
    if (rel?.origin === "owner") { reasons.push(`你关联过${rel.note ? `：${rel.note}` : ""}`); score += 100; }
    const runs = all<{ n: number }>(app.db, `select count(*) n from runs where kind = 'code' and space_id = ? and json_extract(input, '$.continueFrom') is null
      and exists (select 1 from json_each(coalesce(json_extract(input, '$.repos'), '[]')) j where j.value = ?)`, parentId, r.id)[0]?.n ?? 0;
    if (runs) { reasons.push(`${runs} 次交办记在这里`); score += 10 + runs; }
    const items = all<{ title: string }>(app.db, "select i.title from item_materials m join items i on i.id = m.item_id where m.kind = 'repo' and (m.ref = ? or m.ref like ? escape '!') and i.space_id = ? limit 3", r.id, `${r.id.replace(/[!%_]/g, (c) => `!${c}`)}#%`, parentId);
    if (items.length) { reasons.push(`事项${items.map((i) => `「${i.title}」`).join("")}挂着它`); score += 5 * items.length; }
    if (rel?.origin === "agent") { reasons.push(`Agent 关联过${rel.note ? `：${rel.note}` : ""}`); score += 3; }
    if (reasons.length) out.push({ space: r.id, name: r.name, reasons, score });
  }
  return out.sort((a, b) => b.score - a.score);
}
