import { Lexer } from "marked";

/** Keep Markdown blocks intact when highlighting a citation inside a table, list or code block. */
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
  for (const token of Lexer.lex(normalized, { gfm: true })) {
    const end = at + token.raw.length;
    if (token.type !== "space" && at < b && end > a) {
      first = Math.min(first, at);
      last = Math.max(last, end);
    }
    at = end;
  }
  return { before: normalized.slice(0, first), cited: normalized.slice(first, last), after: normalized.slice(last) };
}
