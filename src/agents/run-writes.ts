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
export type WriteAction = "新建" | "更新" | "更正";
export type RunWrite = { tool: string; label: string; action?: WriteAction; space?: string | null; target?: WriteTarget; n?: number };

const clip = (s: unknown, n = 80) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};
/** The verb a write tool's answer starts with ("已新建工作文件…", "已更新事项…"). */
function actionOf(result: string | undefined): WriteAction | undefined {
  if (!result) return undefined;
  if (/^已(新建|创建|建好|保存)/.test(result)) return "新建";
  if (/^已(更新|追加)/.test(result)) return "更新";
  if (/^已更正/.test(result)) return "更正";
  return undefined;
}

/**
 * What a run wrote, so the owner can find it from the run (an answer's "已记录：…" names the
 * things, not where they are). Read from the run's `tool-write` events (tool, arguments and the
 * tool's answer, which names the id and whether it was new) and, for events recorded before the
 * answer was kept, the rows that carry the run id. Other tools are listed by name.
 */
export function runWrites(app: App, run: Run): RunWrite[] {
  const events = all<{ data: string }>(app.db, "select data from run_events where run_id = ? and type = 'tool-write' order by seq", run.id).map((e) => json(e.data, {}) as { name?: string; args?: Record<string, any>; result?: string });
  if (!events.length) return [];
  const out: RunWrite[] = [];
  const at = new Map<string, RunWrite>();
  // The same thing written twice in one run is one entry; it counts as new if it was new the first time.
  const add = (w: RunWrite) => {
    const key = w.target ? JSON.stringify(w.target) : `${w.tool}:${w.label}`;
    const prev = at.get(key);
    if (prev) return void (prev.action ??= w.action);
    at.set(key, w);
    out.push(w);
  };
  const since = run.startedAt ?? run.createdAt;
  const source = (id: string) => one<{ id: string; space_id: string; uri: string; title: string; captured_at: string; deleted_at: string | null }>(app.db, "select id, space_id, uri, title, captured_at, deleted_at from sources where id = ?", id);
  const memory = (id: string) => one<{ id: string; space_id: string; subject: string | null; content: string; supersedes: string | null }>(app.db, "select id, space_id, subject, content, supersedes from memories where id = ?", id);
  const memLabel = (m: { subject: string | null; content: string }) => clip(`${m.subject ? `${m.subject}：` : ""}${m.content}`);
  // Memories written by the run, for events that do not name them.
  const runMemories = all<{ id: string }>(app.db, "select id from memories where run_id = ? order by created_at", run.id).map((m) => m.id);
  let memIndex = 0;

  for (const { name, args = {}, result } of events) {
    if (!name) continue;
    const action = actionOf(result);
    if (name === "write_file") {
      const id = /src:(\S+?)（/.exec(result ?? "")?.[1] ?? one<{ id: string }>(app.db, "select id from sources where kind = 'work' and json_extract(meta, '$.runId') = ? and uri like ? order by updated_at desc limit 1", run.id, `%${String(args.path ?? "").replace(/^work\//, "")}`)?.id;
      const f = id ? source(id) : undefined;
      if (f) add({ tool: name, label: f.title || f.uri, action: action ?? (f.captured_at >= since ? "新建" : "更新"), space: f.space_id, target: f.deleted_at ? undefined : { kind: "source", id: f.id } });
      else add({ tool: name, label: String(args.title ?? args.path ?? "工作文件"), action });
    } else if (name === "remember" || name === "supersede") {
      const id = name === "supersede" ? /→ (\S+)/.exec(result ?? "")?.[1] : /\b(m[0-9a-z]{12,})\b/.exec(result ?? "")?.[1] ?? runMemories[memIndex];
      if (name === "remember" && !/\b(m[0-9a-z]{12,})\b/.test(result ?? "")) memIndex++;
      const m = id ? memory(id) : undefined;
      if (m) add({ tool: name, label: memLabel(m), action: m.supersedes ? "更正" : "新建", space: m.space_id, target: { kind: "memory", id: m.id } });
      else add({ tool: name, label: clip(args.content ?? args.new_content ?? "记忆"), action: name === "supersede" ? "更正" : "新建" });
    } else if (name === "write_page" && args.page) {
      const pageId = /页面 (\S+?)。/.exec(result ?? "")?.[1];
      const space = pageId ? pageId.slice(0, pageId.indexOf("/")) : String(args.space ?? run.spaceId ?? "personal");
      const slug = pageId ? pageId.slice(pageId.indexOf("/") + 1) : String(args.page);
      add({ tool: name, label: String(args.title ?? slug), action, space, target: { kind: "page", space, slug } });
    } else if (name === "upsert_item") {
      const id = /事项 (i[0-9a-z]+)/.exec(result ?? "")?.[1] ?? (args.id ? String(args.id) : one<{ id: string }>(app.db, "select id from items where title = ? and created_at >= ? order by created_at limit 1", String(args.title ?? ""), since)?.id);
      const item = id ? one<{ id: string; title: string; space_id: string }>(app.db, "select id, title, space_id from items where id = ?", id) : undefined;
      add({ tool: name, label: item?.title ?? String(args.title ?? args.id ?? "事项"), action: action ?? (args.id ? "更新" : "新建"), space: item?.space_id, target: item ? { kind: "item", id: item.id } : undefined });
    } else if (name === "save_rule") {
      const id = /规则 (\S+?)「/.exec(result ?? "")?.[1] ?? (args.id ? String(args.id) : one<{ id: string }>(app.db, "select id from rules where updated_at >= ? order by updated_at desc limit 1", since)?.id);
      add({ tool: name, label: args.name ? String(args.name) : clip(args.description, 40) || "规则", action: action ?? (args.id ? "更新" : "新建"), target: id ? { kind: "rule", id } : undefined });
    } else {
      const same = out.find((w) => w.tool === name && !w.target);
      if (same) same.n = (same.n ?? 1) + 1;
      else add({ tool: name, label: clip(args.title ?? args.name ?? args.text ?? args.content ?? args.note ?? "", 60) });
    }
  }
  return out;
}
