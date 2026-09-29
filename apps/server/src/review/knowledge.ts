import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CaptureInput } from "../../../../packages/contracts/src/index.js";
import type { Store } from "../store.js";
import { restoreKnowledgeArticles, writeKnowledgeArticle } from "../knowledge/artifacts.js";
import { digest, type KnowledgeArticle } from "../knowledge/repository.js";
import { captureRepositoryMaterials, createReviewKnowledgeRepository } from "./materials.js";

export function restoreReviewKnowledge(store: Store, root: string) {
  const notes = join(root, ".repo-review/knowledge/user-notes.json");
  if (existsSync(notes)) for (const input of JSON.parse(readFileSync(notes, "utf8")) as CaptureInput[]) {
    if (input.source !== "manual" || !input.externalId?.startsWith("knowledge-answer:")) throw Error("Invalid review user note");
    store.capture(input);
  }
  const coverage = captureRepositoryMaterials(store, root);
  const repository = createReviewKnowledgeRepository(store);
  const restored = restoreKnowledgeArticles(repository, join(root, ".repo-review/knowledge/articles"));
  for (const m of repository.materials().filter(m => m.key.startsWith("manual:knowledge-answer:"))) {
    const id = m.key.slice("manual:knowledge-answer:".length);
    store.db.prepare("UPDATE knowledge_questions SET state='answered',answer_revision=? WHERE id=?").run(m.revisionId, id);
  }
  return { coverage, restored, repository };
}

export function saveReviewAnswerMaterials(store: Store, root: string) {
  const rows = store.db.prepare("SELECT s.external_id,r.title,r.body FROM sources s JOIN revisions r ON s.head=r.id WHERE s.namespace='manual' AND s.external_id LIKE 'knowledge-answer:%' ORDER BY s.external_id").all() as { external_id: string; title: string; body: string }[];
  const inputs = rows.map(r => { const body = JSON.parse(r.body); return { source: "manual", externalId: r.external_id, title: r.title, parts: body.parts, context: body.context, provenance: body.provenance }; });
  const path = join(root, ".repo-review/knowledge/user-notes.json"); mkdirSync(join(root, ".repo-review/knowledge"), { recursive: true });
  writeFileSync(path, JSON.stringify(inputs, null, 2) + "\n");
}

export function publishReviewArticle(root: string, article: KnowledgeArticle) {
  writeKnowledgeArticle(join(root, ".repo-review/runtime/knowledge-staging"), article);
  writeKnowledgeArticle(join(root, ".repo-review/knowledge/articles"), article);
}

export function writeReviewKnowledgeIndex(root: string, articles: KnowledgeArticle[]) {
  const pages = articles.filter(a => a.current), overview = pages.find(a => a.document.key === "topic:overview");
  const md = ["# omem · 可追溯知识", "", overview?.document.summary ?? "仓库材料经 AI 分析与独立复核，正文引用可递归进入相关知识、代码和原始文档。", "", ...pages.filter(a => a.document.key.startsWith("topic:")).map(a => `- [${a.document.title}](knowledge/articles/${digest(a.document.key)}.md)`), "", "## 模块与材料", "", ...pages.filter(a => !a.document.key.startsWith("topic:")).map(a => `- [${a.document.title}](knowledge/articles/${digest(a.document.key)}.md)`)].join("\n") + "\n";
  const path = join(root, ".repo-review/wiki.md");
  if (!existsSync(path) || readFileSync(path, "utf8") !== md) writeFileSync(path, md);
}
