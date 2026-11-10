import type { App } from "../core/app.ts";
import type { Db } from "../core/db.ts";
import { all, one, run } from "../core/db.ts";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";

/** Read-only search processes drop their matrices when the host clears them (model change). */
export const vectorChanges = new EventEmitter();
vectorChanges.setMaxListeners(0);
export type VectorChange = { op: "clear" };

/**
 * Where chunk vectors are searched. The default keeps one int8-quantized matrix per space in
 * memory (a quarter of float32), in the search process (read-process.ts), never on the main thread.
 *
 * Staying current: triggers on `chunks` append to `vector_log` (core/db.ts) whenever a vector
 * appears, changes, moves to another space or goes away, whoever wrote it (the host, the
 * directory-import process). Before each search the index reads the log from where it left off,
 * drops those ids from loaded spaces and reads back the ones that still have a vector. Nothing
 * is reloaded wholesale because chunks changed.
 *
 * Loading: a space is read in pages that yield. A large space also gets a snapshot file
 * (`<home>/cache/vectors`, the quantized matrix as is) written after loading, valid for the
 * embedding model it was made with and the log position it was taken at; the next process reads
 * the file and replays the log since then. A million 1024-dim vectors took 20+ seconds to read
 * from SQLite (4 GB of float32 blobs) every time the search process had been idle and exited.
 *
 * It is exact (brute force). Measured on 2 CPU cores with 512-dim vectors: ~170k chunks across 10
 * spaces search in a few hundred ms over all spaces and tens of ms within one. Beyond roughly
 * half a million chunks, put an ANN engine (sqlite-vec, Qdrant, pgvector…) behind this interface.
 */
export interface VectorIndex {
  /** Bring loaded spaces up to date and load these spaces (all when omitted) without blocking. */
  prepare(app: App, spaces?: string[]): Promise<void>;
  /** Kept for engines without the log; the in-memory index reads chunk changes from `vector_log`. */
  add(app: App, rows: { id: number; spaceId: string; vec: Float32Array }[]): void;
  forget(ids: number[]): void;
  /** Loaded spaces only; call `prepare` first. */
  search(app: App, q: Float32Array, spaces: string[] | undefined, limit: number): { chunkId: number; score: number }[];
  clear(): void;
  evict(spaceIds: string[]): void;
  stats(): { spaces: number; vectors: number; bytes: number };
}

/** Rows of one space; a space is one or more segments (a snapshot is read as one, additions go to a small one after it). */
type Seg = { n: number; ids: Int32Array; codes: Int8Array; scales: Float32Array };
type SpaceMatrix = { dims: number; segs: Seg[] };
const count = (m: SpaceMatrix) => m.segs.reduce((a, g) => a + g.n, 0);

const PAGE = 4000;
/** Changes to one space past which reading it again is cheaper than patching it. */
const PATCH_MAX = (n: number) => Math.max(5000, Math.floor(n * 0.2));
const LOG_PAGE = 20_000;
const MAGIC = 0x31564d4f; // "OMV1"
const HEADER = 32;

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

const yieldLoop = () => new Promise<void>((ok) => setImmediate(ok));
const modelOf = (db: Db) => one<{ value: string }>(db, "select value from kv where key = 'embedding_model'")?.value ?? "";
const logEnd = (db: Db) => one<{ s: number | null }>(db, "select max(seq) s from vector_log")?.s ?? 0;
const logFloor = (db: Db) => Number(one<{ value: string }>(db, "select value from kv where key = 'vector_log_floor'")?.value ?? 0) || 0;
const modelHash = (model: string) => createHash("sha256").update(model).digest().subarray(0, 8);

let tmpSeq = 0;

