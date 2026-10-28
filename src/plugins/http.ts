import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { App } from "../core/app.ts";
import { HttpError } from "../core/util.ts";
import { callTool } from "../agents/tools.ts";
import { createSession, listSessions, sendMessage, sessionView, submitBlock } from "./blocks.ts";
import { describePlugin, findPlugin, getPlugin, listPlugins, pluginWebDir } from "./registry.ts";
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
