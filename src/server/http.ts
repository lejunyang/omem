import { existsSync, readFileSync } from "node:fs";
import { symbolRelations } from "../sources/callgraph.ts";
import { agentSpecHistory, deleteAgentSpec, deleteSkill, listAgentSpecs, listSkills, readAgentSpec, readRaw, readSkill, saveAgentSpec, saveRaw, saveSkill } from "../agents/specs.ts";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import fastifyMultipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import { applyCodeRun, codePatch, discardCodeRun } from "../agents/code.ts";
import { ask, conversationMessages, scheduleIngest, scheduleSpaceSync, stalePages, type PageBrief } from "../agents/jobs.ts";
import { createMcpServer } from "../agents/mcp-server.ts";
import { listAgentProfiles } from "../agents/runner.ts";
import { cancelRun, createRun, getRun, listRuns, runEvents } from "../agents/runs.ts";
import { callTool, toolContextForToken, toolSchemas } from "../agents/tools.ts";
import type { App, AppEvent } from "../core/app.ts";
import { all, one } from "../core/db.ts";
import { configSchema, saveConfig } from "../core/config.ts";
import { listNotifications, markRead } from "../core/notify.ts";
import { listSchedules, nextRuns, scheduleLabels, triggerSchedule, upsertSchedule } from "../core/scheduler.ts";
import { createSpace, getSpace, listSpaces, updateSpace } from "../core/spaces.ts";
import { HttpError } from "../core/util.ts";
import { accessibleSpaces, getUser, OWNER, scopeFor, userForToken } from "../core/users.ts";
import { getGoal, goalSummary, listGoals, upsertGoal } from "../learn/goals.ts";
import { createCard, dueCards, listCards, reviewCard, studyStats, updateCard } from "../learn/cards.ts";
import { getItem, itemEvents, listItems, upsertItem } from "../items/store.ts";
import { getMemory, listMemories, memoryHistory, memoryTags, remember, retract, supersede, updateMemoryText } from "../memory/store.ts";
import { memoryQualityStats, recentRejections } from "../memory/quality.ts";
import { search } from "../search/search.ts";
import { importFile, importText, importUrl } from "../sources/import.ts";
import { deleteSource, getSource, listSources, readSource, sourceOutline } from "../sources/store.ts";
import { deletePage, listPages, pageContext, pageVersion, readPage, spaceGuide, syncWiki, wikiNav, writePage, writeSpaceGuide } from "../wiki/store.ts";

const here = dirname(fileURLToPath(import.meta.url));
function webDist() {
  for (const c of [resolve(here, "../../web/dist"), resolve(here, "../../../web/dist")]) if (existsSync(join(c, "index.html"))) return c;
  return null;
}

