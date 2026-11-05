import { DatabaseSync } from "node:sqlite";
import type { App } from "../core/app.ts";
import type { ReadJob } from "./read-process.ts";
import { vectorIndex, type VectorChange } from "./vectors.ts";

const db = new DatabaseSync(process.argv[2], { readOnly: true });
process.removeAllListeners("warning");
db.exec("pragma query_only = on; pragma busy_timeout = 1000;");
let modelKey = "";
let idle: ReturnType<typeof setTimeout>;
let queue = Promise.resolve();
const armIdle = () => { clearTimeout(idle); idle = setTimeout(() => process.exit(0), 300_000); idle.unref(); };
process.on("disconnect", () => process.exit(0));
process.on("message", (message: { id: number; job: ReadJob; op?: string; change?: VectorChange }) => {
  if (message.op === "invalidate") {
    const c = message.change!;
    if (c.op === "clear") vectorIndex().clear();
    else if (c.op === "evict") vectorIndex().evict(c.spaces);
    else if (c.op === "forget") vectorIndex().forget(c.ids);
    else if (c.op === "add") vectorIndex().add({ db } as App, c.rows);
    return;
  }
  clearTimeout(idle);
  queue = queue.then(async () => {
    const { id, job } = message;
    const phases: Record<string, { ms: number; status: "ok" }> = {};
    const measure = async <T>(name: string, fn: () => Promise<T>) => {
      const start = performance.now(); const result = await fn();
      phases[name] = { ms: Math.round(performance.now() - start), status: "ok" };
      return result;
    };
    try {
      let result: unknown;
      if (job.op === "sql") result = await measure(`${job.stage ?? "read"}.sql`, async () => db.prepare(job.sql).all(...job.params));
      else if (job.op === "rerank") {
        const { rerankLocally } = await import("./rerank.ts");
        result = await measure("rerank.score", () => rerankLocally({ db, config: job.config } as App, job.query, job.passages, job.timeoutMs));
      } else {
        const mod = await import("./embeddings.ts");
        const key = JSON.stringify(job.config.embeddings);
        if (modelKey !== key) { mod.resetEmbedder(); modelKey = key; }
        const app = { db, config: job.config } as App;
        const q = job.vector ?? await measure("vector.embed", () => mod.embedQuery(app, job.query));
        if (!q) result = [];
        else {
          await measure("vector.load", () => vectorIndex().prepare(app, job.spaces));
          result = await measure("vector.scan", async () => vectorIndex().search(app, q, job.spaces, job.limit));
        }
      }
      process.send?.({ id, result, phases, stats: vectorIndex().stats() });
    } catch (e) { process.send?.({ id: message.id, error: `检索查询失败：${(e as Error).message.slice(0, 300)}` }); }
    finally { armIdle(); }
  });
});
armIdle();
