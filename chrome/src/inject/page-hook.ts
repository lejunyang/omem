// 页面钩子：在页面 MAIN world 里改写 fetch / XMLHttpRequest。
// 不用 CDP 时由它负责两件事：记录请求发起时的调用栈（面板的 Initiator），按 Mock 规则改写响应。
// 两种注入方式：已授权站点由内容脚本在 document_start 注入；否则由 DevTools 面板 eval 注入（较晚，最早的几个请求赶不上）。
// 构建为独立 IIFE（scripts/build-inject.mjs），不能依赖扩展页面的模块闭包。
import { filterMockRulesByDomain, groupMatchesPageUrl, type MockGroup, type MockRule, ruleMatchesRequest } from "../shared/mock-rules";
import { applyStaticMock } from "../shared/mock-response";
import { createMockScriptRequest, headersArrayToRecord, type MockScriptInput, type MockScriptOutput, normalizeMockScriptResult } from "../shared/mock-script";
import type { HeaderPair, RequestInitiator } from "../shared/network";
import {
  HOOK_EVENT_MOCKED,
  HOOK_EVENT_READY,
  HOOK_EVENT_RULES,
  HOOK_EVENT_SCRIPT,
  HOOK_EVENT_SCRIPT_RESULT,
  type HookRulesPayload,
  hookRequestKey,
  initiatorFromStack,
  PAGE_HOOK_GLOBAL,
  type PageHookApi,
  parseV8Stack
} from "../shared/page-hook-protocol";

const HOOK_VERSION = 1;
const RULES_WAIT_MS = 300;
const MAX_REMEMBERED = 400;

install();

