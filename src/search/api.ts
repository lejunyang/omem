import { keyOf } from "../core/ai-keys.ts";
import type { App } from "../core/app.ts";
import type { Config } from "../core/config.ts";
import { estimatedAiTokens, MINUTE_LIMIT_EXHAUSTED, requestWithAiLimit, settleAiUsage } from "../core/ai-request.ts";

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

export async function searchPost(app: App, cfg: Connection, path: string, body: Record<string, unknown> & { model: string }, signal: AbortSignal): Promise<unknown> {
  const key = cfg.keyRef ? keyOf(cfg.keyRef, app.home) : process.env[cfg.apiKeyEnv];
  const provider = cfg.keyRef && app.config.ai.providers.find(p => p.id === cfg.keyRef);
  if (cfg.keyRef && (!key || !provider)) throw new Error("AI 服务商或密钥不存在");
  try {
    const encoded = JSON.stringify(body);
    const send = () => fetch(searchBase(app.config, cfg) + path, {
      method: "POST", redirect: "error", signal,
      headers: { "content-type": "application/json", ...(key && { authorization: "Bearer " + key }) },
      body: encoded,
    });
    const { response, errorText, settle, minuteRetriesExhausted } = provider
      ? await requestWithAiLimit(app, provider, body.model, () => estimatedAiTokens(encoded, body, 0), { signal }, send)
      : { response: await send() };
    if (!response.ok) {
      // The status determines retries even if the optional error detail cannot be read.
      const detail = errorText ?? await response.text().catch(() => "");
      const safe = key ? detail.replaceAll(key, "[已隐藏]") : detail;
      throw new SearchApiError(`HTTP ${response.status} ${safe.slice(0, 240)}${minuteRetriesExhausted ? ` ${MINUTE_LIMIT_EXHAUSTED}` : ""}`.trim(), response.status === 429 || response.status >= 500);
    }
    const payload = await response.json();
    settleAiUsage(settle, payload);
    return payload;
  } catch (err) {
    const error = err as Error;
    const message = key ? error.message.replaceAll(key, "[已隐藏]") : error.message;
    const retryable = err instanceof SearchApiError ? err.retryable : isTransportTimeout(error) || isTransportTimeout(error.cause);
    throw new SearchApiError(message.slice(0, 500), retryable);
  }
}
