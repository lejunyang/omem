/** Query alternatives are reading leads supplied by the investigating Agent.
 * They never replace the question or acquire separate votes for the same route. */
export function recallQueries(text: string, variants?: string[]): string[] {
  const queries = [text], seen = new Set([text.trim().normalize("NFKC").toLowerCase()]);
  for (const variant of variants ?? []) {
    const clean = variant.trim(), key = clean.normalize("NFKC").toLowerCase();
    if (!clean || clean.length > 400 || seen.has(key)) continue;
    seen.add(key); queries.push(clean);
    if (queries.length === 4) break;
  }
  return queries;
}

type Recalled = {
  unit: {id: string}; score: number; routes: string[];
  routeRanks?: Record<string, number>;
  matchedRanges?: {start: number; end: number}[];
};

/** Best rank within each route across query forms; ordinary RRF across routes.
 * Every independently admitted candidate survives until the normal selection. */
export function mergeQueryRecall<T extends Recalled>(branches: T[][]): T[] {
  const merged = new Map<string, T>();
  for (const branch of branches) branch.forEach((hit, index) => {
    const prior = merged.get(hit.unit.id);
    const ranks = hit.routeRanks ?? Object.fromEntries(hit.routes.map(route => [route, index]));
    const routeRanks = {...prior?.routeRanks};
    for (const [route, rank] of Object.entries(ranks))
      routeRanks[route] = Math.min(routeRanks[route] ?? Infinity, rank);
    const better = !prior || Math.min(...Object.values(ranks)) < Math.min(...Object.values(prior.routeRanks!));
    const matchedRanges = [...(prior?.matchedRanges ?? []), ...(hit.matchedRanges ?? [])]
      .filter((range, i, all) => all.findIndex(r => r.start === range.start && r.end === range.end) === i);
    merged.set(hit.unit.id, {
      ...(better ? hit : prior!), routeRanks, matchedRanges,
      routes: [...new Set([...(prior?.routes ?? []), ...hit.routes])],
      score: Object.values(routeRanks).reduce((sum, rank) => sum + 1 / (60 + rank + 1), 0),
    });
  });
  return [...merged.values()].sort((a,b) => b.score - a.score);
}
