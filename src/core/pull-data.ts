import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { all, openDb, run } from "./db.ts";
import { now, sha256 } from "./util.ts";
import { relocate } from "./pull-repos.ts";

export type Row = Record<string, SQLInputValue>;
export type Table = { name: string; key: string[]; newer?: string; integer?: boolean; natural?: string[]; local?: string[] };
/** Every business table belongs here. Search projections, credentials and capture/process state do not. */
export const pullTables: Table[] = [
  { name: "users", key: ["id"] },
  { name: "identities", key: ["channel", "external_id"] },
  { name: "space_members", key: ["space_id", "user_id"] },
  { name: "space_relations", key: ["space_a", "space_b"], newer: "updated_at" },
  { name: "memory_folders", key: ["space_id", "path"], newer: "updated_at" },
  { name: "memories", key: ["id"], newer: "updated_at", local: ["embedding"] },
  { name: "items", key: ["id"], newer: "updated_at" },
  { name: "conversations", key: ["id"], newer: "updated_at", local: ["agent_session", "agent_cwd"] },
  { name: "runs", key: ["id"], newer: "coalesce(finished_at, started_at, created_at)", local: ["profile_id", "lane", "not_before"] },
  { name: "cards", key: ["id"], newer: "due_at" },
  { name: "learn_goals", key: ["id"], newer: "updated_at" },
  { name: "card_interactions", key: ["id"], newer: "coalesce(handled_at, created_at)" },
  { name: "messages", key: ["id"] },
  { name: "run_events", key: ["run_id", "seq"] },
  { name: "card_reviews", key: ["card_id", "at", "user_id"] },
  { name: "notifications", key: ["id"] },
  { name: "handled_messages", key: ["channel", "message_id"] },
  { name: "chat_settings", key: ["channel", "chat_id"], newer: "sync_updated_at" },
  { name: "memory_rejections", key: ["id"] },
  { name: "shadow_writes", key: ["id"] },
  { name: "profile_proposals", key: ["id"], newer: "sync_updated_at" },
  { name: "item_repairs", key: ["id"] },
  { name: "item_update_proposals", key: ["id"], newer: "sync_updated_at" },
  { name: "asks", key: ["id"], newer: "sync_updated_at" },
  { name: "rules", key: ["id"], newer: "updated_at", local: ["enabled"] },
  { name: "archive_rules", key: ["id"], newer: "sync_updated_at" },
  { name: "attention_rules", key: ["id"], newer: "sync_updated_at" },
  { name: "rule_handled", key: ["rule_id", "key"] },
  { name: "schedules", key: ["id"], local: ["enabled"] },
  { name: "source_routes", key: ["source_id"], newer: "sync_updated_at" },
  { name: "source_locations", key: ["origin_space", "uri"], newer: "sync_updated_at" },
  { name: "item_checks", key: ["item_id"], newer: "checked_at" },
  { name: "lark_messages", key: ["message_id"], newer: "sync_updated_at" },
  { name: "digest_jobs", key: ["id"], newer: "updated_at" },
  { name: "digest_done", key: ["job_id", "source_id"] },
  { name: "reviews", key: ["id"], newer: "sync_updated_at" },
  ...[
    ["item_events", ["item_id", "at", "kind", "text"]],
    ["memory_recalls", ["memory_id", "run_id", "agent_profile", "at", "via"]],
    ["rule_firings", ["rule_id", "event_key", "at"]],
    ["source_moves", ["source_id", "from_space", "to_space", "at", "reason"]],
    ["source_notes", ["source_id", "line_start", "line_end", "kind", "note", "created_at"]],
    ["item_materials", ["item_id", "kind", "ref"]],
    ["review_findings", ["review_id", "file_path", "line", "title"]],
  ].map(([name, natural]) => ({ name: name as string, key: ["id"], newer: "sync_updated_at", integer: true, natural: natural as string[] })),
];

