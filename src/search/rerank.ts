import type { App } from "../core/app.ts";
import { loadLocalModel } from "./embeddings.ts";

/**
 * Optional reranking: a cross-encoder (bge-reranker-v2-m3 by default, ONNX q8 through
 * transformers.js) reads the question together with each passage and gives a relevance in 0–1.
 * On T2Retrieval it lifts nDCG@10 of the fused list by 3–5 points (docs/v2/evaluation.md).
 *
 * It costs CPU per question, so calls run one at a time; a call that cannot finish within
 * `rerank.timeoutMs` (waiting included) stops at the next batch and returns null, and the
 * caller keeps its own order.
 */
type Scorer = { key: string; score(query: string, passages: string[], deadline: number): Promise<number[] | null> };

let loaded: { key: string; scorer: Promise<Scorer | null>; failedAt?: number } | null = null;
let testScorer: Scorer | null = null;
let queue: Promise<unknown> = Promise.resolve();
const BATCH = 8;
/** What settings → 检索 shows: whether the model loaded, and how the recent calls went. */
const stats = { state: "idle" as "idle" | "loading" | "ready" | "failed", error: "", calls: 0, timeouts: 0, lastMs: 0 };

function keyOf(app: App) {
  const c = app.config.rerank;
  return `${c.model}|${c.threads}|${c.maxTokens}`;
}

/** Loaded on first use and again when the model, threads or length change (settings apply without a restart). */
async function getScorer(app: App): Promise<Scorer | null> {
  if (testScorer) return testScorer;
  const key = keyOf(app);
  // A failed load is tried again after a minute (the model may have been downloaded since).
  if (loaded && loaded.key === key && (!loaded.failedAt || Date.now() - loaded.failedAt < 60_000)) return loaded.scorer;
  const cfg = app.config.rerank;
  const entry: { key: string; scorer: Promise<Scorer | null>; failedAt?: number } = { key, scorer: Promise.resolve(null) };
  loaded = entry;
  stats.state = "loading";
  entry.scorer = loadLocalModel(cfg.model, async (mod, id) => {
    const opts = { dtype: "q8", ...(cfg.threads ? { session_options: { intraOpNumThreads: cfg.threads } } : {}) };
    const [tok, model] = await Promise.all([mod.AutoTokenizer.from_pretrained(id), mod.AutoModelForSequenceClassification.from_pretrained(id, opts)]);
    stats.state = "ready";
    stats.error = "";
    return {
      key,
      async score(query: string, passages: string[], deadline: number) {
        const out: number[] = new Array(passages.length);
        // Similar lengths together: a batch is padded to its longest pair.
        const order = passages.map((p, i) => ({ i, n: p.length })).sort((a, b) => a.n - b.n).map((x) => x.i);
        for (let at = 0; at < order.length; at += BATCH) {
          if (Date.now() > deadline) return null;
          const group = order.slice(at, at + BATCH);
          const inputs = tok(group.map(() => query), { text_pair: group.map((i) => passages[i]), padding: true, truncation: true, max_length: cfg.maxTokens });
          const { logits } = await model(inputs);
          const data = logits.data as Float32Array;
          group.forEach((i, k) => (out[i] = 1 / (1 + Math.exp(-data[k]))));
        }
        return out;
      },
    } satisfies Scorer;
  }).catch((e) => {
    console.warn("[omem] 重排模型不可用，检索保持原来的顺序：", (e as Error).message);
    entry.failedAt = Date.now();
    stats.state = "failed";
    stats.error = (e as Error).message;
    return null;
  });
  return entry.scorer;
}

/**
 * Relevance of each passage to the query (0–1), or null when reranking is off, failed or ran out
 * of time. `timeoutMs` shortens `rerank.timeoutMs` for callers that hold up a reply.
 */
export async function rerankScores(app: App, query: string, passages: string[], timeoutMs?: number): Promise<number[] | null> {
  const cfg = app.config.rerank;
  if (!cfg.enabled || !passages.length || !query.trim()) return null;
  const started = Date.now();
  const deadline = started + Math.min(cfg.timeoutMs, timeoutMs ?? Infinity);
  const run = queue.then(async () => {
    stats.calls++;
    const s = Date.now() > deadline ? null : await getScorer(app);
    const scores = s ? await s.score(query.slice(0, 1000), passages, deadline) : null;
    if (scores) stats.lastMs = Date.now() - started;
    else if (Date.now() > deadline) stats.timeouts++;
    return scores;
  });
  queue = run.catch(() => {});
  return run.catch((e) => {
    console.warn("[omem] 重排失败，检索保持原来的顺序：", (e as Error).message);
    return null;
  });
}

export function rerankStatus(app: App) {
  const c = app.config.rerank;
  return { enabled: c.enabled, model: c.model, ...stats };
}

/** Tests: a stand-in scorer (null turns it back to the model). */
export function setRerankerForTests(score: ((query: string, passages: string[]) => number[]) | null) {
  testScorer = score ? { key: "test", score: async (q, p) => score(q, p) } : null;
}
