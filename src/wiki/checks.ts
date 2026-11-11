/**
 * Checks the host makes on a Wiki page an agent writes (write_page), before it is saved. Only what can
 * be decided from data the host has: links, citations, who may read what, the code index, length.
 * Whether a claim matches what it cites, whether a "not found" is true, whether another space already
 * covers the topic — that is the wiki-checker role's judgment (src/wiki/verify.ts). docs/v2/wiki-verify.md.
 */
import type { App } from "../core/app.ts";
import { all, one } from "../core/db.ts";
import { headCommit } from "../core/git.ts";
import { findSpace, relatedIds } from "../core/spaces.ts";
import { can } from "../auth/permissions.ts";
import { canonicalSourceId } from "../sources/duplicates.ts";
import { extractCites, extractLinks, folderOf, listPages, resolveSlug, resolveSourceRef } from "./store.ts";

/** Body length (characters of text, link targets left out) above which a page is turned away, and above which the checker looks at splitting it. */
export const HARD_LENGTH = 12000;
export const SOFT_LENGTH = 6000;

export type Issue = { kind: "lost-entries" | "cite-missing" | "cite-deleted" | "cite-range" | "cite-unreachable" | "plain-code" | "too-long" | "mermaid"; text: string };

/** What a reader reads: link targets (`](src:…)`, `](https://…)`) and front matter do not count. */
export function textLength(body: string) {
  return body.replace(/\]\([^)]*\)/g, "]").replace(/\s+/g, "").length;
}

const isIndex = (slug: string, kind?: string) => slug === "index" || slug.endsWith("/index") || kind === "index";

/** A link written on `spaceId`'s page, as `{space, slug}` of the page it opens now (null: no such page). */
function target(app: App, spaceId: string, link: string): { space: string; slug: string } | null {
  const colon = link.indexOf(":");
  const space = colon > 0 && findSpace(app, link.slice(0, colon)) ? link.slice(0, colon) : spaceId;
  const raw = space === spaceId && colon <= 0 ? link : link.slice(colon + 1);
  try {
    const slug = resolveSlug(app, space, raw.trim());
    return slug ? { space, slug } : null;
  } catch {
    return null;
  }
}

/**
 * Entries a rewritten home or folder page lost: pages it linked to that still exist and that the new
 * text neither links to nor reaches through the index page of a folder holding them.
 */
export function lostEntries(app: App, spaceId: string, slug: string, kind: string | undefined, before: string, after: string) {
  if (!isIndex(slug, kind)) return [];
  const key = (t: { space: string; slug: string }) => `${t.space}:${t.slug}`;
  const now = new Set(extractLinks(after).map((l) => target(app, spaceId, l)).filter((t): t is { space: string; slug: string } => !!t).map(key));
  const lost: { link: string; space: string; slug: string; title: string }[] = [];
  for (const l of extractLinks(before)) {
    const t = target(app, spaceId, l);
    if (!t || now.has(key(t)) || (t.space === spaceId && t.slug === slug)) continue;
    // Reached through the index page of a folder it sits in.
    let reached = false;
    for (let d = folderOf(t.slug); d && !reached; d = folderOf(d)) reached = now.has(`${t.space}:${d}/index`);
    if (reached || lost.some((x) => key(x) === key(t))) continue;
    const title = one<{ title: string }>(app.db, "select title from pages where id = ?", `${t.space}/${t.slug}`)?.title ?? t.slug;
    lost.push({ link: t.space === spaceId ? t.slug : `${t.space}:${t.slug}`, ...t, title });
  }
  return lost;
}

/** Put lost entries back at the end of the page, under their own heading. */
export function restoreEntries(body: string, lost: { link: string; title: string }[]) {
  if (!lost.length) return body;
  return `${body.trimEnd()}\n\n## 其他页面\n\n${lost.map((l) => `- [[${l.link}|${l.title}]]`).join("\n")}\n`;
}

/** The users who may read a space (active ones), the owner aside: everyone reads everything. */
function readers(app: App, spaceId: string) {
  return all<{ id: string }>(app.db, "select id from users where role != 'owner' and status = 'active' and disabled_at is null").map((u) => u.id).filter((u) => can(app, u, "space.read", spaceId));
}

