import type { SearchQuery, SourceCandidate } from "./port.js";

/** MMR over fused relevance, using existing normalized vectors for redundancy.
 * https://www.elastic.co/search-labs/blog/maximum-marginal-relevance-diversify-results
 * This changes ordering only: original identities, visibility and provenance survive.
 */
export function rankEvidence(hits: SourceCandidate[], query: SearchQuery, vectors = new Map<string, Float32Array>()): SourceCandidate[] {
  const limit = Math.max(1, Math.min(query.limit ?? 20, 100));
  const pool = hits.map(hit => ({ ...hit, score: hit.score * (query.sourceWeight?.(hit.id) ?? 1) * (hit.routes?.includes('code-symbol') ? 1.5 : 1) }))
    .sort((a,b) => b.score-a.score || a.id.localeCompare(b.id));
  if (!pool.length || query.diversify === false) return pool.slice(0,limit);
  const scale = pool[0]!.score || 1, selected: SourceCandidate[] = [];
  const redundancy = new Map<string,number>();
  while (pool.length && selected.length < limit) {
    let best = 0, bestScore = -Infinity;
    for (let i=0;i<pool.length;i++) {
      const hit = pool[i]!;
      const score = .85 * hit.score / scale - .15 * (redundancy.get(hit.id) ?? 0);
      if (score > bestScore) { best = i; bestScore = score; }
    }
    const [chosen] = pool.splice(best,1); selected.push(chosen!);
    for (const hit of pool) redundancy.set(hit.id,Math.max(redundancy.get(hit.id) ?? 0, similarity(hit,chosen!,vectors)));
  }
  return selected;
}
function similarity(a: SourceCandidate,b: SourceCandidate,vectors: Map<string,Float32Array>) {
  // Exact mirrored excerpts and fragments of one source remain redundant even
  // while the optional vector index is catching up. No source is deleted.
  if (a.snippet.replace(/\s+/g," ").trim() === b.snippet.replace(/\s+/g," ").trim()) return 1;
  const x=vectors.get(a.id), y=vectors.get(b.id);
  if (x && y) return Math.max(0,x.reduce((sum,v,i)=>sum+v*y[i]!,0));
  return a.sourceRevisionId === b.sourceRevisionId ? .8 : 0;
}
