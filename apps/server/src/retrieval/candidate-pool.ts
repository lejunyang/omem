/** Bound model work after covering query/route frontiers. This is
 * admission, not relevance scoring; candidates outside the pool stay available. */
export function candidatePool<
  T extends {
    id: string;
    score: number;
    routes: string[];
    routeRanks?: Record<string, number>;
    recallRanks?: Record<string, number>;
  },
>(hits: T[], limit: number): T[] {
  const ordered = [...hits].sort((a, b) => b.score - a.score);
  const ranks = new Map(ordered.map((h,index)=>[h.id,h.recallRanks ?? h.routeRanks ?? Object.fromEntries(h.routes.map(r=>[r,index]))]));
  const routes = [...new Set(ordered.flatMap((h) => Object.keys(ranks.get(h.id)!)))];
  const queues = routes.map((route) =>
    ordered
      .filter((h) => route in ranks.get(h.id)!)
      .sort(
        (a, b) =>
          (ranks.get(a.id)![route] ?? Infinity) -
            (ranks.get(b.id)![route] ?? Infinity) || b.score - a.score,
      ),
  );
  const result: T[] = [], seen = new Set<string>();
  const add = (hit: T) => {
    if (result.length < limit && !seen.has(hit.id)) {
      result.push(hit);
      seen.add(hit.id);
    }
  };
  // Named operations share the frontier budget; one route cannot exhaust it.
  const offsets = queues.map(()=>0);
  while (result.length < limit) {
    let changed = false;
    for (const [index, queue] of queues.entries()) {
      while (queue[offsets[index]!] && seen.has(queue[offsets[index]!]!.id)) offsets[index]!++;
      const hit=queue[offsets[index]!];
      if (!hit) continue;
      offsets[index]!++; add(hit); changed=true;
      if (result.length === limit) break;
    }
    if (!changed) break;
  }
  return result;
}