/** Where else the same original lives, in spaces the page's readers can open: same content, then same path, then same title. */
function sameElsewhere(app: App, spaceId: string, source: { id: string; space_id: string; uri: string; title: string; hash: string }) {
  const repo = (() => {
    const s = findSpace(app, source.space_id);
    return s?.kind === "worktree" ? ((s.settings as { repo?: string }).repo ?? null) : null;
  })();
  const spaces = [...new Set([spaceId, ...(repo ? [repo] : []), ...relatedIds(app, spaceId)])].filter((id) => {
    const s = findSpace(app, id);
    return s && s.kind !== "personal" && s.kind !== "worktree" && id !== source.space_id;
  });
  if (!spaces.length) return null;
  const marks = spaces.map(() => "?").join(",");
  return (
    one<{ id: string; space_id: string }>(app.db, `select id, space_id from sources where space_id in (${marks}) and hash = ? and deleted_at is null`, ...spaces, source.hash) ??
    one<{ id: string; space_id: string }>(app.db, `select id, space_id from sources where space_id in (${marks}) and uri = ? and deleted_at is null`, ...spaces, source.uri) ??
    one<{ id: string; space_id: string }>(app.db, `select id, space_id from sources where space_id in (${marks}) and title = ? and deleted_at is null`, ...spaces, source.title)
  );
}

/**
 * Citations that do not hold up: an original that is not there or was deleted, a line range past its
 * end, and — on a page others read — an original some of them cannot open (someone's personal space,
 * a delegation's temporary branch index, a space a reader of this one has no access to).
 */
export function citeIssues(app: App, spaceId: string, body: string): Issue[] {
  const page = findSpace(app, spaceId);
  const shared = !!page && page.kind !== "personal";
  const pageReaders = shared ? readers(app, spaceId) : [];
  const out: Issue[] = [];
  const seen = new Set<string>();
  for (const c of extractCites(body)) {
    const key = `${c.ref}#${c.lineStart}-${c.lineEnd}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // Resolved the way the page index resolves it (an id, a merged id, a path in this space or anywhere).
    const ref = resolveSourceRef(app, spaceId, c.ref);
    const s = ref ? one<{ id: string; space_id: string; uri: string; title: string; hash: string; text: string; deleted_at: string | null }>(app.db, "select id, space_id, uri, title, hash, text, deleted_at from sources where id = ?", ref.id) : null;
    if (!s) {
      out.push({ kind: "cite-missing", text: `找不到原件 src:${c.ref}：用 search / read_source 拿到原件 id 再引用` });
      continue;
    }
    if (s.deleted_at) {
      out.push({ kind: "cite-deleted", text: `原件 ${s.title}（src:${s.id}）已被删除：换成现有的依据或去掉这条引用` });
      continue;
    }
    const lines = s.text ? s.text.split("\n").length : 0;
    if (c.lineStart !== null && (c.lineStart < 1 || (c.lineEnd ?? c.lineStart) > lines || (c.lineEnd ?? c.lineStart) < c.lineStart))
      out.push({ kind: "cite-range", text: `src:${s.id}#L${c.lineStart}-L${c.lineEnd} 超出原件范围：${s.title} 只有 ${lines} 行，用 read_source 重新确认行号` });
    if (!shared || s.space_id === spaceId) continue;
    const from = findSpace(app, s.space_id);
    const why =
      from?.kind === "personal" ? `在个人空间 ${s.space_id}，空间的其他读者打不开`
      : from?.kind === "worktree" ? `在交办的临时分支索引 ${s.space_id} 里，交办结束后会被清掉`
      : pageReaders.some((u) => !can(app, u, "space.read", s.space_id)) ? `在空间 ${s.space_id}，这个空间有读者没有它的权限`
      : "";
    if (!why) continue;
    const alt = sameElsewhere(app, spaceId, s);
    out.push({ kind: "cite-unreachable", text: `src:${s.id}（${s.title}）${why}。${alt ? `空间 ${alt.space_id} 里有同一份：改引用 src:${alt.id}（行号用 read_source 再确认）` : "换成本空间或相关业务空间里的依据；确实只有这一份时，先把它收进业务空间再引用"}` });
  }
  return out;
}

