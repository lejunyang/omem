import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { notify } from "../core/notify.ts";
import { HttpError, json, newId } from "../core/util.ts";
import { asOwner } from "./lark-auth.ts";
import { larkCli } from "./lark-cli.ts";
import { catalogChanged } from "../sources/catalog.ts";

/**
 * Feishu knowledge bases (wiki) read as the owner: a node's place in the tree and its children.
 *
 * A wiki page often serves as a table of contents whose pages are its child nodes, not links in
 * its text. `importLarkDocument` treats a page's children as links of the same level, so the
 * levels count from the doc first given (`docLinkDepth`), at most `docWikiChildren` per page and
 * `docMaxPerImport` docs per import. A whole knowledge base goes through a crawl: a queue kept in
 * the database, read breadth-first batch by batch (by a scheduled rule, an agent's wake-up, or all
 * at once in the background), so a restart or a pause does not lose its place.
 */

export type WikiNode = {
  spaceId: string;
  nodeToken: string;
  objToken: string;
  objType: string;
  nodeType: string;
  originNodeToken?: string;
  parentNodeToken?: string;
  title: string;
  hasChild: boolean;
};

function toNode(n: any): WikiNode {
  return {
    spaceId: String(n.space_id ?? ""),
    nodeToken: String(n.node_token ?? ""),
    objToken: String(n.obj_token ?? ""),
    objType: String(n.obj_type ?? ""),
    nodeType: String(n.node_type ?? "origin"),
    originNodeToken: n.origin_node_token || undefined,
    parentNodeToken: n.parent_node_token || undefined,
    title: String(n.title ?? ""),
    hasChild: !!n.has_child,
  };
}

/** A wiki node by node token, doc token or URL; null when the doc is not in a knowledge base. */
export async function wikiNode(app: App, token: string): Promise<WikiNode | null> {
  try {
    const v = await asOwner(app, "读取飞书知识库", () => larkCli(["wiki", "+node-get", "--node-token", token, "--as", "user", "--format", "json"], 60_000));
    const d = v?.data ?? v;
    return toNode(d?.node ?? d);
  } catch (e) {
    // Not mounted in a knowledge base.
    if (/131014/.test((e as Error).message)) return null;
    throw e;
  }
}

export type WikiLocation = { node: WikiNode | null; spaceName?: string; parentTitle?: string; path?: string; errors: string[]; ancestors?: WikiNode[] };

/**
 * Keep nodes read from Feishu in `wiki_nodes` (the knowledge-base tree of sources/catalog.ts): the
 * node, its title and parent as Feishu has them now. `sourceId` links the omem copy of a doc; a node
 * nobody captured keeps a null source and shows greyed out. `error` marks the top of a chain whose
 * parent could not be read (no permission), so its subtree hangs under “（无权限的上级）”.
 */
