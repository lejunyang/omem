import { randomBytes } from "node:crypto";
import { request, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { Transform, pipeline } from "node:stream";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import { cookies, SESSION_COOKIE } from "../auth/sessions.ts";
import type { App } from "../core/app.ts";
import { OWNER, userForToken } from "../core/users.ts";
import { sameOrigin, trustedLocal } from "../server/origin.ts";
import { getSession, startAssist, viewerAccess } from "./sessions.ts";
import { grantEndReason } from "./grants.ts";

export const REMOTE_BASE = "/remote";
const VIEWER_COOKIE = "omem_remote_session";
type Access = ReturnType<typeof viewerAccess>;
type Ticket = Access & { id: string; userId: string };
const tickets = new WeakMap<App, Map<string, Ticket>>();

export function viewerCookie(app: App, id: string, userId: string, access: Access) {
  const key = randomBytes(24).toString("hex");
  let issued = tickets.get(app);
  if (!issued) {
    const entries = new Map<string, Ticket>();
    tickets.set(app, entries);
    issued = entries;
    app.events.on("remote-access", (session: string, grant?: string, mode?: Access["mode"]) => {
      for (const [key, t] of entries) {
        if (t.id === session && (!grant || (t.grantId === grant && t.mode !== mode))) entries.delete(key);
      }
    });
  }
  issued.set(key, { ...access, id, userId });
  if (issued.size > 1000) issued.delete(issued.keys().next().value!);
  return `${VIEWER_COOKIE}=${key}; Path=/remote/${id}; HttpOnly; SameSite=Lax`;
}

// Control and clipboard file IDs are local to an assist process. Each operating
// member connects to the same browser target with a separate controller.
type Assist = Awaited<ReturnType<typeof startAssist>>;
type Operator = { ready: Promise<Assist>; assist?: Assist; sockets: number };
const operators = new WeakMap<Assist, Map<string, Operator>>();

function operatingViewer(primary: Assist, grant: string) {
  let group = operators.get(primary);
  if (!group) {
    group = new Map();
    operators.set(primary, group);
  }
  let entry = group.get(grant);
  if (!entry) {
    const ready = startAssist(primary.args, primary.viewer);
    const created: Operator = { ready, sockets: 0 };
    group.set(grant, created);
    entry = created;
    void ready.then(assist => {
      created.assist = assist;
      if (!created.sockets) assist.proc.kill();
    }, () => {});
  }
  const operator = entry;
  operator.sockets++;
  return { ready: operator.ready, release() {
    if (--operator.sockets === 0) {
      group.delete(grant);
      operator.assist?.proc.kill();
    }
  } };
}

function route(app: App, req: IncomingMessage) {
  const match = /^\/remote\/([\w-]+)([/?].*)?$/.exec(req.url ?? "");
  if (!match || !sameOrigin(req)) return 401 as const;
  const [, id, path = "/"] = match;
  const jar = cookies(req);
  const ticket = tickets.get(app)?.get(jar[VIEWER_COOKIE]);
  let userId: string;
  if (VIEWER_COOKIE in jar || "omem_remote" in jar) {
    if (!ticket || ticket.id !== id) return 401 as const;
    userId = ticket.userId;
  } else if (req.headers.authorization) {
    if (!req.headers.authorization.startsWith("Bearer ") || userForToken(app, req.headers.authorization.slice(7)) !== OWNER) return 401 as const;
    userId = OWNER;
  } else {
    if (jar[SESSION_COOKIE] || app.config.token || !trustedLocal(req, req.socket.remoteAddress ?? "", { refuseProxied: app.config.auth.enabled })) return 401 as const;
    userId = OWNER;
  }
  const current = () => {
    try {
      const access = viewerAccess(app, getSession(id), userId);
      if (ticket && (access.mode !== ticket.mode || access.grantId !== ticket.grantId)) return null;
      return access;
    } catch { return null; }
  };
  const access = current();
  if (!access) return 404 as const;
  const session = getSession(id);
  let upstreamPath = path;
  let assist = session.assist;
  if (assist.viewer?.signal.aborted) return 404 as const;
  if (access.grantId) {
    // The assist secret stays on loopback. Construct the upstream URL from known fields only.
    const url = new URL("http://local/" + path.replace(/^\//, ""));
    if (req.method !== "GET" || !["/", "/ws"].includes(url.pathname) &&
        !(access.mode === "operate" && /^\/clipboard\/[\w-]+$/.test(url.pathname))) return 401 as const;
    if (url.searchParams.get("token") !== "viewer") return 401 as const;
    if (url.pathname.startsWith("/clipboard/")) {
      const operator = operators.get(assist)?.get(access.grantId)?.assist;
      if (!operator) return 404 as const;
      assist = operator;
    }
    const query = new URLSearchParams({ token: assist.token, lang: "zh" });
    upstreamPath = url.pathname + "?" + query;
  }
  return { id, userId, path, upstreamPath, assist, session, access, current };
}

type Route = Exclude<ReturnType<typeof route>, number>;
/** Wake even a silent connection when a grant ends, changes mode, or its member is disabled. */
function watch(app: App, r: Route, close: () => void) {
  let timer: NodeJS.Timeout | undefined;
  const check = () => {
    clearTimeout(timer);
    const access = r.current();
    if (!access) return close();
    if (access.expiresAt) timer = setTimeout(check, Math.min(2_147_483_647, Math.max(1, Date.parse(access.expiresAt) - Date.now())));
  };
  const session = (id: string) => { if (id === r.id) check(); };
  const member = (id: string) => { if (id === r.userId) check(); };
  app.events.on("remote-access", session).on("member-access", member);
  check();
  return () => {
    clearTimeout(timer);
    app.events.off("remote-access", session).off("member-access", member);
  };
}

export function proxyHttp(app: App, req: IncomingMessage, res: ServerResponse) {
  const r = route(app, req);
  if (typeof r === "number") { res.writeHead(r); res.end(); return; }
  if (r.path.startsWith("?")) {
    res.writeHead(302, { location: `/remote/${r.id}/${r.path}` });
    res.end();
    return;
  }
  const port = r.assist.port;
  const up = request({ hostname: "127.0.0.1", port, socketPath: r.assist.socketPath, path: r.upstreamPath, method: req.method,
    headers: { accept: req.headers.accept ?? "*/*" } }, response => {
    if (!r.current()) { response.destroy(); res.destroy(); return; }
    res.writeHead(response.statusCode ?? 502, { ...response.headers, "cache-control": "no-store", "referrer-policy": "no-referrer" });
    pipeline(response, new Transform({ transform(chunk, _, cb) {
      if (r.current()) cb(null, chunk);
      else cb(new Error("授权已结束"));
    } }), res, () => {});
  });
  const unwatch = watch(app, r, () => { up.destroy(); res.destroy(); });
  res.once("close", () => { unwatch(); up.destroy(); });
  up.on("error", () => { if (res.headersSent) res.destroy(); else { res.writeHead(502); res.end(); } });
  up.end();
}

/** Only viewer-local codec negotiation and keyframe requests. Re-encode to discard unknown fields. */
function pictureRequest(data: RawData) {
  if (!(data instanceof Buffer) || data.length > 1024) return;
  try {
    const msg = JSON.parse(data.toString());
    if (msg?.type === "keyframe") return '{"type":"keyframe"}';
    if (msg?.type === "hello" && Array.isArray(msg.accept) && msg.accept.every((c: unknown) => typeof c === "string"))
      return JSON.stringify({ type: "hello", accept: msg.accept });
  } catch { /* Unknown messages are input. */ }
}

export function attachRemoteUpgrade(app: App, server: Server) {
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  server.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => {
    if (!req.url?.startsWith("/remote/")) return;
    const r = route(app, req);
    if (typeof r === "number" || r.upstreamPath.split("?")[0] !== "/ws") return void socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
    wss.handleUpgrade(req, socket, head, async client => {
      client.pause();
      const primary = r.assist;
      const operator = r.access.grantId && r.access.mode === "operate"
        ? operatingViewer(primary, r.access.grantId) : null;
      let up: WebSocket | undefined;
      const connection = { userId: r.userId, mode: r.access.mode };
      const close = () => {
        if (client.readyState !== WebSocket.OPEN) return;
        const reason = r.access.grantId && grantEndReason(app, r.access.grantId);
        if (reason) {
          client.resume();
          client.close(1008, reason);
        } else client.terminate();
        up?.terminate();
      };
      const unwatch = watch(app, r, close);
      primary.proc.once("exit", close);
      client.on("error", close).once("close", () => {
        primary.proc.off("exit", close);
        unwatch();
        r.session.connections.delete(connection);
        r.session.idleSince = Date.now();
        up?.terminate();
        operator?.release();
      });
      let endpoint = primary;
      if (operator) {
        try { endpoint = await operator.ready; } catch { return close(); }
        if (client.readyState !== WebSocket.OPEN || !r.current()) return close();
      }
      const path = operator ? `/ws?token=${encodeURIComponent(endpoint.token)}` : r.upstreamPath;
      const upstream = new WebSocket(endpoint.socketPath ? `ws+unix://${endpoint.socketPath}:${path}` : `ws://127.0.0.1:${endpoint.port}${path}`, { perMessageDeflate: false });
      up = upstream;
      upstream.on("error", close).once("close", close);
      upstream.once("open", () => {
        if (!r.current()) return close();
        if (r.session.kind === "browser" && connection.mode === "operate") upstream.send('{"type":"take"}');
        r.session.connections.add(connection);
        client.resume();
      });
      client.on("message", (data, binary) => {
        if (!r.current()) return close();
        const allowed = connection.mode === "operate" ? data : !binary && pictureRequest(data);
        if (allowed && upstream.readyState === WebSocket.OPEN) upstream.send(allowed, { binary });
      });
      upstream.on("message", (data, binary) => {
        if (!r.current()) return close();
        if (client.readyState !== WebSocket.OPEN) return;
        upstream.pause();
        client.send(data, { binary }, error => { if (error) close(); else upstream.resume(); });
      });
    });
  });
}
