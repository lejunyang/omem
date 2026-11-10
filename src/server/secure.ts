import { spawnSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createSecureServer, type Http2ServerRequest, type Http2ServerResponse } from "node:http2";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { homedir, hostname, networkInterfaces } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import type { App } from "../core/app.ts";

/**
 * The HTTPS listener beside the plain one (`https` in config): browsers speak HTTP/2 over it, so
 * all of a browser's tabs share one connection instead of six per address under HTTP/1.1, where
 * every open omem tab holds one for its live events. Browsers only do HTTP/2 over TLS, hence the
 * certificate. It serves the same routes: HTTP/1.1 clients (WebSocket upgrades, `curl`) still
 * work on it (`allowHTTP1`). The plain port stays as it is, for this machine's agents, the CLI and
 * paired devices.
 */
export type HttpsSettings = { port: number; cert?: string; key?: string; selfSigned: boolean; hosts: string[] };

/** Headers HTTP/2 forbids (RFC 9113 §8.2.2): Node throws on some, warns on others. */
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "http2-settings"]);

/**
 * Lets code written for HTTP/1.1 run on an HTTP/2 request: `Host` from `:authority` (origin checks,
 * loopback trust and absolute URLs read it), and connection-specific headers dropped from the
 * response (proxied upstream headers, the event stream's `connection: keep-alive`).
 */
export function http2Compat(req: Http2ServerRequest, res: Http2ServerResponse) {
  if (req.httpVersionMajor !== 2) return;
  // The pseudo-headers (`:path`, `:method`, …) stay where `req.url` / `req.method` read them, out of
  // `req.headers`: the IDE and peer proxies copy those headers upstream, and Node refuses `:` names there.
  const headers: Record<string, string | string[] | undefined> = {};
  for (const [k, v] of Object.entries(req.headers)) if (!k.startsWith(":")) headers[k] = v;
  const authority = req.headers[":authority"];
  if (!headers.host && typeof authority === "string") headers.host = authority;
  Object.defineProperty(req, "headers", { value: headers, writable: true, configurable: true, enumerable: true });
  const setHeader = res.setHeader.bind(res);
  res.setHeader = ((name: string, value: number | string | readonly string[]) => (HOP_BY_HOP.has(name.toLowerCase()) ? res : setHeader(name, value))) as typeof res.setHeader;
  const writeHead = res.writeHead.bind(res) as (status: number, ...rest: unknown[]) => Http2ServerResponse;
  res.writeHead = ((status: number, ...rest: unknown[]) => {
    // HTTP/2 has no status message (Node warns about one).
    const args = rest.filter((a) => typeof a !== "string").map((a) => {
      if (Array.isArray(a)) {
        // Raw headers: [name, value, name, value, …] or [[name, value], …].
        if (a.length && Array.isArray(a[0])) return (a as [string, string][]).filter(([n]) => !HOP_BY_HOP.has(String(n).toLowerCase()));
        const out: unknown[] = [];
        for (let i = 0; i + 1 < a.length; i += 2) if (!HOP_BY_HOP.has(String(a[i]).toLowerCase())) out.push(a[i], a[i + 1]);
        return out;
      }
      if (a && typeof a === "object") return Object.fromEntries(Object.entries(a).filter(([n]) => !HOP_BY_HOP.has(n.toLowerCase())));
      return a;
    });
    for (const n of HOP_BY_HOP) if (res.hasHeader(n)) res.removeHeader(n);
    return writeHead(status, ...args);
  }) as typeof res.writeHead;
}

const expand = (home: string, p: string) => {
  const t = p.trim().replace(/^~(?=$|[\\/])/, homedir());
  return isAbsolute(t) ? t : resolve(home, t);
};

/** Names a self-signed certificate is made for: this machine, its addresses, `webUrl`, and `https.hosts`. */
export function certificateNames(webUrl: string | undefined, extra: string[]) {
  const names = new Set<string>(["localhost", "127.0.0.1", "::1", hostname()]);
  for (const list of Object.values(networkInterfaces())) for (const a of list ?? []) if (!a.internal) names.add(a.address);
  try {
    if (webUrl?.trim()) names.add(new URL(webUrl.trim()).hostname.replace(/^\[|\]$/g, ""));
  } catch {}
  for (const h of extra) if (h.trim()) names.add(h.trim());
  return [...names].filter(Boolean);
}

