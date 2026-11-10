import { type OmemConnection, resolveEndpoint } from "./connections";

// 扩展调 omem 的接口。扩展页面对已授权的主机发请求不受跨域限制；凭据一律是 Bearer om_ 令牌，
// 不靠 cookie：omem 对带 cookie 的写请求要求同源（防 CSRF），扩展的请求过不了这一关。

export class OmemError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "OmemError";
  }
}

async function readError(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  try {
    const body = JSON.parse(text) as { error?: string; message?: string };
    return body.error || body.message || text;
  } catch {
    return text || `${response.status} ${response.statusText}`;
  }
}

export async function omemRequest<T>(
  endpoint: { base: string; token?: string },
  path: string,
  init: { method?: string; body?: unknown; signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<T> {
  const signal = AbortSignal.any([AbortSignal.timeout(init.timeoutMs ?? 30_000), ...(init.signal ? [init.signal] : [])]);
  let response: Response;
  try {
    response = await fetch(`${endpoint.base}${path}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: {
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...(endpoint.token ? { authorization: `Bearer ${endpoint.token}` } : {}),
        "x-omem-client": "chrome-extension"
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      credentials: "omit",
      signal
    });
  } catch (error) {
    if ((error as Error).name === "TimeoutError") throw new OmemError("omem 没有响应（超时）", 0);
    throw new OmemError(`连不上 omem：${(error as Error).message}。确认它在运行、地址正确`, 0);
  }
  if (!response.ok) {
    const message = await readError(response);
    throw new OmemError(response.status === 401 ? "登录已失效：重新连接这一项" : message, response.status);
  }
  return (await response.json()) as T;
}

export function requestFor(connection: OmemConnection, all: OmemConnection[]) {
  const endpoint = resolveEndpoint(connection, all);
  return <T>(path: string, init: Parameters<typeof omemRequest>[2] = {}) => omemRequest<T>(endpoint, path, init);
}

// ---------- 登录（omem login 同一套流程） ----------

export interface LoginStart {
  code: string;
  secret: string;
  url: string;
  expiresAt: string;
}

export function startLogin(url: string, client: string): Promise<LoginStart> {
  return omemRequest<LoginStart>({ base: url }, "/api/auth/cli/start", { body: { client } });
}

export type LoginPoll = { status: "waiting" } | { status: "done"; token: string; user: { id: string; name: string } };

export function pollLogin(url: string, code: string, secret: string): Promise<LoginPoll> {
  return omemRequest<LoginPoll>({ base: url }, "/api/auth/cli/poll", { body: { code, secret } });
}

/**
 * 浏览器里是不是已经登录了这个 omem：带 cookie 读 /api/me（读请求不要求同源）。
 * 只用来在连接时提示「已登录为 X，点允许即可」，发送仍然用令牌。
 */
export async function browserSession(url: string): Promise<{ name: string } | null> {
  try {
    const response = await fetch(`${url}/api/me`, { credentials: "include", signal: AbortSignal.timeout(5000) });
    if (!response.ok) return null;
    const me = (await response.json()) as { name?: string; restricted?: boolean; via?: string };
    // 本机信任（via=local）不算浏览器登录：扩展的请求不会被当成本机网页。
    return me.name && !me.restricted ? { name: me.name } : null;
  } catch {
    return null;
  }
}

// ---------- 读 ----------

export interface OmemMe {
  id: string;
  name: string;
  /** null：全部空间（本人） */
  spaces: string[] | null;
  writes: string[] | null;
}

export interface OmemSpace {
  id: string;
  name: string;
}

export interface OmemPeer {
  id: string;
  url: string;
  via: string | null;
}

// ---------- 发送 ----------

export interface ClipRequest {
  mode: "ask" | "source";
  space: string;
  title: string;
  text: string;
  pageUrl: string;
  conversationId?: string;
  images: Array<{ key: string; title: string; data: string }>;
}

export type ClipResponse =
  | { mode: "ask"; conversationId: string; messageId: string | null; runId: string | null }
  | { mode: "source"; sourceId: string; ingestRun: string | null };

export interface ConversationMessage {
  id: string;
  role: string;
  text: string;
  created_at?: string;
}