export function columns(db: DatabaseSync, table: string, schema = "main") {
  return (db.prepare(`pragma ${schema}.table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
}

type Source = Row & { id: string; space_id: string; uri: string; kind: string; text: string; updated_at: string; deleted_at: string | null };
export type Prepared = { databasePath: string; sources: Source[]; ids: Map<string, string>; lines: Map<string, number[]>; aliases: [string, string, string][] };

/** Append missing occurrences, preserving every existing local line and its citation number. */
function joinChat(local: string, remote: string) {
  const kept = local ? local.split("\n") : [];
  const available = new Map<string, number[]>();
  kept.forEach((line, i) => {
    let slots = available.get(line);
    if (!slots) available.set(line, slots = []);
    slots.push(i + 1);
  });
  const used = new Map<string, number>();
  const lines = (remote ? remote.split("\n") : []).map((line) => {
    const n = used.get(line) ?? 0;
    used.set(line, n + 1);
    const have = available.get(line)?.[n];
    if (have) return have;
    kept.push(line);
    return kept.length;
  });
  return { text: kept.join("\n"), lines };
}

function mapRange(map: number[] | undefined, start: number, end: number) {
  if (!map) return [start, end];
  const range = map.slice(start - 1, end);
  let low = Infinity, high = -Infinity;
  for (const line of range) { low = Math.min(low, line); high = Math.max(high, line); }
  return range.length ? [low, high] : [start, end];
}

export function rewriteRefs(text: string, prepared: Pick<Prepared, "ids" | "lines">) {
  return text.replace(/src:([\w-]+)(?:#L(\d+)(?:-L?(\d+))?)?/g, (_m, id: string, a: string, b: string) => {
    const target = prepared.ids.get(id) ?? id;
    if (!a) return `src:${target}`;
    const [start, end] = mapRange(prepared.lines.get(id), Number(a), Number(b ?? a));
    return `src:${target}#L${start}${end !== start ? `-L${end}` : ""}`;
  });
}

