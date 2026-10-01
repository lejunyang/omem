import type { RetrievalPort } from "../retrieval/port.js";
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

export function registerKnowledgeRoutes(app: FastifyInstance, input: { store: Store; prefix: string; workspace: string; repository?: KnowledgeRepository; retrieval?: RetrievalPort; profile?: AgentProfile; budget?: Partial<GenerationBudget>; onAnswer?: () => void; onPublish?: (a: KnowledgeArticle) => void }) {
  const repository = input.repository ?? new KnowledgeRepository(input.store);
  const prefix = input.prefix;
  const retrieval: RetrievalPort = input.retrieval ?? new KeywordRetrieval(input.store.db);
  let running: KnowledgePipeline | null = null;
  let lastRun: unknown = null;
  const meta = (a: KnowledgeArticle) => ({ key: a.document.key, title: a.document.title, summary: a.document.summary, category: a.document.category, current: a.current, revision: a.revision,
    topicPath: a.document.topicPath ?? [], generatedAt: a.generation.at, model: a.generation.model, reviewedBy: a.review.model, questionCount: a.document.questions.length, reading: a.reading });
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
  app.get(prefix + "/articles", async () => { repository.refresh(); return { articles: repository.list().map(meta), materials: repository.materials().map(m => ({ key: m.key, title: m.title, path: m.path, revisionId: m.revisionId })), running: !!running, lastRun }; });
  app.get<{ Params: { key: string }; Querystring: { revision?: string } }>(prefix + "/articles/:key", async (req, reply) => {
    repository.refresh();
    const a = repository.get(req.params.key, req.query.revision);
    if (!a) return reply.code(404).send({ error: "尚未生成这份知识" });
    return { ...meta(a), document: a.document, citations: a.document.citations.map(c => resolveCitation(a, c.key)) };
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
    const knowledge = repository.get(m.key);
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
    const codeLanguage = filename && !/\.(md|markdown)$/i.test(filename) ? filename.split(".").at(-1)?.toLowerCase() ?? "text" : null;
    return { key: m.key, title: m.title, path: m.path, codeLanguage, digest: m.digest, revisionId: m.revisionId, text: m.text, lineCount: m.lineCount, current: entry.current,
      images: m.images.map(i => ({ ...i, url: prefix + "/assets/" + i.assetId })), knowledge: knowledge ? meta(knowledge) : null, links, documentLinks };
  });
  app.get<{ Params: { id: string } }>(prefix + "/assets/:id", async (req, reply) => {
    const image = input.store.db.prepare("SELECT json_extract(p.value,'$.mimeType') mime FROM revisions r,json_each(r.body,'$.parts') p WHERE json_extract(p.value,'$.type')='image' AND json_extract(p.value,'$.assetId')=? LIMIT 1").get(req.params.id) as { mime: string } | undefined;
    const bytes = image && input.store.asset(req.params.id);
    if (!image || !["image/png", "image/jpeg", "image/webp"].includes(image.mime) || !bytes) return reply.code(404).send({ error: "图片不可用" });
    return reply.type(image.mime).send(bytes);
  });
  app.get(prefix + "/questions", async () => repository.questions());
  app.post<{ Params: { id: string }; Body: { answer: string } }>(prefix + "/questions/:id/answer", async (req, reply) => {
    if (typeof req.body?.answer !== "string" || !req.body.answer.trim() || req.body.answer.length > 20000) return reply.code(400).send({ error: "请提供 1–20000 字的回答" });
    const revisionId = repository.answer(req.params.id, req.body.answer.trim()); input.onAnswer?.();
    return { revisionId };
  });
  app.post<{ Params: { id: string } }>(prefix + "/questions/:id/task", async req => ({ taskId: repository.createTask(req.params.id) }));
  app.get<{ Querystring: { q?: string; topic?: string } }>(prefix + "/search", async (req, reply) => {
    const text = (req.query.q ?? "").trim().slice(0, 300), terms = tokenize(text);
    if (!terms.length) return [];
    repository.refresh();
    let topic: string[] = [];
    try { if (req.query.topic) { topic = JSON.parse(req.query.topic); if (!Array.isArray(topic) || topic.some(p => typeof p !== "string")) throw Error(); } }
    catch { return reply.code(400).send({ error: "分类路径无效" }); }
    const articles = repository.list().filter(a => a.current && topic.every((part, i) => a.document.topicPath?.[i] === part));
    const materials = new Map(repository.materials().map(m => [m.key, m]));
    const scopedFragments = new Set(articles.flatMap(a => a.dependencies.filter(d => d.kind === "material").flatMap(d => materials.get(d.key)?.fragments.map(f => f.id) ?? [])));
    const query = { text, limit: 60, ...(topic.length ? { visible: (id: string) => scopedFragments.has(id) } : {}) };
    const hits = await (retrieval.searchSourcesAsync?.(query) ?? retrieval.searchSources(query));
    const hitRanks = new Map(hits.map((hit, i) => [hit.fragmentId, 1 / (i + 1)]));
    const ranked = articles.flatMap(a => a.document.sections.flatMap(section => {
      const words = (a.document.title + " " + section.title + " " + section.body).toLowerCase();
      const lexical = terms.reduce((n, term) => n + (words.includes(term) ? 1 : 0), 0) / terms.length;
      let evidence = 0;
      for (const c of a.document.citations.filter(c => section.body.includes("[[" + c.key + "]]"))) {
        if (c.target.kind !== "material") continue;
        const material = materials.get(c.target.key);
        if (!material) continue;
        for (const fragment of fragmentPositions(material)) {
          if (fragment.endLine >= (c.target.startLine ?? 1) && fragment.startLine <= (c.target.endLine ?? material.lineCount)) evidence = Math.max(evidence, hitRanks.get(fragment.id) ?? 0);
        }
      }
      const score = lexical + evidence;
      return score ? [{ ...meta(a), section: section.key, sectionTitle: section.title, excerpt: section.body.slice(0, 600), derived: true, score }] : [];
    })).sort((a, b) => b.score - a.score);
    // One article per result, with its best matching section. Long articles do
    // not consume the whole result window simply by repeating related words.
    const best = new Map<string, typeof ranked[number]>();
    for (const hit of ranked) if (!best.has(hit.key)) best.set(hit.key, hit);
    return [...best.values()].slice(0, 50);
  });
  app.post<{ Body: { brief: unknown; revisionIds: string[] } }>(prefix + "/pages", async (req, reply) => {
    if (!input.profile) return reply.code(503).send({ error: "请先在能力与连接中配置 Agent" });
    if (running) return reply.code(409).send({ error: "知识整理正在进行" });
    const parsed = wikiPageBriefSchema.safeParse(req.body?.brief);
    const ids = req.body?.revisionIds;
    if (!parsed.success || !Array.isArray(ids) || !ids.length || ids.length > 500) return reply.code(400).send({ error: "请填写阅读目标并选择原始材料" });
    const selectedIds = new Set(ids), selected = repository.materials().filter(m => selectedIds.has(m.revisionId));
    if (selected.length !== selectedIds.size) return reply.code(400).send({ error: "所选材料已更新，请刷新后重试" });
    const brief = { ...parsed.data, materialKeys: selected.map(m => m.key) };
    running = new KnowledgePipeline(repository, new RoleRuntimeGateway(new RoleBundleRegistry(), input.workspace, new RuntimeRequestRepository(input.store.db)), { ...input.profile, id: "traex" }, { budget: input.budget, onPublish: input.onPublish });
    const pipeline = running;
    lastRun = { state: "running", title: brief.title, key: brief.key };
    void pipeline.writePage(brief).then(() => { lastRun = { state: "published", title: brief.title, key: brief.key }; })
      .catch(error => { lastRun = { state: "failed", title: brief.title, error: String(error) }; }).finally(() => { running = null; });
    return reply.code(202).send({ state: "running", key: brief.key });
  });
  app.post<{ Body: { revisionIds: string[] } }>(prefix + "/analyze", async (req, reply) => {
    if (!input.profile) return reply.code(503).send({ error: "未配置可用 Agent" });
    if (running) return reply.code(409).send({ error: "知识整理正在进行" });
    if (!Array.isArray(req.body?.revisionIds) || !req.body.revisionIds.length || req.body.revisionIds.length > 500) return reply.code(400).send({ error: "请选择要整理的固定材料版本" });
    const ids = new Set(req.body.revisionIds), selected = repository.materials().filter(m => ids.has(m.revisionId));
    if (selected.length !== ids.size) return reply.code(400).send({ error: "部分材料已更新或不可用，请刷新后重试" });
    running = new KnowledgePipeline(repository, new RoleRuntimeGateway(new RoleBundleRegistry(), input.workspace, new RuntimeRequestRepository(input.store.db)), { ...input.profile, id: "traex" }, { budget: input.budget, concurrency: 2, onPublish: input.onPublish });
    const pipeline = running;
    void pipeline.analyze(selected).then(result => { lastRun = result; }).catch(error => { lastRun = { error: String(error) }; }).finally(() => { running = null; });
    return reply.code(202).send({ state: "running", materials: selected.length });
  });
  app.addHook("preClose", async () => { await running?.stop(); });
  return repository;
}
