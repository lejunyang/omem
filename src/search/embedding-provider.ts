import { setTimeout as delay } from "node:timers/promises";
import type { App } from "../core/app.ts";
import type { Config } from "../core/config.ts";
import { untilAbort } from "../core/util.ts";
import { SearchApiError, searchPost } from "./api.ts";

export type Kind = "query" | "passage";
export type EmbeddingProvider = {
  id: string;
  dimensions?: number;
  maxBatch?: number;
  maxChars?: number;
  spaces?: readonly string[];
  embed(texts: string[], kind: Kind, signal: AbortSignal): Promise<Array<number[] | Float32Array>>;
};

export function apiEmbedder(app: App, cfg: Config["embeddings"], id: string): EmbeddingProvider {
  return { id, dimensions: cfg.dimensions, maxBatch: cfg.batch, async embed(input, _kind, signal) {
    const body = await searchPost(app, cfg, "/embeddings", { model: cfg.model, input, dimensions: cfg.dimensions }, signal) as
      { data?: { index?: number; embedding: number[] }[] };
    if (!Array.isArray(body?.data)) throw new Error("响应缺少 data 数组");
    const rows = [...body.data];
    if (rows.some(r => r.index !== undefined)) {
      rows.sort((a, b) => Number(a.index) - Number(b.index));
      if (!rows.every((r, i) => r.index === i)) throw new Error("向量的 index 无效");
    }
    return rows.map(r => r.embedding);
  } };
}

export async function encodeBatch(e: EmbeddingProvider, texts: string[], kind: Kind, timeoutMs: number, expected?: number) {
  if (!e.maxBatch) return encodeOne(e, texts, kind, timeoutMs, expected);
  const deadline = Date.now() + timeoutMs;
  const out: Float32Array[] = [];
  for (let at = 0; at < texts.length; at += e.maxBatch) {
    if (Date.now() >= deadline) throw new Error("向量调用超时");
    const input = texts.slice(at, at + e.maxBatch).map(t => e.maxChars ? t.slice(0, e.maxChars) : t);
    const rows = await encodeOne(e, input, kind, deadline - Date.now(), expected ?? out[0]?.length);
    out.push(...rows);
  }
  return out;
}

async function encodeOne(e: EmbeddingProvider, texts: string[], kind: Kind, timeoutMs: number, expected?: number) {
  const request = (signal: AbortSignal) => untilAbort(signal, () => e.embed(texts, kind, signal));
  // Local inference already implements its own queue and deadline in the read process.
  if (!e.maxBatch) return await request(AbortSignal.timeout(120_000)) as Float32Array[];
  const deadline = Date.now() + timeoutMs;
  let rows: Array<number[] | Float32Array>;
  for (let attempt = 0; ; attempt++) {
    const remaining = Math.max(1, deadline - Date.now());
    const signal = AbortSignal.timeout(Math.max(1, Math.ceil(remaining / (3 - attempt))));
    try {
      rows = await request(signal);
      break;
    } catch (err) {
      const status = Number((err as { status?: number }).status);
      const retry = signal.aborted || (err instanceof SearchApiError && err.retryable) || status === 429 || status >= 500;
      if (!retry || attempt === 2 || Date.now() >= deadline) throw err;
      await delay(Math.min(50 * 2 ** attempt, Math.floor((deadline - Date.now()) / 4)));
    }
  }
  if (!Array.isArray(rows) || rows.length !== texts.length) throw new Error("向量条数与输入不符");
  const dim = expected ?? e.dimensions ?? rows[0]?.length;
  return rows.map(row => {
    if (!(Array.isArray(row) || row instanceof Float32Array) || !dim || row.length !== dim ||
        (e.dimensions && dim !== e.dimensions)) throw new Error("向量维度不符");
    const v = Float32Array.from(row);
    let sum = 0;
    for (let i = 0; i < v.length; i++) {
      if (!Number.isFinite(row[i]) || !Number.isFinite(v[i])) throw new Error("向量含无效数值");
      sum += v[i] * v[i];
    }
    const norm = Math.sqrt(sum) || 1;
    return v.map(x => x / norm);
  });
}
