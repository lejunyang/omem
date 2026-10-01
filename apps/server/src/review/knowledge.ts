import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { captureSchema, type CaptureInput } from "../../../../packages/contracts/src/index.js";
import type { Store } from "../store.js";
import { restoreKnowledgeArticles, writeKnowledgeArticle } from "../knowledge/artifacts.js";
import { digest, type KnowledgeArticle } from "../knowledge/repository.js";
import { captureRepositoryMaterials, createReviewKnowledgeRepository } from "./materials.js";

export function restoreReviewKnowledge(store: Store, root: string) {
  const notes = join(root, ".repo-review/knowledge/user-notes.json");
  if (existsSync(notes)) for (const input of JSON.parse(readFileSync(notes, "utf8")) as CaptureInput[]) {
    if (input.source !== "manual" || !input.externalId?.startsWith("knowledge-answer:")) throw Error("Invalid review user note");
    store.capture(captureSchema.parse(input));
  }
  const coverage = captureRepositoryMaterials(store, root);
  const repository = createReviewKnowledgeRepository(store);
  const restored = restoreKnowledgeArticles(repository, join(root, ".repo-review/knowledge/articles"));
  for (const m of repository.materials().filter(m => m.key.startsWith("manual:knowledge-answer:"))) {
    const id = m.key.slice("manual:knowledge-answer:".length);
    store.db.prepare("UPDATE knowledge_questions SET state='answered',answer_revision=? WHERE id=?").run(m.revisionId, id);
    const q = store.db.prepare("SELECT document_key FROM knowledge_questions WHERE id=?").get(id) as { document_key: string } | undefined;
    if (q && !repository.get(q.document_key)?.dependencies.some(d => d.kind === "material" && d.key === m.key && d.digest === m.digest)) store.db.prepare("INSERT OR REPLACE INTO knowledge_invalidations VALUES(?,?)").run(q.document_key, "保存的用户补充尚未用于知识重核对");
  }
  repository.refresh();
  return { coverage, restored, repository };
}

export function saveReviewAnswerMaterials(store: Store, root: string) {
  const rows = store.db.prepare("SELECT s.external_id,r.title,r.body FROM sources s JOIN revisions r ON s.head=r.id WHERE s.namespace='manual' AND s.external_id LIKE 'knowledge-answer:%' ORDER BY s.external_id").all() as { external_id: string; title: string; body: string }[];
  const inputs = rows.map(r => { const body = JSON.parse(r.body); return { source: "manual", externalId: r.external_id, title: r.title, parts: body.parts, context: body.context, provenance: body.provenance }; });
  const path = join(root, ".repo-review/knowledge/user-notes.json"); mkdirSync(join(root, ".repo-review/knowledge"), { recursive: true });
  writeFileSync(path, JSON.stringify(inputs, null, 2) + "\n");
}

export const reviewMaterialHref = (target: import("../../../../packages/contracts/src/knowledge.js").KnowledgeCitation["target"]) => target.key.startsWith("omem:") ? `../../../${target.key.slice(5)}${target.startLine ? "#L" + target.startLine : ""}` : undefined;

export function publishReviewArticle(root: string, article: KnowledgeArticle) {
  writeKnowledgeArticle(join(root, ".repo-review/runtime/knowledge-staging"), article, reviewMaterialHref);
  writeKnowledgeArticle(join(root, ".repo-review/knowledge/articles"), article, reviewMaterialHref);
}

export function writeReviewKnowledgeIndex(root: string, articles: KnowledgeArticle[]) {
  const pages = articles.filter(a => a.current).sort((a, b) => (a.reading?.order ?? Infinity) - (b.reading?.order ?? Infinity) || a.document.title.localeCompare(b.document.title));
  const groups = new Map<string, KnowledgeArticle[]>();
  for (const article of pages) {
    const label = article.document.topicPath?.join(" / ") || "未分类";
    groups.set(label, [...(groups.get(label) ?? []), article]);
  }
  const md = ["# 知识目录", "", ...[...groups].flatMap(([label, members]) => ["## " + label, "", ...members.map(a => `- [${a.document.title}](knowledge/articles/${digest(a.document.key)}.md)`), ""])].join("\n");
  const path = join(root, ".repo-review/wiki.md");
  if (!existsSync(path) || readFileSync(path, "utf8") !== md) writeFileSync(path, md);
}
