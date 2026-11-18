import { request as httpRequest, type IncomingMessage, type Server } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Duplex } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import type { App } from "./app.ts";
import { createApiToken, OWNER, revokeTokenValue, userForToken } from "./users.ts";
import { findPeer, listPeers, nodeId, savePeers, type Peer } from "./peers.ts";
import { trustedLocal } from "../server/origin.ts";

/**
 * Calling back (docs/v2/mesh.md §1.2): a device that can reach another one but cannot be reached
 * from it (a laptop behind NAT, a node only reachable `via` another) keeps a connection open to it,
 * and through it the other device calls this one like any paired device: `peer call`, `ask_agent`,
 * this one's ACP agents as a `peer` backend, its web pages.
 *
 * - The device that dials out (A) turns it on per device (`omem peer back <device> on`, 设置 → 设备)
 *   and signs that device an owner token of its own, sent each time it connects. Turning it off
 *   revokes the token.
 * - A holds one control connection (`/api/peer/back`, an upgrade to `omem-back`): lines of JSON,
 *   a ping each way. The device it reaches (B) keeps a record of A (`back`) with that token.
 * - When B wants to talk to A it asks over the control connection (`{open: n}`); A dials in once
 *   more (`/api/peer/back/stream`) and hands that connection to its own HTTP server as if B had
 *   connected to it. So one request (or one upgrade: an ACP session, a tunnel) is one connection,
 *   and nothing above the socket knows it went the other way: HTTP, tokens and routes are as ever.
 * - Processes other than the service on B (an ACP bridge, the CLI) get such a connection from their
 *   own service (`/api/peer/back/relay`), which holds the control connection.
 *
 * Requests that arrive this way are never "from this machine": the socket's address is the far
 * end's, and a loopback one (both ends on one host) is masked, so only a token gets them in.
 */

export const BACK_PATH = /^\/api\/peer\/back(\/stream|\/relay)?(\?|$)/;
const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const OPEN_TIMEOUT = 15_000;
const PING_MS = 30_000;
const DEAD_MS = 95_000;
const BACKOFF = [5_000, 30_000, 120_000, 300_000];

type Waiter = { ok: (s: Duplex) => void; fail: (e: Error) => void; timer: NodeJS.Timeout };
/** On the device reached: the devices that dialed in. */
type Link = { node: string; socket: Duplex; since: string; next: number; waiting: Map<number, Waiter>; seen: number; timer: NodeJS.Timeout; links: Map<string, Link> };

/** On the device that dials out: one per device it serves. */
type Dialer = { id: string; state: "connecting" | "connected" | "waiting"; since: string | null; error: string | null; attempts: number; socket: Duplex | null; timer: NodeJS.Timeout | null; stopped: boolean };

/**
 * Per data directory (tests run several instances in one process): `server` is the instance's HTTP
 * server when this process is its service (streams that came the other way are handed to it).
 */
type State = { server: Server | null; links: Map<string, Link>; dialers: Map<string, Dialer>; streams: Set<Duplex> };
const states = new Map<string, State>();
function st(home: string) {
  let s = states.get(home);
  if (!s) states.set(home, (s = { server: null, links: new Map(), dialers: new Map(), streams: new Set() }));
  return s;
}

// ------------------------------------------------------------------ helpers

function onLines(socket: Duplex, each: (msg: Record<string, unknown>) => void, head?: Buffer) {
  let buf = head?.length ? head.toString("utf8") : "";
  const flush = () => {
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        each(JSON.parse(line));
      } catch {}
    }
  };
  // Not setEncoding: a socket an HTTP server upgraded refuses it.
  const text = new StringDecoder("utf8");
  socket.on("data", (d: string | Buffer) => {
    buf += typeof d === "string" ? d : text.write(d);
    if (buf.length > 1 << 20) socket.destroy();
    else flush();
  });
  flush();
}

const send = (socket: Duplex, msg: Record<string, unknown>) => socket.writable && socket.write(JSON.stringify(msg) + "\n");

const refuse = (socket: Duplex, status: string, text = "") =>
  void socket.end(`HTTP/1.1 ${status}\r\ncontent-type: text/plain; charset=utf-8\r\nconnection: close\r\n\r\n${text}`);

const switched = (socket: Duplex, proto: string) => socket.write(`HTTP/1.1 101 Switching Protocols\r\nconnection: Upgrade\r\nupgrade: ${proto}\r\n\r\n`);

function ownerOf(app: App, req: IncomingMessage) {
  const h = req.headers.authorization;
  if (h?.startsWith("Bearer ")) return userForToken(app, h.slice(7)) === OWNER;
  return !app.config.token && trustedLocal(req, req.socket.remoteAddress ?? "", { refuseProxied: app.config.auth.enabled });
}

