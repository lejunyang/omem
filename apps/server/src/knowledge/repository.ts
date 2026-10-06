import { createHash } from "node:crypto";
import type { Store } from "../store.js";
import { stableDigest } from "../storage/digest.js";
import { sourceForMaterialKey, ensureMaterialAliases } from "./material-identity.js";
import { knowledgeDocumentSchema, type KnowledgeArtifact, type KnowledgeDocument, type KnowledgeMaterial, type KnowledgeRole, type WikiPageBrief } from "../../../../packages/contracts/src/knowledge.js";
import { knowledgeStatus, publicationRole } from "./lifecycle.js";

export const digest = (value: string) => createHash("sha256").update(value).digest("hex");
type Row = Record<string, unknown>;
const materialCache = new WeakMap<Store, Map<string, KnowledgeMaterial | null>>();
export type KnowledgeArticle = KnowledgeArtifact & { revision: string; current: boolean };

export function materialFromRevision(store: Store, revisionId: string): KnowledgeMaterial | null {
  let cache = materialCache.get(store);
  if (!cache) { cache = new Map(); materialCache.set(store, cache); }
  if (cache.has(revisionId)) return cache.get(revisionId)!;
  const r = store.revision(revisionId);
  const context = (r?.context ?? {}) as Record<string, unknown>;
  if (!r || context.derived === true || r.provenance?.producerKind === "derived") return null;
  const source = store.db.prepare("SELECT external_id FROM sources WHERE id=?").get(r.sourceId) as Row;
  const parts = r.parts as ({ type: string; text?: string; url?: string; assetId?: string; mimeType?: string; label?: string })[];
  const text = parts.filter(p => p.type === "text" || p.type === "link").map(p => p.type === "text" ? p.text ?? "" : `${p.label ?? ""}\n${p.url}`).join(context.captureFormat === "verbatim-v1" ? "" : "\n\n");
  const images = parts.filter(p => p.type === "image").map(p => ({ assetId: p.assetId!, mimeType: p.mimeType as KnowledgeMaterial["images"][number]["mimeType"], label: p.label ?? r.title }));
  const external = source.external_id ? String(source.external_id) : r.sourceId;
  const material: KnowledgeMaterial = {
    key: `${r.source}:${external}`,
    title: r.title, path: typeof context.filePath === "string" ? context.filePath : r.source === "file" && /^(?:\/|[A-Za-z]:[\\/])/.test(external) ? external.replace(/\\/g, "/") : null,
    conversationId: typeof context.conversationId === "string" ? context.conversationId : undefined,
    sourceId: r.sourceId, revisionId: r.id, namespace: r.source,
    actorId: r.provenance?.actorId, actorVerifiedBy: r.provenance?.actorVerifiedBy, eventAt: r.provenance?.eventAt, quoted: r.provenance?.quoted, forwarded: r.provenance?.forwarded,
    digest: stableDigest({ text, images, actor: r.provenance?.actorId ?? null, quoted: r.provenance?.quoted ?? false, forwarded: r.provenance?.forwarded ?? false }),
    text, lineCount: text.split("\n").length, fragments: r.fragments, images,
  };
  cache.set(revisionId, material);
  return material;
}

export function currentMaterials(store: Store): KnowledgeMaterial[] {
  const rows = store.db.prepare("SELECT id,head FROM sources WHERE head IS NOT NULL ORDER BY namespace,external_id").all() as Row[];
  const aliases = store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='knowledge_material_aliases'").get()
    ? new Map((store.db.prepare("SELECT material_key,source_id FROM knowledge_material_aliases ORDER BY material_key").all() as Row[]).map(r => [String(r.source_id), String(r.material_key)])) : new Map<string, string>();
  return rows.map(r => materialFromRevision(store, String(r.head))).filter((m): m is KnowledgeMaterial => !!m).map(m => aliases.has(m.sourceId) ? { ...m, key: aliases.get(m.sourceId)! } : m);
}

/** Validate the exact source/derived distinction and every inline reference.
 * Semantic correctness is checked separately by an independent model role. */
