/**
 * How a search hit is shown to a reader (web search box): the title, where it lives, and an
 * excerpt around the match as clean text with the matched ranges. Ranking and the snippet the
 * `search` tool gives agents are untouched; this only reads the hit's own text again.
 */
import type { App } from "../core/app.ts";
import { all } from "../core/db.ts";
import { json } from "../core/util.ts";
import type { Hit } from "./search.ts";
import { terms } from "./tokenize.ts";

/** [start, end) offsets into a string. */
export type Range = [number, number];
export type HitDisplay = {
  title: string;
  titleMarks: Range[];
  /** Plain text around the match (no Markdown or HTML syntax), with `…` where it was cut. */
  text: string;
  marks: Range[];
  /** Where the hit lives: knowledge base path, heading path, page folder. */
  place: string;
  /** The original's address, shortened (host and path), for links; empty for files and chats. */
  link: string;
};
export type PresentedHit = Hit & { display: HitDisplay };

const ENTITIES: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'", ensp: " ", emsp: " ", hellip: "…", middot: "·" };

/** Markdown and the HTML that documents carry, reduced to the words a reader would see. */
export function plainText(raw: string): string {
  let t = raw.replace(/\r\n?/g, "\n");
  // Fence lines go; the code stays readable.
  t = t.replace(/^\s*(```|~~~).*$/gm, "");
  // Table cells and block ends become separators before the tags are dropped.
  t = t.replace(/<\/(td|th)\s*>/gi, " | ").replace(/<\/(tr|p|div|li|h[1-6]|ul|ol|table|blockquote|pre)\s*>/gi, "\n").replace(/<br\s*\/?>/gi, "\n");
  t = t.replace(/<!--[\s\S]*?-->/g, "").replace(/<\/?[A-Za-z][^<>]*>/g, "");
  t = t.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (/^#x/i.test(e)) return String.fromCodePoint(parseInt(e.slice(2), 16) || 32);
    if (e[0] === "#" && /^#\d+$/.test(e)) return String.fromCodePoint(Number(e.slice(1)) || 32);
    return ENTITIES[e.toLowerCase()] ?? m;
  });
  // Markdown: images and links keep their text, wiki links their label.
  t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, "$2").replace(/\[\[([^\]]*)\]\]/g, "$1");
  t = t.replace(/<(https?:\/\/[^>\s]+)>/g, "$1").replace(/https?:\/\/([^\s/)]+)[^\s)]*/g, "$1/…");
  t = t
    .split("\n")
    .map((line) => {
      if (/^\s*\|?[\s:|-]+\|?\s*$/.test(line) && line.includes("-") && line.includes("|")) return "";
      return line
        .replace(/^\s{0,3}#{1,6}\s+/, "")
        .replace(/^\s*>+\s?/, "")
        .replace(/^\s*([-*+]|\d+[.)])\s+/, "")
        .replace(/^\s*\|\s?/, "")
        .replace(/\s?\|\s*$/, "");
    })
    .join("\n");
  t = t.replace(/(\*\*|__)(.+?)\1/g, "$2").replace(/~~(.+?)~~/g, "$1").replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)\*(?!\w)/g, "$1$2").replace(/`([^`\n]+)`/g, "$1");
  return t.replace(/[ \t ]+/g, " ").replace(/\s*\n\s*/g, " ").replace(/( \| ){2,}/g, " | ").replace(/\s{2,}/g, " ").trim();
}

const STOP = new Set([
  "the", "a", "an", "of", "to", "in", "is", "are", "and", "or", "for", "on", "how", "what", "why", "does", "do", "where", "which", "when", "it", "this", "that", "with", "be", "can", "i", "we",
  "什么", "怎么", "如何", "哪里", "哪些", "为什么", "是否", "一下", "我们", "你们", "他们", "这个", "那个", "之前", "现在", "的是", "是什", "么时", "时候", "可以", "需要", "有没", "没有",
]);

/** What to look for in the text: the query's search terms (CJK bigrams, identifiers and their parts), without stop words. */
export function highlightTerms(query: string): string[] {
  const all = [...new Set(terms(query))];
  const keep = all.filter((t) => !STOP.has(t));
  return (keep.length ? keep : all).slice(0, 64);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Every place a term occurs (case-insensitive), merged where they touch. */
export function markRanges(text: string, needles: string[]): Range[] {
  const list = needles.filter(Boolean).sort((a, b) => b.length - a.length);
  if (!list.length || !text) return [];
  const re = new RegExp(list.map(escapeRe).join("|"), "giu");
  const out: Range[] = [];
  for (const m of text.matchAll(re)) {
    if (!m[0]) continue;
    const last = out[out.length - 1];
    if (last && m.index! <= last[1]) last[1] = Math.max(last[1], m.index! + m[0].length);
    else out.push([m.index!, m.index! + m[0].length]);
  }
  return out;
}

/**
 * A window of about `size` characters around the best-matching spot of `raw` as plain text:
 * the one that covers the most distinct terms (earliest on a tie), with `…` where it was cut.
 */
export function excerpt(raw: string, needles: string[], size = 200): { text: string; marks: Range[] } {
  const plain = plainText(raw);
  const marks = markRanges(plain, needles);
  if (plain.length <= size) return { text: plain, marks };
  if (!marks.length) return { text: plain.slice(0, size).trimEnd() + "…", marks: [] };
  const lower = plain.toLowerCase();
  const sameLength = lower.length === plain.length;
  const distinct = (a: number, b: number) => new Set(marks.filter(([s, e]) => s >= a && e <= b).map(([s, e]) => (sameLength ? lower : plain).slice(s, e).toLowerCase())).size;
  let start = 0;
  let best = -1;
  for (const [s] of marks) {
    const a = Math.max(0, s - Math.floor(size / 4));
    const score = distinct(a, a + size);
    if (score > best) ((best = score), (start = a));
  }
  let end = Math.min(plain.length, start + size);
  // Begin and end on a word edge for Latin text; CJK has no such edge.
  if (start > 0) {
    const m = /^[^\s]{1,12}\s/.exec(plain.slice(start));
    if (m && /[A-Za-z0-9]/.test(plain[start - 1] ?? "") && /[A-Za-z0-9]/.test(plain[start] ?? "")) start += m[0].length;
  }
  if (end < plain.length && /[A-Za-z0-9]/.test(plain[end - 1] ?? "") && /[A-Za-z0-9]/.test(plain[end] ?? "")) {
    const back = plain.lastIndexOf(" ", end);
    if (back > start + size / 2) end = back;
  }
  const seg = plain.slice(start, end);
  const lead = seg.length - seg.trimStart().length;
  const head = start > 0 ? "…" : "";
  const text = head + seg.trim() + (end < plain.length ? "…" : "");
  const origin = start + lead;
  const shown = marks
    .filter(([s, e]) => e > origin && s < end)
    .map(([s, e]) => [Math.max(s, origin) - origin + head.length, Math.min(e, end) - origin + head.length] as Range)
    .filter(([s, e]) => e > s && s < text.length)
    .map(([s, e]) => [s, Math.min(e, text.length)] as Range);
  return { text, marks: shown };
}

/** `host/path` of a web address, without the scheme and query; empty for anything else. */
export function shortLink(uri: string | undefined | null): string {
  if (!uri || !/^https?:\/\//i.test(uri)) return "";
  try {
    const u = new URL(uri);
    const path = u.pathname.replace(/\/$/, "");
    return u.host + (path.length > 40 ? path.slice(0, 39) + "…" : path);
  } catch {
    return uri;
  }
}

type Needs = { sources: string[]; pages: string[]; memories: string[]; chunks: number[] };
const placeholders = (n: number) => Array(n).fill("?").join(",");

/** Add a reader-facing form to each hit (see HitDisplay). One batch of lookups, no ranking. */
export function presentHits(app: App, hits: Hit[], query: string): PresentedHit[] {
  const needles = highlightTerms(query);
  const need: Needs = { sources: [], pages: [], memories: [], chunks: [] };
  for (const h of hits) {
    if (h.type === "chunk") need.chunks.push(Number(h.id));
    if (h.sourceId) need.sources.push(h.sourceId);
    if (h.type === "page") need.pages.push(h.id);
    if (h.type === "memory") need.memories.push(h.id);
  }
  const chunkText = new Map<string, string>();
  if (need.chunks.length) for (const r of all<{ id: number; text: string }>(app.db, `select id, text from chunks where id in (${placeholders(need.chunks.length)})`, ...need.chunks)) chunkText.set(String(r.id), r.text);
  const sourceMeta = new Map<string, Record<string, unknown>>();
  const uniq = [...new Set(need.sources)];
  if (uniq.length) for (const r of all<{ id: string; meta: string }>(app.db, `select id, meta from sources where id in (${placeholders(uniq.length)})`, ...uniq)) sourceMeta.set(r.id, json(r.meta, {}));
  const pageText = new Map<string, { summary: string; body: string }>();
  if (need.pages.length) for (const r of all<{ id: string; summary: string; body: string }>(app.db, `select id, summary, body from pages where id in (${placeholders(need.pages.length)})`, ...need.pages)) pageText.set(r.id, r);
  const memText = new Map<string, string>();
  if (need.memories.length) for (const r of all<{ id: string; content: string }>(app.db, `select id, content from memories where id in (${placeholders(need.memories.length)})`, ...need.memories)) memText.set(r.id, r.content);

  return hits.map((h) => {
    let raw = h.snippet;
    let place = "";
    let title = h.title;
    if (h.type === "chunk") {
      raw = chunkText.get(h.id) ?? h.snippet;
      const meta = h.sourceId ? sourceMeta.get(h.sourceId) : undefined;
      const wiki = [meta?.wikiSpaceName, meta?.wikiPath].filter((x): x is string => typeof x === "string" && !!x).join(" / ");
      const heading = h.path && h.path !== h.title ? h.path : "";
      place = [wiki, heading].filter(Boolean).join(" · ");
      if (!title) title = h.uri ?? "";
    } else if (h.type === "page") {
      const p = pageText.get(h.id);
      if (p) {
        const fromSummary = excerpt(p.summary, needles);
        raw = fromSummary.marks.length || !p.body ? p.summary : p.body;
        if (!raw.trim()) raw = p.body;
      }
      place = h.path.includes("/") ? h.path.slice(0, h.path.lastIndexOf("/")) : "";
    } else if (h.type === "memory") {
      raw = memText.get(h.id) ?? h.snippet;
      place = h.path;
      title = h.title || "记忆";
    } else if (h.type === "symbol") {
      place = h.path;
    }
    const e = excerpt(raw, needles);
    const plainTitle = plainText(title);
    return { ...h, display: { title: plainTitle, titleMarks: markRanges(plainTitle, needles), text: e.text, marks: e.marks, place, link: shortLink(h.uri) } };
  });
}
