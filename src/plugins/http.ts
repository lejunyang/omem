import { createReadStream, existsSync, statSync } from "node:fs";
import type { IncomingMessage, Server } from "node:http";
import { connect, type Socket } from "node:net";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { App } from "../core/app.ts";
import { OWNER, userForToken } from "../core/users.ts";
import { HttpError } from "../core/util.ts";
import { trustedLocal } from "../server/origin.ts";
import { callTool } from "../agents/tools.ts";
import { createSession, listSessions, sendMessage, sessionView, submitBlock } from "./blocks.ts";
import { codeRuns, describePlugin, findPlugin, getPlugin, listPlugins, pluginWebDir, setPluginIcon, trustPlugin, untrustPlugin } from "./registry.ts";
import { ensureService, serviceStatus, stopService, streamUse } from "./services.ts";
import { savePluginSettings } from "./settings.ts";
import { pluginStore } from "./store.ts";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".mp3": "audio/mpeg",
  ".ico": "image/x-icon",
};

/** The plugin API (docs/v2/plugins.md). Pages reach it only through the shell, which forwards these paths. */
export function registerPluginRoutes(server: FastifyInstance, app: App, who: (req: FastifyRequest) => string) {
  const parse = <T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> => {
    const r = schema.safeParse(value ?? {});
    if (!r.success) throw new HttpError(400, r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    return r.data;
  };
  const plugin = (req: FastifyRequest) => getPlugin((req.params as { id: string }).id);

  server.get("/api/plugins", async () => listPlugins().map(describePlugin));
  server.get("/api/plugins/:id", async (req) => describePlugin(plugin(req)));
  server.get("/api/plugins/:id/sessions", async (req) => listSessions(app, plugin(req).manifest.id, who(req)));
  server.post("/api/plugins/:id/sessions", async (req) => {
    const p = plugin(req);
    const b = parse(z.object({ agent: z.string().optional(), title: z.string().max(80).optional() }), req.body);
    const spec = b.agent ? p.specs.find((s) => s.name === b.agent) : p.specs[0];
    if (!spec) throw new HttpError(400, b.agent ? `插件 ${p.manifest.id} 没有档案 ${b.agent}` : `插件 ${p.manifest.id} 没有可对话的档案`);
    return createSession(app, { plugin: p.manifest.id, agent: spec.name, spaceId: spec.space ?? p.manifest.space?.id ?? "personal", userId: who(req), title: b.title });
  });
  server.get("/api/plugins/:id/sessions/:cid", async (req) => {
    const p = plugin(req);
    return sessionView(app, p.env, (req.params as { cid: string }).cid, who(req));
  });
  server.post("/api/plugins/:id/sessions/:cid/messages", async (req) => {
    const b = parse(z.object({ text: z.string().min(1).max(20_000) }), req.body);
    return sendMessage(app, { plugin: plugin(req).manifest.id, conversationId: (req.params as { cid: string }).cid, userId: who(req), text: b.text });
  });
  server.post("/api/plugins/:id/blocks/:bid/submit", async (req) => {
    const p = plugin(req);
    const b = parse(z.object({ answers: z.record(z.string(), z.unknown()) }), req.body);
    return submitBlock(app, p.env, { blockId: (req.params as { bid: string }).bid, userId: who(req), answers: b.answers });
  });
  server.get("/api/plugins/:id/settings", async (req) => {
    const p = plugin(req);
    return { fields: p.manifest.settings, values: p.env.settings(app, who(req)) };
  });
  server.put("/api/plugins/:id/settings", async (req) => {
    const p = plugin(req);
    const values = savePluginSettings(app, p.manifest.id, p.manifest.settings, who(req), p.manifest.space?.id ?? "personal", parse(z.record(z.string(), z.unknown()), req.body));
    app.emit({ type: "plugin", plugin: p.manifest.id, conversationId: "", settings: true });
    return { fields: p.manifest.settings, values };
  });
  server.get("/api/plugins/:id/data/:collection", async (req) => {
    const p = plugin(req);
    const o = parse(z.object({ key: z.string().optional(), limit: z.coerce.number().int().min(1).max(1000).optional() }), req.query);
    const store = pluginStore(app, p.manifest.id, who(req), p.manifest.space?.id ?? "personal");
    const collection = (req.params as { collection: string }).collection;
    return o.key ? { data: store.get(collection, o.key) } : { records: store.list(collection, { limit: o.limit ?? 100 }) };
  });
  // The page calls the plugin's own tools marked `page`, as the owner; never host tools or another plugin's.
  server.post("/api/plugins/:id/call/:tool", async (req) => {
    const p = plugin(req);
    const name = (req.params as { tool: string }).tool;
    if (!p.tools.some((t) => t.name === name && t.page)) throw new HttpError(403, `插件页面不能调用 ${name}`);
    const userId = who(req);
    const r = await callTool({ app, runId: null, spaceId: p.manifest.space?.id ?? "personal", spaces: null, tools: new Set([name]), actor: "user", userId, plugin: p.manifest.id }, name, req.body ?? {});
    if (r.isError) throw new HttpError(400, r.text);
    return { text: r.text };
  });

  // Trust: a data-directory plugin's code runs only after the owner confirms it (trust.ts).
  server.put("/api/plugins/:id/icon", async (req) => setPluginIcon(app, plugin(req).manifest.id, String((req.body as { icon?: unknown })?.icon ?? "")));
  server.post("/api/plugins/:id/trust", async (req) => trustPlugin(app, plugin(req).manifest.id));
  server.delete("/api/plugins/:id/trust", async (req) => untrustPlugin(app, plugin(req).manifest.id));

  // Services: the page (or the settings) may start and stop the plugin's own ones.
  const service = (req: FastifyRequest) => {
    const p = plugin(req);
    const name = (req.params as { name: string }).name;
    const spec = p.manifest.services.find((s) => s.name === name);
    if (!spec) throw new HttpError(404, `插件 ${p.manifest.id} 没有服务 ${name}`);
    if (!codeRuns(p)) throw new HttpError(403, `插件 ${p.manifest.id} 的代码还没有被信任：在设置 → 插件里确认`);
    return { p, spec };
  };
  server.get("/api/plugins/:id/services", async (req) => {
    const p = plugin(req);
    return serviceStatus(p.manifest.id, p.manifest.services);
  });
  server.post("/api/plugins/:id/services/:name/start", async (req) => {
    const { p, spec } = service(req);
    await ensureService(app, { id: p.manifest.id, dir: p.dir }, spec);
    return serviceStatus(p.manifest.id, [spec])[0];
  });
  server.post("/api/plugins/:id/services/:name/stop", async (req) => {
    const { p, spec } = service(req);
    stopService(p.manifest.id, spec.name);
    return serviceStatus(p.manifest.id, [spec])[0];
  });

  // The page's helper for plugins whose page is plain HTML (data directory): the SDK as one module.
  server.get("/plugins/_sdk/omem.js", async (_req, reply) => {
    const file = join(webDistRoot(), "plugins", "_sdk", "omem.js");
    if (!existsSync(file)) return reply.status(404).send("SDK 还没有构建（pnpm run build）");
    reply.header("access-control-allow-origin", "*").header("cache-control", "no-cache").type(TYPES[".js"]);
    return reply.send(createReadStream(file));
  });

  // Built pages. They run in a sandboxed iframe (an opaque origin), where module scripts are
  // fetched in CORS mode: these public build files say anyone may load them.
  server.get("/plugins/:id/*", async (req, reply) => {
    const { id, "*": rest } = req.params as { id: string; "*": string };
    const p = /^[a-z][a-z0-9]{1,23}$/.test(id) ? findPlugin(id) : null;
    const dir = p ? pluginWebDir(p) : null;
    if (!dir) return reply.status(404).send("插件页面不存在或还没有构建（pnpm run build）");
    const rel = normalize(rest || "index.html");
    const file = join(dir, rel);
    if (rel.startsWith("..") || !file.startsWith(dir + sep) || !existsSync(file) || !statSync(file).isFile()) return reply.status(404).send("not found");
    reply.header("access-control-allow-origin", "*");
    reply.header("cache-control", /[\\/]assets[\\/]/.test(rel) ? "public, max-age=31536000, immutable" : "no-cache");
    reply.type(TYPES[extname(file).toLowerCase()] ?? "application/octet-stream");
    return reply.send(createReadStream(file));
  });
  server.get("/plugins/:id", async (req, reply) => reply.redirect(`/plugins/${(req.params as { id: string }).id}/`));
}

const here = dirname(fileURLToPath(import.meta.url));
function webDistRoot() {
  for (const c of [resolve(here, "../../web/dist"), resolve(here, "../../../web/dist")]) if (existsSync(c)) return c;
  return resolve(here, "../../web/dist");
}

/**
 * The owner only: the token (the shell adds it as a query, like the event stream; another omem
 * forwarding sends it as a header), or this machine while omem trusts loopback (no token configured).
 */
function streamAllowed(app: App, req: IncomingMessage) {
  const url = new URL(req.url ?? "/", "http://x");
  const auth = req.headers.authorization;
  const token = auth?.startsWith("Bearer ") ? auth.slice(7) : url.searchParams.get("token");
  if (token) return userForToken(app, token) === OWNER;
  const ip = req.socket.remoteAddress ?? "";
  return !app.config.token && trustedLocal(req, ip);
}

const STREAM = /^\/api\/plugins\/([a-z][a-z0-9]{1,23})\/streams\/([a-z][a-z0-9-]{0,23})(\?.*)?$/;

/**
 * Streams (docs/v2/plugins.md): a WebSocket upgrade under /api/plugins/<id>/streams/<name> goes to
 * the plugin's service, started if needed, after the owner check; the service gets its token instead
 * of the owner's. The connection is passed through as it is, frames and all.
 */
export function attachPluginStreams(app: App, server: Server) {
  server.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => {
    const m = STREAM.exec(req.url ?? "");
    if (!m) return;
    const refuse = (status: string) => void socket.end(`HTTP/1.1 ${status}\r\n\r\n`);
    if (!streamAllowed(app, req)) return refuse("401 Unauthorized");
    const p = findPlugin(m[1]);
    const stream = p?.manifest.streams.find((s) => s.name === m[2]);
    const spec = stream && p?.manifest.services.find((s) => s.name === stream.service);
    if (!p || !stream || !spec) return refuse("404 Not Found");
    if (!codeRuns(p)) return refuse("403 Forbidden");
    ensureService(app, { id: p.manifest.id, dir: p.dir }, spec).then(
      ({ port, token }) => {
        const upstream = connect(port, "127.0.0.1", () => {
          const headers: Record<string, string | string[]> = {};
          for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && k !== "cookie" && k !== "authorization") headers[k] = v;
          headers.host = `127.0.0.1:${port}`;
          headers.authorization = `Bearer ${token}`;
          const lines = Object.entries(headers).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => `${k}: ${x}`) : [`${k}: ${v}`]));
          upstream.write(`GET ${stream.path} HTTP/1.1\r\n${lines.join("\r\n")}\r\n\r\n`);
          if (head.length) upstream.write(head);
          upstream.pipe(socket);
          socket.pipe(upstream);
          streamUse(p.manifest.id, spec.name, 1);
        });
        let ended = false;
        // Either side gone ends both: a half-open socket would keep the service from being idle.
        const close = () => {
          if (!ended) {
            ended = true;
            streamUse(p.manifest.id, spec.name, -1);
          }
          upstream.destroy();
          socket.destroy();
        };
        for (const s of [upstream, socket]) s.on("error", close).on("close", close).on("end", close);
      },
      () => refuse("503 Service Unavailable"),
    );
  });
}
