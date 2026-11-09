import { generateWiki } from "../wiki/generate.ts";
import { presentHits } from "../search/present.ts";
import { spawnSync } from "node:child_process";
import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { symbolRelations } from "../sources/callgraph.ts";
import { deleteSkillFile, listSkillFiles, readSkillFile, saveSkillFile, DEFAULT_SPEC_TOOLS, deleteAgentSpec, deleteSkill, listAgentSpecs, listSkills, readAgentSpec, readRaw, readSkill, saveAgentSpec, saveRaw, saveSkill } from "../agents/specs.ts";
import { customizeRole, isBuiltinRole, listRoleStates, mergeRole, resetRole, saveRoleOverride, setRoleFullAccess } from "../agents/builtin-roles.ts";
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
import { IDE_BASE, IdeNotReady, attachIdeUpgrade, ensureIdeWeb, ideCli, ideFolder, newIdeSession, proxyIde, stopIdeWeb } from "./ide-web.ts";
import { attachRemoteUpgrade, closeRemote, registerRemoteRoutes } from "../remote/http.ts";
import { attachPreviewUpgrade, registerPreviewRoutes } from "./preview-http.ts";
import { registerArtifactRoutes } from "./artifact-http.ts";
import { actCodeGit, codeGitActionSchema, readCodeGit } from "../agents/code-git.ts";
import { branchIndexes, dropWorktreeSpace, indexBranch } from "../agents/worktree-index.ts";
import {
  addSourceNote, applyAttentionRulesToExisting, deleteAttentionRule, LEVEL_LABELS, LEVELS, levelCounts, levelOf, listAttentionRules, NOTE_KINDS, removeSourceNote,
  saveAttentionRule, selectSources, setAttention, setNodeLevel, sourceFilter, sourceNotes, reviewQueue, reviewSourceNote, reviewNodeLevel,
} from "../sources/attention.ts";
import { defaultBaseRef, fetchBranch, git, isGitRepo, listBranches } from "../core/git.ts";
import { cloneRepository } from "../core/repositories.ts";
import { ask, conversationMessages, scheduleIngest, scheduleSpaceSync, stalePages, type PageBrief } from "../agents/jobs.ts";
import { createMcpServer } from "../agents/mcp-server.ts";
import { listAgentProfiles, loadRole, profileFor, resolveRunProfile } from "../agents/runner.ts";
import type { RoleName } from "../core/config.ts";
import { addRunEvent, cancelRun, countRuns, createRun, getRun, listRuns, queueReason, runEvents } from "../agents/runs.ts";
import { callTool, mcpTools, toolContextForToken, toolList } from "../agents/tools.ts";
import type { App, AppEvent } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { allProfiles, configSchema, saveConfig } from "../core/config.ts";
import { listNotifications, markRead } from "../core/notify.ts";
import { deleteIgnoreRule, listIgnoreRules } from "../core/notify-lessons.ts";
import { listSchedules, nextRuns, scheduleLabels, triggerSchedule, upsertSchedule } from "../core/scheduler.ts";
import { businessOf, createSpace, findSpace, getSpace, listSpaces, relatedSpaces, relateSpaces, setSpaceParent, spaceFamily, unrelateSpaces, updateSpace } from "../core/spaces.ts";
import { HttpError, slugify } from "../core/util.ts";
import { trustedLocal } from "./origin.ts";
import { AUTH_LIMITED, AUTH_PUBLIC, bearerToken, registerAuthRoutes, resolveAuth, type RequestAuth } from "../auth/http.ts";
import { externalCaller, externalToolBackend } from "../auth/external-tools.ts";
import { checkBearer } from "../auth/authenticators.ts";
import { checkRoute } from "../auth/routes.ts";
import { hitFilter, setVisibility, sourceVisible, viewersOf, visibleHits } from "../auth/visibility.ts";
import { registerFederationRoutes } from "../core/federation-http.ts";
import { can, canReadRun, globalPerms, runReadableSpaces, spacesWith } from "../auth/permissions.ts";
import { ACP_PATH, closeAcpServing, serveAcp, toolRelay } from "../core/peer-acp.ts";
import { listShares, readShare, revokeShare } from "../core/shares.ts";
import { accessibleSpaces, addMember, canWrite, findUser, getUser, OWNER, scopeFor, userForToken, userName } from "../core/users.ts";
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
import { rerankStatus } from "../search/rerank.ts";
import { searchRun } from "../search/trace.ts";
import { closeReadProcess } from "../search/read-process.ts";
import { importFile, importText, importUrl } from "../sources/import.ts";
import { deleteSource, getSource, listSourcePaths, listSources, readSource, sourceOutline } from "../sources/store.ts";
import { deletePage, listPages, movePages, pageContext, pageVersion, readPage, spaceGuide, staleDetail, syncWiki, wikiNav, writePage, writeSpaceGuide } from "../wiki/store.ts";
import { upkeepStatus } from "../wiki/upkeep.ts";
import { CATEGORY_KINDS, categoryStatus, inheritedKeyVars, keyHint, keyOf, MODEL_CACHE_MS, type ModelField, modelChoices, readKeys, readModelCache, refreshModels, setKey, testProvider } from "../core/ai-keys.ts";

/** GET /api/share/<token>: exactly this, no query, no other path under it. */
const SHARE_ROUTE = /^\/api\/share\/[A-Za-z0-9_-]{43}$/;

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

const bearer = bearerToken;
/** `METHOD /path` of every /api route registered so far. */
export const registeredRoutes = new Set<string>();

