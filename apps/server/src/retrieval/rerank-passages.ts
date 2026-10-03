import { bestSnippet, querySymbols, queryTerms } from "./relevance.js";

/** Score at most two local passages per unit (lexical and dense), then take
 * their maximum. A long function must not be represented by its prefix alone.
 * These excerpts only rank; the fixed full unit remains available for reading. */
export function rerankPassages(
  text: string,
  query: string,
  denseExcerpt?: string,
  concepts: { label: string; aliases: string[] }[] = [],
) {
  if (text.length <= 800) return [text];
  const symbols = new Set(querySymbols(query));
  const terms = queryTerms(query).filter((t) => !symbols.has(t));
  // Formal, range-bound concepts bridge Chinese questions to code spelling.
  // Merely carrying their labels in the context cannot locate a later branch.
  const aliases = concepts
    .filter((c) =>
      queryTerms(c.label + " " + c.aliases.join(" ")).some((t) =>
        terms.includes(t),
      ),
    )
    .flatMap((c) => c.aliases.map((a) => a.toLowerCase()));
  const anchors = [...new Set(aliases)].filter((a) =>
    text.toLowerCase().includes(a),
  );
  // A bound alias is the bridge to the operation. Generic Chinese words in a
  // notification or comment must not outvote that bridge merely by being more numerous.
  const lexical = bestSnippet(
    text,
    anchors.length ? anchors : terms,
    800,
  ).replace(/^…/, "");
  const ranges: { start: number; end: number }[] = [];
  if (denseExcerpt) {
    const offset = text.indexOf(denseExcerpt);
    if (offset >= 0) {
      const start = Math.max(0, offset - 120);
      ranges.push({ start, end: Math.min(text.length, start + 800) });
    }
  }
  const start = Math.max(0, text.indexOf(lexical));
  const candidate = { start, end: Math.min(text.length, start + 800) };
  if (
    !ranges.some(
      (r) =>
        Math.max(
          0,
          Math.min(r.end, candidate.end) - Math.max(r.start, candidate.start),
        ) >=
        Math.min(r.end - r.start, candidate.end - candidate.start) * 0.75,
    )
  )
    ranges.push(candidate);
  return ranges.map((r) => text.slice(r.start, r.end));
}