/** A loopback address would read as this machine: a stream from another node never is. */
function masked(socket: Duplex) {
  const s = socket as Duplex & { remoteAddress?: string };
  const real = s.remoteAddress ?? "";
  if (/^(127\.|::1$|::ffff:127\.)/.test(real) || !real) Object.defineProperty(s, "remoteAddress", { configurable: true, get: () => "0.0.0.0" });
  return socket;
}

// ------------------------------------------------- on the device reached (B)

/** Whether `id` has its connection open to this machine (outside the service, which holds them, not known: yes). */
export const backOnline = (home: string, id: string) => !st(home).server || st(home).links.has(id);

/** The record B keeps of a device that dials in: a direct pairing it already had stays, gaining `back`. */
function remember(app: App, node: string, token: string, name?: string) {
  const peers = listPeers(app);
  const p = peers.find((x) => x.id === node);
  const back = { token, since: new Date().toISOString(), ...(name && name !== node ? { name } : {}) };
  if (p) {
    if (p.back?.token === token) return;
    p.back = back;
  } else peers.push({ id: node, url: "", urls: [], token, addedAt: back.since, back });
  savePeers(app, peers);
}

/** A device turned calling back off: its record goes if that was all it was. */
function forget(app: App, node: string) {
  const peers = listPeers(app);
  const p = peers.find((x) => x.id === node);
  if (!p?.back) return;
  if (!p.url && !p.via) savePeers(app, peers.filter((x) => x !== p));
  else {
    delete p.back;
    savePeers(app, peers);
  }
}

function dropLink(link: Link, why: string) {
  if (link.links.get(link.node) === link) link.links.delete(link.node);
  clearInterval(link.timer);
  for (const w of link.waiting.values()) {
    clearTimeout(w.timer);
    w.fail(new Error(`设备 ${link.node} 的反向连接断开了：${why}`));
  }
  link.waiting.clear();
  link.socket.destroy();
}

function serveControl(app: App, req: IncomingMessage, socket: Duplex, head: Buffer, url: URL) {
  const node = url.searchParams.get("node") ?? "";
  const token = String(req.headers["x-omem-back-token"] ?? "");
  if (!ID.test(node) || node === nodeId(app)) return refuse(socket, "400 Bad Request", "node 不对");
  if (!/^om_[\w-]{20,}$/.test(token)) return refuse(socket, "400 Bad Request", "缺少反向连接的令牌");
  switched(socket, "omem-back");
  const links = st(app.home).links;
  const old = links.get(node);
  if (old) dropLink(old, "同一设备重新连上");
  remember(app, node, token, url.searchParams.get("name") ?? undefined);
  const link: Link = { node, socket, links, since: new Date().toISOString(), next: 0, waiting: new Map(), seen: Date.now(), timer: setInterval(() => {
    if (Date.now() - link.seen > DEAD_MS) return dropLink(link, "太久没有心跳");
    send(socket, { ping: Date.now() });
  }, PING_MS) };
  link.timer.unref();
  links.set(node, link);
  (socket as Duplex & { setKeepAlive?: (on: boolean, ms: number) => void }).setKeepAlive?.(true, 20_000);
  onLines(socket, (m) => {
    link.seen = Date.now();
    if (m.ping !== undefined) send(socket, { pong: m.ping });
    if (m.forget) {
      forget(app, node);
      dropLink(link, "对方关掉了反向连接");
    }
  }, head);
  socket.on("close", () => dropLink(link, "连接关闭"));
  socket.on("error", () => dropLink(link, "连接出错"));
}

function serveStream(app: App, socket: Duplex, head: Buffer, url: URL) {
  const link = st(app.home).links.get(url.searchParams.get("node") ?? "");
  const n = Number(url.searchParams.get("n"));
  const w = link?.waiting.get(n);
  if (!link || !w) return refuse(socket, "404 Not Found", "没有等着的连接");
  link.waiting.delete(n);
  clearTimeout(w.timer);
  switched(socket, "omem-back-stream");
  if (head.length) socket.unshift(head);
  // An upgraded server socket stays half open: when the far end is done, so is this one.
  socket.on("end", () => socket.end());
  w.ok(socket);
}

/** One connection to `id` over its control connection (in the process that holds it). */
function openHere(app: App, id: string): Promise<Duplex> {
  const link = st(app.home).links.get(id);
  if (!link) return Promise.reject(new Error(`设备 ${id} 现在没有连过来（它只能主动连本机，要等它上线并连上）`));
  return new Promise((ok, fail) => {
    const n = ++link.next;
    const timer = setTimeout(() => {
      link.waiting.delete(n);
      fail(new Error(`设备 ${id} 没有在 ${OPEN_TIMEOUT / 1000} 秒内连回来`));
    }, OPEN_TIMEOUT);
    link.waiting.set(n, { ok, fail, timer });
    send(link.socket, { open: n });
  });
}

