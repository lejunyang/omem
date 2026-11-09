import type { App } from "./app.ts";
import { all, one, run } from "./db.ts";
import { json, now } from "./util.ts";

/**
 * Pairs of spaces that look related but are not yet (and were not rejected by the owner),
 * from evidence the host can see without understanding anything:
 *
 * - memories or pages in one space citing originals of another
 * - Wiki links from one space's pages to another's
 * - a repository's manifest naming another repository's package as a dependency
 * - the same memory tag used in both
 *
 * The dreamer decides from these whether to relate them (relate_spaces). A pair it judged unrelated
 * (relate_spaces decline) is not offered again until a new kind of evidence turns up.
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

const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whether a manifest declares `name` as a dependency: the name as a whole token where that file
 * kind lists dependencies, never as part of a longer word ("view" is not in "preview").
 */
export function dependsOn(uri: string, text: string, name: string): boolean {
  const file = uri.split("/").pop() ?? "";
  const n = esc(name);
  if (file === "package.json") {
    try {
      const pkg = JSON.parse(text) as Record<string, unknown>;
      return ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].some((k) => {
        const deps = pkg[k];
        return !!deps && typeof deps === "object" && Object.prototype.hasOwnProperty.call(deps, name);
      });
    } catch {
      return new RegExp(`"${n}"\\s*:`).test(text);
    }
  }
  // require lines: the module path, alone or with a version after it.
  if (file === "go.mod") return new RegExp(`(^|[\\s(])${n}(\\s|$)`, "m").test(text);
  // A table key (name = "1.0" / name = { … }) or a renamed one (package = "name").
  if (file === "Cargo.toml") return new RegExp(`^\\s*["']?${n}["']?\\s*=|package\\s*=\\s*"${n}"`, "m").test(text);
  // A requirement string: the name, then a version, extra, marker or the end of the string.
  if (file === "pyproject.toml" || file === "setup.py") return new RegExp(`["']${n}\\s*(?=[<>=!~\\[;,@"']|$)`, "m").test(text);
  if (file === "pom.xml") return new RegExp(`<dependency>(?:(?!</dependency>)[\\s\\S])*<artifactId>${n}</artifactId>`).test(text);
  // group:artifact[:version] in quotes.
  return new RegExp(`["':]${n}(?=["':])`).test(text);
}

/** Evidence without its counts: "3 条记忆" and "5 条记忆" are the same kind of evidence. */
const signalKind = (signal: string) => signal.replace(/\d+/g, "#");

/**
 * The dreamer read the evidence and found the two unrelated: remember the kinds of evidence it saw,
 * so the pair comes back only when something new points at it.
 */
export function declineRelation(app: App, a: string, b: string, reason: string) {
  const [x, y] = a < b ? [a, b] : [b, a];
  const seen = relationCandidates(app, Infinity, { includeDeclined: true }).find((c) => c.a === x && c.b === y)?.signals ?? [];
  const old = json<string[]>(one<{ signals: string }>(app.db, "select signals from space_relation_declines where space_a = ? and space_b = ?", x, y)?.signals ?? "[]", []);
  const kinds = [...new Set([...old, ...seen.map(signalKind)])];
  run(
    app.db,
    `insert into space_relation_declines(space_a, space_b, signals, reason, at) values(?,?,?,?,?)
     on conflict(space_a, space_b) do update set signals = excluded.signals, reason = excluded.reason, at = excluded.at`,
    x,
    y,
    JSON.stringify(kinds),
    reason,
    now(),
  );
  return kinds;
}

export function relationCandidates(app: App, limit = 12, opts: { includeDeclined?: boolean } = {}): RelationCandidate[] {
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
  // Who publishes each name. A name several spaces publish (copies, forks, a shared workspace
  // package) says nothing about which one is depended on.
  const publishers = new Map<string, Set<string>>();
  for (const m of manifests) {
    const name = packageName(m.uri, m.text);
    if (name) publishers.set(name, (publishers.get(name) ?? new Set()).add(m.space_id));
  }
  for (const m of manifests)
    for (const [name, spaces] of publishers) {
      if (spaces.size !== 1 || spaces.has(m.space_id)) continue;
      const owner = [...spaces][0];
      if (dependsOn(m.uri, m.text, name)) add(m.space_id, owner, `${m.space_id} 的 ${m.uri} 依赖 ${owner} 发布的 ${name}`);
    }

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

  const declined = new Map(
    opts.includeDeclined ? [] : all<{ space_a: string; space_b: string; signals: string }>(app.db, "select space_a, space_b, signals from space_relation_declines").map((r) => [`${r.space_a}|${r.space_b}`, new Set(json<string[]>(r.signals, []))]),
  );
  return [...found]
    .filter(([k, s]) => !declined.has(k) || [...s].some((x) => !declined.get(k)!.has(signalKind(x))))
    .map(([k, s]) => ({ a: k.split("|")[0], b: k.split("|")[1], signals: [...s] }))
    .sort((x, y) => y.signals.length - x.signals.length)
    .slice(0, limit);
}
