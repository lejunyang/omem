/**
 * How a plugin's parser asked a source to be shown (src/plugins/formats.ts `display`, kept in
 * `source.meta.display`): a table whose rows are line ranges of the text, or records with a title
 * and a line range each. The text stays the one thing cited: every row keeps its lines.
 */
export type Lines = [number, number];
export type SourceDisplay =
  | { kind: "table"; columns: string[]; rowLines: Lines[] }
  | { kind: "records"; items: { title: string; lines: Lines }[] };

const isLines = (v: unknown): v is Lines =>
  Array.isArray(v) && v.length === 2 && v.every((n) => Number.isInteger(n) && n > 0) && v[1] >= v[0];

/** The display of a source read by a parser, or null (missing, or not a shape this page knows). */
export function sourceDisplay(meta: Record<string, unknown> | null | undefined): SourceDisplay | null {
  const d = meta?.parser ? (meta.display as Record<string, unknown> | undefined) : undefined;
  if (!d || typeof d !== "object") return null;
  if (d.kind === "table" && Array.isArray(d.columns) && d.columns.length && Array.isArray(d.rowLines) && d.rowLines.every(isLines))
    return { kind: "table", columns: d.columns.map(String), rowLines: d.rowLines as Lines[] };
  if (d.kind === "records" && Array.isArray(d.items) && d.items.every((i) => i && typeof i === "object" && isLines((i as { lines?: unknown }).lines)))
    return { kind: "records", items: (d.items as { title?: unknown; lines: Lines }[]).map((i) => ({ title: String(i.title ?? ""), lines: i.lines })) };
  return null;
}

/** Lines `from`–`to` (1-based, inclusive) of a text whose first line is line `start`. */
export function linesOf(text: string, start: number, [from, to]: Lines) {
  const all = text.split("\n");
  return all.slice(Math.max(0, from - start), Math.max(0, to - start + 1));
}

/** A record's text under its title: the lines it covers, without a first line that only repeats the title. */
export function recordBody(text: string, start: number, item: { title: string; lines: Lines }) {
  const lines = linesOf(text, start, item.lines);
  if (lines.length > 1 && lines[0].replace(/^#+\s*/, "").trim() === item.title.trim()) lines.shift();
  return lines.join("\n");
}

const pipeRow = /^\s*\|(.*)\|\s*$/;
const unescapePipe = (s: string) => s.replace(/\\\|/g, "|").trim();
/** One Markdown table line `| a | b |` into its cells (escaped `\|` stays in the cell). */
function pipeCells(line: string) {
  const inner = line.match(pipeRow)?.[1];
  return inner === undefined ? null : inner.split(/(?<!\\)\|/).map(unescapePipe);
}

/**
 * A row's lines as cells under `columns`. Parsers write the row as Markdown, and the page cannot know
 * how; it tries, in order: one Markdown table line, `列名：值` lines naming the columns, one line per
 * column, one tab-separated line. Anything else is the whole text in the first cell.
 */
export function rowCells(lines: string[], columns: string[]): string[] {
  const kept = lines.filter((l) => l.trim() && !/^\s*\|?\s*:?-{3,}/.test(l));
  const pad = (cells: string[]) => columns.map((_, i) => cells[i] ?? "");
  if (kept.length === 1) {
    const cells = pipeCells(kept[0]);
    if (cells) return pad(cells);
  }
  const named = new Map<string, string>();
  for (const l of kept) {
    const m = l.match(/^\s*(?:[-*]\s+)?(?:\*\*)?([^:：*]{1,64}?)(?:\*\*)?\s*[:：]\s*(.*)$/);
    if (m && columns.includes(m[1].trim())) named.set(m[1].trim(), m[2].trim());
  }
  if (named.size && named.size >= Math.min(columns.length, kept.length)) return columns.map((c) => named.get(c) ?? "");
  if (kept.length === columns.length && columns.length > 1) return kept.map((l) => l.trim());
  if (kept.length === 1 && kept[0].includes("\t")) return pad(kept[0].split("\t").map((c) => c.trim()));
  return pad([kept.map((l) => l.trim()).join(" ")]);
}

export type TableRow = { key: number; lines: Lines; cells: string[] };
/** The table's rows in the order the parser gave them, each with its cells and lines. */
export function tableRows(text: string, start: number, display: Extract<SourceDisplay, { kind: "table" }>): TableRow[] {
  const all = text.split("\n");
  return display.rowLines.map((lines, key) => ({ key, lines, cells: rowCells(all.slice(Math.max(0, lines[0] - start), Math.max(0, lines[1] - start + 1)), display.columns) }));
}

/** Whether a row's lines meet a cited range. */
export const overlaps = ([a, b]: Lines, from: number, to: number) => a <= to && b >= from;
/** The first row or record that a cited range falls in, or -1. */
export function firstOverlap(ranges: Lines[], from: number, to: number) {
  return ranges.findIndex((r) => overlaps(r, from, to));
}
/** “第 3 行” or “第 3–5 行”, as the page writes a range. */
export const linesLabel = ([a, b]: Lines) => (a === b ? `第 ${a} 行` : `第 ${a}–${b} 行`);
/** The citation for a range of a source: `src:<id>#L起-L止`. */
export const citeRef = (id: string, [a, b]: Lines) => `src:${id}#L${a}-L${b}`;
