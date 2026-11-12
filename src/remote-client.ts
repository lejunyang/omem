import { exec } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { omemHome } from "./core/home.ts";

/**
 * The client side of using a remote omem (docs/v2/remote-clients.md): `omem tool` and `omem mcp`
 * with `--url` / `--remote` / `OMEM_URL` talk to that server's `/api/tools` with a credential, and
 * never open a local library. Saved remotes live in `~/.omem/client.json` (0600), apart from the
 * server's own config; nothing here pairs with the server.
 */

export type RemoteEntry = { url: string; token?: string; authCmd?: string };
export type ClientFile = { default?: string; remotes: Record<string, RemoteEntry> };

export const clientPath = () => join(omemHome(), "client.json");

export function readClient(): ClientFile {
  try {
    const v = JSON.parse(readFileSync(clientPath(), "utf8")) as Partial<ClientFile>;
    return { default: v.default, remotes: v.remotes && typeof v.remotes === "object" ? v.remotes : {} };
  } catch {
    return { remotes: {} };
  }
}

export function writeClient(c: ClientFile) {
  const p = clientPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
  try {
    chmodSync(p, 0o600);
  } catch {
    // Windows: the mode is advisory.
  }
}

export const normalizeUrl = (url: string) => {
  const u = url.trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^/]/.test(u)) throw new Error(`地址要以 http:// 或 https:// 开头：${url}`);
  return u;
};

export const clientName = () => hostname().split(".")[0] || "remote";

type Credential = { kind: "token"; value: string } | { kind: "cmd"; command: string };

export type RemoteTarget = {
  /** The saved remote's name, when it came from client.json. */
  name?: string;
  url: string;
  credential: Credential | null;
};

/**
 * Where to go and with what. Address: `--url` > `--remote` > `OMEM_URL` (or this machine's, with only
 * `OMEM_TOKEN`) > client.json's default;
 * null means the local library. Credential: a saved remote's own (authCmd, token) before the
 * environment; an address given directly takes `OMEM_TOKEN`, then `OMEM_AUTH_CMD`, then whatever
 * a saved remote with the same address has.
 */
export function resolveRemote(o: { url?: string; remote?: string }, env: NodeJS.ProcessEnv = process.env): RemoteTarget | null {
  const file = readClient();
  const entryOf = (name: string) => {
    const e = file.remotes[name];
    if (!e) throw new Error(`没有名为 ${name} 的远程地址（omem remote list 查看，omem remote add 添加）`);
    return e;
  };
  const envCred = (): Credential | null => (env.OMEM_TOKEN ? { kind: "token", value: env.OMEM_TOKEN } : env.OMEM_AUTH_CMD ? { kind: "cmd", command: env.OMEM_AUTH_CMD } : null);
  const entryCred = (e: RemoteEntry | undefined): Credential | null => (e?.authCmd ? { kind: "cmd", command: e.authCmd } : e?.token ? { kind: "token", value: e.token } : null);
  const sameUrl = (url: string) => Object.entries(file.remotes).find(([, e]) => normalizeUrl(e.url) === url);
  // A run's token without an address is for the omem on this machine (what `omem tool` always did).
  const direct = o.url ?? (o.remote ? undefined : (env.OMEM_URL ?? (env.OMEM_TOKEN ? "http://127.0.0.1:4317" : undefined)));
  if (direct) {
    const url = normalizeUrl(direct);
    const saved = sameUrl(url);
    return { name: saved?.[0], url, credential: envCred() ?? entryCred(saved?.[1]) };
  }
  const name = o.remote ?? file.default;
  if (!name) return null;
  const e = entryOf(name);
  return { name, url: normalizeUrl(e.url), credential: entryCred(e) ?? envCred() };
}

/** A JWT's expiry (ms), read without checking it (the server checks); null when it is not a JWT. */
export function jwtExpiry(token: string): number | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const exp = (JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as { exp?: unknown }).exp;
    return typeof exp === "number" ? exp * 1000 : null;
  } catch {
    return null;
  }
}

/** Run the credential command: its standard output, trimmed, is the credential. */
export function runAuthCommand(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(command, { timeout: 60_000, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      const out = String(stdout).trim();
      if (err || !out) return reject(new Error(`取凭据的命令失败（${command}）：${(String(stderr).trim() || err?.message || "没有输出").slice(0, 500)}`));
      resolve(out.split(/\r?\n/).pop()!.trim());
    });
  });
}

/** What the client tells the server about itself (src/auth/external-tools.ts CLIENT_HEADERS). */
export type ClientInfo = { session: string; client?: string; agent?: string; model?: string; effort?: string; space?: string; spaces?: string; readOnly?: boolean };

