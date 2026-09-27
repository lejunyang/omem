/** review knowledge-base HTTP surface. It reuses MemoryService /
 * KeywordRetrieval against the isolated review Store and registers only the
 * read/browse/sync routes a code-review workflow needs. No AssistantRuntime,
 * Lark host, learning pipeline, notification workers or business token gating:
 * the app binds loopback only and owns no business state.
 *
 * Security: without REVIEW_TOKEN it answers only on loopback Hosts and accepts
 * same-origin browser requests from the local Vite/dev origin; with REVIEW_TOKEN
 * set the token gates every /api route. Absolute host paths are never returned. */
import Fastify, { type FastifyInstance } from "fastify";
import staticFiles from "@fastify/static";
import { timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Store } from "../store.js";
import { MemoryService } from "../memory/service.js";
import { KeywordRetrieval } from "../retrieval/keyword.js";
import {
  categoryName,
  readSyncStatus,
  runReviewSync,
  type SyncResult,
} from "./sync.js";
import {
  REVIEW_DIR,
  ensureReviewMetaTable,
  removedSourceIds,
  ensureReviewRelationsTable,
  relationsForFragment,
  listReviewRelations,
  relationsSummary,
  relationsForCodePath,
} from "./store.js";
import { loadAssociations } from "./associations.js";

type Row = Record<string, unknown>;

export const REVIEW_API_PREFIX = "/api/review";

/** Browser origins allowed to call the loopback API without a token. The web UI
 * is served by Vite (5181) or the static production bundle (5180). */
const ALLOWED_ORIGINS = new Set([
  "http://127.0.0.1:5181",
  "http://localhost:5181",
  "http://127.0.0.1:5180",
  "http://localhost:5180",
]);
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export type ReviewAppDeps = {
  store: Store;
  repoRoot: string;
  /** Production build of the Vue app, served when present. Defaults to
   * `<repoRoot>/apps/web/dist`. */
  webDistDir?: string;
  port?: number;
};

