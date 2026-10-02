import { MaterialResearch } from "./research.js";
import { prepareAgentResearch } from "./agent-research.js";
import type { RetrievalConfig } from "../retrieval/factory.js";
import { readFileSync } from "node:fs";
import type { AgentProfile, ContextManifest } from "../../../../packages/contracts/src/index.js";
import { knowledgeResearchSchema, type WikiPageBrief, knowledgeBatchSchema, knowledgePlanSchema, knowledgeReviewSchema, type KnowledgeArtifact, type KnowledgeDocument, type KnowledgeMaterial, type KnowledgePlan } from "../../../../packages/contracts/src/knowledge.js";
import { RoleBundleRegistry } from "../agent-runtime/bundles.js";
import { RoleRuntimeGateway, renderRolePrompt, type RoleRunTrace } from "../agent-runtime/gateway.js";
import { DurableJobWorker } from "../jobs/worker.js";
import { stableDigest } from "../storage/digest.js";
import { estimateTokens, type GenerationBudget } from "../agent-runtime/budget.js";
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
    return batch;
  }

  private async writeAndVerify(role: string, targets: Target[], offers: Offer[], articles: KnowledgeArticle[], priorFeedback?: unknown, publication?: { reading: WikiPageBrief; research: unknown; writerVersion: string }) {
    if (this.nativeResearch) offers = offers.map(o=>({material:o.material,ranges:[{start:1,end:o.material.lineCount}]}));
    let repair: unknown = priorFeedback;
    let remaining = targets;
    const published: KnowledgeArticle[] = [];
    for (let attempt = 0; attempt < 4; attempt++) {
      const write = await this.runRole(repair ? "knowledge-refresher" : role, offers, articles, { conservative: attempt === 3 ? "Retain only directly supported statements; turn remaining uncertain claims into scoped questions with next steps. Do not reintroduce rejected claims." : undefined, targetKeys: remaining.map(t => t.key), targets: remaining, catalogTopics: [...new Set(this.repository.list().map(a => JSON.stringify(a.document.topicPath ?? [])).filter(p => p !== "[]"))].map(p => JSON.parse(p)), reading: publication?.reading, research: publication?.research, revisionAttempt: attempt, ...(repair ? { revisionRequest: repair } : {}) }, out => this.checkBatch(out, remaining, offers, articles));
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
        const readKeys = new Set(document.citations.filter(c=>c.target.kind==="material").map(c=>c.target.key));
        if (this.nativeResearch) for (const t of [write.trace,review.trace]) for (const event of (t.usage.activity ?? []) as {reads?:string[]}[]) for(const key of event.reads??[])readKeys.add(key);
        const dependencies: KnowledgeArtifact["dependencies"] = offers.filter(o=>!this.nativeResearch||readKeys.has(o.material.key)).map(o => ({ kind: "material", key: o.material.key, digest: o.material.digest }));
        for (const a of articles.filter(a=>!this.nativeResearch||document.citations.some(c=>c.target.kind==="article"&&c.target.key===a.document.key))) dependencies.push({ kind: "article", key: a.document.key, digest: a.revision });
        if (this.stopping) throw Error("Knowledge publication cancelled");
        const artifact: KnowledgeArtifact = { version: 1, document, dependencies, ...(publication ? { reading: publication.reading } : {}),
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

  private previousFeedback(targets: KnowledgeMaterial[], offers: Offer[]) {
    const drafts: KnowledgeDocument[] = [], issues: unknown[] = [];
    for (const target of targets) {
      const rows = this.repository.store.db.prepare(`SELECT o.output_json,j.input_refs FROM role_outputs o JOIN jobs j ON j.id=o.job_id
        WHERE o.output_schema='KnowledgeReview.v1' AND EXISTS(SELECT 1 FROM json_each(o.output_json,'$.verdicts') v WHERE json_extract(v.value,'$.documentKey')=? AND json_extract(v.value,'$.verdict')='needs_revision') ORDER BY o.created_at DESC LIMIT 1`).all(target.key) as { output_json: string; input_refs: string }[];
      for (const row of rows) {
        const input = JSON.parse(row.input_refs)[0];
        if (!input.materials?.some((m: {key:string;digest:string}) => m.key === target.key && m.digest === target.digest)) continue;
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
    this.repository.refresh();
    const writerVersion = stableDigest([this.nativeResearch ? "native-research@1" : "reader-first@2", ...["knowledge-researcher", "knowledge-writer", "knowledge-refresher", "knowledge-verifier"].map(role => this.registry.load(role).bundleHash)]);
    const existing = this.repository.get(brief.key);
    if (existing?.current && stableDigest(existing.reading) === stableDigest(brief) && existing.generation.trace.writerVersion === writerVersion) return [existing];
    const available = this.repository.materials();
    const scope = brief.materialKeys ? new Set(brief.materialKeys) : null;
    const materials = scope ? available.filter(m => scope.has(m.key)) : available;
    if (!materials.length || (scope && materials.length !== scope.size)) throw Error("Selected materials are no longer available");
    if (this.nativeResearch) {
      const offers = materials.map(material=>({material,ranges:[{start:1,end:material.lineCount}]}));
      const articles = this.repository.list().filter(a=>a.current&&a.document.key!==brief.key);
      const run = await this.runRole("knowledge-researcher", offers, articles, {title:brief.title,page:brief}, out=>knowledgeResearchSchema.parse(out));
      const research = knowledgeResearchSchema.parse(run.result);
      if (!research.ready || research.requests.length) throw Error("Native researcher must complete its own tool investigation before writing");
      return this.writeAndVerify("knowledge-writer", [{...brief,purpose:brief.goal}], offers, articles, undefined,
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
      undefined, { reading: brief, research: { rounds, findings, gaps,
        materials: [...research.offers.values()].map(o => ({ key: o.material.key, digest: o.material.digest, ranges: o.ranges })) }, writerVersion });
  }

  async plan(): Promise<KnowledgePlan> {
    const materials = this.repository.materials();
    const articles = this.repository.list().filter(a => a.current);
    const base = materials[0];
    if (!base) throw Error("No captured materials to organize");
    const result = await this.runRole("knowledge-planner", this.nativeResearch ? materials.map(material=>({material,ranges:[{start:1,end:material.lineCount}]})) : [{ material: base, ranges: [{ start: 1, end: Math.min(base.lineCount, 100) }] }], this.nativeResearch ? articles : [],
      { title: "知识树规划", catalog: articles.map(a => ({ key: a.document.key, title: a.document.title, category: a.document.category, summary: a.document.summary.slice(0, 220) })) }, out => {
        const plan = knowledgePlanSchema.parse(out);
        for (const chapter of plan.chapters) for (const key of chapter.materialKeys) if (!articles.some(a => a.document.key === key)) throw Error(`Unknown catalog key ${key}`);
      });
    return knowledgePlanSchema.parse(result.result);
  }

  async synthesize(target: Target, childKeys: string[]): Promise<KnowledgeArticle[]> {
    const available = new Map(this.repository.list().filter(a => a.current).map(a => [a.document.key, a]));
    const children = [...new Set(childKeys)].map(k => available.get(k)).filter((a): a is KnowledgeArticle => !!a);
    if (!children.length) throw Error(`No reviewed child knowledge for ${target.key}`);
    if (children.length > 12) {
      const parts: string[] = [];
      for (let i = 0; i < children.length; i += 12) {
        const key = `${target.key}:part-${i / 12 + 1}`;
        await this.synthesize({ key, title: `${target.title} · 专题 ${i / 12 + 1}`, purpose: target.purpose }, children.slice(i, i + 12).map(a => a.document.key));
        parts.push(key);
      }
      return this.synthesize(target, parts);
    }
    const existing = available.get(target.key);
    if (existing && existing.dependencies.filter(d => d.kind === "article").length === children.length && children.every(a => existing.dependencies.some(d => d.kind === "article" && d.key === a.document.key && d.digest === a.revision))) return [existing];
    // Composing already-reviewed chapters is a different reading level from
    // interpreting file knowledge. Keep their fixed article references instead
    // of flattening every descendant source back into the parent prompt.
    const composingChapters = children.every(child => child.dependencies.some(d => d.kind === "article"));
    if (composingChapters) target = { ...target, purpose: `${target.purpose ?? ""} 这是已复核子章节的上层综述。使用正文内联 article 引用提供下钻入口，按子章节所支持的范围概括；它们不是新的独立事实证据。原始材料只提供有限背景，完整依据沿固定子章节引用回查。` };
    const materials = new Map(this.repository.materials().map(m => [m.key, m]));
    const offers = new Map<string, Offer>();
    if (!composingChapters) for (const child of children) for (const c of child.document.citations) if (c.target.kind === "material") {
      const m = materials.get(c.target.key); if (!m) continue;
      const offer = offers.get(m.key) ?? { material: m, ranges: [] };
      const start = c.target.startLine ?? 1, end = c.target.endLine ?? 1;
      if (!offer.ranges.some(r => r.start <= start && r.end >= end)) offer.ranges.push({ start, end });
      offers.set(m.key, offer);
    }
    // A higher-level synthesis cites lower-level derived articles; carry at
    // least one of their original dependencies so provenance remains explicit.
    if (!offers.size) for (const child of children) {
      const d = child.dependencies.find(d => d.kind === "material" && materials.has(d.key));
      if (d) { const m = materials.get(d.key)!; offers.set(m.key, { material: m, ranges: [{ start: 1, end: Math.min(m.lineCount, 60) }] }); break; }
    }
    let selected = [...offers.values()];
    for (const offer of selected) {
      const merged: { start: number; end: number }[] = [];
      for (const range of offer.ranges.sort((a, b) => a.start - b.start)) {
        const last = merged.at(-1);
        if (last && range.start <= last.end + 1) last.end = Math.max(last.end, range.end);
        else merged.push({ ...range });
      }
      offer.ranges = merged;
    }
    // When the configured budget permits it, provide the full relevant source
    // instead of making a chapter infer behavior between isolated excerpts.
    const full = selected.map(o => ({ material: o.material, ranges: [{ start: 1, end: o.material.lineCount }] }));
    if (!this.nativeResearch) try {
      const base = this.registry.load("knowledge-writer");
      const maxInput = this.options.budget?.maxInputTokens ?? base.manifest.budget.max_context_tokens;
      const bundle = { ...base, manifest: { ...base.manifest, budget: { ...base.manifest.budget, max_context_tokens: maxInput } } };
      const preview = renderRolePrompt(bundle, this.context("knowledge-writer", "context-budget-preview", full, children, { targetKeys: [target.key], targets: [target] }));
      const text = preview.blocks.map(b => b.type === "text" ? b.text : "").join("\n");
      if (!composingChapters && estimateTokens(text).budgetedTokens <= maxInput * 0.8) selected = full;
    } catch { /* Bounded excerpts remain explicit when the whole source is too large. */ }
    let feedback: unknown;
    const previous = this.repository.store.db.prepare(`SELECT o.output_json,j.input_refs FROM role_outputs o JOIN jobs j ON j.id=o.job_id
      WHERE o.output_schema='KnowledgeReview.v1' AND EXISTS(SELECT 1 FROM json_each(o.output_json,'$.verdicts') v WHERE json_extract(v.value,'$.documentKey')=? AND json_extract(v.value,'$.verdict')='needs_revision') ORDER BY o.created_at DESC LIMIT 1`).get(target.key) as { output_json: string; input_refs: string } | undefined;
    if (previous) {
      const input = JSON.parse(previous.input_refs)[0];
      const sameSources = input.materials?.every((m: { key: string; digest: string }) => materials.get(m.key)?.digest === m.digest);
      const sameArticles = input.articles?.every((a: { key: string; revision: string }) => available.get(a.key)?.revision === a.revision);
      const draft = input.task?.drafts?.find((d: KnowledgeDocument) => d.key === target.key);
      if (sameSources && sameArticles && draft) feedback = { previousDrafts: [draft], issues: JSON.parse(previous.output_json).verdicts.filter((v: { documentKey: string }) => v.documentKey === target.key), instruction: "Revise the rejected chapter precisely according to these issues. Preserve supported content and the cited scope; do not replace the chapter with unrelated prose." };
    }
    return this.writeAndVerify("knowledge-writer", [target], selected, children, feedback);
  }
}