function install(): void {
  const target = window as unknown as Record<string, unknown>;
  // 内容脚本和面板 eval 可能各注入一次；第二次只补发 ready，让桥重新下发规则。
  if (target[PAGE_HOOK_GLOBAL]) {
    document.dispatchEvent(new CustomEvent(HOOK_EVENT_READY));
    return;
  }

  let rules: MockRule[] = [];
  let groups: MockGroup[] = [];
  let scriptBridge = false;
  let rulesReady = false;
  let resolveRules: () => void = () => undefined;
  const rulesArrived = new Promise<void>((resolve) => (resolveRules = resolve));
  const initiators = new Map<string, RequestInitiator>();
  const mocked = new Set<string>();
  const pendingScripts = new Map<string, (result: { ok: boolean; result?: MockScriptOutput; error?: string }) => void>();

  function setRules(json: string): void {
    try {
      const payload = JSON.parse(json) as HookRulesPayload;
      rules = Array.isArray(payload.rules) ? payload.rules : [];
      groups = Array.isArray(payload.groups) ? payload.groups : [];
      scriptBridge ||= Boolean(payload.scriptBridge);
      rulesReady = true;
      resolveRules();
    } catch {
      // 规则格式不对时保持原状态，不影响页面请求。
    }
  }

  const api: PageHookApi = {
    version: HOOK_VERSION,
    setRules,
    initiator: (key) => initiators.get(key) ?? null,
    mocked: (key) => mocked.has(key)
  };
  Object.defineProperty(target, PAGE_HOOK_GLOBAL, { value: api, configurable: false, enumerable: false });

  document.addEventListener(HOOK_EVENT_RULES, (event) => {
    const detail = (event as CustomEvent).detail;
    if (typeof detail === "string") setRules(detail);
  });
  document.addEventListener(HOOK_EVENT_SCRIPT_RESULT, (event) => {
    const detail = (event as CustomEvent).detail;
    if (typeof detail !== "string") return;
    try {
      const result = JSON.parse(detail) as { id: string; ok: boolean; result?: MockScriptOutput; error?: string };
      pendingScripts.get(result.id)?.(result);
      pendingScripts.delete(result.id);
    } catch {
      // 忽略格式不对的回包。
    }
  });

  function remember(method: string, url: string): void {
    // 去掉扩展自己的帧：内容脚本注入时是 chrome-extension://，面板 eval 注入时没有 URL（已被解析器跳过）。
    const frames = parseV8Stack(new Error().stack).filter((frame) => !frame.url.startsWith("chrome-extension://"));
    if (!frames.length) return;
    const key = hookRequestKey(method, url);
    initiators.delete(key);
    initiators.set(key, initiatorFromStack(frames));
    if (initiators.size > MAX_REMEMBERED) initiators.delete(initiators.keys().next().value as string);
  }

  /** 先按域名和页面 URL 粗筛；状态码、响应头条件要等响应回来再判断。 */
  async function candidatesFor(url: string): Promise<MockRule[]> {
    if (!rulesReady) {
      // 规则还没送到时最多等 300 ms，超时放行，不能卡住页面。
      await Promise.race([rulesArrived, new Promise((resolve) => setTimeout(resolve, RULES_WAIT_MS))]);
    }
    if (!rules.length) return [];
    let host = "";
    try {
      host = new URL(url).hostname;
    } catch {
      return [];
    }
    const groupsById = new Map(groups.map((group) => [group.id, group]));
    return filterMockRulesByDomain(rules, host).filter(
      (rule) => rule.enabled && groupMatchesPageUrl(groupsById.get(rule.groupId), location.href) && (rule.action !== "script" || scriptBridge)
    );
  }

  async function computeMock(rule: MockRule, input: MockScriptInput): Promise<MockScriptOutput | null> {
    if (rule.action !== "script") return applyStaticMock(rule, input);
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const reply = await new Promise<{ ok: boolean; result?: MockScriptOutput; error?: string }>((resolve) => {
      pendingScripts.set(id, resolve);
      document.dispatchEvent(new CustomEvent(HOOK_EVENT_SCRIPT, { detail: JSON.stringify({ id, ruleId: rule.id, input }) }));
      setTimeout(() => {
        if (pendingScripts.delete(id)) resolve({ ok: false, error: "timeout" });
      }, 10_000);
    });
    if (!reply.ok) return null;
    return normalizeMockScriptResult(reply.result, input.response);
  }

  function markMocked(method: string, url: string): void {
    const key = hookRequestKey(method, url);
    mocked.add(key);
    document.dispatchEvent(new CustomEvent(HOOK_EVENT_MOCKED, { detail: JSON.stringify({ method, url }) }));
  }

  async function mockFor(
    candidates: MockRule[],
    request: { method: string; url: string; headers: Record<string, string>; body: string },
    response: { status: number; headers: HeaderPair[]; readBody: () => Promise<string> }
  ): Promise<MockScriptOutput | null> {
    const rule = candidates.find((item) =>
      ruleMatchesRequest(item, { method: request.method, url: request.url, status: response.status, responseHeaders: response.headers })
    );
    if (!rule) return null;
    const body = await response.readBody();
    const result = await computeMock(rule, {
      request: createMockScriptRequest({ method: request.method, url: request.url, headers: request.headers, body: request.body }),
      response: { status: response.status, headers: headersArrayToRecord(response.headers), body }
    });
    if (result) markMocked(request.method, request.url);
    return result;
  }

  patchFetch(remember, candidatesFor, mockFor);
  patchXhr(remember, candidatesFor, mockFor);
  document.dispatchEvent(new CustomEvent(HOOK_EVENT_READY));
}

type Remember = (method: string, url: string) => void;
type Candidates = (url: string) => Promise<MockRule[]>;
type MockFor = (
  candidates: MockRule[],
  request: { method: string; url: string; headers: Record<string, string>; body: string },
  response: { status: number; headers: HeaderPair[]; readBody: () => Promise<string> }
) => Promise<MockScriptOutput | null>;

function absoluteUrl(value: string | URL): string {
  try {
    return new URL(String(value), location.href).href;
  } catch {
    return String(value);
  }
}