export function recordWikiNodes(app: App, nodes: WikiNode[], opts: { sourceId?: string; spaceName?: string; error?: string | null } = {}) {
  const at = new Date().toISOString();
  const up = app.db.prepare(`insert into wiki_nodes(token, wiki_space_id, parent_token, title, obj_token, obj_type, node_type, has_child, source_id, checked_at, error)
    values(?,?,?,?,?,?,?,?,?,?,null) on conflict(token) do update set wiki_space_id = excluded.wiki_space_id, parent_token = excluded.parent_token,
    title = case when excluded.title != '' then excluded.title else wiki_nodes.title end, obj_token = excluded.obj_token, obj_type = excluded.obj_type,
    node_type = excluded.node_type, has_child = excluded.has_child, checked_at = excluded.checked_at, error = null,
    source_id = coalesce(excluded.source_id, wiki_nodes.source_id)`);
  for (const n of nodes) {
    if (!n.nodeToken) continue;
    up.run(n.nodeToken, n.spaceId || null, n.parentNodeToken ?? null, n.title, n.objToken || null, n.objType || null, n.nodeType || null, n.hasChild ? 1 : 0, null, at);
  }
  if (opts.sourceId && nodes[0]?.nodeToken) run(app.db, "update wiki_nodes set source_id = ? where token = ?", opts.sourceId, nodes[0].nodeToken);
  const top = nodes.at(-1);
  if (opts.error && top?.parentNodeToken) run(app.db, "update wiki_nodes set error = ? where token = ?", opts.error.slice(0, 300), top.nodeToken);
  const space = nodes[0]?.spaceId;
  if (space) run(app.db, `insert into wiki_spaces(id, name, checked_at) values(?, ?, ?) on conflict(id) do update set
    name = case when excluded.name != '' then excluded.name else wiki_spaces.name end, checked_at = excluded.checked_at`, space, opts.spaceName ?? "", at);
  if (nodes.length) catalogChanged(app);
}
const locationCaches = new WeakMap<App, Map<string, { until: number; value: Promise<unknown> }>>();
export function clearWikiLocationCache(app: App) { locationCaches.delete(app); }
function cachedLocation<T>(app: App, key: string, read: () => Promise<T>): Promise<T> {
  let cache = locationCaches.get(app);
  if (!cache) locationCaches.set(app, cache = new Map());
  const prior = cache.get(key);
  if (prior && prior.until > Date.now()) return prior.value as Promise<T>;
  if (cache.size > 2000) cache.clear();
  const value = read().catch(error => { cache!.delete(key); throw error; });
  cache.set(key, { until: Date.now() + 5 * 60_000, value });
  return value;
}

/** Resolve human-readable names; incomplete ancestor chains must never masquerade as full paths. */
export async function wikiLocation(app: App, token: string, known?: WikiNode | null): Promise<WikiLocation> {
  const node = known === undefined ? await wikiNode(app, token) : known;
  const result: WikiLocation = { node, errors: [] };
  if (!node) return result;
  try {
    result.spaceName = await cachedLocation(app, `space:${node.spaceId}`, async () => {
      const v = await asOwner(app, "读取飞书知识库名称", () => larkCli(["wiki", "spaces", "get", "--params", JSON.stringify({ space_id: node.spaceId }), "--as", "user", "--format", "json"]));
      const d = v?.data ?? v;
      const name = d?.space?.name ?? d?.name;
      if (typeof name !== "string" || !name.trim()) throw new Error("知识库没有返回名称");
      return name;
    });
  } catch (e) { result.errors.push((e as Error).message); }
  const ancestors: WikiNode[] = [];
  const seen = new Set([node.nodeToken]);
  let parent = node.parentNodeToken;
  try {
    while (parent) {
      if (seen.has(parent) || ancestors.length >= 64) throw new Error("无法确认完整目录层级");
      seen.add(parent);
      const token = parent;
      const n = await cachedLocation(app, `node:${token}`, () => wikiNode(app, token));
      if (!n || n.spaceId !== node.spaceId || !n.title.trim()) throw new Error("无法读取上级目录名称");
      ancestors.push(n);
      parent = n.parentNodeToken;
    }
    result.parentTitle = ancestors[0]?.title;
    result.path = ancestors.map(n => n.title).reverse().join(" / ");
  } catch (e) { result.errors.push((e as Error).message); }
  result.ancestors = ancestors;
  return result;
}

/** Child nodes of a node, up to `max` (pages of 50); an empty `nodeToken` lists the knowledge base's top-level nodes. */
export async function wikiChildren(app: App, node: Pick<WikiNode, "spaceId" | "nodeToken">, max: number): Promise<{ nodes: WikiNode[]; more: boolean }> {
  const nodes: WikiNode[] = [];
  let token = "";
  for (let page = 0; nodes.length < max && page < 200; page++) {
    const v = await asOwner(app, "读取飞书知识库的子页面", () =>
      larkCli(["wiki", "+node-list", "--space-id", node.spaceId, ...(node.nodeToken ? ["--parent-node-token", node.nodeToken] : []), "--page-size", "50", ...(token ? ["--page-token", token] : []), "--as", "user", "--format", "json"], 60_000),
    );
    const d = v?.data ?? v;
    const page = ((d?.nodes ?? d?.items ?? []) as unknown[]).map(toNode);
    nodes.push(...page);
    // Children seen while listing are part of the tree too (greyed out until captured).
    try { recordWikiNodes(app, page); } catch {}
    if (!d?.has_more || !d?.page_token) return { nodes: nodes.slice(0, max), more: nodes.length > max };
    token = String(d.page_token);
  }
  return { nodes: nodes.slice(0, max), more: true };
}