export function validateKnowledgeDocument(document: KnowledgeDocument, materials: Map<string, KnowledgeMaterial>, articles: Map<string, KnowledgeArticle>, offered?: Set<string>, allowMissingHistorical = false) {
  knowledgeDocumentSchema.parse(document);
  const citations = new Map(document.citations.map(c => [c.key, c]));
  if (citations.size !== document.citations.length) throw Error("Duplicate citation keys");
  if (new Set(document.sections.map(s => s.key)).size !== document.sections.length) throw Error("Duplicate section keys");
  const used = new Set<string>();
  for (const section of document.sections) {
    const refs = [...section.body.matchAll(/\[\[([a-zA-Z][a-zA-Z0-9_-]*)\]\]/g)].map(m => m[1]!);
    if (!refs.length) throw Error(`Section ${section.key} needs inline [[citation]] references`);
    for (const id of refs) { if (!citations.has(id)) throw Error(`Unknown inline citation ${id}`); used.add(id); }
    for (const input of section.reviewSources ?? []) {
      if (offered && !offered.has(`material:${input.key}`)) throw Error(`Review source was not offered: ${input.key}`);
      const m = materials.get(input.key);
      if (!m && allowMissingHistorical) continue;
      if (!m || input.endLine < input.startLine || input.endLine > m.lineCount) throw Error(`Invalid review source range: ${input.key}`);
    }
  }
  for (const c of document.citations) {
    if (!used.has(c.key)) throw Error(`Citation ${c.key} is detached from the narrative; place [[${c.key}]] beside its claim`);
    if (offered && !offered.has(`${c.target.kind}:${c.target.key}`)) throw Error(`Reference was not offered: ${c.target.key}`);
    if (c.target.kind === "article") {
      const target = articles.get(c.target.key);
      if (!target) { if (allowMissingHistorical) continue; throw Error(`Unknown article ${c.target.key}`); }
      if (c.target.section && !target.document.sections.some(s => s.key === c.target.section)) throw Error(`Unknown section ${c.target.section}`);
      continue;
    }
    const m = materials.get(c.target.key);
    if (!m) { if (allowMissingHistorical) continue; throw Error(`Unknown material ${c.target.key}`); }
    if (m.images.length && !m.text.trim()) continue;
    const start = c.target.startLine, end = c.target.endLine;
    if (!start || !end || end < start || end > m.lineCount) throw Error(`Invalid range for ${c.key}: ${m.title} has ${m.lineCount} lines`);
    const excerpt = m.text.split("\n").slice(start - 1, end).join("\n");
    if (c.quote.length < 4 || !excerpt.includes(c.quote)) throw Error(`Quote for ${c.key} does not occur in ${m.title}:${start}-${end}; copy an exact substring without line prefixes`);
  }
  for (const q of document.questions) for (const id of q.citationKeys) if (!citations.has(id)) throw Error(`Question cites missing reference ${id}`);
}

/** Models choose locators; the host copies source bytes. This avoids asking a
 * language model to reproduce long code verbatim. The independent review sees
 * the exact bound quote and the surrounding original material. */
export function bindKnowledgeQuotes(document: KnowledgeDocument, materials: Map<string, KnowledgeMaterial>): KnowledgeDocument {
  for (const c of document.citations) {
    if (c.target.kind !== "material") continue;
    const m = materials.get(c.target.key);
    if (!m) throw Error(`Unknown material ${c.target.key}`);
    if (m.images.length && !m.text.trim()) { c.quote = ""; continue; }
    const start = c.target.startLine, end = c.target.endLine;
    if (!start || !end || start < 1 || end < start || end > m.lineCount) throw Error(`Invalid citation range for ${m.title}: ${start}-${end}; total ${m.lineCount}`);
    c.quote = Array.from(m.text.split("\n").slice(start - 1, end).join("\n")).slice(0, 320).join("");
  }
  return document;
}

