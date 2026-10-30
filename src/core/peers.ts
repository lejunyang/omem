import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, networkInterfaces } from "node:os";
import { join } from "node:path";
import type { App } from "./app.ts";
import { createApiToken, OWNER } from "./users.ts";

/**
 * Peers: other omem instances this one can talk to over HTTP.
 *
 * The typical setup is one instance that runs all the time (capture, schedules) and
 * others (laptops) that pull its data, look at its state and ask it to run checks.
 * Machines need not reach each other directly: a peer can be reached `via` another
 * peer, which forwards the request (`/api/peers/<id>/…`).
 *
 * Pairing is one line each way:
 *   on the server  `omem peer invite` → prints a code
 *   on the client  `omem peer add <code> [--via <peer>]`
 * The code carries the inviting node's id, every address it might be reached at
 * (each network interface, the host name) and an API token created for the owner
 * (label `peer:<label>`), so revoking it is revoking that token. `add` keeps the
 * addresses that answer; when the one in use stops answering (a new DHCP lease, a
 * VPN coming back on another interface) the others are tried again, so a paired
 * machine that was offline needs no new pairing. Tokens are per user, which leaves
 * room for other people's devices to pair as members later.
 */
export type Peer = { id: string; url: string; urls?: string[]; token: string; via?: string; addedAt: string };

const fileIn = (home: string) => join(home, "secrets", "peers.json");
const file = (app: App) => fileIn(app.home);

export function nodeId(app: App) {
  return (app.config.node?.id || hostname().split(".")[0] || "omem").toLowerCase().replace(/[^a-z0-9-]+/g, "-");
}

export function listPeers(app: App): Peer[] {
  return pairedIn(app.home);
}

/** The devices paired in a data directory (for code that has no App, like backend availability). */
export function pairedIn(home: string): Peer[] {
  try {
    return JSON.parse(readFileSync(fileIn(home), "utf8")) as Peer[];
  } catch {
    return [];
  }
}

function savePeers(app: App, peers: Peer[]) {
  mkdirSync(join(app.home, "secrets"), { recursive: true, mode: 0o700 });
  writeFileSync(file(app), JSON.stringify(peers, null, 2), { mode: 0o600 });
  try {
    chmodSync(file(app), 0o600);
  } catch {}
}

export function findPeer(app: App, id: string): Peer | null {
  return listPeers(app).find((p) => p.id === id) ?? null;
}

const trim = (u: string) => u.replace(/\/+$/, "");
const isLoopback = (host: string) => /^(127\.|localhost$|::1$)/.test(host);

/**
 * Addresses other machines might reach this instance at: each non-loopback IPv4
 * (private LAN ranges first), then the host name. Empty when the service only
 * listens on loopback, since nobody else could connect anyway.
 */
export function localUrls(app: App): string[] {
  const port = app.config.port;
  const host = app.config.host;
  if (isLoopback(host)) return [];
  if (host !== "0.0.0.0" && host !== "::") return [`http://${host}:${port}`];
  const ips = Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === "IPv4" && !i.internal)
    .map((i) => i!.address);
  const rank = (ip: string) => (/^192\.168\./.test(ip) ? 0 : /^10\./.test(ip) ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3);
  ips.sort((a, b) => rank(a) - rank(b));
  return [...new Set([...ips.map((ip) => `http://${ip}:${port}`), `http://${hostname()}:${port}`])];
}

/** Whether an omem service is answering on this machine's port. */
export async function serviceRunning(app: App) {
  try {
    const r = await fetch(`http://127.0.0.1:${app.config.port}/api/diag`, { signal: AbortSignal.timeout(2000) });
    return r.status < 500;
  } catch {
    return false;
  }
}

/** A pairing code for another machine: this node's id, its addresses and a new owner token. */
export function invite(app: App, opts: { url?: string; label?: string } = {}) {
  const id = nodeId(app);
  const urls = opts.url ? [trim(opts.url)] : localUrls(app);
  const token = createApiToken(app, OWNER, `peer:${opts.label ?? "device"}`);
  const code = "omem1." + Buffer.from(JSON.stringify({ id, urls, token })).toString("base64url");
  return { id, urls, code };
}

