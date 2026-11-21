/**
 * 设置 → 检索与记忆 的向量和重排两张卡（components/EmbeddingSettings.vue、RerankSettings.vue）：把配置
 * （src/core/config.ts 的 `embeddings`、`rerank`）读成可编辑的草稿，再写回 `PUT /api/settings` 和两个检测接口
 * 要的形状；换向量模型时服务端回 409 带的数字写成一句话。纯函数，不碰页面。
 */

export const LOCAL_EMBEDDING_MODEL = "Xenova/bge-small-zh-v1.5";
export const DEFAULT_KEY_ENV = "OPENAI_API_KEY";

export type EmbeddingSource = "none" | "local" | "api" | "plugin";
export type EmbeddingConfig = {
  provider: string; model?: string; url?: string; keyRef?: string; apiKeyEnv?: string;
  timeoutMs?: number; dimensions?: number; batch?: number;
};
/** A plugin's vector provider as `GET /api/search/providers` lists it (`id` is `plugin:<插件>:<名字>`). */
export type EmbedderInfo = { id: string; name: string; model?: string; dimensions?: number; plugin: string; spaces?: string[] };
export type EmbeddingDraft = {
  source: EmbeddingSource;
  localModel: string; apiModel: string; url: string;
  /** An AI provider's id (设置 → AI), or "" for an environment variable. */
  key: string; apiKeyEnv: string;
  dimensions: string; batch: number; timeoutSec: number;
  plugin: string;
};

export function sourceOf(provider: string | undefined): EmbeddingSource {
  if (!provider || provider === "none") return "none";
  if (provider === "local") return "local";
  if (provider.startsWith("plugin:")) return "plugin";
  return "api";
}

export function embeddingDraft(c: EmbeddingConfig, embedders: EmbedderInfo[] = []): EmbeddingDraft {
  const source = sourceOf(c.provider);
  return {
    source,
    localModel: source === "local" || source === "none" ? c.model || LOCAL_EMBEDDING_MODEL : LOCAL_EMBEDDING_MODEL,
    apiModel: source === "api" ? c.model ?? "" : "",
    url: c.url ?? "",
    key: c.keyRef ?? "",
    apiKeyEnv: c.apiKeyEnv || DEFAULT_KEY_ENV,
    dimensions: c.dimensions ? String(c.dimensions) : "",
    batch: c.batch ?? 32,
    timeoutSec: Math.max(1, Math.round((c.timeoutMs ?? 5000) / 1000)),
    plugin: source === "plugin" ? c.provider : embedders[0]?.id ?? "",
  };
}

/**
 * What `PUT /api/settings` gets under `embeddings` (and the test endpoint as is). Cleared optional fields are
 * sent as null: the server drops them (src/auth/settings-sections.ts) instead of keeping the old value.
 */
export function embeddingPatch(d: EmbeddingDraft): Record<string, unknown> {
  if (d.source === "none") return { provider: "none" };
  if (d.source === "local") return { provider: "local", model: d.localModel.trim() || LOCAL_EMBEDDING_MODEL };
  if (d.source === "plugin") return { provider: d.plugin };
  const dims = Number(d.dimensions);
  return {
    provider: "api", model: d.apiModel.trim(), url: d.url.trim() || null, keyRef: d.key || null,
    apiKeyEnv: d.apiKeyEnv.trim() || DEFAULT_KEY_ENV,
    dimensions: d.dimensions.trim() && Number.isInteger(dims) && dims > 0 ? dims : null,
    batch: clamp(d.batch, 1, 256, 32), timeoutMs: clamp(d.timeoutSec, 1, 120, 5) * 1000,
  };
}

/** Why the draft cannot be saved or tried yet; "" when it can. */
export function embeddingProblem(d: EmbeddingDraft): string {
  if (d.source === "plugin" && !d.plugin) return "先选一个插件的向量提供者";
  if (d.source !== "api") return "";
  if (!d.apiModel.trim()) return "填模型名";
  if (d.url.trim() && !/^https?:\/\/[^\s/]+/i.test(d.url.trim())) return "接口地址要以 http:// 或 https:// 开头";
  if (d.dimensions.trim() && !(Number.isInteger(Number(d.dimensions)) && Number(d.dimensions) > 0)) return "维度是正整数，不知道就空着";
  return "";
}

export const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The 409 of `PUT /api/settings` when the vector model would change (src/search/embedding-index.ts `modelChange`). */
export type ModelChange = { confirmation: "embedding-model"; pending: number; clear: number; rebuild: number; token: string; to?: string };
export function isModelChange(v: unknown): v is ModelChange {
  const x = v as Partial<ModelChange> | null;
  return !!x && x.confirmation === "embedding-model" && typeof x.token === "string";
}
export function modelChangeMessage(c: Pick<ModelChange, "clear" | "rebuild">, scoped = false): string {
  const n = (v: number) => v.toLocaleString("zh-CN");
  const clear = c.clear ? `会清掉现有的 ${n(c.clear)} 个向量` : "现在还没有向量";
  const rebuild = c.rebuild ? `，再按新模型重算 ${n(c.rebuild)} 条${scoped ? "（只算这个提供者获准的空间）" : ""}` : "";
  return `${clear}${rebuild}。重算完之前向量检索用不了，全文检索照常。`;
}

