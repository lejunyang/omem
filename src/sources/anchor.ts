import { sha256 } from "../core/util.ts";

/**
 * Anchoring a note to the passage it marks, not only to line numbers: documents are read again and
 * their lines move. A note keeps `quote` (the passage, whitespace collapsed, first 200 characters) and
 * `quote_hash` (the whole passage, each line trimmed). When the text changes, the passage is looked
 * for in the new text (`locate`): the same lines nearest to where it was; failing that, a window that
 * starts with the quote. Not found: the note is stale (left out of ranking, listed for review).
 */

const norm = (line: string) => line.trim().replace(/\s+/g, " ");

/** Lines a..b (1-based, inclusive) of a text. */
export function passageOf(text: string, a: number, b: number) {
  return text.split("\n").slice(a - 1, b).join("\n");
}
export const quoteOf = (passage: string) => passage.replace(/\s+/g, " ").trim().slice(0, 200);
export const hashOf = (passage: string) => sha256(passage.split("\n").map(norm).join("\n"));

/** Where a passage of `len` lines is in `text`, nearest to line `near`; null when it is gone. */
export function locate(text: string, opts: { hash?: string | null; quote?: string | null; len: number; near: number }): { lineStart: number; lineEnd: number } | null {
  const lines = text.split("\n").map(norm);
  const len = Math.max(1, opts.len);
  const quote = opts.quote ? opts.quote.replace(/\s+/g, " ").trim() : "";
  const startsLike = (i: number) => {
    if (!quote) return true;
    const l = lines[i];
    return l.length >= quote.length ? l.startsWith(quote) : quote.startsWith(l);
  };
  let best: number | null = null;
  const closer = (i: number) => best === null || Math.abs(i - opts.near) < Math.abs(best - opts.near);
  if (opts.hash)
    for (let i = 0; i + len <= lines.length; i++) {
      if (!startsLike(i) || !closer(i + 1)) continue;
      if (sha256(lines.slice(i, i + len).join("\n")) === opts.hash) best = i + 1;
    }
  // The passage itself changed but still begins the same way (only with a quote long enough to be specific).
  if (best === null && quote.length >= 20)
    for (let i = 0; i < lines.length; i++) {
      if (!closer(i + 1)) continue;
      if (!lines[i]) continue;
      const window = lines.slice(i, i + len + 3).join(" ").replace(/\s+/g, " ").trim();
      if (window.startsWith(quote)) best = i + 1;
    }
  return best === null ? null : { lineStart: best, lineEnd: Math.min(lines.length, best + len - 1) };
}
