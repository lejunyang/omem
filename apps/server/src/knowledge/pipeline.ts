import { MaterialResearch } from "./research.js";
import { materialDescriptionBatchSchema } from "../../../../packages/contracts/src/material-description.js";
import { prepareAgentResearch } from "./agent-research.js";
import type { RetrievalConfig } from "../retrieval/factory.js";
import { readFileSync } from "node:fs";
import type { AgentProfile, ContextManifest } from "../../../../packages/contracts/src/index.js";
import { knowledgeResearchSchema, type WikiPageBrief, knowledgeBatchSchema, knowledgeReviewSchema, type KnowledgeArtifact, type KnowledgeDocument, type KnowledgeMaterial } from "../../../../packages/contracts/src/knowledge.js";
import { RoleBundleRegistry } from "../agent-runtime/bundles.js";
import { RoleRuntimeGateway, type RoleRunTrace } from "../agent-runtime/gateway.js";
import { DurableJobWorker } from "../jobs/worker.js";
import { stableDigest } from "../storage/digest.js";
import { type GenerationBudget } from "../agent-runtime/budget.js";
import { KnowledgeRepository, materialFromRevision, bindKnowledgeQuotes, validateKnowledgeDocument, type KnowledgeArticle } from "./repository.js";

type Offer = { material: KnowledgeMaterial; ranges: { start: number; end: number }[] };
type Target = { key: string; title: string; purpose?: string };
type RunResult = { result: unknown; trace: RoleRunTrace; at: string };

export function analystFor(m: KnowledgeMaterial) {
  if (m.images.length) return "visual-analyst";
  if (["chat", "hook"].includes(m.namespace) || (m.namespace === "lark" && !!m.conversationId)) return "conversation-analyst";
  return /\.(?:[cm]?[jt]sx?|vue|css|py|go|rs|sh)$/.test(m.path ?? (["file", "git"].includes(m.namespace) ? m.title : "")) ? "code-analyst" : "material-analyst";
}

export class KnowledgePipeline {
  readonly registry = new RoleBundleRegistry();
  private readonly running = new Set<DurableJobWorker>();
  private stopping = false;
  constructor(readonly repository: KnowledgeRepository, readonly gateway: RoleRuntimeGateway, readonly profile: AgentProfile,
    readonly options: { budget?: Partial<GenerationBudget>; nativeResearch?: boolean; retrievalConfig?: RetrievalConfig; concurrency?: number; retryTag?: string; onPublish?: (a: KnowledgeArticle) => void; log?: (message: string) => void } = {}) {}

  private get nativeResearch() { return this.options.nativeResearch ?? this.profile.transport === "acp"; }

  /** Optional catalog work shares the native investigation harness. It creates
   * navigation metadata, not personal facts or a replacement for original prose. */
  async describeMaterials(materials: KnowledgeMaterial[]) {
    const descriptions = this.repository.store.descriptions;
    const versions = new Map(materials.map(m => [m.key, descriptions.get(m.revisionId)]));
    const targets = materials.filter(m => versions.get(m.key)?.author !== "user");
    if (!targets.length) return [];
    const offers = targets.map(material => ({ material, ranges: [{ start: 1, end: material.lineCount }] }));
    const run = await this.runRole("material-cataloger", offers, [], {
      targetKeys: targets.map(m => m.key), descriptionVersions: targets.map(m => versions.get(m.key)?.version ?? 0),
      instruction: "Read each target's original text. Describe what it can answer, distinguish plans, research, examples and implemented behavior. No user question or expected answer is supplied.",
    }, out => {
      const batch = materialDescriptionBatchSchema.parse(out);
      if (batch.descriptions.length !== targets.length || new Set(batch.descriptions.map(d => d.key)).size !== targets.length || targets.some(m => !batch.descriptions.some(d => d.key === m.key))) throw Error("Describe every selected material exactly once");
      for (const entry of batch.descriptions) {
        const m = targets.find(m => m.key === entry.key)!;
        if (entry.description.concepts.some(c => c.endLine < c.startLine || c.endLine > m.lineCount)) throw Error(`Concept range outside ${m.key}`);
        const {validFrom, validUntil} = entry.description;
        if (validFrom && validUntil && Date.parse(validFrom) >= Date.parse(validUntil)) throw Error("Invalid effective time range");
      }
      return batch;
    });
    if (this.stopping) throw Error("Material description cancelled");
    return materialDescriptionBatchSchema.parse(run.result).descriptions.map(entry => {
      const m = targets.find(m => m.key === entry.key)!;
      const record = descriptions.save(m.revisionId, entry.description, "model", versions.get(m.key)?.version ?? 0, run.trace);
      return { key: m.key, digest: m.digest, ...record, trace: run.trace };
    });
  }