export class KnowledgeRepository {
  constructor(readonly store: Store, private readonly materialProvider = () => currentMaterials(store)) {
    // CLI generation and the reader may share this WAL database. Wait for a
    // bounded writer transaction instead of failing immediately with SQLITE_BUSY.
    store.db.exec("PRAGMA busy_timeout=30000");
    ensureMaterialAliases(store.db);
    store.db.exec(`CREATE TABLE IF NOT EXISTS knowledge_revisions(
      id TEXT PRIMARY KEY, document_key TEXT NOT NULL, artifact TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS knowledge_heads(document_key TEXT PRIMARY KEY, revision_id TEXT NOT NULL REFERENCES knowledge_revisions(id), current INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS knowledge_questions(id TEXT PRIMARY KEY, document_key TEXT NOT NULL, article_revision TEXT NOT NULL,
      body TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'open', answer_revision TEXT, task_id TEXT, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS knowledge_invalidations(document_key TEXT PRIMARY KEY, reason TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS knowledge_imports(asset TEXT PRIMARY KEY, state TEXT NOT NULL, reason TEXT NOT NULL, checked_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS knowledge_pages(document_key TEXT PRIMARY KEY, role TEXT NOT NULL, plan TEXT,
        state TEXT NOT NULL DEFAULT 'published', error TEXT, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS knowledge_page_edits(document_key TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS knowledge_page_inputs(document_key TEXT NOT NULL,source_id TEXT NOT NULL,
        purpose TEXT NOT NULL,PRIMARY KEY(document_key,source_id));
      CREATE TABLE IF NOT EXISTS knowledge_import_memberships(owner TEXT NOT NULL,document_key TEXT NOT NULL,revision_id TEXT NOT NULL,
        PRIMARY KEY(owner,document_key));`);
    // Persist the migration once. Content revisions and their hashes are untouched.
    for (const a of this.list()) this.store.db.prepare("INSERT OR IGNORE INTO knowledge_pages VALUES(?,?,?,'published',NULL,?)")
      .run(a.document.key, publicationRole(a), a.reading ? JSON.stringify(a.reading) : null, a.generation.at);
  }

  materials() { return this.materialProvider(); }

  materialsForPlan(brief: WikiPageBrief) {
    const available = this.materials();
    if (!brief.materialKeys && !brief.contextIds?.length) return available;
    const explicit = new Set(brief.materialKeys ?? []);
    if ([...explicit].some(key => !available.some(m => m.key === key))) throw Error("所选材料已不可用，请调整材料范围");
    const sources = this.store.contexts.sourceIds(brief.contextIds ?? []);
    for (const row of this.store.db.prepare("SELECT source_id FROM knowledge_page_inputs WHERE document_key=?").all(brief.key)) sources.add(String(row.source_id));
    const selected = available.filter(m => explicit.has(m.key) || sources.has(m.sourceId));
    if (brief.workflow !== "requirement-followup") return selected;
    const feedbackRevisions = new Set(selected.flatMap(m => this.store.messageFeedback.forSource(m.sourceId).map(f => String(f.revisionId))));
    return available.filter(m => selected.includes(m) || feedbackRevisions.has(m.revisionId));
  }

  /** Explicit host-owned links, separate from the reader's selected scope. */
  attachInput(key: string, sourceId: string, purpose: string) {
    if (!this.pages().some(p => p.key === key && p.plan)) throw Error("文章计划不存在");
    if (!this.store.db.prepare("SELECT id FROM sources WHERE id=?").get(sourceId)) throw Error("原始材料不存在");
    this.store.db.prepare("INSERT OR REPLACE INTO knowledge_page_inputs VALUES(?,?,?)").run(key, sourceId, purpose);
  }

