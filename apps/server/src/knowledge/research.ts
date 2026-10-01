import type { KnowledgeMaterial, KnowledgeResearch, WikiPageBrief } from "../../../../packages/contracts/src/knowledge.js";
import { materialSections } from "./structure.js";
import { tokenize } from "../retrieval/keyword.js";

export type MaterialOffer = { material: KnowledgeMaterial; ranges: { start: number; end: number }[] };
export class MaterialResearch {
  readonly offers = new Map<string, MaterialOffer>();
  readonly activity: { request: unknown; result: unknown }[] = [];
  private readonly byKey: Map<string, KnowledgeMaterial>;
  constructor(readonly materials: KnowledgeMaterial[], readonly brief: WikiPageBrief, readonly maxChars = 160000) {
    this.byKey = new Map(materials.map(m => [m.key, m]));
    for (const path of brief.entryPaths) {
      const material = materials.find(m => m.path === path || m.key === path);
      if (material) this.read(material.key, 1, Math.min(material.lineCount, 100));
    }
  }

  catalog() {
    return this.materials.map(m => ({ key: m.key, title: m.title, path: m.path, lines: m.lineCount }));
  }

  private size() {
    return [...this.offers.values()].reduce((size, offer) => size + offer.ranges.reduce((n, range) => n + offer.material.text.split("\n").slice(range.start - 1, range.end).join("\n").length, 0), 0);
  }

  read(key: string, start: number, end: number) {
    const material = this.byKey.get(key) ?? this.materials.find(m => m.path === key);
    if (!material) return { error: "材料不存在，请使用目录中的 key" };
    if (start > material.lineCount || end < start) return { error: "行范围无效", totalLines: material.lineCount };
    const range = { start, end: Math.min(material.lineCount, end, start + 499) };
    const offer = this.offers.get(material.key) ?? { material, ranges: [] };
    const text = material.text.split("\n").slice(range.start - 1, range.end).join("\n");
    if (!offer.ranges.some(r => r.start <= range.start && r.end >= range.end)) {
      if (this.size() + text.length > this.maxChars) return { error: "本页背景预算已满，请根据已有材料聚焦页面问题" };
      const ranges = [...offer.ranges, range].sort((a, b) => a.start - b.start), merged: typeof ranges = [];
      for (const r of ranges) { const last = merged.at(-1); if (last && r.start <= last.end + 1) last.end = Math.max(last.end, r.end); else merged.push({ ...r }); }
      offer.ranges = merged; this.offers.set(material.key, offer);
    }
    return { key: material.key, title: material.title, range, totalLines: material.lineCount,
      outline: materialSections(material).slice(0, 35) };
  }

  search(query: string) {
    // Paths select a scope; their common directory tokens are not search terms.
    const scopes = (query.match(/(?:[\w.-]+\/)+[\w./-]+/g) ?? []).filter(path => this.materials.some(m => m.path === path || m.path?.startsWith(path.replace(/\/$/, "") + "/")));
    const paths = scopes.length ? this.materials.filter(m => scopes.some(path => m.path === path || m.path?.startsWith(path.replace(/\/$/, "") + "/"))) : [];
    const terms = tokenize(scopes.reduce((text, path) => text.replaceAll(path, " "), query));
    if (!terms.length && paths.length) return paths.slice(0, 5).map(m => this.read(m.key, 1, Math.min(m.lineCount, 80)));
    if (!terms.length) return [];
    const candidates = (paths.length ? paths : this.materials).map(material => {
      const lines = material.text.split("\n"), title = (material.path ?? material.title).toLowerCase();
      const matches = lines.flatMap((line, i) => {
        const score = terms.filter(t => line.toLowerCase().includes(t)).length;
        return score ? [{ line: i + 1, score }] : [];
      }).sort((a, b) => b.score - a.score);
      const score = terms.filter(t => title.includes(t)).length * 3 + (matches[0]?.score ?? 0);
      return { material, matches, score };
    }).filter(c => c.score > 0).sort((a, b) => b.score - a.score).slice(0, 5);
    return candidates.map(({ material, matches }) => ({ key: material.key, path: material.path, lines: material.lineCount,
      outline: materialSections(material).slice(0, 16),
      matches: matches.slice(0, 2).map(hit => {
        const result = this.read(material.key, Math.max(1, hit.line - 3), hit.line + 6);
        return "range" in result ? { range: result.range } : result;
      }) }));
  }

  execute(requests: KnowledgeResearch["requests"]) {
    return requests.map(request => {
      const result = request.kind === "read" ? this.read(request.materialKey, request.startLine, request.endLine) : this.search(request.query);
      const entry = { request, result }; this.activity.push(entry); return entry;
    });
  }
}
