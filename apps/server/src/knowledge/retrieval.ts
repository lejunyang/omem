/** Derived prose can guide retrieval, but the returned candidates are always
 * original fixed fragments. Assistant visibility rules still run afterwards. */
import type { DatabaseSync } from "node:sqlite";
import type { KnowledgeArtifact } from "../../../../packages/contracts/src/knowledge.js";
import { stableDigest } from "../storage/digest.js";
import { sourceForMaterialKey } from "./material-identity.js";
import { relevance } from "../retrieval/relevance.js";
import { marked, type Token, type Tokens } from "marked";
type Row = Record<string, unknown>;

/** Search the prose a reader sees, at the same granularity as its references.
 * A chapter hit must not promote every source mentioned elsewhere in it. */
function passages(body: string): string[] {
  const extract = (tokens: Token[]): string[] => tokens.flatMap(token => {
    if (token.type === "paragraph" || token.type === "text") return [token.raw];
    if (token.type === "list") return (token as Tokens.List).items.flatMap(item => extract(item.tokens));
    if (token.type === "blockquote") return extract((token as Tokens.Blockquote).tokens);
    if (token.type === "table") return (token as Tokens.Table).rows.map(row => row.map(cell => cell.text).join(" "));
    return []; // code, Mermaid, headings and metadata are not explanatory prose
  });
  return extract(marked.lexer(body));
}

export function knowledgeEvidenceCandidates(db: DatabaseSync, terms: string[]): Row[] {
  if (!terms.length || !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='knowledge_heads'").get()) return [];
  // Search readable sections, never JSON metadata, quoted code or trace.
  const rows = db.prepare(`SELECT r.id,r.artifact FROM knowledge_heads h JOIN knowledge_revisions r ON r.id=h.revision_id WHERE h.current=1`).all() as Row[];
  const sourceCache = new Map<string, { row: Row; digest: string; text: string } | null>();
  const articleCache = new Map<string, { id: string; artifact: KnowledgeArtifact } | null>();
  function source(key: string) {
    if (sourceCache.has(key)) return sourceCache.get(key)!;
    const sourceId = sourceForMaterialKey(db, key);
    const row = sourceId ? db.prepare("SELECT r.*,s.namespace FROM sources s JOIN revisions r ON s.head=r.id WHERE s.id=?").get(sourceId) as Row | undefined : undefined;
    if (!row) { sourceCache.set(key, null); return null; }
    const body = JSON.parse(String(row.body));
    if (!Array.isArray(body.parts) || body.context?.derived || body.provenance?.producerKind === "derived") { sourceCache.set(key, null); return null; }
    const parts = body.parts as { type: string; text?: string; url?: string; label?: string; assetId?: string; mimeType?: string }[];
    const text = parts.filter(p => p.type === "text" || p.type === "link").map(p => p.type === "text" ? p.text ?? "" : `${p.label ?? ""}\n${p.url}`).join(body.context?.captureFormat === "verbatim-v1" ? "" : "\n\n");
    const images = parts.filter(p => p.type === "image").map(p => ({ assetId: p.assetId, mimeType: p.mimeType, label: p.label ?? row.title }));
    const value = { row, text, digest: stableDigest({ text, images, actor: body.provenance?.actorId ?? null, quoted: body.provenance?.quoted ?? false, forwarded: body.provenance?.forwarded ?? false }) };
    sourceCache.set(key, value); return value;
  }
  function article(key: string) {
    if (articleCache.has(key)) return articleCache.get(key)!;
    const row = db.prepare("SELECT r.id,r.artifact FROM knowledge_heads h JOIN knowledge_revisions r ON r.id=h.revision_id WHERE h.document_key=? AND h.current=1").get(key) as Row | undefined;
    const value = row ? { id: String(row.id), artifact: JSON.parse(String(row.artifact)) as KnowledgeArtifact } : null;
    articleCache.set(key, value); return value;
  }
  const seen = new Map<string, number>(), output = new Map<string, Row>();
  function visit(a: KnowledgeArtifact, depth: number, keys?: Set<string>, score = 0) {
    if (depth > 8 || output.size >= 100) return;
    if (a.dependencies.some(d => d.kind === "material" ? source(d.key)?.digest !== d.digest : article(d.key)?.id !== d.digest)) return;
    for (const c of a.document.citations.filter(c => !keys || keys.has(c.key))) {
      const visitKey = `${a.document.key}:${c.key}`;
      if ((seen.get(visitKey) ?? -1) >= score) continue;
      seen.set(visitKey, score);
      if (c.target.kind === "article") {
        const child = article(c.target.key);
        if (child) {
          const section = c.target.section;
          const sections = child.artifact.document.sections.filter(s => !section || s.key === section);
          const blocks = sections.flatMap(s => passages(s.body).map(body => ({ body, score: relevance(body, terms, s.title) })));
          const matched = blocks.filter(b => b.score);
          // An explicit child-section reference may provide background even
          // when it uses different vocabulary. Retain that section, not siblings.
          for (const block of matched.length ? matched : section ? blocks : [])
            visit(child.artifact, depth + 1, new Set([...block.body.matchAll(/\[\[([\w-]+)\]\]/g)].map(m => m[1]!)), Math.min(score, block.score || score));
        }
        continue;
      }
      const s = source(c.target.key); if (!s || !c.quote.trim()) continue;
      const fragments = db.prepare("SELECT id,text FROM fragments WHERE revision_id=? ORDER BY ordinal").all(String(s.row.id)) as Row[];
      const lines = s.text.split("\n");
      const startLine = c.target.startLine, endLine = c.target.endLine;
      if (!startLine || !endLine || endLine > lines.length) continue;
      const excerpt = lines.slice(startLine - 1, endLine).join("\n");
      if (!excerpt.includes(c.quote)) continue;
      const start = lines.slice(0, startLine - 1).reduce((n, l) => n + l.length + 1, 0);
      const end = start + excerpt.length;
      const body = JSON.parse(String(s.row.body));
      let cursor = 0;
      for (const fragment of fragments) {
        const text = String(fragment.text), offset = s.text.indexOf(text, cursor);
        if (offset < 0) continue; // image placeholders are not text coordinates
        cursor = offset + text.length;
        if (offset >= end || cursor <= start) continue;
        output.set(String(fragment.id), { fragment_id: fragment.id, revision_id: s.row.id, fragment_text: fragment.text, title: s.row.title, guide_score: Math.max(score, Number(output.get(String(fragment.id))?.guide_score ?? 0)),
          revision_created_at: s.row.created_at, namespace: s.row.namespace, actor_id: body.provenance?.actorId ?? null });
      }
    }
  }
  for (const row of rows) {
    try {
      const a = JSON.parse(String(row.artifact)) as KnowledgeArtifact;
      const matches = a.document.sections.flatMap(section => passages(section.body).map(body => ({body, score: relevance(body, terms, section.title)}))).sort((a,b) => b.score-a.score);
      // Literal article names open the first explanatory section, rather than
      // turning every citation in the article into a search hit.
      if (!matches.some(s => s.score) && terms.length <= 2 && terms.every(t => a.document.title.toLowerCase().includes(t)) && matches[0]) matches[0].score = .4;
      for (const {body, score} of matches) {
        if (score) visit(a, 0, new Set([...body.matchAll(/\[\[([\w-]+)\]\]/g)].map(m => m[1]!)), score);
      }
    } catch { /* Invalid projections never interrupt original-evidence retrieval. */ }
  }
  return [...output.values()];
}
