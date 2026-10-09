/** Bound model work after covering recall routes and original owners. This is
 * admission, not relevance scoring; candidates outside the pool stay available. */
export function candidatePool<
  T extends {
    id: string;
    owner: string;
    score: number;
    routes: string[];
    routeRanks?: Record<string, number>;
  },
>(hits: T[], limit: number): T[] {
  const ordered = [...hits].sort((a, b) => b.score - a.score);
  const routes = [...new Set(ordered.flatMap((h) => h.routes))];
  const queues = routes.map((route) =>
    ordered
      .filter((h) => h.routes.includes(route))
      .sort(
        (a, b) =>
          (a.routeRanks?.[route] ?? Infinity) -
            (b.routeRanks?.[route] ?? Infinity) || b.score - a.score,
      ),
  );
  const result: T[] = [],
    seen = new Set<string>(),
    owners = new Map<string, number>();
  const add = (hit: T) => {
    if (result.length < limit && !seen.has(hit.id)) {
      result.push(hit);
      seen.add(hit.id);
      owners.set(hit.owner, (owners.get(hit.owner) ?? 0) + 1);
    }
  };
  // Preserve explicit operation lookup admission before ordinary route coverage.
  for (const hit of ordered.filter((h) => h.routes.includes("code-symbol")))
    add(hit);
  for (const coverOwners of [true, false]) {
    const pending = queues.map((queue) => queue.filter((h) => !seen.has(h.id)));
    while (result.length < limit) {
      let changed = false;
      for (const queue of pending) {
        const index = queue.findIndex(
          (h) =>
            !seen.has(h.id) && (!coverOwners || (owners.get(h.owner) ?? 0) < 2),
        );
        if (index < 0) continue;
        const [hit] = queue.splice(index, 1);
        add(hit!);
        changed = true;
        if (result.length === limit) break;
      }
      if (!changed) break;
    }
  }
  return result;
}
