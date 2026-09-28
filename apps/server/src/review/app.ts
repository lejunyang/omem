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
import { KeywordRetrieval, tokenize } from "../retrieval/keyword.js";
import {
  categoryName,
  readSyncStatus,
  runReviewSync,
  type SyncResult,
} from "./sync.js";
import {
  REVIEW_DIR,
  EXTERNAL_ID_PREFIX,
  ensureReviewMetaTable,
  ensureReviewRelationsTable,
  relationsForFragment,
  listReviewRelations,
  relationsSummary,
  relationsForCodePath,
} from "./store.js";
import { loadAssociations } from "./associations.js";
import { CodeKnowledgeService } from "../code/sync.js";
import {
  listUnderstandings,
  understandingDetail,
  modelAvailability,
} from "../code/understanding-store.js";

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
  const code = new CodeKnowledgeService(store, repoRoot);
  let codeSyncing = false;
  let lastCodeSync: Awaited<ReturnType<typeof code.sync>> | null = null;
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

  // ---------------------------------------------------------------------
  // Search: category / current / removed are filtered in SQL (JOINed onto the
  // same query that matches fragments), never after a fixed top-N pull. This
  // guarantees a low-ranked hit inside a requested category is still returned
  // even when hundreds of higher-ranked hits live in other categories — the
  // KeywordRetrieval per-term LIMIT 200 / caller top-N cannot starve it.
  // ---------------------------------------------------------------------
  const snippetFor = (text: string, query: string, radius = 80): string => {
    const flat = text.replace(/\s+/g, " ").trim();
    const terms = tokenize(query);
    const hit = terms
      .map((t) => flat.toLowerCase().indexOf(t.toLowerCase()))
      .find((i) => i >= 0);
    if (hit === undefined) return flat.slice(0, radius * 2);
    const start = Math.max(0, hit - radius);
    return (start > 0 ? "…" : "") + flat.slice(start, start + radius * 2);
  };

  type SearchHit = {
    id: string;
    score: number;
    snippet: string;
    text: string;
    title: string;
    version: number;
    category: string | null;
    filePath: string | null;
  };

  const reviewSearch = (
    q: string,
    opts: { category?: string; includeRemoved?: boolean },
  ): SearchHit[] => {
    const terms = tokenize(q);
    if (!terms.length) return [];
    const best = new Map<
      string,
      { row: Row; score: number; matched: Set<string> }
    >();
    for (const term of terms) {
      const escaped = "%" + term.replace(/[!%_]/g, "!$&") + "%";
      const where: string[] = ["f.text LIKE ? ESCAPE '!'"];
      const params: string[] = [escaped];
      if (!opts.includeRemoved)
        where.push("(m.removed IS NULL OR m.removed = 0)");
      if (opts.category) {
        where.push("json_extract(r.body,'$.context.category') = ?");
        params.push(opts.category);
      }
      // s.head = r.id pins us to the current/head revision, so old revisions
      // are excluded without an extra predicate.
      const sql = `SELECT f.id AS fragment_id, f.revision_id, f.text AS fragment_text,
                      r.title AS title, r.version AS version,
                      json_extract(r.body,'$.context.category') AS category,
                      json_extract(r.body,'$.context.filePath') AS filePath
                   FROM fragments f
                   JOIN revisions r ON r.id = f.revision_id
                   JOIN sources s ON s.head = r.id
                   LEFT JOIN review_source_meta m ON m.source_id = s.id
                   WHERE ${where.join(" AND ")}`;
      const rows = store.db.prepare(sql).all(...params) as Row[];
      for (const row of rows) {
        const id = String(row.fragment_id);
        const cur =
          best.get(id) ?? { row, score: 0, matched: new Set<string>() };
        if (!cur.matched.has(term)) {
          cur.matched.add(term);
          cur.score +=
            term.length >= 4 ? 4 : term.length >= 3 ? 3 : term.length >= 2 ? 2 : 1;
        }
        best.set(id, cur);
      }
    }
    return [...best.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, 20)
      .map(({ row, score }) => ({
        id: String(row.fragment_id),
        score,
        snippet: snippetFor(String(row.fragment_text), q),
        text: String(row.fragment_text),
        title: String(row.title),
        version: Number(row.version),
        category: row.category != null ? String(row.category) : null,
        filePath: row.filePath != null ? String(row.filePath) : null,
      }));
  };

  app.get<{
    Querystring: { q?: string; category?: string; includeRemoved?: string };
  }>(P + "/search", async (req) => {
    const q = (req.query.q ?? "").trim();
    if (!q) return [];
    return reviewSearch(q, {
      category: req.query.category,
      includeRemoved: req.query.includeRemoved === "true",
    });
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

  // ---------------------------------------------------------------------
  // Code Knowledge read surface (deterministic graph; no model required).
  // ---------------------------------------------------------------------
  const CP = P + "/code";

  app.get(CP + "/repositories", async () => code.listRepositories());

  app.get(CP + "/snapshots", async () => code.listSnapshots());

  app.get<{ Params: { id: string } }>(CP + "/snapshots/:id", async (req, reply) => {
    const snap = code.listSnapshots().find((s) => s.snapshotId === req.params.id);
    return snap ?? reply.code(404).send({ error: "Snapshot not found" });
  });

  app.get(CP + "/current-snapshot", async () => code.currentSnapshot());

  app.get(CP + "/modules", async () => {
    // Group files by their first two path segments (e.g. apps/server, packages/contracts).
    const files = code.listFiles({});
    const groups = new Map<string, number>();
    for (const f of files) {
      const segs = f.path.split("/");
      const mod = segs.length >= 2 ? segs.slice(0, 2).join("/") : (segs[0] ?? f.path);
      groups.set(mod, (groups.get(mod) ?? 0) + 1);
    }
    return [...groups.entries()]
      .map(([module, fileCount]) => ({ module, fileCount }))
      .sort((a, b) => b.fileCount - a.fileCount);
  });

  app.get<{ Querystring: { language?: string; includeRemoved?: string } }>(
    CP + "/files",
    async (req) =>
      code.listFiles({
        language: req.query.language,
        includeRemoved: req.query.includeRemoved === "true",
      }),
  );

  app.get<{ Params: { id: string } }>(CP + "/files/:id", async (req, reply) => {
    const f = code.fileById(req.params.id);
    return f ?? reply.code(404).send({ error: "File not found" });
  });

  app.get<{ Params: { id: string } }>(CP + "/files/:id/symbols", async (req) =>
    code.symbolsOfFile(req.params.id),
  );

  // Source range: return the head-revision text slice for a line range. Used to
  // show the exact source behind a symbol/edge. Out-of-range → 400.
  app.get<{
    Params: { id: string };
    Querystring: { startLine?: string; endLine?: string };
  }>(CP + "/files/:id/source", async (req, reply) => {
    const file = code.fileById(req.params.id);
    if (!file) return reply.code(404).send({ error: "File not found" });
    const start = Number(req.query.startLine ?? 1);
    const end = Number(req.query.endLine ?? 1);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 1 || end < start)
      return reply.code(400).send({ error: "invalid line range" });
    // Reconstruct head revision text from captured parts.
    const srcRow = store.db
      .prepare("SELECT id FROM sources WHERE namespace='file' AND external_id=?")
      .get(EXTERNAL_ID_PREFIX + file.path) as { id: string } | undefined;
    if (!srcRow) return reply.code(404).send({ error: "File not captured" });
    const headRev = store.db
      .prepare("SELECT head FROM sources WHERE id=?")
      .get(String(srcRow.id)) as { head: string | null } | undefined;
    if (!headRev?.head) return reply.code(404).send({ error: "No head revision" });
    const rev = store.revision(String(headRev.head));
    if (!rev) return reply.code(404).send({ error: "Revision not found" });
    const text = rev.parts
      .map((p) => (p.type === "text" ? p.text : ""))
      .join("\n");
    const lines = text.split("\n");
    if (end > lines.length)
      return reply
        .code(400)
        .send({ error: `endLine ${end} beyond file (${lines.length} lines)` });
    return {
      path: file.path,
      startLine: start,
      endLine: end,
      totalLines: lines.length,
      text: lines.slice(start - 1, end).join("\n"),
    };
  });

  app.get<{ Params: { id: string } }>(CP + "/symbols/:id", async (req, reply) => {
    const row = store.db
      .prepare("SELECT * FROM code_symbols WHERE symbol_id=?")
      .get(req.params.id) as Row | undefined;
    if (!row) return reply.code(404).send({ error: "Symbol not found" });
    return {
      symbolId: String(row.symbol_id),
      fileId: String(row.file_id),
      snapshotId: String(row.snapshot_id),
      name: String(row.name),
      qualifiedName: String(row.qualified_name),
      kind: String(row.kind),
      rangeStart: row.range_start ? JSON.parse(String(row.range_start)) : null,
      rangeEnd: row.range_end ? JSON.parse(String(row.range_end)) : null,
      fragmentId: row.fragment_id ? String(row.fragment_id) : null,
      exported: Number(row.exported) === 1,
      signature: row.signature ? String(row.signature) : null,
    };
  });

  app.get<{ Params: { id: string } }>(CP + "/symbols/:id/edges", async (req) =>
    code.edgesOf({ symbolId: req.params.id }, { includeStale: false }),
  );

  app.get<{ Querystring: { symbolId?: string; fileId?: string; includeStale?: string } }>(
    CP + "/edges",
    async (req) => {
      if (!req.query.symbolId && !req.query.fileId)
        return { edges: [] };
      return code.edgesOf(
        { symbolId: req.query.symbolId, fileId: req.query.fileId },
        { includeStale: req.query.includeStale === "true" },
      );
    },
  );

  app.get<{ Querystring: { snapshotId?: string; includeStale?: string } }>(
    CP + "/graph",
    async (req) =>
      code.graph({
        snapshotId: req.query.snapshotId,
        includeStale: req.query.includeStale === "true",
      }),
  );

  app.get<{ Querystring: { type?: string; id?: string } }>(
    CP + "/understanding",
    async (req) => {
      const type = req.query.type;
      const id = req.query.id;
      if (type !== "file" && type !== "symbol" || !id)
        return { understanding: null };
      return { understanding: code.understandingOf({ type, id }) };
    },
  );

  app.get(CP + "/model-status", async () => ({
    ...modelAvailability(),
    graphEndpoints: ["/api/review/code/graph", "/api/review/code/files", "/api/review/code/symbols"],
  }));

  // Read-only Code Understanding surface. Curated seeds are projected onto the
  // head graph; there is no generation endpoint here (no production model).
  app.get<{ Querystring: { all?: string } }>(CP + "/understandings", async (req) => {
    const rows = listUnderstandings(store, { all: req.query.all === "true" });
    return {
      model: modelAvailability(),
      count: rows.length,
      items: rows.map((r) => ({
        understandingId: String(r.understanding_id),
        targetType: String(r.target_type),
        targetId: String(r.target_id),
        snapshotId: String(r.snapshot_id),
        role: String(r.role_id),
        status: String(r.status),
        confidence: r.confidence == null ? null : Number(r.confidence),
        seed: Number(r.seed) === 1,
        verifiedByAgent: Number(r.verified_by_agent) === 1,
        verifiedBy: r.verified_by ? String(r.verified_by) : null,
        stale: Number(r.stale) === 1,
        source: String(r.source),
        curatedBy: r.curated_by ? String(r.curated_by) : null,
        curatedAt: r.curated_at ? String(r.curated_at) : null,
        generatedAt: String(r.generated_at),
        supersedesId: r.supersedes_id ? String(r.supersedes_id) : null,
      })),
    };
  });

  app.get<{ Params: { id: string } }>(CP + "/understandings/:id", async (req, reply) => {
    const row = understandingDetail(store, req.params.id);
    if (!row) return reply.code(404).send({ error: "Understanding not found" });
    return {
      understandingId: String(row.understanding_id),
      targetType: String(row.target_type),
      targetId: String(row.target_id),
      snapshotId: String(row.snapshot_id),
      role: String(row.role_id),
      status: String(row.status),
      confidence: row.confidence == null ? null : Number(row.confidence),
      seed: Number(row.seed) === 1,
      verifiedByAgent: Number(row.verified_by_agent) === 1,
      verifiedBy: row.verified_by ? String(row.verified_by) : null,
      stale: Number(row.stale) === 1,
      source: String(row.source),
      curatedBy: row.curated_by ? String(row.curated_by) : null,
      curatedAt: row.curated_at ? String(row.curated_at) : null,
      curatedNote: row.curated_note ? String(row.curated_note) : null,
      generatedAt: String(row.generated_at),
      supersedesId: row.supersedes_id ? String(row.supersedes_id) : null,
      inputHash: String(row.input_hash),
      promptHash: row.prompt_hash ? String(row.prompt_hash) : null,
      schemaDigest: row.schema_digest ? String(row.schema_digest) : null,
      unknowns: (() => {
        try { return JSON.parse(String(row.unknowns || "[]")); } catch { return []; }
      })(),
      output: row.output,
      refs: (row.refs as Row[]).map((r) => ({
        kind: String(r.ref_kind),
        id: String(r.ref_id),
        selector: r.selector ? JSON.parse(String(r.selector)) : null,
        note: r.note ? String(r.note) : "",
      })),
    };
  });

  app.post(CP + "/sync", async (_req, reply) => {
    if (codeSyncing) return reply.code(409).send({ error: "Code sync already running" });
    codeSyncing = true;
    try {
      lastCodeSync = await code.sync();
      return lastCodeSync;
    } finally {
      codeSyncing = false;
    }
  });

  const web = deps.webDistDir ?? resolve(repoRoot, "apps/web/dist");
  if (existsSync(web))
    await app.register(staticFiles, { root: web, prefix: "/" });

  app.addHook("onClose", async () => {
    store.close();
  });

  return { app, store, memory, retrieval };
}