  async stop() { this.stopping = true; await Promise.all([...this.running].map(w => w.stop())); }

  private context(role: string, jobId: string, offers: Offer[], articles: KnowledgeArticle[], task: Record<string, unknown>): ContextManifest {
    const materials: ContextManifest["materials"] = [];
    if (this.nativeResearch) {
      const m = offers[0]?.material;
      if (!m) throw Error("At least one fixed original material is required");
      materials.push({content_scope:"revision",fragment_revision_id:m.fragments[0]?.id??m.revisionId,source_revision_id:m.revisionId,text:"Fixed originals are available in catalog.json and omem tools; read them on demand."});
    }
    for (const { material: m, ranges } of this.nativeResearch ? [] : offers) {
      const lines = m.text.split("\n");
      for (const range of ranges) {
        let text = "";
        const flush = () => { if (text) materials.push({ content_scope: "revision", fragment_revision_id: m.fragments[0]?.id ?? m.revisionId,
          source_revision_id: m.revisionId, actor_principal_id: m.actorId ?? null, observed_at: m.eventAt ?? null, quoted: m.quoted ?? false, forwarded: m.forwarded ?? false, text: `MATERIAL ${m.key}\nTitle: ${m.title}\nSource kind: ${m.namespace}; total lines: ${m.lineCount}\n${text}` }); text = ""; };
        for (let n = range.start; n <= range.end; n++) { const line = `L${n} ${lines[n - 1] ?? ""}\n`; if (text.length + line.length > 65000) flush(); text += line; }
        flush();
      }
      for (const image of m.images) {
        const asset = this.repository.store.asset(image.assetId);
        if (!asset) throw Error("Image asset unavailable");
        materials.push({ content_scope: "revision", fragment_revision_id: m.fragments[0]?.id ?? m.revisionId, source_revision_id: m.revisionId,
          text: `IMAGE MATERIAL ${m.key}: ${m.title}`, image: { asset_hash: image.assetId, mime_type: image.mimeType,
            data_base64: asset.toString("base64"), label: image.label } });
      }
    }
    if (!materials.length) throw Error("At least one fixed original material is required");
    return {
      schema_version: 1, job_id: jobId, role_id: role as ContextManifest["role_id"],
      trusted_context: { workspace_id: "personal", project_id: null, owner_id: "owner", observed_at: new Date().toISOString(), timezone: "Asia/Shanghai",
        actor_binding: { id: null, verified_by: null }, source_kind: (offers[0]?.material.namespace ?? "file") as ContextManifest["trusted_context"]["source_kind"], is_forwarded: offers.some(o => o.material.forwarded), producer_kind: "original", source_epoch: 1, project_trusted: false },
      materials, related_memories: [], confirmed_corrections: [],
      task: { ...task, nativeResearch: this.nativeResearch,
        ...(this.nativeResearch ? { materialCatalog: "catalog.json", articleCatalog: "knowledge.json" } : { articles: articles.map(a => ({ ...a.document, revision: a.revision, provenance: "derived knowledge, not independent evidence" })) }),
        allowedMaterials: (this.nativeResearch ? offers.slice(0, 1) : offers).map(o => ({ key: o.material.key, title: o.material.title, ranges: o.ranges, image: !!o.material.images.length })) },
    };
  }