/** The node a child points at: a shortcut opens its origin. */
export function nodeUrl(origin: string, n: WikiNode) {
  return `${origin}/wiki/${n.nodeType === "shortcut" && n.originNodeToken ? n.originNodeToken : n.nodeToken}`;
}

/** Only docs are read; sheets, bases, mind notes and files in a knowledge base stay links. */
export const isReadableNode = (n: WikiNode) => n.objType === "docx" || n.objType === "doc";

let personalSpace: string | null = null;
/** Space id of the owner's personal document library (`my_library`). */
export async function personalLibrary(app: App): Promise<string> {
  if (personalSpace) return personalSpace;
  const v = await asOwner(app, "查找个人文档库", () => larkCli(["wiki", "spaces", "get", "--params", JSON.stringify({ space_id: "my_library" }), "--as", "user", "--format", "json"], 60_000));
  const d = v?.data ?? v;
  const id = String(d?.space?.space_id ?? d?.space_id ?? "");
  if (!id) throw new Error("读不到个人文档库的空间 id");
  personalSpace = id;
  return id;
}

// ---- crawls ------------------------------------------------------------------------------

/** Hand-over counters are kept under `${KEY}:<id>`; before 2026-10-30 every crawl lived in one value under KEY. */
const KEY = "lark_wiki_crawls";
/** Each crawl under a key of its own, so a step of one crawl does not rewrite the others' queues. */
const ONE = "lark_wiki_crawl/";

type Entry = { url: string; depth: number; title?: string; node?: WikiNode };
export type WikiCrawl = {
  id: string;
  /** omem space the docs go into. */
  spaceId: string;
  root: string;
  rootTitle?: string;
  /** A whole knowledge base read from its top-level nodes (lark-knowledge.ts), not from one page. */
  wikiSpaceId?: string;
  /** Pages already captured in the space are passed over without reading them (their updates come from the docs check). */
  skipCaptured?: boolean;
  /** Pages passed over because the space already has them (with `skipCaptured`). */
  known?: number;
  /** Levels of children below the root to read. */
  depth: number;
  maxDocs: number;
  /** Docs per batch; a crawl with a batch pauses after each until continued. */
  batch: number | null;
  status: "running" | "paused" | "done" | "stopped";
  queue: Entry[];
  /** Node URLs already queued (never queued twice). */
  seen: string[];
  read: number;
  failed: number;
  /** Children not read: not docs, beyond the depth, or over maxDocs. */
  skipped: number;
  /** omem source ids read in this crawl, for understanding and for relinking. */
  ids: string[];
  errors: string[];
  startedAt: string;
  updatedAt: string;
  by?: string;
};

const split = new WeakSet<App>();
/** Crawls saved the old way (all in one value) move to a key each, once. */
function splitLegacy(app: App) {
  if (split.has(app)) return;
  split.add(app);
  const legacy = one<{ value: string }>(app.db, "select value from kv where key = ?", KEY)?.value;
  if (legacy === undefined) return;
  for (const c of json<WikiCrawl[]>(legacy, [])) run(app.db, "insert or ignore into kv(key,value) values(?,?)", ONE + c.id, JSON.stringify(c));
  run(app.db, "delete from kv where key = ?", KEY);
}
function crawls(app: App): WikiCrawl[] {
  splitLegacy(app);
  return all<{ value: string }>(app.db, "select value from kv where substr(key, 1, ?) = ?", ONE.length, ONE)
    .map((r) => json<WikiCrawl | null>(r.value, null))
    .filter((c): c is WikiCrawl => !!c)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}
