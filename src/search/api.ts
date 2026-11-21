import { keyOf } from "../core/ai-keys.ts";
import type { App } from "../core/app.ts";
import type { Config } from "../core/config.ts";

type Connection = { url?: string; keyRef?: string; apiKeyEnv: string };
export function searchBase(config: Config, cfg: Connection) {
  const provider = cfg.keyRef && config.ai.providers.find(p => p.id === cfg.keyRef);
  return (cfg.url || (provider && provider.baseUrl) || "https://api.openai.com/v1").replace(/\/+$/, "");
}

export class SearchApiError extends Error {
  retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.retryable = retryable;
  }
}

export async function searchPost(app: App, cfg: Connection, path: string, body: object, signal: AbortSignal): Promise<unknown> {
  const key = cfg.keyRef ? keyOf(cfg.keyRef, app.home) : process.env[cfg.apiKeyEnv];
  if (cfg.keyRef && (!key || !app.config.ai.providers.some(p => p.id === cfg.keyRef))) throw new Error("AI 服务商或密钥不存在");
  const response = await fetch(searchBase(app.config, cfg) + path, {
    method: "POST", redirect: "error", signal,
    headers: { "content-type": "application/json", ...(key && { authorization: "Bearer " + key }) },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = await response.text();
    const safe = key ? detail.replaceAll(key, "[已隐藏]") : detail;
    throw new SearchApiError(`HTTP ${response.status} ${safe.slice(0, 240)}`.trim(), response.status === 429 || response.status >= 500);
  }
  return response.json();
}