  role(a: KnowledgeArtifact): KnowledgeRole {
    return (this.store.db.prepare("SELECT role FROM knowledge_pages WHERE document_key=?").get(a.document.key)?.role as KnowledgeRole | undefined) ?? publicationRole(a);
  }
  pages() {
    return this.store.db.prepare("SELECT * FROM knowledge_pages WHERE role!='note' AND state!='retired' ORDER BY updated_at").all()
      .map(r => ({key:String(r.document_key),role:r.role,plan:r.plan ? JSON.parse(String(r.plan)) as WikiPageBrief : null,state:String(r.state),error:r.error}));
  }
  hasUserPlan(key: string) { return !!this.store.db.prepare("SELECT 1 FROM knowledge_page_edits WHERE document_key=?").get(key); }
  savePlan(brief: WikiPageBrief, user = false) {
    // Imported page maps must not replace a reader's selection on restart.
    if (!user && this.hasUserPlan(brief.key)) return;
    if (user) this.store.db.prepare("INSERT OR IGNORE INTO knowledge_page_edits VALUES(?)").run(brief.key);
    const previous = this.pages().find(p => p.key === brief.key)?.plan;
    this.store.db.prepare(`INSERT INTO knowledge_pages VALUES(?,?,?,'planned',NULL,?) ON CONFLICT(document_key)
      DO UPDATE SET role=excluded.role,plan=excluded.plan,state=CASE WHEN knowledge_pages.state='retired' THEN 'planned' ELSE knowledge_pages.state END,updated_at=excluded.updated_at`)
      .run(brief.key, brief.kind === "reference" ? "reference" : "article", JSON.stringify(brief), new Date().toISOString());
    const published = this.get(brief.key);
    const planReason = "材料范围或阅读目标已调整，等待重新整理";
    if (published?.reading && stableDigest(published.reading) === stableDigest(brief)) {
      // An imported, independently reviewed revision may already implement the
      // new plan even when some original sources have since changed. Clear only
      // the satisfied plan change; source review and user feedback still apply.
      const cleared = this.store.db.prepare("DELETE FROM knowledge_invalidations WHERE document_key=? AND reason=?").run(brief.key, planReason);
      if (cleared.changes) this.refresh();
    } else if (published && stableDigest(previous ?? null) !== stableDigest(brief)) {
      this.store.db.prepare("INSERT OR REPLACE INTO knowledge_invalidations VALUES(?,?)").run(brief.key, planReason);
      this.refresh();
    }
  }
  pageState(key: string, state: "writing" | "published" | "failed" | "retired", error?: string) {
    this.store.db.prepare("UPDATE knowledge_pages SET state=?,error=?,updated_at=? WHERE document_key=?")
      .run(state, error ?? null, new Date().toISOString(), key);
  }
  published() {
    const retired = new Set(this.store.db.prepare("SELECT document_key FROM knowledge_pages WHERE state IN ('retired','planned')").all().map(r=>String(r.document_key)));
    return this.list().filter(a => this.role(a) !== "note" && !retired.has(a.document.key));
  }
  /** Reconcile only this import's publications. User-created/replaced pages and
   * fixed history remain intact when an asset is removed from its directory. */
  reconcileImport(owner: string, assets: {key:string; revision:string}[]) {
    this.store.tx(()=>{
      const retained = new Set(assets.map(a=>a.key));
      for (const row of this.store.db.prepare("SELECT document_key,revision_id FROM knowledge_import_memberships WHERE owner=?").all(owner)) {
        const key=String(row.document_key);
        if (retained.has(key)) continue;
        this.store.db.prepare("DELETE FROM knowledge_import_memberships WHERE owner=? AND document_key=?").run(owner,key);
        const other = this.store.db.prepare("SELECT 1 FROM knowledge_import_memberships WHERE document_key=?").get(key);
        if (!other && this.get(key)?.revision === row.revision_id) this.pageState(key,"retired");
      }
      for (const a of assets) {
        // Presence keeps an asset managed, but only an applied head advances
        // ownership. Rejected/deferred imports and preserved personal edits
        // must not make the last imported head look like a personal revision.
        if (this.get(a.key)?.revision !== a.revision) continue;
        this.store.db.prepare("INSERT INTO knowledge_import_memberships VALUES(?,?,?) ON CONFLICT(owner,document_key) DO UPDATE SET revision_id=excluded.revision_id")
          .run(owner,a.key,a.revision);
        this.store.db.prepare("UPDATE knowledge_pages SET state='published',error=NULL WHERE document_key=? AND state='retired'").run(a.key);
      }
    });
  }
  statusReader() {
    const materials = new Map(this.materials().map(m=>[m.key,m]));
    const articles = new Map(this.list().map(a=>[a.document.key,a]));
    const fixed = new Map<string, KnowledgeMaterial | null>();
    return knowledgeStatus({
      material: (key, digest) => {
        const current = materials.get(key);
        if (!digest || current?.digest === digest) return current;
        const id = key + ":" + digest;
        if (!fixed.has(id)) fixed.set(id, this.resolveMaterial(key, digest)?.material ?? null);
        return fixed.get(id);
      },
      article: (key, revision) => revision ? this.get(key, revision) : articles.get(key),
      invalidated: new Set(this.store.db.prepare("SELECT document_key FROM knowledge_invalidations").all().map(r=>String(r.document_key))),
    });
  }

