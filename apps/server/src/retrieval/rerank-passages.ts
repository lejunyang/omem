import { bestSnippet, querySymbols, queryTerms } from "./relevance.js";
import type { RetrievalUnit } from "./units.js";

/** Score bounded local passages per unit (lexical and matched ranges), then take
 * their maximum. A long function must not be represented by its prefix alone.
 * These excerpts only rank; the fixed full unit remains available for reading. */
function passageRanges(
  text: string,
  query: string,
  denseExcerpt?: string,
  concepts: { label: string; aliases: string[] }[] = [],
  matchedRanges: { start: number; end: number }[] = [],
  size = 800,
) {
  if (text.length <= size) return [{start:0,end:text.length}];
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
    size,
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
    for (let offset = start; offset < end; offset += Math.floor(size * 0.8)) {
      result.push({ start: offset, end: Math.min(end, offset + size) });
      if (offset + size >= end) break;
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
  const candidate = { start, end: Math.min(text.length, start + size) };
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
  return ranges;
}

export function rerankPassages(text:string,query:string,denseExcerpt?:string,concepts:{label:string;aliases:string[]}[]=[],matchedRanges:{start:number;end:number}[]=[]) {
  return passageRanges(text,query,denseExcerpt,concepts,matchedRanges).map(r=>text.slice(r.start,r.end));
}

/** Hints belong only to the original range they describe. They are retrieval
 * metadata, never a replacement for implementation bytes or factual evidence. */
export function scoringPassages(unit: RetrievalUnit, query: string, excerpt?: string,
  matches: { start: number; end: number }[] = []) {
  const baseLine = unit.target.kind === "source" ? unit.target.startLine : 1;
  const concepts = (unit.materialDescription?.description.concepts ?? [])
    .filter(c => unit.target.kind === "source" && c.startLine <= unit.target.endLine && c.endLine >= baseLine);
  const lines = unit.text.split("\n");
  const offset = (line: number) => line <= baseLine ? 0 : lines.slice(0, line - baseLine).join("\n").length + 1;
  const terms = new Set(queryTerms(query));
  const relevant = concepts.filter(c => queryTerms([c.label, ...c.aliases].join(" ")).some(t => terms.has(t)));
  const anchors = relevant.map(c => ({start:offset(c.startLine),end:Math.min(unit.text.length, offset(c.endLine + 1) - 1)}));
  // Bound work by passages, but put known matched implementations before generic
  // word overlap. Keep range positions so the winning input can be read verbatim.
  return passageRanges(unit.text, query, excerpt, relevant, [...anchors, ...matches], 1600).map(({start,end}) => {
    const text=unit.text.slice(start,end);
    const local = concepts.filter(c => offset(c.startLine) < end && offset(c.endLine + 1) > start);
    const heading = unit.headingPath.at(-1) ?? unit.title;
    const context = [heading.slice(0, 120), ...local.slice(0, 2).map(c => `检索概念（需核对原文）：${c.label}`)].join("\n");
    return {text,start,end,context};
  });
}
