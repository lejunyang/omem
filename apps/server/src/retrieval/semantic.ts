import type { DatabaseSync } from "node:sqlite";
import { KeywordRetrieval, ORIGINAL } from "./keyword.js";
import type { EmbeddingModel } from "./embedding.js";
import type { SearchQuery, SourceCandidate } from "./port.js";
import { rankEvidence } from "./ranking.js";

type Fragment = { id: string; revision_id: string; text: string; title: string; created_at: string; namespace: string; actor: string | null };
const CURRENT = `FROM fragments f JOIN revisions r ON r.id=f.revision_id JOIN sources s ON s.head=r.id WHERE ${ORIGINAL}`;
const COLUMNS = "f.id,f.revision_id,f.text,r.title,r.created_at,s.namespace,json_extract(r.body,'$.provenance.actorId') AS actor";

/** Exact cosine is sufficient for a personal SQLite library; no separate vector authority. */
export class SemanticRetrieval extends KeywordRetrieval {
  private model: EmbeddingModel | null = null;
  private loading: Promise<EmbeddingModel> | null = null;
  private work: Promise<number> | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private error: string | null = null;
  constructor(private readonly database: DatabaseSync, private readonly load: () => Promise<EmbeddingModel>) { super(database); }

  override health() {
    const modelId = this.model?.id ?? "";
    const total = Number(this.database.prepare(`SELECT count(*) AS n ${CURRENT}`).get()!.n);
    const indexed = Number(this.database.prepare(`SELECT count(*) AS n ${CURRENT} AND EXISTS (
      SELECT 1 FROM fragment_embedding_heads h WHERE h.fragment_id=f.id AND h.model_id=?)`).get(modelId)!.n);
    return { available: true, backend: "sqlite-fts5-bge-rrf@3", semantic: { model: this.model?.id ?? null,
      state: this.error ? "degraded" : indexed === total && this.model ? "ready" : "indexing", indexed, pending: total-indexed, error: this.error } };
  }

  private async ready() {
    this.loading ??= this.load().then(model => this.model = model);
    return this.loading;
  }

  /** Automatic catch-up includes subsequent captures, without blocking a query on indexing. */
  start() {
    const tick = async () => {
      if (this.stopped) return;
      try { await this.indexBatch(); } catch (error) { this.error = String(error); }
      if (!this.stopped) { this.timer = setTimeout(tick, this.error ? 30_000 : 1000); this.timer.unref(); }
    };
    void tick();
  }

  indexBatch(limit = 8): Promise<number> {
    if (this.work) return this.work;
    this.work = this.index(limit).catch(error => { this.error = String(error); throw error; }).finally(() => this.work = null);
    return this.work;
  }

  private async index(limit: number) {
    const model = await this.ready();
    const fragments = this.database.prepare(`SELECT ${COLUMNS} ${CURRENT} AND NOT EXISTS (
      SELECT 1 FROM fragment_embedding_heads h WHERE h.fragment_id=f.id AND h.model_id=?) ORDER BY r.created_at DESC,f.id LIMIT ?`).all(model.id, limit) as Fragment[];
    for (const fragment of fragments) {
      if (this.stopped) break;
      // Overlapping windows prevent a long immutable fragment from silently losing its tail.
      const windows = embeddingWindows(fragment.text);
      const vectors: number[][] = [];
      for (let i = 0; i < windows.length; i += 16) {
        const batch = windows.slice(i, i + 16);
        const output = await model.embed(batch.map(w => fragment.title.slice(0, 64) + "\n" + fragment.text.slice(w.start, w.end)), "passage");
        if (output.length !== batch.length) throw Error("Embedding batch size mismatch");
        for (const v of output) vectors.push(normalize(v));
      }
      this.database.exec("BEGIN IMMEDIATE");
      try {
        for (let i = 0; i < windows.length; i++) {
          const vector = new Float32Array(vectors[i]!);
          this.database.prepare(`INSERT OR REPLACE INTO fragment_embeddings(fragment_id,model_id,part,start_offset,end_offset,vector) VALUES(?,?,?,?,?,?)`)
            .run(fragment.id, model.id, i, windows[i]!.start, windows[i]!.end, Buffer.from(vector.buffer));
        }
        this.database.prepare("INSERT OR REPLACE INTO fragment_embedding_heads(fragment_id,model_id) VALUES(?,?)").run(fragment.id,model.id);
        this.database.exec("COMMIT");
      } catch (error) { this.database.exec("ROLLBACK"); throw error; }
    }
    this.error = null;
    return fragments.length;
  }

