import { relevance, bestSnippet } from "../retrieval/relevance.js";
import type { RetrievalConfig } from "../retrieval/factory.js";
import type { RetrievalPort } from "../retrieval/port.js";
import { retrievalPurposes } from "../retrieval/port.js";
import { KeywordRetrieval, tokenize } from "../retrieval/keyword.js";
import { fragmentPositions } from "./structure.js";
import type { FastifyInstance } from "fastify";
import type { Store } from "../store.js";
import type { AgentProfile } from "../../../../packages/contracts/src/index.js";
import type { GenerationBudget } from "../agent-runtime/budget.js";
import { RoleBundleRegistry } from "../agent-runtime/bundles.js";
import { RoleRuntimeGateway } from "../agent-runtime/gateway.js";
import { RuntimeRequestRepository } from "../agent-runtime/requests.js";
import { KnowledgePipeline } from "./pipeline.js";
import { KnowledgeRepository, type KnowledgeArticle } from "./repository.js";
import { posix } from "node:path";
import { parseFile } from "../code/parse.js";
import { wikiPageBriefSchema } from "../../../../packages/contracts/src/knowledge.js";
import { KnowledgePageWorker } from "./page-worker.js";
import { KnowledgePageService } from "./page-service.js";
import { MaterialDescriptionWorker } from "../source-profile/description-worker.js";
import { requirementHandoff } from "./requirements.js";