  private async runRole(role: string, offers: Offer[], articles: KnowledgeArticle[], task: Record<string, unknown>, validate?: (out: unknown) => unknown): Promise<RunResult> {
    if (this.stopping) throw Error("Knowledge pipeline stopped");
    const bundle = this.registry.load(role);
    const refs = [{ role, task, workflow: this.nativeResearch ? "native-research@1" : "bounded-context@1", retryTag: this.options.retryTag, materials: offers.map(o => ({ key: o.material.key, digest: o.material.digest, ranges: o.ranges })),
      articles: articles.map(a => ({ key: a.document.key, revision: a.revision })), model: this.profile.model, effort: this.profile.effort, budget: this.options.budget, bundleHash: bundle.bundleHash }];
    const { job } = this.repository.store.jobs.enqueue({ kind: `knowledge:${role}`, inputRefs: refs, roleVersion: bundle.bundleHash, policyVersion: "knowledge@1", maxAttempts: 3, cause: "knowledge-generation" });
    const result = () => {
      const row = this.repository.store.db.prepare("SELECT output_json,trace_json,created_at FROM role_outputs WHERE job_id=? ORDER BY attempt DESC LIMIT 1").get(job.id) as { output_json: string; trace_json: string; created_at: string } | undefined;
      if (!row) throw Error("Completed knowledge job has no output");
      const out = JSON.parse(row.output_json); const normalized = validate?.(out); return { result: normalized ?? out, trace: JSON.parse(row.trace_json) as RoleRunTrace, at: row.created_at };
    };
    if (job.state === "succeeded") return result();
    if (["failed", "cancelled", "awaiting_user"].includes(job.state)) throw Error(`${role} requires retry: ${job.lastError ?? job.state} (job ${job.id})`);
    const worker = new DurableJobWorker(this.repository.store.jobs, `knowledge-${job.id}`, {
      [`knowledge:${role}`]: async (lease, signal) => {
        this.options.log?.(`AI ${role}: ${String(task.targetKeys ?? task.title ?? "catalog")}`);
        const run = await this.gateway.run({ roleId: role, profile: this.profile, context: this.context(role, lease.id, offers, articles, task), signal, budget: this.options.budget, validateOutput: validate,
          ...(this.nativeResearch ? { research: (workspace, schema, validate) => prepareAgentResearch({ repository:this.repository, materials:offers.map(o=>o.material), articles, workspace, schema, validate, retrievalConfig:this.options.retrievalConfig }) } : {}),
          emit: (type, text) => { if (type === "status") this.options.log?.(text); } });
        const saved = this.repository.store.jobs.saveRoleOutput({ jobId: lease.id, leaseToken: lease.leaseToken,
          model: run.trace.effectiveModel, effort: run.trace.effectiveEffort, promptHash: run.trace.promptHash, skillHash: run.trace.skillHash, toolHash: run.trace.toolHash,
          fingerprint: run.trace.fingerprint, roleBundleHash: run.trace.bundleHash, contextHash: run.trace.contextHash, outputSchema: run.trace.outputSchema,
          sessionId: run.trace.sessionIds.at(-1)!, loadedSkills: run.trace.loadedSkills, allowedTools: run.trace.allowedTools, usage: run.trace.usage, output: run.result, trace: run.trace });
        return { resultRef: saved.id, usage: run.trace.usage };
      },
    }, { fingerprint: () => ({ model: this.profile.model ?? "", effort: this.profile.effort ?? "", promptHash: bundle.bundleHash, skillHash: stableDigest(bundle.manifest.skill_bundles), toolHash: stableDigest([]) }), jobIds: [job.id], kinds: [`knowledge:${role}`], leaseMs: 60000, heartbeatMs: 10000 });
    this.running.add(worker);
    try {
      for (;;) {
        const state = this.repository.store.jobs.get(job.id)!;
        if (state.state === "succeeded") return result();
        if (this.stopping || ["failed", "cancelled", "awaiting_user"].includes(state.state)) throw Error(state.lastError ?? "Knowledge job interrupted");
        await worker.processOne();
        if (this.repository.store.jobs.get(job.id)?.state !== "succeeded") await new Promise(r => setTimeout(r, 300));
      }
    } finally { this.running.delete(worker); }
  }

  private checkBatch(out: unknown, targets: Target[], offers: Offer[], articles: KnowledgeArticle[]) {
    const batch = knowledgeBatchSchema.parse(out);
    if (batch.documents.length !== targets.length || new Set(batch.documents.map(d => d.key)).size !== targets.length || targets.some(t => !batch.documents.some(d => d.key === t.key))) throw Error(`Return exactly these document keys: ${targets.map(t => t.key).join(", ")}`);
    const materials = new Map(offers.map(o => [o.material.key, o.material]));
    const articleMap = new Map(articles.map(a => [a.document.key, a]));
    const offered = new Set([...materials.keys()].map(k => `material:${k}`).concat([...articleMap.keys()].map(k => `article:${k}`)));
    for (const d of batch.documents) {
      bindKnowledgeQuotes(d, materials);
      validateKnowledgeDocument(d, materials, articleMap, offered);
      for (const c of d.citations.filter(c => c.target.kind === "material")) {
        const o = offers.find(o => o.material.key === c.target.key)!;
        if (o.material.text && !o.ranges.some(r => c.target.startLine! >= r.start && c.target.endLine! <= r.end)) throw Error(`Citation ${c.key} requests unseen lines from ${c.target.key}`);
      }
    }
    for (const d of batch.documents) for (const section of d.sections) for (const source of section.reviewSources ?? []) {
      const offer = offers.find(o=>o.material.key===source.key);
      if (!offer?.ranges.some(r=>source.startLine >= r.start && source.endLine <= r.end)) throw Error(`Unseen review source: ${source.key}`);
    }
    return batch;
  }

