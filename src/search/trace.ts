import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import type { App } from "../core/app.ts";
import { addRunEvent } from "../agents/runs.ts";

export const searchRun = new AsyncLocalStorage<string>();
type Stage = { ms: number; rows?: number; status: "ok" | "timeout" | "error" };
type Trace = { id: string; query: string; queryHash: string; spaces: number | "all"; totalMs: number; stages: Record<string, Stage>; partial: boolean };
const current = new AsyncLocalStorage<Trace>();
const recent = new WeakMap<App, Trace[]>();

export async function searchStage<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const start = performance.now();
  const trace = current.getStore();
  try {
    const result = await fn();
    if (trace) trace.stages[name] = { ms: Math.round(performance.now() - start), status: "ok", ...(Array.isArray(result) ? { rows: result.length } : {}) };
    return result;
  } catch (e) {
    if (trace) {
      const status = (e as Error).name === "SearchTimeout" ? "timeout" : "error";
      trace.stages[name] = { ms: Math.round(performance.now() - start), status };
      trace.partial = true;
    }
    throw e;
  }
}

/** Worker phase times exclude its IPC/queue wait, kept separately by searchStage. */
export function searchPhases(phases: Record<string, Stage>) {
  const trace = current.getStore();
  if (trace) Object.assign(trace.stages, phases);
}

export async function traceSearch<T>(app: App, query: string, spaces: string[] | undefined, fn: () => Promise<T>): Promise<T> {
  const trace: Trace = { id: randomUUID(), query: query.slice(0, 160), queryHash: createHash("sha256").update(query).digest("hex").slice(0, 16), spaces: spaces?.length ?? "all", totalMs: 0, stages: {}, partial: false };
  const started = performance.now();
  try { return await current.run(trace, fn); }
  finally {
    trace.totalMs = Math.round(performance.now() - started);
    const list = recent.get(app) ?? [];
    list.push(trace);
    if (list.length > 30) list.shift();
    recent.set(app, list);
    const runId = searchRun.getStore();
    if (runId) addRunEvent(app, runId, "search", trace);
    if (trace.totalMs > 3000 || trace.partial) console.warn(`[omem] 检索 ${trace.queryHash} 用了 ${trace.totalMs} ms${trace.partial ? "（部分通道未完成）" : ""}：${JSON.stringify(trace.stages)}`);
  }
}

export function searchLatency(app: App) {
  return (recent.get(app) ?? []).map(({ query: _, ...trace }) => trace);
}
