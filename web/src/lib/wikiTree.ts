/** The Wiki folder tree as the navigation shows it (src/wiki/store.ts buildNav makes the nodes). */
export type NavNode = { slug?: string; title: string; folder?: string; count?: number; stale?: number; children: NavNode[] };
export type NavRow = { key: string; depth: number; node: NavNode; open: boolean; isFolder: boolean };

/** Folder paths above a page: `a/b/c` → `a`, `a/b`. */
export function ancestors(slug: string): string[] {
  const parts = slug.split("/");
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"));
}

/** Folders open the first time a space is seen: all top-level ones in a small wiki, otherwise only the way to the current page. */
export function defaultOpen(nodes: NavNode[], current: string, total: number): Set<string> {
  const out = new Set(ancestors(current));
  if (total <= 60) for (const n of nodes) if (n.folder) out.add(n.folder);
  return out;
}

/**
 * The visible rows, depth first. A folder shows its children when it is open; while filtering,
 * only what matches (and the folders on the way to it) is listed and every folder shows its matches.
 */
export function flattenNav(nodes: NavNode[], open: Set<string>, filter = ""): NavRow[] {
  const f = filter.trim().toLowerCase();
  const matches = (n: NavNode) => n.title.toLowerCase().includes(f) || (n.slug ?? "").toLowerCase().includes(f) || (n.folder ?? "").toLowerCase().includes(f);
  // Whether the node or anything below it matches; a folder that matches itself keeps all its pages.
  const keep = new Map<NavNode, boolean>();
  const mark = (n: NavNode): boolean => {
    const below = n.children.map(mark).some(Boolean);
    const k = !f || matches(n) || below;
    keep.set(n, k);
    return k;
  };
  nodes.forEach(mark);
  const rows: NavRow[] = [];
  const walk = (list: NavNode[], depth: number, parentMatches: boolean) => {
    for (const n of list) {
      if (!keep.get(n) && !parentMatches) continue;
      const isFolder = n.folder !== undefined;
      const self = !f || matches(n);
      const isOpen = isFolder && (f ? true : open.has(n.folder!));
      rows.push({ key: isFolder ? `d:${n.folder}` : `p:${n.slug}`, depth, node: n, open: isOpen, isFolder });
      if (isOpen) walk(n.children, depth + 1, !!f && self && isFolder);
    }
  };
  walk(nodes, 0, false);
  return rows;
}