export async function startServer(app: App, opts: { port?: number; host?: string; quiet?: boolean } = {}) {
  const server = Fastify({ logger: false, bodyLimit: 50 * 1024 * 1024 });
  // Every API route, for test/route-perms.test.ts: each must say what it needs (src/auth/routes.ts).
  server.addHook("onRoute", (r) => {
    if (r.url.startsWith("/api/")) for (const m of [r.method].flat()) registeredRoutes.add(`${m} ${r.url}`);
  });
  await server.register(fastifyCompress, { encodings: ["gzip"], threshold: 1024, globalDecompression: false });
  server.addHook("onClose", async () => {
    closeReadProcess(app);
    const { releaseBackgroundSessions } = await import("../agents/background-sessions.ts");
    await releaseBackgroundSessions(app);
    const { stopSessionCleanup } = await import("../agents/session-cleanup.ts");
    await stopSessionCleanup(app);
  });
  await server.register(fastifyMultipart, { limits: { fileSize: 200 * 1024 * 1024 } });

  server.setErrorHandler((error: Error & { statusCode?: number; status?: number }, _req, reply) => {
    const status = error instanceof HttpError ? error.status : (error.statusCode ?? 500);
    if (status >= 500) console.error(error);
    reply.status(status).send({ error: error.message });
  });

  // API auth (src/auth/http.ts): a token, a login session, or this machine (the owner, unless a
  // token is configured). What each route needs is in src/auth/routes.ts, checked once the body is
  // parsed (some rules find the space in it).
  server.decorateRequest("userId", "owner");
  server.addHook("onRequest", async (req, reply) => {
    // Tool routes check their own (per-run) token.
    if (!req.url.startsWith("/api/") || /^\/api\/tools(\/|\?|$)/.test(req.url)) return;
    // A credential omem did not issue: an authenticator plugin checks it first (src/auth/authenticators.ts).
    await checkBearer(app, bearerToken(req));
    // The one read without a token: a share link (core/shares.ts) carries its own, and the route
    // returns only the snapshot that share holds.
    if (req.method === "GET" && SHARE_ROUTE.test(req.url)) return;
    // A run artifact's file: its URL carries its key (a report page's own files come without a cookie).
    if ((req.method === "GET" || req.method === "HEAD") && /^\/api\/artifacts\/[a-z0-9]+\.[\w-]+\//.test(req.url)) return;
    // Logging in has to work before there is anyone; those routes look themselves.
    if (AUTH_PUBLIC.test(req.url)) return;
    const auth = resolveAuth(app, req);
    if (!auth) return void reply.status(401).send({ error: app.config.auth.enabled ? "请先登录" : "需要访问令牌", login: app.config.auth.enabled });
    const r = req as FastifyRequest & { userId: string; auth: RequestAuth };
    r.userId = auth.userId;
    r.auth = auth;
    const u = findUser(app, auth.userId);
    if ((u?.status === "pending" || auth.restricted) && !AUTH_LIMITED.test(req.url))
      return void reply.status(403).send({ error: u?.status === "pending" ? "账号还在等 omem 的主人批准" : "请先绑定主要登录方", code: u?.status === "pending" ? "pending" : "restricted" });
  });
  server.addHook("preHandler", async (req) => {
    const r = req as FastifyRequest & { auth?: RequestAuth; userId: string };
    if (!r.auth || !req.url.startsWith("/api/")) return;
    await checkRoute(app, req, r.userId);
  });
  const who = (req: FastifyRequest) => (req as FastifyRequest & { userId?: string }).userId ?? OWNER;
  const authOf = (req: FastifyRequest) => (req as FastifyRequest & { auth?: RequestAuth }).auth ?? null;
  registerAuthRoutes(server, app, who, authOf);
  registerFederationRoutes(server, app, who);

  // ------------------------------------------------------------------- shares
  server.get("/api/share/:token", async (req, reply) => {
    reply.header("cache-control", "no-store").header("x-robots-tag", "noindex").header("referrer-policy", "no-referrer");
    const share = readShare(app, (req.params as { token: string }).token);
    if (!share) return reply.status(404).send({ error: "这个分享链接无效、已撤销或已过期" });
    return share;
  });
  server.get("/api/shares", async (req) => ({ shares: listShares(app, who(req)), webUrl: !!app.config.webUrl?.trim(), expiryDays: app.config.shares.expiryDays }));
  server.delete("/api/shares/:id", async (req) => {
    revokeShare(app, (req.params as { id: string }).id, who(req));
    return { ok: true };
  });
  server.get("/api/me", async (req) => {
    const u = getUser(app, who(req));
    // What the page may offer: global permissions, and the spaces this person writes or manages.
    return { ...u, spaces: accessibleSpaces(app, u.id), perms: globalPerms(app, u.id), writes: spacesWith(app, u.id, "memory.write"), wiki: spacesWith(app, u.id, "wiki.write"), manages: spacesWith(app, u.id, "space.manage"), via: authOf(req)?.via ?? "local", restricted: !!authOf(req)?.restricted };
  });

  // ---------------------------------------------------------------- tools/MCP
  // A run's token, or a stand-in for another device's tools (its agent runs here, core/peer-acp.ts).
  const toolBackend = async (req: FastifyRequest) => {
    const relay = toolRelay(bearer(req));
    if (relay) return relay;
    const ctx = toolContextForToken(app, bearer(req));
    if (!ctx) {
      // Someone's own Agent on their own computer, with their credential (docs/v2/remote-clients.md).
      await checkBearer(app, bearer(req));
      const caller = externalCaller(app, req);
      if (caller) return externalToolBackend(app, caller);
      if (!bearer(req).startsWith("ot_")) throw new HttpError(401, bearer(req) ? "凭据无效或已过期（API 令牌被撤销，或 JWT 过期、没有对应的鉴权插件）" : "需要凭据：Authorization: Bearer <令牌>");
      // Tokens live in memory: an agent session kept across a restart still holds the old one.
      console.warn(`[omem] 工具调用被拒：令牌无效（${req.method} ${req.url}；常见于服务重启前开的 Agent 会话）`);
      throw new HttpError(401, "无效的工具令牌");
    }
    return { list: async () => mcpTools(ctx.tools), call: (name: string, args: unknown) => tracedCall(ctx, name, args) };
  };
  /**
   * Each call an agent makes from outside the process is recorded on its run when it arrives and
   * when it returns (`tool-call`), so a call the agent shows as hanging can be told apart: never
   * reached omem (no start), stuck in omem (start, no end), or slow to get back (both, short).
   */
  const tracedCall = async (ctx: NonNullable<ReturnType<typeof toolContextForToken>>, name: string, args: unknown) => {
    const label = name === "omem_call" ? `omem_call → ${String((args as { tool?: unknown } | null)?.tool ?? "")}` : name;
    const runId = ctx.runId && one(app.db, "select 1 from runs where id = ?", ctx.runId) ? ctx.runId : null;
    const started = Date.now();
    if (runId) addRunEvent(app, runId, "tool-call", { name: label, phase: "start" });
    let ok = false;
    try {
      const r = await searchRun.run(runId ?? "", () => callTool(ctx, name, args));
      ok = !r.isError;
      return r;
    } finally {
      const ms = Date.now() - started;
      if (runId) addRunEvent(app, runId, "tool-call", { name: label, phase: "end", ms, ok });
      if (ms > 60_000) console.warn(`[omem] 工具 ${label} 用了 ${Math.round(ms / 1000)} 秒${runId ? `（运行 ${runId}）` : ""}`);
    }
  };
  server.get("/api/tools", async (req) => ({ tools: await (await toolBackend(req)).list() }));
  server.post("/api/tools/:name", async (req) => (await toolBackend(req)).call((req.params as { name: string }).name, req.body));
  const mcp = async (req: FastifyRequest, reply: FastifyReply) => {
    const mcpServer = createMcpServer(await toolBackend(req));
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
  /**
   * What someone other than the owner hears of the live events: runs they may read, their own
   * notifications, asks and plugin sessions, changes in spaces they can read.
   */
  const eventFilter = (userId: string) => {
    if (userId === OWNER) return () => true;
    const runs = new Map<string, boolean>();
    const readable = (runId: string) => {
      if (!runs.has(runId)) runs.set(runId, canReadRun(app, userId, runId));
      return runs.get(runId)!;
    };
    return (e: AppEvent) => {
      if (e.type === "run" || e.type === "run-event") return readable(e.runId);
      if (e.type === "notification") return one<{ user_id: string }>(app.db, "select user_id from notifications where id = ?", e.id)?.user_id === userId;
      if (e.type === "ask") return one<{ user_id: string }>(app.db, "select user_id from asks where id = ?", e.id)?.user_id === userId;
      if (e.type === "plugin") return one<{ user_id: string }>(app.db, "select user_id from conversations where id = ?", e.conversationId)?.user_id === userId;
      if (e.type === "changed") {
        const space = e.spaceId ?? (e.entity === "space" ? e.id : null);
        return !space || (accessibleSpaces(app, userId) ?? []).includes(space);
      }
      return false;
    };
  };
  server.get("/api/events", async (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
    res.write(": connected\n\n");
    const runFilter = (req.query as { run?: string }).run;
    const shown = eventFilter(who(req));
    const listener = (e: AppEvent) => {
      if (runFilter && !("runId" in e && e.runId === runFilter)) return;
      if (!shown(e)) return;
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
  server.get("/api/spaces", async (req) => {
    const counts = new Map(all<{ space_id: string; n: number }>(app.db, "select space_id, count(*) n from sources where deleted_at is null group by space_id").map((r) => [r.space_id, r.n]));
    const pages = new Map(all<{ space_id: string; n: number }>(app.db, "select space_id, count(*) n from pages group by space_id").map((r) => [r.space_id, r.n]));
    const allowed = accessibleSpaces(app, who(req));
    return listSpaces(app)
      .filter((s) => allowed === null || allowed.includes(s.id))
      .map((s) => ({ ...s, sources: counts.get(s.id) ?? 0, pages: pages.get(s.id) ?? 0, related: relatedSpaces(app, s.id).filter((r) => allowed === null || allowed.includes(r.space)) }));
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
    const b = q(z.object({ id: z.string().optional(), name: z.string().trim().min(1), kind: z.enum(["personal", "project", "repo", "learning", "topic"]).optional(), description: z.string().optional(), rootPath: z.string().trim().optional(), parent: z.string().optional() }), req.body);
    // A repository added under a business space (its settings' 添加仓库): managing that space is what it takes.
    if (b.parent && !can(app, who(req), "space.manage", b.parent)) throw new HttpError(403, `不能管理空间 ${b.parent}`);
    // Both local directories and remote clones grant filesystem access on this machine.
    if (b.rootPath && !can(app, who(req), "code.delegate")) throw new HttpError(403, "关联仓库或本机目录要有交办编码的权限");
    if (b.kind === "personal" && who(req) !== OWNER) throw new HttpError(403, "个人空间由 omem 建");
    if (b.kind === "repo" && b.rootPath && /^(?:[a-z][a-z\d+.-]*:\/\/|[^/\\\s]+@[^/\\\s]+:|ext::)/i.test(b.rootPath)) {
      // Validate the space before doing network work; cloneRepository validates the transport.
      const id = slugify(b.id || b.name);
      if (id.startsWith("_")) throw new HttpError(400, "空间 id 不能以下划线开头（知识库保留给 Agent 档案和技能）");
      if (findSpace(app, id)) throw new HttpError(409, `空间已存在：${id}`);
      b.rootPath = await cloneRepository(app, b.rootPath);
      if (listSpaces(app).some((s) => s.rootPath === b.rootPath)) throw new HttpError(409, "这个仓库目录已关联空间，请使用已有空间");
    }
    const s = createSpace(app, { ...b, parentId: b.parent || null });
    // Whoever made it (other than the owner) manages it.
    if (who(req) !== OWNER) addMember(app, s.id, who(req), "manager");
    if (s.rootPath) scheduleSpaceSync(app, s.id);
    return s;
  });
  // A repository under a business space, or taken out of one (docs/v2/coding-work.md 第 4 节).
  server.post("/api/spaces/:id/parent", async (req) => {
    const id = (req.params as { id: string }).id;
    const b = q(z.object({ parent: z.string().nullable() }), req.body);
    if (b.parent && !can(app, who(req), "space.manage", b.parent)) throw new HttpError(403, `不能管理空间 ${b.parent}`);
    return setSpaceParent(app, id, b.parent || null);
  });
  server.get("/api/spaces/:id/repo-suggestions", async (req) => (await import("../core/space-repos.ts")).repoSuggestions(app, (req.params as { id: string }).id));
  server.get("/api/spaces/:id", async (req) => {
    const id = (req.params as { id: string }).id;
    return { ...getSpace(app, id), guide: spaceGuide(app, id) };
  });
  server.patch("/api/spaces/:id", async (req) => {
    const id = (req.params as { id: string }).id;
    const b = q(z.object({ name: z.string().optional(), description: z.string().optional(), settings: z.record(z.string(), z.unknown()).optional(), guide: z.string().optional() }), req.body);
    // A mirror is set up by subscribing (core/federation.ts); a space's manager who is not the owner
    // changes only who may read its Feishu documents (src/auth/visibility.ts).
    if (b.settings && "mirror" in b.settings) throw new HttpError(400, "镜像空间由关注其他服务的空间时设置");
    const extra = Object.keys(b.settings ?? {}).filter((k) => k !== "larkAccess");
    if (who(req) !== OWNER && extra.length) throw new HttpError(403, `只有 omem 的主人能改这些设置：${extra.join("、")}`);
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
    const rows = listSources(app, { spaceId: o.space, kind: o.kind, q: o.q, limit: o.limit, offset: o.offset, level: o.level });
    // Restricted ones only for those who may see them (src/auth/visibility.ts); Feishu-checked ones stay listed by title.
    if (who(req) === OWNER) return rows;
    const shown = rows.sources.filter((r) => sourceVisible(app, who(req), r.id) !== false);
    return { ...rows, sources: shown, total: rows.total - (rows.sources.length - shown.length) };
  });
  // A source seen by fewer people than its space: only its viewers and the space's managers.
  server.put("/api/sources/:id/visibility", async (req) => {
    const b = q(z.object({ visibility: z.enum(["space", "restricted"]), viewers: z.array(z.string()).max(100).optional() }), req.body);
    const id = (req.params as { id: string }).id;
    setVisibility(app, id, b.visibility, b.visibility === "restricted" ? [who(req), ...(b.viewers ?? [])] : []);
    return { visibility: b.visibility, viewers: viewersOf(app, id) };
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
  // What waits for the owner: agents' notes and folder levels, by impact (sources/attention.ts reviewQueue).
  server.get("/api/sources/review", async (req) => {
    const o = q(z.object({ space: z.string() }), req.query);
    if (!(scopeFor(app, who(req), [o.space]) ?? [o.space]).includes(o.space)) throw new HttpError(403, `不能访问空间 ${o.space}`);
    return reviewQueue(app, o.space);
  });
  server.post("/api/source-notes/:id/review", async (req) => {
    ownerOnly(req);
    const b = q(z.object({ decision: z.enum(["confirm", "reject"]) }), req.body);
    reviewSourceNote(app, Number((req.params as { id: string }).id), b.decision);
    return { ok: true };
  });
  server.post("/api/sources/node-level/review", async (req) => {
    ownerOnly(req);
    const b = q(z.object({ space: z.string(), node: z.string().min(1), decision: z.enum(["confirm", "reject"]) }), req.body);
    reviewNodeLevel(app, b.space, b.node, b.decision);
    return { ok: true };
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
    const q = await import("../agents/quota.ts");
    const quota = (await q.quotaProfiles(app)).map((p) => ({ profile: p.id, name: p.name ?? p.id, ...(q.quotaView(app, p) ?? { source: c.sourceOf(p), plan: null, readAt: null, windows: [] }) }));
    return { now: c.loadReport(app), recent: c.recentStats(app), outOfQuota: c.outOfQuotaList(app), quota };
  });
  // Read the plan limits of every account now (Codex app-server, Claude /usage).
  server.post("/api/agents/quota/refresh", async () => {
    const q = await import("../agents/quota.ts");
    await Promise.all((await q.quotaProfiles(app)).map((p) => q.refreshQuota(app, p, 0)));
    return { ok: true };
  });
  // The owner says an account has quota again (bought credits): use it before the reset time.
  server.delete("/api/agents/quota/:source", async (req) => {
    (await import("../agents/capacity.ts")).clearOutOfQuota(app, (req.params as { source: string }).source);
    return { ok: true };
  });
  // The catalog of a space, one level at a time (sources/catalog.ts): counts and levels follow the filters.
  server.get("/api/sources/tree", async (req) => {
    const o = q(z.object({ space: z.string(), node: z.string().default(""), kind: z.string().optional(), level: z.enum(LEVELS).optional(), q: z.string().optional() }), req.query);
    if (!(scopeFor(app, who(req), [o.space]) ?? [o.space]).includes(o.space)) throw new HttpError(403, `不能访问空间 ${o.space}`);
    const { treeChildren } = await import("../sources/catalog.ts");
    return treeChildren(app, o.space, o.node, { kind: o.kind, level: o.level, q: o.q });
  });
  // A level for a whole folder of the catalog (and what arrives there later).
  server.put("/api/sources/node-level", async (req) => {
    ownerOnly(req);
    const b = q(z.object({ space: z.string(), node: z.string().min(1), level: z.enum(LEVELS).nullable() }), req.body);
    return setNodeLevel(app, b.space, b.node, b.level, "owner", { reason: "本人在原件目录里设置" });
  });
  // A name for a knowledge base Feishu will not name (the owner is not a member). A name Feishu gives
  // later (after joining) replaces it.
  server.put("/api/sources/wiki-space-name", async (req) => {
    ownerOnly(req);
    const b = q(z.object({ id: z.string().min(1).max(80), name: z.string().trim().min(1).max(80) }), req.body);
    if (!run(app.db, "update wiki_spaces set name = ? where id = ?", b.name, b.id).changes) throw new HttpError(404, "没有这个知识库");
    const { catalogChanged } = await import("../sources/catalog.ts");
    catalogChanged(app);
    return { ok: true };
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
    // A message of someone else's conversation is as missing as one that never was.
    if (!m || (who(req) !== OWNER && one<{ user_id: string }>(app.db, "select user_id from conversations where id = ?", m.conversation_id)?.user_id !== who(req))) throw new HttpError(404, "消息不存在");
    return { id: m.id, conversationId: m.conversation_id, role: m.role, text: m.text, createdAt: m.created_at };
  });
  server.get("/api/sources/:id", async (req) => {
    const id = (req.params as { id: string }).id;
    // `window`: that many lines to start with, a chat's latest and anything else's first.
    const o = q(z.object({ from: z.coerce.number().optional(), to: z.coerce.number().optional(), window: z.coerce.number().optional() }), req.query);
    const chat = o.window && getSource(app, id).kind === "chat";
    const r = o.window ? readSource(app, id, 1, chat ? undefined : o.window, chat ? o.window : undefined) : readSource(app, id, o.from, o.to);
    // An old id of a merged duplicate opens the copy that was kept.
    const sid = r.source.id;
    const citedBy = all<{ page_id: string; title: string }>(app.db, "select distinct c.page_id, p.title from page_cites c join pages p on p.id = c.page_id where c.source_id = ?", sid);
    return { ...r, outline: sourceOutline(app, sid), citedBy, notes: sourceNotes(app, sid) };
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
    // A compressed copy (core/media.ts) answers for the original name; its type is the copy's.
    const { storedName } = await import("../core/stored-files.ts");
    const actual = storedName(app, name);
    if (!actual) throw new HttpError(404, "not found");
    const file = join(app.filesDir, actual);
    const ext = actual.split(".").pop()!;
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
      avif: "image/avif",
      ogg: "audio/ogg",
      opus: "audio/ogg",
      flac: "audio/flac",
    };
    if (actual !== name) reply.header("content-disposition", `inline; filename="${name.replace(/\.[^.]+$/, "")}.${ext}"`);
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
    // A business space covers its repositories, unless a branch of one repository is asked for.
    const requested = o.space && o.space !== "*" ? (o.branch ? o.space.split(",") : [...new Set(o.space.split(",").flatMap((id) => spaceFamily(app, id)))]) : null;
    let spaces = scopeFor(app, who(req), requested) ?? undefined;
    // A repository space on one branch: its index of the branch stands in for the files it changed.
    let branch: Awaited<ReturnType<typeof indexBranch>> | undefined;
    if (o.branch) {
      if (requested?.length !== 1 || !spaces?.length) throw new HttpError(400, "按分支检索时 space 填一个代码仓库空间");
      branch = await indexBranch(app, spaces[0], o.branch);
      spaces = [spaces[0], branch.space];
    }
    const found = visibleHits(app, who(req), await search(app, o.q, { spaces, types: o.types ? (o.types.split(",") as never) : undefined, limit: o.limit ?? 30, perSource: 2, visible: hitFilter(app, who(req)) }));
    return { hits: presentHits(app, found, o.q), branch };
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
    // A role a feature waits on until the owner picks its AI (replay-judge: nightly replay does not run without it).
    const notice = name === "replay-judge" ? (await import("../agents/replay.ts")).replayStatus(app).notice : null;
    return { name, description: r.description, tools: r.tools, writes: r.writes, modes: r.modes, body: r.body, defaults: { agent: app.config.agents.roles[name] ?? "", byBackend: app.config.agents.roleModels[name] ?? {} }, notice, ...profileDetail(app, name) };
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
  server.put("/api/roles/:name/full-access", async (req) => {
    if (who(req) !== OWNER) throw new HttpError(403, "完全访问只能由本人设置");
    return setRoleFullAccess(app, (req.params as { name: string }).name, q(z.object({ on: z.boolean() }), req.body).on);
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
  server.put("/api/agents/:name", async (req) => {
    // 完全访问 is the owner's alone; another user's edit keeps what the profile had.
    const { fullAccess, ...body } = req.body as { fullAccess?: boolean };
    return saveAgentSpec(app, { ...body, ...(who(req) === OWNER && fullAccess !== undefined ? { fullAccess } : {}), name: (req.params as { name: string }).name } as never, "user");
  });
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
    const c = one<{ user_id: string }>(app.db, "select user_id from conversations where id = ?", id);
    if (!c || (who(req) !== OWNER && c.user_id !== who(req))) throw new HttpError(404, "对话不存在");
    const src = one<{ id: string }>(app.db, "select id from sources where uri = ? and deleted_at is null", `conversation:${id}`);
    if (src) deleteSource(app, src.id);
    app.db.prepare("delete from conversations where id = ?").run(id);
    return { ok: true };
  });

  // --------------------------------------------------------------------- wiki
  server.get("/api/wiki/:space", async (req) => {
    const space = (req.params as { space: string }).space;
    syncWiki(app, space);
    const staleList = staleDetail(app, space);
    const aliases = all<{ alias: string }>(app.db, "select alias from page_aliases where space_id = ?", space).map((r) => r.alias);
    // stale: how many pages cite an original that changed; stalePages: which ones and what changed; upkeep: what checks itself.
    return {
      nav: wikiNav(app, space),
      pages: listPages(app, space),
      aliases,
      stale: staleList.length,
      stalePages: staleList.map((p) => ({ slug: p.slug, sources: p.sources })),
      upkeep: upkeepStatus(app, space),
    };
  });
  server.get("/api/wiki/:space/page/*", async (req) => {
    const { space, "*": slug } = req.params as { space: string; "*": string };
    const v = (req.query as { version?: string }).version;
    if (v) return pageVersion(app, space, slug, v);
    const page = readPage(app, space, slug);
    return { ...page, context: pageContext(app, space, page.slug) };
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
  server.post("/api/wiki/:space/lint", async (req) => {
    const space = (req.params as { space: string }).space;
    const b = q(z.object({ pages: z.array(z.string()).optional() }), req.body ?? {});
    return createRun(app, { kind: "wiki-lint", spaceId: space, title: b.pages?.length ? `检查 ${b.pages.length} 页` : "检查受影响页面", input: b.pages?.length ? { pages: b.pages } : {} });
  });
  // Move or rename pages / folders (a folder: from and to end in "/"); old paths keep opening the page.
  server.post("/api/wiki/:space/move", async (req) => {
    const space = (req.params as { space: string }).space;
    if (!canWrite(app, who(req), space)) throw new HttpError(403, `不能修改空间 ${space} 的 Wiki`);
    const b = q(z.object({ moves: z.array(z.object({ from: z.string(), to: z.string() })).min(1).max(300) }), req.body);
    const r = movePages(app, space, b.moves, { actor: "user" });
    return { moved: r.moved, linksFixed: r.linksFixed };
  });
  // Sort pages into folders: a run of the wiki-organizer role.
  server.post("/api/wiki/:space/organize", async (req) => {
    const space = (req.params as { space: string }).space;
    if (!canWrite(app, who(req), space)) throw new HttpError(403, `不能修改空间 ${space} 的 Wiki`);
    if (one(app.db, "select 1 from runs where kind = 'wiki-organize' and space_id = ? and status in ('queued','running')", space)) throw new HttpError(409, "已有整理目录的运行在进行");
    return createRun(app, { kind: "wiki-organize", spaceId: space, title: "整理 Wiki 目录", userId: who(req) });
  });
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
    // No space named: everything this person can read (all of it for the owner).
    if (o.space) readableSpace(req, o.space);
    const readable = o.space ? undefined : (accessibleSpaces(app, who(req)) ?? undefined);
    if (o.q) {
      const hits = await search(app, o.q, { spaces: o.space ? [o.space] : readable, types: ["memory"], limit: 100, includeHistory: o.status === "all" });
      return hits.map((h) => getMemory(app, h.id)).filter((m) => (!o.tag || m.tags?.includes(o.tag)) && (!o.kind || m.kind === o.kind) && inFolder(m));
    }
    return listMemories(app, { spaceId: o.space, spaceIds: readable, status: o.status ?? "active", kind: o.kind, tag: o.tag, folder, review: o.review, limit: 5000 });
  });
  // Folders: the tree on the memory page, its upkeep by hand, and an on-demand organizing pass.
  server.get("/api/memory-folders", async (req) => {
    const space = (req.query as { space?: string }).space;
    if (space) readableSpace(req, space);
    const readable = accessibleSpaces(app, who(req));
    const spaces = space ? [space] : listSpaces(app).map((s) => s.id).filter((s) => readable === null || readable.includes(s));
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
  server.get("/api/memory-tags", async (req) => {
    const space = (req.query as { space?: string }).space;
    if (space) readableSpace(req, space);
    return memoryTags(app, space, accessibleSpaces(app, who(req)) ?? undefined);
  });
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
  // The nightly dream: whether it is on, when it last looked, and how many digest experiences wait to be merged.
  server.get("/api/dream/status", async () => {
    const s = listSchedules(app).find((x) => x.id === "dream") ?? null;
    const last = one<{ id: string; status: string; created_at: string; finished_at: string | null }>(app.db, "select id, status, created_at, finished_at from runs where kind = 'dream' order by created_at desc limit 1") ?? null;
    const { digestExperienceCount } = await import("../memory/digest-merge.ts");
    return {
      enabled: !!s?.enabled,
      cron: s?.cron ?? null,
      next: s ? (nextRuns(app)[s.id] ?? null) : null,
      lastDreamAt: one<{ value: string }>(app.db, "select value from kv where key = 'dream_at'")?.value ?? null,
      lastRun: last ? { id: last.id, status: last.status, at: last.finished_at ?? last.created_at } : null,
      digestExperiences: digestExperienceCount(app),
    };
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
    const { settleCodeWorks } = await import("../agents/code-branch.ts");
    return { ...(await sweepItems(app)), code: await settleCodeWorks(app) };
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
  // Requirement trees (items/requirements.ts, docs/v2/requirements.md): read by space, written as a
  // batch of operations by the owner (confirmed at once), split from an item by the req-splitter role.
  const readableSpace = (req: { headers: unknown }, id: string) => {
    const allowed = accessibleSpaces(app, who(req as never));
    if (allowed && !allowed.includes(id)) throw new HttpError(403, `不能访问空间 ${id}`);
    return id;
  };
  server.get("/api/requirements", async (req) => {
    const o = q(z.object({ space: z.string(), removed: z.coerce.boolean().optional() }), req.query);
    const { reqTree, reqStatuses } = await import("../items/requirements.ts");
    const spaceId = readableSpace(req, getSpace(app, o.space).id);
    const nodes = reqTree(app, spaceId, { removed: o.removed });
    const states = reqStatuses(app, nodes.map((n) => n.id));
    const links = all<{ node: string; n: number }>(app.db, `select node, count(*) n from (select from_id node from req_links union all select to_id node from req_links) where node in (select id from req_nodes where space_id = ?) group by node`, spaceId);
    const linkCount = new Map(links.map((l) => [l.node, l.n]));
    const work = (await import("../items/work.ts")).reqWorkMarks(app, spaceId, who(req));
    const rt = await import("../items/req-tests.ts");
    const tests = rt.testsOf(app, nodes.map((n) => n.id), 20);
    return { nodes: nodes.map((n) => ({ ...n, state: states.get(n.id) ?? null, testState: rt.testState(tests.get(n.id) ?? []), links: linkCount.get(n.id) ?? 0, work: work.get(n.id) ?? null })) };
  });
  server.get("/api/requirements/:id", async (req) => {
    const { reqDetail } = await import("../items/requirements.ts");
    const d = reqDetail(app, (req.params as { id: string }).id);
    readableSpace(req, d.node.spaceId);
    const allowed = accessibleSpaces(app, who(req));
    // The delegations and branch reviews done for the items this node belongs to (items/work.ts).
    const work = (await import("../items/work.ts")).reqWork(app, d.node.id, who(req));
    // The same entries as the run page's “编码” view (src/agents/code-works.ts), with the item each was done for.
    const works = (await import("../agents/code-works.ts")).listCodeWorks(app, { roots: work.map((w) => w.rootId), ended: true });
    // Test results (items/req-tests.ts): the latest of each test, then earlier ones, with their kept artifacts.
    const rt = await import("../items/req-tests.ts");
    const { artifactsByIds } = await import("../agents/artifacts.ts");
    const results = rt.testsOf(app, [d.node.id], 60).get(d.node.id) ?? [];
    const shots = new Map(artifactsByIds(app, [...new Set(results.flatMap((r) => r.artifacts))]).map((a) => [a.id, a]));
    const testResults = results.map((r) => ({ ...r, artifacts: r.artifacts.flatMap((id) => shots.get(id) ?? []) }));
    return { ...d, links: d.links.filter((l) => !l.other || !allowed || allowed.includes(l.other.spaceId)), work, works, testState: rt.testState(results), testResults };
  });
  server.post("/api/requirements", async (req) => {
    const { reqOpSchema, saveReqs } = await import("../items/requirements.ts");
    const b = q(z.object({ space: z.string(), ops: z.array(reqOpSchema).min(1).max(200) }), req.body);
    const user = who(req);
    return saveReqs(app, b.ops, { by: "user", label: "本人" }, {
      canWrite: (id) => {
        readableSpace(req, id);
        if (!canWrite(app, user, id)) throw new HttpError(403, `无权修改空间 ${id}`);
      },
      canRead: (id) => void readableSpace(req, id),
      defaultSpace: getSpace(app, b.space).id,
    });
  });
  server.post("/api/items/:id/split-requirements", async (req) => {
    const id = (req.params as { id: string }).id;
    const b = q(z.object({ space: z.string().optional(), note: z.string().max(4000).optional() }), req.body ?? {});
    const item = getItem(app, id);
    const target = b.space ? getSpace(app, b.space).id : item.spaceId;
    readableSpace(req, target);
    if (!canWrite(app, who(req), target)) throw new HttpError(403, `无权修改空间 ${target}`);
    const { startReqSplit } = await import("../agents/req-split.ts");
    return startReqSplit(app, { itemId: id, space: target, note: b.note, userId: who(req) });
  });
  const materialBody = z.object({ kind: z.enum(["source", "conversation", "repo", "space", "run", "req"]), ref: z.string().min(1), branch: z.string().optional(), base: z.string().optional(), label: z.string().optional(), note: z.string().optional() });
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
    const o = q(z.object({ id: z.string().optional(), kind: z.string().optional(), exclude: z.string().optional(), space: z.string().optional(), status: z.string().optional(), parent: z.string().optional(), all: z.coerce.boolean().optional(), q: z.string().optional(), brief: z.coerce.boolean().optional(), limit: z.coerce.number().optional(), offset: z.coerce.number().optional() }), req.query);
    // Someone other than the owner: their own runs and the ones they may read (src/auth/permissions.ts).
    const spaces = runReadableSpaces(app, who(req));
    const visibleTo = spaces === null ? undefined : { userId: who(req), spaces };
    const opts = { id: o.id, kind: o.kind, exclude: o.exclude, spaceIds: o.space ? spaceFamily(app, o.space) : undefined, status: o.status, parentId: o.parent, includeQuiet: o.all, q: o.q, visibleTo };
    const runs = listRuns(app, { ...opts, limit: o.limit, offset: o.offset, brief: o.brief }).map((r) => (r.status === "queued" ? { ...r, waiting: queueReason(app, r) } : r));
    return { runs, total: countRuns(app, opts) };
  });
  // Coding work, one entry per delegation or branch review (src/agents/code-works.ts): the run page's “编码” view.
  server.get("/api/code-works", async (req) => {
    const o = q(z.object({ space: z.string().optional(), q: z.string().optional(), ended: z.coerce.boolean().optional(), limit: z.coerce.number().optional() }), req.query);
    const spaces = runReadableSpaces(app, who(req));
    const { listCodeWorks } = await import("../agents/code-works.ts");
    return listCodeWorks(app, { spaces: o.space ? spaceFamily(app, o.space) : undefined, q: o.q, ended: o.ended, limit: o.limit, visibleTo: spaces === null ? undefined : { userId: who(req), spaces } });
  });
  server.get("/api/code-works/:id", async (req) => {
    const spaces = runReadableSpaces(app, who(req));
    const work = (await import("../agents/code-works.ts")).codeWork(app, (req.params as { id: string }).id, spaces === null ? undefined : { userId: who(req), spaces });
    if (!work) throw new HttpError(404, "没有这次交办");
    return work;
  });
  // Who may read it is checked by the route (src/auth/routes.ts); its sub-runs only as far as they are readable too.
  server.get("/api/runs/:id", async (req) => {
    const id = (req.params as { id: string }).id;
    const o = q(z.object({ after: z.coerce.number().optional() }), req.query);
    const r = getRun(app, id);
    const children = listRuns(app, { parentId: id }).filter((c) => who(req) === OWNER || canReadRun(app, who(req), c.id));
    return { run: { ...r, waiting: queueReason(app, r) }, events: runEvents(app, id, o.after ?? 0), children, patches: r.kind === "code" ? codePatches(app, id) : undefined, context: runContext(app, r), writes: runWrites(app, r) };
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
    // Still downloading a server build: the page under /ide shows how far it is.
    const failed = await ensureIdeWeb(app).then(() => null, (e: Error) => (e instanceof IdeNotReady ? null : e.message));
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
      if (hops > 3) throw new HttpError(508, "设备转发层数过多");
      const { id } = req.params as { id: string };
      reply.hijack();
      tunnelHttp(app, id, req.url.slice(`/api/peers/${encodeURIComponent(id)}`.length), req.raw, reply.raw, hops + 1);
    };
    ide.all("/api/peers/:id/ide", relay);
    ide.all("/api/peers/:id/ide/*", relay);
    ide.all("/api/peers/:id/remote/*", relay);
    ide.get("/api/peers/:id/api/ide/open", relay);
  });
  attachIdeUpgrade(app, server.server);
  // Remote operation (docs/v2/remote.md): a browser page or the desktop of this machine through aad.
  await registerRemoteRoutes(server, app, who);
  attachRemoteUpgrade(app, server.server);
  server.addHook("onClose", async () => closeRemote(app));
  // Previews of a delegation's workspace (docs/v2/preview.md): routes and the port tunnel.
  registerPreviewRoutes(server, app, who);
  attachPreviewUpgrade(app, server.server);
  registerArtifactRoutes(server, app, who);
  attachPluginStreams(app, server.server);
  // Its WebSocket: upgrades skip the hooks, so the owner's token is checked here.
  server.server.on("upgrade", async (req, socket, head) => {
    // Another device runs one of this device's agents (core/peer-acp.ts): the owner's token.
    if (ACP_PATH.test(req.url ?? "")) {
      const h = req.headers.authorization;
      const owner = h?.startsWith("Bearer ") ? userForToken(app, h.slice(7)) === OWNER : !app.config.token && trustedLocal(req, req.socket.remoteAddress ?? "", { refuseProxied: app.config.auth.enabled });
      if (!owner) return void socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return void serveAcp(app, req, socket, head);
    }
    const m = /^\/api\/peers\/([^/?]+)(\/.*)$/.exec(req.url ?? "");
    if (!m) return;
    // A middle node passes on any upgrade of its owner, whatever the path: the device at the end
    // checks the token and the path itself, so a new tunnel there (a preview's port, …) needs no
    // newer omem on the nodes in between.
    const { tunnelUpgrade } = await import("../core/peer-tunnel.ts");
    const h = req.headers.authorization;
    const hops = Number(req.headers["x-omem-hops"] ?? 0);
    if (!h?.startsWith("Bearer ") || userForToken(app, h.slice(7)) !== OWNER) return void socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
    if (hops > 3) return void socket.end("HTTP/1.1 508 Loop Detected\r\n\r\n");
    tunnelUpgrade(app, decodeURIComponent(m[1]), m[2], req, socket, head, hops + 1);
  });
  server.addHook("onClose", async () => stopIdeWeb());
  server.addHook("onClose", async () => closeAcpServing());
  // The delegations an editor opened on `folder` belongs to (the VS Code extension, docs/v2/ide.md).
  server.get("/api/code-runs/at", async (req) => {
    const { folder } = q(z.object({ folder: z.string().min(1) }), req.query);
    return { runs: codeRunsAt(app, folder, who(req) === OWNER ? null : who(req)) };
  });
  // Reading a run is not running it: stopping or retrying is for its user, the owner, or whoever may read all runs.
  const mayControlRun = (req: FastifyRequest, id: string) => {
    const user = one<{ user_id: string | null }>(app.db, "select user_id from runs where id = ?", id)?.user_id ?? OWNER;
    if (who(req) !== OWNER && user !== who(req) && !can(app, who(req), "runs.read.all")) throw new HttpError(403, "只能停下或重试自己的运行");
  };
  server.post("/api/runs/:id/cancel", async (req) => {
    const id = (req.params as { id: string }).id;
    mayControlRun(req, id);
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
    mayControlRun(req, id);
    return (await import("../agents/retry.ts")).retryRun(app, id);
  });
  // A round waiting for an outside Agent to code, done by this machine's Agents instead (review-fix.ts codeHere).
  server.post("/api/runs/:id/code-here", async (req) => {
    const id = (req.params as { id: string }).id;
    ownRun(req, id);
    return (await import("../agents/review-fix.ts")).codeHere(app, id, who(req));
  });
  server.get("/api/runs/:id/apply-targets",async (req) => codeApplyTargets(app, (req.params as { id: string }).id));
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
    const body = q(z.object({ mode: z.enum(["merge", "rebase"]).default("merge") }), req.body ?? {});
    const id = (req.params as { id: string }).id;
    const owner = one<{ user_id: string | null }>(app.db, "select user_id from runs where id = ?", id)?.user_id;
    if (who(req) !== OWNER && owner !== who(req)) throw new HttpError(404, "运行不存在");
    return (await import("../agents/code.ts")).queueMoveToTarget(app, id, who(req), body.mode);
  });
  server.post("/api/runs/:id/discard", async (req) => {
    discardCodeRun(app, (req.params as { id: string }).id);
    return { ok: true };
  });
  // ---- delegations driven by tasks (docs/v2/coding-loop.md; agents/code-tasks.ts, code-loop.ts)
  server.get("/api/runs/:id/tasks", async (req) => {
    const id = (req.params as { id: string }).id;
    ownRun(req, id);
    const t = await import("../agents/code-tasks.ts");
    if (!t.isTaskWork(app, id)) return { taskMode: false };
    const rootId = t.workRootOf(app, id);
    const last = t.lastRound(app, rootId);
    const w = t.workState(app, rootId);
    return {
      taskMode: true, rootId, tasks: t.listTasks(app, rootId), checkpoints: t.listCheckpoints(app, rootId), artifacts: (await import("../agents/artifacts.ts")).artifactCounts(app, rootId),
      work: { budget: w.budget, budgetBy: w.budgetBy ?? null, until: w.until, round: Number(last.input.round ?? 1), lastRunId: last.id, paused: w.paused ?? null, viewed: w.viewed?.[who(req)] ?? 0, status: last.status, verdict: last.output.verdict ?? null, stage: last.output.reviewStage ?? null, reverts: (w.reverts ?? []).flatMap((r) => (r.seq !== undefined ? [r.seq] : [])), pending: (w.reverts ?? []).map(t.revertLabel), max: app.config.agents.autoAdvance.codeRoundsMax, look: w.look ? { checks: w.look.checks.map((c) => c.name), ai: Object.fromEntries(w.look.checks.map((c) => [c.name, w.lookAI?.[c.name] ?? null])) } : null },
    };
  });
  // The owner adds a task: it is coded in the next round (now, when nothing is running).
  server.post("/api/runs/:id/tasks", async (req) => {
    const id = (req.params as { id: string }).id;
    ownRun(req, id);
    const b = q(z.object({ title: z.string().trim().min(1).max(200), detail: z.string().max(8000).optional() }), req.body);
    const t = await import("../agents/code-tasks.ts");
    if (!t.isTaskWork(app, id)) throw new HttpError(400, "这次交办不是按修改项推进的");
    const rootId = t.workRootOf(app, id);
    const task = t.addTask(app, rootId, { title: b.title, doneWhen: b.detail?.trim() ?? "", kind: "owner", origin: { note: b.detail?.trim() || b.title } }, who(req));
    const next = await (await import("../agents/code-loop.ts")).advanceWork(app, rootId, { owner: true });
    return { task, next: next?.id ?? null };
  });
  // Another stage review of a task-driven delegation, from a checkpoint (code-loop.ts reviewAgain).
  server.post("/api/runs/:id/review-again", async (req) => {
    const id = (req.params as { id: string }).id;
    ownRun(req, id);
    const b = q(z.object({ from: z.number().int().min(0).optional() }), req.body ?? {});
    const t = await import("../agents/code-tasks.ts");
    if (!t.isTaskWork(app, id)) throw new HttpError(400, "这次交办不是按修改项推进的");
    const next = (await import("../agents/code-loop.ts")).reviewAgain(app, t.workRootOf(app, id), { from: b.from });
    return { next: next.id };
  });
  server.post("/api/runs/:id/tasks/:seq", async (req) => {
    const { id, seq: raw } = req.params as { id: string; seq: string };
    ownRun(req, id);
    const b = q(z.object({ action: z.enum(["answer", "skip", "reopen", "wontdo", "revert"]), choice: z.string().max(200).nullable().optional(), text: z.string().max(8000).optional(), redo: z.boolean().optional() }), req.body);
    const t = await import("../agents/code-tasks.ts");
    const loop = await import("../agents/code-loop.ts");
    if (!t.isTaskWork(app, id)) throw new HttpError(400, "这次交办不是按修改项推进的");
    const rootId = t.workRootOf(app, id);
    const seq = t.parseTaskRef(raw);
    const task = t.getTask(app, rootId, seq);
    const by = who(req);
    let next: { id: string } | null = null;
    if (b.action === "answer" || b.action === "skip") next = await loop.answerTask(app, rootId, seq, { choice: b.choice ?? null, text: b.text ?? null, skip: b.action === "skip" }, by);
    else if (b.action === "wontdo") {
      if (!b.text?.trim()) throw new HttpError(400, "不做要写一句理由");
      if (["done", "wontdo", "reverted"].includes(task.state)) throw new HttpError(409, `${t.taskLabel(seq)} 已经是「${t.TASK_STATE_LABEL[task.state]}」`);
      t.updateTask(app, rootId, seq, { state: "wontdo", answer: b.text.trim() }, { by, kind: "owner", text: `本人决定不做：${b.text.trim()}` });
      loop.closeTaskAsk(app, rootId, seq);
      next = await loop.advanceWork(app, rootId, { owner: true });
    } else if (b.action === "reopen") {
      if (!["done", "wontdo", "reverted"].includes(task.state)) throw new HttpError(409, `${t.taskLabel(seq)} 还没结束，不用重开`);
      t.updateTask(app, rootId, seq, { state: "todo", attempts: 0 }, { by, kind: "owner", text: `本人要求重做${b.text?.trim() ? `：${b.text.trim()}` : ""}` });
      next = await loop.advanceWork(app, rootId, { owner: true });
    } else {
      t.scheduleRevert(app, rootId, seq, b.text?.trim() || "本人要求回退", by, { redo: b.redo ?? false });
      next = await loop.advanceWork(app, rootId, { owner: true });
    }
    return { task: t.getTask(app, rootId, seq), next: next?.id ?? null };
  });
  // Take back a stretch (to a checkpoint), a file (as it was at a revision) or one hunk; the next round does it first.
  server.post("/api/runs/:id/revert", async (req) => {
    const id = (req.params as { id: string }).id;
    ownRun(req, id);
    const b = q(z.object({
      checkpoint: z.number().int().min(0).optional(),
      file: z.object({ space: z.string().min(1), path: z.string().min(1).max(1000), rev: z.string().min(7).max(64) }).optional(),
      patch: z.object({ space: z.string().min(1), text: z.string().min(1).max(200_000) }).optional(),
      reason: z.string().max(4000).optional(),
    }), req.body);
    const t = await import("../agents/code-tasks.ts");
    if (!t.isTaskWork(app, id)) throw new HttpError(400, "这次交办不是按修改项推进的");
    const rootId = t.workRootOf(app, id);
    const { worktreesOf } = await import("../agents/code.ts");
    const op = b.checkpoint !== undefined ? { checkpoint: b.checkpoint } : b.file ? { file: b.file } : b.patch ? { patch: b.patch } : null;
    if (!op) throw new HttpError(400, "要回退什么：检查点、文件或一段改动");
    t.scheduleWorkRevert(app, rootId, worktreesOf(app, rootId), { ...op, reason: b.reason } as never, who(req));
    const next = await (await import("../agents/code-loop.ts")).advanceWork(app, rootId, { owner: true });
    return { reverts: (t.workState(app, rootId).reverts ?? []).map(t.revertLabel), next: next?.id ?? null };
  });
  server.post("/api/runs/:id/work", async (req) => {
    const id = (req.params as { id: string }).id;
    ownRun(req, id);
    const b = q(z.object({ paused: z.boolean().optional(), viewed: z.number().int().min(0).optional() }), req.body);
    const t = await import("../agents/code-tasks.ts");
    if (!t.isTaskWork(app, id)) throw new HttpError(400, "这次交办不是按修改项推进的");
    const rootId = t.workRootOf(app, id);
    let next: { id: string } | null = null;
    if (b.viewed !== undefined) t.setWorkState(app, rootId, { viewed: { ...(t.workState(app, rootId).viewed ?? {}), [who(req)]: b.viewed } });
    if (b.paused === true) t.setWorkState(app, rootId, { paused: "owner" });
    if (b.paused === false) {
      t.setWorkState(app, rootId, { paused: null });
      next = await (await import("../agents/code-loop.ts")).advanceWork(app, rootId, { owner: true });
    }
    return { work: t.workState(app, rootId), next: next?.id ?? null };
  });
  // A file at a commit of the work's repositories (VS Code's two sides of a task's change).
  server.get("/api/runs/:id/file-at", async (req) => {
    const id = (req.params as { id: string }).id;
    ownRun(req, id);
    const o = q(z.object({ space: z.string().min(1), path: z.string().min(1).max(1000), rev: z.string().min(7).max(64) }), req.query);
    const t = await import("../agents/code-tasks.ts");
    const { worktreesOf } = await import("../agents/code.ts");
    const bytes = t.fileAt(app, worktreesOf(app, t.workRootOf(app, id)), o.space, o.path, o.rev);
    if (!bytes) return { missing: true, text: "" };
    if (bytes.subarray(0, 8000).includes(0)) return { binary: true, text: "" };
    return { text: bytes.toString("utf8") };
  });
  // One task's change, a stretch between checkpoints, everything since the viewer last looked, or the branch against another.
  server.get("/api/runs/:id/task-diff", async (req) => {
    const id = (req.params as { id: string }).id;
    ownRun(req, id);
    const o = q(z.object({ tasks: z.string().regex(/^[\dTt, ]+$/).optional(), from: z.coerce.number().int().min(0).optional(), to: z.coerce.number().int().min(0).optional(), since: z.enum(["viewed"]).optional(), base: z.string().max(200).regex(/^(?!-)[\w./-]+$/, "分支名不对").optional() }), req.query);
    const t = await import("../agents/code-tasks.ts");
    if (!t.isTaskWork(app, id)) throw new HttpError(400, "这次交办不是按修改项推进的");
    const rootId = t.workRootOf(app, id);
    const tasks = o.tasks ? o.tasks.split(/[,\s]+/).filter(Boolean).map((x) => t.parseTaskRef(x)) : undefined;
    const { worktreesOf } = await import("../agents/code.ts");
    return { patches: t.workPatches(app, rootId, worktreesOf(app, rootId), { tasks, from: o.from, to: o.to, since: o.since, base: o.base, userId: who(req) }) };
  });
  server.post("/api/delegate", async (req) => {
    // `space` is where the task belongs (a repository or a project); `repos` the repositories it changes.
    const sync = z.object({ pull: z.boolean().optional(), onto: z.string().optional(), mode: z.enum(["merge", "rebase"]).optional(), fetch: z.boolean().optional() });
    const b = q(z.object({ space: z.string(), repos: z.array(z.string()).optional(), task: z.string().min(1), checkCommand: z.string().optional(), reviewTier: z.string().optional(), maxRounds: z.number().int().min(1).max(50).optional(), fromBranch: z.string().optional(), branch: z.string().trim().max(200).optional(), itemId: z.string().optional(), sync: sync.optional(), syncOnly: z.boolean().optional(), parallel: z.boolean().optional() }), req.body);
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
    const r = createRun(app, { kind: "code", spaceId: businessOf(app, s.id), title: b.task.split("\n")[0].slice(0, 80), input: { task: b.task, checkCommand: b.checkCommand, repos, reviewTier: b.reviewTier || undefined, fromBranches, branchNames, itemId: b.itemId, ...(b.sync ? { sync: b.sync, syncOnly: !!b.syncOnly } : {}), ...(!b.syncOnly && app.config.agents.autoAdvance.taskLoop ? { taskMode: true, ...(b.maxRounds ? { maxRounds: b.maxRounds } : {}) } : {}) }, userId });
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
    const { checkLabel, lookName, reviewChecks, reviewsOf } = await import("../agents/review.ts");
    const chain = (r.output as { codeChain?: { rounds: string[] } }).codeChain;
    const rounds = (chain?.rounds ?? [r.id]).map((id) => getRun(app, id));
    const checks = reviewChecks(app);
    const infos = new Map(checks.map((c) => [c.name, c]));
    // A second look by another model is the check under its look name (code-overlap.ts).
    const labels = Object.fromEntries(checks.flatMap((c) => [[c.name, c.label], [lookName(c.name), checkLabel(infos, lookName(c.name))]]));
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
  // Later work on the branch a review's findings were handed to (review-fix.ts fixed_by), and the newest
  // work on the branch after this one: an older review shows its findings' latest state and points
  // questions and fixes at that code.
  server.get("/api/runs/:id/latest-state", async (req) => {
    const id = (req.params as { id: string }).id;
    ownRun(req, id);
    const { fixedByInfo, newerWork, workRuns } = await import("../agents/review-fix.ts");
    const runs = workRuns(app, id);
    const marks = runs.map(() => "?").join(",");
    const by = all<{ b: string }>(app.db, `select distinct f.fixed_by b from review_findings f join reviews r on r.id = f.review_id where r.code_run_id in (${marks}) and f.fixed_by is not null`, ...runs).map((x) => x.b);
    return { fixedBy: fixedByInfo(app, by), newer: newerWork(app, id, who(req)) };
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
  // The owner's rewrite of a finding's suggestion (empty: back to the reviewer's).
  server.put("/api/runs/:id/findings/:fid/suggestion", async (req) => {
    const p = req.params as { id: string; fid: string };
    ownRun(req, p.id);
    const b = q(z.object({ text: z.string().max(8000) }), req.body);
    const { setFindingSuggestion } = await import("../agents/review-fix.ts");
    return setFindingSuggestion(app, p.id, Number(p.fid), b.text);
  });
  // A round without a requirement split of its own borrows the latest one on its work or branch (review-fix.ts inheritedSplit).
  server.get("/api/runs/:id/inherited-split", async (req) => {
    const id = (req.params as { id: string }).id;
    ownRun(req, id);
    return { split: (await import("../agents/review-fix.ts")).inheritedSplit(app, id, who(req)) };
  });
  // The owner marks findings as taken on by later work on the branch (`by`: one of its rounds), or open again (null).
  server.put("/api/runs/:id/findings-fixed", async (req) => {
    const id = (req.params as { id: string }).id;
    ownRun(req, id);
    const b = q(z.object({ ids: z.array(z.number().int()).min(1).max(200), by: z.string().max(40).nullable() }), req.body);
    const { markFindingsFixed } = await import("../agents/review-fix.ts");
    return markFindingsFixed(app, id, b.ids, b.by, who(req));
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
  // Other unfinished delegations and branch reviews on the same branch, whose findings can be fixed together.
  server.get("/api/runs/:id/same-branch", async (req) => {
    const id = (req.params as { id: string }).id;
    ownRun(req, id);
    return (await import("../agents/review-fix.ts")).sameBranchWork(app, id, who(req));
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
      // Findings of other reviews of the same branch are among findingIds (review-fix.ts sameBranchWork).
      withSameBranch: z.boolean().optional(),
    }), req.body);
    if (b.review?.tier) await tierExists(b.review.tier);
    const { validateExecution } = await import("../agents/execution.ts");
    const reviewExecution = b.reviewAi ? validateExecution(app, { ...b.reviewAi, source: "user", reason: "本人在网页上按评审修改时指定" }) : undefined;
    const { startFix } = await import("../agents/review-fix.ts");
    return startFix(app, id, { findingIds: b.findingIds, text: b.text, review: b.review, reviewExecution, applyFirst: b.applyFirst, withSameBranch: b.withSameBranch }, who(req));
  });
  // The owner's words for a delegation while it runs, and the review its rounds get from now on (code-steer.ts).
  server.post("/api/runs/:id/notes", async (req) => {
    const id = (req.params as { id: string }).id;
    ownRun(req, id);
    const b = q(z.object({ text: z.string().min(1).max(20000) }), req.body);
    const { isTaskWork } = await import("../agents/code-tasks.ts");
    if (isTaskWork(app, id)) {
      const made = (await import("../agents/code-loop.ts")).ownerNote(app, id, b.text, who(req));
      if (made) return { runId: made.next?.id ?? id, stage: "task", task: made.task };
    }
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
  type RunFile = { from: "worktree" | "branch" | "repo" | "source"; space: string; path: string; bytes: () => Buffer; size: number; sourceId?: string };
  async function runFile(req: FastifyRequest): Promise<RunFile> {
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
        const shown = spawnSync("git", ["show", `${tip}:${path}`], { cwd: base, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
        if (shown.status === 0) return { from: "branch", space, path, bytes: () => shown.stdout, size: shown.stdout.length };
      }
      if (!base) continue;
      const full = resolvePath(base, path);
      if (!full.startsWith(resolvePath(base) + sep) || !existsSync(full) || statSync(full).isDirectory()) continue;
      return { from: wt && existsSync(wt.path) ? "worktree" : "repo", space, path, bytes: () => readFileSync(full), size: statSync(full).size };
    }
    const { materialSpaces } = await import("../items/materials.ts");
    const readable = [...(input.readSpaces ?? []), ...(input.itemId ? materialSpaces(app, input.itemId, who(req)) : [])].filter((s) => !allowed || allowed.includes(s));
    for (const space of readable) {
      const path = o.path.startsWith(`${space}/`) ? o.path.slice(space.length + 1) : o.path;
      const s = one<{ id: string }>(app.db, "select id from sources where space_id = ? and uri = ? and deleted_at is null", space, path);
      if (s) {
        const text = Buffer.from(readSource(app, s.id).text, "utf8");
        return { from: "source", space, path, bytes: () => text, size: text.length, sourceId: s.id };
      }
    }
    throw new HttpError(404, `找不到文件 ${o.path}`);
  }
  const IMAGE_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", bmp: "image/bmp", ico: "image/x-icon", svg: "image/svg+xml" };
  const imageType = (path: string) => IMAGE_TYPES[path.split(".").pop()!.toLowerCase()];
  server.get("/api/runs/:id/file", async (req) => {
    const f = await runFile(req);
    const meta = { from: f.from, space: f.space, path: f.path, size: f.size, ...(f.sourceId ? { sourceId: f.sourceId } : {}) };
    // Images are shown, other binaries offered as a download (…/file/raw); text comes as lines.
    if (imageType(f.path)) return { ...meta, binary: "image" };
    if (f.size > 2 * 1024 * 1024) return { ...meta, binary: "large" };
    const bytes = f.bytes();
    if (bytes.subarray(0, 8000).includes(0)) return { ...meta, binary: "other" };
    return { ...meta, lines: bytes.toString("utf8").split(/\r?\n/) };
  });
  server.get("/api/runs/:id/file/raw", async (req, reply) => {
    const f = await runFile(req);
    const type = imageType(f.path);
    const name = f.path.split("/").pop()!.replace(/["\\r\n]/g, "_");
    // Shown in an <img> or saved; never run as a page of this site (an SVG can carry script).
    reply.header("x-content-type-options", "nosniff").header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    reply.header("content-disposition", `${type ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(name)}`);
    return reply.type(type ?? "application/octet-stream").send(f.bytes());
  });
  // One side of a binary in a run's diff, by the blob id the diff names (a deleted image, the old
  // version of a changed one): read from the repository the run works in, nothing else.
  server.get("/api/runs/:id/blob", async (req, reply) => {
    const o = q(z.object({ space: z.string().min(1), oid: z.string().regex(/^[0-9a-f]{7,64}$/), path: z.string().min(1).max(1000) }), req.query);
    const r = getRun(app, (req.params as { id: string }).id);
    if (r.kind !== "code") throw new HttpError(400, "只有编码交办有文件");
    const allowed = accessibleSpaces(app, who(req));
    if (allowed && !allowed.includes(o.space)) throw new HttpError(404, `找不到文件 ${o.path}`);
    const { worktreesOf } = await import("../agents/code.ts");
    const root = String(r.input.continueFrom ?? r.id);
    const wt = worktreesOf(app, root).find((w) => w.space === o.space);
    if (!wt && !((getRun(app, root).input as { repos?: string[] }).repos ?? []).includes(o.space)) throw new HttpError(404, `这次交办没有改 ${o.space}`);
    const dir = wt && existsSync(wt.path) ? wt.path : findSpace(app, o.space)?.rootPath;
    if (!dir) throw new HttpError(404, `找不到 ${o.space} 的仓库`);
    const kind = spawnSync("git", ["cat-file", "-t", o.oid], { cwd: dir, encoding: "utf8", windowsHide: true });
    if (kind.status !== 0 || kind.stdout.trim() !== "blob") throw new HttpError(404, `仓库里没有这个版本的 ${o.path}`);
    const shown = spawnSync("git", ["cat-file", "blob", o.oid], { cwd: dir, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
    if (shown.status !== 0) throw new HttpError(404, `读不到这个版本的 ${o.path}`);
    const type = imageType(o.path);
    const name = o.path.split("/").pop()!.replace(/["\\\r\n]/g, "_");
    reply.header("x-content-type-options", "nosniff").header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    reply.header("content-disposition", `${type ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(name)}`);
    return reply.type(type ?? "application/octet-stream").send(shown.stdout);
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
    // A question someone's assistant asked for them says who.
    return listAsks(app, { conversationId: qs.conversation, status: qs.status, userId: who(req), limit: 100 }).map((a) => (a.askedBy ? { ...a, askedByName: userName(app, a.askedBy) } : a));
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
    const b = q(z.object({ choice: z.number().int().min(0).nullable().optional(), text: z.string().optional(), value: z.record(z.string(), z.unknown()).optional(), approved: z.boolean().optional() }), req.body);
    return answerAsk(app, id, { ...b, by: who(req) });
  });
  // Views an agent showed under its replies (`show`, docs/v2/interactive-ui.md).
  server.get("/api/ui/views", async (req) => {
    const conversation = (req.query as { conversation?: string }).conversation;
    if (!conversation) throw new HttpError(400, "要给出 conversation");
    return all<{ id: string; run_id: string | null; title: string; components: string; created_at: string }>(app.db, "select id, run_id, title, components, created_at from ui_views where conversation_id = ? and user_id = ? order by created_at", conversation, who(req)).map((v) => ({
      id: v.id, runId: v.run_id, title: v.title, components: JSON.parse(v.components), createdAt: v.created_at,
    }));
  });
  // An interactive page (`ui_page`): the document a sandboxed frame shows, with the host's policy and bridge.
  server.get("/api/ui/pages/:id", async (req) => {
    const { getPage, pageDocument } = await import("../agents/ui-pages.ts");
    const version = Number((req.query as { version?: string }).version) || undefined;
    const p = getPage(app, (req.params as { id: string }).id, who(req), version);
    return { id: p.id, version: p.version, versions: p.versions, title: p.title, createdAt: p.createdAt, document: pageDocument(p.html) };
  });
  server.post("/api/asks/:id/draft", async (req) => {
    const { saveDraft } = await import("../agents/asks.ts");
    saveDraft(app, (req.params as { id: string }).id, who(req), (req.body as { draft?: unknown } | null)?.draft);
    return { ok: true };
  });
  // One question or view on its own page (`#/ui/<id>`): what a Feishu card or a text chat links to.
  server.get("/api/ui/:id", async (req) => {
    const id = (req.params as { id: string }).id;
    const v = one<{ id: string; run_id: string | null; conversation_id: string | null; user_id: string; title: string; components: string; created_at: string }>(app.db, "select * from ui_views where id = ?", id);
    if (v) {
      if (v.user_id !== who(req)) throw new HttpError(404, "没有这个内容");
      return { type: "view", view: { id: v.id, runId: v.run_id, conversationId: v.conversation_id, title: v.title, components: JSON.parse(v.components), createdAt: v.created_at } };
    }
    const { getAsk, draftOf } = await import("../agents/asks.ts");
    const a = getAsk(app, id);
    if (a.userId !== who(req)) throw new HttpError(404, "没有这个内容");
    return { type: "ask", ask: { ...a, draft: draftOf(app, id), ...(a.askedBy ? { askedByName: userName(app, a.askedBy) } : {}) } };
  });

  // ----------------------------------------------------- notifications/status
  server.get("/api/notifications", async (req) => {
    const list = listNotifications(app, 50, who(req));
    return { notifications: list, unread: list.filter((n) => !n.readAt).length };
  });
  server.post("/api/notifications/read", async (req) => {
    markRead(app, (req.body as { id?: string } | null)?.id, who(req));
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
  server.post("/api/rules", async (req) => (await import("../rules/store.ts")).saveRule(app, req.body as never, "user", who(req)));
  server.put("/api/rules/:id", async (req) => (await import("../rules/store.ts")).saveRule(app, { ...(req.body as object), id: (req.params as { id: string }).id } as never, "user", who(req)));
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
  // A profile whose backend is gone still lists (with no default shown).
  const defaultBackendOf = (f: () => string) => {
    try {
      return f();
    } catch {
      return "";
    }
  };
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
      // `agent`: the backend each one runs on when a rule does not pick one (shown as the default).
      specs: [
        { name: "assistant", description: "主助手：未指定专用档案的日常任务", agent: defaultBackendOf(() => resolveRunProfile(app, { actor: { role: "assistant" } }).id) },
        ...listAgentSpecs(app).map((s) => ({ name: s.name, description: s.description, agent: defaultBackendOf(() => resolveRunProfile(app, { actor: { spec: s } }).id) })),
      ],
      // The AI a rule's agent action may be pinned to (AiDefaults on the rules page).
      backends: listAgentProfiles(app).map((p) => ({ id: p.id, name: p.name ?? p.id, installed: p.installed, transport: p.transport, model: p.model, effort: p.effort, probe: cachedProbe(app, p.id) })),
      chats: all<{ chat_id: string; name: string; chat_mode: string | null }>(app.db, "select chat_id, name, chat_mode from lark_cursors where chat_id like 'oc_%' and name != '' order by updated_at desc limit 300"),
      conversations: all(app.db, "select id,title,channel,space_id,external_id from conversations where user_id = ? order by updated_at desc limit 300", OWNER),
      botReady: !!app.config.lark.appId,
      groups: ruleGroups(app),
      // Whether a rule's “决策模型” choice has one to use (settings → AI → 决策).
      decision: (({ ready, detail }) => ({ ready, detail }))(categoryStatus(app.config, "decision", app.home)),
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
  // The bot apps' permissions and event subscriptions (lark-bot-check.ts), and fixing them by scan.
  server.get("/api/lark/bot-check", async () => ({ bots: await (await import("../channels/lark-bot-check.ts")).checkLarkBots(app) }));
  server.post("/api/lark/bot-check/:ref/scan", async (req) => {
    const ref = q(z.object({ ref: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/) }), req.params).ref;
    return (await import("../channels/lark-bot-check.ts")).updateLarkBotByScan(app, ref);
  });
  // Reactions on what the bots sent, by profile and model (lark-feedback.ts).
  server.get("/api/feedback/stats", async (req) => {
    const days = q(z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }), req.query ?? {}).days;
    return (await import("../channels/lark-feedback.ts")).feedbackStats(app, days);
  });
  // Nightly replay (agents/replay.ts): status, recent replays and their verdicts, run one by hand, adopt / ignore a suggestion.
  server.get("/api/replays", async (req) => {
    const o = q(z.object({ limit: z.coerce.number().int().min(1).max(200).default(30) }), req.query ?? {});
    const m = await import("../agents/replay.ts");
    return { status: m.replayStatus(app), replays: m.listReplays(app, { limit: o.limit }) };
  });
  server.post("/api/replays/run", async (req) => {
    const { REPLAY_AXES } = await import("../core/config.ts");
    const b = q(z.object({ runId: z.string().regex(/^r[0-9a-z]{6,40}$/).optional(), axis: z.enum(REPLAY_AXES).optional() }), req.body ?? {});
    return (await import("../agents/replay.ts")).scheduleReplays(app, b);
  });
  server.post("/api/replay-effects/:id/:action", async (req) => {
    const p = q(z.object({ id: z.string().regex(/^re[0-9a-z]{6,40}$/), action: z.enum(["adopt", "ignore"]) }), req.params);
    return (await import("../agents/replay.ts")).resolveEffect(app, p.id, p.action);
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
  // Knowledge bases the owner can see (lark-knowledge.ts): list with proposals and progress, discover, read, decide, settings.
  server.get("/api/lark/kb", async (req) => {
    const o = q(z.object({ status: z.enum(["new", "proposed", "later", "mapped", "ignored", "gone", "all"]).optional() }), req.query ?? {});
    const k = await import("../channels/lark-knowledge.ts");
    return { ...k.knowledgeOverview(app), kbs: k.listKnowledgeBases(app, { status: o.status ?? "all" }), origin: k.knowledgeOrigin(app) };
  });
  server.post("/api/lark/kb/discover", async (req) => {
    ownerOnly(req);
    return (await import("../channels/lark-knowledge.ts")).startDiscovery(app);
  });
  server.post("/api/lark/kb/read", async (req) => {
    ownerOnly(req);
    const b = q(z.object({ limit: z.number().int().min(1).max(500).optional() }), req.body ?? {});
    return (await import("../channels/lark-knowledge.ts")).startReading(app, b);
  });
  server.put("/api/lark/kb/settings", async (req) => {
    ownerOnly(req);
    const b = q(z.object({ direction: z.string().max(4000).optional(), autoApply: z.boolean().optional(), dailyDocs: z.number().int().min(0).max(2000).optional() }), req.body ?? {});
    const changed = b.direction !== undefined && b.direction.trim() !== (app.config.lark.knowledge?.direction ?? "").trim();
    const next = structuredClone(app.config);
    next.lark.knowledge = { ...next.lark.knowledge, ...Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined)) };
    saveConfig(next, app.home);
    Object.assign(app.config, next);
    // A changed direction brings the knowledge bases put aside back to the scout.
    if (changed) (await import("../channels/lark-knowledge.ts")).directionChanged(app);
    return { settings: app.config.lark.knowledge };
  });
  server.post("/api/lark/kb/:id", async (req) => {
    ownerOnly(req);
    return (await import("../channels/lark-knowledge.ts")).kbAction(app, (req.params as { id: string }).id, req.body);
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
    const probe = await probeProfile(p, app);
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
  // Desktop and browser control (ai-auto-desktop's `aad`): is it installed, which version; install or update it through osdk.
  server.get("/api/desktop", async () => {
    const { desktopControl } = await import("../core/tools.ts");
    return { ...desktopControl.status(), spec: desktopControl.spec() };
  });
  server.post("/api/desktop/install", async () => {
    const { desktopControl, installTool } = await import("../core/tools.ts");
    if (!installTool("aad")) throw new HttpError(500, `安装失败：在终端运行 omem setup desktop 看详细输出（或 osdk install ${desktopControl.spec()}）`);
    return { ...desktopControl.status(), spec: desktopControl.spec() };
  });
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
  // Compressing stored media with ffmpeg (settings → 占用): install and detect ffmpeg, start or stop a job.
  const mediaState = async () => {
    const m = await import("../core/media.ts");
    return { ffmpeg: m.ffmpegStatus(), overview: m.mediaOverview(app), compressed: m.compressedSummary(app), job: m.mediaJobState(app), settings: app.config.media, cpus: (await import("node:os")).cpus().length };
  };
  const mediaOwner = (req: FastifyRequest) => {
    if (who(req) !== OWNER) throw new HttpError(403, "只有本人能压缩附件");
  };
  server.get("/api/media", async (req) => (mediaOwner(req), mediaState()));
  server.post("/api/media/ffmpeg/install", async (req) => {
    mediaOwner(req);
    const { commandExists } = await import("../agents/spawn.ts");
    if (!commandExists("osdk")) throw new HttpError(400, "这台机器没有 osdk：先装 osdk，或自己装 ffmpeg 放进 PATH");
    void (await import("../core/media.ts")).startFfmpegInstall();
    return mediaState();
  });
  server.post("/api/media/compress", async (req) => {
    mediaOwner(req);
    const o = q(z.object({
      types: z.array(z.enum(["image", "video", "audio"])).min(1),
      mode: z.enum(["lossless", "lossy"]),
      quality: z.enum(["high", "medium", "low"]).default("medium"),
      maxSide: z.number().int().min(0).max(16384).default(0),
      minBytes: z.number().int().min(0).default(0),
      deleteOriginals: z.boolean().default(true),
      limit: z.number().int().min(0).default(0),
      retryFailed: z.boolean().default(false),
    }), req.body);
    try {
      (await import("../core/media.ts")).startMediaJob(app, o);
    } catch (e) {
      throw new HttpError(409, (e as Error).message);
    }
    return mediaState();
  });
  server.post("/api/media/stop", async (req) => {
    mediaOwner(req);
    (await import("../core/media.ts")).stopMediaJob();
    return mediaState();
  });
  server.post("/api/media/resume", async (req) => {
    mediaOwner(req);
    if (!(await import("../core/media.ts")).resumeMediaJob(app, { stopped: true })) throw new HttpError(409, "没有可以继续的压缩，或者还没有 ffmpeg");
    return mediaState();
  });
  server.post("/api/media/delete-originals", async (req) => {
    mediaOwner(req);
    try {
      return { ...(await import("../core/media.ts")).deleteCompressedOriginals(app), ...(await mediaState()) };
    } catch (e) {
      throw new HttpError(409, (e as Error).message);
    }
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
    effort: z.string().max(40).optional(),
  });
  server.get("/api/peer/tools", async (req) => {
    if (who(req) !== OWNER) throw new HttpError(403, "只有本人能使用设备的工具接口");
    const o = q(peerScope.extend({ spaces: z.string().optional(), readOnly: z.string().optional() }), req.query);
    const { peerTools } = await import("../agents/peer-agent.ts");
    return { node: (await import("../core/peers.ts")).nodeId(app), tools: peerTools(app, { ...o, spaces: o.spaces?.split(",").filter(Boolean), readOnly: o.readOnly === "1" || o.readOnly === "true" }) };
  });
  server.post("/api/peer/tool", async (req) => {
    if (who(req) !== OWNER) throw new HttpError(403, "只有本人能使用设备的工具接口");
    const b = q(peerScope.extend({ session: z.string().min(1).max(80), name: z.string().max(80), args: z.unknown().optional() }), req.body);
    const { peerToolCall } = await import("../agents/peer-agent.ts");
    const { name, args, ...scope } = b;
    return { node: (await import("../core/peers.ts")).nodeId(app), ...(await peerToolCall(app, scope, name, args)) };
  });
  // `omem peer pull` (core/pull-transfer.ts): the snapshot with the parts asked for; a newer puller
  // fetches attachments separately (files=separate), only the ones it lacks.
  server.get("/api/peer/snapshot", async (req, reply) => {
    if (who(req) !== OWNER) throw new HttpError(403, "只有本人能拉取设备快照");
    const { snapshotStream, parseParts } = await import("../core/pull.ts");
    const q = req.query as { parts?: string; strip?: string; files?: string };
    let parts;
    try { parts = parseParts(q.parts); } catch (e) { throw new HttpError(400, (e as Error).message); }
    reply.type("application/x-tar");
    return reply.send(await snapshotStream(app, q.parts === undefined && q.strip === undefined && q.files === undefined ? undefined : { parts, strip: q.strip === "1", separateFiles: q.files === "separate" }));
  });
  server.get("/api/peer/files", async (req) => {
    if (who(req) !== OWNER) throw new HttpError(403, "只有本人能拉取设备快照");
    const { FILE_NAME } = await import("../core/pull-transfer.ts");
    return { names: existsSync(app.filesDir) ? readdirSync(app.filesDir).filter((n) => FILE_NAME.test(n)) : [] };
  });
  server.post("/api/peer/files", async (req, reply) => {
    if (who(req) !== OWNER) throw new HttpError(403, "只有本人能拉取设备快照");
    const names = (req.body as { names?: unknown })?.names;
    if (!Array.isArray(names) || names.length > 1000 || names.some((n) => typeof n !== "string")) throw new HttpError(400, "names 是最多 1000 个文件名");
    const { filesStream } = await import("../core/pull-transfer.ts");
    reply.type("application/x-tar");
    return reply.send(filesStream(app, names as string[]));
  });
  // Settings → 设备: the devices this one can reach (tokens never leave), the ones holding a
  // pairing token of this one, pairing both ways, and which of a device's agents to use here.
  const peerView = async () => {
    const { listPeers, localUrls, nodeId } = await import("../core/peers.ts");
    const { pairedTokens } = await import("../core/users.ts");
    const agents = app.config.agents.profiles.filter((p) => p.peer).map((p) => ({ id: p.id, name: p.name ?? p.id, peer: p.peer!.id, agent: p.peer!.agent }));
    return {
      node: nodeId(app),
      urls: localUrls(app),
      peers: listPeers(app).map((p) => ({ id: p.id, url: p.url, urls: p.urls ?? [p.url], via: p.via ?? null, addedAt: p.addedAt })),
      paired: pairedTokens(app),
      agents,
    };
  };
  server.get("/api/peers", async () => peerView());
  server.post("/api/peer/invite", async (req) => {
    const b = q(z.object({ label: z.string().trim().regex(/^[\w.-]{1,40}$/, "名字只用字母、数字、点、短横线").default("device"), url: z.string().url().optional() }), req.body);
    const { invite } = await import("../core/peers.ts");
    return invite(app, b);
  });
  server.post("/api/peer/add", async (req) => {
    const b = q(z.object({ code: z.string().trim().min(8), via: z.string().optional(), url: z.string().url().optional() }), req.body);
    const { addPeer, peerJson } = await import("../core/peers.ts");
    let p;
    try {
      p = await addPeer(app, b.code, { via: b.via || undefined, url: b.url });
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    const error = await peerJson<{ node: string }>(app, p.id, "/api/diag", undefined, 20_000).then(() => null, (e: Error) => e.message);
    return { id: p.id, online: !error, error, ...(await peerView()) };
  });
  server.patch("/api/peers/:id", async (req) => {
    const b = q(z.object({ url: z.string().url() }), req.body);
    const { setPeerUrl } = await import("../core/peers.ts");
    try {
      setPeerUrl(app, (req.params as { id: string }).id, b.url);
    } catch (e) {
      throw new HttpError(404, (e as Error).message);
    }
    return peerView();
  });
  server.delete("/api/peers/:id", async (req) => {
    const { removePeer } = await import("../core/peers.ts");
    const r = await removePeer(app, (req.params as { id: string }).id);
    return { ...r, ...(await peerView()) };
  });
  // Is it there, which version, which ACP agents it could lend (its own, installed).
  server.get("/api/peers/:id/status", async (req) => {
    const id = (req.params as { id: string }).id;
    const { peerJson } = await import("../core/peers.ts");
    const started = Date.now();
    try {
      const d = await peerJson<{ node?: string; version?: string | null }>(app, id, "/api/diag", undefined, 15_000);
      const s = await peerJson<{ agents?: { id: string; name?: string; transport: string; installed?: boolean; peer?: unknown }[] }>(app, id, "/api/settings", undefined, 15_000).catch(() => ({ agents: [] }));
      const agents = (s.agents ?? []).filter((a) => a.transport === "acp" && a.installed && !a.peer).map((a) => ({ id: a.id, name: a.name ?? a.id }));
      return { online: true, ms: Date.now() - started, version: d.version ?? null, agents };
    } catch (e) {
      return { online: false, error: (e as Error).message, agents: [] };
    }
  });
  server.post("/api/peer/agents", async (req) => {
    const b = q(z.object({ peer: z.string().min(1), agent: z.string().min(1), name: z.string().optional(), use: z.boolean() }), req.body);
    const { dropPeerAgents, findPeer } = await import("../core/peers.ts");
    if (!findPeer(app, b.peer)) throw new HttpError(404, `没有名为 ${b.peer} 的设备`);
    if (!b.use) {
      await dropPeerAgents(app, (p) => p.id === b.peer && p.agent === b.agent);
      return peerView();
    }
    const id = `${b.peer}-${b.agent}`.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
    if (allProfiles(app.config).some((p) => p.id === id && !(p.peer?.id === b.peer && p.peer.agent === b.agent))) throw new HttpError(409, `已经有名为 ${id} 的 Agent 配置`);
    const rest = app.config.agents.profiles.filter((p) => !(p.peer?.id === b.peer && p.peer.agent === b.agent));
    const name = `${(b.name ?? b.agent).replace(/\s*\(ACP\)$/, "")}（${b.peer}）`;
    app.config.agents.profiles = [...rest, { id, name, transport: "acp", command: "omem", args: [], env: {}, idleTimeoutMs: 600_000, peer: { id: b.peer, agent: b.agent } }];
    saveConfig(app.config, app.home);
    return peerView();
  });
  // A device paired with us asks to forget it: the token it holds stops working.
  server.post("/api/peer/unpair", async (req) => {
    const { revokeTokenValue } = await import("../core/users.ts");
    const token = bearer(req);
    return { revoked: !!token && /^om_/.test(token) && revokeTokenValue(app, token) };
  });
  server.delete("/api/peer/paired/:id", async (req) => {
    const { revokePairedToken } = await import("../core/users.ts");
    if (!revokePairedToken(app, (req.params as { id: string }).id)) throw new HttpError(404, "没有这个配对令牌");
    return peerView();
  });
  server.all("/api/peers/:id/*", async (req, reply) => {
    const { peerFetch } = await import("../core/peers.ts");
    const hops = Number(req.headers["x-omem-hops"] ?? 0);
    if (hops > 3) throw new HttpError(508, "设备转发层数过多");
    const { id } = req.params as { id: string };
    const rest = req.url.slice(`/api/peers/${encodeURIComponent(id)}`.length) || "/";
    // The web UI's own files (GET) are forwarded too, so `omem peer open` can show a peer's
    // UI through a middle node; anything that changes state must be an API call.
    if (!rest.startsWith("/api/") && req.method !== "GET" && req.method !== "HEAD") throw new HttpError(400, "只能转发 /api/ 下的请求和网页文件");
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {});
    const headers: Record<string, string> = body ? { "content-type": "application/json" } : {};
    for (const h of ["accept", "if-none-match", "if-modified-since", "range"]) {
      const v = req.headers[h];
      if (typeof v === "string") headers[h] = v;
    }
    const res = await peerFetch(app, id, rest, { method: req.method, body, headers, timeoutMs: 15 * 60_000 }, hops + 1);
    reply.status(res.status);
    const type = res.headers.get("content-type");
    if (type) reply.type(type);
    // Keep the peer's caching headers so the browser behind `omem peer open` can cache its UI,
    // and its CORS header: plugin pages run in a sandboxed iframe and load their modules in CORS mode.
    // Files (stored originals, run artifacts): seeking a video, and a page's sandbox, which must not be lost on the way.
    for (const h of ["cache-control", "etag", "last-modified", "access-control-allow-origin", "content-range", "accept-ranges", "content-disposition", "content-security-policy", "x-content-type-options", "referrer-policy"]) {
      const v = res.headers.get(h);
      if (v) reply.header(h, v);
    }
    return reply.send(res.body ? (await import("node:stream")).Readable.fromWeb(res.body as never) : "");
  });

  server.get("/api/settings", async () => ({ config: app.config, agents: listAgentProfiles(app), home: app.home, rerank: rerankStatus(app) }));
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
    // A provider taken out takes its key with it.
    for (const id of Object.keys(readKeys(app.home))) if (!next.ai.providers.some((p) => p.id === id)) setKey(app.home, id, null);
    Object.assign(app.config, next);
    return { config: app.config, restart };
  });

  // ----------------------------------------------- AI providers and model categories (core/ai-keys.ts)
  const MODEL_FIELDS: ModelField[] = ["image", "voice.live", "voice.realtime", "voice.transcribe", "voice.delegate", "decision"];
  /** Provider model lists older than a day (or missing) are fetched again, waiting at most a few seconds. */
  const freshModels = async (only?: string) => {
    const cache = readModelCache(app.home);
    const keys = readKeys(app.home);
    const stale = app.config.ai.providers.filter((p) => (only ? p.id === only : true) && keys[p.id] && (only || !cache[p.id] || Date.now() - cache[p.id].at > MODEL_CACHE_MS));
    if (stale.length) await Promise.race([Promise.allSettled(stale.map((p) => refreshModels(app.home, p))), new Promise((r) => setTimeout(r, 8_000))]);
  };
  const aiView = () => {
    const keys = readKeys(app.home);
    const cache = readModelCache(app.home);
    return {
      providers: app.config.ai.providers.map((p) => ({ ...p, keyHint: keyHint(keys[p.id] ?? ""), hasKey: !!keys[p.id], listed: cache[p.id] ? { at: cache[p.id].at, count: cache[p.id].models.length, error: cache[p.id].error } : null })),
      status: Object.fromEntries((["voice", "decision", "image"] as const).map((c) => [c, categoryStatus(app.config, c, app.home)])),
      /** Per provider and field: the listed models that fit, and the model an empty field uses. */
      choices: Object.fromEntries(app.config.ai.providers.map((p) => [p.id, Object.fromEntries(MODEL_FIELDS.map((f) => [f, modelChoices(app.home, p, f)]))])),
      kinds: CATEGORY_KINDS,
      inherited: inheritedKeyVars(),
    };
  };
  server.get("/api/ai", async () => {
    await freshModels();
    return aiView();
  });
  server.put("/api/ai/keys/:id", async (req) => {
    const id = (req.params as { id: string }).id;
    if (!app.config.ai.providers.some((p) => p.id === id)) throw new HttpError(404, "没有这个提供方");
    const b = q(z.object({ key: z.string().trim().max(500).nullable() }), req.body);
    setKey(app.home, id, b.key || null);
    if (b.key) await freshModels(id);
    return aiView();
  });
  // ----------------------------------------------------------------- voice (core/voice.ts)
  const voicePurpose = z.enum(["chat", "practice"]);
  server.get("/api/voice", async () => (await import("../core/voice.ts")).voiceStatus(app));
  server.post("/api/voice/realtime/secret", async (req) => {
    const b = q(z.object({ purpose: voicePurpose, scenario: z.string().max(1000).optional() }), req.body);
    return (await import("../core/voice.ts")).realtimeSecret(app, b);
  });
  server.post("/api/voice/live/sdp", async (req) => {
    const b = q(z.object({ purpose: voicePurpose, scenario: z.string().max(1000).optional(), sdp: z.string().min(10).max(100_000) }), req.body);
    return (await import("../core/voice.ts")).liveConnect(app, b);
  });
  server.post("/api/voice/transcribe", async (req) => {
    const b = q(z.object({ audio: z.string().min(1).max(30_000_000), mime: z.string().max(100).default("audio/webm") }), req.body);
    return { text: await (await import("../core/voice.ts")).transcribe(app, Buffer.from(b.audio, "base64"), b.mime) };
  });
  server.post("/api/voice/tool", async (req) => {
    const b = q(z.object({ name: z.string(), args: z.unknown().optional(), space: z.string().default("personal") }), req.body);
    return (await import("../core/voice.ts")).voiceTool(app, who(req), b.space, b.name, b.args ?? {});
  });
  server.get("/api/voice/sessions", async (req) => {
    const o = q(z.object({ purpose: voicePurpose.optional() }), req.query);
    return { sessions: (await import("../core/voice.ts")).listVoiceSessions(app, who(req), o.purpose) };
  });
  server.post("/api/voice/sessions", async (req) => {
    const b = q(z.object({
      purpose: voicePurpose,
      scenario: z.string().max(1000).optional(),
      api: z.string().max(20),
      model: z.string().max(100),
      startedAt: z.string(),
      space: z.string().default("personal"),
      transcript: z.array(z.object({ role: z.enum(["user", "assistant"]), text: z.string().max(20_000) })).max(2000),
    }), req.body);
    const spaces = accessibleSpaces(app, who(req));
    const spaceId = !spaces || spaces.includes(b.space) ? b.space : spaces[0];
    if (!spaceId) throw new HttpError(403, "没有可用的空间");
    return (await import("../core/voice.ts")).saveVoiceSession(app, who(req), { ...b, spaceId });
  });

  // Settings → AI → 决策: try a question on the configured decision model.
  server.post("/api/ai/decision/test", async (req) => {
    const b = q(z.object({ material: z.string().trim().min(1).max(20_000), question: z.string().trim().min(1).max(2000), options: z.array(z.string().trim().min(1).max(200)).max(20).default([]) }), req.body);
    const { decide } = await import("../core/decision.ts");
    const started = Date.now();
    const question = b.options.length >= 2
      ? { type: "choice" as const, instructions: b.question, options: Object.fromEntries(b.options.map((o) => [o, o])) }
      : { type: "yesno" as const, instructions: b.question };
    try {
      const r = await decide(app, b.material, question);
      if (!r) throw new HttpError(400, categoryStatus(app.config, "decision", app.home).detail);
      return { ...r, ms: Date.now() - started };
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(502, (e as Error).message);
    }
  });
  server.post("/api/ai/providers/:id/test", async (req) => {
    const p = app.config.ai.providers.find((x) => x.id === (req.params as { id: string }).id);
    if (!p) throw new HttpError(404, "没有这个提供方");
    const r = await testProvider(p, keyOf(p.id, app.home));
    if (r.ok) await freshModels(p.id);
    return r;
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
