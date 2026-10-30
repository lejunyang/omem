import type { App } from "../core/app.ts";
import { all } from "../core/db.ts";
import type { Hit } from "../search/search.ts";
import { levelSql, type Level } from "../sources/attention.ts";

/**
 * What a replay arm sees (agents/replay.ts, docs/v2/replay.md “回到当时”). The tools, the lessons in
 * the instructions and passive recall read the library through it:
 *
 * - `asOf`: memories as they stood then (the supersede chain, nothing written later), sources that
 *   existed then, chats and conversations cut to the lines before it; documents and pages only exist
 *   in their latest version, so those changed later are flagged “可能泄题”.
 * - `sourceLevels`: the source levels it may see (S1 focus + reference, S2 ignore as well).
 * - `memoryFilter`: memories left out (M1 the ones the original run touched, M2 all, M3 experience
 *   written by the bulk digest).
 * - `noPages`: no Wiki pages (W1).
 * - `cache`: retrieval shared by the two arms of one replay: the same (tool, arguments, as-of) is
 *   computed once, wide (every level, the memory history), and each arm filters it its own way.
 */
export type MemoryFilter = { exclude?: string[]; all?: boolean; digest?: boolean };
export type RunView = {
  asOf?: string;
  sourceLevels?: Level[];
  memoryFilter?: MemoryFilter;
  noPages?: boolean;
  cache?: Map<string, unknown>;
};

/** Levels seen when the view does not say: everything but ignore (what search does by default). */
export const DEFAULT_LEVELS: Level[] = ["focus", "normal", "reference"];
const levelsOf = (v: RunView) => v.sourceLevels ?? DEFAULT_LEVELS;

/** Sources whose lines carry their own time: cut at as-of line by line. */
export const TIME_CUT_KINDS = new Set(["chat", "conversation"]);

/**
 * SQL (for `memories <a>`) of what the view lets through: valid at as-of (created before, and active
 * then: superseded or retracted only later), and not filtered out.
 */
export function memoryWhere(view: RunView | undefined, a = "m"): { sql: string; params: string[] } {
  if (!view) return { sql: "1=1", params: [] };
  const parts: string[] = [];
  const params: string[] = [];
  if (view.memoryFilter?.all) return { sql: "0=1", params };
  if (view.asOf) {
    parts.push(
      `(${a}.created_at <= ? and (${a}.status = 'active'
        or (${a}.status = 'superseded' and coalesce((select n.created_at from memories n where n.id = ${a}.superseded_by), ${a}.updated_at) > ?)
        or (${a}.status = 'retracted' and coalesce(${a}.valid_to, ${a}.updated_at) > ?)))`,
    );
    params.push(view.asOf, view.asOf, view.asOf);
  } else parts.push(`${a}.status = 'active'`);
  const ex = view.memoryFilter?.exclude ?? [];
  if (ex.length) {
    parts.push(`${a}.id not in (select value from json_each(?))`);
    params.push(JSON.stringify(ex));
  }
  if (view.memoryFilter?.digest) parts.push(`not (${a}.kind = 'experience' and ${a}.run_id in (select id from runs where kind in ('digest', 'triage')))`);
  return { sql: parts.join(" and "), params };
}

/** Which of these memories the view lets through. */
export function visibleMemories(app: App, view: RunView | undefined, ids: string[]): Set<string> {
  if (!view || !ids.length) return new Set(ids);
  const w = memoryWhere(view, "m");
  return new Set(all<{ id: string }>(app.db, `select m.id from memories m where m.id in (select value from json_each(?)) and ${w.sql}`, JSON.stringify([...new Set(ids)]), ...w.params).map((r) => r.id));
}

/** A memory retracted after as-of was still plain then: its retraction note would give the later correction away. */
export const asOfContent = (view: RunView | undefined, content: string) => (view?.asOf ? content.replace(/\n（撤回原因：[\s\S]*$/, "") : content);

type SourceRow = { id: string; kind: string; captured_at: string; updated_at: string; deleted_at: string | null; level: string | null; text?: string };

/** Why the view hides a source, or null. `level` is its effective level. */
export function sourceHidden(view: RunView | undefined, s: { captured_at: string; level: string | null }): string | null {
  if (!view) return null;
  if (view.asOf && s.captured_at > view.asOf) return "这份原件在提问之后才收进来";
  const level = (s.level ?? "normal") as Level;
  if (!levelsOf(view).includes(level)) return `这次复盘不看“${level}”级别的原件`;
  return null;
}

export function sourceRows(app: App, ids: string[]): Map<string, SourceRow> {
  if (!ids.length) return new Map();
  return new Map(
    all<SourceRow>(app.db, `select s.id, s.kind, s.captured_at, s.updated_at, s.deleted_at, ${levelSql("s")} level from sources s where s.id in (select value from json_each(?))`, JSON.stringify([...new Set(ids)])).map((r) => [r.id, r]),
  );
}

const LARK_ID = /\((om_[\w-]+)\)\s*$/;
const MSG_ID = /msg:(msg[0-9a-z]{6,})/;
const MINUTE = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2})|^\*\*[^*]{1,20}\*\*（(\d{4}-\d{2}-\d{2} \d{2}:\d{2})/;