  list(): KnowledgeArticle[] {
    return (this.store.db.prepare("SELECT r.id,r.artifact,h.current FROM knowledge_heads h JOIN knowledge_revisions r ON r.id=h.revision_id ORDER BY r.document_key").all() as Row[]).map(r => ({ ...JSON.parse(String(r.artifact)), revision: String(r.id), current: !!r.current }));
  }
  get(key: string, revision?: string): KnowledgeArticle | null {
    if (!revision) {
      const row = this.store.db.prepare("SELECT r.id,r.artifact,h.current FROM knowledge_heads h JOIN knowledge_revisions r ON r.id=h.revision_id WHERE h.document_key=?").get(key) as Row | undefined;
      return row ? { ...JSON.parse(String(row.artifact)), revision: String(row.id), current: !!row.current } : null;
    }
    const r = this.store.db.prepare("SELECT r.*,h.revision_id head,h.current FROM knowledge_revisions r LEFT JOIN knowledge_heads h ON h.document_key=r.document_key WHERE r.id=? AND r.document_key=?").get(revision, key) as Row | undefined;
    return r ? { ...JSON.parse(String(r.artifact)), revision: String(r.id), current: r.head === r.id && !!r.current } : null;
  }

  publish(artifact: KnowledgeArtifact, expectedPlan?: WikiPageBrief) {
    if (expectedPlan && stableDigest(this.pages().find(p => p.key === artifact.document.key)?.plan ?? null) !== stableDigest(expectedPlan))
      throw Error("阅读目标或补充材料在整理期间发生变化，请重新整理；已保留旧文和最新选材。");
    if (expectedPlan && artifact.selection && stableDigest(this.materialsForPlan(expectedPlan).map(m => m.key).sort()) !== stableDigest([...artifact.selection.materialKeys].sort()))
      throw Error("项目或主题的材料在整理期间发生变化，将按最新范围重新整理；旧文已保留。");
    const materials = new Map(this.materials().map(m => [m.key, m]));
    const articles = new Map(this.list().map(a => [a.document.key, a]));
    if (artifact.dependencies.some(d => d.kind === "material" ? materials.get(d.key)?.digest !== d.digest : articles.get(d.key)?.revision !== d.digest)) throw Error("KNOWLEDGE_INPUT_CHANGED");
    validateKnowledgeDocument(artifact.document, materials, articles);
    const revision = digest(stableDigest(artifact));
    const existing = this.get(artifact.document.key);
    if (existing?.revision === revision) return existing;
    this.store.tx(() => {
      this.store.db.prepare("INSERT OR IGNORE INTO knowledge_revisions VALUES(?,?,?,?)").run(revision, artifact.document.key, JSON.stringify(artifact), artifact.generation.at);
      this.store.db.prepare("INSERT INTO knowledge_heads VALUES(?,?,1) ON CONFLICT(document_key) DO UPDATE SET revision_id=excluded.revision_id,current=1").run(artifact.document.key, revision);
      this.store.db.prepare("DELETE FROM knowledge_invalidations WHERE document_key=?").run(artifact.document.key);
      this.store.db.prepare(`INSERT INTO knowledge_pages VALUES(?,?,?,'published',NULL,?) ON CONFLICT(document_key)
        DO UPDATE SET role=excluded.role,plan=COALESCE(excluded.plan,knowledge_pages.plan),state='published',error=NULL,updated_at=excluded.updated_at`)
        .run(artifact.document.key, publicationRole(artifact), artifact.reading ? JSON.stringify(artifact.reading) : null, artifact.generation.at);
      this.restoreQuestionActions(artifact, revision);
      const changedSections = artifact.document.sections.filter(section => {
        const previous = existing?.document.sections.find(s => s.key === section.key);
        return !previous || previous.title !== section.title || previous.body !== section.body;
      }).map(section => section.title);
      const removed = existing?.document.sections.filter(section => !artifact.document.sections.some(s => s.key === section.key)).map(s => s.title) ?? [];
      const details = existing
        ? [changedSections.length ? "更新章节：" + changedSections.join("、") : "正文章节未改动", removed.length ? "移除章节：" + removed.join("、") : "", `本版包含 ${artifact.document.citations.length} 处引用；独立复核通过。`].filter(Boolean).join("。")
        : `新增 ${artifact.document.sections.length} 个章节：${artifact.document.sections.map(s => s.title).join("、")}。独立复核通过。`;
      if (publicationRole(artifact) !== "note") this.store.record("knowledge", (existing ? "知识已更新：" : "新增知识：") + artifact.document.title, existing?.revision ?? null, revision, details);
    });
    this.refresh();
    return this.get(artifact.document.key)!;
  }