export class MemoryIndex implements VectorIndex {
  private spaces = new Map<string, SpaceMatrix | null>();
  /** Log position the loaded spaces reflect; -1 before the first look. */
  private seq = -1;
  private model: string | null = null;
  private db: Db | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private snapshotDir: string | null;
  private snapshotMin: number;
  /** Spaces whose snapshot should be (re)written once the current search is answered. */
  private dirty = new Set<string>();
  /** Snapshot activity, for tests and diag. */
  readonly counters = { snapshotReads: 0, snapshotWrites: 0, fullLoads: 0, patched: 0 };

  constructor(opts: { snapshotDir?: string; snapshotMin?: number } = {}) {
    this.snapshotDir = opts.snapshotDir ?? null;
    this.snapshotMin = opts.snapshotMin ?? 20_000;
  }

  prepare(app: App, spaces?: string[]) {
    const next = this.chain.then(() => this.doPrepare(app.db, spaces));
    this.chain = next.then(() => this.writeSnapshots(app.db), () => {}).catch(() => {});
    return next;
  }

  private async doPrepare(db: Db, spaces?: string[]) {
    if (this.db !== db) this.reset(db);
    this.catchUp(db);
    const ids = spaces ?? all<{ id: string }>(db, "select id from spaces").map((r) => r.id);
    for (const sp of ids) {
      if (!this.spaces.has(sp)) await this.load(db, sp);
      // Empty and already-loaded spaces still give IPC and cancellation a turn.
      await yieldLoop();
    }
  }

  private reset(db: Db | null) {
    this.spaces.clear();
    this.dirty.clear();
    this.seq = -1;
    this.model = null;
    this.db = db;
  }

  /** Apply the log since the last look to the loaded spaces. */
  private catchUp(db: Db) {
    const model = modelOf(db);
    if (this.seq < 0 || model !== this.model) {
      // First look, or the model changed (every vector was cleared and is being made again).
      this.spaces.clear();
      this.model = model;
      this.seq = logEnd(db);
      return;
    }
    const changed = new Map<string, Set<number>>();
    for (;;) {
      const rows = all<{ seq: number; space_id: string; chunk_id: number }>(db, "select seq, space_id, chunk_id from vector_log where seq > ? order by seq limit ?", this.seq, LOG_PAGE);
      if (!rows.length) break;
      for (const r of rows) {
        if (!this.spaces.has(r.space_id)) continue;
        let set = changed.get(r.space_id);
        if (!set) changed.set(r.space_id, (set = new Set()));
        set.add(r.chunk_id);
      }
      this.seq = rows[rows.length - 1].seq;
      if (rows.length < LOG_PAGE) break;
    }
    for (const [sp, ids] of changed) this.patch(db, sp, ids);
  }

  /** Drop these ids from a loaded space and read back the ones that still have a vector there. */
  private patch(db: Db, sp: string, ids: Set<number>) {
    const m = this.spaces.get(sp);
    if (m === undefined) return;
    if (m && ids.size > PATCH_MAX(count(m))) {
      this.spaces.delete(sp);
      return;
    }
    let target = m;
    if (target) removeIds(target, ids);
    const list = [...ids];
    for (let i = 0; i < list.length; i += 500) {
      const part = list.slice(i, i + 500);
      const rows = all<{ id: number; embedding: Uint8Array }>(db, `select id, embedding from chunks where space_id = ? and embedding is not null and id in (${part.map(() => "?").join(",")})`, sp, ...part);
      for (const r of rows) {
        target ??= alloc(r.embedding.byteLength / 4, rows.length);
        push(target, r.id, asFloats(r.embedding));
      }
    }
    if (target !== m) this.spaces.set(sp, target);
    this.counters.patched += ids.size;
    if (!target) return;
    // It now reflects the log at least up to here (replaying later changes again changes nothing).
    snapshotSeq.set(target, Math.max(snapshotSeq.get(target) ?? 0, this.seq));
    if (count(target) >= this.snapshotMin && ids.size > Math.max(1000, count(target) * 0.05)) this.dirty.add(sp);
  }