  private async writeAndVerify(role: string, targets: Target[], offers: Offer[], articles: KnowledgeArticle[], priorFeedback?: unknown, publication?: { reading: WikiPageBrief; research: unknown; writerVersion: string }) {
    if (this.nativeResearch) offers = offers.map(o=>({material:o.material,ranges:[{start:1,end:o.material.lineCount}]}));
    let repair: unknown = priorFeedback;
    let remaining = targets;
    const published: KnowledgeArticle[] = [];
    for (let attempt = 0; attempt < 4; attempt++) {
      const write = await this.runRole(repair ? "knowledge-refresher" : role, offers, articles, { conservative: attempt === 3 ? "Retain only directly supported statements; turn remaining uncertain claims into scoped questions with next steps. Do not reintroduce rejected claims." : undefined, targetKeys: remaining.map(t => t.key), targets: remaining, catalogTopics: [...new Set(this.repository.list().map(a => JSON.stringify(a.document.topicPath ?? [])).filter(p => p !== "[]"))].map(p => JSON.parse(p)), reading: publication?.reading, research: publication ? {findings:(publication.research as {findings?:unknown}).findings,gaps:(publication.research as {gaps?:unknown}).gaps} : undefined, revisionAttempt: attempt, ...(repair ? { revisionRequest: repair } : {}) }, out => this.checkBatch(out, remaining, offers, articles));
      const batch = knowledgeBatchSchema.parse(write.result);
      // Explicit placement is user/page-plan data, not inferred from repository paths.
      if (publication?.reading.topicPath) for (const document of batch.documents) document.topicPath = publication.reading.topicPath;
      const review = await this.runRole("knowledge-verifier", offers, articles, { targetKeys: remaining.map(t => t.key), drafts: batch.documents, targets: remaining, reading: publication?.reading }, out => {
        const r = knowledgeReviewSchema.parse(out);
        if (r.verdicts.length !== remaining.length || remaining.some(t => !r.verdicts.some(v => v.documentKey === t.key))) throw Error("Review every target exactly once");
      });
      const verdicts = knowledgeReviewSchema.parse(review.result).verdicts;
      const rejected = verdicts.filter(v => v.verdict !== "accepted");
      for (const document of batch.documents.filter(d => !rejected.some(v => v.documentKey === d.key))) {
        const extraQuestions = verdicts.find(v => v.documentKey === document.key)!.questions;
        document.questions = [...document.questions, ...extraQuestions].filter((q, i, all) => all.findIndex(x => x.question === q.question) === i).slice(0, 20);
        const citedKeys = new Set([...document.citations.filter(c=>c.target.kind==="material").map(c=>c.target.key), ...document.sections.flatMap(s=>(s.reviewSources ?? []).map(r=>r.key))]);
        const readKeys = new Set<string>(this.nativeResearch ? [] : offers.map(o=>o.material.key));
        if (this.nativeResearch) for (const t of [write.trace,review.trace,(publication?.research as {trace?:RoleRunTrace})?.trace].filter((t):t is RoleRunTrace=>!!t)) for (const event of (t.usage.activity ?? []) as {reads?:string[]}[]) for(const key of event.reads??[])readKeys.add(key);
        const dependencies: KnowledgeArtifact["dependencies"] = offers.filter(o=>citedKeys.has(o.material.key)).map(o => ({ kind: "material", key: o.material.key, digest: o.material.digest }));
        for (const a of articles.filter(a=>document.citations.some(c=>c.target.kind==="article"&&c.target.key===a.document.key))) dependencies.push({ kind: "article", key: a.document.key, digest: a.revision });
        if (this.stopping) throw Error("Knowledge publication cancelled");
        const artifact: KnowledgeArtifact = { version: 1, document, dependencies, ...(publication ? { reading: publication.reading } : {}),
          publication: {role: publication ? publication.reading.kind === "reference" ? "reference" : "article" : "note"},
          investigation: offers.filter(o=>readKeys.has(o.material.key)).map(o=>({key:o.material.key,digest:o.material.digest})),
          generation: { model: write.trace.effectiveModel!, effort: write.trace.effectiveEffort, at: write.at, trace: { ...write.trace, ...(publication ? { research: publication.research, writerVersion: publication.writerVersion } : {}) } as unknown as Record<string, unknown> },
          review: { model: review.trace.effectiveModel!, at: review.at, trace: review.trace as unknown as Record<string, unknown>, verdict: "accepted" } };
        const article = this.repository.publish(artifact);
        this.options.onPublish?.(article); this.options.log?.(`Published ${document.key}`); published.push(article);
      }
      if (!rejected.length) return published;
      remaining = remaining.filter(t => rejected.some(v => v.documentKey === t.key));
      repair = { previousDrafts: batch.documents.filter(d => remaining.some(t => t.key === d.key)), issues: rejected };
    }
    throw Error(`Semantic review still requests changes: ${remaining.map(t => t.key).join(", ")}`);
  }

