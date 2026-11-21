import * as http from "node:http";
import * as https from "node:https";
import { BlockList, connect, isIP, type Socket } from "node:net";
import { lookup } from "node:dns/promises";
import { once } from "node:events";
import type { Duplex } from "node:stream";

export type Destination = { url: URL; method: string; tunnel: boolean; private: boolean; body?: Buffer; contentType?: string };
export type HostUsage = { host: string; count: number; bytes: number; denied: number; backend: boolean };
export type ProxyOptions = {
  check: (d: Destination) => Promise<{ allowed: boolean; reason?: string; backend?: boolean }>;
  needsBody: (url: URL) => boolean;
  callback?: { origin: string; token: string };
  inspect?: (host: string) => Promise<https.ServerOptions | undefined>;
  resolve?: (host: string) => Promise<string>;
  ca?: Buffer;
};

const reserved = new BlockList();
for (const [ip, prefix] of Object.entries({ "0.0.0.0":8, "10.0.0.0":8, "100.64.0.0":10, "127.0.0.0":8, "169.254.0.0":16, "172.16.0.0":12, "192.0.0.0":24, "192.0.2.0":24, "192.88.99.0":24, "192.168.0.0":16, "198.18.0.0":15, "198.51.100.0":24, "203.0.113.0":24, "224.0.0.0":3 })) reserved.addSubnet(ip, prefix);
const global6 = new BlockList();
global6.addSubnet("2000::", 3, "ipv6");
for (const [ip, prefix] of [["2001::",23], ["2001:db8::",32], ["2002::",16]] as const) reserved.addSubnet(ip,prefix,"ipv6");
export function privateAddress(ip: string) {
  return isIP(ip) === 6 ? !global6.check(ip,"ipv6") || reserved.check(ip,"ipv6") : isIP(ip) !== 4 || reserved.check(ip);
}

