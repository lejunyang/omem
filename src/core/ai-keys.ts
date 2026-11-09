import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AgentProfile, Config } from "./config.ts";
import { omemHome } from "./config.ts";

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
 * key is gone fails here rather than silently falling back to the login on this machine. (A custom
 * base URL is not secret and is already in the profile's env: config.ts `keyedProfiles`.)
 */
export function keyEnv(profile: Pick<AgentProfile, "keyRef" | "id" | "command">): Record<string, string> {
  if (!profile.keyRef) return {};
  const key = keyOf(profile.keyRef);
  if (!key) throw new Error(`后端 ${profile.id} 用的 API key（${profile.keyRef}）还没有填写：设置 → AI → API key`);
  const s = `${profile.id} ${profile.command}`;
  return keyVars(/claude/.test(s) ? "anthropic" : /codex/.test(s) ? "openai" : "", key);
}

export const DEFAULT_BASE: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
  typesafe: "https://api.typesafe.ai",
  openrouter: "https://openrouter.ai/api",
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
  if (cat === "image") return "gpt-image-2.5-flare";
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
export function categoryStatus(config: Config, cat: Category, home?: string): { ready: boolean; detail: string; provider?: string; model?: string; media?: DecisionMedia[] } {
  const c = config.ai[cat];
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
  const model = c.model || defaultModel(cat, p.kind, (c as { api?: string }).api);
  if (!model) return { ready: false, detail: "要填写模型" };
  const media = cat === "decision" ? decisionMedia(p.kind, model) : [];
  return { ready: true, detail: `${p.name || p.id} · ${model}`, provider: p.id, model, ...(media.length ? { media } : {}) };
}

/** Whether a launch env already has a key from outside (the user's shell), for the hint in settings. */
export function inheritedKeyVars(): string[] {
  return ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CODEX_API_KEY"].filter((k) => !!process.env[k]);
}

export const keysFileExists = (home: string) => existsSync(fileIn(home));
