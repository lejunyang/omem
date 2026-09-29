/** Derived prose can guide retrieval, but the returned candidates are always
 * original fixed fragments. Assistant visibility rules still run afterwards. */
import type { DatabaseSync } from "node:sqlite";
import type { KnowledgeArtifact } from "../../../../packages/contracts/src/knowledge.js";
import { stableDigest } from "../storage/digest.js";
type Row = Record<string, unknown>;

export function knowledgeEvidenceCandidates(db: DatabaseSync, terms: string[]): Row[] {
  if (!terms.length || !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='knowledge_heads'").get()) return [];
  const rows = db.prepare(`SELECT r.id,r.artifact FROM knowledge_heads h JOIN knowledge_revisions r ON r.id=h.revision_id
    WHERE h.current=1 AND (${terms.map(() => "r.artifact LIKE ? ESCAPE '!'").join(" OR ")}) LIMIT 30`).all(...terms.map(t => "%" + t.replace(/[!%_]/g, "!$&") + "%")) as Row[];
  const sourceCache = new Map<string, { row: Row; digest: string } | null>();
  const articleCache = new Map<string, { id: string; artifact: KnowledgeArtifact } | null>();
  function source(key: string) {
    if (sourceCache.has(key)) return sourceCache.get(key)!;
    const index = key.indexOf(":"), namespace = key.startsWith("omem:") ? "file" : key.slice(0, index), external = key.startsWith("omem:") ? key : key.slice(index + 1);
    const row = db.prepare("SELECT r.*,s.namespace FROM sources s JOIN revisions r ON s.head=r.id WHERE s.namespace=? AND (s.external_id=? OR (s.external_id IS NULL AND s.id=?)) LIMIT 1").get(namespace, external, external) as Row | undefined;
    if (!row) { sourceCache.set(key, null); return null; }
    const body = JSON.parse(String(row.body));
    if (!Array.isArray(body.parts) || body.context?.derived || body.provenance?.producerKind === "derived") { sourceCache.set(key, null); return null; }
    const parts = body.parts as { type: string; text?: string; url?: string; label?: string; assetId?: string; mimeType?: string }[];
    const text = parts.filter(p => p.type === "text" || p.type === "link").map(p => p.type === "text" ? p.text ?? "" : `${p.label ?? ""}\n${p.url}`).join(body.context?.captureFormat === "verbatim-v1" ? "" : "\n\n");
    const images = parts.filter(p => p.type === "image").map(p => ({ assetId: p.assetId, mimeType: p.mimeType, label: p.label ?? row.title }));
    const value = { row, digest: stableDigest({ text, images, actor: body.provenance?.actorId ?? null, quoted: body.provenance?.quoted ?? false, forwarded: body.provenance?.forwarded ?? false }) };
    sourceCache.set(key, value); return value;
  }
  function article(key: string) {
    if (articleCache.has(key)) return articleCache.get(key)!;
    const row = db.prepare("SELECT r.id,r.artifact FROM knowledge_heads h JOIN knowledge_revisions r ON r.id=h.revision_id WHERE h.document_key=? AND h.current=1").get(key) as Row | undefined;
    const value = row ? { id: String(row.id), artifact: JSON.parse(String(row.artifact)) as KnowledgeArtifact } : null;
    articleCache.set(key, value); return value;
  }
  const seen = new Set<string>(), output = new Map<string, Row>();
  function visit(a: KnowledgeArtifact, depth: number, keys?: Set<string>) {
    if (depth > 8 || seen.has(a.document.key) || output.size >= 30) return;
    seen.add(a.document.key);
    if (a.dependencies.some(d => d.kind === "material" ? source(d.key)?.digest !== d.digest : article(d.key)?.id !== d.digest)) return;
    for (const c of a.document.citations.filter(c => !keys || keys.has(c.key))) {
      if (c.target.kind === "article") { const child = article(c.target.key); if (child) visit(child.artifact, depth + 1); continue; }
      const s = source(c.target.key); if (!s || !c.quote.trim()) continue;
      const fragments = db.prepare("SELECT id,text FROM fragments WHERE revision_id=? ORDER BY ordinal").all(String(s.row.id)) as Row[];
      const fragment = fragments.find(f => String(f.text).includes(c.quote.trim()));
      if (!fragment) continue;
      const body = JSON.parse(String(s.row.body));
      output.set(String(fragment.id), { fragment_id: fragment.id, revision_id: s.row.id, fragment_text: fragment.text, title: s.row.title,
        revision_created_at: s.row.created_at, namespace: s.row.namespace, actor_id: body.provenance?.actorId ?? null });
    }
  }
  for (const row of rows) {
    try {
      const a = JSON.parse(String(row.artifact)) as KnowledgeArtifact;
      const titleHit = terms.some(t => (a.document.title + a.document.summary).toLowerCase().includes(t));
      const sections = a.document.sections.filter(s => titleHit || terms.some(t => (s.title + s.body).toLowerCase().includes(t)));
      if (sections.length) visit(a, 0, new Set(sections.flatMap(s => [...s.body.matchAll(/\[\[([\w-]+)\]\]/g)].map(m => m[1]!))));
    } catch { /* Invalid projections never interrupt original-evidence retrieval. */ }
  }
  return [...output.values()];
}
