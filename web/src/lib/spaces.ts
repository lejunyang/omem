import type { Space } from "../api";
import { kindLabel } from "../store";

/**
 * Spaces in the order people pick them: each business space followed by its repositories (docs/v2/
 * coding-work.md 第 4 节), then the repositories that belong to no business.
 */
export function nestedSpaces<T extends Pick<Space, "id" | "kind" | "parentId">>(spaces: T[]): { space: T; child: boolean }[] {
  const ids = new Set(spaces.map((s) => s.id));
  const isChild = (s: T) => !!s.parentId && ids.has(s.parentId);
  const top = spaces.filter((s) => !isChild(s));
  const standalone = (s: T) => s.kind === "repo";
  const out: { space: T; child: boolean }[] = [];
  for (const s of [...top.filter((s) => !standalone(s)), ...top.filter(standalone)]) {
    out.push({ space: s, child: false });
    for (const c of spaces.filter((c) => c.parentId === s.id)) out.push({ space: c, child: true });
  }
  return out;
}

/** The space picker's options: a business space says how many repositories it has, each repository sits under it. */
export function spaceOptions(spaces: Space[]) {
  return nestedSpaces(spaces).map(({ space: s, child }) => {
    const repos = spaces.filter((c) => c.parentId === s.id).length;
    return {
      value: s.id,
      label: s.name,
      hint: child ? "仓库" : repos ? `${kindLabel[s.kind] ?? s.kind} · ${repos} 个仓库` : kindLabel[s.kind] ?? s.kind,
      indent: child,
      ...(!child && s.kind === "repo" ? { group: "独立仓库" } : {}),
    };
  });
}
