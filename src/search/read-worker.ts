import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import type { App } from "../core/app.ts";
import type { ReadJob } from "./read-process.ts";
import { MemoryIndex, setVectorIndex, vectorIndex, type VectorChange } from "./vectors.ts";

const db = new DatabaseSync(process.argv[2], { readOnly: true });
// Large spaces' matrices are kept as files next to the library: the next process reads them back.
setVectorIndex(new MemoryIndex({ snapshotDir: join(dirname(process.argv[2]), "cache", "vectors") }));
// The vector lane holds the loaded matrices: it waits longer before giving their memory back.
const idleMs = Number(process.argv[3]) || 300_000;
process.removeAllListeners("warning");
db.exec("pragma query_only = on; pragma busy_timeout = 1000;");
let modelKey = "";
let idle: ReturnType<typeof setTimeout>;
let queue = Promise.resolve();
const armIdle = () => { clearTimeout(idle); idle = setTimeout(() => process.exit(0), idleMs); idle.unref(); };
process.on("disconnect", () => process.exit(0));
process.on("message", (message: { id: number; job: ReadJob; op?: string; change?: VectorChange }) => {
  if (message.op === "invalidate") {
    // Chunk changes reach the matrices through vector_log; only a clear (model change) is sent.
    if (message.change?.op === "clear") vectorIndex().clear();
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
      else if (job.op === "prepare") result = await measure("vector.load", () => vectorIndex().prepare({ db } as App, job.spaces));
      else if (job.op === "rerank") {
        const { rerankLocally } = await import("./rerank.ts");
        result = await measure("rerank.score", () => rerankLocally({ db, config: job.config } as App, job.query, job.passages, job.timeoutMs));
      } else {
        const mod = await import("./embeddings.ts");
        const key = JSON.stringify(job.config.embeddings);
        if (modelKey !== key) { if (modelKey) mod.resetEmbedder(); modelKey = key; }
        const app = { db, config: job.config } as App;
        if (job.op === "embed") result = await measure("embedding", () => mod.embedLocally(app, job.texts, job.kind));
        else {
          const q = job.vector ?? (await measure("vector.embed", () => mod.embedLocally(app, [job.query], "query")))[0];
          if (!q) result = [];
          else {
            await measure("vector.load", () => vectorIndex().prepare(app, job.spaces));
            result = await measure("vector.scan", async () => vectorIndex().search(app, q, job.spaces, job.limit));
          }
        }
      }
      process.send?.({ id, result, phases, stats: vectorIndex().stats() });
    } catch (e) { process.send?.({ id: message.id, error: `检索查询失败：${(e as Error).message.slice(0, 300)}` }); }
    finally { armIdle(); }
  });
});
armIdle();