const q = <T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> => {
  const r = schema.safeParse(value ?? {});
  if (!r.success) throw new HttpError(400, r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  return r.data;
};

function bearer(req: FastifyRequest) {
  const h = req.headers.authorization;
  if (h?.startsWith("Bearer ")) return h.slice(7);
  return (req.query as { token?: string })?.token ?? "";
}

export async function startServer(app: App, opts: { port?: number; host?: string; quiet?: boolean } = {}) {
  const server = Fastify({ logger: false, bodyLimit: 50 * 1024 * 1024 });
  await server.register(fastifyMultipart, { limits: { fileSize: 200 * 1024 * 1024 } });

  server.setErrorHandler((error: Error & { statusCode?: number; status?: number }, _req, reply) => {
    const status = error instanceof HttpError ? error.status : (error.statusCode ?? 500);
    if (status >= 500) console.error(error);
    reply.status(status).send({ error: error.message });
  });

  // API auth: loopback is trusted as the owner unless a token is configured; per-user
  // API tokens (omem user token) identify other people. Members get a small API:
  // asking, their own conversations and items, search within their spaces.
  const MEMBER_ROUTES = [/^\/api\/ask$/, /^\/api\/conversations(\/[^/?]+)?(\?.*)?$/, /^\/api\/search(\?.*)?$/, /^\/api\/items(\?.*)?$/, /^\/api\/runs\/[^/?]+(\/events)?(\?.*)?$/, /^\/api\/me$/];
  server.decorateRequest("userId", "owner");
  server.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/api/") || req.url.startsWith("/api/tools")) return;
    const token = bearer(req);
    const userId = token ? userForToken(app, token) : app.config.token ? null : OWNER;
    if (!userId) return void reply.status(401).send({ error: "需要访问令牌" });
    (req as FastifyRequest & { userId: string }).userId = userId;
    if (userId !== OWNER && !MEMBER_ROUTES.some((re) => re.test(req.url))) reply.status(403).send({ error: "这个接口只对 omem 的主人开放" });
  });
  const who = (req: FastifyRequest) => (req as FastifyRequest & { userId?: string }).userId ?? OWNER;
  server.get("/api/me", async (req) => {
    const u = getUser(app, who(req));
    return { ...u, spaces: accessibleSpaces(app, u.id) };
  });

  // ---------------------------------------------------------------- tools/MCP
  const toolCtx = (req: FastifyRequest) => {
    const ctx = toolContextForToken(app, bearer(req));
    if (!ctx) throw new HttpError(401, "无效的工具令牌");
    return ctx;
  };
  server.get("/api/tools", async (req) => ({ tools: toolSchemas(toolCtx(req).tools) }));
  server.post("/api/tools/:name", async (req) => callTool(toolCtx(req), (req.params as { name: string }).name, req.body));
  const mcp = async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = toolCtx(req);
    const mcpServer = createMcpServer({ list: async () => toolSchemas(ctx.tools), call: (name, args) => callTool(ctx, name, args) });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.hijack();
    reply.raw.on("close", () => {
      void transport.close();
      void mcpServer.close();
    });
    await mcpServer.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  };
  server.post("/mcp", mcp);
  server.get("/mcp", async (_req, reply) => reply.status(405).send({ error: "use POST" }));

  // ------------------------------------------------------------------- events
  server.get("/api/events", async (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
    res.write(": connected\n\n");
    const runFilter = (req.query as { run?: string }).run;
    const listener = (e: AppEvent) => {
      if (runFilter && !("runId" in e && e.runId === runFilter)) return;
      res.write(`data: ${JSON.stringify(e)}\n\n`);
    };
    app.events.on("event", listener);
    const ping = setInterval(() => res.write(": ping\n\n"), 20000);
    req.raw.on("close", () => {
      clearInterval(ping);
      app.events.off("event", listener);
    });
  });

  // ------------------------------------------------------------------- spaces
  server.get("/api/spaces", async () => {
    const counts = new Map(all<{ space_id: string; n: number }>(app.db, "select space_id, count(*) n from sources where deleted_at is null group by space_id").map((r) => [r.space_id, r.n]));
    const pages = new Map(all<{ space_id: string; n: number }>(app.db, "select space_id, count(*) n from pages group by space_id").map((r) => [r.space_id, r.n]));
    return listSpaces(app).map((s) => ({ ...s, sources: counts.get(s.id) ?? 0, pages: pages.get(s.id) ?? 0 }));
  });
  server.post("/api/spaces", async (req) => {
    const b = q(z.object({ id: z.string().optional(), name: z.string().min(1), kind: z.enum(["personal", "project", "repo", "learning", "topic"]).optional(), description: z.string().optional(), rootPath: z.string().optional() }), req.body);
    const s = createSpace(app, b);
    if (s.rootPath) scheduleSpaceSync(app, s.id);
    return s;
  });
  server.get("/api/spaces/:id", async (req) => {
    const id = (req.params as { id: string }).id;
    return { ...getSpace(app, id), guide: spaceGuide(app, id) };
  });
  server.patch("/api/spaces/:id", async (req) => {
    const id = (req.params as { id: string }).id;
    const b = q(z.object({ name: z.string().optional(), description: z.string().optional(), settings: z.record(z.string(), z.unknown()).optional(), guide: z.string().optional() }), req.body);
    if (b.guide !== undefined) writeSpaceGuide(app, id, b.guide);
    return updateSpace(app, id, { name: b.name, description: b.description, settings: b.settings ? { ...getSpace(app, id).settings, ...b.settings } : undefined });
  });
  server.post("/api/spaces/:id/sync", async (req) => scheduleSpaceSync(app, (req.params as { id: string }).id));

  // ------------------------------------------------------------------ sources
  server.get("/api/sources", async (req) => {
    const o = q(z.object({ space: z.string().optional(), kind: z.string().optional(), q: z.string().optional(), limit: z.coerce.number().optional(), offset: z.coerce.number().optional() }), req.query);
    return listSources(app, { spaceId: o.space, kind: o.kind, q: o.q, limit: o.limit, offset: o.offset });
  });
  server.get("/api/sources/resolve", async (req) => {
    const o = q(z.object({ uri: z.string().min(1), space: z.string().optional() }), req.query);
    const clean = o.uri.replace(/^\.\//, "");
    const row =
      one<{ id: string }>(app.db, `select id from sources where uri = ? ${o.space ? "and space_id = ?" : ""} and deleted_at is null order by updated_at desc`, clean, ...(o.space ? [o.space] : [])) ??
      one<{ id: string }>(app.db, `select id from sources where uri like ? ${o.space ? "and space_id = ?" : ""} and deleted_at is null order by length(uri)`, `%/${clean}`, ...(o.space ? [o.space] : []));
    if (!row) throw new HttpError(404, `找不到原件 ${o.uri}`);
    return { id: row.id };
  });
  server.get("/api/messages/:id", async (req) => {
    const m = one<{ id: string; conversation_id: string; role: string; text: string; created_at: string }>(app.db, "select * from messages where id = ?", (req.params as { id: string }).id.replace(/^msg:/, ""));
    if (!m) throw new HttpError(404, "消息不存在");
    return { id: m.id, conversationId: m.conversation_id, role: m.role, text: m.text, createdAt: m.created_at };
  });
  server.get("/api/sources/:id", async (req) => {
    const id = (req.params as { id: string }).id;
    const o = q(z.object({ from: z.coerce.number().optional(), to: z.coerce.number().optional() }), req.query);
    const r = readSource(app, id, o.from, o.to);
    const citedBy = all<{ page_id: string; title: string }>(app.db, "select distinct c.page_id, p.title from page_cites c join pages p on p.id = c.page_id where c.source_id = ?", id);
    return { ...r, outline: sourceOutline(app, id), citedBy };
  });
  server.get("/api/sources/:id/relations", async (req) => {
    const o = q(z.object({ qname: z.string() }), req.query);
    return symbolRelations(app, (req.params as { id: string }).id, o.qname);
  });
  server.delete("/api/sources/:id", async (req) => {
    deleteSource(app, (req.params as { id: string }).id);
    return { ok: true };
  });
  server.post("/api/sources/text", async (req) => {
    const b = q(z.object({ space: z.string().default("personal"), title: z.string().optional(), text: z.string().min(1), kind: z.enum(["note", "chat", "doc"]).optional(), ingest: z.boolean().default(true) }), req.body);
    const r = importText(app, b.space, { title: b.title, text: b.text, kind: b.kind });
    const ingest = b.ingest ? scheduleIngest(app, b.space, [r.id]) : null;
    return { ...r, ingestRun: ingest?.id ?? null };
  });
  server.post("/api/sources/url", async (req) => {
    const b = q(z.object({ space: z.string().default("personal"), url: z.string().url(), ingest: z.boolean().default(true) }), req.body);
    const r = await importUrl(app, b.space, b.url);
    const ingest = b.ingest && r.status !== "unchanged" ? scheduleIngest(app, b.space, [r.id]) : null;
    return { ...r, ingestRun: ingest?.id ?? null };
  });
  server.post("/api/sources/upload", async (req) => {
    const space = (req.query as { space?: string }).space ?? "personal";
    getSpace(app, space);
    const dir = await mkdtemp(join(tmpdir(), "omem-up-"));
    const results: { name: string; id?: string; status?: string; error?: string }[] = [];
    try {
      for await (const part of req.files()) {
        const file = join(dir, part.filename.replace(/[\\/]/g, "_"));
        await writeFile(file, await part.toBuffer());
        try {
          const r = await importFile(app, space, file, part.filename);
          results.push(r ? { name: part.filename, id: r.id, status: r.status } : { name: part.filename, error: "不支持的文件类型" });
        } catch (e) {
          results.push({ name: part.filename, error: (e as Error).message });
        }
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    const ids = results.filter((r) => r.id && r.status !== "unchanged").map((r) => r.id!);
    const ingest = scheduleIngest(app, space, ids);
    return { results, ingestRun: ingest?.id ?? null };
  });
  server.get("/api/files/:name", async (req, reply) => {
    const name = (req.params as { name: string }).name;
    if (!/^[a-f0-9]{16}\.[a-z0-9]+$/.test(name)) throw new HttpError(400, "bad name");
    const file = join(app.filesDir, name);
    if (!existsSync(file)) throw new HttpError(404, "not found");
    const ext = name.split(".").pop()!;
    const types: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", pdf: "application/pdf" };
    reply.type(types[ext] ?? "application/octet-stream");
    return readFileSync(file);
  });

  // ------------------------------------------------------------------- search
  server.get("/api/search", async (req) => {
    const o = q(z.object({ q: z.string().min(1), space: z.string().optional(), types: z.string().optional(), limit: z.coerce.number().optional() }), req.query);
    const requested = o.space && o.space !== "*" ? o.space.split(",") : null;
    const spaces = scopeFor(app, who(req), requested) ?? undefined;
    return { hits: await search(app, o.q, { spaces, types: o.types ? (o.types.split(",") as never) : undefined, limit: o.limit ?? 30, perSource: 2 }) };
  });

  // --------------------------------------------------------------------- chat
  server.post("/api/ask", async (req) => {
    const b = q(z.object({ text: z.string().min(1), space: z.string().optional(), conversationId: z.string().optional() }), req.body);
    const userId = who(req);
    if (b.space && userId !== OWNER && !(accessibleSpaces(app, userId) ?? []).includes(b.space)) throw new HttpError(403, `不能访问空间 ${b.space}`);
    return ask(app, { text: b.text, spaceId: b.space, conversationId: b.conversationId, userId });
  });
  server.get("/api/conversations", async (req) => {
    const o = q(z.object({ space: z.string().optional() }), req.query);
    const where = ["user_id = ?", ...(o.space ? ["space_id = ?"] : [])];
    return all(app.db, `select * from conversations where ${where.join(" and ")} order by updated_at desc limit 100`, who(req), ...(o.space ? [o.space] : []));
  });

  // ----------------------------------------------------------- agents & skills
  server.get("/api/agents", async () => listAgentSpecs(app, { includeDrafts: true }));
  server.get("/api/agents/:name", async (req) => {
    const name = (req.params as { name: string }).name;
    return { ...readAgentSpec(app, name), history: agentSpecHistory(app, name) };
  });
  server.put("/api/agents/:name", async (req) => saveAgentSpec(app, { ...(req.body as object), name: (req.params as { name: string }).name } as never, "user"));
  server.delete("/api/agents/:name", async (req) => {
    deleteAgentSpec(app, (req.params as { name: string }).name, "user");
    return { ok: true };
  });
  server.get("/api/library-files/:kind/:name", async (req) => {
    const { kind, name } = req.params as { kind: "agent" | "skill"; name: string };
    return { raw: readRaw(app, kind === "agent" ? "agent" : "skill", name) };
  });
  server.put("/api/library-files/:kind/:name", async (req) => {
    const { kind, name } = req.params as { kind: "agent" | "skill"; name: string };
    const b = q(z.object({ raw: z.string().min(1) }), req.body);
    return saveRaw(app, kind === "agent" ? "agent" : "skill", name, b.raw);
  });
  server.get("/api/skills", async () => listSkills(app, { includeDrafts: true }));
  server.get("/api/skills/:name", async (req) => readSkill(app, (req.params as { name: string }).name));
  server.put("/api/skills/:name", async (req) => {
    const b = q(z.object({ description: z.string(), body: z.string(), status: z.enum(["active", "draft"]).optional() }), req.body);
    return saveSkill(app, { name: (req.params as { name: string }).name, ...b }, "user");
  });
  server.delete("/api/skills/:name", async (req) => {
    deleteSkill(app, (req.params as { name: string }).name, "user");
    return { ok: true };
  });
  server.get("/api/conversations/:id", async (req) => {
    const id = (req.params as { id: string }).id;
    const c = one<{ user_id: string }>(app.db, "select * from conversations where id = ?", id);
    if (!c || (who(req) !== OWNER && c.user_id !== who(req))) throw new HttpError(404, "对话不存在");
    return { conversation: c, messages: conversationMessages(app, id) };
  });
  server.delete("/api/conversations/:id", async (req) => {
    const id = (req.params as { id: string }).id;
    const src = one<{ id: string }>(app.db, "select id from sources where uri = ? and deleted_at is null", `conversation:${id}`);
    if (src) deleteSource(app, src.id);
    app.db.prepare("delete from conversations where id = ?").run(id);
    return { ok: true };
  });

  // --------------------------------------------------------------------- wiki
  server.get("/api/wiki/:space", async (req) => {
    const space = (req.params as { space: string }).space;
    syncWiki(app, space);
    return { nav: wikiNav(app, space), pages: listPages(app, space), stale: stalePages(app, space).length };
  });
  server.get("/api/wiki/:space/page/*", async (req) => {
    const { space, "*": slug } = req.params as { space: string; "*": string };
    const v = (req.query as { version?: string }).version;
    if (v) return pageVersion(app, space, slug, v);
    return { ...readPage(app, space, slug), context: pageContext(app, space, slug) };
  });
  server.put("/api/wiki/:space/page/*", async (req) => {
    const { space, "*": slug } = req.params as { space: string; "*": string };
    const b = q(z.object({ title: z.string(), summary: z.string().optional(), kind: z.string().optional(), body: z.string() }), req.body);
    return writePage(app, space, slug, { meta: { title: b.title, summary: b.summary, kind: b.kind }, body: b.body }, { actor: "user" });
  });
  server.delete("/api/wiki/:space/page/*", async (req) => {
    const { space, "*": slug } = req.params as { space: string; "*": string };
    deletePage(app, space, slug);
    return { ok: true };
  });
  server.post("/api/wiki/:space/plan", async (req) => {
    const space = (req.params as { space: string }).space;
    const b = q(z.object({ focus: z.string().optional(), autoWrite: z.boolean().default(true) }), req.body);
    return createRun(app, { kind: "wiki-plan", spaceId: space, title: "规划 Wiki 目录", input: b });
  });
  server.post("/api/wiki/:space/write", async (req) => {
    const space = (req.params as { space: string }).space;
    const b = q(
      z.object({ slug: z.string(), title: z.string(), kind: z.string().default("guide"), question: z.string(), outline: z.string().default(""), entry_points: z.array(z.string()).default([]), instructions: z.string().optional() }),
      req.body,
    );
    const brief: PageBrief = { slug: b.slug, title: b.title, kind: b.kind, question: b.question, outline: b.outline, entry_points: b.entry_points };
    return createRun(app, { kind: "wiki-write", spaceId: space, title: `写作：${b.title}`, input: { brief, instructions: b.instructions } });
  });
  server.post("/api/wiki/:space/lint", async (req) => createRun(app, { kind: "wiki-lint", spaceId: (req.params as { space: string }).space, title: "检查受影响页面" }));
  server.get("/api/graph", async (req) => {
    const o = q(z.object({ space: z.string().optional() }), req.query);
    const nodes = all<{ id: string; title: string; space_id: string; kind: string }>(app.db, `select id, title, space_id, kind from pages ${o.space ? "where space_id = ?" : ""}`, ...(o.space ? [o.space] : []));
    const ids = new Set(nodes.map((n) => n.id));
    const edges = all<{ from_id: string; to_id: string }>(app.db, "select from_id, to_id from page_links").filter((e) => ids.has(e.from_id) && ids.has(e.to_id));
    return { nodes, edges };
  });

  // ----------------------------------------------------------------- memories
  server.get("/api/memories", async (req) => {
    const o = q(
      z.object({ space: z.string().optional(), status: z.string().optional(), kind: z.string().optional(), q: z.string().optional(), tag: z.string().optional(), review: z.enum(["pending", "keep", "rewrite", "retract"]).optional() }),
      req.query,
    );
    if (o.q) {
      const hits = await search(app, o.q, { spaces: o.space ? [o.space] : undefined, types: ["memory"], limit: 100, includeHistory: o.status === "all" });
      return hits.map((h) => getMemory(app, h.id)).filter((m) => (!o.tag || m.tags?.includes(o.tag)) && (!o.kind || m.kind === o.kind));
    }
    return listMemories(app, { spaceId: o.space, status: o.status ?? "active", kind: o.kind, tag: o.tag, review: o.review });
  });
  server.get("/api/memory-tags", async (req) => memoryTags(app, (req.query as { space?: string }).space));
  // Quality per backend/model, recent write-time rejections, and side-by-side comparison runs.
  server.get("/api/memory-quality", async (req) => {
    const days = Number((req.query as { days?: string }).days ?? 30) || 30;
    const ingests = all<{ id: string; title: string; space_id: string; created_at: string; profile_id: string | null }>(
      app.db,
      "select id, title, space_id, created_at, profile_id from runs where kind = 'ingest' and id in (select parent_id from runs where kind = 'ingest-shadow') order by created_at desc limit 20",
    );
    const compare = ingests.map((r) => ({
      run: r,
      live: all<{ id: string; kind: string; content: string; status: string; review_verdict: string | null; model: string | null; agent_profile: string | null }>(
        app.db,
        "select id, kind, content, status, review_verdict, model, agent_profile from memories where run_id = ? order by created_at",
        r.id,
      ),
      shadows: all<{ id: string; title: string; status: string; profile_id: string | null }>(app.db, "select id, title, status, profile_id from runs where parent_id = ? and kind = 'ingest-shadow' order by created_at", r.id).map((s) => ({
        ...s,
        writes: all<{ id: string; tool: string; args: string; verdict: string | null; verdict_note: string | null; model: string | null }>(app.db, "select id, tool, args, verdict, verdict_note, model from shadow_writes where run_id = ? order by at", s.id).map((w) => ({
          ...w,
          args: JSON.parse(w.args),
        })),
        rejected: all<{ content: string; codes: string }>(app.db, "select content, codes from memory_rejections where run_id = ?", s.id).map((x) => ({ content: x.content, codes: JSON.parse(x.codes) })),
      })),
      rejected: all<{ content: string; codes: string }>(app.db, "select content, codes from memory_rejections where run_id = ?", r.id).map((x) => ({ content: x.content, codes: JSON.parse(x.codes) })),
    }));
    return {
      stats: memoryQualityStats(app, days),
      rejections: recentRejections(app, 40),
      pending: one<{ n: number }>(app.db, "select count(*) n from memories where status = 'active' and created_by = 'agent' and reviewed_at is null")?.n ?? 0,
      review: app.config.memory.review,
      compare: app.config.memory.compare,
      runs: compare,
    };
  });
  server.get("/api/memories/:id", async (req) => {
    const id = (req.params as { id: string }).id;
    return { memory: getMemory(app, id), history: memoryHistory(app, id) };
  });
  server.post("/api/memories", async (req) => {
    const b = q(z.object({ space: z.string().default("personal"), kind: z.enum(["fact", "agreement", "preference", "experience", "person", "decision"]), subject: z.string().optional(), content: z.string().min(1), tags: z.array(z.string()).optional() }), req.body);
    return remember(app, { spaceId: b.space, kind: b.kind, subject: b.subject, content: b.content, tags: b.tags, createdBy: "user" });
  });
  server.post("/api/memories/:id/supersede", async (req) => {
    const b = q(z.object({ content: z.string().min(1), reason: z.string().optional() }), req.body);
    return supersede(app, (req.params as { id: string }).id, { content: b.content, reason: b.reason, createdBy: "user" });
  });
  server.patch("/api/memories/:id", async (req) => {
    const b = q(z.object({ content: z.string().optional(), subject: z.string().optional(), kind: z.enum(["fact", "agreement", "preference", "experience", "person", "decision"]).optional(), tags: z.array(z.string()).optional() }), req.body);
    return updateMemoryText(app, (req.params as { id: string }).id, b);
  });
  server.delete("/api/memories/:id", async (req) => retract(app, (req.params as { id: string }).id, ((req.query as { reason?: string }).reason ?? "本人撤回").slice(0, 200)));

  // -------------------------------------------------------------------- items
  const itemBody = z.object({
    space: z.string().optional(),
    kind: z.enum(["todo", "waiting", "reminder", "watch", "decision"]).optional(),
    title: z.string().optional(),
    detail: z.string().optional(),
    status: z.enum(["open", "waiting", "snoozed", "done", "cancelled"]).optional(),
    priority: z.number().int().min(1).max(3).optional(),
    dueAt: z.string().nullable().optional(),
    remindAt: z.string().nullable().optional(),
    waitingOn: z.string().nullable().optional(),
    note: z.string().optional(),
  });
  server.get("/api/items", async (req) => {
    const o = q(z.object({ space: z.string().optional(), status: z.string().optional(), kind: z.string().optional(), q: z.string().optional() }), req.query);
    return listItems(app, { spaceId: o.space, status: o.status ?? "active", kind: o.kind, q: o.q, userId: who(req) === OWNER ? undefined : who(req) });
  });
  server.get("/api/items/:id", async (req) => {
    const id = (req.params as { id: string }).id;
    return { item: getItem(app, id), events: itemEvents(app, id) };
  });
  server.post("/api/items", async (req) => {
    const b = q(itemBody, req.body);
    return upsertItem(app, undefined, { ...b, spaceId: b.space ?? "personal" }, "user");
  });
  server.patch("/api/items/:id", async (req) => {
    const b = q(itemBody, req.body);
    return upsertItem(app, (req.params as { id: string }).id, b, "user");
  });

  // --------------------------------------------------------------------- runs
  server.get("/api/runs", async (req) => {
    const o = q(z.object({ kind: z.string().optional(), space: z.string().optional(), status: z.string().optional(), parent: z.string().optional(), all: z.coerce.boolean().optional(), limit: z.coerce.number().optional() }), req.query);
    return listRuns(app, { kind: o.kind, spaceId: o.space, status: o.status, parentId: o.parent, includeQuiet: o.all, limit: o.limit });
  });
  server.get("/api/runs/:id", async (req) => {
    const id = (req.params as { id: string }).id;
    const o = q(z.object({ after: z.coerce.number().optional() }), req.query);
    const r = getRun(app, id);
    const owner = one<{ user_id: string | null }>(app.db, "select user_id from runs where id = ?", id)?.user_id;
    if (who(req) !== OWNER && owner !== who(req)) throw new HttpError(404, "运行不存在");
    return { run: r, events: runEvents(app, id, o.after ?? 0), children: listRuns(app, { parentId: id }), patch: r.kind === "code" ? codePatch(app, id) : undefined };
  });
  server.post("/api/runs/:id/cancel", async (req) => cancelRun(app, (req.params as { id: string }).id));
  server.post("/api/runs/:id/retry", async (req) => {
    const r = getRun(app, (req.params as { id: string }).id);
    return createRun(app, { kind: r.kind, spaceId: r.spaceId, title: r.title, input: r.input, parentId: r.parentId });
  });
  server.post("/api/runs/:id/apply", async (req) => applyCodeRun(app, (req.params as { id: string }).id));
  server.post("/api/runs/:id/discard", async (req) => {
    discardCodeRun(app, (req.params as { id: string }).id);
    return { ok: true };
  });
  server.post("/api/delegate", async (req) => {
    const b = q(z.object({ space: z.string(), task: z.string().min(1), checkCommand: z.string().optional() }), req.body);
    const s = getSpace(app, b.space);
    if (!s.rootPath) throw new HttpError(400, "这个空间没有关联代码目录");
    return createRun(app, { kind: "code", spaceId: s.id, title: b.task.split("\n")[0].slice(0, 80), input: { task: b.task, checkCommand: b.checkCommand } });
  });

  // ------------------------------------------------------------------ learning
  server.get("/api/cards", async (req) => {
    const o = q(z.object({ space: z.string().optional(), due: z.string().optional() }), req.query);
    return { cards: o.due ? dueCards(app, o.space) : listCards(app, o.space), stats: studyStats(app, o.space) };
  });
  server.post("/api/cards", async (req) => {
    const b = q(z.object({ space: z.string().default("personal"), front: z.string().min(1), back: z.string().default("") }), req.body);
    return createCard(app, { spaceId: b.space, front: b.front, back: b.back }).card;
  });
  server.post("/api/cards/:id/review", async (req) => {
    const b = q(z.object({ rating: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]) }), req.body);
    return reviewCard(app, (req.params as { id: string }).id, b.rating);
  });
  server.patch("/api/cards/:id", async (req) => {
    const b = q(z.object({ front: z.string().optional(), back: z.string().optional(), suspended: z.boolean().optional() }), req.body);
    return updateCard(app, (req.params as { id: string }).id, b);
  });
  // Anki-compatible plain text: one card per line, front<TAB>back (HTML allowed by Anki).
  server.get("/api/cards/export.txt", async (req, reply) => {
    const o = q(z.object({ space: z.string().optional() }), req.query);
    const clean = (s: string) => s.replace(/\t/g, " ").replace(/\r?\n/g, "<br>");
    reply.header("content-disposition", `attachment; filename="omem-cards${o.space ? "-" + o.space : ""}.txt"`).type("text/plain; charset=utf-8");
    return "#separator:tab\n#html:true\n" + listCards(app, o.space).map((c) => `${clean(c.front)}\t${clean(c.back)}`).join("\n") + "\n";
  });
  server.post("/api/cards/import", async (req) => {
    const b = q(z.object({ space: z.string().default("personal"), text: z.string().min(1) }), req.body);
    let created = 0;
    let skipped = 0;
    const sep = /\t/.test(b.text) ? "\t" : ";";
    for (const line of b.text.split(/\r?\n/)) {
      if (!line.trim() || line.startsWith("#")) continue;
      const [front, ...rest] = line.split(sep);
      const r = createCard(app, { spaceId: b.space, front: front.replace(/<br\s*\/?>/g, "\n"), back: rest.join(sep).replace(/<br\s*\/?>/g, "\n") });
      r.created ? created++ : skipped++;
    }
    return { created, skipped };
  });
  server.get("/api/learn/goals", async () => listGoals(app, { userId: OWNER, status: "all" }).map((g) => goalSummary(app, g)));
  server.post("/api/learn/goals", async (req) => {
    const b = q(z.object({ id: z.string().optional(), title: z.string().optional(), detail: z.string().optional(), spaceId: z.string().optional(), dailyNew: z.number().int().optional(), remindAt: z.string().optional(), status: z.enum(["active", "paused", "done"]).optional() }), req.body);
    const { id, ...rest } = b;
    return upsertGoal(app, id, { ...rest, userId: id ? undefined : OWNER });
  });
  server.post("/api/learn/generate", async (req) => {
    const b = q(z.object({ space: z.string(), sourceIds: z.array(z.string()).min(1), focus: z.string().optional() }), req.body);
    return createRun(app, { kind: "tutor", spaceId: b.space, title: "生成复习卡片", input: { sourceIds: b.sourceIds, focus: b.focus } });
  });

  // ----------------------------------------------------- notifications/status
  server.get("/api/notifications", async () => {
    const list = listNotifications(app, 50);
    return { notifications: list, unread: list.filter((n) => !n.readAt).length };
  });
  server.post("/api/notifications/read", async (req) => {
    markRead(app, (req.body as { id?: string } | null)?.id);
    return { ok: true };
  });
  server.get("/api/home", async () => {
    const items = listItems(app, { status: "active" });
    return {
      decisions: items.filter((i) => i.kind === "decision"),
      dueSoon: items.filter((i) => (i.dueAt || i.remindAt) && new Date(i.dueAt ?? i.remindAt!).getTime() < Date.now() + 3 * 86400_000),
      waiting: items.filter((i) => i.kind === "waiting" || i.status === "waiting"),
      runs: listRuns(app, { limit: 8 }),
      study: studyStats(app),
      notifications: listNotifications(app, 8),
      recentSources: all(app.db, "select id, space_id spaceId, kind, uri, title, updated_at updatedAt from sources where deleted_at is null and kind not in ('code', 'conversation') order by updated_at desc limit 8"),
    };
  });
  server.get("/api/schedules", async () => ({ schedules: listSchedules(app), next: nextRuns(app), labels: scheduleLabels }));
  server.put("/api/schedules/:id", async (req) => {
    const id = (req.params as { id: string }).id;
    const existing = listSchedules(app).find((s) => s.id === id);
    if (!existing) throw new HttpError(404, "定时任务不存在");
    const b = q(z.object({ cron: z.string().optional(), enabled: z.boolean().optional(), config: z.record(z.string(), z.unknown()).optional() }), req.body);
    return upsertSchedule(app, { ...existing, ...b });
  });
  server.post("/api/schedules/:id/run", async (req) => ({ ok: triggerSchedule(app, (req.params as { id: string }).id) }));

  // ------------------------------------------------------------ lark personal
  server.get("/api/lark/chats", async () => {
    const { listLarkChats, capturePolicyFor } = await import("../channels/lark-personal.ts");
    return { chats: (await listLarkChats(app)).map((c) => ({ ...c, policy: capturePolicyFor(app, c) })) };
  });
  // Chats capture has read, with kind, mute state and what is done with them.
  server.get("/api/lark/captured", async () => {
    const { capturedChats } = await import("../channels/lark-personal.ts");
    return { chats: capturedChats(app), policies: app.config.lark.capture.policies };
  });
  server.put("/api/lark/chats/:id/policy", async (req) => {
    const { setCapturePolicy, capturedChats } = await import("../channels/lark-personal.ts");
    const b = q(z.object({ policy: z.enum(["ingest", "involved", "store", "skip"]).nullable() }), req.body);
    const id = (req.params as { id: string }).id;
    setCapturePolicy(app, id, b.policy);
    return { chat: capturedChats(app).find((c) => c.chatId === id) ?? null };
  });
  server.get("/api/lark/subscriptions", async () => {
    const { getSubscriptions } = await import("../channels/lark-personal.ts");
    return { subscriptions: getSubscriptions(app) };
  });
  server.put("/api/lark/subscriptions", async (req) => {
    const { setSubscriptions } = await import("../channels/lark-personal.ts");
    const b = q(z.object({ subscriptions: z.array(z.object({ chatId: z.string(), name: z.string(), spaceId: z.string() })) }), req.body);
    return { subscriptions: setSubscriptions(app, b.subscriptions) };
  });
  server.post("/api/lark/poll", async () => {
    const { pollLark } = await import("../channels/lark-personal.ts");
    return pollLark(app);
  });

  server.post("/api/agents/:id/probe", async (req) => {
    const { allProfiles } = await import("../core/config.ts");
    const { cachedProbe, probeProfile, saveProbe } = await import("../agents/probe.ts");
    const id = (req.params as { id: string }).id;
    const p = allProfiles(app.config).find((x) => x.id === id);
    if (!p) throw new HttpError(404, "没有这个 Agent 配置");
    const body = req.body as { refresh?: boolean } | undefined;
    const cached = cachedProbe(app, id);
    if (cached && !body?.refresh) return { ...cached, cached: true };
    const probe = await probeProfile(p);
    if (!probe.error) saveProbe(app, id, probe);
    return probe;
  });

  // Per-role model/effort defaults: agents.roleModels[role][profileId] = { model, effort }.
  server.put("/api/agent-role-model", async (req) => {
    const { saveConfig } = await import("../core/config.ts");
    const b = q(
      z.object({ role: z.string().min(1), profile: z.string().min(1), model: z.string().optional().nullable(), effort: z.string().optional().nullable() }),
      req.body,
    );
    const next = structuredClone(app.config);
    const byRole = new Map(Object.entries(next.agents.roleModels ?? {}));
    const byProfile = new Map(Object.entries(byRole.get(b.role) ?? {}));
    if (b.model === null && b.effort === null) byProfile.delete(b.profile);
    else
      byProfile.set(b.profile, {
        ...(byProfile.get(b.profile) ?? {}),
        ...(b.model === undefined ? {} : { model: b.model || undefined }),
        ...(b.effort === undefined ? {} : { effort: b.effort || undefined }),
      });
    byRole.set(b.role, Object.fromEntries(byProfile));
    next.agents.roleModels = Object.fromEntries(byRole);
    saveConfig(next, app.home);
    Object.assign(app.config, next);
    return { roleModels: next.agents.roleModels };
  });

  // Official ACP registry: agents beyond the built-in catalog, runnable via npx / uvx / a downloaded binary.
  server.get("/api/agent-registry", async () => {
    const { fetchRegistry, registryOptions } = await import("../agents/catalog.ts");
    const have = new Set(listAgentProfiles(app).filter((p) => p.installed).map((p) => p.id));
    return (await fetchRegistry()).map((a) => ({
      id: a.id,
      name: a.name,
      version: a.version,
      description: a.description,
      website: a.website ?? a.repository,
      added: have.has(a.id),
      ways: registryOptions(a).filter((o) => o.available).map((o) => o.kind),
    }));
  });
  server.post("/api/agent-registry/:id", async (req) => {
    const { fetchRegistry } = await import("../agents/catalog.ts");
    const { addRegistryAgent } = await import("../setup.ts");
    const id = (req.params as { id: string }).id;
    const b = q(z.object({ via: z.enum(["npx", "uvx", "binary"]).optional() }), req.body ?? {});
    const agent = (await fetchRegistry()).find((a) => a.id === id);
    if (!agent) throw new HttpError(404, `ACP 注册表里没有 ${id}`);
    const next = structuredClone(app.config);
    const profile = await addRegistryAgent(agent, next, app.home, b.via);
    saveConfig(next, app.home);
    Object.assign(app.config, next);
    return { profile, agents: listAgentProfiles(app) };
  });

  // ----------------------------------------------------------------- settings
  server.get("/api/settings", async () => ({ config: app.config, agents: listAgentProfiles(app), home: app.home }));
  server.put("/api/settings", async (req) => {
    const next = configSchema.parse({ ...app.config, ...(req.body as object) });
    saveConfig(next, app.home);
    Object.assign(app.config, next);
    return { config: app.config, restartNeeded: true };
  });

  // -------------------------------------------------------------------- web
  const dist = webDist();
  if (dist) {
    await server.register(fastifyStatic, { root: dist, prefix: "/" });
    server.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/")) return reply.status(404).send({ error: "not found" });
      return reply.sendFile("index.html");
    });
  }

  const host = opts.host ?? app.config.host;
  const address = await server.listen({ port: opts.port ?? app.config.port, host });
  const url = new URL(address);
  app.baseUrl = `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${url.port}`;
  if (!opts.quiet) console.log(`omem 已启动：${app.baseUrl}${dist ? "" : "（未找到网页构建产物，仅 API）"}`);
  return server;
}