  private previousFeedback(targets: Target[], offers: Offer[], articles: KnowledgeArticle[] = [], reading?: WikiPageBrief) {
    const drafts: KnowledgeDocument[] = [], issues: unknown[] = [];
    for (const target of targets) {
      const rows = this.repository.store.db.prepare(`SELECT o.output_json,j.input_refs FROM role_outputs o JOIN jobs j ON j.id=o.job_id
        WHERE o.output_schema='KnowledgeReview.v1' AND EXISTS(SELECT 1 FROM json_each(o.output_json,'$.verdicts') v WHERE json_extract(v.value,'$.documentKey')=? AND json_extract(v.value,'$.verdict')='needs_revision') ORDER BY o.created_at DESC LIMIT 1`).all(target.key) as { output_json: string; input_refs: string }[];
      for (const row of rows) {
        const input = JSON.parse(row.input_refs)[0];
        if (!input.materials || stableDigest(input.task?.reading ?? null) !== stableDigest(reading ?? null)) continue;
        if ((input.articles ?? []).some((a:{key:string;revision:string})=>!articles.some(current=>current.document.key===a.key && current.revision===a.revision))) continue;
        // A draft from an old multi-document batch may rely on a sibling that
        // is no longer supplied. Do not smuggle that context into a repair.
        if (!input.materials.every((m: {key:string;digest:string}) => offers.some(o => o.material.key === m.key && o.material.digest === m.digest))) continue;
        const draft = input.task?.drafts?.find((d: KnowledgeDocument) => d.key === target.key);
        const verdict = JSON.parse(row.output_json).verdicts.find((v: {documentKey:string}) => v.documentKey === target.key);
        if (draft && verdict) { drafts.push(draft); issues.push(verdict); }
      }
    }
    return drafts.length ? { previousDrafts: drafts, issues, instruction: "Apply these precise corrections to the supplied prior drafts. Preserve unaffected claims; generate any new targets from their originals. Recheck modal strength such as required versus recommended and every cited range." } : undefined;
  }