  private restoreQuestionActions(artifact: KnowledgeArtifact, revision: string) {
    const liveQuestions = new Set(artifact.document.questions.map(q => digest(artifact.document.key + ":" + q.question)));
    for (const row of this.store.db.prepare("SELECT id FROM knowledge_questions WHERE document_key=? AND state='open'").all(artifact.document.key) as Row[]) {
      if (!liveQuestions.has(String(row.id))) this.store.db.prepare("UPDATE knowledge_questions SET state='superseded',updated_at=? WHERE id=?").run(new Date().toISOString(), String(row.id));
    }
    for (const question of artifact.document.questions) {
      const id = digest(artifact.document.key + ":" + question.question);
      this.store.db.prepare("INSERT INTO knowledge_questions(id,document_key,article_revision,body,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET article_revision=excluded.article_revision,body=excluded.body,state=CASE WHEN knowledge_questions.state='superseded' THEN 'open' ELSE knowledge_questions.state END,updated_at=excluded.updated_at").run(id, artifact.document.key, revision, JSON.stringify(question), new Date().toISOString());
    }
  }

  /** Restore reviewed bytes and their fixed inputs. An import can advance only
   * its own previously managed head; applicability is recalculated separately. */
  restoreHistorical(artifact: KnowledgeArtifact, asHead = true, importOwner?: string) {
    if (artifact.version !== 1 || artifact.review?.verdict !== "accepted" || !artifact.generation?.model || !artifact.review.model) throw Error("Missing review provenance");
    const materials = new Map<string, KnowledgeMaterial>(), articles = new Map<string, KnowledgeArticle>();
    for (const dependency of artifact.dependencies) {
      if (dependency.kind === "material") {
        const entry = this.resolveMaterial(dependency.key, dependency.digest);
        if (entry) materials.set(dependency.key, entry.material);
      } else {
        const article = this.get(dependency.key, dependency.digest);
        if (article) articles.set(dependency.key, article);
      }
    }
    validateKnowledgeDocument(artifact.document, materials, articles, undefined, true);
    const revision = digest(stableDigest(artifact));
    this.store.tx(() => {
      this.store.db.prepare("INSERT OR IGNORE INTO knowledge_revisions VALUES(?,?,?,?)").run(revision, artifact.document.key, JSON.stringify(artifact), artifact.generation.at);
      if (asHead) {
        const head = this.get(artifact.document.key);
        const managed = importOwner && this.store.db.prepare("SELECT revision_id FROM knowledge_import_memberships WHERE owner=? AND document_key=?").get(importOwner, artifact.document.key);
        const canAdvance = !!head && !!managed && managed.revision_id === head.revision;
        this.store.db.prepare("INSERT OR IGNORE INTO knowledge_heads VALUES(?,?,0)").run(artifact.document.key, revision);
        if (canAdvance) this.store.db.prepare("UPDATE knowledge_heads SET revision_id=?,current=0 WHERE document_key=?")
          .run(revision,artifact.document.key);
        this.store.db.prepare("INSERT OR IGNORE INTO knowledge_pages VALUES(?,?,?,'published',NULL,?)")
          .run(artifact.document.key, publicationRole(artifact), artifact.reading ? JSON.stringify(artifact.reading) : null, artifact.generation.at);
        if (!head || canAdvance || head.revision === revision) {
          this.restoreQuestionActions(artifact, revision);
          this.store.db.prepare(`UPDATE knowledge_pages SET role=?,plan=COALESCE(?,plan),state='published',error=NULL,updated_at=?
            WHERE document_key=? AND (? OR state IN ('planned','retired'))`)
            .run(publicationRole(artifact),artifact.reading ? JSON.stringify(artifact.reading) : null,artifact.generation.at,artifact.document.key,Number(!head || head.revision !== revision));
        }
      }
    });
  }

