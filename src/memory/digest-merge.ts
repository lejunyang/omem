import type { App } from "../core/app.ts";
import { all, one } from "../core/db.ts";
import { json, truncate } from "../core/util.ts";
import { SAME_TOPIC } from "./passive.ts";

/**
 * The bulk digest (src/agents/digest.ts) wrote an experience memory for nearly every original it
 * read; most restate that one original and belong on its knowledge page instead. The dreamer works
 * through them a few groups a night: memories close in meaning (vectors; same space and profile),
 * often from different originals, are merged into one reusable conclusion or retracted. Without
 * vectors the same original is the only signal. The host only finds the groups.
 */
export type DigestGroup = { memories: { id: string; content: string; spaceId: string; sourceId: string | null }[]; sources: { id: string; title: string }[] };

export function digestExperienceCount(app: App) {
  return one<{ n: number }>(app.db, "select count(*) n from memories m join runs r on r.id = m.run_id where m.status = 'active' and m.kind = 'experience' and r.kind = 'digest'")!.n;
}

export function digestMergeGroups(app: App, opts: { groups?: number; perGroup?: number; threshold?: number } = {}): DigestGroup[] {
  const groups = opts.groups ?? 4;
  const perGroup = opts.perGroup ?? 8;
  const threshold = opts.threshold ?? SAME_TOPIC;
  const rows = all<{ id: string; space_id: string; content: string; source_refs: string; embedding: Uint8Array | null; agent: string | null }>(
    app.db,
    `select m.id, m.space_id, m.content, m.source_refs, m.embedding, m.agent from memories m join runs r on r.id = m.run_id
      where m.status = 'active' and m.kind = 'experience' and r.kind = 'digest' order by m.created_at`,
  ).map((r) => ({ ...r, source: json<string[]>(r.source_refs, []).map((x) => /^src:([A-Za-z0-9_-]+)/.exec(x)?.[1]).find(Boolean) ?? null }));
  const vec = (r: (typeof rows)[number]) => (r.embedding ? new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4) : null);
  const clusters: (typeof rows)[] = [];
  // Merging never crosses spaces or profiles.
  const byOwner = new Map<string, typeof rows>();
  for (const r of rows) byOwner.set(`${r.space_id}|${r.agent ?? ""}`, [...(byOwner.get(`${r.space_id}|${r.agent ?? ""}`) ?? []), r]);
  for (const list of byOwner.values()) {
    const plain = list.filter((r) => !vec(r));
    // Without vectors (no embedding model): the same original.
    const bySource = new Map<string, typeof rows>();
    for (const r of plain) if (r.source) bySource.set(r.source, [...(bySource.get(r.source) ?? []), r]);
    for (const g of bySource.values()) if (g.length >= 2) clusters.push(g);
    // With vectors: around each memory not yet taken, the others close to it. Every member is close to
    // the first, so a group cannot drift across a chain of near neighbours.
    const vs = list.filter((r) => vec(r)).map((r) => ({ r, v: vec(r)! }));
    const taken = new Set<string>();
    for (const seed of vs) {
      if (taken.has(seed.r.id)) continue;
      const group = [seed.r];
      for (const o of vs) {
        if (o === seed || taken.has(o.r.id) || o.v.length !== seed.v.length) continue;
        let s = 0;
        for (let k = 0; k < o.v.length; k++) s += o.v[k] * seed.v[k];
        if (s >= threshold) group.push(o.r);
      }
      if (group.length < 2) continue;
      for (const g of group) taken.add(g.id);
      clusters.push(group);
    }
  }
  const title = (id: string) => one<{ title: string }>(app.db, "select title from sources where id = ?", id)?.title ?? id;
  return clusters
    .sort((a, b) => b.length - a.length)
    .slice(0, groups)
    .map((c) => {
      const members = c.slice(0, perGroup);
      const sources = [...new Set(members.map((m) => m.source).filter((x): x is string => !!x))];
      return {
        memories: members.map((r) => ({ id: r.id, content: truncate(r.content, 200), spaceId: r.space_id, sourceId: r.source })),
        sources: sources.map((id) => ({ id, title: title(id) })),
      };
    });
}

/** The dreamer's task section; empty when there is nothing to merge. */
export function digestMergeText(app: App) {
  const groups = digestMergeGroups(app);
  if (!groups.length) return "";
  const total = digestExperienceCount(app);
  return [
    `存量整理（digest）写的经验记忆还有 ${total} 条有效，多数只是复述一个原件，应该进它的知识页。本轮先处理下面 ${groups.length} 组（意思相近，可能来自不同原件；宿主只负责找），排在第 1 步“重复记忆”之前：`,
    ...groups.map((g, i) => `- 第 ${i + 1} 组（原件：${g.sources.map((s) => `src:${s.id}「${s.title}」`).join("、") || "未注明"}）：\n${g.memories.map((m) => `  - ${m.id}「${m.content}」${m.sourceId ? `（src:${m.sourceId}）` : ""}`).join("\n")}`),
    "每组的做法：有跨原件、以后能复用的结论 → 用 remember 写一条更概括的（来源保留这些原件），再 supersede 或 forget 其余（原因写“合并进 m_xxx”）；说的其实是不同的事就不动；只是复述原件、原件已有知识页的 → forget（原因写“已在知识页”）；原件还没有知识页又确实重要 → 先补进页面再撤回。不确定就不动。剩下的留给以后几晚，不要一次清完。",
  ].join("\n");
}