  async analyze(materials: KnowledgeMaterial[], supplements: (targets: KnowledgeMaterial[]) => Offer[] = () => []) {
    const current = new Map(this.repository.list().filter(a => a.current).map(a => [a.document.key, a]));
    const verifierHash = this.nativeResearch ? this.registry.load("knowledge-verifier").bundleHash : null;
    const pending = materials.filter(m => {
      const a = current.get(m.key);
      return !a || (this.nativeResearch && (a.generation.trace.bundleHash !== this.registry.load(analystFor(m)).bundleHash || a.review.trace.bundleHash !== verifierHash));
    });
    // Each article gets its own original and explicit linked context. Sharing a
    // prompt to save calls made unrelated batch siblings permanent dependencies.
    // Concurrency still bounds cost; genuinely supplied context stays tracked.
    const batches = pending.map(material => [material]);
    const failures: { keys: string[]; error: string }[] = [];
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(this.options.concurrency ?? 3, batches.length) }, async () => {
      while (next < batches.length && !this.stopping) {
        const targets = batches[next++]!;
        const offers: Offer[] = targets.map(m => ({ material: m, ranges: [{ start: 1, end: m.lineCount }] }));
        for (const q of this.repository.questions().filter(q => q.answerRevision && targets.some(t => t.key === q.documentKey))) {
          const answer = materialFromRevision(this.repository.store, String(q.answerRevision));
          if (answer) offers.push({ material: answer, ranges: [{ start: 1, end: answer.lineCount }] });
        }
        for (const s of supplements(targets)) if (!offers.some(o => o.material.key === s.material.key)) offers.push(s);
        if (this.nativeResearch) for (const material of this.repository.materials()) if (!offers.some(o=>o.material.key===material.key)) offers.push({material,ranges:[{start:1,end:material.lineCount}]});
        try { await this.writeAndVerify(analystFor(targets[0]!), targets.map(m => ({ key: m.key, title: m.title })), offers, [], this.previousFeedback(targets, offers)); }
        catch (error) { const failure = { keys: targets.map(m => m.key), error: String(error) }; failures.push(failure); this.options.log?.(`FAILED ${failure.keys.join(", ")}: ${failure.error}`); }
      }
    }));
    return { total: materials.length, reused: materials.length - pending.length, failures };
  }

  /** Publish a reader page directly from investigated originals. File summaries
   * are optional background, never a prerequisite or an arbitrary batching tree. */
  async writePage(brief: WikiPageBrief) {
    this.repository.savePlan(brief);
    this.repository.pageState(brief.key, "writing");
    try {
      const articles = await this.writePlannedPage(brief);
      this.repository.pageState(brief.key, "published");
      return articles;
    } catch (error) {
      this.repository.pageState(brief.key, "failed", String(error));
      throw error;
    }
  }

  private async writePlannedPage(brief: WikiPageBrief) {
    this.repository.refresh();
    const writerVersion = stableDigest([this.nativeResearch ? "native-research@2" : "reader-first@3", ...["knowledge-researcher", "knowledge-writer", "knowledge-refresher", "knowledge-verifier"].map(role => this.registry.load(role).bundleHash)]);
    const existing = this.repository.get(brief.key);
    if (!this.options.retryTag && existing?.current && stableDigest(existing.reading) === stableDigest(brief) && existing.generation.trace.writerVersion === writerVersion) return [existing];
    const available = this.repository.materials();
    const scope = brief.materialKeys ? new Set(brief.materialKeys) : null;
    const materials = scope ? available.filter(m => scope.has(m.key)) : available;
    if (!materials.length || (scope && materials.length !== scope.size)) throw Error("Selected materials are no longer available");
    if (this.nativeResearch) {
      const offers = materials.map(material=>({material,ranges:[{start:1,end:material.lineCount}]}));
      const articles = this.repository.published().filter(a=>a.current&&a.document.key!==brief.key);
      const run = await this.runRole("knowledge-researcher", offers, articles, {title:brief.title,page:brief}, out=>knowledgeResearchSchema.parse(out));
      const research = knowledgeResearchSchema.parse(run.result);
      if (!research.ready || research.requests.length) throw Error("Native researcher must complete its own tool investigation before writing");
      return this.writeAndVerify("knowledge-writer", [{...brief,purpose:brief.goal}], offers, articles, this.previousFeedback([brief], offers, articles, brief),
        {reading:brief,research:{trace:run.trace,findings:research.findings,gaps:research.gaps},writerVersion});
    }
    const research = new MaterialResearch(materials, brief);
    if (!research.offers.size) research.search(brief.title + " " + brief.goal);
    if (!research.offers.size) for (const m of materials.slice(0, 3)) research.read(m.key, 1, Math.min(m.lineCount, 80));
    const rounds: unknown[] = [];
    let observations: unknown = [], findings = "", gaps: string[] = [];
    for (let round = 0; round < 3; round++) {
      const run = await this.runRole("knowledge-researcher", [...research.offers.values()], [], {
        title: brief.title, page: brief, round, remainingRounds: 3 - round, catalog: research.catalog(), observations, findings,
      }, out => knowledgeResearchSchema.parse(out));
      const result = knowledgeResearchSchema.parse(run.result);
      findings = result.findings; gaps = result.gaps;
      rounds.push({ trace: run.trace, findings, gaps, requests: result.requests });
      // Execute a last round's requests too: the writer and verifier will see
      // the fetched source even when investigation has exhausted its round budget.
      observations = research.execute(result.requests);
      if (result.ready && !result.requests.length) break;
    }
    const target = { ...brief, purpose: brief.goal };
    return this.writeAndVerify("knowledge-writer", [target], [...research.offers.values()], [],
      this.previousFeedback([brief], [...research.offers.values()], [], brief), { reading: brief, research: { rounds, findings, gaps,
        materials: [...research.offers.values()].map(o => ({ key: o.material.key, digest: o.material.digest, ranges: o.ranges })) }, writerVersion });
  }

}
