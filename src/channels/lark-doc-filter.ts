import { asLarkUser } from "../auth/lark-user.ts";
import type { App } from "../core/app.ts";
import { HttpError } from "../core/util.ts";
import { findUser, OWNER, updateUser } from "../core/users.ts";
import { larkCli } from "./lark-cli.ts";
import { personalLibrary, wikiNode, type WikiNode } from "./lark-wiki.ts";

/**
 * Which Feishu documents a person lets omem keep on its own (docs/v2/multi-user.md, “文档采集的范围”):
 * the documents they opened lately (lark-personal.ts captureRecentDocs), the documents those link to
 * or list as child pages, and for the owner the documents linked in captured chats. Each person keeps
 * their own list (`settings.larkDocs`): single documents, a knowledge-base page with everything under
 * it, a whole knowledge base, a cloud-space folder, and their personal document library as one switch.
 * A document someone hands the assistant themselves is not filtered: they asked for it.
 */
export type DocRule = { kind: "doc" | "wiki" | "space" | "folder"; token: string; url: string; title?: string };
export type DocCapture = {
  /** Their recently opened documents are read at all (the owner's is `lark.capture.recentDocs`). */
  on: boolean;
  /** Skip everything in their personal document library (default on for members, off for the owner). */
  skipLibrary: boolean;
  exclude: DocRule[];
};
export type DocCaptureSettings = { skipLibrary?: boolean; exclude?: DocRule[] };
const MAX_RULES = 100;

export function docCaptureOf(app: App, userId: string): DocCapture {
  const u = findUser(app, userId);
  const s = u?.settings.larkDocs ?? {};
  const owner = userId === OWNER;
  return {
    // Members who connected before this switch existed keep what they had (on); the login page and the account page set it.
    on: owner ? app.config.lark.capture.recentDocs : u?.settings.larkCapture?.docs ?? true,
    skipLibrary: s.skipLibrary ?? !owner,
    exclude: s.exclude ?? [],
  };
}

