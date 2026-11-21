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

// Node fetch can report a transport timeout directly or as the cause of a TypeError.
function isTransportTimeout(error: unknown) {
  const e = error as NodeJS.ErrnoException | undefined;
  return e?.name === "TimeoutError" || e?.code === "ETIMEDOUT" || e?.code === "UND_ERR_CONNECT_TIMEOUT"
    || e?.code === "UND_ERR_HEADERS_TIMEOUT" || e?.code === "UND_ERR_BODY_TIMEOUT";
}

export async function searchPost(app: App, cfg: Connection, path: string, body: object, signal: AbortSignal): Promise<unknown> {
  const key = cfg.keyRef ? keyOf(cfg.keyRef, app.home) : process.env[cfg.apiKeyEnv];
  if (cfg.keyRef && (!key || !app.config.ai.providers.some(p => p.id === cfg.keyRef))) throw new Error("AI 服务商或密钥不存在");
  try {
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
    return await response.json();
  } catch (err) {
    const error = err as Error;
    const message = key ? error.message.replaceAll(key, "[已隐藏]") : error.message;
    const retryable = err instanceof SearchApiError ? err.retryable : isTransportTimeout(error) || isTransportTimeout(error.cause);
    throw new SearchApiError(message.slice(0, 500), retryable);
  }
}
