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
import { digest, materialFromRevision } from "../knowledge/repository.js";
import { stableDigest } from "../storage/digest.js";
import type { RetrievalPort, SearchQuery } from "../retrieval/port.js";

/** Input adapter eligibility only. Content ranking is shared with all captures. */
export function developmentRetrieval(store: Store, retrieval: RetrievalPort): RetrievalPort {
  const policy = (query: SearchQuery): SearchQuery => {
    const rows = store.db.prepare(`SELECT f.id,s.external_id AS key,m.removed,m.legacy_alias_of
      FROM fragments f JOIN revisions r ON r.id=f.revision_id JOIN sources s ON s.head=r.id
      LEFT JOIN review_source_meta m ON m.source_id=s.id
      WHERE s.namespace='file' AND s.external_id LIKE 'omem:%'`).all() as { id:string; key:string; removed:number|null; legacy_alias_of:string|null }[];
    const imported = new Map(rows.map(row => [row.id, row]));
    return { ...query,
      visible: id => { const row = imported.get(id); return !row?.removed && !row?.legacy_alias_of && (query.visible?.(id) ?? true); },
    };
  };
  return {
    ...(retrieval.search ? { search: (q: SearchQuery) => retrieval.search!(policy(q)) } : {}),
    searchSources: q => retrieval.searchSources(policy(q)),
    ...(retrieval.searchSourcesAsync ? { searchSourcesAsync: (q: SearchQuery) => retrieval.searchSourcesAsync!(policy(q)) } : {}),
    searchMemories: q => retrieval.searchMemories(q),
    readEvidence: (revision, fragment) => retrieval.readEvidence(revision, fragment),
    health: () => retrieval.health(),
  };
}

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
          store.capture({ source: "file", externalId: key, title: revision.title, parts, context: revision.context, provenance: revision.provenance } as CaptureInput, { learning: false, notify: false });
          digests.delete(material.digest); if (!digests.size) break;
        }
      }
    } finally { prior.close(); }
  }
  // Capture live files last so importing history never moves the live head back.
  const restored = restoreReviewKnowledge(store, root, { learning: false, notify: false });
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
