import type { DatabaseSync } from "node:sqlite";
import type { EmbeddingModel } from "./embedding.js";
import type { RerankerModel } from "./reranker.js";
import {
  conceptCandidates,
  conceptWindows,
  CONCEPT_VECTOR_VERSION,
} from "./concept-vectors.js";
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
import { scoringPassages } from "./rerank-passages.js";
import { candidatePool } from "./candidate-pool.js";
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
  matchedRanges?: { start: number; end: number }[];
  routeRanks?: Record<string, number>;
  codeMatches?: RetrievalHit["codeMatches"];
  reranking?: RetrievalHit["reranking"];
  rankingStatus?: RetrievalHit["rankingStatus"];
};
export type RetrievalTrace = {
  stage:
    | "lexical"
    | "symbols"
    | "concepts"
    | "semantic"
    | "semantic-concepts"
    | "fusion"
    | "reranker-input"
    | "reranker"
    | "selection"
    | "decision"
    | "final";
  hits: RetrievalHit[];
  model?: string;
  error?: string;
};
export type RetrievalObserver = (trace: RetrievalTrace) => void;
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
  private conceptError: string | null = null;
  private rankingError: string | null = null;
  constructor(
    private database: DatabaseSync,
    private load?: () => Promise<EmbeddingModel>,
    private loadReranker?: () => Promise<RerankerModel>,
    private readOnly = false,
    private rank?: (
      query: SearchQuery,
      hits: RetrievalHit[],
    ) => Promise<RetrievalHit[]>,
    private readonly rankingOptions: { budgetMs?: number } = {},
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
  private get conceptModelId() {
    return this.modelId ? this.modelId + ":" + CONCEPT_VECTOR_VERSION : null;
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
    const conceptTotal = Number(
      this.database
        .prepare(
          "SELECT count(*) n FROM retrieval_units WHERE description_json IS NOT NULL",
        )
        .get()!.n,
    );
    const conceptIndexed = this.conceptModelId
      ? Number(
          this.database
            .prepare(
              "SELECT count(*) n FROM retrieval_unit_vector_heads WHERE model_id=?",
            )
            .get(this.conceptModelId)!.n,
        )
      : 0;
    return {
      available: true,
      backend: "sqlite-context-bm25-bge@1",
      projection: UNIT_VERSION,
      units: total,
      semantic: {
        model: this.modelId,
        state:
          this.error || this.conceptError
            ? "degraded"
            : !this.load
              ? "disabled"
              : this.model &&
                  indexed === total &&
                  conceptIndexed === conceptTotal &&
                  !this.projection.preparing
                ? "ready"
                : "indexing",
        indexed,
        pending: total - indexed,
        error: this.error,
        concepts: {
          model: this.conceptModelId,
          indexed: conceptIndexed,
          pending: conceptTotal - conceptIndexed,
          error: this.conceptError,
        },
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
    let rows = this.database
      .prepare(
        `SELECT u.* FROM retrieval_units u WHERE NOT EXISTS (
      SELECT 1 FROM retrieval_unit_vector_heads h WHERE h.unit_id=u.id AND h.model_id=?) LIMIT ?`,
      )
      .all(this.modelId, limit);
    const conceptIndex = !rows.length;
    const vectorModelId = conceptIndex ? this.conceptModelId : this.modelId;
    if (conceptIndex)
      rows = this.database
        .prepare(
          `SELECT u.* FROM retrieval_units u
      WHERE u.description_json IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM retrieval_unit_vector_heads h WHERE h.unit_id=u.id AND h.model_id=?) LIMIT ?`,
        )
        .all(vectorModelId, limit);
    for (const row of rows) {
      if (this.stopped) break;
      const unit = decodeUnit(row),
        windows = conceptIndex
          ? conceptWindows(unit)
          : embeddingWindows(unit.text),
        vectors: number[][] = [];
      for (let i = 0; i < windows.length; i += 16) {
        const batch = windows.slice(i, i + 16);
        const result = await model.embed(
          batch.map((w) =>
            "text" in w && typeof w.text === "string"
              ? w.text
              : unit.context.slice(0, 180) +
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
              vectorModelId,
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
          .run(unit.id, vectorModelId);
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
      branch.forEach((h, rank) => {
        const prior = fused.get(h.unit.id);
        fused.set(h.unit.id, {
          ...h,
          // The symbol route contributes navigation; it must not overwrite a
          // query-relevant dense window with the beginning of the same method.
          excerpt: h.routes.includes("semantic-concept")
            ? h.excerpt
            : (prior?.excerpt ?? h.excerpt),
          matchedRanges: [
            ...(prior?.matchedRanges ?? []),
            ...(h.matchedRanges ?? []),
          ].filter(
            (range, i, all) =>
              all.findIndex(
                (r) => r.start === range.start && r.end === range.end,
              ) === i,
          ),
          routeRanks: {
            ...prior?.routeRanks,
            ...Object.fromEntries(
              h.routes.map((route) => [
                route,
                Math.min(prior?.routeRanks?.[route] ?? Infinity, rank),
              ]),
            ),
          },
          // Standard RRF: scores from BM25, cosine and symbol lookup have
          // different scales. Only each route's one-based rank contributes.
          score: (prior?.score ?? 0) + 1 / (60 + rank + 1),
          routes: [...new Set([...(prior?.routes ?? []), ...h.routes])],
        });
      });
    }
    return [...fused.values()];
  }
  private concepts(q: SearchQuery): ScoredUnit[] {
    const terms = [
      ...new Set(queryTerms(q.text).flatMap((t) => indexText(t).split(" "))),
    ];
    if (!terms.length || exactLookup(q.text)) return [];
    const phrase = terms
      .filter(Boolean)
      .map((t) => '"' + t.replaceAll('"', '""') + '"')
      .join(" OR ");
    if (!phrase) return [];
    // Reuse the context FTS index, then require a match in a saved concept for
    // this exact passage. Headings and a file-wide summary are not concept hits.
    const rows = this.database
      .prepare(
        `SELECT u.*,bm25(retrieval_units_fts,0,0,1,0) rank
      FROM retrieval_units_fts JOIN retrieval_units u ON u.id=retrieval_units_fts.id
      WHERE retrieval_units_fts MATCH ? AND u.kind='source' AND u.description_json IS NOT NULL
      ORDER BY rank`,
      )
      .iterate(`context : (${phrase})`);
    const hits: ScoredUnit[] = [];
    const seenConcepts = new Set<string>();
    for (const row of rows) {
      const unit = decodeUnit(row);
      if (!this.eligible(unit, q) || unit.target.kind !== "source") continue;
      const target = unit.target;
      const matching = unit.materialDescription!.description.concepts.filter(
        (c) => {
          if (c.startLine > target.endLine || c.endLine < target.startLine)
            return false;
          const words = new Set(
            indexText([c.label, ...c.aliases].join(" ")).split(" "),
          );
          return terms.some((t) => words.has(t));
        },
      );
      if (!matching.length) continue;
      const identity = (c: (typeof matching)[number]) =>
        JSON.stringify([
          target.key,
          target.revisionId,
          c.label,
          c.startLine,
          c.endLine,
        ]);
      const first = matching.find((c) => !seenConcepts.has(identity(c)));
      if (!first) continue;
      seenConcepts.add(identity(first));
      const start = Math.max(target.startLine, first.startLine);
      const end = Math.min(target.endLine, first.endLine);
      const lines = unit.text.split("\n"),
        offset = start - target.startLine;
      const startOffset = offset
        ? lines.slice(0, offset).join("\n").length + 1
        : 0;
      const excerpt = lines
        .slice(offset, end - target.startLine + 1)
        .join("\n");
      hits.push({
        unit,
        score: -Number(row.rank),
        routes: ["material-concept"],
        excerpt,
        matchedRanges: [
          { start: startOffset, end: startOffset + excerpt.length },
        ],
      });
      // Visibility/scope filtering precedes the bound; hidden passages consume no slots.
      if (hits.length === 40) break;
    }
    return hits;
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
  private observe(
    observer: RetrievalObserver | undefined,
    stage: RetrievalTrace["stage"],
    hits: ScoredUnit[],
    model?: string,
    error?: string,
  ) {
    if (!observer) return;
    // Diagnostics see the actual stage before later host preferences and limits.
    // Copies prevent an observer from changing subsequent retrieval behavior.
    observer({
      stage,
      model,
      error,
      hits: structuredClone(
        hits.map((h) => ({
          id: h.unit.id,
          kind: h.unit.kind,
          title: h.unit.title,
          text: h.excerpt ?? h.unit.text,
          context: h.unit.context,
          headingPath: h.unit.headingPath,
          score: h.score,
          routes: h.routes,
          target: h.unit.target,
          references: h.unit.references,
          provenance: h.unit.provenance,
          eventAt: h.unit.eventAt,
          ...(h.unit.materialDescription
            ? { materialDescription: h.unit.materialDescription }
            : {}),
          ...(h.reranking ? { reranking: h.reranking } : {}),
        ...(h.rankingStatus ? { rankingStatus: h.rankingStatus } : {}),
        })),
      ),
    });
  }
  async search(
    q: SearchQuery,
    observer?: RetrievalObserver,
  ): Promise<RetrievalHit[]> {
    await this.syncAsync();
    const navigation = this.navigationCandidates(q);
    if (navigation) {
      const hits = this.finish(navigation.hits, navigation.query);
      observer?.({ stage: "final", hits: structuredClone(hits) });
      return hits;
    }
    const lexical = this.lexical(q);
    const symbols = this.symbols(q);
    const concepts = this.concepts(q);
    this.observe(observer, "lexical", lexical);
    this.observe(observer, "symbols", symbols);
    this.observe(observer, "concepts", concepts);
    const lexicalOnly = () =>
      symbols.length || concepts.length
        ? this.fuse([lexical, symbols, concepts])
        : lexical;
    if (!q.text.trim() || exactLookup(q.text))
      return this.select(lexicalOnly(), q, observer);
    if (!this.model) {
      const hits = lexicalOnly();
      this.observe(observer, "fusion", hits);
      return this.select(await this.rerank(hits, q, observer), q, observer);
    }
    const dense = new Map<string, ScoredUnit>();
    const conceptDense = new Map<string, ScoredUnit>();
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
          matchedRanges: [
            { start: Number(row.start_offset), end: Number(row.end_offset) },
          ],
          excerpt: unit.text.slice(
            Number(row.start_offset),
            Number(row.end_offset),
          ),
        });
      }
      try {
        for (const hit of conceptCandidates(
          this.database,
          this.conceptModelId!,
          units,
          vector,
        ))
          conceptDense.set(hit.unit.id, hit);
        this.conceptError = null;
      } catch (error) {
        // An optional representation failing does not discard healthy body vectors.
        conceptDense.clear();
        this.conceptError = String(error);
      }
    } catch (error) {
      this.error = String(error);
      const hits = lexicalOnly();
      this.observe(
        observer,
        "semantic",
        [],
        this.modelId ?? undefined,
        this.error,
      );
      this.observe(observer, "fusion", hits);
      return this.select(await this.rerank(hits, q, observer), q, observer);
    }
    const sorted = [...dense.values()].sort((a, b) => b.score - a.score);
    // The best match may be a question with no answer. It must not raise the
    // admission floor for all other candidates before a reader/model sees them.
    const floor = 0.4;
    const accepted = sorted
      .filter((h) => h.score >= floor)
      .sort(
        (a, b) =>
          b.score * this.applicability(b.unit, q) -
          a.score * this.applicability(a.unit, q),
      )
      .slice(0, 100);
    this.observe(observer, "semantic", accepted, this.modelId ?? undefined);
    const semanticConcepts = [...conceptDense.values()]
      .filter((h) => h.score >= floor)
      .sort(
        (a, b) =>
          b.score * this.applicability(b.unit, q) -
          a.score * this.applicability(a.unit, q),
      )
      .slice(0, 100);
    this.observe(
      observer,
      "semantic-concepts",
      semanticConcepts,
      this.conceptModelId ?? undefined,
      this.conceptError ?? undefined,
    );
    const hits = this.fuse([
      lexical.slice(0, 100),
      accepted,
      symbols,
      concepts,
      semanticConcepts,
    ]);
    this.observe(observer, "fusion", hits);
    return this.select(await this.rerank(hits, q, observer), q, observer);
  }
  private async rerank(
    hits: ScoredUnit[],
    q: SearchQuery,
    observer?: RetrievalObserver,
  ) {
    if (this.loadReranker && hits.length) {
      try {
        this.rankingLoad ??= this.loadReranker()
          .then((model) => (this.reranker = model))
          .catch((error) => {
            // Explicitly installed resources may become available after startup.
            // A rejected load is not a permanent model cache.
            this.rankingLoad = undefined;
            throw error;
          });
        const model = await this.rankingLoad;
        q.signal?.throwIfAborted();
        const deadline = performance.now() + (this.rankingOptions.budgetMs ?? 20_000);
        const pool = candidatePool(hits.map(h => ({ ...h, id: h.unit.id, owner: h.unit.owner })), hits.length);
        const scored = new Map<string, { score: number; text: string; start: number; end: number }>();
        const planned = new Map<string, {h:ScoredUnit;input:string;text:string;start:number;end:number}[]>();
        const evaluated = new Map<string,number>();
        let rounds = 1;
        let reason: "budget" | "failed" | undefined;
        // Give candidates one window each before spending more on long units.
        // Budget/cancellation still retain every previously completed score.
        scoring: for (let round=0;round<rounds;round++) for (let offset = 0; offset < pool.length; offset += 8) {
          q.signal?.throwIfAborted();
          if (performance.now() >= deadline) { reason = "budget"; break scoring; }
          const batch = pool.slice(offset, offset + 8);
          try {
            const passages = batch.flatMap(h => {
              if(!planned.has(h.unit.id)) {
                const windows=scoringPassages(h.unit, q.text, h.excerpt, h.matchedRanges)
                  .flatMap(p => (model.windows?.(q.text, p.text, p.context) ?? [p.context + "\n" + p.text]).map(input => {
                const text = input.startsWith(p.context + "\n") ? input.slice(p.context.length + 1) : input;
                const start = p.start + Math.max(0, p.text.indexOf(text));
                return {h,input,text,start,end:start + text.length};
                  }));
                planned.set(h.unit.id,windows);rounds=Math.max(rounds,windows.length);
              }
              const window=planned.get(h.unit.id)![round];
              return window ? [window] : [];
            });
            if(!passages.length)continue;
            const scores = await model.score(q.text, passages.map(p => p.input), { signal: q.signal, deadline });
            if (scores.length !== passages.length || scores.some(s => !Number.isFinite(s))) throw Error("Invalid reranker score batch");
            passages.forEach((p, i) => {
              evaluated.set(p.h.unit.id,(evaluated.get(p.h.unit.id) ?? 0)+1);
              if (scores[i]! > (scored.get(p.h.unit.id)?.score ?? -Infinity))
                scored.set(p.h.unit.id, {score:scores[i]!,text:p.text,start:p.start,end:p.end});
            });
            this.observe(observer, "reranker-input", passages.map((p, i) => ({ ...p.h, excerpt: p.input, score: scores[i]! })), model.id);
          } catch (error) {
            q.signal?.throwIfAborted();
            reason = String(error).includes("RERANK_BUDGET_EXHAUSTED") ? "budget" : "failed";
            this.rankingError = String(error);
            break scoring;
          }
        }
        const max = Math.max(...hits.map(h => h.score), 1e-6);
        hits = hits.map(h => {
          const winner = scored.get(h.unit.id);
          return winner === undefined
            ? { ...h, score: h.score / max * 0.3, rankingStatus: { state: "unscored" as const, reason: reason ?? "failed", model: model.id } }
            : { ...h, score: winner.score * 0.7 + h.score / max * 0.3,
                excerpt: winner.text, matchedRanges: [{start:winner.start,end:winner.end}],
                rankingStatus: { state: "scored" as const, model: model.id, evaluatedWindows:evaluated.get(h.unit.id),plannedWindows:planned.get(h.unit.id)?.length,
                  ...(evaluated.get(h.unit.id)!<planned.get(h.unit.id)!.length ? {reason:reason ?? "failed"} : {}) },
                reranking: { model: model.id, relevance: winner.score, retrievalScore: h.score }, routes: [...h.routes, "cross-encoder"] };
        });
        if (!reason) this.rankingError = null;
        this.observe(observer, "reranker", hits, model.id, reason);
      } catch (error) {
        q.signal?.throwIfAborted();
        this.rankingError = String(error);
        this.observe(observer, "reranker", hits, undefined, this.rankingError);
      }
    }
    return hits;
  }
  private async select(
    hits: ScoredUnit[],
    q: SearchQuery,
    observer?: RetrievalObserver,
  ) {
    const finish = (emit = true) => {
      const selected = this.finish(hits, q);
      if (emit) observer?.({ stage: "final", hits: structuredClone(selected) });
      return selected;
    };
    if (!this.rank || !q.text.trim() || exactLookup(q.text)) return finish();
    // Score a pool before spending the requested reading slots. Do not allow a
    // model to see hidden/out-of-scope units or force a cold model load here.
    const leading = this.finish([...hits],{...q,diversify:false,limit:6});
    const leadingIds=new Set(leading.map(h=>h.id));
    const coverage = candidatePool(
      hits.filter(h=>!leadingIds.has(h.unit.id)).map((h) => ({ ...h, id: h.unit.id, owner: h.unit.owner })), 6);
    const inspected=[...leading,...coverage.flatMap(h=>this.finish([h],{...q,diversify:false,limit:1}))];
    const inspectedIds=new Set(inspected.map(h=>h.id));
    const pool = [...inspected,...this.finish(hits.filter(h=>!inspectedIds.has(h.unit.id)), {
      ...q,
      diversify: false,
      limit: Math.max(q.limit ?? 20, 40)-inspected.length,
    })];
    observer?.({ stage: "selection", hits: structuredClone(pool) });
    try {
      const ranked = await this.rank(q, pool);
      if (ranked === pool) return finish();
      observer?.({ stage: "decision", hits: structuredClone(ranked) });
      if (ranked.some((h) => h.assessment?.advisoryOnly)) {
        const assessments = new Map(ranked.map((h) => [h.id, h.assessment]));
        const selected = finish(false).map((h) => ({
          ...h,
          ...(assessments.get(h.id)
            ? { assessment: assessments.get(h.id) }
            : {}),
        }));
        observer?.({ stage: "final", hits: structuredClone(selected) });
        return selected;
      }
      const owners = new Map<string, number>(),
        sections = new Set<string>(),
        seen = new Set<string>();
      const allowed = new Map(pool.map((h) => [h.id, h]));
      const poolIds = new Set(pool.map((h) => h.id));
      const selected = [
        ...ranked
          .filter((h) => allowed.has(h.id))
          .map((h) => ({
            ...allowed.get(h.id)!,
            assessment: h.assessment,
            ...(h.assessment
              ? { routes: [...allowed.get(h.id)!.routes, "decision"] }
              : {}),
          })),
        ...this.finish(hits, {
          ...q,
          diversify: false,
          limit: hits.length,
        }).filter((h) => !poolIds.has(h.id)),
      ]
        .filter((hit) => {
          if (q.diversify === false) return true;
          const owner =
            hit.target.kind === "source" || hit.target.kind === "knowledge"
              ? hit.target.key
              : hit.target.id;
          const section =
            hit.target.kind === "knowledge"
              ? `${hit.target.revision}:${hit.target.section}`
              : null;
          const text = hit.text.replace(/\s+/g, " ").trim();
          if (
            (section ? sections.has(section) : (owners.get(owner) ?? 0) >= 2) ||
            seen.has(text)
          )
            return false;
          if (section) sections.add(section);
          owners.set(owner, (owners.get(owner) ?? 0) + 1);
          seen.add(text);
          return true;
        })
        .slice(0, q.limit ?? 20);
      observer?.({ stage: "final", hits: structuredClone(selected) });
      return selected;
    } catch {
      q.signal?.throwIfAborted();
      return finish();
    }
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
        ...(u.target.kind === "source" && h.matchedRanges?.length
          ? {
              matchedRanges: h.matchedRanges.map((r) => ({
                startLine:
                  u.target.kind === "source"
                    ? u.target.startLine +
                      u.text.slice(0, r.start).split("\n").length -
                      1
                    : 1,
                endLine:
                  u.target.kind === "source"
                    ? u.target.startLine +
                      u.text.slice(0, Math.max(r.start, r.end - 1)).split("\n")
                        .length -
                      1
                    : 1,
              })),
            }
          : {}),
        score: h.score * priority(u),
        routes: [...h.routes, "purpose:" + (q.purpose ?? "balanced")],
        ...(h.reranking ? { reranking: h.reranking } : {}),
        ...(h.rankingStatus ? { rankingStatus: h.rankingStatus } : {}),
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
    const terms = queryTerms(q.text);
    return hits
      .flatMap((h) =>
        h.references.flatMap((r) => {
          const matchedLines = new Set(
            h.text
              .split("\n")
              .map((line) => line.trim())
              .filter((line) => line.length > 3),
          );
          // One structured passage occupies one result slot. Its overlapping
          // storage fragments are evidence anchors, not extra search results.
          const fragments = r.fragmentIds
            .filter((id) => !seen.has(id) && (!q.visible || q.visible(id)))
            .map((id) => ({
              id,
              text: this.readEvidence(r.revisionId, id)?.text ?? "",
            }))
            .filter((f) => f.text)
            .sort((a, b) => {
              const relevance = (text: string) =>
                text
                  .split("\n")
                  .reduce(
                    (total, line) =>
                      total +
                      (matchedLines.has(line.trim()) ? line.trim().length : 0),
                    0,
                  ) +
                Number(text.includes(h.text)) * (terms.length + 1) +
                terms.filter((t) => text.toLowerCase().includes(t)).length;
              return relevance(b.text) - relevance(a.text);
            });
          const id = fragments[0]?.id;
          if (!id) return [];
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
