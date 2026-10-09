import { bestSnippet, querySymbols, queryTerms } from "./relevance.js";

/** Score bounded local passages per unit (lexical and matched ranges), then take
 * their maximum. A long function must not be represented by its prefix alone.
 * These excerpts only rank; the fixed full unit remains available for reading. */
export function rerankPassages(
  text: string,
  query: string,
  denseExcerpt?: string,
  concepts: { label: string; aliases: string[] }[] = [],
  matchedRanges: { start: number; end: number }[] = [],
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
  const matched = matchedRanges.length
    ? matchedRanges
    : denseExcerpt && text.includes(denseExcerpt)
      ? [
          {
            start: text.indexOf(denseExcerpt),
            end: text.indexOf(denseExcerpt) + denseExcerpt.length,
          },
        ]
      : [];
  const windows = matched.flatMap((range) => {
    const start = Math.max(0, range.start - 120),
      end = Math.min(text.length, range.end + 120);
    const result: { start: number; end: number }[] = [];
    for (let offset = start; offset < end; offset += 640) {
      result.push({ start: offset, end: Math.min(end, offset + 800) });
      if (offset + 800 >= end) break;
    }
    return result;
  });
  // Cover the whole match when it fits. For oversized matches, spread a bounded
  // sample across the range including its tail rather than taking its prefix.
  const selected =
    windows.length <= 5
      ? windows
      : Array.from(
          { length: 5 },
          (_, i) => windows[Math.round((i * (windows.length - 1)) / 4)]!,
        );
  ranges.push(
    ...selected.filter(
      (r, i, all) =>
        all.findIndex((x) => x.start === r.start && x.end === r.end) === i,
    ),
  );
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