function load(app: App, id: string): WikiCrawl | null {
  splitLegacy(app);
  return json<WikiCrawl | null>(one<{ value: string }>(app.db, "select value from kv where key = ?", ONE + id)?.value, null);
}
function put(app: App, c: WikiCrawl) {
  c.updatedAt = new Date().toISOString();
  run(app.db, "insert into kv(key,value) values(?,?) on conflict(key) do update set value = excluded.value", ONE + c.id, JSON.stringify(c));
}

/** A crawl as the owner and agents see it (without the queue). */
export function crawlSummary(c: WikiCrawl) {
  const { queue, seen, ids, ...rest } = c;
  return { ...rest, queued: queue.length, docs: ids.length, errors: c.errors.slice(-5) };
}

export function listCrawls(app: App) {
  return crawls(app).map(crawlSummary);
}

export function getCrawl(app: App, id: string) {
  const c = load(app, id);
  if (!c) throw new HttpError(404, `没有这个知识库爬取：${id}`);
  return c;
}

/** Drop a finished or stopped crawl (its queue and hand-over counter). */
export function forgetCrawl(app: App, id: string) {
  const c = load(app, id);
  if (!c || c.status === "running" || c.status === "paused") return false;
  run(app.db, "delete from kv where key in (?, ?)", ONE + id, `${KEY}:${id}`);
  return true;
}

/** Being read right now in this process (a background loop holds it). */
export const crawlBusy = (id: string) => driving.has(id);

/**
 * Start reading a whole knowledge base into a space: its top-level nodes are queued (read now, one
 * listing), and the crawl waits paused until it is continued batch by batch (lark-knowledge.ts reads
 * a share of the daily budget from it). Pages the space already has are passed over. An open crawl
 * of the same knowledge base into the same space is returned instead of a second one.
 */
export async function startSpaceCrawl(app: App, input: { spaceId: string; wikiSpaceId: string; title: string; origin: string; depth?: number; maxDocs?: number; batch: number; by?: string }) {
  const same = crawls(app).find((c) => c.wikiSpaceId === input.wikiSpaceId && c.spaceId === input.spaceId && (c.status === "running" || c.status === "paused"));
  if (same) return crawlSummary(same);
  const depth = Math.max(0, Math.min(50, input.depth ?? 50));
  const { nodes, more } = await wikiChildren(app, { spaceId: input.wikiSpaceId, nodeToken: "" }, 5000);
  const queue = nodes.map((n) => ({ url: nodeUrl(input.origin, n), depth, title: n.title, node: n }));
  const at = new Date().toISOString();
  const c: WikiCrawl = {
    id: newId("wc"),
    spaceId: input.spaceId,
    root: `${input.origin}/wiki/space/${input.wikiSpaceId}`,
    rootTitle: input.title,
    wikiSpaceId: input.wikiSpaceId,
    skipCaptured: true,
    known: 0,
    depth,
    maxDocs: Math.max(1, input.maxDocs ?? 100_000),
    batch: Math.max(1, input.batch),
    status: "paused",
    queue,
    seen: [...new Set(queue.map((e) => e.url))],
    read: 0,
    failed: 0,
    skipped: more ? 1 : 0,
    ids: [],
    errors: [],
    startedAt: at,
    updatedAt: at,
    by: input.by,
  };
  put(app, c);
  return crawlSummary(c);
}

/**
 * Start reading a knowledge base (or a part of it) from a node: the node itself and its children
 * `depth` levels down, at most `maxDocs` docs. With `batch`, it stops after that many docs and waits
 * for `continueCrawl` (a rule's schedule, a wake-up); without, it keeps going in the background.
 */
