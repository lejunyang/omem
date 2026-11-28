import { classifyError, isMinuteRateLimit } from "./ai-errors.ts";
import { AI_MINUTE, aiRateLimit } from "./ai-rate-limit.ts";
import type { App } from "./app.ts";
import type { Config } from "./config.ts";

type Provider = Config["ai"]["providers"][number];
type Settle = (tokens: number) => void;
type Result = { response: Response; errorText?: string; settle?: Settle; minuteRetriesExhausted?: boolean };
const MINUTE_RETRIES = 3;
export const MINUTE_LIMIT_EXHAUSTED = "按 API key 的分钟限额等了 3 轮，上游仍然拒绝。请核对 RPM / TPM 设置和同一账号的其他流量。";

/** Admit every upstream attempt, including retries, through the same key/model queue. */
export async function requestWithAiLimit(
  app: App,
  provider: Provider,
  model: string,
  estimate: () => number,
  options: { signal?: AbortSignal; deadline?: number; onWait?: (ms: number) => void },
  send: () => Promise<Response>,
): Promise<Result> {
  const queue = aiRateLimit(app, provider, model);
  if (!queue) return { response: await send() };
  const tokens = estimate();
  const wait = { ...options, signal: options.signal ?? new AbortController().signal };
  for (let retry = 0; ; retry++) {
    const settle = await queue.acquire(tokens, wait);
    wait.signal.throwIfAborted();
    const response = await send();
    if (response.ok) return { response, settle };
    const errorText = await response.text().catch(() => "");
    wait.signal.throwIfAborted();
    if (!isMinuteRateLimit(classifyError(provider.kind, response.status, errorText))) return { response, errorText };
    if (retry === MINUTE_RETRIES) {
      settle(0);
      return { response, errorText, minuteRetriesExhausted: true };
    }
    // The provider may be counting traffic from other processes or keys on the same account.
    // Stop this model's queue for a full minute, then put the retry at its tail.
    queue.defer(Date.now() + AI_MINUTE);
    settle(0);
  }
}

type Payload = Record<string, unknown>;
const object = (value: unknown) => value && typeof value === "object" ? value as Payload : undefined;
const tokenNumber = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

export function estimatedAiTokens(body: string | Buffer, fields: Payload, defaultOutput = 4096) {
  const output = tokenNumber(fields.max_completion_tokens) ?? tokenNumber(fields.max_output_tokens)
    ?? tokenNumber(fields.max_tokens) ?? defaultOutput;
  return Math.ceil(Buffer.byteLength(body) / 4)
    + output * Math.max(1, tokenNumber(fields.n) ?? 1, tokenNumber(fields.best_of) ?? 1);
}

class TokenUsage {
  private total?: number;
  private input?: number;
  private output?: number;
  private cacheCreation = 0;
  private cacheRead = 0;

  read(payload: unknown) {
    const j = object(payload);
    const usage = object(j?.usage ?? object(j?.response)?.usage ?? object(j?.message)?.usage ?? object(j?.result)?.usage);
    if (!usage || usage.type === "duration") return;
    this.total = tokenNumber(usage.total_tokens) ?? this.total;
    this.input = tokenNumber(usage.prompt_tokens ?? usage.input_tokens) ?? this.input;
    this.output = tokenNumber(usage.completion_tokens ?? usage.output_tokens) ?? this.output;
    // Anthropic puts these outside input_tokens. OpenAI counts cached tokens inside input_tokens.
    this.cacheCreation = tokenNumber(usage.cache_creation_input_tokens) ?? this.cacheCreation;
    this.cacheRead = tokenNumber(usage.cache_read_input_tokens) ?? this.cacheRead;
  }

  apply(settle: Settle) {
    const total = this.total ?? (this.input === undefined ? undefined : this.input + (this.output ?? 0) + this.cacheCreation + this.cacheRead);
    if (total !== undefined) settle(total);
  }
}

export function settleAiUsage(settle: Settle | undefined, payload: unknown) {
  if (!settle) return;
  const usage = new TokenUsage();
  usage.read(payload);
  usage.apply(settle);
}

const MAX_USAGE_FRAME = 8 * 1024 * 1024;

/** Observe usage while passing the original bytes on with the same backpressure. */
export function streamWithAiUsage(body: ReadableStream<Uint8Array>, contentType: string, settle: Settle) {
  const sse = contentType.includes("text/event-stream");
  if (!sse && !contentType.includes("json")) return body;
  const decoder = new TextDecoder();
  const usage = new TokenUsage();
  let pending = "";
  let data: string[] = [];
  let dataSize = 0;
  let tooLarge = false;
  let applied = false;
  const apply = () => {
    if (applied) return;
    applied = true;
    usage.apply(settle);
  };
  const read = (text: string) => {
    if (text === "[DONE]") return apply();
    let j: Payload;
    try { j = JSON.parse(text); } catch { return; }
    usage.read(j);
    if (j?.type === "message_stop" || j?.type === "response.completed" || j?.type === "response.incomplete") apply();
  };
  const line = (text: string) => {
    if (!text && data.length) {
      if (!tooLarge) read(data.join("\n"));
      data = [];
      dataSize = 0;
      tooLarge = false;
    } else if (text.startsWith("data:") && !tooLarge) {
      const value = text.slice(5).replace(/^ /, "");
      dataSize += value.length + 1;
      if (dataSize <= MAX_USAGE_FRAME) data.push(value);
      else tooLarge = true;
    } else if (!text) {
      tooLarge = false;
    }
  };
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      if (!sse && tooLarge) return;
      pending += decoder.decode(chunk, { stream: true });
      if (sse) {
        const lines = pending.split("\n");
        pending = lines.pop()!;
        for (const value of lines) line(value.replace(/\r$/, ""));
      }
      if (pending.length > MAX_USAGE_FRAME) {
        tooLarge = true;
        pending = "";
      }
    },
    flush() {
      pending += decoder.decode();
      if (sse) {
        line(pending.replace(/\r$/, ""));
        line("");
      } else if (!tooLarge) {
        read(pending);
      }
      apply();
    },
  }));
}
