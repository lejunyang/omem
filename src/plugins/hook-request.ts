import { HttpError } from "../core/util.ts";
import type { PluginHookEvent, PluginHookOptions, PluginHookRequest } from "./types.ts";

export const HOOK_BODY_MAX = 1024 * 1024;
export const HOOK_HEADER_MAX = 64;
export const HOOK_HEADER_BYTES = 16 * 1024;
export const HOOK_QUERY_BYTES = 8 * 1024;
export const HOOK_KEY_MAX = 256;
export const HOOK_WINDOW_MAX_HOURS = 7 * 24;
export const HOOK_PER_MINUTE = 60;
export const HOOK_RATE_MAX = 10_000;

const defaultKeyHeaders = ["x-idempotency-key", "x-event-id", "idempotency-key", "x-request-id", "x-github-delivery"];
const headerToken = /^[!#$%&'*+.^_`|~0-9a-z-]{1,64}$/i;
const privateHeaders = new Set(["authorization", "cookie", "proxy-authorization", "set-cookie"]);
const int = (value: unknown, max: number) => typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= max;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const names = (value: unknown, pattern: RegExp) => Array.isArray(value) && value.length <= 16 && value.every(name => typeof name === "string" && pattern.test(name));
export const hookPath = (plugin: string, name: string) => `/api/hooks/${plugin}/${name}`;
export const hookKeyHeader = (def: PluginHookOptions) => def.secretHeader?.toLowerCase() ?? "authorization";
export const hookWindowMs = (def: PluginHookOptions) => (def.dedup?.windowHours ?? 24) * 60 * 60 * 1000;

export function validateHookOptions(def: PluginHookOptions) {
  const invalid = (key: string) => { throw new Error(`回调 ${def.name} 的 ${key} 不合法`); };
  if (def.ack !== undefined && def.ack !== "first") invalid("ack");
  if (def.format !== undefined && !["auto", "webhook", "openai-chat"].includes(def.format)) invalid("format");
  if (def.secretHeader !== undefined && (typeof def.secretHeader !== "string" || !headerToken.test(def.secretHeader) || privateHeaders.has(def.secretHeader.toLowerCase()))) invalid("secretHeader");
  if (def.headers !== undefined && !names(def.headers, headerToken)) invalid("headers");
  if (def.dedup !== undefined && (!record(def.dedup) ||
    (def.dedup.headers !== undefined && !names(def.dedup.headers, headerToken)) ||
    (def.dedup.bodyFields !== undefined && !names(def.dedup.bodyFields, /^(?=.{1,120}$)[\w-]+(?:\.[\w-]+){0,7}$/)) ||
    (def.dedup.requireMatch !== undefined && typeof def.dedup.requireMatch !== "boolean") ||
    (def.dedup.requireMatch && (!def.dedup.bodyFields?.length || def.dedup.headers?.length === 0)) ||
    (def.dedup.windowHours !== undefined && !int(def.dedup.windowHours, HOOK_WINDOW_MAX_HOURS)))) invalid("dedup");
  if (def.rateLimit !== undefined && (!record(def.rateLimit) || !int(def.rateLimit.perMinute, HOOK_RATE_MAX) ||
    (def.rateLimit.burst !== undefined && !int(def.rateLimit.burst, HOOK_RATE_MAX)))) invalid("rateLimit");
}

export function hookRequestHeaders(def: PluginHookOptions, headers: Record<string, string | string[] | undefined>) {
  const keep = new Set(["content-type", ...defaultKeyHeaders, ...def.dedup?.headers ?? [], ...def.headers ?? []].map(name => name.toLowerCase()));
  return Object.fromEntries(Object.entries(headers).flatMap(([name, value]) => {
    const key = name.toLowerCase();
    return value === undefined || privateHeaders.has(key) || key === hookKeyHeader(def) || (def.ack === "first" && !keep.has(key))
      ? [] : [[key, Array.isArray(value) ? value.join(", ") : value]];
  }));
}

function readJson(body: string): unknown {
  try { return JSON.parse(body); } catch { return body; }
}

export function hookDeliveryKey(def: PluginHookOptions, headers: Record<string, string>, body: unknown): string | null | undefined {
  const key = (value: unknown, exact = false) => {
    const text = typeof value === "string" ? (exact ? value : value.trim()) : typeof value === "number" && Number.isSafeInteger(value) ? String(value) : "";
    return text.trim() && Buffer.byteLength(text) <= HOOK_KEY_MAX ? text : null;
  };
  const headerKey = (def.dedup?.headers ?? defaultKeyHeaders).map(name => key(headers[name.toLowerCase()])).find(value => value !== null) ?? null;
  if (headerKey && !def.dedup?.requireMatch) return headerKey;
  let bodyKey = null;
  for (const path of def.dedup?.bodyFields ?? []) {
    let value = body;
    for (const part of path.split(".")) value = record(value) && Object.hasOwn(value, part) ? value[part] : undefined;
    bodyKey = key(value, def.dedup?.requireMatch);
    if (bodyKey) break;
  }
  if (def.dedup?.requireMatch && (!headerKey || headerKey !== bodyKey)) return undefined;
  return bodyKey;
}

type ParsedHook =
  | { format: "webhook"; data: unknown; raw: unknown }
  | { format: "openai-chat"; data: unknown; raw: unknown; model: string; stream: boolean };

export function parseHookEvent(body: string, format: PluginHookOptions["format"] = "auto"): ParsedHook {
  const raw = readJson(body);
  const message = record(raw) && Array.isArray(raw.messages) ? raw.messages.findLast(entry => record(entry) && entry.role === "user") : undefined;
  if (format === "auto") format = message ? "openai-chat" : "webhook";
  if (format === "openai-chat") {
    if (!record(message) || typeof message.content !== "string" || !record(raw)) throw new HttpError(400, "回调需要最后一条 user 消息的文本");
    const value = readJson(message.content);
    return { format, raw, data: record(value) || Array.isArray(value) ? value : message.content, model: typeof raw.model === "string" && raw.model.length <= 128 ? raw.model : "omem-hook", stream: raw.stream === true };
  }
  return { format: "webhook", raw, data: raw };
}

export function hookEvent(parsed: ParsedHook): PluginHookEvent {
  return { format: parsed.format, data: parsed.data, trust: "untrusted" };
}

export function hookReceipt(parsed: ParsedHook, id: PluginHookRequest["deliveryId"], at: number) {
  const text = `已收到 · ${id}`;
  if (parsed.format === "openai-chat") {
    const base = { id: `chatcmpl-${id}`, created: Math.floor(at / 1000), model: parsed.model };
    if (parsed.stream) {
      const chunk = (delta: object, finish_reason: string | null) => `data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason, logprobs: null }] })}\n\n`;
      return { status: 200, contentType: "text/event-stream", body: chunk({ role: "assistant", content: text }, null) + chunk({}, "stop") + "data: [DONE]\n\n" };
    }
    return { status: 200, body: { ...base, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop", logprobs: null }] } };
  }
  return null;
}