function patchFetch(remember: Remember, candidatesFor: Candidates, mockFor: MockFor): void {
  const originalFetch = window.fetch;
  if (typeof originalFetch !== "function") return;
  const patched = async function (this: unknown, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const isRequest = typeof Request !== "undefined" && input instanceof Request;
    const method = (init?.method ?? (isRequest ? (input as Request).method : "GET")).toUpperCase();
    const url = absoluteUrl(isRequest ? (input as Request).url : (input as string | URL));
    remember(method, url);
    const candidates = await candidatesFor(url);
    const response = await originalFetch.call(this as typeof globalThis, input, init);
    if (!candidates.length) return response;
    const headers: HeaderPair[] = [];
    response.headers.forEach((value, name) => headers.push({ name, value }));
    const requestHeaders: Record<string, string> = {};
    new Headers(init?.headers ?? (isRequest ? (input as Request).headers : undefined)).forEach((value, name) => (requestHeaders[name] = value));
    const result = await mockFor(
      candidates,
      { method, url, headers: requestHeaders, body: typeof init?.body === "string" ? init.body : "" },
      { status: response.status, headers, readBody: () => response.clone().text() }
    ).catch(() => null);
    if (!result) return response;
    const mockedResponse = new Response(nullBodyStatus(result.status) ? null : result.body, {
      status: result.status,
      statusText: response.statusText,
      headers: result.headers
    });
    // Response.url 是只读的原型属性；在实例上覆盖，页面读到的仍是原地址。
    Object.defineProperty(mockedResponse, "url", { value: response.url });
    Object.defineProperty(mockedResponse, "redirected", { value: response.redirected });
    return mockedResponse;
  };
  // 保留 fetch.toString() 等探测的观感，避免个别站点检测到被改写后降级。
  Object.defineProperty(patched, "name", { value: "fetch" });
  window.fetch = patched as typeof window.fetch;
}

function nullBodyStatus(status: number): boolean {
  return status === 101 || status === 204 || status === 205 || status === 304;
}

interface XhrMeta {
  method: string;
  url: string;
  async: boolean;
  headers: Record<string, string>;
}

/**
 * XHR 只在命中候选规则时接管：用一个内部的原生 XHR 真正发请求，拿到结果算出 Mock，
 * 再在页面持有的那个 XHR 实例上覆盖 readyState / status / response 等只读属性并派发事件。
 * 没有候选规则的请求完全走原生实现。同步 XHR 不接管。
 */
