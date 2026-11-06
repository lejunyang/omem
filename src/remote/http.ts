import { randomBytes } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { ask } from "../agents/jobs.ts";
import type { App } from "../core/app.ts";
import { desktopControl } from "../core/tools.ts";
import { OWNER, userForToken } from "../core/users.ts";
import { HttpError } from "../core/util.ts";
import { sameOrigin, trustedLocal } from "../server/origin.ts";
import { getRecording, listRecordings, markInterrupted, readRecording, updateRecording, type Recording } from "./recordings.ts";
import { assistOf, browserProfiles, closeAll, closeSession, getSession, listSessions, navigate, openBrowser, openDesktop, replayRecording, restartViewer, screens, sessionView, startRecording, stopRecording, viewerPath, viewing } from "./sessions.ts";
import { cachedProbe, probeRunning, probeVideo, readSettings, remoteSettingsSchema, saveSettings, viewerArgs } from "./settings.ts";

/**
 * Remote operation over HTTP (docs/v2/remote.md): /api/remote for the page, and /remote/<session>/
 * where `aad assist`'s viewer and its WebSocket are forwarded. Only whoever opened a session gets
 * through: the cookie /api/remote hands out (on this site), the owner's token from a forwarding omem
 * (`omem peer open`), or this machine when no token is configured.
 */

export const REMOTE_BASE = "/remote";
const COOKIE = "omem_remote";
/** Viewer cookies, each for the user it was given to. */
const viewers = new Map<string, string>();

function cookieFor(userId: string) {
  const id = randomBytes(24).toString("hex");
  viewers.set(id, userId);
  // Every view hands out one: the oldest go once there are many (a page opened again gets a new one).
  for (const old of viewers.keys()) {
    if (viewers.size <= 1000) break;
    viewers.delete(old);
  }
  return `${COOKIE}=${id}; Path=${REMOTE_BASE}; HttpOnly; SameSite=Lax`;
}

function cookies(req: IncomingMessage) {
  return Object.fromEntries((req.headers.cookie ?? "").split(";").map((c) => c.trim().split("=")).filter((p) => p[0]).map(([k, ...v]) => [k, v.join("=")]));
}

/** Who is asking for a forwarded viewer, or null. */
function viewerOf(app: App, req: IncomingMessage): string | null {
  const user = viewers.get(cookies(req)[COOKIE] ?? "");
  // The cookie rides along with another site's WebSocket too; its Origin gives it away.
  if (user) return sameOrigin(req) ? user : null;
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return userForToken(app, auth.slice(7)) === OWNER ? OWNER : null;
  return !app.config.token && trustedLocal(req, req.socket.remoteAddress ?? "", { refuseProxied: app.config.auth.enabled }) ? OWNER : null;
}

/** `/remote/<id>/rest` → the session and what to ask `aad assist` for. */
function route(app: App, req: IncomingMessage) {
  const m = /^\/remote\/([^/?]+)([/?][^]*)?$/.exec(req.url ?? "");
  if (!m) return null;
  const user = viewerOf(app, req);
  if (!user) return { status: 401 as const };
  const assist = assistOf(m[1]);
  try {
    if (!assist) throw new Error();
    getSession(m[1], user);
  } catch {
    return { status: 404 as const };
  }
  return { status: 200 as const, id: m[1], port: assist.port, path: m[2] || "/" };
}

function proxyHttp(app: App, req: IncomingMessage, res: ServerResponse) {
  const r = route(app, req);
  if (!r || r.status !== 200) {
    res.writeHead(r?.status ?? 404, { "content-type": "text/plain; charset=utf-8" });
    return void res.end(r?.status === 401 ? "只有打开这个远程会话的人能看" : "远程会话已经结束");
  }
  // A path without the trailing slash would resolve the viewer's `ws` one level too high.
  if (r.path.startsWith("?")) {
    res.writeHead(302, { location: `${REMOTE_BASE}/${r.id}/${r.path}` });
    return void res.end();
  }
  const up = httpRequest({ host: "127.0.0.1", port: r.port, path: r.path, method: req.method, headers: { host: `127.0.0.1:${r.port}`, accept: req.headers.accept ?? "*/*" } }, (u) => {
    res.writeHead(u.statusCode ?? 502, { ...u.headers, "cache-control": "no-store", "referrer-policy": "no-referrer" });
    u.pipe(res);
  });
  up.on("error", () => (res.headersSent ? res.destroy() : (res.writeHead(502), res.end("aad assist 没有回应"))));
  up.end();
}