/** From another process on this machine: the service holds the control connection and splices one through. */
function openViaService(app: App, id: string): Promise<Duplex> {
  return new Promise((ok, fail) => {
    const headers: Record<string, string> = { connection: "Upgrade", upgrade: "omem-back-relay", host: `127.0.0.1:${app.config.port}` };
    if (app.config.token) headers.authorization = `Bearer ${app.config.token}`;
    const req = httpRequest({ host: "127.0.0.1", port: app.config.port, path: `/api/peer/back/relay?node=${encodeURIComponent(id)}`, headers, agent: false });
    req.on("upgrade", (_res, socket, head) => {
      if (head.length) socket.unshift(head);
      ok(socket);
    });
    req.on("response", (res) => {
      let body = "";
      res.on("data", (d: Buffer) => (body += d.toString()));
      res.on("end", () => fail(new Error(body.trim() || `本机服务拒绝转接到 ${id}（HTTP ${res.statusCode}）`)));
    });
    req.on("error", (e) => fail(new Error(`设备 ${id} 只能经本机服务的反向连接访问，而本机服务没有在运行：${e.message}`)));
    req.end();
  });
}

/**
 * A raw connection to device `id`'s HTTP server over the connection it keeps to this machine: what a
 * request to a `back` device is sent over (`createConnection`).
 */
export function openBack(app: App, id: string): Promise<Duplex> {
  return st(app.home).server ? openHere(app, id) : openViaService(app, id);
}

function serveRelay(app: App, req: IncomingMessage, socket: Duplex, head: Buffer, url: URL) {
  const id = url.searchParams.get("node") ?? "";
  openHere(app, id).then(
    async (far) => {
      switched(socket, "omem-back-relay");
      if (head.length) far.write(head);
      const { splice } = await import("./peer-tunnel.ts");
      splice(socket, far);
    },
    (e: Error) => refuse(socket, "502 Bad Gateway", e.message),
  );
}

/** The upgrade paths, on this instance's server (http.ts). Returns true when it took the request. */
export function attachPeerBack(app: App, server: Server) {
  st(app.home).server = server;
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const m = BACK_PATH.exec(req.url ?? "");
    if (!m) return;
    if (!ownerOf(app, req)) return refuse(socket, "401 Unauthorized");
    const url = new URL(req.url ?? "/", "http://x");
    if (!m[1]) return serveControl(app, req, socket, head, url);
    if (m[1] === "/stream") return serveStream(app, socket, head, url);
    return serveRelay(app, req, socket, head, url);
  });
}

// ------------------------------------------------ on the device that dials (A)

/** Start calling back to every device it is turned on for (the service, after it listens). */
export function startPeerBack(app: App) {
  for (const p of listPeers(app)) if (p.serveBack) dial(app, p.id);
}

export function stopPeerBack(app: App) {
  const s = st(app.home);
  for (const d of s.dialers.values()) stopDialer(d);
  s.dialers.clear();
  for (const l of [...s.links.values()]) dropLink(l, "服务停止");
  // Streams handed to the server would keep it from closing (an agent session idles on one).
  for (const x of s.streams) x.destroy();
  states.delete(app.home);
}

function stopDialer(d: Dialer, bye = false) {
  d.stopped = true;
  if (d.timer) clearTimeout(d.timer);
  if (d.socket) {
    if (bye) send(d.socket, { forget: true });
    const s = d.socket;
    setTimeout(() => s.destroy(), bye ? 300 : 0).unref();
  }
}

function dial(app: App, id: string) {
  const dialers = st(app.home).dialers;
  const prev = dialers.get(id);
  if (prev) stopDialer(prev);
  const d: Dialer = { id, state: "connecting", since: null, error: null, attempts: 0, socket: null, timer: null, stopped: false };
  dialers.set(id, d);
  connect(app, d);
}

function retry(app: App, d: Dialer, why: string) {
  if (d.stopped) return;
  d.socket = null;
  d.state = "waiting";
  d.error = why;
  const wait = BACKOFF[Math.min(d.attempts, BACKOFF.length - 1)];
  d.attempts++;
  d.timer = setTimeout(() => connect(app, d), wait);
  d.timer.unref();
}

