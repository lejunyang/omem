/**
 * Index-time and query-time term generation for SQLite FTS5 (unicode61).
 *
 * unicode61 already splits Latin text on punctuation and folds case, but it keeps
 * a whole run of CJK characters as one token and never splits camelCase. We
 * therefore pre-process text into explicit terms:
 *  - CJK runs → overlapping bigrams (the classic CJK analyzer; robust without a
 *    dictionary, handles 2-character words that a trigram index misses);
 *  - identifiers → the identifier plus its camelCase / digit parts.
 */
const CJK = /[㐀-䶿一-鿿豈-﫿぀-ヿ가-힯]/;
const SEGMENT = /([㐀-䶿一-鿿豈-﫿぀-ヿ가-힯]+)|([\p{L}\p{N}_$]+)/gu;

function cjkTerms(run: string, out: string[]) {
  const chars = [...run];
  if (chars.length === 1) {
    out.push(chars[0]);
    return;
  }
  for (let i = 0; i < chars.length - 1; i++) out.push(chars[i] + chars[i + 1]);
}

function wordTerms(word: string, out: string[]) {
  const lower = word.toLowerCase();
  const parts = word
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-zA-Z])(\d)/g, "$1 $2")
    .split(/[\s_$]+/)
    .map((p) => p.toLowerCase())
    .filter(Boolean);
  const joined = lower.replace(/[_$]/g, "");
  if (joined) out.push(joined);
  if (parts.length > 1) for (const p of parts) out.push(p);
}

export function terms(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(SEGMENT)) {
    if (match[1]) cjkTerms(match[1], out);
    else if (match[2]) wordTerms(match[2], out);
  }
  return out;
}

export function indexText(text: string): string {
  return terms(text).join(" ");
}

const STOP = new Set([
  "the", "a", "an", "of", "to", "in", "is", "are", "and", "or", "for", "on", "how", "what", "why", "does", "do", "where", "which", "when", "it", "this", "that", "with", "be", "can", "i", "we",
  "什么", "怎么", "如何", "哪里", "哪些", "为什么", "是否", "一下", "我们", "你们", "他们", "这个", "那个", "之前", "现在", "的是", "是什", "么时", "时候", "可以", "需要", "有没", "没有",
]);

/** Build an FTS5 MATCH expression (OR of distinct quoted terms), or null if empty. */
export function matchQuery(query: string): string | null {
  const unique = [...new Set(terms(query))].filter((t) => !STOP.has(t));
  const chosen = unique.length ? unique : [...new Set(terms(query))];
  if (!chosen.length) return null;
  return chosen
    .slice(0, 64)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(" OR ");
}

export function hasCjk(text: string) {
  return CJK.test(text);
}