/** WebSocket upgrades under /remote go to the session's `aad assist`, frames both ways. */
export function attachRemoteUpgrade(app: App, server: Server) {
  server.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => {
    if (!req.url?.startsWith(`${REMOTE_BASE}/`)) return;
    const r = route(app, req);
    if (!r || r.status !== 200) return void socket.end(`HTTP/1.1 ${r?.status === 401 ? "401 Unauthorized" : "404 Not Found"}\r\n\r\n`);
    const upstream = connect(r.port, "127.0.0.1", () => {
      const keep = ["upgrade", "connection", "sec-websocket-key", "sec-websocket-version", "sec-websocket-extensions", "sec-websocket-protocol"];
      const lines = Object.entries(req.headers).filter(([k]) => keep.includes(k)).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`);
      upstream.write(`GET ${r.path} HTTP/1.1\r\nhost: 127.0.0.1:${r.port}\r\n${lines.join("\r\n")}\r\n\r\n`);
      if (head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
      viewing(r.id, 1);
    });
    let counted = true;
    const close = () => {
      if (counted) viewing(r.id, -1);
      counted = false;
      upstream.destroy();
      socket.destroy();
    };
    for (const s of [upstream, socket]) s.on("error", close).on("close", close).on("end", close);
  });
}

/** One person's long-lived profiles (sessions.ts profileDir): the owner's, or those under `@<user>`. */
const profiles = (app: App, userId: string) => {
  const dir = userId === OWNER ? join(app.home, "remote", "profiles") : join(app.home, "remote", "profiles", `@${userId}`);
  return existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith("@")).map((d) => d.name) : [];
};
/** This machine's own browsers carry the owner's logins: only the owner starts from a copy of them. */
const ownerOnly = (userId: string) => {
  if (userId !== OWNER) throw new HttpError(403, "只有本人能用这台机器上浏览器的登录");
};

/** The message that hands a finished recording to the assistant in the page's conversation. */
export function organizeText(r: Recording) {
  const s = r.summary;
  if (r.status === "failed") return `刚才的录制（${r.id}）没有完成：${String(s.error ?? "原因不明")}。`;
  const what = r.kind === "browser" ? `浏览器（${r.target || "页面"}）` : `窗口（${r.target}）`;
  return [
    `我录好了要教你的操作（录制 ${r.id}，在${what}）：${r.goal || "见对话里我说的"}。`,
    `一共 ${s.actions ?? 0} 个动作，${s.replayable ?? 0} 步可以回放${s.skipped ? `，${s.skipped} 个没能成为步骤` : ""}${s.requests ? `，记下 ${s.requests} 个请求` : ""}。`,
    "请按技能 skill-from-recording 看这次录制，先跟我确认流程、每次会变的值和成功的标志，再保存成技能。",
  ].join("\n");
}

async function organize(app: App, r: Recording, userId: string, conversationId?: string | null) {
  const sent = await ask(app, { text: organizeText(r), conversationId: conversationId ?? r.conversationId ?? undefined, userId });
  updateRecording(app, r.id, { conversationId: sent.conversationId });
  return sent;
}

export function registerRemoteRoutes(server: FastifyInstance, app: App, who: (req: FastifyRequest) => string) {
  markInterrupted(app);
  const q = <T>(schema: z.ZodType<T>, v: unknown): T => {
    const r = schema.safeParse(v ?? {});
    if (!r.success) throw new HttpError(400, r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    return r.data;
  };
  const view = (s: ReturnType<typeof getSession>, reply: FastifyReply, userId: string) => {
    reply.header("set-cookie", cookieFor(userId)).header("cache-control", "no-store");
    return { ...sessionView(s), src: viewerPath(s) };
  };

  // Whether the page is offered at all: aad installed on this machine.
  server.get("/api/remote", async (req) => {
    const status = desktopControl.status();
    return { available: status.installed, version: status.version, sessions: status.installed ? listSessions(who(req)) : [], profiles: profiles(app, who(req)) };
  });
  server.get("/api/remote/screens", async () => screens());
  // This machine's own browser profiles, whose logins a session can start from a copy of.
  server.get("/api/remote/browser-profiles", async (req) => (ownerOnly(who(req)), browserProfiles()));
  // How sessions are shown: each user's picture settings, and which video codecs work here.
  server.get("/api/remote/settings", async (req) => ({ settings: readSettings(app, who(req)), video: cachedProbe(app), probing: probeRunning() }));
  server.put("/api/remote/settings", async (req) => saveSettings(app, who(req), q(remoteSettingsSchema.partial(), req.body)));
  server.post("/api/remote/settings/probe", async () => probeVideo(app));
  server.post("/api/remote/sessions", async (req, reply) => {
    const b = q(z.object({
      kind: z.enum(["browser", "desktop"]),
      url: z.string().max(2048).optional(),
      browser: z.enum(["chrome", "edge", "brave"]).optional(),
      profile: z.string().max(40).optional(),
      copyFrom: z.object({ browser: z.enum(["chrome", "edge", "brave"]), id: z.string().min(1).max(100) }).optional(),
      closeRunning: z.boolean().optional(),
      visible: z.boolean().optional(),
      monitor: z.number().int().min(0).optional(),
      window: z.string().max(200).optional(),
      title: z.string().max(200).optional(),
    }), req.body);
    const userId = who(req);
    if (b.copyFrom) ownerOnly(userId);
    const settings = readSettings(app, userId);
    const viewer = viewerArgs(settings, b.kind, cachedProbe(app));
    const s = b.kind === "browser"
      ? await openBrowser(app, { url: b.url || undefined, browser: b.browser ?? (settings.browser || undefined), profile: b.profile || undefined, copyFrom: b.copyFrom, closeRunning: b.closeRunning, visible: b.visible, viewer, userId })
      : await openDesktop(app, { monitor: b.monitor, window: b.window, title: b.title?.slice(0, 60), viewer, userId });
    return view(s, reply, userId);
  });
  server.post("/api/remote/sessions/:id/view", async (req, reply) => view(getSession((req.params as { id: string }).id, who(req)), reply, who(req)));
  // The session's viewer again, with the settings as they are now.
  server.post("/api/remote/sessions/:id/viewer", async (req, reply) => {
    const userId = who(req);
    const s = getSession((req.params as { id: string }).id, userId);
    return view(await restartViewer(app, s.id, userId, viewerArgs(readSettings(app, userId), s.kind, cachedProbe(app))), reply, userId);
  });
  server.post("/api/remote/sessions/:id/navigate", async (req) => navigate((req.params as { id: string }).id, q(z.object({ url: z.string().min(1).max(2048) }), req.body).url, who(req)));
  server.delete("/api/remote/sessions/:id", async (req) => {
    const id = (req.params as { id: string }).id;
    getSession(id, who(req));
    await closeSession(app, id);
    return { ok: true };
  });
  server.post("/api/remote/sessions/:id/recording", async (req) => {
    const b = q(z.object({ goal: z.string().max(2000).default(""), window: z.string().max(200).optional(), conversationId: z.string().optional() }), req.body);
    return startRecording(app, (req.params as { id: string }).id, { ...b, userId: who(req) });
  });
  // Stopping hands the recording to the assistant in the page's conversation (organize).
  server.delete("/api/remote/sessions/:id/recording", async (req) => {
    const o = q(z.object({ conversationId: z.string().optional(), organize: z.enum(["0", "1"]).default("1") }), req.query);
    const userId = who(req);
    const r = await stopRecording(app, getSession((req.params as { id: string }).id, userId));
    if (o.organize === "0") return { recording: r, conversationId: r.conversationId };
    const sent = await organize(app, r, userId, o.conversationId);
    return { recording: getRecording(app, r.id), conversationId: sent.conversationId };
  });
  server.get("/api/remote/recordings", async (req) => listRecordings(app, who(req)));
  server.get("/api/remote/recordings/:id", async (req) => {
    const r = getRecording(app, (req.params as { id: string }).id, who(req));
    return { ...r, text: readRecording(app, r.id, who(req), { part: "summary" }) };
  });
  server.post("/api/remote/recordings/:id/organize", async (req) => {
    const b = q(z.object({ conversationId: z.string().optional() }), req.body);
    const r = getRecording(app, (req.params as { id: string }).id, who(req));
    const sent = await organize(app, r, who(req), b.conversationId);
    return { conversationId: sent.conversationId };
  });
  server.post("/api/remote/recordings/:id/replay", async (req) => {
    const b = q(z.object({ sessionId: z.string().optional() }), req.body);
    return replayRecording(app, (req.params as { id: string }).id, b.sessionId ?? null, who(req));
  });

  // The viewer itself, raw: no body parsing, the check above instead of the /api auth hook.
  return server.register(async (raw) => {
    raw.removeAllContentTypeParsers();
    raw.addContentTypeParser("*", (_req, _payload, done) => done(null));
    const pass = async (req: FastifyRequest, reply: FastifyReply) => {
      reply.hijack();
      proxyHttp(app, req.raw, reply.raw);
    };
    raw.all(`${REMOTE_BASE}/:id`, pass);
    raw.all(`${REMOTE_BASE}/:id/*`, pass);
  });
}

export const closeRemote = closeAll;
