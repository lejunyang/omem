/** Explicit development input: repository materials join the personal store.
 * Retain referenced historical evidence; never replace the personal database. */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { CaptureInput } from "../../../../packages/contracts/src/index.js";
import type { KnowledgeArtifact } from "../../../../packages/contracts/src/knowledge.js";
import { Store } from "../store.js";
import { restoreReviewKnowledge } from "../review/knowledge.js";
import { createReviewKnowledgeRepository } from "../review/materials.js";
import { reviewDataDir } from "../review/store.js";
import { digest, materialFromRevision } from "./repository.js";
import { stableDigest } from "../storage/digest.js";

export function importDevelopmentKnowledge(store: Store, root: string) {
  const repository = createReviewKnowledgeRepository(store);
  const directory = join(root, ".repo-review/knowledge/articles");
  const artifacts: KnowledgeArtifact[] = existsSync(directory) ? readdirSync(directory).filter(f => f.endsWith(".json")).map(f => JSON.parse(readFileSync(join(directory, f), "utf8"))) : [];
  const historical = new Map(artifacts.map(a => [digest(stableDigest(a)), a]));
  const reviewDirectory = reviewDataDir(root);
  if (store.dataDir !== reviewDirectory && existsSync(join(reviewDirectory, "omem.sqlite"))) {
    const prior = new Store(reviewDirectory);
    try {
      // Follow article revisions, not only heads: a parent may still cite an
      // older child even though that child's newer version is already current.
      for (const artifact of historical.values()) for (const d of artifact.dependencies) {
        if (d.kind !== "article" || historical.has(d.digest)) continue;
        const row = prior.db.prepare("SELECT artifact FROM knowledge_revisions WHERE id=?").get(d.digest) as {artifact: string} | undefined;
        if (row) historical.set(d.digest, JSON.parse(row.artifact));
      }
      const required = new Map<string, Set<string>>();
      for (const artifact of historical.values()) for (const d of artifact.dependencies) {
        if (d.kind !== "material" || !d.key.startsWith("omem:") || repository.resolveMaterial(d.key, d.digest)) continue;
        const digests = required.get(d.key) ?? new Set<string>(); digests.add(d.digest); required.set(d.key, digests);
      }
      for (const [key, digests] of required) {
        for (const row of prior.db.prepare("SELECT r.id FROM revisions r JOIN sources s ON s.id=r.source_id WHERE s.namespace='file' AND s.external_id=? ORDER BY r.created_at DESC").all(key)) {
          const material = materialFromRevision(prior, String(row.id));
          if (!material || !digests.has(material.digest)) continue;
          const revision = prior.revision(material.revisionId)!;
          const parts = revision.parts.map(p => p.type === "image" ? { type: "image", mimeType: p.mimeType, label: p.label, data: prior.asset(p.assetId)?.toString("base64") } : p);
          store.capture({ source: "file", externalId: material.key, title: revision.title, parts, context: revision.context, provenance: revision.provenance } as CaptureInput);
          digests.delete(material.digest); if (!digests.size) break;
        }
      }
    } finally { prior.close(); }
  }
  // Capture live files last so importing history never moves the live head back.
  const restored = restoreReviewKnowledge(store, root);
  const historyFailures: { title: string; reason: string }[] = [];
  // History can still be read when an old source is no longer available.
  // Its unresolved citations are disabled by the API; refresh marks it stale.
  for (const artifact of historical.values()) {
    try { repository.restoreHistorical(artifact, false); }
    catch (error) { historyFailures.push({ title: artifact.document.title, reason: String(error) }); }
  }
  for (const artifact of artifacts) {
    try { repository.restoreHistorical(artifact); } catch { /* Keep unavailable versions out of the readable directory. */ }
  }
  repository.refresh();
  if (historyFailures.length) console.warn("Knowledge history unavailable:", historyFailures);
  return { ...restored, repository, historyFailures };
}
