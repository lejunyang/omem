/**
 * The item's 需求 → 发现 → 方案 → 交付 (GET /api/items/:id/chain, src/items/chain.ts): what the
 * collapsed row says, and which entries light up together.
 */
export type ChainKind = "req" | "finding" | "design" | "work" | "object";
export type ChainEntry = { key: string; kind: ChainKind; title: string; status: string; cls: "" | "ok" | "warn" | "danger" | "accent"; now: string; href: string; links: string[]; waits?: string; reviewing?: boolean };
export type ChainGroup = { item: { id: string; title: string }; reqs: ChainEntry[]; findings: ChainEntry[]; designs: ChainEntry[]; works: ChainEntry[]; more: number };
export type ItemChain = {
  itemId: string; line: boolean; groups: ChainGroup[]; moreGroups: number;
  counts: { reqs: number; findings: number; designs: number; works: number; reviewing: number; waiting: number };
};

export const SEGMENTS = [
  { key: "reqs", label: "需求", unit: "条" },
  { key: "findings", label: "发现", unit: "个" },
  { key: "designs", label: "方案", unit: "份" },
  { key: "works", label: "交付", unit: "次" },
] as const;

/** “3 条需求 · 2 个发现 · 1 份方案 · 2 次交付，1 次在评审”; empty segments left out. */
export function chainSummary(c: ItemChain["counts"]): string {
  const parts = SEGMENTS.filter((s) => c[s.key]).map((s) => `${c[s.key]} ${s.unit}${s.label}`);
  const tail = [c.reviewing ? `${c.reviewing} 次在评审` : "", c.waiting ? `${c.waiting} 次等你` : ""].filter(Boolean).join("，");
  return parts.join(" · ") + (tail ? `，${tail}` : "");
}

export const chainEmpty = (c: ItemChain | null | undefined) => !c || !c.groups.length;

/**
 * The entries connected to `key` within one group, itself included: links go both ways and are
 * followed on (a requirement lights its design, the work that implements it, that work's finding).
 */
export function connected(group: Pick<ChainGroup, "reqs" | "findings" | "designs" | "works">, key: string): Set<string> {
  const edges = new Map<string, Set<string>>();
  const add = (a: string, b: string) => { if (!edges.has(a)) edges.set(a, new Set()); edges.get(a)!.add(b); };
  for (const e of [...group.reqs, ...group.findings, ...group.designs, ...group.works]) for (const l of e.links) { add(e.key, l); add(l, e.key); }
  const out = new Set([key]);
  const queue = [key];
  while (queue.length) for (const next of edges.get(queue.shift()!) ?? []) if (!out.has(next)) { out.add(next); queue.push(next); }
  return out;
}

/** An entry's page inside the app (`#/…` → a router path), or null for an outside address. */
export const chainRoute = (href: string) => (href.startsWith("#/") ? href.slice(1) : null);
