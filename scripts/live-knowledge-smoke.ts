/** Live Agent acceptance through the normal knowledge API. Authored sample
 * inputs live in an isolated Store; generated prose is never hand-seeded. */
import Fastify from "fastify";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Store } from "../apps/server/src/store.js";
import { registerKnowledgeRoutes } from "../apps/server/src/knowledge/api.js";
import { KnowledgeRepository } from "../apps/server/src/knowledge/repository.js";
import { loadReviewCodeModelConfig } from "../apps/server/src/review/model-config.js";
import { profileSchema } from "../packages/contracts/src/index.js";
import { writeKnowledgeArticle } from "../apps/server/src/knowledge/artifacts.js";

const directory = resolve(".repo-review/runtime/general-knowledge");
mkdirSync(directory, { recursive: true });
const config = loadReviewCodeModelConfig();
if (config.transport !== "acp" || !config.command || config.model !== "gpt-5.6-sol") throw Error("Live acceptance requires configured traex ACP / gpt-5.6-sol");
const profile = profileSchema.parse({ id: "traex", name: "Live knowledge acceptance", transport: "acp", command: config.command, args: config.args ?? [], model: config.model, effort: config.effort, timeoutMs: config.timeoutMs });
const samples = [
  { key: "acceptance:english", title: "区分两种 used to 表达", reader: "英语学习者", goal: "通过例句理解 used to do 与 be used to doing 的区别，并按照笔记完成一次练习。",
    text: "# 英语学习笔记（人工编写的流程验收材料）\n\n## 两种表达\nused to + 动词原形，描述过去的习惯或状态。例句：I used to walk to school. 意思是我过去常步行上学。\nbe used to + 名词或动名词，表示习惯于某件事。例句：I am used to walking to school. 意思是我习惯步行上学。\n\n## 本次练习\n先用自己的话说明两个例句的区别，再分别造一句。下一次复习先遮住解释，仅看英文判断是哪一种表达；记下混淆的地方。这里只记录本次学习安排，没有接入自动卡片或学习提醒。" },
  { key: "acceptance:photography", title: "拍摄移动玩具的快门练习", reader: "刚开始练习摄影的人", goal: "根据练习记录安排一次拍摄，理解对照、观察和记录步骤，避免把一次观察推广到所有相机。",
    text: "# 摄影练习记录（人工编写的流程验收材料）\n\n## 练习设置\n在同一处光线稳定的桌面，让玩具小车沿标记路线移动。相机位置固定，分别用 1/30 秒和 1/250 秒快门拍摄；其他设置、移动路线和速度尽量一致，把每次参数写下来。\n\n## 已有观察\n本次记录中，1/30 秒的移动轮廓有拖影，1/250 秒的轮廓更清晰。两张照片亮度不同，尚未记录其他曝光参数，不能把亮度差异全部归因于快门。\n\n## 下次复习\n复习时对照参数和照片，先区分运动模糊与亮度，再补记光圈、ISO 和光线条件。本记录没有远程控制相机，也没有替读者规定适用于所有场景的快门值。" },
];
let store = new Store(join(directory, "data")), app = Fastify();
const report: Record<string, unknown> = { startedAt: new Date().toISOString(), model: profile.model, inputs: "人工编写的跨领域验收材料，非用户真实笔记", pages: [] };
try {
  const repository = registerKnowledgeRoutes(app, { store, prefix: "/api/knowledge", workspace: join(directory, "agents"), profile, budget: config });
  const sources = samples.map(sample => store.capture({ source: "manual", externalId: sample.key, title: sample.title, parts: [{ type: "text", text: sample.text }], context: { application: "knowledge-live-acceptance" } }));
  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i]!, revision = sources[i]!.revision;
    console.log("GENERATE", sample.key);
    const response = await app.inject({ method: "POST", url: "/api/knowledge/pages", payload: { revisionIds: [revision.id], brief: {
      key: sample.key, title: sample.title, kind: "explanation", order: 0, reader: sample.reader, goal: sample.goal, scenario: sample.goal, questions: [sample.goal], entryPaths: [],
    } } });
    if (response.statusCode !== 202) throw Error(response.body);
    const deadline = Date.now() + 20 * 60 * 1000;
    while (true) {
      const status = (await app.inject("/api/knowledge/articles")).json();
      if (!status.running) { if (status.lastRun?.state !== "published") throw Error(JSON.stringify(status.lastRun)); break; }
      if (Date.now() > deadline) throw Error("Live knowledge generation timed out");
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    const article = repository.get(sample.key)!;
    if (!article.current || article.review.verdict !== "accepted" || !article.document.topicPath?.length) throw Error("Article was not published with a topic path");
    const material = repository.materials().find(m => m.revisionId === revision.id)!;
    if (article.dependencies.some(d => d.kind !== "material" || d.key !== material.key)) throw Error("Generation crossed the selected material scope");
    const detail = (await app.inject("/api/knowledge/articles/" + encodeURIComponent(sample.key))).json();
    if (detail.citations.some((c: { actionable: boolean }) => !c.actionable)) throw Error("Unresolved source citation");
    writeKnowledgeArticle(join(directory, "articles"), article);
    (report.pages as unknown[]).push({ key: sample.key, title: article.document.title, topicPath: article.document.topicPath, generation: article.generation, review: article.review, citations: detail.citations.length });
    console.log("PUBLISHED", sample.key, article.document.topicPath);
  }
  await app.close(); store.close();
  store = new Store(join(directory, "data")); app = Fastify();
  const restored = new KnowledgeRepository(store);
  registerKnowledgeRoutes(app, { store, prefix: "/api/knowledge", workspace: join(directory, "agents"), repository: restored });
  const pages = restored.list();
  if (pages.length !== 2 || pages.some(p => !p.current)) throw Error("Published pages did not survive restart");
  if (JSON.stringify(pages[0]!.document.topicPath) === JSON.stringify(pages[1]!.document.topicPath)) throw Error("Unrelated topics collapsed into one classification");
  for (const page of pages) {
    const response = await app.inject("/api/knowledge/search?" + new URLSearchParams({ q: "复习", topic: JSON.stringify(page.document.topicPath) }));
    if (response.json().length !== 1 || response.json()[0].key !== page.document.key) throw Error("Topic search did not isolate its article");
  }
  report.passed = true; report.completedAt = new Date().toISOString();
  console.log("PASS real ACP generation, independent review, two domains, citations, restart and scoped search");
} catch (error) { report.passed = false; report.error = String(error); process.exitCode = 1; console.error(error); }
finally { await app.close(); store.close(); writeFileSync(join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n"); }