  private async load(db: Db, sp: string) {
    // Position first: whatever changes while the pages are read is replayed by the next catch-up.
    const base = logEnd(db);
    const snap = await this.readSnapshot(db, sp);
    if (snap) {
      this.spaces.set(sp, snap.m);
      const ids = new Set(all<{ chunk_id: number }>(db, "select chunk_id from vector_log where space_id = ? and seq > ?", sp, snap.seq).map((r) => r.chunk_id));
      if (ids.size) this.patch(db, sp, ids);
      // The snapshot trusts the log; a count that disagrees, or sampled rows that differ from the
      // database (a data directory whose database was replaced), mean it is not this library's.
      const total = one<{ n: number }>(db, "select count(*) n from chunks where space_id = ? and embedding is not null", sp)?.n ?? 0;
      const now = this.spaces.get(sp);
      if (now !== undefined && (now ? count(now) : 0) === total && (!now || sampleMatches(db, sp, now))) return;
      this.spaces.delete(sp);
    }
    this.counters.fullLoads++;
    const total = one<{ n: number }>(db, "select count(*) n from chunks where space_id = ? and embedding is not null", sp)?.n ?? 0;
    let m: SpaceMatrix | null = null;
    let cursor = 0;
    for (;;) {
      const rows = all<{ id: number; embedding: Uint8Array }>(db, "select id, embedding from chunks where space_id = ? and embedding is not null and id > ? order by id limit ?", sp, cursor, PAGE);
      if (!rows.length) break;
      m ??= alloc(rows[0].embedding.byteLength / 4, Math.max(total, rows.length) + 64);
      for (const r of rows) push(m, r.id, asFloats(r.embedding));
      cursor = rows[rows.length - 1].id;
      await yieldLoop();
    }
    // Cleared or reset meanwhile (model change): the next search loads it afresh.
    if (this.db !== db) return;
    this.spaces.set(sp, m);
    if (m && count(m) >= this.snapshotMin) {
      this.dirty.add(sp);
      snapshotSeq.set(m, base);
    }
  }

  private snapshotFile(sp: string) {
    return join(this.snapshotDir!, createHash("sha256").update(sp).digest("hex").slice(0, 24) + ".vec");
  }

  private async readSnapshot(db: Db, sp: string): Promise<{ m: SpaceMatrix; seq: number } | null> {
    if (!this.snapshotDir) return null;
    const file = this.snapshotFile(sp);
    let buf: Uint8Array;
    try { buf = await readFile(file); } catch { return null; }
    const bad = async () => { await rm(file, { force: true }).catch(() => {}); return null; };
    if (buf.byteOffset % 4 !== 0) buf = new Uint8Array(buf);
    if (buf.byteLength < HEADER) return bad();
    const head = new DataView(buf.buffer, buf.byteOffset, HEADER);
    const dims = head.getUint32(4, true);
    const n = head.getUint32(8, true);
    const seq = head.getFloat64(16, true);
    if (head.getUint32(0, true) !== MAGIC || !dims || buf.byteLength !== HEADER + n * 8 + n * dims) return bad();
    if (!Buffer.from(buf.buffer, buf.byteOffset + 24, 8).equals(modelHash(this.model ?? modelOf(db)))) return bad();
    // Older than the log reaches back: changes in between are unknown.
    if (seq < logFloor(db)) return bad();
    const at = buf.byteOffset;
    const m: SpaceMatrix = {
      dims,
      segs: [{
        n,
        ids: new Int32Array(buf.buffer, at + HEADER, n),
        scales: new Float32Array(buf.buffer, at + HEADER + n * 4, n),
        codes: new Int8Array(buf.buffer, at + HEADER + n * 8, n * dims),
      }],
    };
    this.counters.snapshotReads++;
    snapshotSeq.set(m, seq);
    return { m, seq };
  }

