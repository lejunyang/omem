import type { App } from "../core/app.ts";
import { all, one } from "../core/db.ts";
import { json } from "../core/util.ts";
import type { Run } from "./runs.ts";

/** Where a write can be opened: an original, a memory, a Wiki page, an item, a rule. */
export type WriteTarget =
  | { kind: "source"; id: string }
  | { kind: "memory"; id: string }
  | { kind: "page"; space: string; slug: string }
  | { kind: "item"; id: string }
  | { kind: "rule"; id: string };
export type RunWrite = { tool: string; label: string; space?: string | null; target?: WriteTarget; n?: number };

const clip = (s: unknown, n = 80) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/**
 * What a run wrote, so the owner can find it from the run (an answer's "已记录：…" names the
 * things, not where they are). Read from the run's `tool-write` events and the rows that carry
 * the run id: working files (`meta.runId`), memories (`run_id`). Other tools are listed by name.
 */
export function runWrites(app: App, run: Run): RunWrite[] {
  const events = all<{ data: string }>(app.db, "select data from run_events where run_id = ? and type = 'tool-write' order by seq", run.id).map((e) => json(e.data, {}) as { name?: string; args?: Record<string, any> });
  if (!events.length) return [];
  const out: RunWrite[] = [];
  const seen = new Set<string>();
  const add = (w: RunWrite) => {
    const key = w.target ? JSON.stringify(w.target) : `${w.tool}:${w.label}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(w);
  };
  const names = new Set(events.map((e) => e.name));

  if (names.has("write_file"))
    for (const f of all<{ id: string; space_id: string; uri: string; title: string; deleted_at: string | null }>(app.db, "select id, space_id, uri, title, deleted_at from sources where kind = 'work' and json_extract(meta, '$.runId') = ? order by updated_at", run.id))
      add({ tool: "write_file", label: f.title || f.uri, space: f.space_id, target: f.deleted_at ? undefined : { kind: "source", id: f.id } });
  if (names.has("remember") || names.has("supersede"))
    for (const m of all<{ id: string; space_id: string; subject: string | null; content: string }>(app.db, "select id, space_id, subject, content from memories where run_id = ? order by created_at", run.id))
      add({ tool: "remember", label: clip(`${m.subject ? `${m.subject}：` : ""}${m.content}`), space: m.space_id, target: { kind: "memory", id: m.id } });

  const since = run.startedAt ?? run.createdAt;
  for (const { name, args = {} } of events) {
    if (!name || name === "write_file" || name === "remember" || name === "supersede") continue;
    if (name === "write_page" && args.page) {
      const space = String(args.space ?? run.spaceId ?? "personal");
      add({ tool: name, label: String(args.title ?? args.page), space, target: { kind: "page", space, slug: String(args.page) } });
    } else if (name === "upsert_item") {
      const id = args.id ? String(args.id) : one<{ id: string }>(app.db, "select id from items where title = ? and created_at >= ? order by created_at limit 1", String(args.title ?? ""), since)?.id;
      const item = id ? one<{ id: string; title: string; space_id: string }>(app.db, "select id, title, space_id from items where id = ?", id) : undefined;
      add({ tool: name, label: item?.title ?? String(args.title ?? args.id ?? "事项"), space: item?.space_id, target: item ? { kind: "item", id: item.id } : undefined });
    } else if (name === "save_rule") {
      const rule = args.id ? { id: String(args.id) } : one<{ id: string }>(app.db, "select id from rules where updated_at >= ? order by updated_at desc limit 1", since);
      add({ tool: name, label: args.name ? String(args.name) : clip(args.description, 40) || "规则", target: rule ? { kind: "rule", id: rule.id } : undefined });
    } else {
      const same = out.find((w) => w.tool === name && !w.target);
      if (same) same.n = (same.n ?? 1) + 1;
      else add({ tool: name, label: clip(args.title ?? args.name ?? args.text ?? args.content ?? args.note ?? "", 60) });
    }
  }
  return out;
}
