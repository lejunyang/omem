import { basename, dirname, join } from "node:path";
import { restrictedSourceFilter } from "../auth/visibility.ts";
import { spacesWithCapability } from "../auth/capabilities.ts";
import { canReadRun } from "../auth/permissions.ts";
import type { App } from "../core/app.ts";
import { all } from "../core/db.ts";
import { listSpaces } from "../core/spaces.ts";
import { accessibleSpaces } from "../core/users.ts";
import { canonical } from "./own-sandbox.ts";

export function sandboxData(app: App, user: string) {
  const data = canonical(app.home);
  const allowed = accessibleSpaces(app, user);
  const known = listSpaces(app);
  const spaces = user === "owner" ? null : known.map(s => s.id).filter(id => !allowed || allowed.includes(id));
  const repos = known.filter(s => s.rootPath && dirname(canonical(s.rootPath)) === join(data, "repos") &&
    (!spaces || spaces.includes(s.id))).map(s => basename(s.rootPath!));
  const grants = all<{ id: string; space_id: string | null; run_id: string }>(app.db,
    "select id, space_id, run_id from run_artifacts" + (spaces ? " where space_id in (select value from json_each(?))" : ""),
    ...(spaces ? [JSON.stringify(spaces)] : []));
  const runs = new Map<string, boolean>();
  const artifacts = grants.filter(a => {
    if (!spaces) return true;
    if (!runs.has(a.run_id)) runs.set(a.run_id, canReadRun(app, user, a.run_id));
    return runs.get(a.run_id);
  }).map(a => a.id);
  // Only host-indexed source references confer access. Documents requiring an external
  // permission check stay behind the existing source API.
  let files: string[] = [];
  if (spaces) {
    const readable = spacesWithCapability(app, user, "sources.view");
    const restricted = restrictedSourceFilter(app, user);
    files = all<{ name: string; variant: string | null }>(app.db, `select distinct f.name, v.file variant
      from stored_file_refs f join sources on sources.id=f.target join spaces s on s.id=sources.space_id
      left join file_variants v on v.original=f.name and v.status='done'
      where f.origin in ('sources','lark_messages') and sources.deleted_at is null and ${restricted.sql}
      and sources.space_id in (select value from json_each(?))
      and (sources.kind != 'doc' or coalesce(json_extract(s.settings,'$.larkAccess'),0)=0)`,
      ...restricted.params, JSON.stringify(spaces.filter(s => !readable || readable.includes(s)))).flatMap(row => row.variant ? [row.name, row.variant] : [row.name]);
  }
  return { data, spaces, repos, artifacts, files };
}