export async function buildReviewApp(deps: ReviewAppDeps) {
  const { store, repoRoot } = deps;
  ensureReviewMetaTable(store);
  ensureReviewRelationsTable(store);
  const memory = new MemoryService(store);
  const retrieval = new KeywordRetrieval(store.db);
  const app: FastifyInstance = Fastify({ bodyLimit: 2_000_000, logger: false });
  const P = REVIEW_API_PREFIX;

  const reviewToken = process.env.REVIEW_TOKEN || "";

  // ---------------------------------------------------------------------
  // Request gate: token if configured, otherwise loopback + allowed Origin.
  // ---------------------------------------------------------------------
  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith(P)) return;
    if (reviewToken) {
      const candidate = String(req.headers.authorization || "").replace(
        /^Bearer /,
        "",
      );
      const a = Buffer.from(candidate);
      const b = Buffer.from(reviewToken);
      if (a.length !== b.length || !timingSafeEqual(a, b))
        return reply.code(401).send({ error: "Review token required" });
      return;
    }
    const host = new URL("http://" + (req.headers.host || "invalid")).hostname;
    if (!LOOPBACK_HOSTS.has(host))
      return reply.code(403).send({ error: "Local host required" });
    if (req.headers.origin) {
      const origin = String(req.headers.origin).replace(/\/$/, "");
      if (!ALLOWED_ORIGINS.has(origin))
        return reply.code(403).send({ error: "Cross-origin request rejected" });
    }
  });

  let syncing = false;
  let lastSync: SyncResult | null = null;

  const sourceList = (category?: string) => {
    const where = category
      ? "WHERE json_extract(r.body,'$.context.category') = ?"
      : "";
    const sql = `
      SELECT s.id AS sourceId, s.external_id AS externalId,
             r.id AS revisionId, r.title, r.version, r.created_at AS createdAt,
             json_extract(r.body,'$.context.category') AS category,
             json_extract(r.body,'$.context.filePath') AS filePath
      FROM sources s JOIN revisions r ON s.head = r.id
      ${where}
      ORDER BY r.created_at DESC`;
    const rows = (
      category ? store.db.prepare(sql).all(category) : store.db.prepare(sql).all()
    ) as Row[];
    return rows.map((r) => ({
      sourceId: String(r.sourceId),
      externalId: String(r.externalId),
      revisionId: String(r.revisionId),
      title: String(r.title),
      version: Number(r.version),
      createdAt: String(r.createdAt),
      category: r.category ? String(r.category) : null,
      filePath: r.filePath ? String(r.filePath) : null,
    }));
  };

  app.get(P + "/health", async () => {
    const sourceCount = Number(
      (store.db.prepare("SELECT COUNT(*) AS n FROM sources").get() as Row).n,
    );
    const fragmentCount = Number(
      (store.db.prepare("SELECT COUNT(*) AS n FROM fragments").get() as Row).n,
    );
    const status = readSyncStatus(repoRoot);
    return {
      mode: "review",
      dataDir: `${REVIEW_DIR}/data`,
      port: deps.port ?? Number(process.env.REVIEW_PORT ?? 5180),
      lastSyncCommit: status.lastSyncCommit,
      sourceCount,
      fragmentCount,
    };
  });

  app.get(P + "/categories", async () => {
    const rows = store.db
      .prepare(
        `SELECT json_extract(r.body,'$.context.category') AS category,
                COUNT(DISTINCT s.id) AS sourceCount,
                COUNT(f.id) AS fragmentCount
         FROM sources s
         JOIN revisions r ON s.head = r.id
         LEFT JOIN fragments f ON f.revision_id = r.id
         WHERE json_extract(r.body,'$.context.category') IS NOT NULL
         GROUP BY category`,
      )
      .all() as Row[];
    return rows.map((r) => ({
      id: String(r.category),
      name: categoryName(String(r.category)),
      sourceCount: Number(r.sourceCount),
      fragmentCount: Number(r.fragmentCount),
    }));
  });

  app.get<{ Querystring: { category?: string } }>(P + "/sources", async (req) =>
    sourceList(req.query.category),
  );

  app.get<{ Params: { id: string } }>(
    P + "/sources/:id/versions",
    async (req, reply) => {
      const rows = store.db
        .prepare(
          `SELECT r.id AS id, r.version AS version,
                  (s.head = r.id) AS current,
                  r.created_at AS createdAt,
                  json_extract(r.body,'$.context.contentHash') AS contentHash
           FROM revisions r JOIN sources s ON s.id = r.source_id
           WHERE r.source_id = ?
           ORDER BY r.version DESC`,
        )
        .all(req.params.id) as Row[];
      if (!rows.length)
        return reply.code(404).send({ error: "Source not found" });
      return rows.map((r) => ({
        id: String(r.id),
        version: Number(r.version),
        current: Boolean(r.current),
        createdAt: String(r.createdAt),
        contentHash: r.contentHash ? String(r.contentHash) : null,
      }));
    },
  );

  app.get<{ Params: { id: string } }>(
    P + "/revisions/:id",
    async (req, reply) =>
      store.revision(req.params.id) ??
      reply.code(404).send({ error: "Revision not found" }),
  );

  app.get<{ Params: { id: string } }>(
    P + "/fragments/:id",
    async (req, reply) => {
      const evidence = store.evidence(req.params.id);
      if (!evidence) return reply.code(404).send({ error: "Fragment not found" });
      const { fragment, revision } = evidence;
      return {
        id: fragment.id,
        revisionId: fragment.revisionId,
        ordinal: fragment.ordinal,
        text: fragment.text,
        revision: {
          id: revision.id,
          title: revision.title,
          version: revision.version,
          source: revision.source,
          createdAt: revision.createdAt,
          current: revision.current,
          context: revision.context,
        },
        provenance: revision.provenance ?? null,
      };
    },
  );

  app.get<{
    Params: { id: string };
  }>(P + "/fragments/:id/relations", async (req, reply) => {
    const evidence = store.evidence(req.params.id);
    if (!evidence) return reply.code(404).send({ error: "Fragment not found" });
    return { fragmentId: req.params.id, relations: relationsForFragment(store, req.params.id) };
  });

  app.get<{
    Querystring: { status?: string; type?: string };
  }>(P + "/relations", async (req) =>
    listReviewRelations(store, {
      status: req.query.status,
      type: req.query.type,
    }),
  );

  app.get<{ Querystring: { path?: string } }>(P + "/code-relations", async (req, reply) => {
    const path = (req.query.path ?? "").trim();
    if (!path) return reply.code(400).send({ error: "path query required" });
    return relationsForCodePath(store, path);
  });

  app.get(P + "/associations", async () => {
    let seedCount = 0;
    try {
      seedCount = loadAssociations(repoRoot).length;
    } catch {
      seedCount = 0;
    }
    return { seedCount, ...relationsSummary(store) };
  });

  app.get<{
    Querystring: { q?: string; category?: string; includeRemoved?: string };
  }>(P + "/search", async (req) => {
    const q = (req.query.q ?? "").trim();
    if (!q) return [];
    const includeRemoved = req.query.includeRemoved === "true";
    // Pull a broad pool first, then filter by category and removed status, then
    // take the top 20. Filtering after only top20 used to starve a category that
    // had lower-ranked-but-relevant hits once another category dominated.
    const candidates = retrieval.searchSources({ text: q, limit: 100 });
    const removed = includeRemoved ? new Set<string>() : removedSourceIds(store);
    const out: Record<string, unknown>[] = [];
    for (const c of candidates) {
      const revision = store.revision(c.sourceRevisionId);
      if (!revision) continue;
      if (!revision.current) continue; // only head/current revisions
      if (removed.has(revision.sourceId)) continue;
      const ctx = revision.context as unknown as {
        category?: string;
        filePath?: string;
      };
      if (req.query.category && ctx.category !== req.query.category) continue;
      const fragment = revision.fragments.find((f) => f.id === c.fragmentId);
      if (!fragment) continue;
      out.push({
        id: c.fragmentId,
        score: c.score,
        snippet: c.snippet,
        text: fragment.text,
        title: revision.title,
        version: revision.version,
        category: ctx.category ?? null,
        filePath: ctx.filePath ?? null,
      });
      if (out.length >= 20) break;
    }
    return out;
  });

  app.get(P + "/sync/status", async () => ({
    ...readSyncStatus(repoRoot),
    running: syncing,
    lastResult: lastSync,
  }));

  app.post(P + "/sync", async (_req, reply) => {
    if (syncing) return reply.code(409).send({ error: "Sync already running" });
    syncing = true;
    try {
      lastSync = await runReviewSync(store, repoRoot);
      return lastSync;
    } finally {
      syncing = false;
    }
  });

  app.get<{ Querystring: { path?: string } }>(P + "/code", async (req, reply) => {
    const path = (req.query.path ?? "").trim();
    if (!path) return reply.code(400).send({ error: "path query required" });
    const rows = sourceList();
    const match = rows.find((r) => r.filePath === path);
    return match ?? reply.code(404).send({ error: "Source not found" });
  });

  const web = deps.webDistDir ?? resolve(repoRoot, "apps/web/dist");
  if (existsSync(web))
    await app.register(staticFiles, { root: web, prefix: "/" });

  app.addHook("onClose", async () => {
    store.close();
  });

  return { app, store, memory, retrieval };
}
