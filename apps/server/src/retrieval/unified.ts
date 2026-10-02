import type { DatabaseSync } from "node:sqlite";
import type { EmbeddingModel } from "./embedding.js";
import type { RerankerModel } from "./reranker.js";
import { KeywordRetrieval } from "./keyword.js";
import { embeddingWindows } from "./semantic.js";
import {
  queryTerms,
  exactLookup,
  bestSnippet,
  relevance,
} from "./relevance.js";
import {
  RetrievalProjection,
  decodeUnit,
  indexText,
  UNIT_VERSION,
  type RetrievalUnit,
} from "./units.js";
import type { RetrievalHit, SearchQuery, SourceCandidate } from "./port.js";
import type { KnowledgeArtifact } from "../../../../packages/contracts/src/knowledge.js";

type ScoredUnit = {
  unit: RetrievalUnit;
  score: number;
  routes: string[];
  excerpt?: string;
};
const normalize = (v: number[]) => {
  const norm = Math.hypot(...v);
  if (!norm || v.some((x) => !Number.isFinite(x)))
    throw Error("Invalid embedding vector");
  return v.map((x) => x / norm);
};

/** All reader and Agent searches use these units. The legacy source port only
 * projects the same results back to immutable evidence for older processors. */
export class UnifiedRetrieval extends KeywordRetrieval {
  private projection: RetrievalProjection;
  private model?: EmbeddingModel;
  private loading?: Promise<EmbeddingModel>;
  private reranker?: RerankerModel;
  private rankingLoad?: Promise<RerankerModel>;
  private timer?: ReturnType<typeof setTimeout>;
  private work: Promise<number> | null = null;
  private stopped = false;
  private error: string | null = null;
  private rankingError: string | null = null;
  constructor(
    private database: DatabaseSync,
    private load?: () => Promise<EmbeddingModel>,
    private loadReranker?: () => Promise<RerankerModel>,
    private readOnly = false,
  ) {
    super(database);
    this.projection = new RetrievalProjection(database);
  }

