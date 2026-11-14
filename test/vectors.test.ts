import { describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/core/db.ts";
import { MemoryIndex, pruneVectorLog, vectorIndex } from "../src/search/vectors.ts";
import { upsertSource } from "../src/sources/store.ts";
import { testApp } from "./helpers.ts";
import { createSpace } from "../src/core/spaces.ts";

const vec = (i: number) => {
  const v = new Float32Array(8);
  v[i % 8] = 1;
  return v;
};
/** A vector with some spread, so rankings have no ties. */
const spread = (i: number) => {
  const v = new Float32Array(32);
  for (let k = 0; k < 32; k++) v[k] = Math.sin(i * 7.31 + k * k * 1.7 + i * k * 0.013);
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
};
const blob = (v: Float32Array) => new Uint8Array(v.buffer.slice(0));

function fill(app: ReturnType<typeof testApp>, spaceId: string, n: number, make = vec) {
  const src = upsertSource(app, { spaceId, kind: "note", uri: `v-${spaceId}`, title: "向量", text: "x" }).id;
  run(app.db, "delete from chunks where source_id = ?", src);
  run(app.db, "begin");
  const ins = app.db.prepare("insert into chunks(source_id, space_id, ord, kind, line_start, line_end, text, embedding) values(?,?,?,?,?,?,?,?)");
  for (let i = 0; i < n; i++) ins.run(src, spaceId, i, "window", 1, 1, `c${i}`, blob(make(i)));
  run(app.db, "commit");
  return src;
}

const ids = (app: ReturnType<typeof testApp>, space: string) => (app.db.prepare("select id from chunks where space_id = ? order by id").all(space) as { id: number }[]).map((r) => r.id);

/** What a fresh index, reading everything from the database, returns. */
async function fresh(app: ReturnType<typeof testApp>, q: Float32Array, spaces: string[], limit = 10) {
  const idx = new MemoryIndex();
  await idx.prepare(app, spaces);
  return idx.search(app, q, spaces, limit);
}

describe("vector index loading", () => {
  it("uses a space index for counts and pages, caches empty spaces, and yields while loading", async () => {
    const app = testApp();
    const idx = vectorIndex();
    idx.clear();
    try {
      fill(app, "personal", 100);
      const empty = Array.from({ length: 30 }, (_, i) => `empty-${i}`);
      for (const id of empty) createSpace(app, { id, name: id, kind: "topic" });
      for (const sql of [
        "select count(*) from chunks where space_id = ? and embedding is not null",
        "select id, embedding from chunks where space_id = ? and embedding is not null and id > 0 order by id limit 4000",
      ]) {
        const plan = app.db.prepare(`explain query plan ${sql}`).all(empty[0]) as { detail: string }[];
        expect(plan.some((r) => /SEARCH chunks USING (COVERING )?INDEX chunks_vector_space/.test(r.detail))).toBe(true);
      }
      let ticks = 0;
      const pulse = () => { ticks++; if (ticks < empty.length) setImmediate(pulse); };
      setImmediate(pulse);
      await idx.prepare(app, empty);
      expect(ticks).toBeGreaterThan(1);
      const prepare = app.db.prepare.bind(app.db);
      let loads = 0;
      app.db.prepare = (sql) => { if (/from chunks/.test(sql)) loads++; return prepare(sql); };
      await idx.prepare(app, empty);
      expect(loads).toBe(0);
      app.db.prepare = prepare;
      // The first vector of an empty, loaded space arrives through the log.
      const src = fill(app, empty[0], 1, () => vec(3));
      expect(src).toBeTruthy();
      await idx.prepare(app, [empty[0]]);
      const hit = idx.search(app, vec(3), [empty[0]], 1)[0];
      expect(hit.chunkId).toBe(ids(app, empty[0])[0]);
      expect(hit.score).toBeCloseTo(1);
    } finally { idx.clear(); app.db.close(); }
  });

  it("loads a large space in pages without blocking", async () => {
    const app = testApp();
    fill(app, "personal", 9_500);
    const idx = vectorIndex();
    idx.clear();
    expect(idx.search(app, vec(3), ["personal"], 5)).toEqual([]);
    let ticks = 0;
    const timer = setInterval(() => ticks++, 0);
    await idx.prepare(app, ["personal"]);
    clearInterval(timer);
    expect(ticks).toBeGreaterThan(0); // the event loop ran between pages
    expect(idx.stats().vectors).toBe(9_500);
    const hits = idx.search(app, vec(3), ["personal"], 5);
    expect(hits).toHaveLength(5);
    expect(hits[0].score).toBeGreaterThan(0.9);
    idx.clear();
    app.db.close();
  });

  it("logs every vector change, whoever writes it", () => {
    const app = testApp();
    try {
      createSpace(app, { id: "project-a", name: "项目 A", kind: "topic" });
      fill(app, "personal", 3);
      const [a, b, c] = ids(app, "personal");
      const log = () => app.db.prepare("select space_id s, chunk_id id from vector_log order by seq").all() as { s: string; id: number }[];
      expect(log().map((r) => r.id)).toEqual([a, b, c]);
      run(app.db, "delete from vector_log");
      run(app.db, "update chunks set embedding = ? where id = ?", blob(vec(5)), a);
      run(app.db, "update chunks set space_id = 'project-a' where id = ?", b);
      run(app.db, "delete from chunks where id = ?", c);
      run(app.db, "update chunks set text = 'y' where id = ?", a); // not a vector change
      expect(log()).toEqual([{ s: "personal", id: a }, { s: "personal", id: b }, { s: "project-a", id: b }, { s: "personal", id: c }]);
    } finally { app.db.close(); }
  });

  it("follows additions, changes, moves and deletions without reading a space again, same results as a fresh load", async () => {
    const app = testApp();
    createSpace(app, { id: "project-a", name: "项目 A", kind: "topic" });
    const idx = new MemoryIndex();
    try {
      fill(app, "personal", 500, spread);
      fill(app, "project-a", 200, (i) => spread(i + 1000));
      await idx.prepare(app, ["personal", "project-a"]);
      expect(idx.counters.fullLoads).toBe(2);
      const p = ids(app, "personal");
      // Changed vector, moved chunk, deleted chunk, a new chunk, a chunk that lost its vector.
      run(app.db, "update chunks set embedding = ? where id = ?", blob(spread(9001)), p[10]);
      run(app.db, "update chunks set space_id = 'project-a' where id = ?", p[20]);
      run(app.db, "delete from chunks where id = ?", p[30]);
      run(app.db, "update chunks set embedding = null where id = ?", p[40]);
      const src = upsertSource(app, { spaceId: "personal", kind: "note", uri: "extra", title: "补充", text: "补充材料" });
      const extra = (app.db.prepare("select id from chunks where source_id = ?").get(src.id) as { id: number }).id;
      run(app.db, "update chunks set embedding = ? where id = ?", blob(spread(9002)), extra);
      await idx.prepare(app, ["personal", "project-a"]);
      expect(idx.counters.fullLoads).toBe(2);
      expect(idx.stats().vectors).toBe(700 - 2 + 1);
      for (const [q, spaces] of [[spread(9001), ["personal"]], [spread(20), ["project-a"]], [spread(9002), ["personal", "project-a"]], [spread(7), ["personal", "project-a"]]] as const) {
        expect(idx.search(app, q, [...spaces], 10)).toEqual(await fresh(app, q, [...spaces]));
      }
      expect(idx.search(app, spread(9001), ["personal"], 1)[0].chunkId).toBe(p[10]);
      expect(idx.search(app, spread(20), ["project-a"], 1)[0].chunkId).toBe(p[20]);
    } finally { app.db.close(); }
  });

  it("keeps a space right when vectors change while it is being read", async () => {
    const app = testApp();
    const idx = new MemoryIndex();
    try {
      fill(app, "personal", 9500);
      const rows = ids(app, "personal");
      const changed = [rows[1], rows.at(-1)!];
      for (const id of changed) run(app.db, "update chunks set embedding = null where id = ?", id);
      const loading = idx.prepare(app, ["personal"]);
      await new Promise((ok) => setImmediate(ok));
      for (const id of changed) run(app.db, "update chunks set embedding = ? where id = ?", blob(vec(3)), id);
      await loading;
      await idx.prepare(app, ["personal"]);
      expect(idx.stats().vectors).toBe(9500);
    } finally { app.db.close(); }
  });

  it("writes a snapshot of a large space and reads it back, replaying the log since", async () => {
    const app = testApp();
    const dir = mkdtempSync(join(tmpdir(), "omem-vec-"));
    try {
      app.db.prepare("insert into kv(key, value) values('embedding_model', 'test:model')").run();
      fill(app, "personal", 3000, spread);
      const first = new MemoryIndex({ snapshotDir: dir, snapshotMin: 1000 });
      await first.prepare(app, ["personal"]);
      await first.prepare(app, []); // the snapshot is written after the search it was loaded for
      expect(first.counters.snapshotWrites).toBe(1);
      expect(readdirSync(dir)).toHaveLength(1);
      // Changes after the snapshot: the next process replays them.
      const p = ids(app, "personal");
      run(app.db, "update chunks set embedding = ? where id = ?", blob(spread(5000)), p[0]);
      run(app.db, "delete from chunks where id = ?", p[1]);
      const second = new MemoryIndex({ snapshotDir: dir, snapshotMin: 1000 });
      await second.prepare(app, ["personal"]);
      expect(second.counters).toMatchObject({ snapshotReads: 1, fullLoads: 0 });
      expect(second.stats().vectors).toBe(2999);
      for (const q of [spread(5000), spread(3), spread(1)]) expect(second.search(app, q, ["personal"], 10)).toEqual(await fresh(app, q, ["personal"]));
      // Additions after a snapshot load go to a segment of their own.
      const src = upsertSource(app, { spaceId: "personal", kind: "note", uri: "extra", title: "补充", text: "补充材料" });
      const extra = (app.db.prepare("select id from chunks where source_id = ?").get(src.id) as { id: number }).id;
      run(app.db, "update chunks set embedding = ? where id = ?", blob(spread(6000)), extra);
      await second.prepare(app, ["personal"]);
      expect(second.search(app, spread(6000), ["personal"], 1)[0].chunkId).toBe(extra);
      expect(second.search(app, spread(4), ["personal"], 10)).toEqual(await fresh(app, spread(4), ["personal"]));

      // Another model, or a log pruned past the snapshot: not trusted, read in full.
      app.db.prepare("update kv set value = 'test:other' where key = 'embedding_model'").run();
      const third = new MemoryIndex({ snapshotDir: dir, snapshotMin: 1000 });
      await third.prepare(app, ["personal"]);
      expect(third.counters).toMatchObject({ snapshotReads: 0, fullLoads: 1 });
      app.db.prepare("update kv set value = 'test:model' where key = 'embedding_model'").run();
      const again = new MemoryIndex({ snapshotDir: dir, snapshotMin: 1000 });
      await again.prepare(app, ["personal"]);
      await again.prepare(app, []);
      expect(again.counters.snapshotWrites).toBe(1);
      run(app.db, "update chunks set embedding = ? where id = ?", blob(spread(7000)), p[2]);
      expect(await pruneVectorLog(app, 0)).toBeGreaterThan(0);
      const fourth = new MemoryIndex({ snapshotDir: dir, snapshotMin: 1000 });
      await fourth.prepare(app, ["personal"]);
      expect(fourth.counters).toMatchObject({ snapshotReads: 0, fullLoads: 1 });
      expect(fourth.search(app, spread(7000), ["personal"], 1)[0].chunkId).toBe(p[2]);
      // A damaged file is dropped.
      for (const f of readdirSync(dir)) writeFileSync(join(dir, f), "broken");
      const fifth = new MemoryIndex({ snapshotDir: dir, snapshotMin: 1000 });
      await fifth.prepare(app, ["personal"]);
      expect(fifth.counters.fullLoads).toBe(1);
    } finally { app.db.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("does not trust a snapshot of another database with the same counts", async () => {
    const app = testApp();
    const dir = mkdtempSync(join(tmpdir(), "omem-vec-"));
    try {
      fill(app, "personal", 2000, spread);
      const first = new MemoryIndex({ snapshotDir: dir, snapshotMin: 1000 });
      await first.prepare(app, ["personal"]);
      await first.prepare(app, []);
      expect(first.counters.snapshotWrites).toBe(1);
      // As if the database file were replaced: other vectors, same ids, no log of the change.
      run(app.db, "update chunks set embedding = ? where space_id = 'personal'", blob(spread(4242)));
      run(app.db, "delete from vector_log");
      const second = new MemoryIndex({ snapshotDir: dir, snapshotMin: 1000 });
      await second.prepare(app, ["personal"]);
      expect(second.counters).toMatchObject({ snapshotReads: 1, fullLoads: 1 });
      expect(second.search(app, spread(4242), ["personal"], 1)[0].score).toBeCloseTo(1, 2);
    } finally { app.db.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("starts over when the embedding model changes", async () => {
    const app = testApp();
    const idx = new MemoryIndex();
    try {
      fill(app, "personal", 50);
      await idx.prepare(app, ["personal"]);
      expect(idx.stats().vectors).toBe(50);
      run(app.db, "insert into kv(key, value) values('embedding_model', 'test:new') on conflict(key) do update set value = excluded.value");
      run(app.db, "update chunks set embedding = null");
      await idx.prepare(app, ["personal"]);
      expect(idx.stats().vectors).toBe(0);
    } finally { app.db.close(); }
  });
});

describe("vectors stored packed", () => {
  it("packs to exactly what the index quantizes to, and reads both forms", async () => {
    const { pack, isPacked, dimsOf, toFloats } = await import("../src/search/vector-codec.ts");
    const v = spread(42);
    const p = pack(v);
    expect(isPacked(p)).toBe(true);
    expect(p.byteLength).toBe(8 + 32);
    expect(dimsOf(p)).toBe(32);
    expect(isPacked(blob(v))).toBe(false);
    expect(dimsOf(blob(v))).toBe(32);
    // The values come back to within the quantization step.
    const back = toFloats(p);
    for (let k = 0; k < 32; k++) expect(Math.abs(back[k] - v[k])).toBeLessThan(0.01);

    // A space holding both forms searches the same as one holding only float32 values.
    const app = testApp();
    createSpace(app, { id: "mixed", name: "混合" });
    createSpace(app, { id: "floats", name: "浮点" });
    fill(app, "floats", 300, spread);
    fill(app, "mixed", 300, spread);
    const mixed = ids(app, "mixed");
    for (let i = 0; i < mixed.length; i += 2) run(app.db, "update chunks set embedding = ? where id = ?", pack(spread(i)), mixed[i]);
    const floats = ids(app, "floats");
    const rank = (hits: { chunkId: number; score: number }[], all: number[]) => hits.map((h) => [all.indexOf(h.chunkId), Number(h.score.toFixed(6))]);
    expect(rank(await fresh(app, spread(7), ["mixed"]), mixed)).toEqual(rank(await fresh(app, spread(7), ["floats"]), floats));
  });

  it("converts stored float32 vectors in batches without logging a change, leaving search and snapshots as they were", async () => {
    const { packStoredVectors } = await import("../src/search/vectors.ts");
    const { isPacked } = await import("../src/search/vector-codec.ts");
    const app = testApp();
    const dir = mkdtempSync(join(tmpdir(), "omem-vec-pack-"));
    try {
      app.db.prepare("insert into kv(key, value) values('embedding_model', 'test:model')").run();
      fill(app, "personal", 1200, spread);
      const idx = new MemoryIndex({ snapshotDir: dir, snapshotMin: 100 });
      await idx.prepare(app, ["personal"]);
      const before = idx.search(app, spread(3), ["personal"], 10);
      await idx.prepare(app, ["personal"]);
      expect(idx.counters.snapshotWrites).toBe(1);
      const logged = (app.db.prepare("select count(*) n from vector_log").get() as { n: number }).n;
      const bytes = () => (app.db.prepare("select sum(length(embedding)) n from chunks").get() as { n: number }).n;
      const was = bytes();

      let looked = 0;
      for (let n = packStoredVectors(app, 500); n; n = packStoredVectors(app, 500)) looked += n;
      expect(looked).toBeGreaterThanOrEqual(1200);
      expect(packStoredVectors(app)).toBe(0);
      const rows = app.db.prepare("select embedding from chunks where embedding is not null").all() as { embedding: Uint8Array }[];
      expect(rows.every((r) => isPacked(r.embedding))).toBe(true);
      expect(bytes()).toBe(1200 * (8 + 32));
      expect(bytes()).toBeLessThan(was / 3);
      // Not a change: nothing logged, the loaded index and a fresh one (from its snapshot) answer the same.
      expect((app.db.prepare("select count(*) n from vector_log").get() as { n: number }).n).toBe(logged);
      await idx.prepare(app, ["personal"]);
      expect(idx.search(app, spread(3), ["personal"], 10)).toEqual(before);
      const again = new MemoryIndex({ snapshotDir: dir, snapshotMin: 100 });
      await again.prepare(app, ["personal"]);
      expect(again.counters).toMatchObject({ snapshotReads: 1, fullLoads: 0 });
      expect(again.search(app, spread(3), ["personal"], 10)).toEqual(before);
      // A real change to a packed row is still logged.
      const first = ids(app, "personal")[0];
      run(app.db, "update chunks set embedding = null where id = ?", first);
      expect((app.db.prepare("select count(*) n from vector_log").get() as { n: number }).n).toBe(logged + 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
