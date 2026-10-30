import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Duplex } from "node:stream";
import type { App } from "./app.ts";
import { findPeer } from "./peers.ts";

/**
 * Raw forwarding to a peer, for what `peerFetch` cannot carry: web VS Code under /ide (WebSocket
 * upgrades, binary bodies, redirects with cookies). The request goes byte for byte to the first
 * direct peer on the way, its path wrapped in `/api/peers/<id>` for each middle node, which
 * forwards it the same way (http.ts). Only the paths in `tunneled` go this way; `/api/peer/acp` is a
 * device's agent used from here (peer-acp.ts).
 */
export const tunneled = (path: string) => /^\/ide(\/|\?|$)/.test(path) || /^\/api\/ide\/open(\?|$)/.test(path) || /^\/api\/peer\/acp(\?|$)/.test(path);

export function peerRoute(app: App, id: string, path: string, hops: number): { url: string; token: string; path: string; hops: number } {
  if (hops > 4) throw new Error("设备转发层数过多");
  const p = findPeer(app, id);
  if (!p) throw new Error(`没有名为 ${id} 的设备（omem peer list 查看）`);
  if (p.via) return peerRoute(app, p.via, `/api/peers/${encodeURIComponent(p.id)}${path}`, hops + 1);
  return { url: p.url, token: p.token, path, hops };
}

function upstream(app: App, id: string, req: IncomingMessage, path: string, hops: number) {
  const r = peerRoute(app, id, path, hops);
  const target = new URL(r.path, r.url);
  const headers: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && !["host", "authorization", "x-omem-hops"].includes(k)) headers[k] = v;
  headers.authorization = `Bearer ${r.token}`;
  headers["x-omem-hops"] = String(r.hops);
  // Kept from the first hop: web VS Code addresses its WebSocket to the host the browser used.
  if (!headers["x-forwarded-host"] && req.headers.host) headers["x-forwarded-host"] = req.headers.host;
  return (target.protocol === "https:" ? httpsRequest : httpRequest)(target, { method: req.method, headers, agent: false });
}

const fail = (res: ServerResponse, e: Error) => {
  if (res.headersSent) return void res.destroy();
  res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
  res.end(e.message);
};

/** An HTTP request (body not read yet) to `path` on peer `id`. */
export function tunnelHttp(app: App, id: string, path: string, req: IncomingMessage, res: ServerResponse, hops = 0) {
  let up;
  try {
    up = upstream(app, id, req, path, hops);
  } catch (e) {
    return fail(res, e as Error);
  }
  up.on("response", (r) => {
    res.writeHead(r.statusCode ?? 502, r.statusMessage, r.rawHeaders);
    r.pipe(res);
  });
  up.on("error", (e) => fail(res, e));
  res.on("close", () => up.destroy());
  req.pipe(up);
}

/** A WebSocket upgrade to `path` on peer `id`: the handshake answer and then the frames both ways. */
export function tunnelUpgrade(app: App, id: string, path: string, req: IncomingMessage, socket: Duplex, head: Buffer, hops = 0) {
  let up;
  try {
    up = upstream(app, id, req, path, hops);
  } catch {
    return void socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
  }
  const head1 = (r: IncomingMessage) => {
    const lines = [];
    for (let i = 0; i < r.rawHeaders.length; i += 2) lines.push(`${r.rawHeaders[i]}: ${r.rawHeaders[i + 1]}`);
    return `HTTP/1.1 ${r.statusCode} ${r.statusMessage}\r\n${lines.join("\r\n")}\r\n\r\n`;
  };
  up.on("upgrade", (r, peer, peerHead) => {
    socket.write(head1(r));
    if (peerHead.length) socket.write(peerHead);
    if (head.length) peer.write(head);
    peer.pipe(socket);
    socket.pipe(peer);
    // Either side gone ends both (see attachIdeUpgrade).
    const close = () => (peer.destroy(), socket.destroy());
    for (const s of [peer, socket]) s.on("error", close).on("close", close).on("end", close);
  });
  // Refused (401, 503 …): the answer as it is, then the connection closed.
  up.on("response", (r) => {
    socket.write(head1(r));
    r.pipe(socket);
  });
  up.on("error", () => socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"));
  socket.on("error", () => up.destroy());
  up.end();
}