  private sync() {
    if (!this.readOnly) this.projection.sync();
  }
  private async syncAsync() {
    if (!this.readOnly) await this.projection.syncAsync();
  }
  private ready() {
    this.loading ??= this.load!().then((model) => (this.model = model));
    return this.loading;
  }
  private get modelId() {
    return this.model ? UNIT_VERSION + ":" + this.model.id : null;
  }
  start() {
    const tick = async () => {
      if (this.stopped) return;
      try {
        await this.syncAsync();
        if (this.load) await this.indexBatch();
      } catch (error) {
        this.error = String(error);
      }
      if (!this.stopped) {
        this.timer = setTimeout(tick, this.error ? 30_000 : 1000);
        this.timer.unref();
      }
    };
    // Let the HTTP listener start before catch-up work over a fresh corpus.
    this.timer = setTimeout(tick, 100);
    this.timer.unref();
  }
  override health() {
    const total = Number(
      this.database.prepare("SELECT count(*) n FROM retrieval_units").get()!.n,
    );
    const indexed = this.modelId
      ? Number(
          this.database
            .prepare(
              "SELECT count(*) n FROM retrieval_unit_vector_heads WHERE model_id=?",
            )
            .get(this.modelId)!.n,
        )
      : 0;
    return {
      available: true,
      backend: "sqlite-context-bm25-bge@1",
      projection: UNIT_VERSION,
      units: total,
      semantic: {
        model: this.modelId,
        state: this.error
          ? "degraded"
          : !this.load
            ? "disabled"
            : this.model && indexed === total && !this.projection.preparing
              ? "ready"
              : "indexing",
        indexed,
        pending: total - indexed,
        error: this.error,
      },
      reranker: {
        model: this.reranker?.id ?? null,
        state: this.rankingError
          ? "degraded"
          : this.reranker
            ? "ready"
            : this.loadReranker
              ? "pending"
              : "disabled",
        error: this.rankingError,
      },
    };
  }
  indexBatch(limit = 8): Promise<number> {
    if (!this.load) {
      this.sync();
      return Promise.resolve(0);
    }
    if (this.work) return this.work;
    this.work = this.index(limit)
      .catch((error) => {
        this.error = String(error);
        throw error;
      })
      .finally(() => (this.work = null));
    return this.work;
  }
  private async index(limit: number) {
    await this.syncAsync();
    const model = await this.ready();
    if (!limit || this.readOnly) return 0;
    const rows = this.database
      .prepare(
        `SELECT u.* FROM retrieval_units u WHERE NOT EXISTS (
      SELECT 1 FROM retrieval_unit_vector_heads h WHERE h.unit_id=u.id AND h.model_id=?) LIMIT ?`,
      )
      .all(this.modelId, limit);
    for (const row of rows) {
      if (this.stopped) break;
      const unit = decodeUnit(row),
        windows = embeddingWindows(unit.text),
        vectors: number[][] = [];
      for (let i = 0; i < windows.length; i += 16) {
        const batch = windows.slice(i, i + 16);
        const result = await model.embed(
          batch.map(
            (w) =>
              unit.context.slice(0, 180) +
              "\n" +
              unit.text.slice(w.start, w.end).replace(/\[\[[\w-]+\]\]/g, ""),
          ),
          "passage",
        );
        if (result.length !== batch.length)
          throw Error("Embedding batch size mismatch");
        vectors.push(...result.map(normalize));
      }
      // A source can change while embedding is running; obsolete units cannot return.
      if (
        !this.database
          .prepare("SELECT 1 FROM retrieval_units WHERE id=?")
          .get(unit.id)
      )
        continue;
      this.database.exec("BEGIN IMMEDIATE");
      try {
        for (let i = 0; i < windows.length; i++) {
          const vector = new Float32Array(vectors[i]!);
          this.database
            .prepare(
              "INSERT OR REPLACE INTO retrieval_unit_vectors VALUES(?,?,?,?,?,?)",
            )
            .run(
              unit.id,
              this.modelId,
              i,
              windows[i]!.start,
              windows[i]!.end,
              Buffer.from(vector.buffer),
            );
        }
        this.database
          .prepare(
            "INSERT OR REPLACE INTO retrieval_unit_vector_heads VALUES(?,?)",
          )
          .run(unit.id, this.modelId);
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    }
    this.error = null;
    return rows.length;
  }
  private eligible(u: RetrievalUnit, q: SearchQuery) {
    if (
      q.purpose === "follow-up" &&
      u.kind === "task" &&
      !["open", "waiting"].includes(u.subtype)
    )
      return false;
    if (q.project_id && q.project_trusted && u.target.kind === "memory") {
      const memory = this.database
        .prepare("SELECT scope FROM memories WHERE id=?")
        .get(u.target.id);
      const scope = memory ? JSON.parse(String(memory.scope)) : {};
      if (
        typeof scope.project_id === "string" &&
        scope.project_id !== q.project_id
      )
        return false;
    }
    if (q.kinds && !q.kinds.includes(u.kind)) return false;
    if (
      q.topicPath?.length &&
      !q.topicPath.every((part, i) => u.topicPath[i] === part)
    )
      return false;
    if (
      q.visible &&
      (!u.visibilityIds.length || !u.visibilityIds.every(q.visible))
    )
      return false;
    if (
      q.timeRange?.from &&
      Date.parse(u.provenance.time ?? "") < Date.parse(q.timeRange.from)
    )
      return false;
    if (
      q.timeRange?.to &&
      Date.parse(u.provenance.time ?? "") > Date.parse(q.timeRange.to)
    )
      return false;
    return true;
  }
  private lexical(q: SearchQuery): ScoredUnit[] {
    this.sync();
    const terms = queryTerms(q.text);
    if (!terms.length) return [];
    const phrase = [
      ...new Set(terms.flatMap((term) => indexText(term).split(" "))),
    ]
      .filter(Boolean)
      .map((t) => '"' + t.replaceAll('"', '""') + '"')
      .join(" OR ");
    const rows = this.database
      .prepare(
        `SELECT u.*,bm25(retrieval_units_fts,0,2,1,4) rank FROM retrieval_units_fts
      JOIN retrieval_units u ON u.id=retrieval_units_fts.id WHERE retrieval_units_fts MATCH ? ORDER BY rank`,
      )
      .all(phrase);
    return rows
      .flatMap((row) => {
        const unit = decodeUnit(row);
        if (!this.eligible(unit, q)) return [];
        const exact = exactLookup(q.text);
        if (
          exact &&
          !(unit.text + "\n" + unit.context)
            .toLowerCase()
            .includes(q.text.trim().toLowerCase())
        )
          return [];
        if (
          !exact &&
          !relevance(
            unit.text +
              "\n" +
              unit.headingPath.join(" ") +
              (unit.kind === "task" || unit.kind === "memory"
                ? "\n" + unit.title + "\n" + unit.context
                : ""),
            terms,
          )
        )
          return [];
        return [
          {
            unit,
            score: -Number(row.rank),
            routes: [
              "bm25",
              ...(exact && unit.subtype === "code" ? ["code-symbol"] : []),
            ],
          },
        ];
      })
      .slice(0, 250);
  }
  async search(q: SearchQuery): Promise<RetrievalHit[]> {
    await this.syncAsync();
    const lexical = this.lexical(q);
    if (!q.text.trim() || exactLookup(q.text) || !this.model)
      return this.finish(lexical, q);
    const dense = new Map<string, ScoredUnit>();
    try {
      const [raw] = await this.model.embed([q.text.slice(0, 400)], "query"),
        vector = normalize(raw!);
      const units = new Map(
        this.database
          .prepare("SELECT * FROM retrieval_units")
          .all()
          .map(decodeUnit)
          .filter((u) => this.eligible(u, q))
          .map((u) => [u.id, u]),
      );
      for (const row of this.database
        .prepare(
          `SELECT unit_id,vector,start_offset,end_offset FROM retrieval_unit_vectors WHERE model_id=?`,
        )
        .all(this.modelId)) {
        const unit = units.get(String(row.unit_id));
        if (!unit) continue;
        const bytes = row.vector as Uint8Array;
        const stored = new Float32Array(
          bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength,
          ),
        );
        if (stored.length !== vector.length)
          throw Error("Embedding dimensions changed without new identity");
        const score = vector.reduce((n, v, i) => n + v * stored[i]!, 0);
        if (score <= (dense.get(unit.id)?.score ?? -Infinity)) continue;
        dense.set(unit.id, {
          unit,
          score,
          routes: ["semantic"],
          excerpt: unit.text.slice(
            Number(row.start_offset),
            Number(row.end_offset),
          ),
        });
      }
    } catch (error) {
      this.error = String(error);
      return this.finish(lexical, q);
    }
    const sorted = [...dense.values()].sort((a, b) => b.score - a.score);
    const floor = Math.max(0.4, (sorted[0]?.score ?? 1) - 0.075);
    const accepted = sorted.filter((h) => h.score >= floor).slice(0, 100);
    const fused = new Map<string, ScoredUnit>(),
      scale = Math.max(...lexical.map((h) => h.score), 1e-6);
    for (const branch of [lexical.slice(0, 100), accepted])
      branch.forEach((h, rank) => {
        const prior = fused.get(h.unit.id);
        const quality = h.routes.includes("semantic")
          ? (h.score - 0.3) / 0.7
          : h.score / scale;
        fused.set(h.unit.id, {
          ...h,
          score: (prior?.score ?? 0) + quality / (61 + rank),
          routes: [...new Set([...(prior?.routes ?? []), ...h.routes])],
        });
      });
    let hits = [...fused.values()];
    if (this.loadReranker && hits.length) {
      try {
        this.rankingLoad ??= this.loadReranker().then(
          (model) => (this.reranker = model),
        );
        const model = await this.rankingLoad,
          pool = hits.sort((a, b) => b.score - a.score).slice(0, 40);
        const scores = await model.score(
          q.text,
          pool.map(
            (h) =>
              h.unit.context + "\n" + (h.excerpt ?? h.unit.text).slice(0, 1200),
          ),
        );
        const max = Math.max(...pool.map((h) => h.score), 1e-6);
        hits = pool.flatMap((h, i) =>
          scores[i]! >= 0.1 || h.routes.includes("code-symbol")
            ? [
                {
                  ...h,
                  score: scores[i]! * 0.7 + (h.score / max) * 0.3,
                  routes: [...h.routes, "cross-encoder"],
                },
              ]
            : [],
        );
        this.rankingError = null;
      } catch (error) {
        this.rankingError = String(error);
      }
    }
    return this.finish(hits, q);
  }
  private finish(hits: ScoredUnit[], q: SearchQuery): RetrievalHit[] {
    const articles = new Map<string, KnowledgeArtifact>();
    const preference = (u: RetrievalUnit) => {
      switch (q.purpose) {
        case "concept":
          return u.kind === "knowledge" ? 1.35 : 1;
        case "implementation":
          return u.subtype === "code"
            ? 1.35
            : u.kind === "knowledge"
              ? 1.15
              : 1;
        case "background":
          return u.kind === "knowledge" || u.kind === "memory" ? 1.3 : 1;
        case "follow-up":
          return u.kind === "task"
            ? 1.5
            : u.kind === "memory" || u.subtype === "conversation"
              ? 1.2
              : 1;
        default:
          return 1;
      }
    };
    const priority = (u: RetrievalUnit) => {
      const definition =
        exactLookup(q.text) &&
        u.headingPath.at(-1)?.toLowerCase() === q.text.trim().toLowerCase()
          ? 2
          : 1;
      if (
        q.purpose !== "follow-up" ||
        (!["task", "memory"].includes(u.kind) && u.subtype !== "conversation")
      )
        return preference(u) * definition;
      const event = Date.parse(u.eventAt ?? "");
      const ageDays = Math.max(0, (Date.now() - event) / 86_400_000);
      return (
        preference(u) *
        (Number.isFinite(ageDays) ? 1 + 0.15 * Math.exp(-ageDays / 30) : 1)
      );
    };
    const owners = new Map<string, number>(),
      seen = new Set<string>(),
      output: RetrievalHit[] = [];
    const terms = queryTerms(q.text);
    for (const h of hits.sort(
      (a, b) => b.score * priority(b.unit) - a.score * priority(a.unit),
    )) {
      if (!this.eligible(h.unit, q)) continue;
      const u = h.unit,
        fingerprint = u.text.replace(/\s+/g, " ").trim();
      if (
        q.diversify !== false &&
        ((owners.get(u.owner) ?? 0) >= 2 || seen.has(fingerprint))
      )
        continue;
      owners.set(u.owner, (owners.get(u.owner) ?? 0) + 1);
      seen.add(fingerprint);
      const text = (
        u.kind === "knowledge" && u.text.length <= 1200
          ? u.text
          : (h.excerpt ?? bestSnippet(u.text, terms, 800))
      ).trim();
      let citations: RetrievalHit["citations"];
      if (u.target.kind === "knowledge") {
        const revision = u.target.revision;
        if (!articles.has(revision)) {
          const row = this.database
            .prepare("SELECT artifact FROM knowledge_revisions WHERE id=?")
            .get(revision);
          if (row) articles.set(revision, JSON.parse(String(row.artifact)));
        }
        citations = articles
          .get(revision)
          ?.document.citations.filter((c) => text.includes("[[" + c.key + "]]"))
          .map((c) => ({
            key: c.key,
            label: c.label,
            reason: c.reason,
            relation: c.relation,
            target: c.target,
            actionable: true,
          }));
      }
      output.push({
        id: u.id,
        kind: u.kind,
        title: u.title,
        text,
        context: u.context,
        headingPath: u.headingPath,
        score: h.score * priority(u),
        routes: [...h.routes, "purpose:" + (q.purpose ?? "balanced")],
        target: u.target,
        references: u.references,
        citations,
        provenance: u.provenance,
        eventAt: u.eventAt,
      });
      if (output.length >= (q.limit ?? 20)) break;
    }
    return output;
  }
  override searchSources(q: SearchQuery): SourceCandidate[] {
    return this.sources(
      this.finish(this.lexical({ ...q, kinds: ["source"] }), q),
      q,
    );
  }
  async searchSourcesAsync(q: SearchQuery): Promise<SourceCandidate[]> {
    return this.sources(await this.search({ ...q, kinds: ["source"] }), q);
  }
  private sources(hits: RetrievalHit[], q: SearchQuery): SourceCandidate[] {
    const seen = new Set<string>();
    return hits
      .flatMap((h) =>
        h.references.flatMap((r) =>
          r.fragmentIds.flatMap((id) => {
            if (seen.has(id) || (q.visible && !q.visible(id))) return [];
            seen.add(id);
            return [
              {
                id,
                fragmentId: id,
                sourceRevisionId: r.revisionId,
                score: h.score,
                snippet: h.text,
                routes: h.routes,
                provenance: h.provenance,
              },
            ];
          }),
        ),
      )
      .slice(0, q.limit ?? 20);
  }
  async close() {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.projection.settle().catch(() => {});
    await this.work?.catch(() => {});
    await this.loading?.catch(() => {});
    await this.model?.close();
    await this.reranker?.close();
  }
}