/** `GET /api/search/providers` → `embeddings` (src/search/embeddings.ts `embeddingStatus`). */
export type EmbeddingStatus = {
  provider: string; kind: string; model: string | null; dimensions: number | null; plugin: string | null; name: string | null;
  lastMs: number; lastError: string | null; writeError?: string; pausedUntil?: number;
  pending: number; excludedSpaces: string[]; excludedReason: string | null;
  /** Vectors already stored: original chunks and active memories, and the two together. */
  embedded?: { chunks: number; memories: number; total: number };
  state: "off" | "unavailable" | "model-changed" | "paused" | "failed" | "ready" | "idle";
};
/** `title`: the stored vectors split into originals and memories, for hovering over the line. */
export function embeddingStatusLine(s: EmbeddingStatus | null | undefined): { text: string; bad: boolean; title?: string } {
  if (!s || s.state === "off") return { text: "", bad: false };
  const what = [s.name || s.model, s.dimensions && `${s.dimensions} 维`].filter(Boolean).join(" · ");
  const n = (v: number) => v.toLocaleString("zh-CN");
  const pending = s.pending ? `，还有 ${n(s.pending)} 条没算向量，后台在补` : "";
  const have = s.embedded ? `，已有 ${n(s.embedded.total)} 个向量` : "";
  const title = s.embedded ? `原件分块 ${n(s.embedded.chunks)} 个，记忆 ${n(s.embedded.memories)} 个` : undefined;
  switch (s.state) {
    case "unavailable": return { text: "插件的向量提供者现在不可用（插件停了或没注册），这期间只用全文检索", bad: true };
    case "model-changed": return { text: "插件换了模型或维度：保存一次并确认重建，之前向量检索不用它", bad: true };
    case "paused": return { text: `写入向量暂停了：${s.writeError ?? s.lastError ?? ""}`, bad: true };
    case "failed": return { text: `最近一次调用出错：${s.lastError}${have}${pending}`, bad: true, title };
    case "ready": return { text: `在用 ${what}${s.lastMs ? `，上一次 ${s.lastMs} ms` : ""}${have}${pending}`, bad: false, title };
    default: return { text: `${what ? `${what}，` : ""}还没用过${have}${pending}`, bad: false, title };
  }
}

/** “只用于这些空间：示例商城、退款” for a provider granted only some spaces; “” when it may read all. */
export function spacesLine(spaces: string[] | undefined, names: Map<string, string>): string {
  if (!spaces?.length) return "";
  return `只用于这些空间：${spaces.map((id) => names.get(id) ?? id).join("、")}`;
}

export type RerankSource = "local" | "api" | "plugin";
export type RerankApi = { url?: string; keyRef?: string; apiKeyEnv?: string; timeoutMs?: number; model?: string };
export type RerankConfig = { enabled: boolean; provider: string; api?: RerankApi; model: string; top: number };
export type RerankDraft = { source: RerankSource; plugin: string; url: string; model: string; key: string; apiKeyEnv: string; timeoutSec: number };
/** A plugin's reranker as `GET /api/search/providers` lists it (`id` is `<插件>:<名字>`, chosen as `plugin:<id>`). */
export type RerankerInfo = { id: string; label: string; plugin: string; spaces?: string[]; lastMs: number | null; lastError: string | null };

export function rerankDraft(c: RerankConfig, rerankers: RerankerInfo[] = []): RerankDraft {
  const source: RerankSource = c.provider === "api" ? "api" : c.provider.startsWith("plugin:") ? "plugin" : "local";
  return {
    source, plugin: source === "plugin" ? c.provider : rerankers[0] ? `plugin:${rerankers[0].id}` : "",
    url: c.api?.url ?? "", model: c.api?.model ?? "", key: c.api?.keyRef ?? "", apiKeyEnv: c.api?.apiKeyEnv || DEFAULT_KEY_ENV,
    timeoutSec: Math.max(1, Math.round((c.api?.timeoutMs ?? 5000) / 1000)),
  };
}
/** The part of `rerank` the draft changes (the whole `api` object is replaced when it is sent). */
export function rerankPatch(d: RerankDraft): Record<string, unknown> {
  if (d.source === "local") return { provider: "local" };
  if (d.source === "plugin") return { provider: d.plugin };
  const api: RerankApi = { model: d.model.trim(), apiKeyEnv: d.apiKeyEnv.trim() || DEFAULT_KEY_ENV, timeoutMs: clamp(d.timeoutSec, 1, 120, 5) * 1000 };
  if (d.url.trim()) api.url = d.url.trim();
  if (d.key) api.keyRef = d.key;
  return { provider: "api", api };
}
export function rerankProblem(d: RerankDraft): string {
  if (d.source === "plugin" && !d.plugin) return "先选一个插件的重排";
  if (d.source !== "api") return "";
  if (!d.model.trim()) return "填模型名";
  if (d.url.trim() && !/^https?:\/\/[^\s/]+/i.test(d.url.trim())) return "接口地址要以 http:// 或 https:// 开头";
  return "";
}
/** The scores the test endpoint returned (sorted high to low; `index` is the test sentence). */
export function rerankScoresText(results: { index: number; score: number }[]): string {
  if (!results.length) return "没有返回分数";
  const top = results[0];
  const fmt = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(3));
  return `返回 ${results.length} 个分数，最高 ${fmt(top.score)}（检测句里的第 ${top.index + 1} 句）、最低 ${fmt(results.at(-1)!.score)}`;
}

function clamp(v: number, min: number, max: number, fallback: number) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : fallback;
}
