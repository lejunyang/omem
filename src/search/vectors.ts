import type { App } from "../core/app.ts";
import { all } from "../core/db.ts";

/**
 * Where chunk vectors are searched. The default keeps one int8-quantized
 * matrix per space in memory, loaded on first use and extended as new chunks
 * get embedded — a quarter of the memory of float32, no duplicate caches for
 * different space combinations, and no full reload after every batch.
 *
 * It is exact (brute force). Measured on 2 CPU cores with 512-dim vectors:
 * ~170k chunks across 10 spaces search in a few hundred ms over all spaces and
 * tens of ms within one. Beyond roughly half a million chunks, put an ANN
 * engine (sqlite-vec, Qdrant, pgvector…) behind this interface.
 */
export interface VectorIndex {
  /** Chunks that got vectors (only matters for spaces already loaded). */
  add(app: App, rows: { id: number; spaceId: string; vec: Float32Array }[]): void;
  /** Chunks that no longer exist. */
  forget(ids: number[]): void;
  search(app: App, q: Float32Array, spaces: string[] | undefined, limit: number): { chunkId: number; score: number }[];
  clear(): void;
  stats(): { spaces: number; vectors: number; bytes: number };
}

type SpaceMatrix = { n: number; dims: number; ids: Int32Array; codes: Int8Array; scales: Float32Array };

function quantize(v: Float32Array, codes: Int8Array, offset: number) {
  let max = 0;
  for (let k = 0; k < v.length; k++) max = Math.max(max, Math.abs(v[k]));
  const scale = max / 127 || 1;
  for (let k = 0; k < v.length; k++) codes[offset + k] = Math.round(v[k] / scale);
  return scale;
}

class MemoryIndex implements VectorIndex {
  private spaces = new Map<string, SpaceMatrix>();
  private removed = new Set<number>();

  private load(app: App, spaceId: string): SpaceMatrix | null {
    const hit = this.spaces.get(spaceId);
    if (hit) return hit;
    const rows = all<{ id: number; embedding: Uint8Array }>(app.db, "select id, embedding from chunks where space_id = ? and embedding is not null", spaceId);
    if (!rows.length) return null;
    const dims = rows[0].embedding.byteLength / 4;
    const m = this.alloc(dims, rows.length);
    for (const r of rows) this.push(m, r.id, new Float32Array(r.embedding.buffer.slice(r.embedding.byteOffset, r.embedding.byteOffset + r.embedding.byteLength)));
    for (const r of rows) this.removed.delete(r.id);
    this.spaces.set(spaceId, m);
    return m;
  }

  private alloc(dims: number, cap: number): SpaceMatrix {
    return { n: 0, dims, ids: new Int32Array(cap), codes: new Int8Array(cap * dims), scales: new Float32Array(cap) };
  }

  private push(m: SpaceMatrix, id: number, v: Float32Array) {
    if (v.length !== m.dims) return;
    if (m.n === m.ids.length) {
      const cap = Math.max(16, m.n * 2);
      const ids = new Int32Array(cap);
      ids.set(m.ids);
      const codes = new Int8Array(cap * m.dims);
      codes.set(m.codes);
      const scales = new Float32Array(cap);
      scales.set(m.scales);
      Object.assign(m, { ids, codes, scales });
    }
    m.ids[m.n] = id;
    m.scales[m.n] = quantize(v, m.codes, m.n * m.dims);
    m.n++;
  }

  add(_app: App, rows: { id: number; spaceId: string; vec: Float32Array }[]) {
    for (const r of rows) {
      // A reused row id: the old vector may still sit in some matrix — reload lazily.
      if (this.removed.has(r.id)) {
        this.spaces.clear();
        this.removed.clear();
        return;
      }
      const m = this.spaces.get(r.spaceId);
      if (m) this.push(m, r.id, r.vec);
    }
  }

  forget(ids: number[]) {
    for (const id of ids) this.removed.add(id);
    // Rebuild lazily when too much of the cache is dead.
    const total = [...this.spaces.values()].reduce((a, m) => a + m.n, 0);
    if (total && this.removed.size > total * 0.2) {
      this.spaces.clear();
      this.removed.clear();
    }
  }

  search(app: App, q: Float32Array, spaces: string[] | undefined, limit: number) {
    const ids = spaces ?? all<{ id: string }>(app.db, "select id from spaces").map((r) => r.id);
    // Keep the best `limit` in a small sorted array (limit is tens, n is large).
    const top: { chunkId: number; score: number }[] = [];
    let floor = -Infinity;
    for (const sp of ids) {
      const m = this.load(app, sp);
      if (!m || m.dims !== q.length) continue;
      const { codes, scales, dims } = m;
      for (let i = 0; i < m.n; i++) {
        let s = 0;
        const off = i * dims;
        for (let k = 0; k < dims; k++) s += codes[off + k] * q[k];
        s *= scales[i];
        if (top.length >= limit && s <= floor) continue;
        const id = m.ids[i];
        if (this.removed.has(id)) continue;
        let j = top.length;
        while (j > 0 && top[j - 1].score < s) j--;
        top.splice(j, 0, { chunkId: id, score: s });
        if (top.length > limit) top.pop();
        if (top.length >= limit) floor = top[top.length - 1].score;
      }
    }
    return top;
  }

  clear() {
    this.spaces.clear();
    this.removed.clear();
  }

  stats() {
    let vectors = 0;
    let bytes = 0;
    for (const m of this.spaces.values()) {
      vectors += m.n;
      bytes += m.codes.byteLength + m.ids.byteLength + m.scales.byteLength;
    }
    return { spaces: this.spaces.size, vectors, bytes };
  }
}

let index: VectorIndex = new MemoryIndex();
export function vectorIndex() {
  return index;
}
/** Plug in another engine (ANN, external service) with the same interface. */
export function setVectorIndex(next: VectorIndex) {
  index = next;
}
