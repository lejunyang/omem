import { expect, it, vi } from "vitest";
import { join } from "node:path";
import { testApp } from "./helpers.ts";
import { ReadProcess, SearchTimeout, closeReadProcess, readProcess } from "../src/search/read-process.ts";
import { vectorIndex } from "../src/search/vectors.ts";
import { upsertSource } from "../src/sources/store.ts";
import { createRun } from "../src/agents/runs.ts";
import { search } from "../src/search/search.ts";
import { searchLatency, searchRun } from "../src/search/trace.ts";
import { startServer } from "../src/server/http.ts";

it("kills a synchronous read on its deadline, keeps HTTP responsive, and restarts read-only", async () => {
  const app = testApp();
  const reader = new ReadProcess(join(app.home, "omem.db"));
  const server = await startServer(app, { port: 0, quiet: true });
  try {
    await reader.request({ op: "sql", sql: "select 1", params: [] });
    let ticks = 0;
    const timer = setInterval(() => ticks++, 5);
    const slow = reader.request({ op: "sql", sql: "with recursive x(n) as (values(0) union all select n+1 from x where n < 1000000000) select sum(n) from x", params: [] }, 200);
    const failure = expect(slow).rejects.toMatchObject({ name: "SearchTimeout" });
    const queued = reader.request({ op: "sql", sql: "select 2", params: [] }, 20);
    await expect(queued).rejects.toMatchObject({ name: "SearchTimeout" });
    expect((await server.inject({ url: "/api/settings" })).statusCode).toBe(200);
    await failure;
    clearInterval(timer);
    expect(ticks).toBeGreaterThan(1);
    expect(await reader.request({ op: "sql", sql: "select count(*) n from spaces", params: [] })).toEqual([{ n: 1 }]);
    await expect(reader.request({ op: "sql", sql: "delete from spaces", params: [] })).rejects.toThrow();
    expect(app.db.prepare("select count(*) n from spaces").get()).toMatchObject({ n: 1 });
  } finally { reader.stop(); await server.close(); app.db.close(); }
});

it("keeps the worker's vector cache in step with additions, deletion and empty spaces", async () => {
  const app = testApp();
  const reader = readProcess(app);
  const q = new Float32Array([1, 0]);
  const job = { op: "vector" as const, query: "示例编号", spaces: ["personal"], limit: 5, config: { embeddings: app.config.embeddings }, vector: q };
  try {
    expect(await reader.request(job)).toEqual([]);
    const src = upsertSource(app, { spaceId: "personal", kind: "note", uri: "sample", title: "示例", text: "示例材料" });
    const row = app.db.prepare("select id from chunks where source_id=?").get(src.id) as { id: number };
    app.db.prepare("update chunks set embedding=? where id=?").run(new Uint8Array(q.buffer), row.id);
    vectorIndex().add(app, [{ id: row.id, spaceId: "personal", vec: q }]);
    const hits = await reader.request<{ chunkId: number }[]>(job);
    expect(hits.map((h) => h.chunkId)).toEqual([row.id]);
    expect(await reader.request({ ...job, spaces: ["other"] })).toEqual([]);
    app.db.prepare("update chunks set embedding=null where id=?").run(row.id);
    vectorIndex().forget([row.id]);
    expect(await reader.request(job)).toEqual([]);
  } finally { closeReadProcess(app); app.db.close(); }
});

it("records bounded query context and per-stage timings on the calling run", async () => {
  const app = testApp();
  try {
    upsertSource(app, { spaceId: "personal", kind: "note", uri: "sample", title: "示例退款", text: "退款申请经审核后提交" });
    const r = createRun(app, { kind: "ask", title: "示例检索" });
    const hits = await searchRun.run(r.id, () => search(app, "退款", { spaces: ["personal"], types: ["chunk"] }));
    expect(hits.length).toBeGreaterThan(0);
    const row = app.db.prepare("select data from run_events where run_id=? and type='search'").get(r.id) as { data: string };
    expect(JSON.parse(row.data)).toMatchObject({ query: "退款", spaces: 1, partial: false, stages: { fts: { status: "ok" }, "fts.sql": { status: "ok" } } });
    expect(searchLatency(app)[0]).not.toHaveProperty("query");
  } finally { closeReadProcess(app); app.db.close(); }
});

it("keeps full-text hits when the independent vector channel times out", async () => {
  const app = testApp();
  app.config.embeddings.provider = "local";
  const timeout = vi.spyOn(readProcess(app, "vector"), "request").mockRejectedValue(new SearchTimeout());
  try {
    const src = upsertSource(app, { spaceId: "personal", kind: "note", uri: "sample", title: "退款", text: "退款申请经审核后提交" });
    const hits = await search(app, "退款", { types: ["chunk"] });
    expect(hits.map((h) => h.sourceId)).toContain(src.id);
    expect(searchLatency(app).at(-1)).toMatchObject({ partial: true, stages: { vector: { status: "timeout" }, fts: { status: "ok" } } });
  } finally { timeout.mockRestore(); closeReadProcess(app); app.db.close(); }
});
