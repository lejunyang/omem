import { validateHeaderName, validateHeaderValue } from "node:http";
import { isPromise } from "node:util/types";
import type { PluginHookAccept, PluginHookAcceptState, PluginHookRequest } from "./types.ts";

export const HOOK_ACCEPT_MS = 50;
export const HOOK_ACCEPT_IPC_MS = 500;
type Response = { status: number; headers: Record<string, string>; body: string };
export type HookResponder = (req: PluginHookRequest, state: PluginHookAcceptState) => Response | Promise<Response>;

const transportHeaders = new Set(["connection", "content-encoding", "content-length", "keep-alive", "trailer", "transfer-encoding", "upgrade"]);

export function runHookAccept(accept: PluginHookAccept, req: PluginHookRequest, state: PluginHookAcceptState): Response {
  const started = performance.now();
  const response = accept(req, state);
  if (isPromise(response)) {
    void response.catch(() => {});
    throw new Error("回调 accept 必须同步返回");
  }
  if (!response || !Number.isInteger(response.status) || response.status < 200 || response.status > 599)
    throw new Error("回调 accept 必须返回合法的 HTTP 状态码");
  const headers: Record<string, string> = Object.create(null);
  for (const [name, value] of Object.entries(response.headers ?? {})) {
    const key = name.toLowerCase();
    if (typeof value !== "string" || transportHeaders.has(key)) throw new Error("回调 accept 返回了无效的响应头");
    validateHeaderName(name);
    validateHeaderValue(name, value);
    headers[key] = value;
  }
  const payload = response.body;
  const text = typeof payload === "string";
  const body = text ? payload : JSON.stringify(payload);
  if (body === undefined) throw new Error("回调 accept 需要返回正文");
  headers["content-type"] ??= text ? "text/plain; charset=utf-8" : "application/json; charset=utf-8";
  if (performance.now() - started > HOOK_ACCEPT_MS) throw new Error("回调 accept 超时");
  return { status: response.status, headers, body };
}
