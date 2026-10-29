import { generateWiki } from "../wiki/generate.ts";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { symbolRelations } from "../sources/callgraph.ts";
import { deleteSkillFile, listSkillFiles, readSkillFile, saveSkillFile, DEFAULT_SPEC_TOOLS, deleteAgentSpec, deleteSkill, listAgentSpecs, listSkills, readAgentSpec, readRaw, readSkill, saveAgentSpec, saveRaw, saveSkill } from "../agents/specs.ts";
import { customizeRole, isBuiltinRole, listRoleStates, mergeRole, resetRole, saveRoleOverride } from "../agents/builtin-roles.ts";
import { profileDetail } from "../agents/profiles.ts";
import { cachedProbe } from "../agents/probe.ts";
import { applyProposal, attachSkills, profileExists, rejectProposal } from "../agents/proposals.ts";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, join, resolve, resolve as resolvePath, sep } from "node:path";
import { fileURLToPath } from "node:url";
import fastifyMultipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import fastifyCompress from "@fastify/compress";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import { applyCodeRun, codeApplyTargets, codeFolders, codePatches, codeRunsAt, codeRepos, createBranchReview, discardCodeRun } from "../agents/code.ts";
import { attachPluginStreams, registerPluginRoutes } from "../plugins/http.ts";
import { IDE_BASE, attachIdeUpgrade, ensureIdeWeb, ideCli, ideFolder, newIdeSession, proxyIde, stopIdeWeb } from "./ide-web.ts";
import { actCodeGit, codeGitActionSchema, readCodeGit } from "../agents/code-git.ts";
import { branchIndexes, dropWorktreeSpace, indexBranch } from "../agents/worktree-index.ts";
import {
  addSourceNote, applyAttentionRulesToExisting, deleteAttentionRule, LEVEL_LABELS, LEVELS, levelCounts, levelOf, listAttentionRules, NOTE_KINDS, removeSourceNote,
  saveAttentionRule, selectSources, setAttention, sourceFilter, sourceNotes,
} from "../sources/attention.ts";
import { defaultBaseRef, fetchBranch, git, isGitRepo, listBranches } from "../core/git.ts";
import { ask, conversationMessages, scheduleIngest, scheduleSpaceSync, stalePages, type PageBrief } from "../agents/jobs.ts";
import { createMcpServer } from "../agents/mcp-server.ts";
import { listAgentProfiles, loadRole, profileFor, resolveRunProfile } from "../agents/runner.ts";
import type { RoleName } from "../core/config.ts";
import { cancelRun, countRuns, createRun, getRun, listRuns, queueReason, runEvents } from "../agents/runs.ts";
import { callTool, mcpTools, toolContextForToken, toolList } from "../agents/tools.ts";
import type { App, AppEvent } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { configSchema, saveConfig } from "../core/config.ts";
import { listNotifications, markRead } from "../core/notify.ts";
import { deleteIgnoreRule, listIgnoreRules } from "../core/notify-lessons.ts";
import { listSchedules, nextRuns, scheduleLabels, triggerSchedule, upsertSchedule } from "../core/scheduler.ts";
import { createSpace, findSpace, getSpace, listSpaces, relatedSpaces, relateSpaces, unrelateSpaces, updateSpace } from "../core/spaces.ts";
import { HttpError } from "../core/util.ts";
import { accessibleSpaces, getUser, OWNER, scopeFor, userForToken } from "../core/users.ts";
import { getGoal, goalSummary, listGoals, upsertGoal } from "../learn/goals.ts";
import { runWrites } from "../agents/run-writes.ts";
import { createCard, dueCards, listCards, reviewCard, studyStats, updateCard } from "../learn/cards.ts";
import { refExcerpt } from "../items/evidence.ts";
import { getItem, itemEvents, listItems, upsertItem } from "../items/store.ts";
import { addMaterials, itemsOfRun, linkRunToItem, materialViews, removeMaterials, type MaterialView } from "../items/materials.ts";
import { getMemory, listMemories, memoryHistory, memoryTags, remember, retract, supersede, updateMemoryText } from "../memory/store.ts";
import { memoryQualityStats, recentRejections } from "../memory/quality.ts";
import { ensureFolder, listFolders, moveMemories, normalizeFolder, relocateFolder, removeFolder, unfiledCount } from "../memory/folders.ts";
import { search } from "../search/search.ts";
import { importFile, importText, importUrl } from "../sources/import.ts";
import { deleteSource, getSource, listSourcePaths, listSources, readSource, sourceOutline } from "../sources/store.ts";
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
  await server.register(fastifyCompress, { encodings: ["gzip"], threshold: 1024, globalDecompression: false });
  server.addHook("onClose", async () => {
    const { releaseBackgroundSessions } = await import("../agents/background-sessions.ts");
    await releaseBackgroundSessions(app);
  });
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
    // Without a token only this machine is trusted, even when listening on all interfaces.
    const local = /^(127\.|::1$|::ffff:127\.)/.test(req.ip ?? "");
    const userId = token ? userForToken(app, token) : app.config.token || !local ? null : OWNER;
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
  server.get("/api/tools", async (req) => ({ tools: mcpTools(toolCtx(req).tools) }));
  server.post("/api/tools/:name", async (req) => callTool(toolCtx(req), (req.params as { name: string }).name, req.body));
  const mcp = async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = toolCtx(req);
    const mcpServer = createMcpServer({ list: async () => mcpTools(ctx.tools), call: (name, args) => callTool(ctx, name, args) });
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
    return listSpaces(app).map((s) => ({ ...s, sources: counts.get(s.id) ?? 0, pages: pages.get(s.id) ?? 0, related: relatedSpaces(app, s.id) }));
  });
  // Related spaces: the owner adds or removes; removing one an agent added keeps it from coming back.
  server.post("/api/spaces/:id/related", async (req) => {
    const id = (req.params as { id: string }).id;
    const b = q(z.object({ space: z.string().min(1), note: z.string().optional() }), req.body);
    relateSpaces(app, id, b.space, { note: b.note, origin: "owner" });
    return relatedSpaces(app, id);
  });
  server.delete("/api/spaces/:id/related/:other", async (req) => {
    const { id, other } = req.params as { id: string; other: string };
    unrelateSpaces(app, id, other, "owner");
    return relatedSpaces(app, id);
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
  server.get("/api/spaces/:id/workspaces", async (req) => {
    const { listWorkspaces } = await import("../agents/workspaces.ts");
    return listWorkspaces(app, getSpace(app, (req.params as { id: string }).id));
  });
  // Another checkout of the same repository becomes the space's directory (delegations start and apply there).
  server.post("/api/spaces/:id/relink", async (req) => {
    const id = (req.params as { id: string }).id;
    const b = q(z.object({ path: z.string().trim().min(1), discard: z.boolean().optional() }), req.body);
    const { relinkRepoSpace } = await import("../agents/repo-relink.ts");
    const r = relinkRepoSpace(app, id, b.path, { discard: b.discard });
    if (r.done) scheduleSpaceSync(app, id);
    return r;
  });

  // ------------------------------------------------------------------ sources
  server.get("/api/sources", async (req) => {
    const o = q(z.object({ space: z.string().optional(), kind: z.string().optional(), q: z.string().optional(), limit: z.coerce.number().optional(), offset: z.coerce.number().optional(), level: z.enum(LEVELS).optional() }), req.query);
    return listSources(app, { spaceId: o.space, kind: o.kind, q: o.q, limit: o.limit, offset: o.offset, level: o.level });
  });

  // ------------------------------------------------- how much a source matters (sources/attention.ts)
  const ownerOnly = (req: { headers: Record<string, unknown> }) => {
    if (who(req as never) !== OWNER) throw new HttpError(403, "只有本人能改关注程度和整理任务");
  };
  server.get("/api/sources/levels", async (req) => {
    const o = q(z.object({ space: z.string().optional() }), req.query);
    return { counts: levelCounts(app, scopeFor(app, who(req), null), o.space), labels: LEVEL_LABELS };
  });
  server.put("/api/sources/:id/attention", async (req) => {
    ownerOnly(req);
    const b = q(z.object({ level: z.enum(LEVELS).nullable() }), req.body);
    setAttention(app, [(req.params as { id: string }).id], b.level, "owner");
    return levelOf(app, (req.params as { id: string }).id);
  });
  server.post("/api/sources/attention", async (req) => {
    ownerOnly(req);
    const b = q(z.object({ filter: sourceFilter, level: z.enum(LEVELS).nullable(), dryRun: z.boolean().optional() }), req.body);
    const rows = selectSources(app, b.filter, null);
    if (b.dryRun) return { matched: rows.length, sample: rows.slice(0, 20) };
    return { matched: rows.length, ...setAttention(app, rows.map((r) => r.id), b.level, "owner") };
  });
  server.get("/api/sources/:id/notes", async (req) => sourceNotes(app, (req.params as { id: string }).id));
  server.post("/api/sources/:id/notes", async (req) => {
    ownerOnly(req);
    const b = q(z.object({ kind: z.enum(NOTE_KINDS), lineStart: z.number().int().nullable().optional(), lineEnd: z.number().int().nullable().optional(), note: z.string().max(500), ref: z.string().nullable().optional() }), req.body);
    return addSourceNote(app, { sourceId: (req.params as { id: string }).id, ...b, by: "owner" });
  });
  server.delete("/api/source-notes/:id", async (req) => {
    ownerOnly(req);
    removeSourceNote(app, Number((req.params as { id: string }).id), "owner");
    return { ok: true };
  });
  server.get("/api/attention-rules", async () => listAttentionRules(app));
  server.put("/api/attention-rules/:id", async (req) => {
    ownerOnly(req);
    const id = (req.params as { id: string }).id;
    return saveAttentionRule(app, req.body, id === "new" ? undefined : id);
  });
  server.delete("/api/attention-rules/:id", async (req) => {
    ownerOnly(req);
    deleteAttentionRule(app, (req.params as { id: string }).id);
    return { ok: true };
  });
  server.post("/api/attention-rules/apply", async (req) => {
    ownerOnly(req);
    const b = q(z.object({ space: z.string().optional() }), req.body ?? {});
    return applyAttentionRulesToExisting(app, b.space);
  });
  server.get("/api/digest-jobs", async (req) => {
    const o = q(z.object({ all: z.coerce.boolean().optional() }), req.query);
    const d = await import("../agents/digest.ts");
    return d.listDigestJobs(app, { all: o.all }).map((j) => ({ ...j, ...d.countDigest(app, j), inflight: d.inflightCount(app, j.id), label: j.body.title ?? d.describeJob(j) }));
  });
  server.post("/api/digest-jobs", async (req) => {
    ownerOnly(req);
    return (await import("../agents/digest.ts")).createDigestJob(app, req.body);
  });
  server.post("/api/digest-jobs/:id/:action", async (req) => {
    ownerOnly(req);
    const p = req.params as { id: string; action: string };
    const status = ({ pause: "paused", resume: "active", stop: "stopped" } as const)[p.action as "pause"];
    if (!status) throw new HttpError(404, "未知操作");
    return (await import("../agents/digest.ts")).setDigestStatus(app, p.id, status);
  });
  // Pace of a job: batches at a time, sources and characters per batch.
  server.put("/api/digest-jobs/:id", async (req) => {
    ownerOnly(req);
    return (await import("../agents/digest.ts")).updateDigestJob(app, (req.params as { id: string }).id, req.body);
  });
  // Models in use now against their limits, and how each did in the last 7 days.
  server.get("/api/agents/load", async () => {
    const c = await import("../agents/capacity.ts");
    return { now: c.loadReport(app), recent: c.recentStats(app) };
  });
  server.get("/api/sources/paths", async (req) => {
    const o = q(z.object({ space: z.string(), kind: z.string().optional(), q: z.string().optional() }), req.query);
    return listSourcePaths(app, { spaceId: o.space, kind: o.kind, q: o.q });
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
    // `window`: that many lines to start with, a chat's latest and anything else's first.
    const o = q(z.object({ from: z.coerce.number().optional(), to: z.coerce.number().optional(), window: z.coerce.number().optional() }), req.query);
    const chat = o.window && getSource(app, id).kind === "chat";
    const r = o.window ? readSource(app, id, 1, chat ? undefined : o.window, chat ? o.window : undefined) : readSource(app, id, o.from, o.to);
    const citedBy = all<{ page_id: string; title: string }>(app.db, "select distinct c.page_id, p.title from page_cites c join pages p on p.id = c.page_id where c.source_id = ?", id);
    return { ...r, outline: sourceOutline(app, id), citedBy, notes: sourceNotes(app, id) };
  });
  // Chat sources captured from Feishu: messages with quotes, images and reactions for a chat-like view.
  server.get("/api/sources/:id/messages", async (req) => {
    const o = q(z.object({ from: z.coerce.number().optional(), to: z.coerce.number().optional() }), req.query);
    const { sourceMessages } = await import("../channels/lark-messages.ts");
    return sourceMessages(app, (req.params as { id: string }).id, o.from, o.to);
  });
  // A chat image or file that was not downloaded at capture time: fetched once, then served as a stored file.
  server.get("/api/lark/messages/:mid/resources/:key", async (req, reply) => {
    if (who(req) !== OWNER) throw new HttpError(403, "只有本人可以读取飞书消息资源");
    const { mid, key } = req.params as { mid: string; key: string };
    if (!/^om_[\w-]{4,80}$/.test(mid) || !/^(?:img|file)_[\w-]{4,120}$/.test(key)) throw new HttpError(400, "bad id");
    const { messageResourceFile } = await import("../channels/lark-messages.ts");
    const file = await messageResourceFile(app, mid, key);
    if (!file) throw new HttpError(404, "读不到这个资源（可能已过期或没有权限）");
    // Served here, not redirected: a redirect would drop the token the browser sent in the query.
    return sendStoredFile(req, reply, file);
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
    const ids = [...(r.status !== "unchanged" ? [r.id] : []), ...(r.related ?? [])];
    const ingest = b.ingest && ids.length ? scheduleIngest(app, b.space, ids) : null;
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
  server.get("/api/files/:name", async (req, reply) => sendStoredFile(req, reply, (req.params as { name: string }).name));
  /** A stored original (images, PDFs, videos with Range support). */
  async function sendStoredFile(req: FastifyRequest, reply: FastifyReply, name: string) {
    if (!/^[a-f0-9]{16}\.[a-z0-9]+$/.test(name)) throw new HttpError(400, "bad name");
    const file = join(app.filesDir, name);
    if (!existsSync(file)) throw new HttpError(404, "not found");
    const ext = name.split(".").pop()!;
    const types: Record<string, string> = {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      webp: "image/webp",
      pdf: "application/pdf",
      mp4: "video/mp4",
      mov: "video/quicktime",
      webm: "video/webm",
      mp3: "audio/mpeg",
      m4a: "audio/mp4",
    };
    reply.type(types[ext] ?? "application/octet-stream").header("accept-ranges", "bytes").header("x-content-type-options", "nosniff");
    // Videos are seeked with Range requests.
    const size = statSync(file).size;
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ""));
    if (range && (range[1] || range[2])) {
      const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start >= size || start > end) return reply.code(416).header("content-range", `bytes */${size}`).send();
      reply.code(206).header("content-range", `bytes ${start}-${end}/${size}`).header("content-length", end - start + 1);
      return reply.send(createReadStream(file, { start, end }));
    }
    reply.header("content-length", size);
    return reply.send(createReadStream(file));
  }

  // ------------------------------------------------------------------- search
  // An id pasted into search (the run id under a Feishu answer, src:/mem:/msg:, an item…): what it names.
  server.get("/api/lookup", async (req) => {
    const o = q(z.object({ id: z.string() }), req.query);
    const { lookupId } = await import("../core/lookup.ts");
    return { hits: lookupId(app, o.id, who(req)) };
  });
  server.get("/api/search", async (req) => {
    const o = q(z.object({ q: z.string().min(1), space: z.string().optional(), types: z.string().optional(), limit: z.coerce.number().optional(), branch: z.string().optional() }), req.query);
    const requested = o.space && o.space !== "*" ? o.space.split(",") : null;
    let spaces = scopeFor(app, who(req), requested) ?? undefined;
    // A repository space on one branch: its index of the branch stands in for the files it changed.
    let branch: Awaited<ReturnType<typeof indexBranch>> | undefined;
    if (o.branch) {
      if (requested?.length !== 1 || !spaces?.length) throw new HttpError(400, "按分支检索时 space 填一个代码仓库空间");
      branch = await indexBranch(app, spaces[0], o.branch);
      spaces = [spaces[0], branch.space];
    }
    return { hits: await search(app, o.q, { spaces, types: o.types ? (o.types.split(",") as never) : undefined, limit: o.limit ?? 30, perSource: 2 }), branch };
  });

  // ------------------------------------------------------------------- branches of a repository space
  const repoFor = (req: { params: unknown }, userId: string) => {
    const s = getSpace(app, (req.params as { id: string }).id);
    if (!(scopeFor(app, userId, [s.id]) ?? [s.id]).includes(s.id)) throw new HttpError(403, `不能访问空间 ${s.id}`);
    if (!s.rootPath || !isGitRepo(s.rootPath)) throw new HttpError(400, `空间 ${s.id} 没有关联 Git 仓库`);
    return s as typeof s & { rootPath: string };
  };
  server.get("/api/spaces/:id/branches", async (req) => {
    const s = repoFor(req, who(req));
    const o = q(z.object({ fetch: z.coerce.boolean().optional() }), req.query);
    if (o.fetch) fetchBranch(s.rootPath, "*");
    return {
      current: git(s.rootPath, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim(),
      base: defaultBaseRef(s.rootPath),
      branches: listBranches(s.rootPath),
      indexed: branchIndexes(app, s.id).map((x) => ({ space: x.id, branch: x.settings.branch, baseRef: x.settings.baseRef, commit: x.settings.commit, updatedAt: x.updatedAt })),
    };
  });
  server.post("/api/spaces/:id/branches/index", async (req) => {
    const s = repoFor(req, who(req));
    const b = q(z.object({ branch: z.string().min(1), base: z.string().optional(), fetch: z.boolean().optional() }), req.body);
    return indexBranch(app, s.id, b.branch, { base: b.base, fetch: b.fetch });
  });
  server.delete("/api/spaces/:id/branches/index", async (req) => {
    const s = repoFor(req, who(req));
    const o = q(z.object({ branch: z.string().min(1) }), req.query);
    dropWorktreeSpace(app, branchIndexes(app, s.id).find((x) => x.settings.branch === o.branch)?.id ?? "");
    return { ok: true };
  });
  server.post("/api/review-branch", async (req) => {
    const b = q(z.object({ space: z.string().optional(), repos: z.array(z.string()).min(1), branch: z.string().min(1), branches: z.record(z.string(), z.string()).optional(), base: z.string().optional(), task: z.string().optional(), title: z.string().optional(), fetch: z.boolean().optional(), reviewTier: z.string().optional(), readSpaces: z.array(z.string()).optional(), itemId: z.string().optional() }), req.body);
    const userId = who(req);
    const wanted = [...b.repos, ...(b.space ? [b.space] : []), ...(b.readSpaces ?? [])];
    const allowed = scopeFor(app, userId, wanted) ?? wanted;
    for (const id of wanted) if (!allowed.includes(id)) throw new HttpError(403, `不能访问空间 ${id}`);
    if (b.itemId && getItem(app, b.itemId).userId !== userId) throw new HttpError(403, "不能使用他人的事项");
    return createBranchReview(app, b, null, userId);
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
  // A spec with what it has learned (attached skills, its own memories, proposals, usage).
  server.get("/api/agents/:name", async (req) => {
    const name = (req.params as { name: string }).name;
    return { ...readAgentSpec(app, name), ...profileDetail(app, name) };
  });
  // Built-in roles as profiles: the source version, the owner's copy, and the same learned view.
  server.get("/api/roles", async () => listRoleStates(app));
  // What a profile form offers: backends, omem tools (and which write), the default tool set of a spec.
  server.get("/api/profile-options", async () => ({
    // The cached probe rides along so the form need not ask again (probe once, or "重新检测").
    backends: listAgentProfiles(app).map((p) => ({ id: p.id, name: p.name ?? p.id, installed: p.installed, transport: p.transport, model: p.model, effort: p.effort, probe: cachedProbe(app, p.id) })),
    globalDefaultBackend: app.config.agents.default || listAgentProfiles(app).find((p) => p.installed)?.id || "",
    defaultBackend: (() => { try { return profileFor(app, "assistant").id; } catch { return ""; } })(),
    tools: toolList().map((t) => ({ name: t.name, description: t.description.split(/[。\n]/)[0], write: !!t.write })),
    defaultTools: DEFAULT_SPEC_TOOLS,
  }));
  server.get("/api/roles/:name", async (req) => {
    const name = (req.params as { name: string }).name;
    const r = loadRole(name, app);
    return { name, description: r.description, tools: r.tools, writes: r.writes, modes: r.modes, body: r.body, defaults: { agent: app.config.agents.roles[name] ?? "", byBackend: app.config.agents.roleModels[name] ?? {} }, ...profileDetail(app, name) };
  });
  server.put("/api/roles/:name/defaults", async (req) => {
    const name = (req.params as { name: string }).name;
    if (!isBuiltinRole(name)) throw new HttpError(400, "未知内置角色");
    const b = q(z.object({ agent: z.string(), profile: z.string().min(1), model: z.string(), effort: z.string() }), req.body);
    const profiles = listAgentProfiles(app);
    if (!profiles.some((p) => p.id === b.profile) || (b.agent && !profiles.some((p) => p.id === b.agent))) throw new HttpError(400, "后端不存在");
    const next = structuredClone(app.config);
    if (b.agent) next.agents.roles[name] = b.agent; else delete next.agents.roles[name];
    next.agents.roleModels[name] = { ...next.agents.roleModels[name], [b.profile]: { model: b.model.trim() || undefined, effort: b.effort.trim() || undefined } };
    saveConfig(next, app.home); Object.assign(app.config, next);
    return { ok: true };
  });
  server.put("/api/roles/:name", async (req) => saveRoleOverride(app, (req.params as { name: string }).name, q(z.object({ raw: z.string().min(1) }), req.body).raw, "user"));
  server.post("/api/roles/:name/customize", async (req) => ({ raw: customizeRole(app, (req.params as { name: string }).name, "user") }));
  server.post("/api/roles/:name/reset", async (req) => resetRole(app, (req.params as { name: string }).name, "user"));
  server.post("/api/roles/:name/merge", async (req) => {
    const name = (req.params as { name: string }).name;
    const r = mergeRole(app, name);
    if (!r.conflicts) return { merged: true, state: r.state };
    const run = createRun(app, { kind: "role-merge", spaceId: "personal", title: `合并内置角色 ${name} 的源码更新`, lane: `role-merge:${name}`, input: { role: name } });
    return { merged: false, conflicts: r.conflicts, runId: run.id };
  });
  server.put("/api/profiles/:name/skills", async (req) => {
    const b = q(z.object({ add: z.array(z.string()).default([]), remove: z.array(z.string()).default([]) }), req.body);
    attachSkills(app, (req.params as { name: string }).name, b.add, b.remove, "user");
    return { ok: true };
  });
  server.post("/api/profiles/:name/review", async (req) => {
    const name = (req.params as { name: string }).name;
    if (!profileExists(app, name)) throw new HttpError(404, `没有 ${name}`);
    const { scheduleProfileReview } = await import("../agents/profile-jobs.ts");
    return scheduleProfileReview(app, name);
  });
  server.post("/api/profile-proposals/:id/apply", async (req) => applyProposal(app, (req.params as { id: string }).id));
  server.post("/api/profile-proposals/:id/reject", async (req) => rejectProposal(app, (req.params as { id: string }).id));
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
  server.get("/api/skills/:name/files", async (req) => listSkillFiles(app, (req.params as { name: string }).name));
  server.get("/api/skills/:name/file", async (req) => ({ raw: readSkillFile(app, (req.params as { name: string }).name, q(z.object({ path: z.string() }), req.query).path) }));
  server.put("/api/skills/:name/file", async (req) => {
    const b = q(z.object({ path: z.string(), raw: z.string(), create: z.boolean().optional() }), req.body);
    saveSkillFile(app, (req.params as { name: string }).name, b.path, b.raw, b.create);
    return { ok: true };
  });
  server.delete("/api/skills/:name/file", async (req) => {
    deleteSkillFile(app, (req.params as { name: string }).name, q(z.object({ path: z.string() }), req.query).path);
    return { ok: true };
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
    return generateWiki(app, { spaceId: space, ...b, userId: who(req) });
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
      z.object({ space: z.string().optional(), status: z.string().optional(), kind: z.string().optional(), q: z.string().optional(), tag: z.string().optional(), folder: z.string().optional(), unfiled: z.string().optional(), review: z.enum(["pending", "keep", "rewrite", "retract"]).optional() }),
      req.query,
    );
    const folder = o.unfiled ? null : normalizeFolder(o.folder) || undefined;
    const inFolder = (m: { folder: string }) => (folder === undefined ? true : folder === null ? !m.folder : m.folder === folder || m.folder.startsWith(folder + "/"));
    if (o.q) {
      const hits = await search(app, o.q, { spaces: o.space ? [o.space] : undefined, types: ["memory"], limit: 100, includeHistory: o.status === "all" });
      return hits.map((h) => getMemory(app, h.id)).filter((m) => (!o.tag || m.tags?.includes(o.tag)) && (!o.kind || m.kind === o.kind) && inFolder(m));
    }
    return listMemories(app, { spaceId: o.space, status: o.status ?? "active", kind: o.kind, tag: o.tag, folder, review: o.review, limit: 5000 });
  });
  // Folders: the tree on the memory page, its upkeep by hand, and an on-demand organizing pass.
  server.get("/api/memory-folders", async (req) => {
    const space = (req.query as { space?: string }).space;
    const spaces = space ? [space] : listSpaces(app).map((s) => s.id);
    return { folders: listFolders(app, spaces), unfiled: Object.fromEntries(spaces.map((s) => [s, unfiledCount(app, s)]).filter(([, n]) => n)) };
  });
  const folderBody = z.object({ space: z.string(), path: z.string().min(1), description: z.string().optional() });
  server.post("/api/memory-folders", async (req) => {
    const b = q(folderBody, req.body);
    const path = normalizeFolder(b.path);
    if (!path) throw new HttpError(400, "目录名不能为空");
    ensureFolder(app, b.space, path, b.description ?? "", "user", true);
    app.emit({ type: "changed", entity: "memory", id: path, spaceId: b.space });
    return { path };
  });
  server.patch("/api/memory-folders", async (req) => {
    const b = q(folderBody.extend({ to: z.string().optional() }), req.body);
    const path = normalizeFolder(b.path);
    if (b.description !== undefined) ensureFolder(app, b.space, path, b.description, "user", true);
    const to = b.to === undefined ? path : normalizeFolder(b.to);
    if (to !== path) relocateFolder(app, b.space, path, to, "user");
    app.emit({ type: "changed", entity: "memory", id: to, spaceId: b.space });
    return { path: to };
  });
  server.delete("/api/memory-folders", async (req) => {
    const o = q(z.object({ space: z.string(), path: z.string().min(1) }), req.query);
    return { moved: removeFolder(app, o.space, normalizeFolder(o.path), "user") };
  });
  server.post("/api/memory-folders/move", async (req) => {
    const b = q(z.object({ space: z.string(), ids: z.array(z.string()).min(1), folder: z.string() }), req.body);
    return { moved: moveMemories(app, b.space, b.ids, normalizeFolder(b.folder), "user") };
  });
  server.post("/api/memory-folders/organize", async (req) => {
    const b = q(z.object({ space: z.string() }), req.body);
    if (listRuns(app, { kind: "memory-organize", status: "queued" }).length || listRuns(app, { kind: "memory-organize", status: "running" }).length) throw new HttpError(409, "已有整理目录的运行在进行");
    return createRun(app, { kind: "memory-organize", spaceId: b.space, title: "整理记忆目录" });
  });
  server.get("/api/memory-tags", async (req) => memoryTags(app, (req.query as { space?: string }).space));
  // Recall/effectiveness accounting for memory governance.
  server.get("/api/memory-recall-stats", async (req) => {
    const o = q(z.object({ space: z.string().optional(), includeInactive: z.coerce.boolean().optional(), sort: z.enum(["recalls", "never", "unused", "recent"]).optional() }), req.query);
    const { recallStats, memoriesWithRecall } = await import("../memory/recall-stats.ts");
    return { stats: recallStats(app, { spaceId: o.space, includeInactive: o.includeInactive }), memories: memoriesWithRecall(app, { spaceId: o.space, sort: o.sort }) };
  });
  // Shortcomings seen in daily use (answers that found nothing, corrections, failures…); owner only.
  server.get("/api/shortcomings", async (req) => {
    const days = Number((req.query as { days?: string }).days ?? 7) || 7;
    const { shortcomings } = await import("../memory/gaps.ts");
    return shortcomings(app, { since: new Date(Date.now() - days * 86400_000).toISOString(), limit: 20 });
  });
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
    const b = q(z.object({ space: z.string().default("personal"), kind: z.enum(["fact", "agreement", "preference", "experience", "person", "decision"]), subject: z.string().optional(), content: z.string().min(1), tags: z.array(z.string()).optional(), folder: z.string().optional() }), req.body);
    const folder = normalizeFolder(b.folder);
    const m = remember(app, { spaceId: b.space, kind: b.kind, subject: b.subject, content: b.content, tags: b.tags, folder, createdBy: "user" });
    if (folder) ensureFolder(app, b.space, folder, "", "user");
    return m;
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
    status: z.enum(["open", "waiting", "snoozed", "done", "cancelled", "expired"]).optional(),
    priority: z.number().int().min(1).max(3).optional(),
    dueAt: z.string().nullable().optional(),
    remindAt: z.string().nullable().optional(),
    waitingOn: z.string().nullable().optional(),
    note: z.string().optional(),
  });
  server.get("/api/items", async (req) => {
    const o = q(z.object({ space: z.string().optional(), status: z.string().optional(), kind: z.string().optional(), q: z.string().optional() }), req.query);
    const { itemExpiry } = await import("../items/expiry.ts");
    return listItems(app, { spaceId: o.space, status: o.status ?? "active", kind: o.kind, q: o.q, userId: who(req) === OWNER ? undefined : who(req) }).map((i) => {
      const e = itemExpiry(app, i);
      return e ? { ...i, expiresAt: e.at, expiryText: e.text } : i;
    });
  });
  // Items close themselves (src/items/expiry.ts): the rules, the backlog waiting for review, and "keep".
  server.get("/api/items-expiry", async (req) => {
    const { backlogApplied, dueItems, expirySince } = await import("../items/expiry.ts");
    const userId = who(req) === OWNER ? undefined : who(req);
    const row = (d: Awaited<ReturnType<typeof dueItems>>[number]) => ({ id: d.item.id, title: d.item.title, kind: d.item.kind, spaceId: d.item.spaceId, lastActivity: d.lastActivity, expiresAt: d.expiry.at, expiryText: d.expiry.text });
    const due = dueItems(app, { userId, withinDays: 3 });
    return {
      settings: app.config.items,
      since: expirySince(app),
      backlogApplied: backlogApplied(app),
      backlog: due.filter((d) => d.backlog).map(row),
      soon: due.filter((d) => !d.backlog).map(row),
    };
  });
  server.post("/api/items-expiry/backlog", async (req) => {
    if (who(req) !== OWNER) throw new HttpError(403, "只有本人能处理积压");
    const b = q(z.object({ keep: z.array(z.string()).default([]) }), req.body);
    const { applyBacklog } = await import("../items/expiry.ts");
    return { expired: applyBacklog(app, b.keep) };
  });
  server.post("/api/items-expiry/sweep", async (req) => {
    if (who(req) !== OWNER) throw new HttpError(403, "只有本人能立即收尾");
    const { sweepItems } = await import("../agents/jobs.ts");
    return sweepItems(app);
  });
  server.post("/api/items/:id/keep", async (req) => {
    const id = (req.params as { id: string }).id;
    const item = getItem(app, id);
    if (item.userId !== who(req) && who(req) !== OWNER) throw new HttpError(403, "不能修改他人的事项");
    const { keepItem } = await import("../items/expiry.ts");
    return keepItem(app, id, "user");
  });
  server.get("/api/items/:id", async (req) => {
    const id = (req.params as { id: string }).id;
    const item = getItem(app, id);
    // A readable excerpt per reference, only from spaces this reader may see.
    const allowed = accessibleSpaces(app, who(req));
    const excerpts: Record<string, { title: string; text: string }> = {};
    for (const ref of item.sourceRefs) {
      const ex = refExcerpt(app, ref, 120);
      if (ex && (!allowed || allowed.includes(ex.spaceId))) excerpts[ref] = { title: ex.title, text: ex.text };
    }
    const { listWorkFiles } = await import("../sources/work.ts");
    const files = listWorkFiles(app, { item: id, spaces: allowed });
    const { itemExpiry } = await import("../items/expiry.ts");
    return { item, events: itemEvents(app, id), excerpts, files, expiry: itemExpiry(app, item), materials: materialViews(app, id, who(req)).map(materialForPage(app)) };
  });
  const materialBody = z.object({ kind: z.enum(["source", "conversation", "repo", "space", "run"]), ref: z.string().min(1), branch: z.string().optional(), base: z.string().optional(), label: z.string().optional(), note: z.string().optional() });
  server.post("/api/items/:id/materials", async (req) => {
    const b = q(z.object({ materials: z.array(materialBody).min(1) }), req.body);
    return addMaterials(app, (req.params as { id: string }).id, b.materials, who(req), "user");
  });
  server.delete("/api/items/:id/materials/:mid", async (req) => {
    const p = req.params as { id: string; mid: string };
    return { removed: removeMaterials(app, p.id, [Number(p.mid)], who(req), "user") };
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
    const o = q(z.object({ kind: z.string().optional(), space: z.string().optional(), status: z.string().optional(), parent: z.string().optional(), all: z.coerce.boolean().optional(), q: z.string().optional(), brief: z.coerce.boolean().optional(), limit: z.coerce.number().optional(), offset: z.coerce.number().optional() }), req.query);
    const opts = { kind: o.kind, spaceId: o.space, status: o.status, parentId: o.parent, includeQuiet: o.all, q: o.q };
    const runs = listRuns(app, { ...opts, limit: o.limit, offset: o.offset, brief: o.brief }).map((r) => (r.status === "queued" ? { ...r, waiting: queueReason(app, r) } : r));
    return { runs, total: countRuns(app, opts) };
  });
  server.get("/api/runs/:id", async (req) => {
    const id = (req.params as { id: string }).id;
    const o = q(z.object({ after: z.coerce.number().optional() }), req.query);
    const r = getRun(app, id);
    const owner = one<{ user_id: string | null }>(app.db, "select user_id from runs where id = ?", id)?.user_id;
    if (who(req) !== OWNER && owner !== who(req)) throw new HttpError(404, "运行不存在");
    return { run: { ...r, waiting: queueReason(app, r) }, events: runEvents(app, id, o.after ?? 0), children: listRuns(app, { parentId: id }), patches: r.kind === "code" ? codePatches(app, id) : undefined, context: runContext(app, r), writes: runWrites(app, r) };
  });
  // Folders to open in an editor; `local`: the page is on this machine (loopback, no token), so a
  // local link works; otherwise the viewer reaches them over SSH (`host` keys their alias for it).
  server.get("/api/runs/:id/folders", async (req) => {
    const id = (req.params as { id: string }).id;
    const local = !bearer(req) && /^(127\.|::1$|::ffff:127\.)/.test(req.ip ?? "");
    return { local, host: hostname(), platform: process.platform, folders: codeFolders(app, id) };
  });
  // Web VS Code (src/server/ide-web.ts): an ordinary link (the token as a query, like downloads)
  // starts serve-web, gives the owner's browser the session cookie that opens /ide and redirects
  // there; /ide itself is proxied raw, body unread.
  // Which VS Code CLI web VS Code would run here (the gear menu shows it next to the command field).
  server.get("/api/ide/cli", async () => {
    const found = ideCli(app);
    return { command: app.config.ide.web.command ?? null, found: found?.path ?? null };
  });
  server.get("/api/ide/open", async (req, reply) => {
    if (who(req) !== OWNER) throw new HttpError(403, "网页版 VS Code 只对本人开放");
    const { folder } = q(z.object({ folder: z.string().optional(), token: z.string().optional() }), req.query);
    // Opened in a new tab: a readable sentence, not JSON.
    const failed = await ensureIdeWeb(app).then(() => null, (e: Error) => e.message);
    if (failed) return reply.code(503).type("text/plain; charset=utf-8").send(failed);
    reply.header("set-cookie", newIdeSession()).header("cache-control", "no-store");
    return reply.redirect(`${IDE_BASE}/${folder ? `?folder=${encodeURIComponent(ideFolder(folder))}` : ""}`);
  });
  await server.register(async (ide) => {
    ide.removeAllContentTypeParsers();
    ide.addContentTypeParser("*", (_req, _payload, done) => done(null));
    const pass = async (req: FastifyRequest, reply: FastifyReply) => {
      reply.hijack();
      await proxyIde(app, req.raw, reply.raw);
    };
    ide.all(IDE_BASE, pass);
    ide.all(`${IDE_BASE}/*`, pass);
    // A peer's web VS Code through this node (`omem peer open` of a peer reached via this one):
    // forwarded raw like /ide itself; the auth hook above already let only the owner in.
    const relay = async (req: FastifyRequest, reply: FastifyReply) => {
      const { tunnelHttp } = await import("../core/peer-tunnel.ts");
      const hops = Number(req.headers["x-omem-hops"] ?? 0);
      if (hops > 3) throw new HttpError(508, "同伴转发层数过多");
      const { id } = req.params as { id: string };
      reply.hijack();
      tunnelHttp(app, id, req.url.slice(`/api/peers/${encodeURIComponent(id)}`.length), req.raw, reply.raw, hops + 1);
    };
    ide.all("/api/peers/:id/ide", relay);
    ide.all("/api/peers/:id/ide/*", relay);
    ide.get("/api/peers/:id/api/ide/open", relay);
  });
  attachIdeUpgrade(app, server.server);
  attachPluginStreams(app, server.server);
  // Its WebSocket: upgrades skip the hooks, so the owner's token is checked here.
  server.server.on("upgrade", async (req, socket, head) => {
    const m = /^\/api\/peers\/([^/?]+)(\/.*)$/.exec(req.url ?? "");
    if (!m) return;
    const { tunneled, tunnelUpgrade } = await import("../core/peer-tunnel.ts");
    if (!tunneled(m[2])) return void socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
    const h = req.headers.authorization;
    const hops = Number(req.headers["x-omem-hops"] ?? 0);
    if (!h?.startsWith("Bearer ") || userForToken(app, h.slice(7)) !== OWNER) return void socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
    if (hops > 3) return void socket.end("HTTP/1.1 508 Loop Detected\r\n\r\n");
    tunnelUpgrade(app, decodeURIComponent(m[1]), m[2], req, socket, head, hops + 1);
  });
  server.addHook("onClose", async () => stopIdeWeb());
  // The delegations an editor opened on `folder` belongs to (the VS Code extension, docs/v2/ide.md).
  server.get("/api/code-runs/at", async (req) => {
    const { folder } = q(z.object({ folder: z.string().min(1) }), req.query);
    return { runs: codeRunsAt(app, folder, who(req) === OWNER ? null : who(req)) };
  });
  server.post("/api/runs/:id/cancel", async (req) => {
    const id = (req.params as { id: string }).id;
    // Stopping a coding round from the page is the owner's stop: no automatic round after it.
    const r = getRun(app, id);
    if (r.kind === "code" && ["queued", "running"].includes(r.status)) {
      const { stopCodeWork } = await import("../agents/code-steer.ts");
      stopCodeWork(app, id, "本人在网页上停下");
      return getRun(app, id);
    }
    return cancelRun(app, id);
  });
  server.post("/api/runs/:id/retry", async (req) => {
    const id = (req.params as { id: string }).id;
    const owner = one<{ user_id: string | null }>(app.db, "select user_id from runs where id = ?", id)?.user_id;
    if (who(req) !== OWNER && owner !== who(req)) throw new HttpError(404, "运行不存在");
    return (await import("../agents/retry.ts")).retryRun(app, id);
  });
  server.get("/api/runs/:id/apply-targets", async (req) => codeApplyTargets(app, (req.params as { id: string }).id));
  server.post("/api/runs/:id/apply", async (req) => {
    const b = q(z.object({ squash: z.string().trim().max(10000).optional(), force: z.boolean().optional() }), req.body ?? {});
    return applyCodeRun(app, (req.params as { id: string }).id, { squash: b.squash || undefined, force: b.force });
  });
  // A delegation's work branch (src/agents/code-branch.ts): its state, and what the owner does with it before confirming.
  server.get("/api/runs/:id/branch", async (req) => {
    const id = (req.params as { id: string }).id;
    const owner = one<{ user_id: string | null }>(app.db, "select user_id from runs where id = ?", id)?.user_id;
    if (who(req) !== OWNER && owner !== who(req)) throw new HttpError(404, "运行不存在");
    return (await import("../agents/code-branch.ts")).branchStatus(app, id);
  });
  server.post("/api/runs/:id/branch", async (req) => {
    const id = (req.params as { id: string }).id;
    const b = q(z.object({ space: z.string().min(1), action: z.enum(["rename", "checkout", "squash"]), name: z.string().trim().max(200).optional(), message: z.string().trim().max(10000).optional() }), req.body);
    if (who(req) !== OWNER) throw new HttpError(403, "分支操作只对本人开放");
    const m = await import("../agents/code-branch.ts");
    if (b.action === "rename") return m.renameWorkBranch(app, id, b.space, b.name ?? "");
    if (b.action === "checkout") return m.checkoutInMain(app, id, b.space);
    return m.squashWorkBranch(app, id, b.space, b.message ?? "");
  });
  // Merge or rebase the work branch onto another branch: a round of Git work, conflicts to the coding Agent.
  server.post("/api/runs/:id/sync", async (req) => {
    const id = (req.params as { id: string }).id;
    const b = q(z.object({ onto: z.string().trim().min(1).max(200), mode: z.enum(["merge", "rebase"]).optional() }), req.body);
    if (who(req) !== OWNER) throw new HttpError(403, "分支操作只对本人开放");
    return (await import("../agents/code.ts")).queueSyncRound(app, id, { onto: b.onto, mode: b.mode ?? "merge" }, who(req));
  });
  server.get("/api/runs/:id/git", async (req) => {
    const { space } = q(z.object({ space: z.string().min(1) }), req.query);
    if (!(scopeFor(app, who(req), [space]) ?? [space]).includes(space)) throw new HttpError(403, "不能访问该仓库");
    return readCodeGit(app, (req.params as { id: string }).id, space);
  });
  server.post("/api/runs/:id/git", async (req) => {
    const body = q(codeGitActionSchema, req.body);
    if (!(scopeFor(app, who(req), [body.space]) ?? [body.space]).includes(body.space)) throw new HttpError(403, "不能访问该仓库");
    return actCodeGit(app, (req.params as { id: string }).id, body, who(req));
  });
  // The target branch moved since the work began: redo the work on its latest commit (code-sync.ts).
  server.post("/api/runs/:id/move-to-target", async (req) => {
    const id = (req.params as { id: string }).id;
    const owner = one<{ user_id: string | null }>(app.db, "select user_id from runs where id = ?", id)?.user_id;
    if (who(req) !== OWNER && owner !== who(req)) throw new HttpError(404, "运行不存在");
    return (await import("../agents/code.ts")).queueMoveToTarget(app, id, who(req));
  });
  server.post("/api/runs/:id/discard", async (req) => {
    discardCodeRun(app, (req.params as { id: string }).id);
    return { ok: true };
  });
  server.post("/api/delegate", async (req) => {
    // `space` is where the task belongs (a repository or a project); `repos` the repositories it changes.
    const sync = z.object({ pull: z.boolean().optional(), onto: z.string().optional(), mode: z.enum(["merge", "rebase"]).optional(), fetch: z.boolean().optional() });
    const b = q(z.object({ space: z.string(), repos: z.array(z.string()).optional(), task: z.string().min(1), checkCommand: z.string().optional(), reviewTier: z.string().optional(), fromBranch: z.string().optional(), branch: z.string().trim().max(200).optional(), itemId: z.string().optional(), sync: sync.optional(), syncOnly: z.boolean().optional(), parallel: z.boolean().optional() }), req.body);
    if (b.sync && !b.sync.pull && !b.sync.onto) throw new HttpError(400, "同步要选拉取或合并 / 变基到哪个分支");
    const userId = who(req);
    const s = getSpace(app, b.space);
    const repos = codeRepos(app, s.id, b.repos).map((r) => r.id);
    const fromBranches = b.fromBranch ? Object.fromEntries(repos.map((id) => [id, b.fromBranch!])) : undefined;
    const branchNames = b.branch ? Object.fromEntries(repos.map((id) => [id, b.branch!])) : undefined;
    // A new delegation gets a new branch; only one that works on an existing branch can meet another.
    const onBranch = b.fromBranch ?? b.branch;
    if (!b.parallel && onBranch) {
      const { openDelegationOn } = await import("../agents/review-fix.ts");
      const open = openDelegationOn(app, repos, onBranch, userId);
      if (open) throw new HttpError(409, `分支 ${onBranch} 上已有没确认的交办「${open.title}」（${open.id}），在它上面接着改，或者先确认 / 丢弃它`);
    }
    if (b.itemId && getItem(app, b.itemId).userId !== userId) throw new HttpError(403, "不能使用他人的事项");
    const r = createRun(app, { kind: "code", spaceId: s.id, title: b.task.split("\n")[0].slice(0, 80), input: { task: b.task, checkCommand: b.checkCommand, repos, reviewTier: b.reviewTier || undefined, fromBranches, branchNames, itemId: b.itemId, ...(b.sync ? { sync: b.sync, syncOnly: !!b.syncOnly } : {}) }, userId });
    if (b.itemId) linkRunToItem(app, r, b.itemId, userId);
    return r;
  });

  // ------------------------------------------------------------------- code review (docs/v2/review.md)
  server.get("/api/review-settings", async () => {
    const { reviewChecks, reviewTiers } = await import("../agents/review.ts");
    const checks = reviewChecks(app).map((c) => {
      let ai: { profile: string; model?: string; effort?: string } | null = null;
      try {
        const spec = c.builtin ? null : readAgentSpec(app, c.name);
        const p = resolveRunProfile(app, { actor: spec ? { spec } : { role: c.name as RoleName }, profileId: c.builtin ? app.config.agents.roles[c.name] : undefined });
        ai = { profile: p.id, model: p.model, effort: p.effort };
      } catch { /* missing profile or backend: shown as such */ }
      return { ...c, ai };
    });
    // How recent delegations fell into the tiers, to judge the thresholds.
    const recent = all<{ tier: string | null; n: number }>(app.db, "select json_extract(output, '$.reviewPlan.tier') tier, count(*) n from (select output from runs where kind = 'code' and json_extract(input, '$.round') is null order by created_at desc limit 30) group by tier");
    const specs = listAgentSpecs(app).filter((s) => !checks.some((c) => c.name === s.name)).map((s) => ({ name: s.name, description: s.description }));
    return { tiers: reviewTiers(app), rereviewAllEvery: app.config.review.rereviewAllEvery, rotation: app.config.review.rotation ?? [], checks, specs, recent: Object.fromEntries(recent.filter((r) => r.tier).map((r) => [r.tier, r.n])) };
  });
  server.put("/api/review-settings", async (req) => {
    const { validateReviewSettings } = await import("../agents/review.ts");
    const settings = validateReviewSettings(app, req.body);
    const next = structuredClone(app.config);
    next.review = settings;
    saveConfig(next, app.home);
    Object.assign(app.config, next);
    return { ok: true };
  });
  server.get("/api/review-options", async () => {
    const { REVIEW_FIELDS, REVIEW_FIELD_HELP, REVIEW_OPS } = await import("../agents/review.ts");
    return { fields: REVIEW_FIELDS, descriptions: REVIEW_FIELD_HELP, ops: REVIEW_OPS };
  });
  // Every round of the delegation a coding run belongs to, with each check's findings.
  server.get("/api/runs/:id/reviews", async (req) => {
    const r = getRun(app, (req.params as { id: string }).id);
    if (r.kind !== "code") throw new HttpError(400, "只有编码交办有评审");
    const { reviewChecks, reviewsOf } = await import("../agents/review.ts");
    const chain = (r.output as { codeChain?: { rounds: string[] } }).codeChain;
    const rounds = (chain?.rounds ?? [r.id]).map((id) => getRun(app, id));
    const labels = Object.fromEntries(reviewChecks(app).map((c) => [c.name, c.label]));
    const { getAsk } = await import("../agents/asks.ts");
    // The owner's open decision on a round (plan to confirm, stopped review), answered from the run page.
    const askOf = (id: unknown) => { try { const a = typeof id === "string" ? getAsk(app, id) : null; return a ? { id: a.id, status: a.status, question: a.question, options: a.options, answer: a.answer, handler: one<{ h: string | null }>(app.db, "select json_extract(context, '$.handler') h from asks where id = ?", a.id)?.h ?? null } : null; } catch { return null; } };
    // A review that waited for the owner (a confirmed plan, a retry, a later split) ran in runs of its own.
    const reviewRuns = (id: string) => all<{ id: string; status: string; title: string }>(app.db, "select id, status, title from runs where parent_id = ? and kind = 'review' order by created_at", id);
    return {
      estimate: rounds[0]?.output.reviewEstimate ?? null,
      rounds: rounds.map((x) => ({
        runId: x.id, round: (x.input as { round?: number }).round ?? 1, status: x.status,
        plan: x.output.reviewPlan ?? null, verdict: x.output.verdict ?? null, stage: x.output.reviewStage ?? null,
        lead: x.output.reviewLead ?? null, stop: x.output.reviewStop ?? null, changePoints: (x.output.changePoints as { points?: unknown[] } | undefined)?.points ?? null, ask: askOf(x.output.reviewAskId), acceptedByOwner: !!x.output.acceptedByOwner,
        reviewRuns: reviewRuns(x.id),
      })),
      reviews: reviewsOf(app, rounds.map((x) => x.id)),
      labels,
    };
  });
  // A file of a delegation as it is now: the worktree while it exists, else the repository (after apply).
  // The owner's call on a finding, and starting the fix (src/agents/review-fix.ts).
  const ownRun = (req: FastifyRequest, id: string) => {
    const owner = one<{ user_id: string | null }>(app.db, "select user_id from runs where id = ?", id)?.user_id;
    if (who(req) !== OWNER && owner !== who(req)) throw new HttpError(404, "运行不存在");
  };
  const tierExists = async (tier: string) => {
    const { reviewTiers } = await import("../agents/review.ts");
    if (!reviewTiers(app).some((t) => t.id === tier || t.name === tier)) throw new HttpError(400, `没有评审档位 ${tier}`);
  };
  server.put("/api/runs/:id/findings/:fid", async (req) => {
    const p = req.params as { id: string; fid: string };
    ownRun(req, p.id);
    const b = q(z.object({ decision: z.enum(["fix", "later", "wontfix"]).nullable(), note: z.string().max(2000).optional() }), req.body);
    const { setFindingDecision } = await import("../agents/review-fix.ts");
    return setFindingDecision(app, p.id, Number(p.fid), b.decision, b.note);
  });
  // Split the requirement into change points for a review that has none (an earlier review), or
  // rework the split it has by the owner's note.
  server.post("/api/runs/:id/change-points", async (req) => {
    const id = (req.params as { id: string }).id;
    ownRun(req, id);
    const b = q(z.object({ note: z.string().max(20000).optional(), revise: z.boolean().optional() }), req.body ?? {});
    const { requestSplit } = await import("../agents/review-chain.ts");
    return requestSplit(app, id, { ...b, userId: who(req) });
  });
  server.post("/api/runs/:id/fix", async (req) => {
    const id = (req.params as { id: string }).id;
    ownRun(req, id);
    const b = q(z.object({
      findingIds: z.array(z.number().int()).max(200),
      text: z.string().max(20000).optional(),
      // The next rounds' review (code-steer.ts RoundReview) and the functional reviewer's AI for them.
      review: z.object({ tier: z.string().optional(), checks: z.array(z.string()).optional(), split: z.boolean().optional(), rotate: z.boolean().optional() }).optional(),
      reviewAi: z.object({ profile: z.string().min(1), model: z.string().optional(), effort: z.string().optional() }).optional(),
      applyFirst: z.boolean().optional(),
    }), req.body);
    if (b.review?.tier) await tierExists(b.review.tier);
    const { validateExecution } = await import("../agents/execution.ts");
    const reviewExecution = b.reviewAi ? validateExecution(app, { ...b.reviewAi, source: "user", reason: "本人在网页上按评审修改时指定" }) : undefined;
    const { startFix } = await import("../agents/review-fix.ts");
    return startFix(app, id, { findingIds: b.findingIds, text: b.text, review: b.review, reviewExecution, applyFirst: b.applyFirst }, who(req));
  });
  // The owner's words for a delegation while it runs, and the review its rounds get from now on (code-steer.ts).
  server.post("/api/runs/:id/notes", async (req) => {
    const id = (req.params as { id: string }).id;
    ownRun(req, id);
    const b = q(z.object({ text: z.string().min(1).max(20000) }), req.body);
    const { addCodeNote } = await import("../agents/code-steer.ts");
    return addCodeNote(app, id, b.text, who(req));
  });
  server.put("/api/runs/:id/round-review", async (req) => {
    const id = (req.params as { id: string }).id;
    ownRun(req, id);
    const b = q(z.object({ tier: z.string().optional(), checks: z.array(z.string()).optional(), split: z.boolean().optional(), rotate: z.boolean().optional() }), req.body);
    if (b.tier) await tierExists(b.tier);
    const { setRoundReview } = await import("../agents/code-steer.ts");
    return setRoundReview(app, id, b);
  });

  // A file a delegation or review names (`space` optional; a path may start with the repository's
  // space id): the worktree while it exists, a reviewed branch's tip after it is gone, else the
  // repository; a path in another space the review read (a migration's source) comes from the index.
  server.get("/api/runs/:id/file", async (req) => {
    const o = q(z.object({ space: z.string().optional(), path: z.string().min(1).max(1000) }), req.query);
    const r = getRun(app, (req.params as { id: string }).id);
    if (r.kind !== "code") throw new HttpError(400, "只有编码交办有文件");
    const { worktreesOf } = await import("../agents/code.ts");
    const root = (r.output as { continueFrom?: string }).continueFrom ?? (r.input as { continueFrom?: string }).continueFrom ?? r.id;
    const worktrees = worktreesOf(app, root);
    const input = getRun(app, root).input as { repos?: string[]; readSpaces?: string[]; itemId?: string };
    const repos = o.space ? [o.space] : [...new Set([...worktrees.map((w) => w.space), ...(input.repos ?? [])])];
    const allowed = accessibleSpaces(app, who(req));
    for (const space of repos) {
      if (allowed && !allowed.includes(space)) continue;
      const path = o.path.startsWith(`${space}/`) && !o.space ? o.path.slice(space.length + 1) : o.path;
      const wt = worktrees.find((w) => w.space === space);
      const appliedTo = (r.output.appliedTo ?? getRun(app, root).output.appliedTo) as { space: string; path: string }[] | undefined;
      const base = wt && existsSync(wt.path) ? wt.path : appliedTo?.find(t => t.space === space)?.path ?? findSpace(app, space)?.rootPath;
      // A reviewed branch's tip, or a work branch between rounds (its workspace given back).
      const tip = wt?.tip ?? (wt?.commits ? `refs/heads/${wt.branch}` : undefined);
      if (wt && !existsSync(wt.path) && tip && base) {
        const shown = git(base, ["show", `${tip}:${path}`]);
        if (shown.ok) return { lines: shown.stdout.split(/\r?\n/), from: "branch", space, path };
      }
      if (!base) continue;
      const full = resolvePath(base, path);
      if (!full.startsWith(resolvePath(base) + sep) || !existsSync(full) || statSync(full).isDirectory()) continue;
      if (statSync(full).size > 2 * 1024 * 1024) throw new HttpError(413, "文件太大");
      return { lines: readFileSync(full, "utf8").split(/\r?\n/), from: wt && existsSync(wt.path) ? "worktree" : "repo", space, path };
    }
    const { materialSpaces } = await import("../items/materials.ts");
    const readable = [...(input.readSpaces ?? []), ...(input.itemId ? materialSpaces(app, input.itemId, who(req)) : [])].filter((s) => !allowed || allowed.includes(s));
    for (const space of readable) {
      const path = o.path.startsWith(`${space}/`) ? o.path.slice(space.length + 1) : o.path;
      const s = one<{ id: string }>(app.db, "select id from sources where space_id = ? and uri = ? and deleted_at is null", space, path);
      if (s) return { lines: readSource(app, s.id).text.split(/\r?\n/), from: "source", space, path, sourceId: s.id };
    }
    throw new HttpError(404, `找不到文件 ${o.path}`);
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

  // -------------------------------------------------------------------- asks
  // Questions, suggested next steps and approvals from agents (agents/asks.ts).
  server.get("/api/asks", async (req) => {
    const { listAsks } = await import("../agents/asks.ts");
    const qs = req.query as { conversation?: string; status?: "pending" | "answered" | "cancelled" };
    return listAsks(app, { conversationId: qs.conversation, status: qs.status, userId: who(req), limit: 100 });
  });
  server.get("/api/asks/:id", async (req) => {
    const { getAsk } = await import("../agents/asks.ts");
    const a = getAsk(app, (req.params as { id: string }).id);
    if (a.userId !== who(req)) throw new HttpError(404, "没有这个提问");
    return a;
  });
  server.post("/api/asks/:id/answer", async (req) => {
    const { answerAsk, getAsk } = await import("../agents/asks.ts");
    const id = (req.params as { id: string }).id;
    if (getAsk(app, id).userId !== who(req)) throw new HttpError(404, "没有这个提问");
    const b = q(z.object({ choice: z.number().int().min(0).nullable().optional(), text: z.string().optional(), approved: z.boolean().optional() }), req.body);
    return answerAsk(app, id, { ...b, by: who(req) });
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
  // Archive settings are owner-only, like task rules; members cannot reach these routes.
  server.get("/api/archive-rules", async () => (await import("../sources/archive.ts")).listArchiveRules(app));
  server.get("/api/archive-options", async () => {
    const { ARCHIVE_FIELDS, ARCHIVE_FIELD_HELP, ARCHIVE_KINDS, ARCHIVE_CHANNELS } = await import("../sources/archive.ts");
    return { fields: ARCHIVE_FIELDS, descriptions: ARCHIVE_FIELD_HELP, valueOptions: Object.fromEntries(Object.entries({ kind: ARCHIVE_KINDS, channel: ARCHIVE_CHANNELS }).map(([field, values]) => [field, Object.entries(values).map(([value, label]) => ({ value, label }))])), ops: ["equals", "contains", "startsWith", "endsWith", "in"] };
  });
  server.post("/api/archive-rules", async req => (await import("../sources/archive.ts")).saveArchiveRule(app, req.body));
  server.put("/api/archive-rules/order", async req => (await import("../sources/archive.ts")).orderArchiveRules(app, q(z.object({ ids: z.array(z.string()).max(500) }), req.body).ids));
  server.put("/api/archive-rules/:id", async req => (await import("../sources/archive.ts")).saveArchiveRule(app, req.body, (req.params as { id: string }).id));
  server.delete("/api/archive-rules/:id", async req => {
    run(app.db, "delete from archive_rules where id=?", (req.params as { id: string }).id);
    return { ok: true };
  });
  server.post("/api/archive-rules/draft", async req => {
    const b = q(z.object({ space: z.string(), description: z.string().min(1).max(2000), current: z.record(z.string(), z.unknown()).optional() }), req.body);
    getSpace(app, b.space);
    return createRun(app, { kind: "archive-rule-draft", spaceId: b.space, title: "编写归档规则", input: b, userId: who(req) });
  });
  server.get("/api/archive/folders", async () => (await import("../channels/lark-docs.ts")).refreshProgress(app));
  server.post("/api/archive/folders", async req => {
    const b = q(z.object({ space: z.string() }), req.body);
    getSpace(app, b.space);
    return (await import("../channels/lark-docs.ts")).refreshInBackground(app, { space: b.space, metadataOnly: true });
  });
  server.post("/api/archive/preview", async req => {
    const b = q(z.object({ space: z.string(), limit: z.number().int().min(1).max(200).default(100), offset: z.number().int().min(0).default(0) }), req.body);
    return (await import("../sources/archive.ts")).previewArchive(app, b.space, b.limit, b.offset);
  });
  server.post("/api/archive/apply", async req => {
    const b = q(z.object({ space: z.string(), entries: z.array(z.object({ id: z.string(), hash: z.string(), ruleId: z.string(), ruleVersion: z.string(), target: z.string() })).max(200) }), req.body);
    return (await import("../sources/archive.ts")).applyArchivePreview(app, b.space, b.entries);
  });
  server.post("/api/archive/classify", async req => {
    const b = q(z.object({ space: z.string(), ids: z.array(z.string()).min(1).max(100) }), req.body);
    const { sourceRoute, queueArchive, RECHECK } = await import("../sources/archive.ts");
    // Explicit historical review: scope and validate the whole batch before queueing it.
    for (const id of b.ids) {
      const s = getSource(app, id);
      if (s.spaceId !== b.space || s.deletedAt || ["code", "conversation", "activity", "work"].includes(s.kind)) throw new HttpError(400, "请选择当前空间的可归档原件");
      if (["manual", "binding"].includes(sourceRoute(app, id)?.mode ?? "")) throw new HttpError(409, "已指定归属的材料不能由 AI 改动");
    }
    for (const id of b.ids) {
      run(app.db, "insert into source_routes(source_id,origin_space,mode,reason,pending) values(?,?,'fallback',?,1) on conflict(source_id) do update set pending=1,decision_hash=null,mode='fallback',reason=excluded.reason", id, b.space, RECHECK);
      queueArchive(app, id);
    }
    return { queued: b.ids.length };
  });
  server.get("/api/sources/:id/archive", async req => {
    const id = (req.params as { id: string }).id;
    getSource(app, id);
    const { sourceRoute, archiveHistory } = await import("../sources/archive.ts");
    return { route: sourceRoute(app, id), history: archiveHistory(app, id) };
  });
  server.post("/api/sources/:id/move", async req => {
    const b = q(z.object({ space: z.string(), hash: z.string(), reason: z.string().min(1).max(500) }), req.body);
    return (await import("../sources/archive.ts")).moveSource(app, (req.params as { id: string }).id, b.space, b.reason, "manual", undefined, b.hash);
  });

  // ------------------------------------------------------------------- rules
  server.get("/api/rules", async (req) => {
    const o = q(z.object({ space: z.string().optional() }), req.query);
    const { listRules } = await import("../rules/store.ts");
    const { describe } = await import("../rules/conditions.ts");
    // Temporary wake-up rules are listed with the timed wakes (/api/wakes).
    return listRules(app).filter((r) => !r.temporary && (!o.space || !r.spaceId || r.spaceId === o.space)).map((r) => ({ ...r, conditionText: describe(r.conditions) }));
  });
  // Wake-ups agents set for themselves: timed (queued runs) and on a message (temporary rules).
  server.get("/api/wakes", async () => (await import("../agents/wakes.ts")).pendingWakes(app));
  // Groups being watched (set_chat_watch): listed with the wake-ups, can be stopped.
  server.get("/api/watches", async (req) => (who(req) === OWNER ? (await import("../channels/lark-watch.ts")).listWatches(app) : []));
  server.delete("/api/watches/:chatId", async (req) => {
    if (who(req) !== OWNER) throw new HttpError(403, "只有本人可以取消盯群");
    (await import("../channels/lark-watch.ts")).setWatchRule(app, (req.params as { chatId: string }).chatId, null);
    return { ok: true };
  });
  server.delete("/api/wakes/:id", async (req) => {
    (await import("../agents/wakes.ts")).cancelWake(app, (req.params as { id: string }).id);
    return { ok: true };
  });
  server.get("/api/rules/:id", async (req) => {
    const id = (req.params as { id: string }).id;
    const { getRule, listFirings } = await import("../rules/store.ts");
    const { describe } = await import("../rules/conditions.ts");
    const r = getRule(app, id);
    return { ...r, conditionText: describe(r.conditions), firings: listFirings(app, id) };
  });
  // What a rule needs from Feishu (meetings: lark-cli and bot permissions), with links to fix the gaps.
  server.get("/api/rules/:id/permissions", async (req) => {
    const { getRule } = await import("../rules/store.ts");
    return (await import("../rules/permissions.ts")).rulePermissions(app, getRule(app, (req.params as { id: string }).id));
  });
  server.post("/api/rules", async (req) => (await import("../rules/store.ts")).saveRule(app, req.body as never, "user"));
  server.put("/api/rules/:id", async (req) => (await import("../rules/store.ts")).saveRule(app, { ...(req.body as object), id: (req.params as { id: string }).id } as never, "user"));
  server.delete("/api/rules/:id", async (req) => {
    (await import("../rules/store.ts")).deleteRule(app, (req.params as { id: string }).id);
    return { ok: true };
  });
  // The model writes a rule from the owner's words (nothing is saved); the page shows it to edit.
  server.post("/api/rules/draft", async (req) => {
    const b = q(z.object({ description: z.string().min(1), current: z.record(z.string(), z.unknown()).optional() }), req.body);
    return (await import("../rules/compile.ts")).draftRule(app, b.description, b.current as never);
  });
  // Try a rule on recent captured messages without firing anything.
  server.post("/api/rules/test", async (req) => {
    const b = q(z.object({ rule: z.record(z.string(), z.unknown()), chatId: z.string().optional(), days: z.number().optional(), ai: z.boolean().optional() }), req.body);
    return (await import("../rules/engine.ts")).testRule(app, b.rule as never, { chatId: b.chatId, days: b.days, ai: b.ai });
  });
  server.get("/api/rule-options", async () => {
    const { FIELDS, OPS, EVENT_FIELDS } = await import("../rules/types.ts");
    const { larkBotInfo } = await import("../channels/lark-send.ts");
    const { ruleGroups } = await import("../rules/destinations.ts");
    return {
      fields: FIELDS,
      ops: OPS,
      eventFields: EVENT_FIELDS,
      // omem's bots a meeting rule can bring in ("main" and lark.bots).
      bots: [
        ...(app.config.lark.appId ? [{ id: "main", name: one<{ value: string }>(app.db, "select value from kv where key = 'lark_bot_name'")?.value ?? larkBotInfo("main")?.name ?? "主机器人" }] : []),
        ...app.config.lark.bots.filter((b) => b.enabled).map((b) => ({ id: b.id, name: larkBotInfo(b.id)?.name ?? b.id })),
      ],
      specs: [{ name: "assistant", description: "主助手：未指定专用档案的日常任务" }, ...listAgentSpecs(app).map((s) => ({ name: s.name, description: s.description }))],
      chats: all<{ chat_id: string; name: string }>(app.db, "select chat_id, name from lark_cursors where chat_id like 'oc_%' and name != '' order by updated_at desc limit 300"),
      conversations: all(app.db, "select id,title,channel,space_id,external_id from conversations where user_id = ? order by updated_at desc limit 300", OWNER),
      botReady: !!app.config.lark.appId,
      groups: ruleGroups(app),
    };
  });
  server.post("/api/rule-conversations", async (req) => {
    const { chatId } = q(z.object({ chatId: z.string().min(1) }), req.body);
    return (await import("../rules/destinations.ts")).ruleGroupConversation(app, chatId);
  });
  server.get("/api/notify-ignore-rules", async () => ({ rules: listIgnoreRules(app) }));
  server.post("/api/notify-ignore-rules/delete", async (req) => {
    const id = (req.body as { id?: string } | null)?.id;
    if (id) deleteIgnoreRule(app, id);
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
  // History before the first read, a few pages per poll into monthly archive sources.
  server.post("/api/lark/chats/:id/backfill", async (req) => {
    const { requestBackfill } = await import("../channels/lark-personal.ts");
    const b = q(z.object({ days: z.number().int().min(0).max(3650), ingest: z.boolean().default(false) }), req.body);
    return requestBackfill(app, (req.params as { id: string }).id, b.days, b.ingest);
  });
  // Images and files of saved messages that were never downloaded.
  server.post("/api/lark/fill-files", async (req) => {
    const { fillResourcesInBackground } = await import("../channels/lark-messages.ts");
    const b = q(z.object({ chatIds: z.array(z.string()).max(500).optional() }), req.body ?? {});
    return fillResourcesInBackground(app, b.chatIds);
  });
  server.get("/api/lark/fill-files", async () => (await import("../channels/lark-messages.ts")).fillResourcesStatus());
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
  // What the owner's lark-cli login lacks for reading knowledge bases and writing docs; POST starts a login for it.
  server.get("/api/lark/user-permissions", async () => {
    const { missingUserScopes, cliUser } = await import("../channels/lark-auth.ts");
    return { user: await cliUser(), ...(await missingUserScopes(["wiki-read", "doc-write"])) };
  });
  server.post("/api/lark/user-permissions", async (req) => {
    const { missingUserScopes, requestUserScopes } = await import("../channels/lark-auth.ts");
    const b = q(z.object({ scopes: z.array(z.string().regex(/^[a-z:._]+$/)).max(30).optional() }), req.body ?? {});
    const scopes = b.scopes ?? (await missingUserScopes(["wiki-read", "doc-write"])).missing.map((m) => m.anyOf[0]);
    if (!scopes.length) return { url: null };
    return requestUserScopes(app, scopes, "在设置页补齐授权：");
  });
  // Knowledge-base crawls (lark-wiki.ts): progress, continue, stop.
  server.get("/api/lark/wiki-crawls", async () => ({ crawls: (await import("../channels/lark-wiki.ts")).listCrawls(app) }));
  server.post("/api/lark/wiki-crawls/:id/:op", async (req) => {
    const w = await import("../channels/lark-wiki.ts");
    const { id, op } = req.params as { id: string; op: string };
    if (op === "stop") return w.stopCrawl(app, id);
    if (op === "continue") return w.continueCrawl(app, id);
    throw new HttpError(400, "未知操作");
  });

  server.post("/api/agents/:id/probe", async (req) => {
    const { allProfiles } = await import("../core/config.ts");
    const { probeProfile, saveProbe } = await import("../agents/probe.ts");
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
  // ------------------------------------------------------------------- peers
  // Diagnostics and a fixed set of commands for other devices (owner only), a consistent
  // snapshot for `omem peer pull`, and forwarding to peers this instance can reach.
  server.get("/api/diag", async () => (await import("../core/peer-exec.ts")).diag(app));
  // Disk usage of the data directory (settings → 占用); the scan runs in a child process.
  server.get("/api/storage", async (req) => {
    if (who(req) !== OWNER) throw new HttpError(403, "只有本人能查看占用");
    return (await import("../core/storage.ts")).storageStatus(app);
  });
  server.post("/api/storage/scan", async (req) => {
    if (who(req) !== OWNER) throw new HttpError(403, "只有本人能查看占用");
    const m = await import("../core/storage.ts");
    void m.startStorageScan(app);
    return m.storageStatus(app);
  });
  server.get("/api/peer/commands", async () => {
    const { peerCommands } = await import("../core/peer-exec.ts");
    return Object.fromEntries(Object.entries(peerCommands).map(([k, c]) => [k, c.description]));
  });
  server.post("/api/peer/exec", async (req) => {
    const b = q(z.object({ command: z.string(), args: z.unknown().optional() }), req.body);
    const { runPeerCommand } = await import("../core/peer-exec.ts");
    return { node: (await import("../core/peers.ts")).nodeId(app), result: await runPeerCommand(app, b.command, b.args) };
  });
  // One omem tool call from another device's Agent, as the owner with the tool set `omem mcp`
  // gives minus everything that acts outward (agents/peer-agent.ts); recorded in a run per session.
  const peerScope = z.object({
    caller: z.string().max(80).optional(),
    space: z.string().max(200).optional(),
    spaces: z.array(z.string().max(200)).max(100).optional(),
    readOnly: z.boolean().optional(),
    agent: z.string().max(80).optional(),
    model: z.string().max(120).optional(),
  });
  server.get("/api/peer/tools", async (req) => {
    if (who(req) !== OWNER) throw new HttpError(403, "只有本人能使用同伴的工具接口");
    const o = q(peerScope.extend({ spaces: z.string().optional(), readOnly: z.string().optional() }), req.query);
    const { peerTools } = await import("../agents/peer-agent.ts");
    return { node: (await import("../core/peers.ts")).nodeId(app), tools: peerTools(app, { ...o, spaces: o.spaces?.split(",").filter(Boolean), readOnly: o.readOnly === "1" || o.readOnly === "true" }) };
  });
  server.post("/api/peer/tool", async (req) => {
    if (who(req) !== OWNER) throw new HttpError(403, "只有本人能使用同伴的工具接口");
    const b = q(peerScope.extend({ session: z.string().min(1).max(80), name: z.string().max(80), args: z.unknown().optional() }), req.body);
    const { peerToolCall } = await import("../agents/peer-agent.ts");
    const { name, args, ...scope } = b;
    return { node: (await import("../core/peers.ts")).nodeId(app), ...(await peerToolCall(app, scope, name, args)) };
  });
  server.get("/api/peer/snapshot", async (req, reply) => {
    if (who(req) !== OWNER) throw new HttpError(403, "只有本人能拉取设备快照");
    const { snapshotStream } = await import("../core/pull.ts");
    reply.type("application/x-tar");
    return reply.send(await snapshotStream(app));
  });
  server.get("/api/peers", async () => {
    const { listPeers, nodeId } = await import("../core/peers.ts");
    return { node: nodeId(app), peers: listPeers(app).map((p) => ({ id: p.id, url: p.url, via: p.via ?? null, addedAt: p.addedAt })) };
  });
  server.all("/api/peers/:id/*", async (req, reply) => {
    const { peerFetch } = await import("../core/peers.ts");
    const hops = Number(req.headers["x-omem-hops"] ?? 0);
    if (hops > 3) throw new HttpError(508, "同伴转发层数过多");
    const { id } = req.params as { id: string };
    const rest = req.url.slice(`/api/peers/${encodeURIComponent(id)}`.length) || "/";
    // The web UI's own files (GET) are forwarded too, so `omem peer open` can show a peer's
    // UI through a middle node; anything that changes state must be an API call.
    if (!rest.startsWith("/api/") && req.method !== "GET" && req.method !== "HEAD") throw new HttpError(400, "只能转发 /api/ 下的请求和网页文件");
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {});
    const headers: Record<string, string> = body ? { "content-type": "application/json" } : {};
    for (const h of ["accept", "if-none-match", "if-modified-since"]) {
      const v = req.headers[h];
      if (typeof v === "string") headers[h] = v;
    }
    const res = await peerFetch(app, id, rest, { method: req.method, body, headers, timeoutMs: 15 * 60_000 }, hops + 1);
    reply.status(res.status);
    const type = res.headers.get("content-type");
    if (type) reply.type(type);
    // Keep the peer's caching headers so the browser behind `omem peer open` can cache its UI.
    for (const h of ["cache-control", "etag", "last-modified"]) {
      const v = res.headers.get(h);
      if (v) reply.header(h, v);
    }
    return reply.send(res.body ? (await import("node:stream")).Readable.fromWeb(res.body as never) : "");
  });

  server.get("/api/settings", async () => ({ config: app.config, agents: listAgentProfiles(app), home: app.home }));
  server.put("/api/settings", async (req) => {
    const next = configSchema.parse({ ...app.config, ...(req.body as object) });
    // Everything else is read on use; these are only read when the service starts.
    const atStartup: [string, (c: typeof next) => unknown][] = [
      ["监听地址和端口", (c) => [c.host, c.port]],
      ["向量检索", (c) => c.embeddings],
      ["飞书机器人的开关和应用", (c) => [c.lark.enabled, c.lark.appId, c.lark.appSecretEnv, c.lark.bots.map((b) => [b.id, b.appId, b.enabled])]],
      ["Telegram", (c) => c.telegram],
      ["QQ / 微信（OneBot）", (c) => c.onebot],
    ];
    const restart = atStartup.filter(([, pick]) => JSON.stringify(pick(app.config)) !== JSON.stringify(pick(next))).map(([label]) => label);
    saveConfig(next, app.home);
    Object.assign(app.config, next);
    return { config: app.config, restart };
  });

  // ---------------------------------------------------------------- plugins
  registerPluginRoutes(server, app, who);

  // -------------------------------------------------------------------- web
  const dist = webDist();
  if (dist) {
    // Built assets carry a content hash in their name and never change; index.html must be
    // revalidated so a new build is picked up. Matters most through `omem peer open`, where
    // every revalidation crosses the network.
    await server.register(fastifyStatic, {
      root: dist,
      prefix: "/",
      cacheControl: false,
      setHeaders: (res, path) => res.setHeader("cache-control", /[\\/]assets[\\/]/.test(path) ? "public, max-age=31536000, immutable" : "no-cache"),
    });
    server.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/")) return reply.status(404).send({ error: "not found" });
      return reply.sendFile("index.html");
    });
  }

  const configured = opts.host ?? app.config.host;
  // "localhost" can resolve to ::1 only; listen on 127.0.0.1 so local clients always reach it.
  const host = configured === "localhost" ? "127.0.0.1" : configured;
  const address = await server.listen({ port: opts.port ?? app.config.port, host });
  const url = new URL(address);
  app.baseUrl = `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${url.port}`;
  if (!opts.quiet) console.log(`omem 已启动：${app.baseUrl}${dist ? "" : "（未找到网页构建产物，仅 API）"}`);
  return server;
}

/** A material as the item page lists it; runs carry their kind, status and review verdict. */
function materialForPage(app: App) {
  return (m: MaterialView) => {
    if (m.kind !== "run" || !m.readable || m.missing) return m;
    const r = one<{ kind: string; status: string; output: string; input: string; created_at: string }>(app.db, "select kind, status, output, input, created_at from runs where id = ?", m.ref);
    if (!r) return m;
    // A delegation that went several rounds reads as its latest round.
    const first = JSON.parse(r.output) as { codeChain?: { rounds: string[] } };
    const lastId = first.codeChain?.rounds.at(-1);
    const last = lastId && lastId !== m.ref ? one<{ status: string; output: string }>(app.db, "select status, output from runs where id = ?", lastId) : null;
    const out = (last ? JSON.parse(last.output) : first) as { verdict?: string; reviewLead?: { verdict: string; summary: string } };
    return { ...m, run: { kind: r.kind, status: last?.status ?? r.status, verdict: out.verdict ?? null, summary: out.reviewLead?.summary ?? null, branchReview: !!(JSON.parse(r.input) as { branches?: unknown }).branches, createdAt: r.created_at } };
  };
}

/**
 * Where a run sits: the conversation it answers in (and whether that is a Feishu topic or a work
 * session of a multi-agent task), the run that started it, and the rounds of the work it is part of.
 */
function runContext(app: App, r: ReturnType<typeof getRun>) {
  const input = r.input as { conversationId?: string; threadId?: string; agentWorkId?: string; sourceRunId?: string };
  const convId = input.conversationId ?? input.threadId ?? null;
  const conv = convId
    ? one<{ id: string; title: string; channel: string; external_id: string | null; parent_id: string | null; status: string }>(app.db, "select id, title, channel, external_id, parent_id, status from conversations where id = ?", convId)
    : undefined;
  const brief = (id: string | null | undefined) =>
    id ? one<{ id: string; kind: string; title: string; status: string; created_at: string }>(app.db, "select id, kind, title, status, created_at from runs where id = ?", id) : undefined;
  const parent = brief(r.parentId);
  const workId = input.agentWorkId ?? ((r.output as { agentWork?: { askRunId?: string } }).agentWork?.askRunId === r.id ? r.id : undefined);
  const work = workId ? (getRun(app, workId).output as { agentWork?: { title: string; workConversationId: string; rootConversationId: string; rounds: { runId: string; agent: string }[] } }).agentWork : undefined;
  const conversation = conv
    ? {
        id: conv.id,
        title: conv.title,
        channel: conv.channel,
        topic: !!conv.external_id?.includes("#"),
        work: !!work && work.workConversationId === conv.id,
        parentId: conv.parent_id,
        parentTitle: conv.parent_id ? one<{ title: string }>(app.db, "select title from conversations where id = ?", conv.parent_id)?.title ?? null : null,
        // Other turns in the same conversation: one line of work in Feishu is one conversation here.
        turns: all<{ id: string; title: string; status: string; created_at: string }>(
          app.db,
          "select id, title, status, created_at from runs where kind = 'ask' and json_extract(input,'$.conversationId') = ? order by created_at",
          conv.id,
        ).map((x) => ({ id: x.id, title: x.title, status: x.status, createdAt: x.created_at })),
      }
    : null;
  // The items this work was done for: later rounds and re-reviews belong to the first round's items.
  const root = (r.input as { continueFrom?: string; codeRunId?: string }).continueFrom ?? (r.input as { codeRunId?: string }).codeRunId ?? r.id;
  const own = (r.input as { itemId?: string }).itemId;
  const itemIds = [...new Set([...(own ? [own] : []), ...itemsOfRun(app, root).map((i) => i.id), ...itemsOfRun(app, r.id).map((i) => i.id)])];
  return {
    conversation,
    items: itemIds.flatMap((id) => one<{ id: string; title: string; status: string }>(app.db, "select id, title, status from items where id = ?", id) ?? []),
    parent: parent ? { id: parent.id, kind: parent.kind, title: parent.title, status: parent.status } : null,
    source: input.sourceRunId ? brief(input.sourceRunId) ?? null : null,
    work: work
      ? {
          id: workId,
          title: work.title,
          rounds: work.rounds.map((x) => {
            const b = brief(x.runId);
            return { runId: x.runId, agent: x.agent, kind: b?.kind ?? "agent", status: b?.status ?? "queued", title: b?.title ?? "" };
          }),
        }
      : null,
  };
}