function headers(input: http.IncomingHttpHeaders) {
  const copy = { ...input };
  for (const key of ["connection","keep-alive","proxy-connection","proxy-authorization","proxy-authenticate","transfer-encoding","upgrade","trailer","te", ...(input.connection ?? "").toLowerCase().split(",").map(k => k.trim())]) delete copy[key];
  return copy;
}
const callbackPath = /^\/(?:mcp|api\/(?:tools(?:\/[a-zA-Z0-9_-]+)?|command-gate|operation-gate\/http|remote\/agent-browser))$/;
const hostName = (url: URL) => url.hostname.replace(/^\[|\]$/g, "");
class Refused extends Error {}
export async function startProxy(path: string, opts: ProxyOptions) {
  const usage = new Map<string, HostUsage>();
  const sockets = new Set<Duplex>();
  let closed = false;
  function track(socket: Duplex) {
    if (closed) { socket.destroy(); return; }
    sockets.add(socket);
    socket.on("error", () => socket.destroy()).once("close", () => sockets.delete(socket));
  }
  function row(url: URL) {
    let r = usage.get(url.host);
    if (!r) {
      if (usage.size >= 256) throw new Refused("运行访问的主机数已达上限");
      r = { host: url.host, count: 0, bytes: 0, denied: 0, backend: false };
      usage.set(url.host,r);
    }
    r.count++;
    return r;
  }
  async function address(url: URL) {
    const host = hostName(url);
    return isIP(host) ? host : opts.resolve ? opts.resolve(host) : (await lookup(host)).address;
  }
  async function gate(d: Destination, r: HostUsage) {
    const result = await opts.check(d);
    if (!result.allowed) { r.denied++; throw new Refused(result.reason ?? "出网规则拒绝请求"); }
    if (result.backend) r.backend = true;
  }
  async function send(req: http.IncomingMessage, res: http.ServerResponse, inside?: URL) {
    const raw = req.url ?? "";
    const url = raw.startsWith("/") ? new URL(raw, inside ?? "http://" + req.headers.host) : new URL(raw);
    const callback = !inside && opts.callback && url.origin === opts.callback.origin;
    if (url.username || url.password || (inside ? inside.origin !== url.origin : url.protocol !== "http:") || (raw.startsWith("/") && !inside && !callback)) throw new Refused("请求地址无效");
    if (callback && (!callbackPath.test(url.pathname) || req.headers.authorization !== "Bearer " + opts.callback!.token)) throw new Refused("需要本次运行的入口与令牌");
    const ip = await address(url);
    let body: Buffer | undefined;
    let r: HostUsage | undefined;
    if (!callback) {
      r = row(url);
      if (opts.needsBody(url)) {
        if (req.headers["content-encoding"] && req.headers["content-encoding"] !== "identity") throw new Refused("无法检查压缩的请求体");
        const chunks: Buffer[] = [];
        let n = 0;
        for await (const chunk of req.iterator({ destroyOnReturn: false })) {
          n += chunk.length;
          if (n > 1024 * 1024) throw new Refused("请求体超过规则检查上限");
          chunks.push(chunk);
        }
        body = Buffer.concat(chunks);
      }
      await gate({ url, method: req.method!, body, tunnel: false, private: privateAddress(ip), contentType: req.headers["content-type"] }, r);
    }
    if (closed || res.destroyed) return;
    const h = headers(req.headers);
    h.host = url.host;
    // Connect to the checked address directly. A second DNS answer must never change the peer.
    const upstream = (inside ? https : http).request({ hostname: ip, port: url.port || (inside ? 443 : 80), servername: hostName(url), ca: opts.ca, agent: false,
      path: url.pathname + url.search, method: req.method, headers: h }, reply => {
      res.writeHead(reply.statusCode!,headers(reply.headers));
      reply.on("error", () => res.destroy());
      if (r) reply.on("data", b => { r.bytes += b.length; });
      reply.pipe(res);
    });
    res.once("close", () => upstream.destroy());
    upstream.on("error", () => { if (!res.headersSent) res.writeHead(502).end("上游连接或证书验证失败"); else res.destroy(); });
    if (body) { r!.bytes += body.length; upstream.end(body); }
    else { if (r) req.on("data", b => { r.bytes += b.length; }); req.pipe(upstream); }
  }
  function handler(inside?: URL): http.RequestListener {
    return (req,res) => { void send(req,res,inside).catch(e => {
      if (res.headersSent) res.destroy(); else res.writeHead(e instanceof Refused ? 403 : 502, { connection: "close" }).end(e instanceof Refused ? e.message : "代理无法处理请求");
    }); };
  }
  const server = http.createServer(handler());
  server.maxConnections = 64;
  server.on("connection",track);
  server.on("connect", (req, socket, head) => { void (async () => {
    if (!/^(?:[\w.-]+|\[[\da-f:]+\]):\d+$/i.test(req.url ?? "")) throw new Refused("隧道地址无效");
    const url = new URL("https://" + req.url);
    const cert = await opts.inspect?.(url.hostname);
    if (closed || socket.destroyed) return;
    if (cert) {
      const tls = https.createServer(cert, handler(url));
      tls.on("tlsClientError", (_e,s) => s.destroy());
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) socket.unshift(head);
      tls.emit("connection", socket);
      return;
    }
    const r = row(url);
    const ip = await address(url);
    await gate({ url, method: "CONNECT", private: privateAddress(ip), tunnel: true },r);
    if (closed || socket.destroyed) return;
    const peer = connect(Number(url.port || 443),ip);
    track(peer);
    socket.once("close", () => peer.destroy());
    await once(peer,"connect");
    peer.once("close", () => socket.destroy());
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    r.bytes += head.length;
    if (head.length) peer.write(head);
    for (const s of [socket,peer]) s.on("data", b => { r.bytes += b.length; });
    socket.pipe(peer).pipe(socket);
  })().catch(e => {
    const reason = e instanceof Refused ? e.message : "代理无法连接上游";
    socket.end("HTTP/1.1 " + (e instanceof Refused ? "403 Forbidden" : "502 Bad Gateway") + "\r\nConnection: close\r\nContent-Length: " + Buffer.byteLength(reason) + "\r\n\r\n" + reason);
  }); });
  server.listen(path);
  await once(server,"listening");
  return { usage, close() { closed = true; server.close(); for (const s of sockets) s.destroy(); } };
}