export function registerKnowledgeRoutes(app: FastifyInstance, input: { store: Store; prefix: string; workspace: string; repository?: KnowledgeRepository; retrieval?: RetrievalPort; retrievalConfig?: RetrievalConfig; profile?: AgentProfile; budget?: Partial<GenerationBudget>; onAnswer?: () => void; onPublish?: (a: KnowledgeArticle) => void; onService?: (service: KnowledgePageService) => void; preparePage?: (plan: import("../../../../packages/contracts/src/knowledge.js").WikiPageBrief) => void; beforePageRun?: (plan: import("../../../../packages/contracts/src/knowledge.js").WikiPageBrief, signal: AbortSignal) => Promise<unknown> }) {
  const repository = input.repository ?? new KnowledgeRepository(input.store);
  const prefix = input.prefix;
  app.get<{Params:{key:string}}>(prefix + "/pages/:key/handoff", async (req, reply) => {
    try { repository.refresh(); return requirementHandoff(repository, req.params.key); }
    catch (error) { return reply.code(409).send({error: error instanceof Error ? error.message : String(error)}); }
  });
  const retrieval: RetrievalPort = input.retrieval ?? new KeywordRetrieval(input.store.db);
  let running: KnowledgePipeline | null = null;
  let lastRun: unknown = null;
  const maintenance = new KnowledgePageWorker(repository, {
    prepare: input.preparePage,
    settleMs: 12000,
    blocked: () => !!running,
    onError: error => app.log.error(error),
    run: input.profile ? async (brief, job, signal) => {
      const investigationHints = await input.beforePageRun?.(brief, signal);
      const pipeline = new KnowledgePipeline(repository, new RoleRuntimeGateway(new RoleBundleRegistry(), input.workspace, new RuntimeRequestRepository(input.store.db)),
        { ...input.profile!, id: "traex" }, { retrievalConfig: input.retrievalConfig, budget: input.budget, investigationHints, onPublish: input.onPublish, retryTag: `${job.id}:${job.generation}` });
      running = pipeline;
      const cancel = () => { void pipeline.stop(); };
      signal.addEventListener("abort", cancel, { once: true });
      try {
        if (signal.aborted) throw Error("Knowledge maintenance cancelled");
        return (await pipeline.writePage(brief))[0]?.revision;
      } finally {
        signal.removeEventListener("abort", cancel);
        await pipeline.stop();
        running = null;
      }
    } : undefined,
  });
  const pages = new KnowledgePageService(repository, maintenance, !!input.profile);
  input.onService?.(pages);
  const descriptions = new MaterialDescriptionWorker(repository, {
    blocked: () => !!running || maintenance.busy(),
    onError: error => app.log.error(error),
    run: input.profile ? async (material, job, signal) => {
      const pipeline = new KnowledgePipeline(repository, new RoleRuntimeGateway(new RoleBundleRegistry(), input.workspace, new RuntimeRequestRepository(input.store.db)),
        { ...input.profile!, id: "traex" }, { retrievalConfig: input.retrievalConfig, budget: input.budget, retryTag: `${job.id}:${job.generation}` });
      running = pipeline;
      const cancel = () => { void pipeline.stop(); };
      signal.addEventListener("abort", cancel, { once: true });
      try {
        if (signal.aborted) throw Error("Material description cancelled");
        await pipeline.describeMaterials([material]);
      } finally {
        signal.removeEventListener("abort", cancel);
        await pipeline.stop();
        running = null;
      }
    } : undefined,
  });
  app.addHook("onReady", async () => { maintenance.start(); descriptions.start(); });
  app.get<{ Querystring: { revisionId: string } }>(prefix + "/description-run", async (req, reply) => {
    if (!req.query.revisionId) return reply.code(400).send({error:"请选择材料版本"});
    try { return descriptions.status(req.query.revisionId); }
    catch (error) { return reply.code(404).send({error:String(error)}); }
  });
  app.put<{ Params: { revisionId: string }; Body: { enabled: boolean } }>(prefix + "/description-maintenance/:revisionId", async (req, reply) => {
    if (typeof req.body?.enabled !== "boolean") return reply.code(400).send({error:"请选择是否自动整理"});
    if (req.body.enabled && !input.profile) return reply.code(503).send({error:"请先在能力与连接中配置 Agent"});
    try { return descriptions.setEnabled(req.params.revisionId, req.body.enabled); }
    catch (error) { return reply.code(409).send({error:String(error)}); }
  });
  app.post<{ Body: {revisionIds: string[]; followUpdates?: boolean} }>(prefix + "/describe", async (req, reply) => {
    if (!input.profile) return reply.code(503).send({error:"请先在能力与连接中配置 Agent"});
    const ids = req.body?.revisionIds;
    if (!Array.isArray(ids) || !ids.length || ids.length > 30 || ids.some(id => typeof id !== "string")) return reply.code(400).send({error:"请选择 1–30 份材料"});
    const selected = repository.materials().filter(m => ids.includes(m.revisionId));
    if (selected.length !== new Set(ids).size) return reply.code(409).send({error:"材料已更新，请重新选择当前版本"});
    if (selected.some(m => input.store.descriptions.get(m.revisionId)?.author === "user")) return reply.code(409).send({error:"这些材料有人工修正，已保留；原文换版后可重新分析"});
    if (req.body.followUpdates !== undefined && typeof req.body.followUpdates !== "boolean") return reply.code(400).send({error:"自动整理选项无效"});
    for (const material of selected) {
      descriptions.setEnabled(material.revisionId, req.body.followUpdates === true);
      descriptions.request(material.revisionId);
    }
    return reply.code(202).send({state:"queued",revisionIds:ids});
  });
  const meta = (a: KnowledgeArticle) => ({ key: a.document.key, title: a.document.title, summary: a.document.summary, category: a.document.category, current: a.current, revision: a.revision,
    topicPath: a.document.topicPath ?? [], generatedAt: a.generation.at, model: a.generation.model, reviewedBy: a.review.model, questionCount: a.document.questions.length, reading: a.reading, role: repository.role(a) });
  const resolveCitation = (a: KnowledgeArticle, key: string) => {
    const c = a.document.citations.find(c => c.key === key);
    if (!c) return null;
    const dependency = a.dependencies.find(d => d.kind === c.target.kind && d.key === c.target.key);
    if (!dependency) return { ...c, actionable: false, unavailableReason: "引用缺少固定版本依据" };
    if (c.target.kind === "article") {
      const target = repository.get(c.target.key, dependency.digest);
      return { ...c, actionable: !!target, unavailableReason: target ? null : "被引用的知识版本不可用", current: target?.current ?? false,
        resolved: target ? { kind: "article", key: target.document.key, revision: target.revision, section: c.target.section, title: target.document.title } : null };
    }
    const target = repository.resolveMaterial(c.target.key, dependency.digest);
    return { ...c, actionable: !!target, unavailableReason: target ? null : "被引用的原始材料版本不可用", current: target?.current ?? false,
      resolved: target ? { kind: "material", key: target.material.key, digest: target.material.digest, title: target.material.title, startLine: c.target.startLine, endLine: c.target.endLine } : null };
  };
  app.get(prefix + "/articles", async () => { repository.refresh(); return { articles: repository.published().map(meta), pages: repository.pages().map(p => ({ ...p, maintenance: maintenance.status(p.key) })), contexts: input.store.contexts.list(), materials: repository.materials().map(m => ({ key: m.key, title: m.title, path: m.path, revisionId: m.revisionId, contextIds: input.store.contexts.forSource(m.sourceId) })), running: !!running || maintenance.busy(), lastRun: maintenance.lastRun() ?? lastRun }; });
  app.get<{ Params: { key: string }; Querystring: { revision?: string } }>(prefix + "/articles/:key", async (req, reply) => {
    repository.refresh();
    const a = repository.get(req.params.key, req.query.revision);
    if (!a) return reply.code(404).send({ error: "尚未生成这份知识" });
    return { ...meta(a), document: a.document, sectionStatus: repository.statusReader()(a), citations: a.document.citations.map(c => resolveCitation(a, c.key)) };
  });
  app.get<{ Querystring: { document: string; revision?: string; citation: string } }>(prefix + "/citation", async (req, reply) => {
    const a = repository.get(req.query.document, req.query.revision);
    const c = a && resolveCitation(a, req.query.citation);
    return c ?? reply.code(404).send({ error: "引用不存在" });
  });
  app.get<{ Params: { key: string }; Querystring: { digest?: string } }>(prefix + "/materials/:key", async (req, reply) => {
    const entry = repository.resolveMaterial(req.params.key, req.query.digest);
    if (!entry) return reply.code(404).send({ error: "固定材料不可用" });
    const m = entry.material;
    const knowledge = repository.published().find(a=>a.document.key===m.key);
    const all = repository.materials();
    const documentLinks: { href: string; target: string }[] = [];
    if (m.path) for (const match of m.text.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const href = match[1]!;
      if (/^(?:[a-z]+:|\/\/)/i.test(href)) continue;
      const file = href.split("#")[0]!;
      let decoded = file; try { decoded = decodeURIComponent(file); } catch { continue; }
      const path = file ? posix.normalize(posix.join(posix.dirname(m.path), decoded)) : m.path;
      const targets = all.filter(target => target.namespace === m.namespace && target.path === path);
      if (targets.length === 1) documentLinks.push({ href, target: targets[0]!.key });
    }
    const links: { line: number; label: string; reason: string; target: string }[] = [];
    if (m.path && /\.(?:[cm]?[jt]sx?|vue)$/.test(m.path)) {
      const parsed = parseFile(m.path, m.text);
      for (const imp of parsed.imports) {
        if (!imp.specifier.startsWith(".")) continue;
        const path = posix.normalize(posix.join(posix.dirname(m.path), imp.specifier));
        const base = path.replace(/\.[cm]?js$/, "");
        const candidates = [path, ...[".ts", ".tsx", ".vue", ".js", "/index.ts"].map(e => base + e)];
        const target = all.find(x => x.path && candidates.includes(x.path));
        if (target) links.push({ line: imp.rangeStart.line, label: target.path?.split("/").pop() ?? target.title, reason: `该 import 引用了 ${target.title}；这是确定性的模块依赖，调用行为请结合知识正文。`, target: target.key });
      }
    }
    const filename = m.path ?? (["file", "git"].includes(m.namespace) ? m.title : "");
    const document = input.store.revision(m.revisionId)?.context.document;
    const codeLanguage = !document && filename && !/\.(md|markdown)$/i.test(filename) ? filename.split(".").at(-1)?.toLowerCase() ?? "text" : null;
    return { key: m.key, title: m.title, path: m.path, codeLanguage, digest: m.digest, revisionId: m.revisionId, text: m.text, lineCount: m.lineCount, current: entry.current,
      document, materialDescription: input.store.descriptions.get(m.revisionId),
      images: m.images.map(i => ({ ...i, url: prefix + "/assets/" + i.assetId })), knowledge: knowledge ? meta(knowledge) : null, links, documentLinks };
  });
  app.get<{ Params: { id: string } }>(prefix + "/assets/:id", async (req, reply) => {
    const image = input.store.db.prepare("SELECT json_extract(p.value,'$.mimeType') mime FROM revisions r,json_each(r.body,'$.parts') p WHERE json_extract(p.value,'$.type')='image' AND json_extract(p.value,'$.assetId')=? LIMIT 1").get(req.params.id) as { mime: string } | undefined;
    const bytes = image && input.store.asset(req.params.id);
    if (!image || !["image/png", "image/jpeg", "image/webp"].includes(image.mime) || !bytes) return reply.code(404).send({ error: "图片不可用" });
    return reply.type(image.mime).send(bytes);
  });
  app.get(prefix + "/questions", async () => {
    const published = new Set(repository.published().map(a=>a.document.key));
    return repository.questions().filter(q=>published.has(q.documentKey));
  });
  app.post<{ Params: { id: string }; Body: { answer: string } }>(prefix + "/questions/:id/answer", async (req, reply) => {
    if (typeof req.body?.answer !== "string" || !req.body.answer.trim() || req.body.answer.length > 20000) return reply.code(400).send({ error: "请提供 1–20000 字的回答" });
    const revisionId = repository.answer(req.params.id, req.body.answer.trim()); input.onAnswer?.();
    return { revisionId };
  });
  app.post<{ Params: { id: string } }>(prefix + "/questions/:id/task", async req => ({ taskId: repository.createTask(req.params.id) }));
  app.get<{ Querystring: { q?: string; topic?: string; purpose?: string } }>(prefix + "/search", async (req, reply) => {
    const text = (req.query.q ?? "").trim().slice(0, 300), terms = tokenize(text);
    if (!terms.length) return [];
    repository.refresh();
    let topic: string[] = [];
    try { if (req.query.topic) { topic = JSON.parse(req.query.topic); if (!Array.isArray(topic) || topic.some(p => typeof p !== "string")) throw Error(); } }
    catch { return reply.code(400).send({ error: "分类路径无效" }); }
    const articles = repository.published().filter(a => topic.every((part, i) => a.document.topicPath?.[i] === part));
    if (retrieval.search) {
      const purpose = req.query.purpose ?? "concept";
      if (!retrievalPurposes.includes(purpose as typeof retrievalPurposes[number])) return reply.code(400).send({ error: "查找用途无效" });
      const hits = await retrieval.search({ text, limit: 50, kinds: ["knowledge"], topicPath: topic, purpose: purpose as typeof retrievalPurposes[number] });
      const byKey = new Map(articles.map(a => [a.document.key, a]));
      const seen = new Set<string>();
      return hits.flatMap(hit => {
        if (hit.target.kind !== "knowledge" || seen.has(hit.target.key)) return [];
        const a = byKey.get(hit.target.key); if (!a || a.revision !== hit.target.revision) return [];
        seen.add(hit.target.key);
        return [{ ...meta(a), section: hit.target.section, sectionTitle: hit.headingPath.join(" / "), excerpt: hit.text, derived: true, score: hit.score, routes: hit.routes }];
      });
    }
    const materials = new Map(repository.materials().map(m => [m.key, m]));
    const scopedFragments = new Set(articles.flatMap(a => a.dependencies.filter(d => d.kind === "material").flatMap(d => materials.get(d.key)?.fragments.map(f => f.id) ?? [])));
    const query = { text, limit: 60, ...(topic.length ? { visible: (id: string) => scopedFragments.has(id) } : {}) };
    const hits = await (retrieval.searchSourcesAsync?.(query) ?? retrieval.searchSources(query));
    const maxScore = Math.max(...hits.map(h => h.score), 1e-6);
    const hitRanks = new Map(hits.map(hit => [hit.fragmentId, hit.score / maxScore]));
    const assess = repository.statusReader();
    const ranked = articles.flatMap(a => a.document.sections.filter(section=>assess(a)[section.key]?.state === "current").flatMap(section => {
      const lexical = relevance(section.title + " " + section.body, terms, a.document.title);
      let evidence = 0;
      for (const c of a.document.citations.filter(c => section.body.includes("[[" + c.key + "]]"))) {
        if (c.target.kind !== "material") continue;
        const material = materials.get(c.target.key);
        if (!material) continue;
        for (const fragment of fragmentPositions(material)) {
          if (fragment.endLine >= (c.target.startLine ?? 1) && fragment.startLine <= (c.target.endLine ?? material.lineCount)) evidence = Math.max(evidence, hitRanks.get(fragment.id) ?? 0);
        }
      }
      const score = lexical + evidence * .4;
      return score ? [{ ...meta(a), section: section.key, sectionTitle: section.title, excerpt: bestSnippet(section.body, terms, 600), derived: true, score }] : [];
    })).sort((a, b) => b.score - a.score);
    // One article per result, with its best matching section. Long articles do
    // not consume the whole result window simply by repeating related words.
    const best = new Map<string, typeof ranked[number]>();
    for (const hit of ranked) if (!best.has(hit.key)) best.set(hit.key, hit);
    return [...best.values()].slice(0, 50);
  });
  function startPage(brief: import("../../../../packages/contracts/src/knowledge.js").WikiPageBrief) {
    maintenance.request(brief.key);
    return { state: "queued", key: brief.key };
  }
  app.put<{ Params: { key: string }; Body: { enabled: boolean } }>(prefix + "/pages/:key/maintenance", async (req, reply) => {
    if (typeof req.body?.enabled !== "boolean") return reply.code(400).send({ error: "请选择是否随材料更新" });
    if (req.body.enabled && !input.profile) return reply.code(503).send({ error: "请先在能力与连接中配置 Agent" });
    try { return maintenance.setEnabled(req.params.key, req.body.enabled); }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : "无法设置自动更新" }); }
  });
  app.post<{Params:{key:string}}>(prefix+"/pages/:key/refresh", async(req,reply)=>{
    if (!input.profile) return reply.code(503).send({error:"请先在能力与连接中配置 Agent"});
    if (["queued", "writing"].includes(maintenance.status(req.params.key)?.state ?? "")) return reply.code(409).send({error:"这篇文章正在整理"});
    const brief=repository.pages().find(p=>p.key===req.params.key)?.plan;
    if (!brief) return reply.code(404).send({error:"这篇内容没有保存阅读目标，请从整理文章开始"});
    return reply.code(202).send(startPage(brief));
  });
  app.route<{ Params: { key?: string }; Body: { brief: unknown; revisionIds: string[] } }>({ method: ["POST", "PUT"], url: prefix + "/pages/:key?", handler: async (req, reply) => {
    if (!input.profile) return reply.code(503).send({ error: "请先在能力与连接中配置 Agent" });
    const editing = req.method === "PUT";
    if (editing && !repository.pages().some(p => p.key === req.params.key && p.plan)) return reply.code(404).send({ error: "这篇文章没有保存阅读目标" });
    const parsed = wikiPageBriefSchema.safeParse(req.body?.brief);
    const ids = req.body?.revisionIds;
    if (!parsed.success || !Array.isArray(ids) || (!ids.length && !parsed.data.contextIds?.length) || ids.some(id => typeof id !== "string")) return reply.code(400).send({ error: "请填写阅读目标并选择原始材料、项目或主题" });
    if (editing && parsed.data.key !== req.params.key) return reply.code(400).send({ error: "文章已切换，请重新打开整理窗口" });
    if (!editing && repository.pages().some(p => p.key === parsed.data.key)) return reply.code(409).send({ error: "文章已存在，请使用调整材料与目标" });
    const selectedIds = new Set(ids), selected = repository.materials().filter(m => selectedIds.has(m.revisionId));
    if (selected.length !== selectedIds.size) return reply.code(400).send({ error: "所选材料已更新，请刷新后重试" });
    const brief = { ...parsed.data, materialKeys: selected.map(m => m.key) };
    try {
      if (!repository.materialsForPlan(brief).length) return reply.code(400).send({ error: "所选项目或主题还没有材料，请先保存材料" });
    } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : "材料范围不可用" }); }
    return reply.code(202).send(pages.save(brief, editing));
  } });
  app.post<{ Body: { revisionIds: string[] } }>(prefix + "/analyze", async (req, reply) => {
    if (!input.profile) return reply.code(503).send({ error: "未配置可用 Agent" });
    if (running || maintenance.busy()) return reply.code(409).send({ error: "知识整理正在进行" });
    if (!Array.isArray(req.body?.revisionIds) || !req.body.revisionIds.length || req.body.revisionIds.length > 500) return reply.code(400).send({ error: "请选择要整理的固定材料版本" });
    const ids = new Set(req.body.revisionIds), selected = repository.materials().filter(m => ids.has(m.revisionId));
    if (selected.length !== ids.size) return reply.code(400).send({ error: "部分材料已更新或不可用，请刷新后重试" });
    running = new KnowledgePipeline(repository, new RoleRuntimeGateway(new RoleBundleRegistry(), input.workspace, new RuntimeRequestRepository(input.store.db)), { ...input.profile, id: "traex" }, { retrievalConfig: input.retrievalConfig, budget: input.budget, concurrency: 2, onPublish: input.onPublish });
    const pipeline = running;
    void pipeline.analyze(selected).then(result => { lastRun = result; }).catch(error => { lastRun = { error: String(error) }; }).finally(() => { running = null; });
    return reply.code(202).send({ state: "running", materials: selected.length });
  });
  app.addHook("preClose", async () => { await descriptions.stop(); await maintenance.stop(); await running?.stop(); });
  return repository;
}
