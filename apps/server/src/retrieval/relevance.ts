/** ICU word segmentation keeps Chinese concepts intact instead of matching
 * every overlapping character pair. Identifiers remain exact substrings. */
const segmenter = new Intl.Segmenter("zh", { granularity: "word" });
const stop = new Set("我 你 他 她 它 的 了 是 在 和 与 或 把 被 对 以 为 中 上 下 到 后 前 以后 之前 之后 这个 那个 什么 怎么 怎样 如何 为什么 哪些 现在 已经 可以 应该 需要 一个 一些 进行 使用 通过 让 自己 the a an of to is are how what why and or for in on with does do can should".split(" "));
export function queryTerms(text: string): string[] {
  const ascii = text.match(/[A-Za-z0-9_$][A-Za-z0-9_$.-]*/g) ?? [];
  const chinese = [...segmenter.segment(text.replace(/[A-Za-z0-9_$.-]+/g, " "))]
    .filter(s => s.isWordLike).map(s => s.segment);
  const literal = text.trim().replace(/[？?。！!]$/u, "");
  // ICU splits some domain compounds (e.g. 重试). Preserve short literal
  // lookups alongside segmented words without reintroducing sentence bigrams.
  const compound = /^[\p{Script=Han}]{2,8}$/u.test(literal) && !stop.has(literal) ? [literal] : [];
  return [...new Set([...ascii, ...chinese, ...compound].map(s => s.toLowerCase()).filter(s => s.length >= 2 && !stop.has(s)))];
}
export function exactLookup(text: string): boolean {
  return /^[A-Za-z_$][\w$./\\-]*$/.test(text.trim());
}
/** Explicit code spelling, rather than every English word in a question.
 * Quotes allow otherwise ambiguous names such as `apply`; a bare lookup does too.
 * These are navigation candidates, not a claim that the symbol answers the query. */
export function querySymbols(text: string): string[] {
  const names = text.match(/[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/g) ?? [];
  const quoted = [
    ...text.matchAll(
      /[`"'“‘]([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)[`"'”’]/g,
    ),
  ].map((m) => m[1]!.toLowerCase());
  const terms = new Set(
    queryTerms(text).map((term) => term.replace(/\.+$/, "")),
  );
  return [
    ...new Set(
      names
        .filter(
          (name) =>
            terms.has(name.toLowerCase()) &&
            (exactLookup(text) ||
              // Capitalized prose (Markdown) and acronyms (JSON) are not
              // operation names unless explicitly quoted or searched alone.
              /[a-z\d][A-Z]|[_$.]/.test(name) ||
              quoted.includes(name.toLowerCase())),
        )
        .map((name) => name.toLowerCase()),
    ),
  ];
}
export function relevance(text: string, terms: string[], title = "", weights?: Map<string, number>) {
  const lower = text.toLowerCase(), heading = title.toLowerCase();
  const matched = terms.filter(t => lower.includes(t));
  const titleMatched = terms.filter(t => heading.includes(t));
  // A file title alone is not a reason to return all its fragments.
  const required = terms.length <= 2 ? 1 : Math.min(3, Math.ceil(terms.length / 3));
  if (matched.length < required) return 0;
  const weight = (ts: string[]) => ts.reduce((sum,t) => sum + (weights?.get(t) ?? 1),0);
  const total = weight(terms), coverage = weight(matched) / total;
  return coverage * coverage + weight(titleMatched) / total * .15;
}
export function bestSnippet(text: string, terms: string[], size = 300) {
  const lower = text.toLowerCase();
  const offsets = terms.flatMap(t => {
    const out: number[] = [];
    for (let i = lower.indexOf(t); i >= 0 && out.length < 30; i = lower.indexOf(t, i + t.length)) out.push(i);
    return out;
  });
  let start = 0, best = -1;
  for (const offset of [0, ...offsets]) {
    const candidate = Math.max(0, offset - 60);
    const score = terms.filter(t => lower.slice(candidate, candidate + size).includes(t)).length;
    if (score > best) { best = score; start = candidate; }
  }
  return (start ? "…" : "") + text.slice(start, start + size).trim();
}