  /** After a search is answered: write the spaces that were read in full or changed a lot. */
  private async writeSnapshots(db: Db) {
    if (!this.snapshotDir || !this.dirty.size) return;
    const list = [...this.dirty];
    this.dirty.clear();
    for (const sp of list) {
      const m = this.spaces.get(sp);
      if (!m || this.db !== db) continue;
      // A space read in full reflects the log up to where it started reading; a patched one, up to now.
      const seq = Math.min(snapshotSeq.get(m) ?? this.seq, this.seq);
      try {
        await mkdir(this.snapshotDir, { recursive: true });
        const file = this.snapshotFile(sp);
        // Its own name per write: two indexes of one process (tests) or an overlapping write must not share it.
        const tmp = `${file}.${process.pid}.${++tmpSeq}.tmp`;
        const head = Buffer.alloc(HEADER);
        head.writeUInt32LE(MAGIC, 0);
        head.writeUInt32LE(m.dims, 4);
        head.writeUInt32LE(count(m), 8);
        head.writeDoubleLE(seq, 16);
        modelHash(this.model ?? "").copy(head, 24);
        const fh = await open(tmp, "w");
        try {
          // The matrix is not touched meanwhile: the next prepare waits for this write.
          const parts = [head, ...m.segs.map((g) => g.ids.subarray(0, g.n)), ...m.segs.map((g) => g.scales.subarray(0, g.n)), ...m.segs.map((g) => g.codes.subarray(0, g.n * m.dims))];
          for (const part of parts) {
            await fh.write(new Uint8Array(part.buffer, part.byteOffset, part.byteLength));
          }
        } finally { await fh.close(); }
        await rename(tmp, file);
        snapshotSeq.set(m, this.seq);
        this.counters.snapshotWrites++;
      } catch (e) {
        console.warn(`[omem] 向量快照写入失败（${sp}）：${(e as Error).message}`);
      }
    }
  }

  /** The log covers every write; nothing to do here. */
  add() {}
  forget() {}
  evict() {}

  search(_app: App, q: Float32Array, spaces: string[] | undefined, limit: number) {
    const ids = spaces ?? [...this.spaces.keys()];
    // Keep the best `limit` in a small sorted array (limit is tens, n is large).
    const top: { chunkId: number; score: number }[] = [];
    let floor = -Infinity;
    for (const sp of ids) {
      const m = this.spaces.get(sp);
      if (!m || m.dims !== q.length) continue;
      const dims = m.dims;
      for (const g of m.segs) {
        const { codes, scales } = g;
        for (let i = 0; i < g.n; i++) {
          let s = 0;
          const off = i * dims;
          for (let k = 0; k < dims; k++) s += codes[off + k] * q[k];
          s *= scales[i];
          if (top.length >= limit && s <= floor) continue;
          let j = top.length;
          while (j > 0 && top[j - 1].score < s) j--;
          top.splice(j, 0, { chunkId: g.ids[i], score: s });
          if (top.length > limit) top.pop();
          if (top.length >= limit) floor = top[top.length - 1].score;
        }
      }
    }
    return top;
  }

  clear() {
    vectorChanges.emit("change", { op: "clear" });
    this.reset(null);
  }

  stats() {
    let vectors = 0;
    let bytes = 0;
    for (const m of this.spaces.values()) {
      if (!m) continue;
      for (const g of m.segs) {
        vectors += g.n;
        bytes += g.codes.byteLength + g.ids.byteLength + g.scales.byteLength;
      }
    }
    return { spaces: this.spaces.size, vectors, bytes };
  }
}

/** Log position a matrix reflects (for its snapshot). */
const snapshotSeq = new WeakMap<SpaceMatrix, number>();

function seg(dims: number, cap: number): Seg {
  return { n: 0, ids: new Int32Array(cap), codes: new Int8Array(cap * dims), scales: new Float32Array(cap) };
}
function alloc(dims: number, cap: number): SpaceMatrix {
  return { dims, segs: [seg(dims, cap)] };
}

