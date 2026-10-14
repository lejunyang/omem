import { extname } from "node:path";
import { parseCode, type CodeOutline } from "./code.ts";

export type Chunk = {
  kind: "section" | "symbol" | "window" | "message" | "file";
  title: string;
  path: string;
  lineStart: number;
  lineEnd: number;
  text: string;
};

const MAX_CHUNK = 2400;
const TARGET = 1400;

/** Split a line range (0-based, inclusive) into windows near TARGET chars, preferring blank-line breaks. */
function windows(lines: string[], start: number, end: number, base: Omit<Chunk, "lineStart" | "lineEnd" | "text">): Chunk[] {
  const out: Chunk[] = [];
  let from = start;
  let size = 0;
  for (let i = start; i <= end; i++) {
    size += lines[i].length + 1;
    const atBreak = !lines[i].trim();
    if ((size >= TARGET && atBreak) || size >= MAX_CHUNK || i === end) {
      const text = lines.slice(from, i + 1).join("\n");
      if (text.trim()) out.push({ ...base, lineStart: from + 1, lineEnd: i + 1, text });
      from = i + 1;
      size = 0;
    }
  }
  return out;
}

export function chunkMarkdown(text: string, title: string): Chunk[] {
  const lines = text.split("\n");
  const heads: { line: number; level: number; title: string }[] = [];
  let fence = false;
  lines.forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (fence) return;
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) heads.push({ line: i, level: m[1].length, title: m[2] });
  });
  const out: Chunk[] = [];
  const stack: { level: number; title: string }[] = [];
  const bounds = [{ line: 0, level: 0, title: "" }, ...heads];
  for (let h = 0; h < bounds.length; h++) {
    const head = bounds[h];
    const end = (h + 1 < bounds.length ? bounds[h + 1].line : lines.length) - 1;
    if (head.level) {
      while (stack.length && stack[stack.length - 1].level >= head.level) stack.pop();
      stack.push({ level: head.level, title: head.title });
    }
    if (end < head.line) continue;
    const path = stack.map((s) => s.title).join(" / ");
    const base = { kind: "section" as const, title: head.title || title, path };
    out.push(...windows(lines, head.line, end, base));
  }
  return out;
}

export function chunkPlain(text: string, title: string): Chunk[] {
  const lines = text.split("\n");
  if (!lines.length) return [];
  return windows(lines, 0, lines.length - 1, { kind: "window", title, path: "" });
}

/** Chat transcripts: one line per message, "[time] speaker: text". Windows keep turns together. */
export function chunkChat(text: string, title: string): Chunk[] {
  const lines = text.split("\n");
  const out: Chunk[] = [];
  const PER = 24;
  for (let i = 0; i < lines.length; i += PER - 4) {
    const end = Math.min(lines.length - 1, i + PER - 1);
    const body = lines.slice(i, end + 1).join("\n");
    if (body.trim()) out.push({ kind: "message", title, path: "", lineStart: i + 1, lineEnd: end + 1, text: body });
    if (end === lines.length - 1) break;
  }
  return out;
}

export function chunkCode(path: string, text: string): { chunks: Chunk[]; outline: CodeOutline } {
  const outline = parseCode(path, text);
  const lines = text.split("\n");
  const out: Chunk[] = [];
  const covered = new Array<boolean>(lines.length).fill(false);
  // Symbol chunks: top-level declarations (classes are split into members when large).
  for (const s of outline.symbols) {
    if (s.parent && outline.symbols.find((p) => p.qname === s.parent && p.lineEnd - p.lineStart < 120)) continue;
    const isBigContainer = outline.symbols.some((c) => c.parent === s.qname) && s.lineEnd - s.lineStart >= 120;
    if (isBigContainer) continue;
    const start = s.docStart ?? s.lineStart;
    const base = { kind: "symbol" as const, title: s.qname, path: `${path}#${s.qname}` };
    const pieces = windows(lines, start - 1, s.lineEnd - 1, base);
    for (const p of pieces) out.push(p);
    for (let i = start - 1; i < s.lineEnd; i++) covered[i] = true;
  }
  // Remaining lines (imports, top-level statements, templates) as file windows.
  let i = 0;
  while (i < lines.length) {
    if (covered[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < lines.length && !covered[j + 1]) j++;
    const slice = lines.slice(i, j + 1).join("\n");
    if (slice.trim()) out.push(...windows(lines, i, j, { kind: "file", title: path, path }));
    i = j + 1;
  }
  out.sort((a, b) => a.lineStart - b.lineStart);
  return { chunks: out, outline };
}

const CODE_EXT = new Set([
  ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte", ".py", ".go", ".rs", ".java", ".kt", ".kts", ".swift", ".c", ".h", ".cc", ".cpp", ".hpp", ".cs", ".rb", ".php", ".lua", ".scala", ".sh", ".bash", ".ps1", ".sql", ".dart", ".m", ".mm", ".zig", ".ex", ".exs", ".erl", ".hs", ".clj",
  ".cxx", ".hh", ".hxx", ".sc", ".ml", ".mli", ".res", ".resi", ".sol", ".el", ".elm", ".ocaml", ".fs", ".r", ".jl", ".nim", ".v", ".groovy",
]);
const CONFIG_EXT = new Set([".json", ".toml", ".yaml", ".yml", ".xml", ".ini", ".gradle", ".properties", ".css", ".scss", ".less", ".html"]);

export function classify(path: string): "code" | "doc" | "config" {
  const ext = extname(path).toLowerCase();
  if (CODE_EXT.has(ext)) return "code";
  if (CONFIG_EXT.has(ext) || /(^|\/)(Dockerfile|Makefile|\.env\.example)$/.test(path)) return "config";
  return "doc";
}

export function chunkSource(kind: string, uri: string, title: string, text: string): { chunks: Chunk[]; outline?: CodeOutline } {
  if (kind === "code") {
    const kindOf = classify(uri);
    if (kindOf === "code") return chunkCode(uri, text);
    return { chunks: chunkPlain(text, title).map((c) => ({ ...c, kind: "file", path: uri })) };
  }
  if (kind === "chat") return { chunks: chunkChat(text, title) };
  if (/\.(md|markdown|mdx)$/i.test(uri) || /^#{1,6}\s/m.test(text)) return { chunks: chunkMarkdown(text, title) };
  return { chunks: chunkPlain(text, title) };
}