/** What a link points at, as a rule; null for something that is not a document, a folder or a knowledge base. */
export function parseDocRule(input: string): DocRule | null {
  let u: URL;
  try { u = new URL(input.trim()); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const parts = u.pathname.split("/").filter(Boolean);
  const url = `${u.origin}${u.pathname}`;
  const tok = (s: string | undefined) => (s && /^[A-Za-z0-9_-]{3,80}$/.test(s) ? s : null);
  if (parts[0] === "wiki" && parts[1] === "space") { const t = tok(parts[2]); return t ? { kind: "space", token: t, url } : null; }
  if (parts[0] === "wiki" && parts[1] === "settings") { const t = tok(parts[2]); return t ? { kind: "space", token: t, url: `${u.origin}/wiki/space/${t}` } : null; }
  if (parts[0] === "wiki") { const t = tok(parts[1]); return t ? { kind: "wiki", token: t, url } : null; }
  if (parts[0] === "drive" && parts[1] === "folder") { const t = tok(parts[2]); return t ? { kind: "folder", token: t, url } : null; }
  if (["docx", "docs", "doc", "sheets", "base", "mindnotes", "file", "slides"].includes(parts[0] ?? "")) { const t = tok(parts[1]); return t ? { kind: "doc", token: t, url } : null; }
  return null;
}

/** As the person whose list it is (the owner's own login otherwise). */
const asThem = <T>(app: App, userId: string, fn: () => Promise<T>) => (userId === OWNER ? fn() : asLarkUser(app, userId, fn));

/** A title for the rule, as far as their login can read it; a rule without one shows its link. */
async function describe(app: App, userId: string, rule: DocRule): Promise<DocRule> {
  try {
    return await asThem(app, userId, async () => {
      if (rule.kind === "wiki" || rule.kind === "doc") {
        const n = await wikiNode(app, rule.token).catch(() => null);
        if (n?.title) return { ...rule, title: n.title };
      }
      if (rule.kind === "space") {
        const v = await larkCli(["wiki", "spaces", "get", "--params", JSON.stringify({ space_id: rule.token }), "--as", "user", "--format", "json"], 30_000);
        const name = (v?.data ?? v)?.space?.name;
        if (typeof name === "string" && name.trim()) return { ...rule, title: name.trim().slice(0, 200) };
      }
      return rule;
    });
  } catch {
    return rule;
  }
}

export async function setDocCapture(app: App, userId: string, patch: { on?: boolean; skipLibrary?: boolean; add?: string; remove?: string }) {
  const u = findUser(app, userId);
  if (!u) throw new HttpError(404, "没有这个用户");
  if (patch.on !== undefined && userId === OWNER) throw new HttpError(400, "你自己的在 设置 → 采集 → 飞书文档 里开关");
  const now = docCaptureOf(app, userId);
  let exclude = now.exclude;
  if (patch.add) {
    const rule = parseDocRule(patch.add);
    if (!rule) throw new HttpError(400, "认不出这个链接：贴飞书文档、知识库页面、知识库首页或云空间文件夹的链接");
    if (exclude.length >= MAX_RULES) throw new HttpError(400, `最多排除 ${MAX_RULES} 项`);
    if (!exclude.some((r) => r.kind === rule.kind && r.token === rule.token)) exclude = [...exclude, await describe(app, userId, rule)];
  }
  if (patch.remove) exclude = exclude.filter((r) => r.token !== patch.remove);
  const larkDocs: DocCaptureSettings = { ...(u.settings.larkDocs ?? {}), exclude, ...(patch.skipLibrary !== undefined ? { skipLibrary: patch.skipLibrary } : {}) };
  updateUser(app, userId, { settings: { larkDocs, ...(patch.on !== undefined ? { larkCapture: { ...(u.settings.larkCapture ?? {}), docs: patch.on } } : {}) } });
  return docCaptureOf(app, userId);
}

const FOLDER_MAX = 2000;
const FOLDER_DEPTH = 5;
const FOLDER_TTL = 30 * 60_000;
/** Document tokens under an excluded folder, by person and folder; listed again after half an hour. */
const folderCache = new Map<string, { until: number; tokens: Promise<Set<string>> }>();
async function listFolder(token: string) {
  const found = new Set<string>();
  const queue: [string, number][] = [[token, 0]];
  while (queue.length && found.size < FOLDER_MAX) {
    const [folder, depth] = queue.shift()!;
    let page = "";
    for (let i = 0; i < 20 && found.size < FOLDER_MAX; i++) {
      const v = await larkCli(["drive", "files", "list", "--params", JSON.stringify({ folder_token: folder, page_size: 200, ...(page ? { page_token: page } : {}) }), "--as", "user", "--format", "json"], 60_000);
      const d = v?.data ?? v;
      for (const f of (d?.files ?? []) as { token?: string; type?: string; shortcut_info?: { target_token?: string } }[]) {
        if (f.type === "folder" && f.token) { if (depth + 1 < FOLDER_DEPTH) queue.push([f.token, depth + 1]); continue; }
        const t = f.shortcut_info?.target_token ?? f.token;
        if (t) found.add(t);
      }
      if (!d?.has_more || !d?.next_page_token) break;
      page = String(d.next_page_token);
    }
  }
  return found;
}

/** The path token of a document link and whether it is a knowledge-base page. */
function tokenOf(url: string): { token: string; wiki: boolean } | null {
  const r = parseDocRule(url);
  return r && (r.kind === "doc" || r.kind === "wiki") ? { token: r.token, wiki: r.kind === "wiki" } : null;
}

/**
 * For one capture pass: why a document is left out (null: keep it). Runs as whoever is capturing (the
 * caller is already inside their Feishu login). Looks a knowledge-base page up once, and walks up its
 * parents only when a page rule needs it; an unreadable lookup keeps the document (it then fails to
 * import the usual way rather than being hidden by a guess).
 */
export function docSkipper(app: App, userId: string) {
  const c = docCaptureOf(app, userId);
  const docs = new Set(c.exclude.filter((r) => r.kind === "doc").map((r) => r.token));
  const pages = new Set(c.exclude.filter((r) => r.kind === "wiki").map((r) => r.token));
  const spaces = new Set(c.exclude.filter((r) => r.kind === "space").map((r) => r.token));
  const folders = c.exclude.filter((r) => r.kind === "folder");
  const needWiki = pages.size > 0 || spaces.size > 0 || c.skipLibrary;
  const nodes = new Map<string, Promise<WikiNode | null>>();
  const node = (t: string) => {
    if (!nodes.has(t)) nodes.set(t, wikiNode(app, t).catch(() => null));
    return nodes.get(t)!;
  };
  let library: Promise<string | null> | null = null;
  const inFolders = async (token: string) => {
    for (const f of folders) {
      const key = `${userId}:${f.token}`;
      let hit = folderCache.get(key);
      if (!hit || hit.until < Date.now()) {
        hit = { until: Date.now() + FOLDER_TTL, tokens: listFolder(f.token).catch(() => new Set<string>()) };
        folderCache.set(key, hit);
      }
      if ((await hit.tokens).has(token)) return f;
    }
    return null;
  };
  const named = (r: DocRule | undefined, fallback: string) => (r?.title ? `${fallback}《${r.title}》` : fallback);
  return async (url: string): Promise<string | null> => {
    const t = tokenOf(url);
    if (!t) return null;
    if (docs.has(t.token)) return "排除的文档";
    if (folders.length && !t.wiki) {
      const f = await inFolders(t.token);
      if (f) return named(f, "排除的文件夹");
    }
    if (!needWiki) return null;
    const n = await node(t.token);
    if (!n) return null;
    if (docs.has(n.objToken) || docs.has(n.nodeToken)) return "排除的文档";
    if (spaces.has(n.spaceId)) return named(c.exclude.find((r) => r.kind === "space" && r.token === n.spaceId), "排除的知识库");
    if (c.skipLibrary) {
      library ??= personalLibrary(app).catch(() => null);
      if (n.spaceId && n.spaceId === (await library)) return "个人文档库";
    }
    if (pages.size) {
      let cur: WikiNode | null = n;
      for (let i = 0; cur && i < 64; i++) {
        if (pages.has(cur.nodeToken)) return named(c.exclude.find((r) => r.kind === "wiki" && r.token === cur!.nodeToken), "排除的知识库页面");
        cur = cur.parentNodeToken ? await node(cur.parentNodeToken) : null;
      }
    }
    return null;
  };
}
export type DocSkipper = ReturnType<typeof docSkipper>;
