import * as http from "node:http";
import * as https from "node:https";
import * as tls from "node:tls";
import { networkInterfaces } from "node:os";
import { proxyTunnel } from "./network-request.ts";
import { BlockList, connect, isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { once } from "node:events";
import type { Duplex } from "node:stream";

/** `local`: the address is this machine's own (loopback, unspecified or one of its interfaces); `ip`: the address the proxy will connect to. */
export type Destination = { url: URL; method: string; tunnel: boolean; private: boolean; local?: boolean; ip?: string; body?: Buffer; contentType?: string };
export type HostUsage = { host: string; count: number; bytes: number; denied: number; backend: boolean; lastDeniedAt?: number; error?: string };
export type ProxyOptions = {
  check: (d: Destination) => Promise<{ allowed: boolean; reason?: string; backend?: boolean }>;
  needsBody: (url: URL) => boolean;
  callback?: { origin: string; token: string; target?: string };
  inspect?: (host: string) => Promise<https.ServerOptions | undefined>;
  resolve?: (host: string) => Promise<string>;
  ca?: Buffer;
  upstreamProxy?: (protocol: string) => URL | undefined;
  /** A browser opens many connections to many hosts over a long time (remote/browser-guard.ts); a run's defaults are 64 and 256. */
  limits?: { connections: number; hosts: number };
  /** Does not keep the process alive by itself (a proxy that lives as long as omem). */
  unref?: boolean;
};

const reserved = new BlockList();
for (const [ip, prefix] of Object.entries({ "0.0.0.0": 8, "10.0.0.0": 8, "100.64.0.0": 10, "127.0.0.0": 8, "169.254.0.0": 16, "172.16.0.0": 12, "192.0.0.0": 24, "192.0.2.0": 24, "192.88.99.0": 24, "192.168.0.0": 16, "198.18.0.0": 15, "198.51.100.0": 24, "203.0.113.0": 24, "224.0.0.0": 3 })) reserved.addSubnet(ip, prefix);
const global6 = new BlockList();
global6.addSubnet("2000::", 3, "ipv6");
for (const [ip, prefix] of [["2001::", 23], ["2001:db8::", 32], ["2002::", 16]] as const) reserved.addSubnet(ip, prefix, "ipv6");
export function privateAddress(ip: string) {
  return isIP(ip) === 6 ? !global6.check(ip, "ipv6") || reserved.check(ip, "ipv6") : isIP(ip) !== 4 || reserved.check(ip);
}

function headers(input: http.IncomingHttpHeaders) {
  const copy = { ...input };
  for (const key of ["connection", "keep-alive", "proxy-connection", "proxy-authorization", "proxy-authenticate", "transfer-encoding", "upgrade", "trailer", "te", ...(input.connection ?? "").toLowerCase().split(",").map(k => k.trim())]) delete copy[key];
  return copy;
}
const callbackPath = /^\/(?:mcp|api\/(?:tools(?:\/[a-zA-Z0-9_-]+)?|command-gate|credentials\/outcome|operation-gate\/http|remote\/agent-browser))$/;
/** The API-key relay (core/ai-relay.ts): a backend's own token, checked by the route, not the run's. */
const relayPath = /^\/api\/ai\/relay\/[^/]+\/[^/]+\/(?:openai|anthropic)\//;
const hostName = (url: URL) => url.hostname.replace(/^\[|\]$/g, "");
class Refused extends Error { }
/** `listen`: a socket path (a run's sandbox) or a loopback TCP port (a browser, which cannot use a path). */
export async function startProxy(listen: string | { host: string; port: number }, opts: ProxyOptions) {
  const maxConnections = opts.limits?.connections ?? 64;
  const maxHosts = opts.limits?.hosts ?? 256;
  const usage = new Map<string, HostUsage>();
  const sockets = new Set<Duplex>();
  const lifetime = new AbortController();
  const hostAddresses = new BlockList();
  hostAddresses.addSubnet("127.0.0.0", 8);
  hostAddresses.addAddress("0.0.0.0");
  hostAddresses.addAddress("::", "ipv6");
  for (const nic of Object.values(networkInterfaces()).flat()) {
    if (nic) hostAddresses.addAddress(nic.address, isIP(nic.address) === 6 ? "ipv6" : "ipv4");
  }
  const local = (ip: string) => hostAddresses.check(ip, isIP(ip) === 6 ? "ipv6" : "ipv4");
  let closed = false;
  let connecting = 0;
  async function dial(url: URL, ip: string, port: number) {
    if (connecting >= maxConnections) throw new Refused("等待上游的连接数已达上限");
    connecting++;
    try { return await connectPeer(url, ip, port); } finally { connecting--; }
  }
  async function connectPeer(url: URL, ip: string, port: number) {
    const via = opts.upstreamProxy?.(url.protocol);
    if (!via) {
      const peer = connect(port, ip);
      track(peer);
      await once(peer, "connect");
      return peer;
    }
    const peer = await proxyTunnel(via, (isIP(ip) === 6 ? "[" + ip + "]" : ip) + ":" + port, lifetime.signal);
    track(peer);
    return peer;
  }
  function track(socket: Duplex) {
    if (closed) { socket.destroy(); return; }
    sockets.add(socket);
    socket.on("error", () => socket.destroy()).once("close", () => sockets.delete(socket));
  }
  function row(url: URL) {
    let r = usage.get(url.host);
    if (!r) {
      if (usage.size >= maxHosts) throw new Refused("运行访问的主机数已达上限");
      r = { host: url.host, count: 0, bytes: 0, denied: 0, backend: false };
      usage.set(url.host, r);
    }
    r.count++;
    return r;
  }
  async function address(url: URL) {
    const host = hostName(url);
    return isIP(host) ? host : opts.resolve ? opts.resolve(host) : (await lookup(host)).address;
  }
  function servicePort(url: URL, ip: string) {
    if (!opts.callback) return false;
    const entry = new URL(opts.callback.target ?? opts.callback.origin);
    return Number(url.port || (url.protocol === "https:" ? 443 : 80)) === Number(entry.port || 80)
      && local(ip);
  }
  function refuse(r: HostUsage, message: string): never {
    r.denied++;
    r.lastDeniedAt = Date.now();
    throw new Refused(message);
  }
  async function gate(d: Destination, r: HostUsage) {
    const result = await opts.check(d);
    if (!result.allowed) refuse(r, result.reason ?? "出网规则拒绝请求");
    if (result.backend) r.backend = true;
  }
  async function send(req: http.IncomingMessage, res: http.ServerResponse, inside?: URL) {
    const raw = req.url ?? "";
    const url = raw.startsWith("/") ? new URL(raw, inside ?? "http://" + req.headers.host) : new URL(raw);
    url.hostname = url.hostname.replace(/\.$/, "");
    const callback = !inside && opts.callback && url.origin === opts.callback.origin;
    if (url.username || url.password || (inside ? inside.origin !== url.origin : url.protocol !== "http:") || (raw.startsWith("/") && !inside && !callback)) throw new Refused("请求地址无效");
    if (callback && !relayPath.test(url.pathname) && (!callbackPath.test(url.pathname) || req.headers.authorization !== "Bearer " + opts.callback!.token)) throw new Refused("需要本次运行的入口与令牌");
    if (callback && opts.callback?.target) {
      const target = new URL(opts.callback.target);
      url.host = target.host;
    }
    const ip = await address(url);
    let body: Buffer | undefined;
    let r: HostUsage | undefined;
    if (!callback) {
      r = row(url);
      if (servicePort(url, ip)) refuse(r, "宿主入口需要本次运行令牌");
      if (opts.needsBody(url)) {
        if (req.headers["content-encoding"] && req.headers["content-encoding"] !== "identity") refuse(r, "无法检查压缩的请求体");
        const chunks: Buffer[] = [];
        let n = 0;
        for await (const chunk of req.iterator({ destroyOnReturn: false })) {
          n += chunk.length;
          if (n > 1024 * 1024) refuse(r, "请求体超过规则检查上限");
          chunks.push(chunk);
        }
        body = Buffer.concat(chunks);
      }
      await gate({ url, method: req.method!, body, tunnel: false, private: local(ip) || privateAddress(ip), local: local(ip), ip, contentType: req.headers["content-type"] }, r);
    }
    if (closed || res.destroyed) return;
    const h = headers(req.headers);
    h.host = url.host;
    if (body) h["content-length"] = String(body.length);
    else if (req.headers["transfer-encoding"]) h["transfer-encoding"] = "chunked";
    // Connect to the checked address directly. A second DNS answer must never change the peer.
    let agent: https.Agent | http.Agent | false = false;
    if (!callback && opts.upstreamProxy?.(url.protocol)) {
      const peer = await dial(url, ip, Number(url.port || (inside ? 443 : 80)));
      if (closed || res.destroyed) { peer.destroy(); return; }
      agent = inside ? new https.Agent() : new http.Agent();
      agent.createConnection = () => inside ? tls.connect({ socket: peer, servername: hostName(url), ca: opts.ca, rejectUnauthorized: true }) : peer;
    }
    const upstream = (inside ? https : http).request({
      hostname: ip, port: url.port || (inside ? 443 : 80), servername: hostName(url), ca: opts.ca, rejectUnauthorized: true, agent,
      path: url.pathname + url.search, method: req.method, headers: h
    }, reply => {
      res.writeHead(reply.statusCode!, headers(reply.headers));
      reply.on("error", () => res.destroy());
      if (r) reply.on("data", b => { r.bytes += b.length; });
      reply.pipe(res);
    });
    if (callback && url.pathname === "/api/command-gate") upstream.on("information", info => {
      if (info.statusCode === 102 && !res.destroyed) res.writeProcessing();
    });
    res.once("close", () => upstream.destroy());
    upstream.on("error", () => { if (!res.headersSent) res.writeHead(502).end("上游连接或证书验证失败"); else res.destroy(); });
    if (body) { r!.bytes += body.length; upstream.end(body); }
    else { if (r) req.on("data", b => { r.bytes += b.length; }); req.pipe(upstream); }
  }
  let requests = 0;
  function handler(inside?: URL): http.RequestListener {
    return (req, res) => {
      if (requests >= maxConnections) { res.writeHead(429, { connection: "close" }).end("代理请求数已达上限"); return; }
      requests++;
      const finished = new Promise<void>(resolve => res.once("close", resolve));
      void send(req, res, inside).catch(e => {
        if (res.headersSent) res.destroy();
        else res.writeHead(e instanceof Refused ? 403 : 502, { connection: "close" }).end(e instanceof Refused ? e.message : "代理无法处理请求");
      }).then(() => finished).finally(() => requests--);
    };
  }
  const server = http.createServer(handler());
  server.maxConnections = maxConnections;
  server.on("connection", track);
  server.on("connect", (req, socket, head) => {
    void (async () => {
      if (!/^(?:[\w.-]+|\[[\da-f:]+\]):\d+$/i.test(req.url ?? "")) throw new Refused("隧道地址无效");
      const url = new URL("https://" + req.url);
      url.hostname = url.hostname.replace(/\.$/, "");
      const cert = await opts.inspect?.(url.hostname);
      if (closed || socket.destroyed) return;
      if (cert) {
        const tls = https.createServer(cert, handler(url));
        tls.on("tlsClientError", (_e, s) => {
          if (usage.has(url.host) || usage.size < maxHosts) {
            const host = row(url);
            host.denied++;
            host.lastDeniedAt = Date.now();
            host.error = "解密握手失败，请检查沙箱信任包及客户端是否钉了证书";
          }
          s.destroy();
        });
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) socket.unshift(head);
        tls.emit("connection", socket);
        return;
      }
      const r = row(url);
      const ip = await address(url);
      if (servicePort(url, ip)) refuse(r, "宿主入口需要本次运行令牌");
      await gate({ url, method: "CONNECT", private: local(ip) || privateAddress(ip), local: local(ip), ip, tunnel: true }, r);
      if (closed || socket.destroyed) return;
      const peer = await dial(url, ip, Number(url.port || 443));
      if (closed || socket.destroyed) { peer.destroy(); return; }
      socket.once("close", () => peer.destroy());
      peer.once("close", () => socket.destroy());
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      r.bytes += head.length;
      if (head.length) peer.write(head);
      for (const s of [socket, peer]) s.on("data", b => { r.bytes += b.length; });
      socket.pipe(peer).pipe(socket);
    })().catch(e => {
      const reason = e instanceof Refused ? e.message : "代理无法连接上游";
      socket.end("HTTP/1.1 " + (e instanceof Refused ? "403 Forbidden" : "502 Bad Gateway") + "\r\nConnection: close\r\nContent-Length: " + Buffer.byteLength(reason) + "\r\n\r\n" + reason);
    });
  });
  if (typeof listen === "string") server.listen(listen);
  else server.listen(listen.port, listen.host);
  await once(server, "listening");
  if (opts.unref) server.unref();
  const bound = server.address();
  return { usage, port: bound && typeof bound === "object" ? bound.port : 0, close() { closed = true; lifetime.abort(); server.close(); for (const s of sockets) s.destroy(); } };
}
