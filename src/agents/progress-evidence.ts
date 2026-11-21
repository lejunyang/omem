import type { App } from "../core/app.ts";
import { all } from "../core/db.ts";
import { capabilityAccess } from "../auth/capabilities.ts";
import { readableSourceIds } from "../auth/visibility.ts";
import { visibleRuns, type Reader } from "./progress-runs.ts";

export type EvidenceTarget = { kind: "source" | "design" | "run" | "object"; id: string; title: string };

/** Stage reports cite sources (with optional lines), designs, attached objects and runs. */
export function stageEvidence(app: App, reader: Reader, item: string, refs: string[]) {
  const targets = new Map<string, EvidenceTarget>();
  if (!refs.length) return targets;
  const keys = [...new Set(refs)].map(ref => {
    if (ref.startsWith("src:")) return { ref, kind: "source", id: ref.slice(4).split("#")[0] };
    if (ref.startsWith("design:")) return { ref, kind: "design", id: ref.slice(7) };
    if (ref.startsWith("object:")) return { ref, kind: "object", id: ref.slice(7) };
    return { ref, kind: "run", id: ref.replace(/^(?:run|code-work):/, "") };
  });
  const ids = (kind: string) => JSON.stringify(keys.filter(k => k.kind === kind).map(k => k.id));
  const access = capabilityAccess(app, reader.user);
  const visible = visibleRuns(app, reader);
  type Row = EvidenceTarget & { space: string | null };
  const rows = all<Row>(app.db, `select 'run' kind,r.id,r.title,null space from runs r
    where r.id in (select value from json_each(?)) and ${visible.sql}
    union all select 'design',id,title,space_id from designs where id in (select value from json_each(?))
    union all select 'source',id,title,space_id from sources where id in (select value from json_each(?)) and deleted_at is null
    union all select 'object',o.id,o.title,null from item_materials m join flow_objects o on o.id=m.ref
      where m.item_id=? and m.kind='object' and o.id in (select value from json_each(?))`,
    ids("run"), ...visible.params, ids("design"), ids("source"), item, ids("object"));
  const sources = reader.user === "owner" ? null : readableSourceIds(app, reader.user, keys.filter(k => k.kind === "source").map(k => k.id));
  const found = new Map<string, EvidenceTarget>();
  for (const { kind, id, title, space } of rows) {
    if (space && (reader.spaces && !reader.spaces.includes(space) || !access.source(kind === "design" ? "designs.view" : "sources.view", space))) continue;
    if (kind === "source" && sources && !sources.has(id)) continue;
    found.set(kind + ":" + id, { kind, id, title });
  }
  for (const { ref, kind, id } of keys) {
    const target = found.get(kind + ":" + id);
    if (target) targets.set(ref, target);
  }
  return targets;
}
