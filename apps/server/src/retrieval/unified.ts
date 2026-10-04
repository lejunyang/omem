import type { DatabaseSync } from "node:sqlite";
import type { EmbeddingModel } from "./embedding.js";
import type { RerankerModel } from "./reranker.js";
import { KeywordRetrieval } from "./keyword.js";
import { embeddingWindows } from "./semantic.js";
import {
  queryTerms,
  exactLookup,
  bestSnippet,
  querySymbols,
  asksForCallers,
} from "./relevance.js";
import { CodeNavigation } from "./code-navigation.js";
import { rerankPassages } from "./rerank-passages.js";
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
  codeMatches?: RetrievalHit["codeMatches"];
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
  private navigation: CodeNavigation;
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
    this.navigation = new CodeNavigation(database);
  }

  private sync() {
    if (!this.readOnly) this.projection.sync();
  }
  private async syncAsync() {
    if (!this.readOnly) await this.projection.syncAsync();
  }
  private ready() {
    this.loading ??= this.load!()
      .then((model) => (this.model = model))
      .catch((error) => {
        // A failed startup is not a loaded model. Let the background worker's
        // existing 30-second backoff retry instead of caching rejection forever.
        this.loading = undefined;
        throw error;
      });
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
      this.database.exec("BEGIN IMMEDIATE");
      try {
        // Check under the writer lock: another maintenance process may replace
        // this unit while embedding runs, or between an unlocked check and BEGIN.
        if (
          !this.database
            .prepare("SELECT 1 FROM retrieval_units WHERE id=?")
            .get(unit.id)
        ) {
          this.database.exec("ROLLBACK");
          continue;
        }
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
    const description = u.materialDescription?.description;
    if (
      q.materialRoles?.length &&
      !q.materialRoles.includes(description?.role ?? "unknown")
    )
      return false;
    if (q.effectiveAt && description) {
      const at = Date.parse(q.effectiveAt);
      if (description.validFrom && at < Date.parse(description.validFrom))
        return false;
      if (description.validUntil && at >= Date.parse(description.validUntil))
        return false;
    }
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
  private applicability(u: RetrievalUnit, q: SearchQuery) {
    const d = u.materialDescription?.description;
    if (!d || q.materialRoles?.length || q.purpose === "background") return 1;
    // Navigation preferences, not truth decisions. Unknown sources remain fully
    // eligible; explicit role/history searches retain plans and research.
    const role = {
      reference: 1,
      implementation: 1,
      plan: 0.45,
      research: 0.55,
      record: 0.9,
      example: 0.5,
      unknown: 1,
    }[d.role];
    const state =
      d.status === "superseded"
        ? 0.4
        : d.status === "proposed"
          ? 0.65
          : d.status === "historical"
            ? 0.8
            : 1;
    return role * state;
  }
  private namedDefinition(unit: RetrievalUnit, q: SearchQuery) {
    if (unit.kind !== "source" || unit.subtype !== "code") return false;
    const name = unit.headingPath.at(-1)?.toLowerCase();
    return querySymbols(q.text).some(
      (term) =>
        /^[a-z_$][\w$.]*$/.test(term) &&
        (name === term || name?.endsWith("." + term)),
    );
  }
  private symbols(q: SearchQuery): ScoredUnit[] {
    const names = querySymbols(q.text);
    if (!names.length) return [];
    const definition = "lower(json_extract(heading_path, '$[#-1]'))";
    // AST-backed operation names have their own route. They must not depend on
    // a whole-question BM25 rank surviving its candidate cutoff.
    const rows = this.database
      .prepare(
        `SELECT * FROM retrieval_units
      WHERE kind='source' AND subtype='code' AND (${names
        .map(
          () =>
            `(${definition}=? OR substr(${definition},-length(?)-1)='.'||?)`,
        )
        .join(" OR ")})
      ORDER BY owner,id`,
      )
      .all(...names.flatMap((name) => [name, name, name]));
    return rows
      .map(decodeUnit)
      .filter((unit) => this.eligible(unit, q))
      .map((unit) => ({
        unit,
        score: 1,
        routes: ["code-symbol"],
      }));
  }
  private navigationCandidates(
    q: SearchQuery,
  ): { query: SearchQuery; hits: ScoredUnit[] } | null {
    if (q.codeIntent)
      return {
        query: q,
        hits: q.codeIntent === "callers" ? this.callers(q) : this.symbols(q),
      };
    if (querySymbols(q.text).length && asksForCallers(q.text)) {
      const hits = this.callers(q);
      // An inferred shortcut is not an explicit filter. Unsupported languages
      // or missing AST call sites still get ordinary text/semantic recall.
      if (hits.length) return { query: { ...q, codeIntent: "callers" }, hits };
    }
    return null;
  }
  private callers(q: SearchQuery): ScoredUnit[] {
    const names = querySymbols(q.text);
    if (!names.length) return [];
    const units = this.database
      .prepare(
        `SELECT * FROM retrieval_units
      WHERE kind='source' AND subtype='code' AND (${names.map(() => "instr(lower(text),?)>0").join(" OR ")})`,
      )
      .all(...names.map((n) => n.split(".").at(-1)!))
      .map(decodeUnit)
      .filter((u) => this.eligible(u, q));
    const span = (u: RetrievalUnit) =>
      u.target.kind === "source"
        ? u.target.endLine - u.target.startLine
        : Infinity;
    const seen = new Set<string>();
    // Prefer the smallest enclosing operation over an overlapping outer function.
    return units
      .sort((a, b) => span(a) - span(b) || a.id.localeCompare(b.id))
      .flatMap((unit) => {
        if (unit.target.kind !== "source") return [];
        const target = unit.target;
        const matches = this.navigation.matches(unit, names).flatMap((m) => {
          const lines = m.lines.filter(
            (line) => !seen.has(`${target.revisionId}:${line}:${m.symbol}`),
          );
          for (const line of lines)
            seen.add(`${target.revisionId}:${line}:${m.symbol}`);
          return lines.length ? [{ ...m, lines }] : [];
        });
        if (!matches.length) return [];
        const line =
          Math.min(...matches.flatMap((m) => m.lines)) - target.startLine;
        return [
          {
            unit,
            score: 1,
            routes: ["code-call-candidate"],
            codeMatches: matches,
            excerpt: unit.text
              .split("\n")
              .slice(Math.max(0, line - 3), line + 12)
              .join("\n"),
          },
        ];
      });
  }
  private fuse(branches: ScoredUnit[][]): ScoredUnit[] {
    const fused = new Map<string, ScoredUnit>();
    for (const branch of branches) {
      const scale = Math.max(...branch.map((h) => h.score), 1e-6);
      branch.forEach((h, rank) => {
        const prior = fused.get(h.unit.id);
        const quality = h.routes.includes("semantic")
          ? (h.score - 0.3) / 0.7
          : h.score / scale;
        fused.set(h.unit.id, {
          ...h,
          // The symbol route contributes navigation; it must not overwrite a
          // query-relevant dense window with the beginning of the same method.
          excerpt: prior?.excerpt ?? h.excerpt,
          score: (prior?.score ?? 0) + quality / (61 + rank),
          routes: [...new Set([...(prior?.routes ?? []), ...h.routes])],
        });
      });
    }
    return [...fused.values()];
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
        `SELECT id,bm25(retrieval_units_fts,0,2,1,4) rank FROM retrieval_units_fts
      WHERE retrieval_units_fts MATCH ? ORDER BY rank`,
      )
      .iterate(phrase);
    const pool: ScoredUnit[] = [];
    // Sort only IDs/scores in SQLite. Carrying every full source through its
    // sort buffer is costly even when JavaScript stops consuming rows early.
    const readUnit = this.database.prepare(
      "SELECT * FROM retrieval_units WHERE id=?",
    );
    const limit = 250;
    const weighted = (hit: ScoredUnit) =>
      hit.score * this.applicability(hit.unit, q);
    const exact = exactLookup(q.text);
    for (const row of rows) {
      const score = -Number(row.rank);
      // BM25 rows arrive in descending score order. Applicability is a prior
      // in [0,1], so no remaining row can beat this upper bound. Stop only
      // after collecting eligible candidates: hidden/out-of-scope rows never
      // consume the pool. Strict inequality retains stable ties.
      if (pool.length === limit && score < weighted(pool.at(-1)!)) break;
      const stored = readUnit.get(row.id!);
      if (!stored) continue;
      const unit = decodeUnit(stored);
      if (!this.eligible(unit, q)) continue;
      if (
        exact &&
        !(unit.text + "\n" + unit.context)
          .toLowerCase()
          .includes(q.text.trim().toLowerCase())
      )
        continue;
      // BM25 supplies lexical relevance. A second minimum matched-word count
      // rejects concise answers to verbose questions and unsupported-language
      // symbol references; context selection happens after candidate recall.
      pool.push({ unit, score, routes: ["bm25"] });
      pool.sort((a, b) => weighted(b) - weighted(a));
      if (pool.length > limit) pool.pop();
    }
    return pool;
  }
  async search(q: SearchQuery): Promise<RetrievalHit[]> {
    await this.syncAsync();
    const navigation = this.navigationCandidates(q);
    if (navigation) return this.finish(navigation.hits, navigation.query);
    const lexical = this.lexical(q);
    const symbols = this.symbols(q);
    const lexicalOnly = () =>
      symbols.length ? this.fuse([lexical, symbols]) : lexical;
    if (!q.text.trim() || exactLookup(q.text) || !this.model)
      return this.finish(lexicalOnly(), q);
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
      return this.finish(lexicalOnly(), q);
    }
    const sorted = [...dense.values()].sort((a, b) => b.score - a.score);
    const floor = Math.max(0.4, (sorted[0]?.score ?? 1) - 0.075);
    const accepted = sorted
      .filter((h) => h.score >= floor)
      .sort(
        (a, b) =>
          b.score * this.applicability(b.unit, q) -
          a.score * this.applicability(a.unit, q),
      )
      .slice(0, 100);
    let hits = this.fuse([lexical.slice(0, 100), accepted, symbols]);
    if (this.loadReranker && hits.length) {
      try {
        this.rankingLoad ??= this.loadReranker().then(
          (model) => (this.reranker = model),
        );
        const model = await this.rankingLoad,
          pool = hits
            .sort(
              (a, b) =>
                Number(b.routes.includes("code-symbol")) -
                  Number(a.routes.includes("code-symbol")) || b.score - a.score,
            )
            .slice(0, 40);
        const passages = pool.flatMap((h, unitIndex) =>
          rerankPassages(
            h.unit.text,
            q.text,
            h.excerpt,
            h.unit.target.kind === "source"
              ? h.unit.materialDescription?.description.concepts.filter(
                  (c) =>
                    h.unit.target.kind === "source" &&
                    c.startLine <= h.unit.target.endLine &&
                    c.endLine >= h.unit.target.startLine,
                )
              : [],
          ).map((text) => ({
            unitIndex,
            text,
            input: h.unit.context.slice(0, 160) + "\n" + text,
          })),
        );
        const scores = await model.score(
          q.text,
          passages.map((p) => p.input),
        );
        const best = new Map<number, { score: number; text: string }>();
        passages.forEach((p, i) => {
          if (scores[i]! > (best.get(p.unitIndex)?.score ?? -Infinity))
            best.set(p.unitIndex, { score: scores[i]!, text: p.text });
        });
        const max = Math.max(...pool.map((h) => h.score), 1e-6);
        hits = pool.flatMap((h, i) =>
          best.get(i)!.score >= 0.1 || h.routes.includes("code-symbol")
            ? [
                {
                  ...h,
                  score: best.get(i)!.score * 0.7 + (h.score / max) * 0.3,
                  excerpt: best.get(i)!.text,
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
        q.codeIntent !== "callers" && this.namedDefinition(u, q) ? 2 : 1;
      const freshness =
        u.target.kind === "knowledge" && u.target.reviewState === "needs-review"
          ? 0.85
          : 1;
      if (
        q.purpose !== "follow-up" ||
        (!["task", "memory"].includes(u.kind) && u.subtype !== "conversation")
      )
        return (
          preference(u) * definition * freshness * this.applicability(u, q)
        );
      const event = Date.parse(u.eventAt ?? "");
      const ageDays = Math.max(0, (Date.now() - event) / 86_400_000);
      return (
        preference(u) *
        (Number.isFinite(ageDays) ? 1 + 0.15 * Math.exp(-ageDays / 30) : 1)
      );
    };
    const owners = new Map<string, number>(),
      sections = new Set<string>(),
      seen = new Set<string>(),
      output: RetrievalHit[] = [];
    const terms = queryTerms(q.text);
    const ordered = hits.sort(
      (a, b) => b.score * priority(b.unit) - a.score * priority(a.unit),
    );
    if (q.codeIntent === "callers" && q.diversify !== false) {
      // Show the breadth of entry points before more sites in the same file.
      // Unlike a per-owner cap, this does not discard the remaining call sites.
      const counts = new Map<string, number>();
      const round = new Map(
        ordered.map((h) => {
          const n = counts.get(h.unit.owner) ?? 0;
          counts.set(h.unit.owner, n + 1);
          return [h.unit.id, n];
        }),
      );
      ordered.sort((a, b) => round.get(a.unit.id)! - round.get(b.unit.id)!);
    }
    for (const h of ordered) {
      if (!this.eligible(h.unit, q)) continue;
      const u = h.unit,
        fingerprint = u.text.replace(/\s+/g, " ").trim();
      const section =
        u.target.kind === "knowledge"
          ? `${u.target.revision}:${u.target.section}`
          : null;
      if (
        q.diversify !== false &&
        q.codeIntent !== "callers" &&
        ((section ? sections.has(section) : (owners.get(u.owner) ?? 0) >= 2) ||
          seen.has(fingerprint))
      )
        continue;
      if (section) sections.add(section);
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
        ...(h.codeMatches ? { codeMatches: h.codeMatches } : {}),
        target: u.target,
        references: u.references,
        citations,
        provenance: u.provenance,
        eventAt: u.eventAt,
        ...(u.materialDescription
          ? { materialDescription: u.materialDescription }
          : {}),
      });
      if (output.length >= (q.limit ?? 20)) break;
    }
    return output;
  }
  override searchSources(q: SearchQuery): SourceCandidate[] {
    this.sync();
    const sourceQuery = { ...q, kinds: ["source" as const] };
    const navigation = this.navigationCandidates(sourceQuery);
    if (navigation)
      return this.sources(this.finish(navigation.hits, navigation.query), q);
    const lexical = this.lexical(sourceQuery),
      symbols = this.symbols(sourceQuery);
    return this.sources(
      this.finish(symbols.length ? this.fuse([lexical, symbols]) : lexical, q),
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
