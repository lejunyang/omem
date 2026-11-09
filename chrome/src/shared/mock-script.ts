import type { HeaderPair } from "./network";

export interface MockScriptInput {
  request: MockScriptRequest;
  response: MockScriptResponse;
}

export interface MockScriptRequest {
  method: string;
  url: string;
  origin: string;
  protocol: string;
  host: string;
  hostname: string;
  port: string;
  pathname: string;
  search: string;
  queryString: string;
  query: Record<string, string | string[]>;
  headers: Record<string, string>;
  body: string;
}

export interface MockScriptResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export type MockScriptOutput = MockScriptResponse;

// 用户脚本入参使用对象形式的 headers，便于脚本直接按 header 名读取；发送给 CDP 前再转回数组。
export function headersArrayToRecord(headers: HeaderPair[]): Record<string, string> {
  return Object.fromEntries(headers.map((header) => [header.name, header.value]));
}

// CDP fulfillRequest 仍需要 HeaderPair 数组，这里集中转换，避免 UI 和脚本运行器重复处理格式。
export function headersRecordToArray(headers: Record<string, string>): HeaderPair[] {
  return Object.entries(headers).map(([name, value]) => ({ name, value }));
}

// 用户脚本返回值不可信，必须逐字段归一化；缺失或非法字段回退到原响应，避免脚本小错误破坏请求。
export function normalizeMockScriptResult(
  value: unknown,
  fallback: MockScriptOutput
): MockScriptOutput {
  if (!value || typeof value !== "object") {
    return fallback;
  }

  const candidate = value as Record<string, unknown>;
  return {
    status: normalizeStatus(candidate.status, fallback.status),
    headers: normalizeHeaders(candidate.headers, fallback.headers),
    body: normalizeBody(candidate.body, fallback.body)
  };
}

export function createMockScriptRequest(input: {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
}): MockScriptRequest {
  // 将 URL 拆成 origin/path/query 等常用字段，减少用户脚本反复 new URL 的样板代码。
  const urlParts = parseUrl(input.url);
  return {
    method: input.method,
    url: input.url,
    ...urlParts,
    headers: normalizeHeaderRecord(input.headers ?? {}),
    body: input.body ?? ""
  };
}

function normalizeHeaders(value: unknown, fallback: Record<string, string>): Record<string, string> {
  // 兼容对象和 HeaderPair 数组两种返回，方便用户从示例或原响应结构中直接改写 headers。
  if (!value || typeof value !== "object") {
    return fallback;
  }

  if (Array.isArray(value)) {
    return Object.fromEntries(
      value.flatMap((item) => {
        if (!item || typeof item !== "object") {
          return [];
        }
        const header = item as Record<string, unknown>;
        if (typeof header.name !== "string") {
          return [];
        }
        return [[header.name, String(header.value ?? "")]];
      })
    );
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([name, headerValue]) => [
      name,
      String(headerValue ?? "")
    ])
  );
}

function normalizeHeaderRecord(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), String(value ?? "")]));
}

function normalizeStatus(value: unknown, fallback: number): number {
  const status = Number(value);
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : fallback;
}

function normalizeBody(value: unknown, fallback: string): string {
  if (value === undefined || value === null) {
    return fallback;
  }

  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "object") {
    return JSON.stringify(value, null, 2);
  }

  return String(value);
}

function parseUrl(url: string): Omit<MockScriptRequest, "body" | "headers" | "method" | "url"> {
  try {
    const parsedUrl = new URL(url);
    return {
      origin: parsedUrl.origin,
      protocol: parsedUrl.protocol,
      host: parsedUrl.host,
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      pathname: parsedUrl.pathname,
      search: parsedUrl.search,
      queryString: parsedUrl.search.slice(1),
      query: parseQuery(parsedUrl.searchParams)
    };
  } catch {
    return {
      origin: "",
      protocol: "",
      host: "",
      hostname: "",
      port: "",
      pathname: "",
      search: "",
      queryString: "",
      query: {}
    };
  }
}

function parseQuery(searchParams: URLSearchParams): Record<string, string | string[]> {
  // 同名 query 参数保留为数组，避免丢失如 ?id=1&id=2 这类真实接口语义。
  const query: Record<string, string | string[]> = {};
  searchParams.forEach((value, key) => {
    const current = query[key];
    if (Array.isArray(current)) {
      current.push(value);
      return;
    }
    query[key] = current === undefined ? value : [current, value];
  });
  return query;
}
