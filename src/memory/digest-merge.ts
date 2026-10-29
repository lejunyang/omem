import type { App } from "../core/app.ts";
import { all, one } from "../core/db.ts";
import { json, truncate } from "../core/util.ts";
import { SAME_TOPIC } from "./passive.ts";

/**
 * The bulk digest (src/agents/digest.ts) wrote an experience memory for nearly every original it
 * read; most restate that one original and belong on its knowledge page instead. The dreamer works
 * through them a few groups a night: memories from the same original, close in meaning (vectors),
 * are merged into one reusable conclusion or retracted. The host only finds the groups.
 */
export type DigestGroup = { sourceId: string; title: string; memories: { id: string; content: string; spaceId: string }[] };

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
  );
  // By the first original each one cites (and space and profile: merging never crosses them).
  const bySource = new Map<string, typeof rows>();
  for (const r of rows) {
    const ref = json<string[]>(r.source_refs, []).map((x) => /^src:([A-Za-z0-9_-]+)/.exec(x)?.[1]).find(Boolean);
    if (!ref) continue;
    const key = `${ref}|${r.space_id}|${r.agent ?? ""}`;
    bySource.set(key, [...(bySource.get(key) ?? []), r]);
  }
  const vec = (r: (typeof rows)[number]) => (r.embedding ? new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4) : null);
  const clusters: { sourceId: string; rows: typeof rows }[] = [];
  for (const [key, list] of bySource) {
    if (list.length < 2) continue;
    const sourceId = key.split("|")[0];
    const vs = list.map(vec);
    // Without vectors (no embedding model) the same original is the only signal.
    if (vs.some((v) => !v)) {
      clusters.push({ sourceId, rows: list });
      continue;
    }
    // Single-linkage: memories joined by a pair above the threshold.
    const parent = list.map((_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) {
        const a = vs[i]!, b = vs[j]!;
        if (a.length !== b.length) continue;
        let s = 0;
        for (let k = 0; k < a.length; k++) s += a[k] * b[k];
        if (s >= threshold) parent[find(i)] = find(j);
      }
    const parts = new Map<number, typeof rows>();
    list.forEach((r, i) => parts.set(find(i), [...(parts.get(find(i)) ?? []), r]));
    for (const p of parts.values()) if (p.length >= 2) clusters.push({ sourceId, rows: p });
  }
  return clusters
    .sort((a, b) => b.rows.length - a.rows.length)
    .slice(0, groups)
    .map((c) => ({
      sourceId: c.sourceId,
      title: one<{ title: string }>(app.db, "select title from sources where id = ?", c.sourceId)?.title ?? c.sourceId,
      memories: c.rows.slice(0, perGroup).map((r) => ({ id: r.id, content: truncate(r.content, 200), spaceId: r.space_id })),
    }));
}

/** The dreamer's task section; empty when there is nothing to merge. */
export function digestMergeText(app: App) {
  const groups = digestMergeGroups(app);
  if (!groups.length) return "";
  const total = digestExperienceCount(app);
  return [
    `存量整理（digest）写的经验记忆还有 ${total} 条有效，多数只是复述一个原件，应该进它的知识页。本轮先处理下面 ${groups.length} 组（同一原件、意思相近；宿主只负责找），排在第 1 步“重复记忆”之前：`,
    ...groups.map((g) => `- 原件 src:${g.sourceId}「${g.title}」：\n${g.memories.map((m) => `  - ${m.id}「${m.content}」`).join("\n")}`),
    "每组的做法：有跨原件、以后能复用的结论 → 用 remember 写一条更概括的（来源保留原件），再 supersede 或 forget 其余（原因写“合并进 m_xxx”）；只是复述原件、原件已有知识页的 → forget（原因写“已在知识页”）；原件还没有知识页又确实重要 → 先补进页面再撤回。不确定就不动。剩下的留给以后几晚，不要一次清完。",
  ].join("\n");
}
