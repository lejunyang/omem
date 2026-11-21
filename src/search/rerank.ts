import type { App } from "../core/app.ts";
import { searchPost } from "./api.ts";
import type { Config } from "../core/config.ts";
import { loadLocalModel } from "./embeddings.ts";
import { pluginScores, selectedReranker, pluginHitFilter, type RerankCandidate, type SharedSearchAccess } from "./providers.ts";
import { OWNER } from "../core/users.ts";
import { readProcess } from "./read-process.ts";
import { searchStage } from "./trace.ts";
import { modelSource, prepareLocalModel } from "./local-models.ts";
import { rerankers } from "../plugins/process-hooks.ts";

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
const lastProvider = new WeakMap<App, string | null>();
/** What settings → 检索 shows: whether the model loaded, and how the recent calls went. */
const stats = { state: "idle" as "idle" | "loading" | "ready" | "failed", error: "", calls: 0, timeouts: 0, lastMs: 0 };
/** Models that have scored at least once in this run of the service. */
const everReady = new Set<string>();

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

export async function apiScores(app: App, cfg: Config["rerank"], query: string, passages: string[], budget: number) {
  if (!cfg.api) throw new Error("请填写云端重排模型和接口");
  type Row = { index: number; relevance_score?: number; score?: number };
  const body = await searchPost(app, cfg.api, "/rerank", {
    model: cfg.api.model, query: query.slice(0, 1000),
    // Estimate one token as two UTF-16 code units.
    documents: passages.map(p => p.slice(0, cfg.maxTokens * 2)), top_n: passages.length,
  }, AbortSignal.timeout(Math.min(cfg.api.timeoutMs, budget))) as {
    results?: Row[]; data?: Row[];
  };
  const results = body?.results ?? body?.data;
  if (!Array.isArray(results) || results.length !== passages.length) throw new Error("重排结果数量与候选不符");
  const scores: number[] = [];
  for (const r of results) {
    const score = r?.relevance_score ?? r?.score;
    if (!Number.isInteger(r?.index) || r.index < 0 || r.index >= passages.length ||
        scores[r.index] !== undefined || typeof score !== "number" || !Number.isFinite(score))
      throw new Error("重排结果的索引或分数无效");
    scores[r.index] = score;
  }
  return scores;
}

const lastCall = new WeakMap<App, { selected: string; lastMs: number; lastError: string | null }>();
/** Each provider scores the entire candidate list in input order. Only plugins have a local fallback. */
export async function rerankScores(app: App, query: string, candidates: RerankCandidate[],
  { timeoutMs, userId = OWNER, shared, config: cfg = app.config.rerank }: { timeoutMs?: number; userId?: string; shared?: SharedSearchAccess; config?: Config["rerank"] } = {}) {
  if (!cfg.enabled || !candidates.length || !query.trim()) return { scores: null, provider: null };
  const started = Date.now();
  const budget = Math.min(timeoutMs ?? Infinity, cfg.timeoutMs);
  const selected = cfg.provider;
  let provider = selected;
  const passages = candidates.map(c => c.text);
  let scores: number[] | null = null;
  let error: string | null = null;
  try {
    if (selected === "api") {
      if (candidates.every(pluginHitFilter(app, candidates, userId, shared)))
        scores = await apiScores(app, cfg, query, passages, budget);
    } else {
      const entry = selected.startsWith("plugin:") ? rerankers.get(selected.slice(7)) : undefined;
      if (entry && candidates.every(c => !entry.spaces.length || entry.spaces.includes(c.spaceId)) &&
          candidates.every(pluginHitFilter(app, candidates, userId, shared))) {
        scores = await pluginScores(app, entry, query, candidates, userId, Math.max(1, Math.floor(budget / 2)));
      }
      if (!scores) {
        provider = "local";
        scores = await builtinScores(app, query, passages, Math.max(0, started + budget - Date.now()), cfg);
      }
    }
  } catch (e) { error = (e as Error).message; }
  lastCall.set(app, { selected, lastMs: Date.now() - started, lastError: error ?? (scores ? null : stats.error || "重排未返回分数") });
  lastProvider.set(app, scores ? provider : null);
  return { scores, provider: scores ? provider : null };
}

