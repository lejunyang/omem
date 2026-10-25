import type { App } from "../core/app.ts";
import { all } from "../core/db.ts";

/**
 * Where chunk vectors are searched. The default keeps one int8-quantized
 * matrix per space in memory, loaded on first use and extended as new chunks
 * get embedded — a quarter of the memory of float32, no duplicate caches for
 * different space combinations, and no full reload after every batch. A space loads
 * in pages that yield to the event loop: a code space of a few hundred thousand
 * chunks once blocked the whole process for minutes (every tool call, reply and
 * timer waited) when it was read in one synchronous query.
 *
 * It is exact (brute force). Measured on 2 CPU cores with 512-dim vectors:
 * ~170k chunks across 10 spaces search in a few hundred ms over all spaces and
 * tens of ms within one. Beyond roughly half a million chunks, put an ANN
 * engine (sqlite-vec, Qdrant, pgvector…) behind this interface.
 */
export interface VectorIndex {
  /** Load these spaces (all when omitted) without blocking; search only sees loaded spaces. */
  prepare(app: App, spaces?: string[]): Promise<void>;
  /** Chunks that got vectors (only matters for spaces already loaded). */
  add(app: App, rows: { id: number; spaceId: string; vec: Float32Array }[]): void;
  /** Chunks that no longer exist. */
  forget(ids: number[]): void;
  search(app: App, q: Float32Array, spaces: string[] | undefined, limit: number): { chunkId: number; score: number }[];
  clear(): void;
  /** Spaces whose chunks changed hands: only these reload on next use. */
  evict(spaceIds: string[]): void;
  stats(): { spaces: number; vectors: number; bytes: number };
}

type SpaceMatrix = { n: number; dims: number; ids: Int32Array; codes: Int8Array; scales: Float32Array };

const PAGE = 4000;
/** A stored vector as floats; SQLite's buffer is used in place when aligned. */
function asFloats(b: Uint8Array) {
  if (b.byteOffset % 4 === 0) return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
  return new Float32Array(b.slice().buffer);
}

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

  private loading = new Map<string, { done: Promise<void>; cursor: number; added: { id: number; vec: Float32Array }[]; stale: boolean }>();

  async prepare(app: App, spaces?: string[]) {
    const ids = spaces ?? all<{ id: string }>(app.db, "select id from spaces").map((r) => r.id);
    for (const sp of ids) await this.load(app, sp);
  }

  private load(app: App, spaceId: string): Promise<void> {
    if (this.spaces.has(spaceId)) return Promise.resolve();
    const running = this.loading.get(spaceId);
    if (running) return running.done;
    const state = { cursor: 0, added: [] as { id: number; vec: Float32Array }[], done: Promise.resolve(), stale: false };
    state.done = (async () => {
      const total = all<{ n: number }>(app.db, "select count(*) n from chunks where space_id = ? and embedding is not null", spaceId)[0]?.n ?? 0;
      let m: SpaceMatrix | null = null;
      for (;;) {
        const rows = all<{ id: number; embedding: Uint8Array }>(app.db, "select id, embedding from chunks where space_id = ? and embedding is not null and id > ? order by id limit ?", spaceId, state.cursor, PAGE);
        if (!rows.length) break;
        m ??= this.alloc(rows[0].embedding.byteLength / 4, Math.max(total, rows.length));
        for (const r of rows) {
          this.push(m, r.id, asFloats(r.embedding));
          this.removed.delete(r.id);
        }
        state.cursor = rows[rows.length - 1].id;
        await new Promise((ok) => setImmediate(ok));
      }
      // Vectors embedded while loading below the cursor were not in any page.
      if (m) for (const a of state.added) if (a.id <= state.cursor) this.push(m, a.id, a.vec);
      // Cleared or evicted meanwhile (model change, chunks moved): the next search loads it afresh.
      if (m && !state.stale) this.spaces.set(spaceId, m);
    })().finally(() => { if (this.loading.get(spaceId) === state) this.loading.delete(spaceId); });
    this.loading.set(spaceId, state);
    return state.done;
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
      // A reused row id: the old vector may still sit in a matrix — reload only the spaces holding it.
      if (this.removed.has(r.id)) {
        for (const [sp, m] of this.spaces) if (m.ids.subarray(0, m.n).includes(r.id)) this.spaces.delete(sp);
        this.removed.delete(r.id);
      }
      const m = this.spaces.get(r.spaceId);
      if (m) this.push(m, r.id, r.vec);
      else this.loading.get(r.spaceId)?.added.push({ id: r.id, vec: r.vec });
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
      const m = this.spaces.get(sp);
      // Not loaded yet: start loading for the next search instead of blocking this one.
      if (!m) { void this.load(app, sp).catch(() => {}); continue; }
      if (m.dims !== q.length) continue;
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
    for (const l of this.loading.values()) l.stale = true;
    this.loading.clear();
  }

  evict(spaceIds: string[]) {
    for (const id of spaceIds) {
      this.spaces.delete(id);
      const l = this.loading.get(id);
      if (l) l.stale = true;
      this.loading.delete(id);
    }
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
