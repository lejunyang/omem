import { stableDigest } from "../storage/digest.js";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { KnowledgeArtifact, KnowledgeCitation } from "../../../../packages/contracts/src/knowledge.js";
import { knowledgeDocumentSchema } from "../../../../packages/contracts/src/knowledge.js";
import { digest, KnowledgeRepository, type KnowledgeArticle } from "./repository.js";

export function articleMarkdown(a: KnowledgeArticle, materialHref?: (target: KnowledgeCitation["target"]) => string | undefined) {
  const links = new Map(a.document.citations.map(c => [c.key, c]));
  const body = a.document.sections.map(section => {
    const text = section.body.replace(/\[\[([a-zA-Z][a-zA-Z0-9_-]*)\]\]/g, (_, id: string) => {
      const c = links.get(id); if (!c) return "（引用不可用）";
      const target = c.target.kind === "article" ? `${digest(c.target.key)}.md${c.target.section ? "#" + c.target.section : ""}` : materialHref?.(c.target) ?? "#source-evidence";
      return `[${c.label.replace(/[\[\]]/g, "")} ↗](${target} "${c.reason.replace(/["\n]/g, " ")}")`;
    });
    return `<a id="${section.key}"></a>\n## ${section.title}\n\n${text}`;
  }).join("\n\n");
  return `# ${a.document.title}\n\n${a.document.summary}\n\n来源：${a.generation.model} 分析，${a.review.model} 独立复核；模型解释仍可被原始证据纠正。\n\n${body}\n`;
}

export function writeKnowledgeArticle(directory: string, a: KnowledgeArticle, materialHref?: (target: KnowledgeCitation["target"]) => string | undefined) {
  mkdirSync(directory, { recursive: true });
  const { current, revision, ...artifact } = a;
  const name = digest(a.document.key);
  const outputs = [[`${name}.json`, JSON.stringify(artifact, null, 2) + "\n"], [`${name}.md`, articleMarkdown(a, materialHref)]] as const;
  for (const [file, text] of outputs) {
    const path = join(directory, file);
    if (!existsSync(path) || readFileSync(path, "utf8") !== text) writeFileSync(path, text);
  }
}

export function restoreKnowledgeArticles(repository: KnowledgeRepository, directory: string) {
  const result: { file: string; state: string; reason: string }[] = [];
  const pending: { file: string; artifact: KnowledgeArtifact }[] = [];
  for (const file of (existsSync(directory) ? readdirSync(directory) : []).filter(f => f.endsWith(".json")).sort()) {
    try { pending.push({ file, artifact: JSON.parse(readFileSync(join(directory, file), "utf8")) as KnowledgeArtifact }); }
    catch (error) { result.push({ file, state: "rejected", reason: String(error) }); }
  }
  // A temporarily unreadable asset is not a deletion. Keep prior ownership until
  // the directory is parseable, while still restoring its other valid pages.
  const imported = pending.map(({artifact})=>({key:artifact.document?.key,revision:digest(stableDigest(artifact))})).filter(a=>!!a.key);
  const parseable = !result.length;
  const sources = new Map(repository.materials().map(m => [m.key, m.digest]));
  for (let pass = 0; pending.length && pass < 100; pass++) {
    let progress = false;
    for (let i = pending.length - 1; i >= 0; i--) {
      const { file, artifact } = pending[i]!;
      if (artifact.dependencies?.some(d => d.kind === "article" && (
        !repository.get(d.key) ||
        // Existing heads may still be the previous generation. Restore the
        // matching child asset first instead of prematurely rejecting its parent.
        (repository.get(d.key)?.revision !== d.digest && pending.some(p =>
          p.artifact.document?.key === d.key && digest(stableDigest(p.artifact)) === d.digest))
      ))) continue;
      let state = "restored", reason = "";
      try {
        if (artifact.version !== 1 || artifact.review?.verdict !== "accepted" || !artifact.generation?.model || !artifact.review.model) throw Error("Missing generation/review provenance");
        knowledgeDocumentSchema.parse(artifact.document);
        if (artifact.dependencies.some(d => d.kind === "material" ? sources.get(d.key) !== d.digest : repository.get(d.key)?.revision !== d.digest)) {
          repository.restoreHistorical(artifact);
          state = Object.values(repository.statusReader()(artifact)).every(s=>s.state === "current") ? "restored" : "stale";
          reason = state === "stale" ? "部分引用的章节或函数已变化，保留旧文等待核对" : "引用所在上下文未变，保留原有解释";
        }
        else if (repository.get(artifact.document.key)?.revision !== digest(stableDigest(artifact))) repository.publish(artifact);
      } catch (error) { state = "rejected"; reason = String(error); }
      repository.store.db.prepare("INSERT INTO knowledge_imports VALUES(?,?,?,?) ON CONFLICT(asset) DO UPDATE SET state=excluded.state,reason=excluded.reason,checked_at=excluded.checked_at").run(file, state, reason, new Date().toISOString());
      result.push({ file, state, reason }); pending.splice(i, 1); progress = true;
    }
    if (!progress) break;
  }
  for (const { file } of pending) result.push({ file, state: "missing", reason: "引用的子知识尚不可用" });
  if (parseable) repository.reconcileImport(resolve(directory), imported);
  repository.refresh(); return result;
}
