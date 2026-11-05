import { describe, expect, it } from "vitest";
import { run } from "../src/core/db.ts";
import { vectorIndex } from "../src/search/vectors.ts";
import { upsertSource } from "../src/sources/store.ts";
import { testApp } from "./helpers.ts";
import { createSpace } from "../src/core/spaces.ts";

const vec = (i: number) => {
  const v = new Float32Array(8);
  v[i % 8] = 1;
  return v;
};

function fill(app: ReturnType<typeof testApp>, spaceId: string, n: number) {
  const src = upsertSource(app, { spaceId, kind: "note", uri: `v-${spaceId}`, title: "向量", text: "x" }).id;
  run(app.db, "delete from chunks where source_id = ?", src);
  run(app.db, "begin");
  const ins = app.db.prepare("insert into chunks(source_id, space_id, ord, kind, line_start, line_end, text, embedding) values(?,?,?,?,?,?,?,?)");
  for (let i = 0; i < n; i++) {
    const v = vec(i);
    ins.run(src, spaceId, i, "window", 1, 1, `c${i}`, new Uint8Array(v.buffer));
  }
  run(app.db, "commit");
}

describe("vector index loading", () => {
  it("uses a space index for counts and pages, caches empty spaces, and accepts their first vector", async () => {
    const app = testApp();
    const idx = vectorIndex();
    idx.clear();
    try {
      fill(app, "personal", 100);
      const ids = Array.from({ length: 30 }, (_, i) => `empty-${i}`);
      for (const id of ids) createSpace(app, { id, name: id, kind: "topic" });
      for (const sql of [
        "select count(*) from chunks where space_id = ? and embedding is not null",
        "select id, embedding from chunks where space_id = ? and embedding is not null and id > 0 order by id limit 4000",
      ]) {
        const plan = app.db.prepare(`explain query plan ${sql}`).all(ids[0]) as { detail: string }[];
        expect(plan.some((r) => /SEARCH chunks USING (COVERING )?INDEX chunks_vector_space/.test(r.detail))).toBe(true);
      }
      let ticks = 0;
      const pulse = () => { ticks++; if (ticks < ids.length) setImmediate(pulse); };
      setImmediate(pulse);
      await idx.prepare(app, ids);
      expect(ticks).toBeGreaterThan(1);
      const prepare = app.db.prepare.bind(app.db);
      let queries = 0;
      app.db.prepare = (sql) => { queries++; return prepare(sql); };
      await idx.prepare(app, ids);
      expect(queries).toBe(0);
      idx.add(app, [{ id: 9000, spaceId: ids[0], vec: vec(3) }]);
      const hit = idx.search(app, vec(3), [ids[0]], 1)[0];
      expect(hit.chunkId).toBe(9000);
      expect(hit.score).toBeCloseTo(1);
      idx.evict([ids[1]]);
      await idx.prepare(app, [ids[1]]);
      expect(queries).toBeGreaterThan(0);
    } finally { idx.clear(); app.db.close(); }
  });

  it("loads a large space in pages without blocking, and searches only what is loaded", async () => {
    const app = testApp();
    fill(app, "personal", 9_500);
    const idx = vectorIndex();
    idx.clear();
    // Not loaded: no hits now, loading starts in the background.
    expect(idx.search(app, vec(3), ["personal"], 5)).toEqual([]);
    let ticks = 0;
    const timer = setInterval(() => ticks++, 0);
    await idx.prepare(app, ["personal"]);
    clearInterval(timer);
    expect(ticks).toBeGreaterThan(0); // the event loop ran between pages
    expect(idx.stats().vectors).toBeGreaterThanOrEqual(9_500);
    const hits = idx.search(app, vec(3), ["personal"], 5);
    expect(hits).toHaveLength(5);
    expect(hits[0].score).toBeGreaterThan(0.9);
    app.db.close();
  });

  it("a reused chunk id drops only the space that held the old vector", async () => {
    const app = testApp();
    fill(app, "personal", 50);
    const idx = vectorIndex();
    idx.clear();
    await idx.prepare(app);
    const before = idx.stats().spaces;
    const any = idx.search(app, vec(0), ["personal"], 1)[0].chunkId;
    idx.forget([any]);
    idx.add(app, [{ id: any, spaceId: "personal", vec: vec(1) }]);
    expect(idx.stats().spaces).toBe(before - 1);
    app.db.close();
  });

  it("does not append vectors twice when they arrive on either side of a loading cursor", async () => {
    const app = testApp();
    const idx = vectorIndex();
    idx.clear();
    try {
      fill(app, "personal", 9500);
      const rows = app.db.prepare("select id from chunks order by id").all() as { id: number }[];
      const ids = [rows[1].id, rows.at(-1)!.id];
      for (const id of ids) app.db.prepare("update chunks set embedding=null where id=?").run(id);
      const loading = idx.prepare(app, ["personal"]);
      await new Promise((ok) => setImmediate(ok));
      for (const id of ids) app.db.prepare("update chunks set embedding=? where id=?").run(new Uint8Array(vec(3).buffer), id);
      idx.add(app, ids.map((id) => ({ id, spaceId: "personal", vec: vec(3) })));
      await loading;
      expect(idx.stats().vectors).toBe(9500);
    } finally { idx.clear(); app.db.close(); }
  });
});