const isIp = (n: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(n) || n.includes(":");

/**
 * A self-signed certificate in `<home>/tls/`, made with `openssl` and made again when the names it
 * covers changed (a new address) or it is about to expire. Browsers warn until it is trusted.
 */
export function ensureSelfSigned(home: string, names: string[], openssl = "openssl") {
  const dir = join(home, "tls");
  const cert = join(dir, "self-signed.crt");
  const key = join(dir, "self-signed.key");
  const want = [...new Set(names)].sort();
  if (existsSync(cert) && existsSync(key)) {
    try {
      const x = new X509Certificate(readFileSync(cert));
      const has = new Set((x.subjectAltName ?? "").split(/,\s*/).map((s) => s.replace(/^(DNS|IP Address):/, "").toLowerCase()));
      const fresh = new Date(x.validTo).getTime() - Date.now() > 30 * 86_400_000;
      if (fresh && want.every((n) => has.has(n.toLowerCase()))) return { cert, key, made: false };
    } catch {}
  }
  mkdirSync(dir, { recursive: true });
  const san = want.map((n) => `${isIp(n) ? "IP" : "DNS"}:${n}`).join(",");
  const r = spawnSync(openssl, ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "825", "-keyout", key, "-out", cert, "-subj", "/CN=omem", "-addext", `subjectAltName=${san}`, "-addext", "basicConstraints=critical,CA:FALSE", "-addext", "extendedKeyUsage=serverAuth"], { encoding: "utf8", env: { ...process.env, MSYS_NO_PATHCONV: "1" } });
  if (r.error || r.status !== 0)
    throw new Error(`生成自签名证书要用 openssl（${r.error ? r.error.message : (r.stderr || "").trim().split("\n").at(-1)}）：装上 openssl，或在 https.cert / https.key 里给已有的证书和私钥`);
  return { cert, key, made: true };
}

export function fingerprint(certPem: Buffer) {
  try {
    return new X509Certificate(certPem).fingerprint256;
  } catch {
    return createHash("sha256").update(certPem).digest("hex");
  }
}

/**
 * Starts the HTTPS (HTTP/2) listener for `server`'s routes: requests go through Fastify's router,
 * WebSocket upgrades to the same `upgrade` listeners as the plain port.
 */
export async function listenSecure(app: App, server: FastifyInstance, host: string, settings: HttpsSettings, quiet = false) {
  let certFile: string, keyFile: string;
  if (settings.cert?.trim() && settings.key?.trim()) {
    certFile = expand(app.home, settings.cert);
    keyFile = expand(app.home, settings.key);
  } else if (settings.selfSigned) {
    const made = ensureSelfSigned(app.home, certificateNames(app.config.webUrl, settings.hosts));
    certFile = made.cert;
    keyFile = made.key;
    if (made.made && !quiet) console.log(`[omem] 生成了自签名证书 ${certFile}`);
  } else {
    throw new Error("https 要给 cert 和 key（证书和私钥的路径），或设 selfSigned: true");
  }
  const cert = readFileSync(certFile);
  const key = readFileSync(keyFile);
  const secure = createSecureServer({ allowHTTP1: true, cert, key }, (req, res) => {
    http2Compat(req, res);
    server.routing(req as unknown as IncomingMessage, res as unknown as ServerResponse);
  });
  // Like Fastify's own HTTP/2 server: an idle session is closed (the browser opens a new one).
  secure.on("session", (s) => s.setTimeout(72_000, () => s.close()));
  secure.on("upgrade", (req, socket, head) => {
    if (server.server.listenerCount("upgrade")) server.server.emit("upgrade", req, socket, head);
    else socket.destroy();
  });
  // Event streams never end by themselves: closing drops every connection (HTTP/2 and HTTP/1.1).
  const sockets = new Set<Socket>();
  secure.on("secureConnection", (s: Socket) => {
    sockets.add(s);
    s.once("close", () => sockets.delete(s));
  });
  await new Promise<void>((ok, fail) => secure.once("error", fail).listen(settings.port, host, () => (secure.off("error", fail), ok())));
  secure.on("error", (e) => console.error(`[omem] HTTPS 监听出错：${(e as Error).message}`));
  const port = (secure.address() as { port: number }).port;
  if (!quiet) console.log(`omem HTTPS（HTTP/2）：https://${host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host}:${port}（证书指纹 ${fingerprint(cert)}）`);
  return {
    port,
    server: secure,
    close: () =>
      new Promise<void>((ok) => {
        secure.close(() => ok());
        for (const s of sockets) s.destroy();
      }),
  };
}
export type SecureListener = Awaited<ReturnType<typeof listenSecure>>;