function patchXhr(remember: Remember, candidatesFor: Candidates, mockFor: MockFor): void {
  const Xhr = window.XMLHttpRequest;
  if (typeof Xhr !== "function") return;
  const metas = new WeakMap<XMLHttpRequest, XhrMeta>();
  const inners = new WeakMap<XMLHttpRequest, XMLHttpRequest>();
  const { open, send, setRequestHeader, abort } = Xhr.prototype;

  // 用 arguments 原样转交：两参数调用时不能补成五个参数（user/password 传 undefined 会被当成显式凭据）。
  Xhr.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL) {
    const async = arguments.length < 3 || arguments[2] !== false;
    metas.set(this, { method: String(method).toUpperCase(), url: absoluteUrl(url), async, headers: {} });
    // eslint-disable-next-line prefer-rest-params
    return (open as (...args: unknown[]) => void).apply(this, Array.from(arguments));
  } as typeof Xhr.prototype.open;

  Xhr.prototype.setRequestHeader = function (this: XMLHttpRequest, name: string, value: string) {
    const meta = metas.get(this);
    if (meta) meta.headers[name] = value;
    return setRequestHeader.call(this, name, value);
  };

  Xhr.prototype.abort = function (this: XMLHttpRequest) {
    const inner = inners.get(this);
    if (inner) {
      inner.abort();
      return;
    }
    return abort.call(this);
  };

  Xhr.prototype.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    const meta = metas.get(this);
    if (!meta || !meta.async) return send.call(this, body);
    remember(meta.method, meta.url);
    const xhr = this;
    void candidatesFor(meta.url).then((candidates) => {
      if (!candidates.length) {
        send.call(xhr, body);
        return;
      }
      takeOver(xhr, meta, candidates, body);
    });
  };

  function takeOver(xhr: XMLHttpRequest, meta: XhrMeta, candidates: MockRule[], body?: Document | XMLHttpRequestBodyInit | null): void {
    const inner = new Xhr();
    inners.set(xhr, inner);
    open.call(inner, meta.method, meta.url, true);
    for (const [name, value] of Object.entries(meta.headers)) setRequestHeader.call(inner, name, value);
    inner.withCredentials = xhr.withCredentials;
    inner.timeout = xhr.timeout;
    // 内部统一按文本取，Mock 算完后再按页面要求的 responseType 转换。
    const forward = (type: string) => () => {
      Object.defineProperty(xhr, "readyState", { configurable: true, get: () => 4 });
      Object.defineProperty(xhr, "status", { configurable: true, get: () => 0 });
      xhr.dispatchEvent(new Event("readystatechange"));
      xhr.dispatchEvent(new ProgressEvent(type));
      xhr.dispatchEvent(new ProgressEvent("loadend"));
    };
    inner.addEventListener("error", forward("error"));
    inner.addEventListener("timeout", forward("timeout"));
    inner.addEventListener("abort", forward("abort"));
    inner.addEventListener("load", () => {
      const headers = parseRawHeaders(inner.getAllResponseHeaders());
      void mockFor(
        candidates,
        { method: meta.method, url: meta.url, headers: meta.headers, body: typeof body === "string" ? body : "" },
        { status: inner.status, headers, readBody: async () => inner.responseText }
      )
        .catch(() => null)
        .then((result) => {
          finish(xhr, inner, result ?? { status: inner.status, headers: Object.fromEntries(headers.map((h) => [h.name, h.value])), body: inner.responseText });
        });
    });
    send.call(inner, body as XMLHttpRequestBodyInit | null);
  }

  function finish(xhr: XMLHttpRequest, inner: XMLHttpRequest, result: MockScriptOutput): void {
    const headerLines = Object.entries(result.headers).map(([name, value]) => `${name.toLowerCase()}: ${value}`);
    const lookup = new Map(Object.entries(result.headers).map(([name, value]) => [name.toLowerCase(), value]));
    const define = (key: string, value: unknown) => Object.defineProperty(xhr, key, { configurable: true, get: () => value });
    define("readyState", 4);
    define("status", result.status);
    define("statusText", inner.statusText);
    define("responseURL", inner.responseURL);
    define("responseText", result.body);
    define("response", convertBody(result.body, xhr.responseType, lookup.get("content-type") ?? ""));
    Object.defineProperty(xhr, "getAllResponseHeaders", { configurable: true, value: () => headerLines.join("\r\n") + (headerLines.length ? "\r\n" : "") });
    Object.defineProperty(xhr, "getResponseHeader", { configurable: true, value: (name: string) => lookup.get(String(name).toLowerCase()) ?? null });
    xhr.dispatchEvent(new Event("readystatechange"));
    xhr.dispatchEvent(new ProgressEvent("load"));
    xhr.dispatchEvent(new ProgressEvent("loadend"));
  }
}

function convertBody(text: string, responseType: XMLHttpRequestResponseType, contentType: string): unknown {
  if (responseType === "json") {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }
  if (responseType === "blob") return new Blob([text], { type: contentType });
  if (responseType === "arraybuffer") return new TextEncoder().encode(text).buffer;
  if (responseType === "document") return new DOMParser().parseFromString(text, contentType.includes("xml") ? "application/xml" : "text/html");
  return text;
}

function parseRawHeaders(raw: string): HeaderPair[] {
  return raw
    .trim()
    .split(/[\r\n]+/)
    .filter(Boolean)
    .map((line) => {
      const index = line.indexOf(":");
      return { name: line.slice(0, index).trim(), value: line.slice(index + 1).trim() };
    });
}