export function decodeInvite(code: string): { id: string; urls: string[]; token: string } {
  const m = /^omem1\.([A-Za-z0-9_-]+)$/.exec(code.trim());
  if (!m) throw new Error("配对码格式不对（应以 omem1. 开头）");
  const v = JSON.parse(Buffer.from(m[1], "base64url").toString("utf8"));
  const urls: string[] = (v.urls ?? (v.url ? [v.url] : [])).filter(Boolean).map(trim);
  if (!v.id || !v.token) throw new Error("配对码不完整");
  return { id: v.id, urls, token: v.token };
}

async function answers(url: string, token: string) {
  try {
    const r = await fetch(url + "/api/diag", { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * Add (or re-add) a peer from its code. Direct peers keep every address from the
 * code, the first one that answers in front; `via` peers are reached through the
 * middle node, which needs them paired with it under the same id.
 */
export async function addPeer(app: App, code: string, opts: { via?: string; url?: string } = {}) {
  const v = decodeInvite(code);
  if (opts.via && !findPeer(app, opts.via)) throw new Error(`没有名为 ${opts.via} 的设备；先添加它`);
  let urls = opts.url ? [trim(opts.url)] : v.urls;
  if (!opts.via) {
    if (!urls.length) throw new Error("配对码里没有地址（对方服务只监听本机）；对方把 host 改为 0.0.0.0 后重新 invite，或这里用 --url 指定");
    const ok: string[] = [];
    for (const u of urls) if (await answers(u, v.token)) ok.push(u);
    urls = [...ok, ...urls.filter((u) => !ok.includes(u))];
  }
  const peer: Peer = { id: v.id, url: urls[0] ?? "", urls, token: v.token, via: opts.via, addedAt: new Date().toISOString() };
  savePeers(app, [...listPeers(app).filter((p) => p.id !== peer.id), peer]);
  return peer;
}

/** Point a direct peer at a new address (it moved and none of the known ones answer). */
export function setPeerUrl(app: App, id: string, url: string) {
  const peers = listPeers(app);
  const p = peers.find((x) => x.id === id);
  if (!p) throw new Error(`没有名为 ${id} 的设备`);
  p.url = trim(url);
  p.urls = [p.url, ...(p.urls ?? []).filter((u) => u !== p.url)];
  delete p.via;
  savePeers(app, peers);
  return p;
}

/**
 * Forget a device. A direct one is first asked to revoke the token it gave us (`/api/peer/unpair`;
 * best effort: an older or offline device keeps it until `omem user revoke` there). Profiles that
 * used its agents go too.
 */
export async function removePeer(app: App, id: string) {
  const before = listPeers(app);
  const p = before.find((x) => x.id === id);
  let revoked = false;
  if (p && !p.via) revoked = await peerJson<{ revoked: boolean }>(app, id, "/api/peer/unpair", {}, 5000).then((r) => r.revoked, () => false);
  savePeers(app, before.filter((x) => x.id !== id));
  await dropPeerAgents(app, (x) => x.id === id);
  return { removed: !!p, revoked };
}

/**
 * Stop using some devices' agents here: their profiles go, and roles, the default and the
 * fallback list that named them go back to choosing on their own.
 */
export async function dropPeerAgents(app: App, which: (peer: { id: string; agent: string }) => boolean) {
  const a = app.config.agents;
  const gone = new Set(a.profiles.filter((x) => x.peer && which(x.peer)).map((x) => x.id));
  if (!gone.size) return;
  a.profiles = a.profiles.filter((x) => !gone.has(x.id));
  for (const [role, profile] of Object.entries(a.roles)) if (gone.has(profile)) delete a.roles[role];
  if (a.default && gone.has(a.default)) a.default = undefined;
  a.fallback = a.fallback.filter((x) => !gone.has(x.profile));
  const { saveConfig } = await import("./config.ts");
  saveConfig(app.config, app.home);
}

/**
 * Request a path on a peer. A peer reached `via` another one goes through that peer's
 * forwarding endpoint with that peer's token (any depth, at most a few hops).
 */
export async function peerFetch(app: App, id: string, path: string, init: RequestInit & { timeoutMs?: number } = {}, hops = 0): Promise<Response> {
  if (hops > 4) throw new Error("设备转发层数过多");
  const p = findPeer(app, id);
  if (!p) throw new Error(`没有名为 ${id} 的设备（omem peer list 查看）`);
  if (p.via) return peerFetch(app, p.via, `/api/peers/${encodeURIComponent(p.id)}${path}`, init, hops + 1);
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${p.token}`);
  headers.set("x-omem-hops", String(hops));
  const go = (url: string) => fetch(url + path, { ...init, headers, signal: AbortSignal.timeout(init.timeoutMs ?? 120_000) });
  try {
    return await go(p.url);
  } catch (e) {
    // The address in use stopped answering: try the others from the code once, and
    // remember the one that works.
    for (const u of (p.urls ?? []).filter((u) => u !== p.url)) {
      if (!(await answers(u, p.token))) continue;
      const peers = listPeers(app);
      const q = peers.find((x) => x.id === p.id);
      if (q) {
        q.url = u;
        savePeers(app, peers);
      }
      return go(u);
    }
    throw new Error(`连不上设备 ${p.id}（${p.url}）：${(e as Error).message}`);
  }
}

export async function peerJson<T = unknown>(app: App, id: string, path: string, body?: unknown, timeoutMs?: number): Promise<T> {
  const res = await peerFetch(app, id, path, body === undefined ? { timeoutMs } : { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" }, timeoutMs });
  const text = await res.text();
  const data = text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null;
  if (!res.ok) throw new Error(`${id}：${(data as { error?: string })?.error ?? res.statusText}`);
  return data as T;
}

/** The code version this instance runs (git commit of the package, if it is a checkout). */
export function codeVersion(root: string) {
  if (!existsSync(join(root, ".git"))) return null;
  const r = spawnSync("git", ["-C", root, "log", "-1", "--format=%h %cI %s"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

/**
 * A local web server that shows a peer's web UI: every request goes to the peer
 * (through its `via` chain if any) with the paired token, so the browser needs no
 * token and the peer need not be reachable from here. Listens on 127.0.0.1 only.
 * Uploads (multipart) work for direct peers; through a middle node only JSON bodies do.
 * Web VS Code (/ide, with its WebSocket) goes through the raw tunnel instead (peer-tunnel.ts).
 */
export async function openPeerUi(app: App, id: string, port = 0) {
  if (!findPeer(app, id)) throw new Error(`没有名为 ${id} 的设备（omem peer list 查看）`);
  const { createServer } = await import("node:http");
  const { Readable } = await import("node:stream");
  const { tunneled, tunnelHttp, tunnelUpgrade } = await import("./peer-tunnel.ts");
  const { trustedLocal } = await import("../server/origin.ts");
  // Everything here goes out with the owner's token: only this machine's browser, not another site's page.
  const refuse = (req: import("node:http").IncomingMessage) => !trustedLocal(req, req.socket.remoteAddress ?? "");
  const server = createServer(async (req, res) => {
    if (refuse(req)) return void res.writeHead(403, { "content-type": "text/plain; charset=utf-8" }).end("只接受本机浏览器直接打开的请求");
    if (tunneled(req.url ?? "/")) return tunnelHttp(app, id, req.url ?? "/", req, res);
    try {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const headers: Record<string, string> = {};
      for (const h of ["content-type", "accept", "last-event-id", "range", "if-none-match", "if-modified-since"]) {
        const v = req.headers[h];
        if (typeof v === "string") headers[h] = v;
      }
      const body = chunks.length && req.method !== "GET" && req.method !== "HEAD" ? Buffer.concat(chunks) : undefined;
      const up = await peerFetch(app, id, req.url ?? "/", { method: req.method, headers, body, timeoutMs: 24 * 3600_000 });
      const out: Record<string, string> = {};
      // fetch already decoded the body; length and encoding no longer apply.
      up.headers.forEach((v, k) => {
        if (!["content-encoding", "content-length", "transfer-encoding", "connection"].includes(k)) out[k] = v;
      });
      res.writeHead(up.status, out);
      if (!up.body) return void res.end();
      const stream = Readable.fromWeb(up.body as never);
      req.on("close", () => stream.destroy());
      stream.on("error", () => res.end());
      stream.pipe(res);
    } catch (e) {
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: (e as Error).message }));
    }
  });
  server.on("upgrade", (req, socket, head) => {
    if (refuse(req)) return void socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    if (tunneled(req.url ?? "/")) tunnelUpgrade(app, id, req.url ?? "/", req, socket, head);
    else socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
  });
  await new Promise<void>((ok, fail) => server.once("error", fail).listen(port, "127.0.0.1", () => ok()));
  const addr = server.address() as { port: number };
  return { url: `http://127.0.0.1:${addr.port}`, close: () => new Promise((r) => server.close(r)) };
}