export async function startCrawl(app: App, input: { spaceId: string; url: string; depth?: number; maxDocs?: number; batch?: number | null; by?: string }, opts: { background?: boolean } = {}) {
  const { normalizeDocUrl } = await import("./lark-docs.ts");
  const { url } = normalizeDocUrl(input.url);
  const node = await wikiNode(app, url);
  if (!node) throw new HttpError(400, "这篇文档不在知识库里：知识库爬取只能从知识库页面开始（普通文档的链接会按 docLinkDepth 跟随）");
  const same = crawls(app).find((c) => c.root === url && c.spaceId === input.spaceId && (c.status === "running" || c.status === "paused"));
  if (same) throw new HttpError(409, `这个知识库页面已经在爬取（${same.id}，${same.status === "paused" ? "已暂停，用 continue 继续" : "进行中"}）`);
  const cfg = app.config.lark.capture;
  const c: WikiCrawl = {
    id: newId("wc"),
    spaceId: input.spaceId,
    root: url,
    rootTitle: node.title,
    depth: Math.max(0, Math.min(50, input.depth ?? cfg.docLinkDepth)),
    maxDocs: Math.max(1, input.maxDocs ?? cfg.wikiCrawlMaxDocs),
    batch: input.batch ?? null,
    status: "running",
    queue: [{ url, depth: Math.max(0, Math.min(50, input.depth ?? cfg.docLinkDepth)), title: node.title }],
    seen: [url],
    read: 0,
    failed: 0,
    skipped: 0,
    ids: [],
    errors: [],
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    by: input.by,
  };
  put(app, c);
  if (opts.background !== false) drive(app, c.id);
  return crawlSummary(c);
}

/** Continue a paused crawl (its next batch), or a running one interrupted by a restart. */
export function continueCrawl(app: App, id: string, opts: { batch?: number | null; maxDocs?: number; background?: boolean } = {}) {
  const c = getCrawl(app, id);
  if (c.status === "done" || c.status === "stopped") throw new HttpError(409, `这个爬取已经${c.status === "done" ? "完成" : "停止"}`);
  if (opts.batch !== undefined) c.batch = opts.batch;
  if (opts.maxDocs) c.maxDocs = opts.maxDocs;
  c.status = "running";
  put(app, c);
  if (opts.background !== false) drive(app, id);
  return crawlSummary(c);
}

export function stopCrawl(app: App, id: string) {
  const c = getCrawl(app, id);
  c.status = "stopped";
  put(app, c);
  return crawlSummary(c);
}

/** At startup: crawls that were running carry on. */
export function resumeCrawls(app: App) {
  for (const c of crawls(app)) if (c.status === "running") drive(app, c.id);
}

const driving = new Set<string>();

function drive(app: App, id: string) {
  if (driving.has(id)) return;
  driving.add(id);
  void crawlLoop(app, id)
    .catch((e) => console.warn(`[omem] 知识库爬取 ${id} 出错：${(e as Error).message}`))
    .finally(() => driving.delete(id));
}