async function upgrade(app: App, id: string, path: string, proto: string, extra: Record<string, string> = {}): Promise<{ socket: Duplex; head: Buffer }> {
  const { peerRoute } = await import("./peer-tunnel.ts");
  const r = peerRoute(app, id, path, 0);
  if (r.connect) throw new Error(`设备 ${id} 也只能反向连接，两边都连不到对方`);
  const target = new URL(r.path, r.url);
  return new Promise((ok, fail) => {
    const req = (target.protocol === "https:" ? httpsRequest : httpRequest)(target, {
      headers: { connection: "Upgrade", upgrade: proto, authorization: `Bearer ${r.token}`, "x-omem-hops": String(r.hops), ...extra },
      agent: false,
    });
    req.setTimeout(20_000, () => req.destroy(new Error("连接超时")));
    req.on("upgrade", (_res, socket, head) => {
      req.setTimeout(0);
      ok({ socket, head });
    });
    req.on("response", (res) => {
      let body = "";
      res.on("data", (b: Buffer) => (body += b.toString()));
      res.on("end", () => fail(new Error(res.statusCode === 404 ? `设备 ${id} 的 omem 还不支持反向连接（更新它和中间的设备）` : `设备 ${id} 拒绝（HTTP ${res.statusCode}）${body.trim() ? `：${body.trim().slice(0, 200)}` : ""}`)));
    });
    req.on("error", (e) => fail(new Error(`连不上设备 ${id}：${e.message}`)));
    req.end();
  });
}

async function connect(app: App, d: Dialer) {
  if (d.stopped) return;
  const p = findPeer(app, d.id);
  if (!p?.serveBack) return void st(app.home).dialers.delete(d.id);
  d.state = "connecting";
  let socket: Duplex, head: Buffer;
  try {
    ({ socket, head } = await upgrade(app, d.id, `/api/peer/back?node=${encodeURIComponent(nodeId(app))}`, "omem-back", { "x-omem-back-token": p.serveBack.token }));
  } catch (e) {
    return retry(app, d, (e as Error).message);
  }
  if (d.stopped) return void socket.destroy();
  d.socket = socket;
  d.state = "connected";
  d.since = new Date().toISOString();
  d.error = null;
  let seen = Date.now();
  // Connected for a while: the next drop starts the backoff over.
  const settled = setTimeout(() => (d.attempts = 0), 60_000);
  settled.unref();
  const beat = setInterval(() => {
    if (Date.now() - seen > DEAD_MS) return void socket.destroy();
    send(socket, { ping: Date.now() });
  }, PING_MS);
  beat.unref();
  (socket as Duplex & { setKeepAlive?: (on: boolean, ms: number) => void }).setKeepAlive?.(true, 20_000);
  onLines(socket, (m) => {
    seen = Date.now();
    if (m.ping !== undefined) send(socket, { pong: m.ping });
    if (typeof m.open === "number") void stream(app, d.id, m.open);
  }, head);
  let gone = false;
  const down = (why: string) => {
    if (gone) return;
    gone = true;
    clearInterval(beat);
    clearTimeout(settled);
    retry(app, d, why);
  };
  socket.on("close", () => down("连接断开"));
  socket.on("error", (e) => down(e.message));
}

/** Dial in once more for the far end and serve what it sends like any connection to this machine. */
async function stream(app: App, id: string, n: number) {
  try {
    const { socket, head } = await upgrade(app, id, `/api/peer/back/stream?node=${encodeURIComponent(nodeId(app))}&n=${n}`, "omem-back-stream");
    if (head.length) socket.unshift(head);
    const s = st(app.home);
    if (!s.server) return void socket.destroy();
    s.streams.add(socket);
    socket.on("close", () => s.streams.delete(socket));
    s.server.emit("connection", masked(socket));
  } catch {
    // The far end times its wait out and says so.
  }
}

/** Turn calling back to a device on or off (on this machine, the one that dials). */
export function setServeBack(app: App, id: string, on: boolean) {
  const peers = listPeers(app);
  const p = peers.find((x) => x.id === id);
  if (!p) throw new Error(`没有名为 ${id} 的设备`);
  if (p.back && !p.url && !p.via) throw new Error(`设备 ${id} 本来就是反过来连本机的，本机连不到它`);
  if (on && !p.serveBack) {
    p.serveBack = { token: createApiToken(app, OWNER, `peer:back-${id}`), since: new Date().toISOString() };
    savePeers(app, peers);
  }
  if (!on && p.serveBack) {
    revokeTokenValue(app, p.serveBack.token);
    delete p.serveBack;
    savePeers(app, peers);
    const d = st(app.home).dialers.get(id);
    if (d) stopDialer(d, true);
    st(app.home).dialers.delete(id);
  }
  if (on && st(app.home).server && !st(app.home).dialers.has(id)) dial(app, id);
  return backState(app, id);
}

/** What the devices page shows for one device: this machine calling back to it, it calling back here. */
export function backState(app: App, id: string) {
  const p: Peer | null = findPeer(app, id);
  const d = st(app.home).dialers.get(id);
  const l = st(app.home).links.get(id);
  return {
    serving: p?.serveBack ? { state: d?.state ?? "off", since: d?.since ?? null, error: d?.error ?? null } : null,
    incoming: p?.back ? { online: !!l, since: l?.since ?? p.back.since } : null,
  };
}