/**
 * Which lines of a chat or conversation existed at as-of. A line's time comes from its Feishu message
 * (lark_messages.create_ms) or omem message (messages.created_at) when its id is on the line, else
 * from the minute it starts with (a line in the same minute as as-of counts as later). Lines without a
 * time (a message's continuation) go with the line before them.
 */
export function visibleLines(app: App, view: RunView, sourceId: string, text: string): boolean[] {
  const key = `lines|${sourceId}|${view.asOf}`;
  const cached = view.cache?.get(key) as { len: number; vis: boolean[] } | undefined;
  const lines = text.split("\n");
  if (cached && cached.len === lines.length) return cached.vis;
  const asOf = Date.parse(view.asOf!);
  const lark = new Set<string>();
  const msgs = new Set<string>();
  for (const l of lines) {
    const a = LARK_ID.exec(l)?.[1];
    if (a) lark.add(a);
    const b = l.startsWith("**") ? MSG_ID.exec(l)?.[1] : undefined;
    if (b) msgs.add(b);
  }
  const larkMs = new Map(lark.size ? all<{ message_id: string; create_ms: number }>(app.db, "select message_id, create_ms from lark_messages where message_id in (select value from json_each(?))", JSON.stringify([...lark])).map((r) => [r.message_id, r.create_ms]) : []);
  const msgMs = new Map(msgs.size ? all<{ id: string; created_at: string }>(app.db, "select id, created_at from messages where id in (select value from json_each(?))", JSON.stringify([...msgs])).map((r) => [r.id, Date.parse(r.created_at)]) : []);
  let state = true;
  const vis = lines.map((l) => {
    const lid = LARK_ID.exec(l)?.[1];
    const mid = l.startsWith("**") ? MSG_ID.exec(l)?.[1] : undefined;
    const exact = (lid && larkMs.get(lid)) ?? (mid && msgMs.get(mid));
    if (typeof exact === "number") state = exact < asOf;
    else {
      const m = MINUTE.exec(l);
      if (m) state = Date.parse(`${(m[1] ?? m[2]).replace(" ", "T")}:00Z`) + 60_000 <= asOf;
    }
    return state;
  });
  view.cache?.set(key, { len: lines.length, vis });
  return vis;
}

/**
 * Search hits as the view sees them: memories valid then and not filtered out, sources that existed
 * then at an allowed level, chat hits cut to the lines before as-of, pages unless W1. Hits on
 * documents and pages changed after as-of are marked `later` (可能泄题). Memories superseded or
 * retracted after as-of show as they were then.
 */
export function filterHits(app: App, view: RunView | undefined, hits: Hit[]): Hit[] {
  if (!view) return hits;
  const mems = visibleMemories(app, view, hits.filter((h) => h.type === "memory").map((h) => h.id));
  const srcs = sourceRows(app, hits.flatMap((h) => (h.sourceId ? [h.sourceId] : [])));
  const pageTimes = new Map(
    view.asOf && hits.some((h) => h.type === "page")
      ? all<{ id: string; updated_at: string }>(app.db, "select id, updated_at from pages where id in (select value from json_each(?))", JSON.stringify(hits.filter((h) => h.type === "page").map((h) => h.id))).map((r) => [r.id, r.updated_at])
      : [],
  );
  const out: Hit[] = [];
  for (const h of hits) {
    if (h.type === "memory") {
      if (!mems.has(h.id)) continue;
      out.push({ ...h, status: "active", snippet: asOfContent(view, h.snippet) });
      continue;
    }
    if (h.type === "page") {
      if (view.noPages) continue;
      const at = pageTimes.get(h.id);
      out.push(view.asOf && at && at > view.asOf ? { ...h, later: true } : h);
      continue;
    }
    const s = h.sourceId ? srcs.get(h.sourceId) : undefined;
    if (!s || sourceHidden(view, s)) continue;
    if (view.asOf && TIME_CUT_KINDS.has(s.kind)) {
      const text = all<{ text: string }>(app.db, "select text from sources where id = ?", s.id)[0]?.text ?? "";
      const vis = visibleLines(app, view, s.id, text);
      const from = h.lineStart ?? 1;
      const to = h.lineEnd ?? from;
      const keep: number[] = [];
      for (let i = from; i <= to; i++) if (vis[i - 1]) keep.push(i);
      if (!keep.length) continue;
      if (keep.length === to - from + 1) out.push(h);
      else {
        const lines = text.split("\n");
        out.push({ ...h, lineStart: keep[0], lineEnd: keep[keep.length - 1], snippet: keep.map((i) => lines[i - 1]).join("\n").slice(0, 500) });
      }
      continue;
    }
    out.push(view.asOf && s.updated_at > view.asOf ? { ...h, later: true } : h);
  }
  return out;
}

/** A cached computation shared by the arms of one replay. */
export async function cached<T>(view: RunView | undefined, key: unknown[], make: () => Promise<T> | T): Promise<T> {
  if (!view?.cache) return make();
  const k = JSON.stringify(key);
  if (view.cache.has(k)) return structuredClone(view.cache.get(k)) as T;
  const v = await make();
  view.cache.set(k, structuredClone(v));
  return v;
}

/** Shown on tool output: when the arm is answering from. */
export const asOfLabel = (view: RunView) => (view.asOf ? view.asOf.slice(0, 16).replace("T", " ") : "");