  /** Refresh applicability per chapter; page identity and its plan remain stable. */
  refresh() {
    const assess = this.statusReader();
    for (const a of this.list()) this.store.db.prepare("UPDATE knowledge_heads SET current=? WHERE document_key=?")
      .run(Object.values(assess(a)).every(s=>s.state==="current") ? 1 : 0, a.document.key);
  }

  resolveMaterial(key: string, expectedDigest?: string) {
    const current = this.materials().find(m => m.key === key);
    if (current && (!expectedDigest || current.digest === expectedDigest)) return { material: current, current: true };
    const sourceId = sourceForMaterialKey(this.store.db, key);
    if (!sourceId) return null;
    for (const row of this.store.db.prepare("SELECT id FROM revisions WHERE source_id=? ORDER BY created_at DESC").all(sourceId) as Row[]) {
      const m = materialFromRevision(this.store, String(row.id));
      if (m && (!expectedDigest || m.digest === expectedDigest)) return { material: { ...m, key, path: m.path ?? current?.path ?? null }, current: false };
    }
    return null;
  }

  questions() { return (this.store.db.prepare("SELECT * FROM knowledge_questions ORDER BY updated_at DESC").all() as Row[]).map(r => ({ id: String(r.id), documentKey: String(r.document_key), ...JSON.parse(String(r.body)), state: String(r.state), taskId: r.task_id, answerRevision: r.answer_revision })); }

  answer(id: string, answer: string) {
    const q = this.questions().find(q => q.id === id);
    if (!q) throw Error("Question not found");
    const capture = this.store.capture({ source: "manual", externalId: `knowledge-answer:${id}`, title: q.question, parts: [{ type: "text", text: answer }], context: { application: "knowledge-reader", event: id, conversationId: q.documentKey }, provenance: { collectorId: "knowledge-reader", actorId: "owner", actorType: "owner", actorVerifiedBy: "local-ui", sourceUri: null, eventId: null, eventAt: new Date().toISOString(), timezone: "Asia/Shanghai", quoted: false, forwarded: false, producerKind: "original" } });
    const plan = this.pages().find(p => p.key === q.documentKey)?.plan;
    if (plan) {
      const material = materialFromRevision(this.store, capture.revision.id)!;
      this.savePlan({ ...plan, materialKeys: [...new Set([...(plan.materialKeys ?? this.materials().map(m => m.key)), material.key])] }, true);
    }
    this.store.db.prepare("UPDATE knowledge_questions SET state='answered',answer_revision=?,updated_at=? WHERE id=?").run(capture.revision.id, new Date().toISOString(), id);
    this.store.db.prepare("INSERT OR REPLACE INTO knowledge_invalidations VALUES(?,?)").run(q.documentKey, "用户补充了背景，需要重新核对");
    this.refresh();
    return capture.revision.id;
  }

  createTask(id: string) {
    const q = this.questions().find(q => q.id === id);
    if (!q) throw Error("Question not found");
    if (q.taskId) return String(q.taskId);
    const task = this.store.createTask({ title: q.question, detail: `${q.why}\n下一步：${q.nextStep}`, dueAt: null });
    const taskId = String(task.id);
    this.store.db.prepare("UPDATE knowledge_questions SET state='task',task_id=?,updated_at=? WHERE id=?").run(taskId, new Date().toISOString(), id);
    return taskId;
  }
}
