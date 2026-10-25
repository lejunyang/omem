import { describe, expect, it } from "vitest";
import { run } from "../src/core/db.ts";
import { vectorIndex } from "../src/search/vectors.ts";
import { upsertSource } from "../src/sources/store.ts";
import { testApp } from "./helpers.ts";

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
});