export function clientHeaders(info: ClientInfo): Record<string, string> {
  const h: Record<string, string> = {};
  const put = (k: string, v: string | undefined) => {
    if (v) h[k] = encodeURIComponent(v);
  };
  put("x-omem-session", info.session);
  put("x-omem-client", info.client ?? clientName());
  put("x-omem-agent", info.agent);
  put("x-omem-model", info.model);
  put("x-omem-effort", info.effort);
  put("x-omem-space", info.space);
  put("x-omem-spaces", info.spaces);
  if (info.readOnly) h["x-omem-read-only"] = "1";
  return h;
}

/** A remote server's API with the credential: fetched on first use, again when it expires or is refused. */
export function remoteApi(target: RemoteTarget, headers: Record<string, string> = {}) {
  let cached: { value: string; until: number } | null = null;
  const credential = async (fresh = false) => {
    const c = target.credential;
    if (!c) throw new Error(`没有 ${target.url} 的凭据：设 OMEM_TOKEN 或 OMEM_AUTH_CMD，或者 omem login ${target.url}`);
    if (c.kind === "token") return c.value;
    if (!fresh && cached && cached.until > Date.now()) return cached.value;
    const value = await runAuthCommand(c.command);
    const exp = jwtExpiry(value);
    cached = { value, until: exp ? exp - 60_000 : Number.POSITIVE_INFINITY };
    return value;
  };
  const request = async (path: string, init: { method?: string; body?: unknown; timeoutMs?: number } = {}) => {
    const send = async (fresh: boolean) =>
      fetch(`${target.url}${path}`, {
        method: init.method ?? (init.body === undefined ? "GET" : "POST"),
        headers: { ...headers, authorization: `Bearer ${await credential(fresh)}`, ...(init.body === undefined ? {} : { "content-type": "application/json" }) },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(init.timeoutMs ?? 15 * 60_000),
      });
    let res = await send(false);
    // A credential from a command may have run out early: get a new one once.
    if (res.status === 401 && target.credential?.kind === "cmd") res = await send(true);
    return res;
  };
  const failure = async (res: Response) => {
    const text = await res.text();
    let msg = text;
    try {
      msg = (JSON.parse(text) as { error?: string }).error ?? text;
    } catch {
      // not JSON
    }
    return `${target.url} 返回 HTTP ${res.status}：${msg.slice(0, 500)}`;
  };
  return {
    request,
    failure,
    async json<T>(path: string, init: { method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<T> {
      const res = await request(path, init);
      if (!res.ok) throw new Error(await failure(res));
      return (await res.json()) as T;
    },
  };
}

/** The tools of a remote server for `omem tool` / `omem mcp`. */
export function remoteToolBackend(target: RemoteTarget, info: ClientInfo) {
  const api = remoteApi(target, clientHeaders(info));
  return {
    list: async () => (await api.json<{ tools: { name: string; description: string; inputSchema: Record<string, unknown> }[] }>("/api/tools", { timeoutMs: 30_000 })).tools,
    call: async (name: string, args: unknown): Promise<{ text: string; isError: boolean }> => {
      try {
        const res = await api.request(`/api/tools/${encodeURIComponent(name)}`, { body: args ?? {} });
        if (!res.ok) return { text: `调用失败：${await api.failure(res)}`, isError: true };
        return (await res.json()) as { text: string; isError: boolean };
      } catch (e) {
        return { text: `调用失败：${(e as Error).message}`, isError: true };
      }
    },
  };
}

/** Open a page in the default browser (no shell in between: the address may hold `&`). */
export async function openBrowser(url: string) {
  const { spawn } = await import("node:child_process");
  const [cmd, args] = process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}

/**
 * `omem login <地址>` (docs/v2/remote-clients.md §4.2): ask for a code, let the person allow it in the
 * browser, poll until the token comes. `say` prints what the person needs to see.
 */
export async function cliLogin(url: string, say: (line: string) => void, opts: { browser?: boolean; timeoutMs?: number } = {}) {
  const post = async <T>(path: string, body: unknown) => {
    const res = await fetch(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    const text = await res.text();
    let data: unknown = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    if (!res.ok) throw Object.assign(new Error(`${url} 返回 HTTP ${res.status}：${(data as { error?: string })?.error ?? text.slice(0, 300)}`), { status: res.status });
    return data as T;
  };
  const start = await post<{ code: string; secret: string; url: string; expiresAt: string }>("/api/auth/cli/start", { client: clientName() });
  say(`在浏览器里打开下面的地址，登录后确认（确认码 ${start.code}，10 分钟内有效）：\n${start.url}`);
  if (opts.browser !== false) await openBrowser(start.url);
  const until = Math.min(Date.parse(start.expiresAt), Date.now() + (opts.timeoutMs ?? 10 * 60_000));
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 2000));
    const r = await post<{ status: "waiting" } | { status: "done"; token: string; user: { id: string; name: string } }>("/api/auth/cli/poll", { code: start.code, secret: start.secret });
    if (r.status === "done") return r;
  }
  throw new Error("等确认超时了：重新 omem login");
}