  /** Separate async hook keeps synchronous lexical callers compatible. */
  async searchSourcesAsync(query: SearchQuery): Promise<SourceCandidate[]> {
    const lexical = super.searchSources({ ...query, diversify: false, limit: 100 });
    if (!query.text.trim() || !this.model) return rankEvidence(lexical,query);
    try {
      const [raw] = await this.model.embed([query.text.slice(0, 400)], "query");
      const vector = normalize(raw!);
      const rows = this.database.prepare(`SELECT ${COLUMNS},e.vector,e.start_offset,e.end_offset FROM fragment_embeddings e
        JOIN fragments f ON f.id=e.fragment_id JOIN revisions r ON r.id=f.revision_id JOIN sources s ON s.head=r.id
        WHERE e.model_id=? AND ${ORIGINAL}`).all(this.model.id) as (Fragment & { vector: Uint8Array; start_offset: number; end_offset: number })[];
      const dense = new Map<string, SourceCandidate>();
      const vectors = new Map<string, Float32Array>();
      for (const row of rows) {
        if (query.visible && !query.visible(row.id)) continue;
        if (query.timeRange?.from && Date.parse(row.created_at) < Date.parse(query.timeRange.from)) continue;
        if (query.timeRange?.to && Date.parse(row.created_at) > Date.parse(query.timeRange.to)) continue;
        const stored = new Float32Array(row.vector.buffer.slice(row.vector.byteOffset,row.vector.byteOffset+row.vector.byteLength));
        if (stored.length !== vector.length) throw Error("Embedding dimensions changed without a new model identity");
        const score = vector.reduce((sum,v,i) => sum + v * stored[i]!, 0);
        if ((dense.get(row.id)?.score ?? -Infinity) >= score) continue;
        vectors.set(row.id,stored);
        dense.set(row.id, { id: row.id, fragmentId: row.id, sourceRevisionId: row.revision_id, score,
          snippet: row.text.slice(row.start_offset, row.end_offset), routes: ["semantic"],
          provenance: { actor: row.actor, time: row.created_at, source: row.namespace } });
      }
      const fused = new Map<string, SourceCandidate>();
      for (const branch of [lexical, [...dense.values()].sort((a,b) => b.score-a.score).slice(0,100)]) {
        branch.forEach((hit,rank) => {
          const prior = fused.get(hit.id);
          fused.set(hit.id, { ...hit, score: (prior?.score ?? 0) + 1/(60+rank+1), routes: [...new Set([...(prior?.routes ?? []),...hit.routes ?? []])] });
        });
      }
      return rankEvidence([...fused.values()],query,vectors);
    } catch (error) { this.error = String(error); return rankEvidence(lexical,query); }
  }

  async close() {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.work?.catch(() => {});
    await this.model?.close();
  }
}

export function embeddingWindows(text: string) {
  const windows: { start: number; end: number }[] = [];
  for (let start = 0; start < Math.max(1,text.length); start += 320) {
    windows.push({ start, end: Math.min(text.length,start+400) });
    if (start + 400 >= text.length) break;
  }
  return windows;
}
function normalize(vector: number[]) {
  if (!vector?.length || vector.some(v => !Number.isFinite(v))) throw Error("Invalid embedding vector");
  const norm = Math.hypot(...vector);
  if (!norm) throw Error("Empty embedding vector");
  return vector.map(v => v/norm);
}
