import type { App } from "./app.ts";
import { all } from "./db.ts";
import { json } from "./util.ts";

/**
 * Pairs of spaces that look related but are not yet (and were not rejected by the owner),
 * from evidence the host can see without understanding anything:
 *
 * - memories or pages in one space citing originals of another
 * - Wiki links from one space's pages to another's
 * - a repository's manifest naming another repository's package as a dependency
 * - the same memory tag used in both
 *
 * The dreamer decides from these whether to relate them (relate_spaces).
 */
export type RelationCandidate = { a: string; b: string; signals: string[] };

const MANIFESTS = ["package.json", "go.mod", "pyproject.toml", "setup.py", "Cargo.toml", "pom.xml", "build.gradle", "build.gradle.kts"];

/** The package a manifest publishes, if it says. */
export function packageName(uri: string, text: string): string | null {
  const file = uri.split("/").pop() ?? "";
  const m =
    file === "package.json"
      ? /"name"\s*:\s*"([^"]+)"/.exec(text)
      : file === "go.mod"
        ? /^module\s+(\S+)/m.exec(text)
        : file === "pyproject.toml" || file === "Cargo.toml"
          ? /^\s*name\s*=\s*"([^"]+)"/m.exec(text)
          : file === "setup.py"
            ? /name\s*=\s*["']([^"']+)["']/.exec(text)
            : file === "pom.xml"
              ? /<artifactId>([^<]+)<\/artifactId>/.exec(text.replace(/<parent>[\s\S]*?<\/parent>/, ""))
              : null;
  const name = m?.[1]?.trim();
  // Too short or generic names match by accident.
  return name && name.length >= 4 && !/^(app|main|demo|test|root|server|client|web)$/i.test(name) ? name : null;
}

export function relationCandidates(app: App, limit = 12): RelationCandidate[] {
  const known = new Set(all<{ space_a: string; space_b: string }>(app.db, "select space_a, space_b from space_relations").map((r) => `${r.space_a}|${r.space_b}`));
  const found = new Map<string, Set<string>>();
  const add = (x: string, y: string, signal: string) => {
    if (!x || !y || x === y) return;
    const [a, b] = x < y ? [x, y] : [y, x];
    if (known.has(`${a}|${b}`)) return;
    const k = `${a}|${b}`;
    if (!found.has(k)) found.set(k, new Set());
    found.get(k)!.add(signal);
  };

  // Memories citing another space's originals.
  for (const r of all<{ a: string; b: string; n: number }>(
    app.db,
    `select m.space_id a, s.space_id b, count(*) n from memories m, json_each(m.source_refs) j
       join sources s on s.id = substr(j.value, 5, instr(j.value || '#', '#') - 5)
     where m.status = 'active' and j.value like 'src:%' and s.space_id != m.space_id group by a, b`,
  ))
    add(r.a, r.b, `${r.a} 有 ${r.n} 条记忆引用 ${r.b} 的原件`);

  // Pages citing another space's originals.
  for (const r of all<{ a: string; b: string; n: number }>(
    app.db,
    "select p.space_id a, s.space_id b, count(distinct p.id) n from page_cites c join pages p on p.id = c.page_id join sources s on s.id = c.source_id where s.space_id != p.space_id group by a, b",
  ))
    add(r.a, r.b, `${r.a} 有 ${r.n} 个页面引用 ${r.b} 的原件`);

  // Wiki links across spaces (to_id is space/slug).
  for (const r of all<{ a: string; b: string; n: number }>(
    app.db,
    "select p.space_id a, substr(l.to_id, 1, instr(l.to_id, '/') - 1) b, count(*) n from page_links l join pages p on p.id = l.from_id where instr(l.to_id, '/') > 0 and substr(l.to_id, 1, instr(l.to_id, '/') - 1) != p.space_id group by a, b",
  ))
    add(r.a, r.b, `${r.a} 的页面链接到 ${r.b}（${r.n} 处）`);

  // Repositories depending on each other's packages.
  const manifests = all<{ space_id: string; uri: string; text: string }>(
    app.db,
    `select s.space_id, s.uri, s.text from sources s join spaces p on p.id = s.space_id
      where p.root_path is not null and s.deleted_at is null and (${MANIFESTS.map(() => "s.uri = ? or s.uri like ?").join(" or ")})`,
    ...MANIFESTS.flatMap((f) => [f, `%/${f}`]),
  );
  const published = new Map<string, string>();
  for (const m of manifests) {
    const name = packageName(m.uri, m.text);
    if (name && !published.has(name)) published.set(name, m.space_id);
  }
  for (const m of manifests)
    for (const [name, owner] of published)
      if (owner !== m.space_id && m.text.includes(name) && packageName(m.uri, m.text) !== name) add(m.space_id, owner, `${m.space_id} 的 ${m.uri} 依赖 ${owner} 发布的 ${name}`);

  // The same tag in both.
  const tagSpaces = new Map<string, Set<string>>();
  for (const r of all<{ space_id: string; tags: string }>(app.db, "select space_id, tags from memories where status = 'active' and tags != '[]'"))
    for (const t of json<string[]>(r.tags, [])) {
      if (!tagSpaces.has(t)) tagSpaces.set(t, new Set());
      tagSpaces.get(t)!.add(r.space_id);
    }
  for (const [t, spaces] of tagSpaces) {
    const list = [...spaces];
    if (list.length > 4) continue; // a tag on everything says nothing
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) add(list[i], list[j], `两边都有标签 #${t} 的记忆`);
  }

  // Nightly replay (agents/replay.ts): adding the other space to a question's search answered it better.
  for (const r of all<{ target_id: string; n: number }>(app.db, "select target_id, count(*) n from replay_effects where effect = 'relate' and target_kind = 'space' and target_id like '%|%' group by target_id")) {
    const [a, b] = r.target_id.split("|");
    add(a, b, `夜间复盘里 ${r.n} 次加上另一边的空间后答得更好`);
  }

  return [...found]
    .map(([k, s]) => ({ a: k.split("|")[0], b: k.split("|")[1], signals: [...s] }))
    .sort((x, y) => y.signals.length - x.signals.length)
    .slice(0, limit);
}