function push(m: SpaceMatrix, id: number, v: Float32Array) {
  if (v.length !== m.dims) return;
  let g = m.segs[m.segs.length - 1];
  if (g.n === g.ids.length) {
    // A new segment instead of growing in place: copying a gigabyte of codes to add one row would
    // hold two copies at once. When there are many, the small ones are merged.
    if (m.segs.length >= 8) compact(m);
    g = m.segs[m.segs.length - 1];
    if (g.n === g.ids.length) m.segs.push((g = seg(m.dims, Math.max(1024, Math.ceil(count(m) * 0.1)))));
  }
  g.ids[g.n] = id;
  g.scales[g.n] = quantize(v, g.codes, g.n * m.dims);
  g.n++;
}

/** Merge every segment after the first into one with room to spare. */
function compact(m: SpaceMatrix) {
  const rest = m.segs.slice(1);
  const n = rest.reduce((a, g) => a + g.n, 0);
  const out = seg(m.dims, Math.max(1024, n * 2));
  for (const g of rest) {
    out.ids.set(g.ids.subarray(0, g.n), out.n);
    out.scales.set(g.scales.subarray(0, g.n), out.n);
    out.codes.set(g.codes.subarray(0, g.n * m.dims), out.n * m.dims);
    out.n += g.n;
  }
  m.segs = [m.segs[0], out];
}

/** A few rows spread over the matrix, compared with what the database holds for them now. */
function sampleMatches(db: Db, sp: string, m: SpaceMatrix, samples = 16) {
  const total = count(m);
  const codes = new Int8Array(m.dims);
  for (let k = 0; k < Math.min(samples, total); k++) {
    let at = Math.floor(((k + 0.5) * total) / Math.min(samples, total));
    const g = m.segs.find((s) => (at < s.n ? true : ((at -= s.n), false)))!;
    const row = one<{ embedding: Uint8Array }>(db, "select embedding from chunks where id = ? and space_id = ? and embedding is not null", g.ids[at], sp);
    if (!row || row.embedding.byteLength !== m.dims * 4) return false;
    const scale = quantize(asFloats(row.embedding), codes, 0);
    if (Math.abs(scale - g.scales[at]) > 1e-6 * Math.max(1, scale)) return false;
    for (let d = 0; d < m.dims; d++) if (codes[d] !== g.codes[at * m.dims + d]) return false;
  }
  return true;
}

/** Remove rows by id in one pass, moving each segment's last row into the hole. */
function removeIds(m: SpaceMatrix, ids: Set<number>) {
  const d = m.dims;
  for (const g of m.segs) {
    let i = 0;
    while (i < g.n) {
      if (!ids.has(g.ids[i])) { i++; continue; }
      const last = g.n - 1;
      if (i !== last) {
        g.ids[i] = g.ids[last];
        g.scales[i] = g.scales[last];
        g.codes.copyWithin(i * d, last * d, last * d + d);
      }
      g.n--;
    }
  }
}

/**
 * Keep the log to its recent part (run by the host now and then). A snapshot older than what was
 * removed is not trusted (`vector_log_floor`) and its space is read in full once more.
 */
export async function pruneVectorLog(app: App, keep = 300_000) {
  const end = logEnd(app.db);
  const cut = end - keep;
  if (cut <= logFloor(app.db)) return 0;
  let removed = 0;
  let from = one<{ s: number | null }>(app.db, "select min(seq) s from vector_log")?.s ?? cut;
  // Floor first: a reader that sees the floor never trusts a snapshot the deleted rows belonged to.
  run(app.db, "insert into kv(key, value) values('vector_log_floor', ?) on conflict(key) do update set value = excluded.value", String(cut));
  while (from <= cut) {
    const to = Math.min(cut, from + 20_000);
    removed += Number(run(app.db, "delete from vector_log where seq >= ? and seq <= ?", from, to).changes);
    from = to + 1;
    await yieldLoop();
  }
  return removed;
}

let index: VectorIndex = new MemoryIndex();
export function vectorIndex() {
  return index;
}
/** Plug in another engine (ANN, external service) with the same interface. */
export function setVectorIndex(next: VectorIndex) {
  index = next;
}
