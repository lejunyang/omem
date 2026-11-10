/**
 * Markdown as Feishu renders it. Card Markdown (and the `md` of a post) follows CommonMark's rule for
 * `**`: a closing `**` right after punctuation only closes when whitespace or punctuation follows it, and
 * an opening `**` right before punctuation only opens after whitespace or punctuation. Chinese text breaks
 * this all the time — `**建议：**先查日志`, `查了**（北京时间）**的日志`, `如**「标题」**所示` — and the
 * reader sees the asterisks. Every Feishu send path (lark-send.ts, the owner's `/ai` reply) passes its
 * Markdown through here, so a bold that would not render is rewritten into one that does:
 *
 * - spaces just inside the markers go (`** 结论 **` → `**结论**`);
 * - clause punctuation at the end of the bold moves out (`**建议：**先` → `**建议**：先`);
 * - otherwise a space goes on the outer side (`**（北京时间）**的` → `**（北京时间）** 的`).
 *
 * A bold that already renders is left exactly as it is. Code (fenced or inline) is never touched.
 */

const PUNCT = /[\p{P}\p{S}]/u;
const SPACE = /\s/u;
/** Punctuation that ends a clause: moved out of the bold rather than padded with a space. */
const TRAILING = new Set([..."：:，,。；;！!？?、"]);
const CODE = /```[\s\S]*?(?:```|$)|`[^`\n]*`/g;
/** Code stands in as one private-use character while bold is fixed; it starts and ends with a backtick, so it counts as punctuation. */
const HOLE = 0xe000;
const isHole = (c: string | undefined) => c !== undefined && c.charCodeAt(0) >= HOLE && c.charCodeAt(0) < 0xf900;

const isSpace = (c: string | undefined) => c === undefined || SPACE.test(c);
const isPunct = (c: string | undefined) => c !== undefined && (PUNCT.test(c) || isHole(c));

/** `**` runs of exactly two asterisks (a third makes it something else: leave it alone). */
function markers(line: string): number[] {
  const at: number[] = [];
  for (let i = 0; i < line.length - 1; i++) {
    if (line[i] !== "*" || line[i + 1] !== "*") continue;
    let j = i;
    while (line[j] === "*") j++;
    if (j - i === 2 && line[i - 1] !== "\\") at.push(i);
    i = j - 1;
  }
  return at;
}

function fixLine(line: string): string {
  const at = markers(line);
  if (at.length < 2) return line;
  let out = "";
  let last = 0;
  for (let k = 0; k + 1 < at.length; k += 2) {
    const open = at[k];
    const close = at[k + 1];
    let inner = line.slice(open + 2, close);
    if (!inner.trim()) continue;
    const before = line[open - 1];
    const after = line[close + 2];
    let lead = "";
    let tail = "";
    // `** 结论 **`: spaces inside the markers never render as bold; they go.
    inner = inner.trim();
    // Opening: punctuation inside with a letter right before the markers.
    if (isPunct(inner[0]) && !isSpace(before) && !isPunct(before)) lead = " ";
    // Closing: punctuation inside with a letter right after the markers.
    let moved = "";
    if (isPunct(inner.at(-1)) && !isSpace(after) && !isPunct(after)) {
      while (inner.length > 1 && TRAILING.has(inner.at(-1)!)) {
        moved = inner.at(-1)! + moved;
        inner = inner.slice(0, -1);
      }
      // What is left still ends in punctuation (a bracket or a quote): pad instead.
      if (isPunct(inner.at(-1))) {
        inner += moved;
        moved = "";
        tail = " ";
      }
    }
    out += `${line.slice(last, open)}${lead}**${inner}**${moved}${tail}`;
    last = close + 2;
  }
  return out + line.slice(last);
}

/** One Markdown text with every bold written so Feishu renders it. */
export function larkMarkdown(md: string): string {
  // Private-use characters stand in for code below: text that has its own is left as it is.
  if (!md || !md.includes("**") || /[-]/.test(md)) return md;
  const code: string[] = [];
  const masked = md.replace(CODE, (c) => (code.length >= 0xf900 - HOLE ? c : String.fromCharCode(HOLE + code.push(c) - 1)));
  if (!masked.includes("**")) return md;
  return masked
    .split("\n")
    .map(fixLine)
    .join("\n")
    .replace(/[-]/g, (c) => code[c.charCodeAt(0) - HOLE] ?? c);
}

/** The same for every Markdown element of a card (callback values and other protocol data stay as they are). */
export function larkCardMarkdown<T>(card: T): T {
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (!value || typeof value !== "object") return value;
    const node = value as Record<string, unknown>;
    const text = node.tag === "markdown" || node.tag === "lark_md";
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, text && k === "content" && typeof v === "string" ? larkMarkdown(v) : k === "value" ? v : walk(v)]));
  };
  return walk(card) as T;
}
