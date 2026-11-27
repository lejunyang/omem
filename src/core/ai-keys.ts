import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AgentProfile, Config } from "./config.ts";
import { keyedModelEnv, omemHome, useListedModels } from "./config.ts";
import { relayToken } from "./ai-relay-addr.ts";
import { classifyError, type ErrorKind } from "./ai-errors.ts";
import type { App } from "./app.ts";
import { estimatedAiTokens, MINUTE_LIMIT_EXHAUSTED, requestWithAiLimit, settleAiUsage } from "./ai-request.ts";

/**
 * API keys of the AI providers (`ai.providers`), in secrets/ai-keys.json beside the other secrets:
 * not in config.json, not in a snapshot or a pull, never sent to the web (only the last 4 characters).
 * Agents launched with such a key (`keyRef`) get it as their vendor's environment variable.
 */
type Provider = Config["ai"]["providers"][number];

const fileIn = (home: string) => join(home, "secrets", "ai-keys.json");
/** The data directory whose keys launches use: set by the App (one per service), tests set their own. */
let keyHome: string | undefined;
export function useKeyHome(home: string) {
  keyHome = resolve(home);
}

export function readKeys(home = keyHome ?? omemHome()): Record<string, string> {
  try {
    const v = JSON.parse(readFileSync(fileIn(home), "utf8"));
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

export function keyOf(id: string, home?: string) {
  return readKeys(home)[id] || "";
}

export function setKey(home: string, id: string, key: string | null) {
  const keys = readKeys(home);
  if (key) keys[id] = key.trim();
  else delete keys[id];
  mkdirSync(join(home, "secrets"), { recursive: true, mode: 0o700 });
  const file = fileIn(home);
  writeFileSync(file, JSON.stringify(keys, null, 2) + "\n", { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {}
}

/** What the web may see of a key. */
export const keyHint = (key: string) => (key ? `…${key.slice(-4)}` : "");

/** Environment variables a provider's key goes in, by provider kind. */
export function keyVars(kind: string, key: string, baseUrl?: string): Record<string, string> {
  if (kind === "anthropic") return { ANTHROPIC_API_KEY: key, ...(baseUrl ? { ANTHROPIC_BASE_URL: baseUrl } : {}) };
  // codex-acp reads CODEX_API_KEY first and OPENAI_API_KEY as a fallback; `codex exec` reads CODEX_API_KEY.
  if (kind === "openai") return { CODEX_API_KEY: key, OPENAI_API_KEY: key, ...(baseUrl ? { OPENAI_BASE_URL: baseUrl } : {}) };
  return {};
}

/**
 * Extra environment for launching a profile: its provider's key, or nothing. A keyed profile whose
 * key is gone fails here rather than silently falling back to the login on this machine. (Addresses
 * and models are not secret and are already in the profile's env: config.ts `keyedProfiles`, which
 * also names the variables the key goes in.)
 */
export function keyEnv(profile: Pick<AgentProfile, "keyRef" | "id" | "command"> & Partial<Pick<AgentProfile, "model" | "env" | "keyModels">> & { keyVars?: string[]; keyRelay?: boolean }, clientToken?: string): Record<string, string> {
  if (!profile.keyRef) return {};
  const key = keyOf(profile.keyRef);
  if (!key) throw new Error(`后端 ${profile.id} 用的 API key（${profile.keyRef}）还没有填写：设置 → 后端与模型 → API key`);
  // Through the relay the agent holds the relay's token; omem adds the key on the way out.
  const value = profile.keyRelay ? clientToken ?? relayToken(profile.id) : key;
  // A third party's key: the model this run is on goes in at launch too (config.ts keyedModelEnv), and Codex /
  // Claude Code get a config directory of their own (thirdPartyHome) so nothing they do reaches their vendor.
  if (profile.keyVars?.length) return { ...keyedModelEnv(profile), ...thirdPartyHome(profile), ...Object.fromEntries(profile.keyVars.map((v) => [v, value])) };
  const s = `${profile.id} ${profile.command}`;
  return keyVars(/claude/.test(s) ? "anthropic" : /codex/.test(s) ? "openai" : "", key);
}

/**
 * Codex on a third party's key: a CODEX_HOME of its own (`agents/keyed/<backend>` in the data
 * directory), its config.toml turning off what Codex fetches from OpenAI and GitHub besides the
 * model (the plugin marketplace sync from github.com, the model catalog, analytics and the update
 * check, all to chatgpt.com / github.com; checked 2026-11-27 with codex 0.169 through a logging
 * proxy: none left). It also keeps these runs out of the owner's own ~/.codex and its login.
 * codex-acp passes only hooks from CODEX_CONFIG to the app server at start, so this has to be a file.
 */
/**
 * Claude Code the same way: CLAUDE_CONFIG_DIR of its own whose settings.json skips WebFetch's domain check
 * (a call to api.anthropic.com before each fetch; with CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC the rest is
 * already quiet). WebSearch is a server tool of the Anthropic format: Ark runs it (checked 2026-11-27).
 */
const KEYED_CLAUDE_SETTINGS = JSON.stringify({ skipWebFetchPreflight: true }, null, 2) + "\n";
const KEYED_CODEX_TOML = ["# Written by omem for Codex on a third party's API key: nothing beyond the model's own API.", "check_for_update_on_startup = false", "", "[analytics]", "enabled = false", "", "[features]", "plugins = false", "remote_models = false", ""].join("\n");
function thirdPartyHome(profile: Pick<AgentProfile, "id" | "command"> & { keyModels?: string[] }): Record<string, string> {
  const codex = /^codex/.test(profile.id);
  if (!profile.keyModels || !(codex || /^claude/.test(profile.id))) return {};
  const dir = join(keyHome ?? omemHome(), "agents", "keyed", profile.id.replace(/[^\w@.-]/g, "_"));
  mkdirSync(dir, { recursive: true });
  const [name, text] = codex ? ["config.toml", KEYED_CODEX_TOML] : ["settings.json", KEYED_CLAUDE_SETTINGS];
  const file = join(dir, name);
  if (!existsSync(file) || readFileSync(file, "utf8") !== text) writeFileSync(file, text);
  return codex ? { CODEX_HOME: dir } : { CLAUDE_CONFIG_DIR: dir };
}

export const DEFAULT_BASE: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
  typesafe: "https://api.typesafe.ai",
  openrouter: "https://openrouter.ai/api",
  ark: "https://ark.cn-beijing.volces.com/api/v3",
};
/**
 * Where a provider's API is. Cloudflare's is per account: Workers AI under
 * `…/accounts/<账号>/ai` (a custom base replaces that whole prefix), empty without an account.
 */
export const baseOf = (p: Pick<Provider, "kind" | "baseUrl"> & { accountId?: string }) => {
  if (p.baseUrl) return p.baseUrl.replace(/\/+$/, "");
  if (p.kind === "cloudflare") return p.accountId ? `https://api.cloudflare.com/client/v4/accounts/${p.accountId}/ai` : "";
  return (DEFAULT_BASE[p.kind] || "").replace(/\/+$/, "");
};

/**
 * Check a provider's key with a request that costs nothing (list models / the key's own info).
 * TypeSafe has no such endpoint we know of: the key's presence is all that is checked.
 */
export async function testProvider(p: Provider, key: string, fetcher: typeof fetch = fetch): Promise<{ ok: boolean; detail: string }> {
  if (!key) return { ok: false, detail: "还没有填写 API key" };
  const base = baseOf(p);
  let url: string;
  let headers: Record<string, string>;
  if (p.kind === "anthropic") {
    url = `${base}/v1/models`;
    headers = { "x-api-key": key, "anthropic-version": "2023-06-01" };
  } else if (p.kind === "openrouter") {
    url = `${base}/v1/key`;
    headers = { authorization: `Bearer ${key}` };
  } else if (p.kind === "cloudflare") {
    if (!base) return { ok: false, detail: "Cloudflare 要填写账号 ID" };
    // Listing the account's Workers AI models is free and checks both the token and the account.
    url = `${base}/models/search?search=clef&per_page=1`;
    headers = { authorization: `Bearer ${key}` };
  } else if (p.kind === "typesafe") {
    return { ok: true, detail: "已填写（TypeSafe 没有免费的检查接口，第一次判断时才知道是否可用）" };
  } else {
    if (!base) return { ok: false, detail: "OpenAI 兼容的提供方要填写接口地址" };
    // Ark and OpenAI-compatible services: listing the models is free and checks the key.
    url = `${base}/models`;
    headers = { authorization: `Bearer ${key}` };
  }
  try {
    const r = await fetcher(url, { headers, signal: AbortSignal.timeout(15_000) });
    if (r.ok) return { ok: true, detail: "可用" };
    const text = (await r.text().catch(() => "")).slice(0, 200);
    return { ok: false, detail: `${r.status}${r.status === 401 || r.status === 403 ? "（key 无效或没有权限）" : ""}${text ? `：${text}` : ""}` };
  } catch (e) {
    return { ok: false, detail: `连不上 ${new URL(url).host}：${(e as Error).message}` };
  }
}

/**
 * A third-party service's Anthropic-shaped address, when it answers a model listing there (free):
 * Volcengine Ark's sits beside its OpenAI one (`…/api/v3` → `…/api/compatible`), others under
 * `/anthropic` or at the same root. Null when none answers; it can still be filled in by hand.
 */
export async function findAnthropicUrl(baseUrl: string, key: string, fetcher: typeof fetch = fetch): Promise<string | null> {
  const base = baseUrl.replace(/\/+$/, "");
  const root = base.replace(/\/v\d+$/, "");
  const candidates = [...new Set([...(root !== base ? [`${root}/compatible`] : []), `${root}/anthropic`, root])];
  for (const c of candidates) {
    try {
      const r = await fetcher(`${c}/v1/models`, { headers: { authorization: `Bearer ${key}`, "x-api-key": key, "anthropic-version": "2023-06-01" }, signal: AbortSignal.timeout(8_000) });
      if (!r.ok) continue;
      const body = (await r.json().catch(() => null)) as { data?: unknown } | null;
      if (body && Array.isArray(body.data)) return c;
    } catch {}
  }
  return null;
}

/**
 * Whether the model the backends of a third-party key run on answers, in each format they use: one
 * reply of at most one token. Services often list models the account cannot call by that name (Ark
 * accounts that must use an endpoint ID): this is where that shows.
 */
export async function tryBackendModel(p: Pick<Provider, "baseUrl" | "anthropicUrl" | "model">, key: string, fetcher: typeof fetch = fetch, kind = "openai-compatible", rate?: { app: App; provider: Provider }): Promise<{ ok: boolean; detail: string; endpointOnly?: boolean; served?: string }> {
  if (!p.model) return { ok: false, detail: "还没有填写后端用的模型" };
  const calls: [string, string, Record<string, string>, Record<string, unknown>][] = [];
  if (p.baseUrl) calls.push(["OpenAI 格式", `${p.baseUrl.replace(/\/+$/, "")}/chat/completions`, { authorization: `Bearer ${key}` }, { model: p.model, messages: [{ role: "user", content: "ping" }], max_tokens: 1 }]);
  if (p.anthropicUrl) calls.push(["Anthropic 格式", `${p.anthropicUrl.replace(/\/+$/, "")}/v1/messages`, { authorization: `Bearer ${key}`, "x-api-key": key, "anthropic-version": "2023-06-01" }, { model: p.model, messages: [{ role: "user", content: "ping" }], max_tokens: 1 }]);
  const bad: string[] = [];
  let endpointOnly: boolean | undefined, served: string | undefined;
  for (const [label, url, headers, body] of calls) {
    try {
      const encoded = JSON.stringify(body);
      const send = () => fetcher(url, {
        method: "POST", headers: { ...headers, "content-type": "application/json" },
        body: encoded, signal: AbortSignal.timeout(30_000),
      });
      const { response: r, errorText, settle, minuteRetriesExhausted } = rate
        ? await requestWithAiLimit(rate.app, rate.provider, p.model, () => estimatedAiTokens(encoded, body), {}, send)
        : { response: await send() };
      const text = errorText ?? await r.text().catch(() => "");
      if (r.ok) {
        // The name it answered as: for an endpoint ID, the model behind it.
        try {
          const payload = JSON.parse(text);
          settleAiUsage(settle, payload);
          served ??= String(payload.model ?? "") || undefined;
        } catch {}
        continue;
      }
      const c = classifyError(kind, r.status, text);
      // Model names refused, endpoint IDs only (Ark's ModelIDAccessDisabled): a fact about the key, not this model.
      if (/ModelIDAccessDisabled|use a custom endpoint ID/i.test(`${c.code} ${c.message}`)) {
        endpointOnly = true;
        bad.push(`${label}：这个 key 不能直接用模型名，只能用接入点 ID`);
        continue;
      }
      const msg = `${c.code ? `${c.code}：` : ""}${c.message}`;
      bad.push(`${label} ${r.status}${msg ? `：${msg}` : ""}（${ERROR_WORD[c.kind]}）${minuteRetriesExhausted ? MINUTE_LIMIT_EXHAUSTED : ""}`);
    } catch (e) {
      bad.push(`${label}连不上：${(e as Error).message}`);
    }
  }
  const more = { ...(endpointOnly ? { endpointOnly } : {}), ...(served ? { served } : {}) };
  return bad.length ? { ok: false, detail: `模型 ${p.model} 调不通（${[...new Set(bad)].join("；")}）`, ...more } : { ok: true, detail: `模型 ${p.model} 可以调用${served && served !== p.model ? `（背后是 ${served}）` : ""}`, ...more };
}
/** The kinds of provider error (core/ai-errors.ts) in a few words. */
export const ERROR_WORD: Record<ErrorKind, string> = { rate: "限流，稍后自动恢复", daily: "今天的用量到上限了", quota: "额度用完或欠费", auth: "key 被拒绝", config: "模型或接入点不对", server: "提供方出错", input: "这次请求被拒", other: "其他错误" };

export type Category = "voice" | "decision" | "image";
/** Which provider kinds can serve a category. startlux (decision) is the local judge, not a provider. */
export const CATEGORY_KINDS: Record<Category, string[]> = {
  voice: ["openai", "openai-compatible"],
  decision: ["openai", "typesafe", "openrouter", "cloudflare"],
  image: ["openai", "openai-compatible"],
};
/** Model a category uses when none is set, by provider kind (as of 2026-11). */
export function defaultModel(cat: Category, kind: string, api?: string) {
  if (cat === "voice") return api === "realtime" ? "gpt-realtime-2.1" : "gpt-live-1";
  if (cat === "image") return "gpt-image-2.6-flare";
  if (kind === "openai") return "gpt-6-luna";
  if (kind === "typesafe") return "jev-latest";
  if (kind === "openrouter") return "jev-latest";
  if (kind === "cloudflare") return "clef-flash";
  return "";
}

/** Media a decision model reads besides text and JSON. Only Cloudflare's Clef family says so (2026-11). */
export type DecisionMedia = "images" | "audio" | "videos";
export function decisionMedia(kind: string, model: string): DecisionMedia[] {
  if (kind !== "cloudflare") return [];
  const m = clefModel(model);
  if (m === "clef-omni") return ["images", "audio", "videos"];
  if (m === "clef" || m === "clef-flash") return ["images"];
  return [];
}
/** Clef's `model` selector from what the user wrote (`clef-omni` or `@cf/cloudflare/clef-omni`). */
export const clefModel = (model: string) => model.trim().replace(/^@cf\/cloudflare\//, "");

/**
 * Whether a category is usable: a provider of a fitting kind with a key (for decision also the local
 * StartLux judge). Features and their skills turn on only when this says ready.
 */
export type CategoryStatus = { ready: boolean; detail: string; provider?: string; model?: string; media?: DecisionMedia[] };

export function categoryStatus(config: Config, cat: Category, home?: string): CategoryStatus {
  if (cat !== "decision") return statusOf(config, cat, config.ai[cat], home);
  // Several decision models may be named: usable when any of them is. Says which one is asked first
  // (core/decision.ts decides the order per call) and how many more stand behind it.
  const all = decisionStatuses(config, home);
  if (!all.length) return { ready: false, detail: "没有选择提供方" };
  const ok = all.filter((s) => s.ready);
  if (!ok.length) return all[0];
  const media = [...new Set(ok.flatMap((s) => s.media ?? []))];
  return { ...ok[0], detail: ok.length > 1 ? `${ok[0].detail} 等 ${ok.length} 个` : ok[0].detail, ...(media.length ? { media } : {}) };
}

export type DecisionChoice = { provider: string; model: string };

/** The decision models settings name, the first one first, each once (config.ai.decision). */
export function decisionChoices(config: Config): DecisionChoice[] {
  const d = config.ai.decision;
  const seen = new Set<string>();
  return [{ provider: d.provider, model: d.model }, ...(d.others ?? [])].filter((c) => {
    const k = `${c.provider}\n${c.model}`;
    if (!c.provider || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Whether one decision model (named in settings or not yet) is usable now. */
export const decisionStatus = (config: Config, c: DecisionChoice, home?: string): CategoryStatus & DecisionChoice => {
  const s = statusOf(config, "decision", c, home);
  return { ...s, provider: c.provider, model: s.model ?? c.model };
};

/** Each named decision model and whether it is usable now, in the order settings list them. */
export function decisionStatuses(config: Config, home?: string): (CategoryStatus & DecisionChoice)[] {
  return decisionChoices(config).map((c) => {
    const s = statusOf(config, "decision", c, home);
    // `model` is the one that will be asked: the provider's default when settings leave it empty.
    return { ...s, provider: c.provider, model: s.model ?? c.model };
  });
}

function statusOf(config: Config, cat: Category, c: { provider: string; model: string; api?: string }, home?: string): CategoryStatus {
  if (cat === "decision" && c.provider === "startlux") {
    const g = config.guard;
    const ready = g.provider === "startlux" && !!(g.url || g.modelDir);
    return { ready, detail: ready ? "本地 StartLux-Decision" : "本地判官还没装好：终端运行 omem setup → 注入标记", provider: "startlux", model: "StartLux-Decision" };
  }
  if (!c.provider) return { ready: false, detail: "没有选择提供方" };
  const p = config.ai.providers.find((x) => x.id === c.provider);
  if (!p) return { ready: false, detail: `提供方 ${c.provider} 不存在` };
  if (!CATEGORY_KINDS[cat].includes(p.kind)) return { ready: false, detail: `${p.name || p.id} 不提供这类模型` };
  if (!keyOf(p.id, home)) return { ready: false, detail: `${p.name || p.id} 还没有填写 API key` };
  if (p.kind === "cloudflare" && !baseOf(p)) return { ready: false, detail: `${p.name || p.id} 还没有填写 Cloudflare 账号 ID` };
  const field: ModelField = cat === "voice" ? (c.api === "realtime" ? "voice.realtime" : "voice.live") : cat;
  const model = c.model || (home ? modelChoices(home, p, field).default : builtinDefault(field, p.kind));
  if (!model) return { ready: false, detail: "要填写模型" };
  const media = cat === "decision" ? decisionMedia(p.kind, model) : [];
  return { ready: true, detail: `${p.name || p.id} · ${model}`, provider: p.id, model, ...(media.length ? { media } : {}) };
}

// ------------------------------------------------------------------ detected models

/**
 * What each provider says it serves (`GET /models` and the like), cached in cache/ai-models.json
 * (model names only, nothing secret) and refreshed when the key is added, checked, or the list is a
 * day old. Settings offer these per field; a field left empty uses the newest listed one (`newestOf`),
 * the built-in default only when nothing fitting is listed.
 */
export type ModelField = "image" | "voice.live" | "voice.realtime" | "voice.transcribe" | "voice.delegate" | "decision";
/**
 * What a listing says about one model, when it says anything (Volcengine Ark and the like do, OpenAI
 * does not): the API formats it answers (`chat` = Chat Completions, `responses`, `anthropic` =
 * Messages), what it is for (`LLM`, `ImageGeneration`…), and whether it calls tools.
 */
/** What a listing says about one model: API formats, domain, tool calls, and the thinking levels it takes (default first). */
export type ModelInfo = { formats?: ("chat" | "responses" | "anthropic")[]; type?: string; tools?: boolean; efforts?: string[]; context?: number; inputs?: string[] };
/**
 * One key's listing, and what calling it taught: `endpointOnly` when the provider refuses model names
 * and takes only endpoint IDs (Ark: `ModelIDAccessDisabled`), `endpoints` the listed model each
 * endpoint answered as (its levels and formats come from there).
 */
type ModelCache = Record<string, { at: number; models: string[]; info?: Record<string, ModelInfo>; error?: string; endpointOnly?: boolean; endpoints?: Record<string, string> }>;
const cacheFile = (home: string) => join(home, "cache", "ai-models.json");
/** The listing kept for each key, for config.ts to pick a key's backend models from; read again when the file changes. */
let listedMemo: { file: string; mtime: number; cache: ModelCache } | null = null;
/** The name to show for a model: an endpoint ID (`ep-…`) means nothing, the listed model it answered as does. */
export function modelDisplayName(model: string | undefined | null): string {
  if (!model) return model ?? "";
  const cache = listedCache();
  for (const e of Object.values(cache ?? {})) if (e.endpoints?.[model]) return e.endpoints[model];
  return model;
}
function listedCache(): ModelCache | null {
  const file = cacheFile(keyHome ?? omemHome());
  let mtime = 0;
  try { mtime = statSync(file).mtimeMs; } catch { return null; }
  if (!listedMemo || listedMemo.file !== file || listedMemo.mtime !== mtime) listedMemo = { file, mtime, cache: readModelCache(keyHome ?? omemHome()) };
  return listedMemo.cache;
}
useListedModels((provider) => {
  const e = listedCache()?.[provider];
  return e && !e.error ? { models: e.models, info: e.info, endpointOnly: e.endpointOnly, endpoints: e.endpoints } : null;
});
export function readModelCache(home: string): ModelCache {
  try {
    const v = JSON.parse(readFileSync(cacheFile(home), "utf8"));
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}
function writeModelCache(home: string, c: ModelCache) {
  mkdirSync(join(home, "cache"), { recursive: true });
  writeFileSync(cacheFile(home), JSON.stringify(c, null, 2) + "\n");
}
export const MODEL_CACHE_MS = 24 * 3600_000;

let listFetch: typeof fetch = (...a) => fetch(...a);
/** Tests replace the network for model listing. */
export function setModelListFetchForTests(f: typeof fetch | null) {
  listFetch = f ?? ((...a) => fetch(...a));
}

type Listed = { id?: string; name?: string; domain?: string; api_supported?: Record<string, boolean>; features?: { tools?: { function_calling?: boolean } }; effort?: { default_level?: string; supported_levels?: string[] }; context_window?: number; token_limits?: { context_window?: number }; modalities?: { input_modalities?: string[] } };
const contextOf = (m: Listed) => { const n = Number(m.token_limits?.context_window ?? m.context_window); return Number.isFinite(n) && n > 0 ? n : 0; };
const LEVEL_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
/** A listing's thinking levels in the usual order (Ark lists `effort.supported_levels`). */
const levelsOf = (e: Listed["effort"]) => [...new Set((e?.supported_levels ?? []).map(String))].sort((a, b) => (LEVEL_ORDER.indexOf(a) + 1 || 99) - (LEVEL_ORDER.indexOf(b) + 1 || 99));
const FORMAT_OF: Record<string, "chat" | "responses" | "anthropic"> = { "chat/completions": "chat", responses: "responses", messages: "anthropic" };

/** Models a provider lists, with what the listing says about each; null when it has no listing we know of (TypeSafe, Anthropic here). */
export async function listModelEntries(p: Provider, key: string, fetcher: typeof fetch = listFetch): Promise<{ models: string[]; info: Record<string, ModelInfo> } | null> {
  const base = baseOf(p);
  let url: string;
  if (p.kind === "openai" || p.kind === "openai-compatible" || p.kind === "ark") url = `${base}/models`;
  else if (p.kind === "openrouter") url = `${base}/v1/models`;
  else if (p.kind === "cloudflare") url = `${base}/models/search?search=clef&per_page=50`;
  else return null;
  if (!base || !key) return null;
  const r = await fetcher(url, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`${r.status}：${(await r.text().catch(() => "")).slice(0, 200)}`);
  const body = (await r.json()) as { data?: Listed[]; result?: { name?: string }[] };
  if (p.kind === "cloudflare") return { models: [...new Set((body.result ?? []).map((m) => clefModel(String(m.name ?? ""))).filter(Boolean))].sort(), info: {} };
  const info: Record<string, ModelInfo> = {};
  for (const m of body.data ?? []) {
    const id = String(m.id ?? "");
    if (!id) continue;
    const formats = m.api_supported ? Object.entries(m.api_supported).flatMap(([k, on]) => (on && FORMAT_OF[k] ? [FORMAT_OF[k]] : [])) : [];
    const one: ModelInfo = { ...(formats.length ? { formats } : {}), ...(m.domain ? { type: m.domain } : {}), ...(m.features?.tools?.function_calling !== undefined ? { tools: !!m.features.tools.function_calling } : {}), ...(levelsOf(m.effort).length ? { efforts: levelsOf(m.effort) } : {}), ...(contextOf(m) ? { context: contextOf(m) } : {}), ...(m.modalities?.input_modalities?.length ? { inputs: m.modalities.input_modalities.map(String) } : {}) };
    if (Object.keys(one).length) info[id] = one;
  }
  return { models: [...new Set((body.data ?? []).map((m) => String(m.id ?? "")).filter(Boolean))].sort(), info };
}
export async function listModels(p: Provider, key: string, fetcher: typeof fetch = listFetch): Promise<string[] | null> {
  return (await listModelEntries(p, key, fetcher))?.models ?? null;
}

/** Refresh one provider's cached list; failures are kept (with the old list) for the settings page. */
const learned = (old: ModelCache[string] | undefined) => ({ ...(old?.endpointOnly !== undefined ? { endpointOnly: old.endpointOnly } : {}), ...(old?.endpoints ? { endpoints: old.endpoints } : {}) });

/**
 * What a check's calls showed about a key (`tryBackendModel`): whether model names are refused, and
 * the listed model behind each endpoint that answered (matched by the name it answered with).
 */
export function noteModelAccess(home: string, provider: string, seen: { endpointOnly?: boolean; served?: [string, string][] }) {
  const c = readModelCache(home);
  const e = c[provider];
  if (!e) return;
  if (seen.endpointOnly !== undefined) e.endpointOnly = seen.endpointOnly;
  for (const [asked, answered] of seen.served ?? []) {
    if (e.models.includes(asked)) continue;
    const listed = e.models.includes(answered) ? answered : [...e.models].sort((a, b) => b.length - a.length).find((m) => answered.startsWith(m));
    if (listed) e.endpoints = { ...e.endpoints, [asked]: listed };
  }
  writeModelCache(home, c);
}

export async function refreshModels(home: string, p: Provider, fetcher: typeof fetch = listFetch) {
  const key = keyOf(p.id, home);
  const old = readModelCache(home)[p.id];
  let entry: ModelCache[string] | null;
  try {
    const listed = await listModelEntries(p, key, fetcher);
    entry = listed ? { at: Date.now(), models: listed.models, ...(Object.keys(listed.info).length ? { info: listed.info } : {}), ...learned(old) } : null;
  } catch (e) {
    entry = { at: Date.now(), models: old?.models ?? [], ...(old?.info ? { info: old.info } : {}), ...learned(old), error: (e as Error).message.slice(0, 200) };
  }
  const c = readModelCache(home);
  if (entry) c[p.id] = entry;
  else delete c[p.id];
  writeModelCache(home, c);
  return entry;
}

const FIELD_FILTER: Record<ModelField, (m: string, kind: string) => boolean> = {
  image: (m) => /^gpt-image-/.test(m),
  "voice.live": (m) => /^gpt-live/.test(m),
  "voice.realtime": (m) => /^gpt-realtime/.test(m) && !/whisper|translat|transcri/.test(m),
  "voice.transcribe": (m) => /transcri|whisper/.test(m),
  "voice.delegate": (m) => isTextModel(m),
  // OpenAI's Decisions API takes gpt-6-luna only (2026-11), not its other text models.
  decision: (m, kind) => (kind === "cloudflare" ? /^clef/.test(m) : kind === "openrouter" ? /jev|clef/i.test(m) : kind === "openai" ? /^gpt-6-luna(?:-|$)/.test(m) : isTextModel(m)),
};
const isTextModel = (m: string) => /^(gpt-\d|o\d)/.test(m) && !/image|realtime|live|audio|tts|transcri|whisper|search|embed|translat/.test(m);

/** The built-in default for a field, before looking at what the account lists. */
export function builtinDefault(field: ModelField, kind: string) {
  if (field === "voice.transcribe") return "gpt-transcribe";
  if (field === "voice.delegate") return "gpt-6-luna";
  if (field === "voice.live") return defaultModel("voice", kind, "live");
  if (field === "voice.realtime") return defaultModel("voice", kind, "realtime");
  return defaultModel(field, kind);
}

const version = (m: string) => (m.match(/\d+(?:\.\d+)*/g) ?? []).flatMap((s) => s.split(".").map(Number));
function newer(a: number[], b: number[]) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return false;
}
const dated = /-\d{4}-\d{2}-\d{2}$|-\d{8}$/;
/** Same name once the version numbers are taken out: gpt-image-2.5-flare and gpt-image-2.6-flare. */
const variant = (m: string) => m.replace(/\d+(?:\.\d+)*/g, "#");
/**
 * The newest of the listed models: the largest version number in the name (dated snapshots left out).
 * Between equal versions (gpt-image-2.6-flare / -sunburst, clef / clef-flash) the built-in default's
 * variant, then the first by name. Nothing listed: the built-in default.
 */
export function newestOf(models: string[], builtin: string) {
  const live = models.filter((m) => !dated.test(m));
  if (!live.length) return builtin;
  const pick = (a: string, b: string) => {
    const va = version(a), vb = version(b);
    if (newer(va, vb)) return a;
    if (newer(vb, va)) return b;
    const ka = a === builtin || variant(a) === variant(builtin), kb = b === builtin || variant(b) === variant(builtin);
    if (ka !== kb) return ka ? a : b;
    return a <= b ? a : b;
  };
  return live.reduce(pick);
}

/** Choices for one field of one provider: the listed models that fit, and what an empty field means. */
export function modelChoices(home: string, p: Pick<Provider, "id" | "kind">, field: ModelField) {
  const listed = readModelCache(home)[p.id]?.models ?? [];
  const models = listed.filter((m) => FIELD_FILTER[field](m, p.kind));
  return { default: newestOf(models, builtinDefault(field, p.kind)), models };
}

/** The model an empty field uses for the provider a category picked. */
export function defaultFor(config: Config, home: string | undefined, field: ModelField) {
  const cat = field.split(".")[0] as Category;
  const p = config.ai.providers.find((x) => x.id === config.ai[cat].provider);
  if (!p) return builtinDefault(field, "openai");
  return home ? modelChoices(home, p, field).default : builtinDefault(field, p.kind);
}

/** Whether a launch env already has a key from outside (the user's shell), for the hint in settings. */
export function inheritedKeyVars(): string[] {
  return ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CODEX_API_KEY"].filter((k) => !!process.env[k]);
}

export const keysFileExists = (home: string) => existsSync(fileIn(home));