/** Spaces whose code a page may cite: its own, its related ones (repositories included), within what the run may read. */
export function codeSpaces(app: App, spaceId: string, readable: string[] | null) {
  return [...new Set([spaceId, ...relatedIds(app, spaceId)])].filter((id) => !readable || readable.includes(id));
}

/** Fenced code blocks and `[text](target)` links (whatever they point at) are not plain-text mentions. */
const prose = (body: string) => body.replace(/```[\s\S]*?```/g, "").replace(/\[[^\]]*\]\([^)]*\)/g, "");

/**
 * Code named in plain text that the index can give a `src:` citation for: `path/file.ext:120` (or
 * `#L120`) whose file is a single original in the page's code spaces, and `` `symbolName` `` defined in
 * exactly one file the page never cites. Mentions the index cannot resolve are returned apart.
 */
export function codeRefIssues(app: App, spaceId: string, body: string, spaces: string[]) {
  const issues: Issue[] = [];
  const unresolved: string[] = [];
  if (!spaces.length) return { issues, unresolved };
  const marks = spaces.map(() => "?").join(",");
  const text = prose(body);
  const cited = new Set(extractCites(body).map((c) => canonicalSourceId(app, c.ref)));
  const paths = new Set<string>();
  for (const m of text.matchAll(/(?<![\w/.-])((?:[\w.@-]+\/)*[\w.@-]+\.[A-Za-z][A-Za-z0-9]{0,5})(?::|#L)(\d+)(?:-L?(\d+))?/g)) {
    const [whole, path, a, b] = m;
    if (paths.has(whole) || /^\d+\.\d+$/.test(path) || /^https?$/i.test(path)) continue;
    paths.add(whole);
    const hits = all<{ id: string; uri: string }>(app.db, `select id, uri from sources where space_id in (${marks}) and deleted_at is null and (uri = ? or uri like ?) limit 3`, ...spaces, path, `%/${path}`);
    if (hits.length === 1) issues.push({ kind: "plain-code", text: `“${whole}”写成了纯文本：改成 [${path}:${a}](src:${hits[0].id}#L${a}-L${b ?? a})（行号用 read_source 确认）` });
    else if (!hits.length && path.includes("/")) unresolved.push(whole);
  }
  const names = new Set<string>();
  for (const m of text.matchAll(/`([A-Za-z_$][\w$]*(?:(?:\.|::|#)[A-Za-z_$][\w$]*)*)(\(\))?`/g)) {
    const name = m[1].split(/\.|::|#/).pop()!;
    const symbolish = name.length >= 5 && (/[a-z][A-Z]/.test(name) || name.includes("_") || !!m[2] || m[1] !== name);
    if (!symbolish || names.has(name)) continue;
    names.add(name);
    const defs = all<{ source_id: string; line_start: number; line_end: number; uri: string }>(app.db, `select distinct y.source_id, y.line_start, y.line_end, s.uri from symbols y join sources s on s.id = y.source_id where y.space_id in (${marks}) and y.name = ? and s.deleted_at is null limit 3`, ...spaces, name);
    const files = new Set(defs.map((d) => d.source_id));
    if (files.size !== 1 || cited.has(defs[0].source_id)) continue;
    issues.push({ kind: "plain-code", text: `\`${m[1]}\` 只在 ${defs[0].uri} 定义，页面没有引用这个文件：在讲它的地方加 [${defs[0].uri}:${defs[0].line_start}](src:${defs[0].source_id}#L${defs[0].line_start}-L${defs[0].line_end})` });
  }
  return { issues: issues.slice(0, 12), unresolved };
}

/** Pages in related spaces whose title is (nearly) the same as `title`: the same topic written elsewhere. */
export function sameTopicElsewhere(app: App, spaceId: string, title: string, readable: string[] | null = null) {
  const norm = (s: string) => s.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
  const t = norm(title);
  if (t.length < 2) return [];
  const out: { space: string; slug: string; title: string }[] = [];
  for (const sp of relatedIds(app, spaceId)) {
    if (readable && !readable.includes(sp)) continue;
    for (const p of listPages(app, sp)) {
      if (p.slug === "index" || p.slug.endsWith("/index")) continue;
      const n = norm(p.title);
      if (n === t || (Math.min(n.length, t.length) >= 4 && (n.includes(t) || t.includes(n)))) out.push({ space: sp, slug: p.slug, title: p.title });
    }
  }
  return out.slice(0, 10);
}

/** What write_page refuses (`errors`), notes the writer gets back, and the body as it will be saved (lost entries put back). */
export function checkPageWrite(app: App, input: { spaceId: string; slug: string; kind?: string; title: string; body: string; before: string | null; readable: string[] | null; restoreLost: boolean }) {
  const errors: Issue[] = [];
  const notes: string[] = [];
  let body = input.body;
  const fixes: string[] = [];
  if (input.before !== null) {
    const lost = lostEntries(app, input.spaceId, input.slug, input.kind, input.before, body);
    if (lost.length && input.restoreLost) {
      body = restoreEntries(body, lost);
      fixes.push("lost-entries");
      notes.push(`改写丢了 ${lost.length} 个仍然存在的页面入口，已补在页尾“其他页面”：${lost.map((l) => l.link).join("、")}。觉得放得不合适就把它们移到对应分组里`);
    } else if (lost.length)
      errors.push({ kind: "lost-entries", text: `改写后丢了 ${lost.length} 个仍然存在的页面入口：${lost.map((l) => `[[${l.link}|${l.title}]]`).join("、")}。把它们放回合适的分组（或链接到收着它们的目录 index）；确实不该再列的页面要先移动或删除。再次提交仍然缺少时宿主会把它们补在页尾` });
  }
  errors.push(...citeIssues(app, input.spaceId, body));
  const code = codeRefIssues(app, input.spaceId, body, codeSpaces(app, input.spaceId, input.readable));
  errors.push(...code.issues);
  if (code.unresolved.length) notes.push(`这些代码位置在索引里找不到对应的文件，核对时会再看：${code.unresolved.slice(0, 8).join("、")}`);
  const len = textLength(body);
  if (!isIndex(input.slug, input.kind) && len > HARD_LENGTH)
    errors.push({ kind: "too-long", text: `正文约 ${len} 字，超过 ${HARD_LENGTH}：按读者的问题拆成几页（同目录下的新页面），这一页留开头的结论和到各页的链接` });
  else if (!isIndex(input.slug, input.kind) && len > SOFT_LENGTH) notes.push(`正文约 ${len} 字，偏长：核对时会看能不能拆`);
  const same = input.before === null ? sameTopicElsewhere(app, input.spaceId, input.title, input.readable) : [];
  if (same.length) notes.push(`相关空间已有同主题的页面：${same.map((p) => `[[${p.space}:${p.slug}|${p.title}]]`).join("、")}。两边讲的是同一件事就链接过去、只写本空间特有的部分；说法不一致的在页面里写清以哪边为准`);
  return { errors, notes, body, fixes, length: len };
}

// ---------------------------------------------------------------- diagrams

type MermaidLib = { parse(text: string): Promise<unknown> };
let mermaidLib: Promise<MermaidLib | null> | null = null;
/**
 * mermaid's own parser, in Node. Parsing a valid flowchart sanitizes its labels with DOMPurify, which
 * has no window here: it gets inert stand-ins (nothing on the host renders HTML with DOMPurify, and
 * parsing only checks syntax). Null when mermaid cannot be loaded: the checker role looks instead.
 */
function loadMermaid() {
  mermaidLib ??= (async () => {
    try {
      const purify = (await import("dompurify")).default as unknown as Record<string, unknown>;
      if (typeof purify.addHook !== "function") Object.assign(purify, { addHook() {}, removeHook() {}, removeHooks() {}, removeAllHooks() {}, sanitize: (s: unknown) => String(s) });
      return (await import("mermaid")).default as unknown as MermaidLib;
    } catch (e) {
      console.warn(`[omem] mermaid 加载失败，Wiki 图表的语法检查交给核对角色：${(e as Error).message}`);
      return null;
    }
  })();
  return mermaidLib;
}

/** Whether mermaid could be loaded here to check diagrams (when not, the checker role is told to look). */
export const mermaidCheckable = async () => !!(await loadMermaid());

/** ```mermaid blocks of a page that mermaid cannot parse, with the page line the error is on. */
export async function mermaidIssues(body: string): Promise<Issue[]> {
  const blocks: { start: number; text: string }[] = [];
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*```+\s*mermaid\s*$/i.test(lines[i])) continue;
    const start = i + 1;
    let j = start;
    while (j < lines.length && !/^\s*```+\s*$/.test(lines[j])) j++;
    blocks.push({ start, text: lines.slice(start, j).join("\n") });
    i = j;
  }
  if (!blocks.length) return [];
  const mermaid = await loadMermaid();
  if (!mermaid) return [];
  const out: Issue[] = [];
  for (const [n, b] of blocks.entries()) {
    try {
      await mermaid.parse(b.text);
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      const at = /line (\d+)/i.exec(msg);
      const pageLine = b.start + (at ? Number(at[1]) : 1);
      const detail = msg.split("\n").slice(0, 3).join(" ").replace(/\s+/g, " ").slice(0, 300);
      out.push({ kind: "mermaid", text: `第 ${n + 1} 张 mermaid 图语法错误，在正文第 ${pageLine} 行附近：${detail}。常见原因：节点或连线文字里有括号、以 / 开头（会被当成形状），把文字用双引号包起来，如 A["调用 apply(order)"]、-->|"成功(200)"|` });
    }
  }
  return out;
}

// ---------------------------------------------------------------- the code index

export type IndexState = { space: string; name: string; reason: string };

/** Repository spaces among `spaces` whose index is behind their checkout (or was never built). */
export function staleCodeIndexes(app: App, spaces: string[]): IndexState[] {
  const out: IndexState[] = [];
  for (const id of new Set(spaces)) {
    const s = findSpace(app, id);
    if (!s?.rootPath || s.kind === "worktree") continue;
    const lastSync = s.settings.lastSync as string | undefined;
    const indexed = (s.settings.commit as string | null | undefined) ?? null;
    let head: string | null = null;
    try {
      head = headCommit(s.rootPath);
    } catch {}
    if (!lastSync) out.push({ space: id, name: s.name, reason: "还没有建过索引" });
    else if (head && head !== indexed) out.push({ space: id, name: s.name, reason: `索引停在 ${lastSync.slice(0, 10)}${indexed ? `（${indexed.slice(0, 8)}）` : ""}，仓库已到 ${head.slice(0, 8)}` });
  }
  return out;
}

/** Bring stale code indexes up to date before a page is planned or written; what could not be is returned to report. */
export async function refreshCodeIndexes(app: App, spaces: string[], onStatus?: (text: string) => void, timeoutMs = 10 * 60_000) {
  const notes: string[] = [];
  const synced: string[] = [];
  for (const st of staleCodeIndexes(app, spaces)) {
    if (one(app.db, "select 1 from runs where kind = 'sync' and space_id = ? and status = 'running'", st.space)) {
      notes.push(`代码空间 ${st.name} 的索引正在同步（${st.reason}），这次写作时还没完成，引用它的新代码可能缺`);
      continue;
    }
    onStatus?.(`代码空间 ${st.name} ${st.reason}：先同步索引`);
    try {
      const { syncDirectorySpace } = await import("../sources/import.ts");
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([syncDirectorySpace(app, st.space), new Promise((_, reject) => (timer = setTimeout(() => reject(new Error("超过 10 分钟没有完成")), timeoutMs)))]).finally(() => clearTimeout(timer));
      synced.push(st.name);
    } catch (e) {
      notes.push(`代码空间 ${st.name} ${st.reason}，同步失败（${(e as Error).message}）：页面里引用它的代码可能对不上`);
    }
  }
  return { synced, notes };
}