async function builtinScores(app: App, query: string, passages: string[], timeoutMs?: number, cfg = app.config.rerank) {
  if (testScorer) return rerankLocally(app, query, passages, timeoutMs, cfg);
  const model = cfg.model;
  // osdk first (local-models.ts): while it is downloading a model nothing has fetched before, searches
  // keep their own order instead of starting a second download next to it.
  const src = modelSource(model);
  if (src.via === "hub" && src.osdk && src.known) {
    void prepareLocalModel(model);
    if (modelSource(model).syncing && !src.cached) {
      stats.state = "loading";
      return null;
    }
  }
  const budget = Math.min(cfg.timeoutMs, timeoutMs ?? Infinity);
  stats.calls++;
  if (!everReady.has(model)) stats.state = "loading";
  const start = performance.now();
  try {
    const scores = await searchStage("rerank", () => readProcess(app, "rerank").request<number[] | null>({ op: "rerank", query, passages, config: { rerank: cfg }, timeoutMs: budget }, budget));
    stats.lastMs = Math.round(performance.now() - start);
    if (scores) {
      everReady.add(model);
      stats.state = "ready";
      stats.error = "";
    } else stats.timeouts++;
    return scores;
  } catch (e) {
    const timedOut = (e as Error).name === "SearchTimeout";
    if (timedOut) stats.timeouts++;
    // The first calls can run out of time while the model is still being downloaded or loaded: that is
    // “loading”, not a failure. A model that does not load says so itself (read-worker.ts).
    if (timedOut && !everReady.has(model)) stats.state = "loading";
    else if (!timedOut) {
      stats.state = "failed";
      stats.error = (e as Error).message;
    }
    return null;
  }
}

export async function rerankLocally(app: App, query: string, passages: string[], timeoutMs?: number, cfg = app.config.rerank): Promise<number[] | null> {
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
  const entry = selectedReranker(app);
  const call = lastCall.get(app);
  const last = call?.selected === c.provider ? call : null;
  return { ...stats, enabled: c.enabled, provider: c.enabled ? c.provider : null, lastProvider: last ? lastProvider.get(app) : null,
    kind: c.provider.startsWith("plugin:") ? "plugin" : c.provider,
    plugin: entry?.plugin ?? null, name: entry?.def.label ?? null,
    model: c.provider === "api" ? c.api?.model : c.provider === "local" ? c.model : null,
    lastMs: last?.lastMs ?? 0, lastError: last?.lastError ?? null,
    ...(c.provider === "api" && { state: last ? last.lastError ? "failed" : "ready" : "idle", error: last?.lastError ?? "" }),
    source: c.provider === "local" ? modelSource(c.model) : null };

}

export const RERANK_TEST_QUERY = "哪个句子说明今天的天气？";
export const RERANK_TEST_DOCUMENTS = ["今天晴朗，适合散步。", "图书馆每周一开放。", "明天可能下雨。", "这是一次接口检测。"];
export async function testReranker(app: App, cfg: Config["rerank"]) {
  const entry = cfg.provider.startsWith("plugin:") ? rerankers.get(cfg.provider.slice(7)) : undefined;
  if (cfg.provider.startsWith("plugin:") && !entry) throw new Error("重排提供者不可用");
  const spaceId = entry?.spaces[0] ?? "personal";
  const candidates = RERANK_TEST_DOCUMENTS.map((text, i) => ({ id: String(i), type: "memory" as const, spaceId, text }));
  const { scores, provider } = await rerankScores(app, RERANK_TEST_QUERY, candidates, { config: { ...cfg, enabled: true } });
  if (!scores || provider !== cfg.provider) throw new Error(lastCall.get(app)?.lastError ?? "重排提供者未返回分数");
  return scores.map((score, index) => ({ index, score })).sort((a, b) => b.score - a.score);
}
/** Whether the model failed to load in this process (the read process tells the main one through an error). */
export const rerankLoadError = () => (stats.state === "failed" ? stats.error || "重排模型没有加载成功" : "");

/** Tests: a stand-in scorer (null turns it back to the model). */
export function setRerankerForTests(score: ((query: string, passages: string[]) => number[]) | null) {
  testScorer = score ? { key: "test", score: async (q, p) => score(q, p) } : null;
}
