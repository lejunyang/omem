import { Lexer } from "marked";

/** Block-level HTML that wraps Markdown in documents (Feishu callouts and column grids, details, tables). */
const CONTAINER = /<(\/?)(div|blockquote|table|details|section)\b[^>]*?(\/?)>/gi;

/** How far an HTML block opens (+) or closes (−) the containers around the Markdown that follows it. */
function depthChange(html: string) {
  let n = 0;
  for (const m of html.matchAll(CONTAINER)) if (!m[3]) n += m[1] ? -1 : 1;
  return n;
}

/**
 * Keep Markdown blocks intact when highlighting a citation inside a table, list or code block; a citation
 * inside an HTML container (a Feishu callout or column grid) takes the whole container, so neither side is
 * left with half of it.
 */
export function citedDocumentParts(text: string, start: number, from?: number, to = from) {
  if (!from) return { before: text, cited: "", after: "" };
  const normalized = text.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  const offset = (line: number) => lines.slice(0, Math.max(0, Math.min(lines.length, line - start))).reduce((n, l) => n + l.length + 1, 0);
  const a = Math.min(normalized.length, offset(from));
  const b = Math.min(normalized.length, offset((to ?? from) + 1));
  let at = 0;
  let first = a;
  let last = b;
  let depth = 0;
  // Offsets where no container is open: the only places the text can be cut.
  const open: number[] = [0];
  for (const token of Lexer.lex(normalized, { gfm: true })) {
    const end = at + token.raw.length;
    if (token.type !== "space" && at < b && end > a) {
      first = Math.min(first, at);
      last = Math.max(last, end);
    }
    // A window that starts inside a container sees its close first; that counts as level ground.
    if (token.type === "html") depth = Math.max(0, depth + depthChange(token.raw));
    if (depth === 0) open.push(end);
    at = end;
  }
  if (first < last) {
    first = open.filter((o) => o <= first).pop() ?? 0;
    last = open.find((o) => o >= last) ?? normalized.length;
  }
  return { before: normalized.slice(0, first), cited: normalized.slice(first, last), after: normalized.slice(last) };
}