/** Read queued nodes one by one until the batch, the queue or `maxDocs` runs out; progress is saved after each. */
export async function crawlLoop(app: App, id: string) {
  const { findLarkDoc, importLarkDocument, relinkParent } = await import("./lark-docs.ts");
  // The space's copy of a page: by its wiki link, or by the document behind it (a /docx/ copy).
  const captured = (c: WikiCrawl, url: string, node: WikiNode) =>
    !!(findLarkDoc(app, c.spaceId, url) ?? (node.objToken ? findLarkDoc(app, c.spaceId, `${new URL(url).origin}/docx/${node.objToken}`) : undefined));
  let inBatch = 0;
  let steps = 0;
  for (;;) {
    const c = getCrawl(app, id);
    if (c.status !== "running") return c;
    if (!c.queue.length || c.read >= c.maxDocs) return finish(app, c);
    // Pages passed over (already there, not docs) cost a listing each: one batch walks a bounded number of them too.
    if (c.batch && (inBatch >= c.batch || (c.skipCaptured && steps >= c.batch * 20 + 100))) {
      c.status = "paused";
      put(app, c);
      await handOver(app, c, false);
      return c;
    }
    const entry = c.queue[0];
    try {
      // Children come with their node; only the root is looked up.
      const node = entry.node ?? (await wikiNode(app, entry.url));
      if (node && !isReadableNode(node)) c.skipped++;
      else if (c.skipCaptured && node && captured(c, entry.url, node)) c.known = (c.known ?? 0) + 1;
      else {
        // Only this page: its children come from the queue, its links stay links (or local copies).
        const r = await importLarkDocument(app, c.spaceId, entry.url, { depth: 0, wikiChildren: false });
        if (!c.ids.includes(r.id)) c.ids.push(r.id);
        c.read++;
        inBatch++;
        // Earlier pages that link to this one now point at the local copy.
        if (r.status === "created" && c.ids.length > 1) {
          const token = new URL(entry.url).pathname.split("/").pop()!;
          const title = one<{ title: string }>(app.db, "select title from sources where id = ?", r.id)?.title ?? entry.title ?? "";
          const others = c.ids.filter((x) => x !== r.id);
          for (const p of all<{ id: string }>(app.db, `select id from sources where id in (${others.map(() => "?").join(",")}) and instr(text, ?) > 0`, ...others, token))
            relinkParent(app, p.id, entry.url, r.id, title);
        }
      }
      // A shortcut's children belong to its origin, which is in the tree elsewhere.
      if (node?.hasChild && node.nodeType !== "shortcut") {
        if (entry.depth <= 0) c.skipped++;
        else {
          const origin = new URL(entry.url).origin;
          const room = Math.max(0, c.maxDocs - c.read - c.queue.length + 1);
          const { nodes, more } = await wikiChildren(app, node, room);
          const seen = new Set(c.seen);
          for (const n of nodes) {
            const url = nodeUrl(origin, n);
            if (seen.has(url)) continue;
            seen.add(url);
            c.seen.push(url);
            c.queue.push({ url, depth: entry.depth - 1, title: n.title, node: n });
          }
          if (more) c.skipped++;
        }
      }
    } catch (e) {
      // Missing permission: pause rather than fail every remaining page the same way.
      if (/缺少飞书权限/.test((e as Error).message)) {
        c.status = "paused";
        c.errors.push((e as Error).message.slice(0, 300));
        put(app, c);
        return c;
      }
      c.failed++;
      if (c.errors.length < 50) c.errors.push(`${entry.title ?? entry.url}：${(e as Error).message.slice(0, 200)}`);
    }
    c.queue.shift();
    steps++;
    put(app, c);
  }
}

async function finish(app: App, c: WikiCrawl) {
  c.skipped += c.queue.length;
  c.queue = [];
  c.status = "done";
  put(app, c);
  await handOver(app, c, true);
  return c;
}

/** Docs read so far go to understanding; the owner hears once when the crawl is done. */
async function handOver(app: App, c: WikiCrawl, done: boolean) {
  const handed = json<Record<string, number>>(one<{ value: string }>(app.db, "select value from kv where key = ?", `${KEY}:${c.id}`)?.value, {});
  const fresh = c.ids.slice(handed.n ?? 0);
  if (fresh.length) {
    // Folder levels (a knowledge base set to “only searchable”) reach the new pages before deciding what to digest.
    if (one(app.db, "select 1 from source_node_levels where space_id = ? limit 1", c.spaceId)) (await import("../sources/attention.ts")).applyNodeLevels(app, c.spaceId);
    const { scheduleIngest } = await import("../agents/jobs.ts");
    scheduleIngest(app, c.spaceId, fresh, `飞书知识库《${c.rootTitle ?? c.root}》`);
  }
  run(app.db, "insert into kv(key,value) values(?,?) on conflict(key) do update set value = excluded.value", `${KEY}:${c.id}`, JSON.stringify({ n: c.ids.length }));
  if (done)
    notify(app, {
      title: `飞书知识库读取完成：《${c.rootTitle ?? c.root}》`,
      body: `读了 ${c.read} 篇${c.known ? `，${c.known} 篇空间里已有、没再读` : ""}${c.failed ? `，${c.failed} 篇失败` : ""}${c.skipped ? `，${c.skipped} 个页面没读（不是文档、超出层数或总量）` : ""}，已交给整理。`,
      urgency: "silent",
    });
}