/** Mutate only the private snapshot, never the peer or existing local evidence. */
export function prepareData(local: DatabaseSync, dir: string, paths: Map<string, string>): Prepared {
  const original = openDb(join(dir, "omem.db"));
  const databasePath = join(mkdtempSync(join(dir, "merge-")), "omem.db");
  original.prepare("vacuum into ?").run(databasePath);
  original.close();
  const remote = openDb(databasePath);
  remote.exec("pragma foreign_keys = off");
  for (const t of all<{ name: string }>(remote, "select name from sqlite_master where type = 'trigger' and name glob '*_sync_*'")) remote.exec(`drop trigger ${t.name}`);
  const prepared: Prepared = { databasePath, sources: [], ids: new Map(), lines: new Map(), aliases: [] };
  try {
    const lookup = local.prepare("select * from sources where space_id = ? and uri = ?");
    for (const s of all<Source>(remote, "select * from sources")) {
      const have = lookup.get(s.space_id, s.uri) as Source | undefined;
      prepared.ids.set(s.id, have?.id ?? s.id);
      if (have && !have.deleted_at && !s.deleted_at && (s.kind === "chat" || s.kind === "conversation")) {
        const remoteId = s.id;
        const merged = joinChat(have.text, s.text);
        prepared.lines.set(s.id, merged.lines);
        if (have.updated_at >= s.updated_at) Object.assign(s, have, { id: remoteId });
        s.text = merged.text;
        s.hash = sha256(s.text);
        if (s.text !== have.text) s.updated_at = [s.updated_at, have.updated_at, now()].sort().at(-1)!;
      }
      prepared.sources.push(s);
    }

    // Line-bearing structured records need the mapping from the remote chat before its id changes.
    for (const name of ["lark_messages", "source_notes"])
      for (const row of all<Row>(remote, `select rowid as _rowid, * from ${name} where source_id is not null`)) {
        const map = prepared.lines.get(row.source_id as string);
        if (!map) continue;
        if (name === "lark_messages" && row.line)
          remote.prepare(`update ${name} set line = ?, sync_updated_at = sync_updated_at where rowid = ?`).run(map[Number(row.line) - 1] ?? row.line, row._rowid);
        if (name === "source_notes" && row.line_start) {
          const [a, b] = mapRange(map, Number(row.line_start), Number(row.line_end ?? row.line_start));
          remote.prepare(`update ${name} set line_start = ?, line_end = ? where rowid = ?`).run(a, b, row._rowid);
        }
      }

    function rewrite(value: unknown): unknown {
      if (typeof value === "string") return relocate(prepared.ids.get(value) ?? rewriteRefs(value, prepared), paths);
      if (Array.isArray(value)) return value.map(rewrite);
      if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rewrite(v)]));
      return value;
    }
    for (const s of prepared.sources) s.meta = JSON.stringify(rewrite(JSON.parse(String(s.meta))));
    for (const t of pullTables) {
      const fields = columns(remote, t.name).filter((c) => !["id", "sync_key", "sync_updated_at"].includes(c));
      if (!fields.length) continue;
      for (const row of all<Row>(remote, `select rowid as _rowid, ${fields.join(",")} from ${t.name}`)) {
        const changes: [string, SQLInputValue][] = [];
        for (const c of fields) {
          const v = row[c];
          if (typeof v !== "string") continue;
          let next: string;
          // Only structured JSON is parsed. A long numeric card answer is text, not a JS number.
          try { next = /^[\s]*[\[{]/.test(v) ? JSON.stringify(rewrite(JSON.parse(v))) : rewrite(v) as string; }
          catch { next = rewrite(v) as string; }
          if (next !== v) changes.push([c, next]);
        }
        if (changes.length) remote.prepare(`update ${t.name} set ${changes.map(([c]) => `${c} = ?`).join(",")} where rowid = ?`).run(...changes.map(([, v]) => v), row._rowid);
      }
    }

    for (const t of pullTables.filter((t) => t.integer)) {
      let next = Number((local.prepare(`select coalesce(max(id), 0) n from ${t.name}`).get() as { n: number }).n);
      const idMap = new Map<number, number>();
      for (const row of all<Row>(remote, `select * from ${t.name} order by id`)) {
        // Natural keys also recognise copies made before portable identities were introduced.
        const have = local.prepare(`select id, sync_key from ${t.name} where sync_key = ? or sync_key = (select local_key from pull_aliases where table_name = ? and remote_key = ?) or (${t.natural!.map((k) => `${k} is ?`).join(" and ")}) limit 1`).get(row.sync_key, t.name, row.sync_key, ...t.natural!.map((k) => row[k])) as { id: number; sync_key: string } | undefined;
        if (have && have.sync_key !== row.sync_key) prepared.aliases.push([t.name, row.sync_key as string, have.sync_key]);
        const id = have?.id ?? ++next;
        idMap.set(Number(row.id), id);
        remote.prepare(`update ${t.name} set id = ?, sync_key = ? where id = ?`).run(-Number(row.id), have?.sync_key ?? row.sync_key, row.id);
      }
      for (const [from, to] of idMap) remote.prepare(`update ${t.name} set id = ? where id = ?`).run(to, -from);
      if (t.name === "review_findings") {
        for (const row of all<Row>(remote, "select id, merged_into from review_findings where merged_into is not null"))
          remote.prepare("update review_findings set merged_into = ? where id = ?").run(idMap.get(Number(row.merged_into)) ?? null, row.id);
        // These are actionable numeric references, unlike the historical prose in reports.
        const remap = (v: unknown, key = ""): unknown => {
          if (typeof v === "number" && ["findingId", "findingIds", "into"].includes(key)) return idMap.get(v) ?? v;
          if (Array.isArray(v)) return v.map((x) => remap(x, key));
          if (v && typeof v === "object") {
            const finding = "decision" in v && "id" in v;
            return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, remap(x, finding && k === "id" ? "findingId" : k)]));
          }
          return v;
        };
        for (const table of ["runs", "asks", "run_events"]) {
          const fields = columns(remote, table).filter((c) => ["input", "output", "context", "args", "data"].includes(c));
          for (const row of all<Row>(remote, `select rowid as _rowid, ${fields.join(",")} from ${table}`))
            for (const field of fields) {
              if (typeof row[field] !== "string") continue;
              try {
                const value = JSON.stringify(remap(JSON.parse(row[field] as string)));
                if (value !== row[field]) remote.prepare(`update ${table} set ${field} = ? where rowid = ?`).run(value, row._rowid);
              } catch { /* Plain historical text has no actionable numeric references. */ }
            }
        }
      }
    }
  } finally { remote.close(); }
  return prepared;
}

export function rewriteLibrary(dir: string, prepared: Pick<Prepared, "ids" | "lines">, paths: Map<string, string>) {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === ".git" || e.isSymbolicLink()) continue;
    const file = join(dir, e.name);
    if (e.isDirectory()) rewriteLibrary(file, prepared, paths);
    else if (e.name.endsWith(".md")) {
      const before = readFileSync(file, "utf8");
      const after = relocate(rewriteRefs(before, prepared), paths);
      if (before !== after) writeFileSync(file, after);
    }
  }
}
