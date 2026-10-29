import type { App } from "../core/app.ts";
import { all } from "../core/db.ts";
import { effectiveLevel, NOTE_ACTIVE_SQL, nodeLevels, scheduleNodeLevels, type Level } from "./attention.ts";

/**
 * Where each original sits: a chain of nodes per kind, so every space can be browsed as a tree and
 * levels can be set on a whole folder (sources/attention.ts). Node keys are stable, titles may change.
 *
 * | kind                         | chain                                                              |
 * |------------------------------|--------------------------------------------------------------------|
 * | code, files with a path      | `dir:<a>` → `dir:<a/b>` → the file                                  |
 * | Feishu knowledge-base docs   | `wiki:<space>` → `wn:<node>` … → `wn:<this doc>` (a doc is a node)  |
 * | Feishu docs outside one      | `lark-drive` → `from:<doc that linked it>` or `lark-drive:direct`  |
 * | chats                        | `chat:<type>` → `chat:<chatId>` → each month; images under `chat:<chatId>:images` |
 * | web pages                    | `site:<host>` → `site:<host>/<first path segment>`                 |
 * | meetings, calendar, minutes  | `kind:<kind>` → year → month                                       |
 * | notes, work files, the rest  | `kind:<kind>` → month                                              |
 *
 * Knowledge-base nodes come from `wiki_nodes` (lark-wiki.ts `recordWikiNodes`), including nodes nobody
 * captured: they show greyed out and can be captured on click. The tree of a space is built in
 * memory from one query and cached until a source of that space changes.
 */

export type NodeKind = "group" | "dir" | "wiki-space" | "wiki-node" | "chat-type" | "chat" | "images" | "site" | "period" | "source";
export type CatalogNode = {
  key: string;
  title: string;
  kind: NodeKind;
  parent: string;
  sourceId?: string;
  /** A knowledge-base node with no copy in this space (shown greyed out). */
  uncaptured?: boolean;
  /** Feishu link to capture an uncaptured node, or to open it. */
  url?: string;
  /** Sort key within the parent (ascending). */
  sort: string;
};
export type CatalogRow = {
  id: string;
  kind: string;
  uri: string;
  title: string;
  updated_at: string;
  captured_at: string;
  attention: string | null;
  attention_by: string | null;
  node_level: string | null;
  node_level_by: string | null;
  hash: string;
  chat_id: string | null;
  chat_kind: string | null;
  month: string | null;
  wiki_node: string | null;
  wiki_space: string | null;
  parent_url: string | null;
  token: string | null;
  url: string | null;
  date: string | null;
};
export type Catalog = {
  spaceId: string;
  nodes: Map<string, CatalogNode>;
  children: Map<string, string[]>;
  /** Source id → its own node key. */
  nodeOf: Map<string, string>;
  rows: Map<string, CatalogRow>;
  builtAt: number;
};

export const ROOT = "";
const CHAT_TYPES: Record<string, string> = { group: "群聊", topic: "话题群", p2p: "单聊", bot: "机器人", other: "其他会话" };
const KIND_GROUPS: Record<string, string> = {
  note: "笔记", work: "工作文件", conversation: "对话", activity: "活动", event: "日程", meeting: "会议与妙记", image: "图片", web: "网页", doc: "文档", code: "代码", chat: "聊天",
};
const DOC_URL = /^https?:\/\/[^/]+\/(docx|wiki|docs)\/([A-Za-z0-9_-]+)/;
const hasScheme = (uri: string) => /^[a-z][a-z\d+.-]*:/i.test(uri) && !/^[a-z]:[\\/]/i.test(uri);
const MONTH = (d: string | null | undefined) => (d && /^\d{4}-\d{2}/.test(d) ? d.slice(0, 7) : "");
/** Sort descending by date: later months first. */
const desc = (s: string) => [...s].map((c) => String.fromCharCode(0xffff - c.charCodeAt(0))).join("");

const caches = new WeakMap<App, Map<string, Catalog>>();
const listening = new WeakSet<App>();

/** Forget cached trees (all spaces, or one); sources that moved in the tree get their folder level again. */
export function catalogChanged(app: App, spaceId?: string) {
  const c = caches.get(app);
  if (spaceId) c?.delete(spaceId);
  else c?.clear();
  scheduleNodeLevels(app, spaceId);
}

/** Follow source changes (once per app): cached trees are dropped, folder levels reach new sources. */
export function watchCatalog(app: App) {
  if (listening.has(app)) return;
  listening.add(app);
  app.events.on("event", (e) => {
    if (e.type === "changed" && (e.entity === "source" || e.entity === "space")) catalogChanged(app, e.entity === "source" ? e.spaceId : undefined);
  });
}

/** The tree of a space, built on first use and cached until its sources change. */
export function catalog(app: App, spaceId: string): Catalog {
  let cache = caches.get(app);
  if (!cache) caches.set(app, (cache = new Map()));
  watchCatalog(app);
  const hit = cache.get(spaceId);
  if (hit && Date.now() - hit.builtAt < 10 * 60_000) return hit;
  const built = buildCatalog(app, spaceId);
  cache.set(spaceId, built);
  return built;
}

export const ROW_SQL = `select id, kind, uri, title, updated_at, captured_at, attention, attention_by, node_level, node_level_by, hash,
  json_extract(meta, '$.chatId') chat_id, coalesce(nullif(json_extract(meta, '$.chatKind'), ''), json_extract(meta, '$.chatMode')) chat_kind,
  json_extract(meta, '$.month') month, json_extract(meta, '$.wikiNodeToken') wiki_node, json_extract(meta, '$.wikiSpaceId') wiki_space,
  json_extract(meta, '$.parentUrl') parent_url, json_extract(meta, '$.token') token, json_extract(meta, '$.url') url,
  coalesce(json_extract(meta, '$.start'), json_extract(meta, '$.date')) date
  from sources`;

type WikiRow = { token: string; wiki_space_id: string | null; parent_token: string | null; title: string; obj_type: string | null; node_type: string | null; has_child: number | null; error: string | null };

export function buildCatalog(app: App, spaceId: string): Catalog {
  // A /wiki/ copy is read first, so it is the node when a /docx/ copy of the same doc exists.
  const rows = all<CatalogRow>(app.db, `${ROW_SQL} where space_id = ? and deleted_at is null order by (uri like '%/wiki/%') desc`, spaceId);
  const wiki = new Map(all<WikiRow>(app.db, "select token, wiki_space_id, parent_token, title, obj_type, node_type, has_child, error from wiki_nodes").map((r) => [r.token, r]));
  const wikiNames = new Map(all<{ id: string; name: string }>(app.db, "select id, name from wiki_spaces").map((r) => [r.id, r.name]));
  const cat: Catalog = { spaceId, nodes: new Map(), children: new Map(), nodeOf: new Map(), rows: new Map(rows.map((r) => [r.id, r])), builtAt: Date.now() };
  const add = (n: Omit<CatalogNode, "sort"> & { sort?: string }) => {
    const have = cat.nodes.get(n.key);
    if (have) {
      // A placeholder first seen as someone's ancestor gets its real place and title later.
      if (n.sourceId && !have.sourceId) Object.assign(have, { sourceId: n.sourceId, title: n.title || have.title, uncaptured: false });
      return have;
    }
    const node: CatalogNode = { ...n, sort: n.sort ?? n.title };
    cat.nodes.set(n.key, node);
    const list = cat.children.get(n.parent);
    if (list) list.push(n.key);
    else cat.children.set(n.parent, [n.key]);
    return node;
  };
  const chain = (parts: { key: string; title: string; kind: NodeKind; sort?: string; url?: string }[]) => {
    let parent = ROOT;
    for (const p of parts) {
      add({ ...p, parent });
      parent = p.key;
    }
    return parent;
  };

  // Chats: the type and the best name of each chat (some archives only have the raw id as title).
  const chats = new Map<string, { type: string; title: string; latest: string }>();
  for (const r of rows) {
    if (r.kind !== "chat" || !r.chat_id) continue;
    const c = chats.get(r.chat_id) ?? { type: "", title: "", latest: "" };
    const t = chatType(r.chat_kind);
    if (!c.type || (c.type === "other" && t !== "other")) c.type = t;
    const name = r.title.replace(/（\d{4}-\d{2}( 历史)?）$/, "").trim();
    if (name && !/^oc_[\w-]+$/.test(name) && (!c.title || r.updated_at > c.latest)) c.title = name;
    if (r.updated_at > c.latest) c.latest = r.updated_at;
    chats.set(r.chat_id, c);
  }
  // Feishu docs by link token (parent links), and the host of each knowledge base (to capture greyed nodes).
  const byToken = new Map<string, CatalogRow>();
  for (const r of rows) {
    if (r.kind !== "doc") continue;
    const m = DOC_URL.exec(r.url ?? r.uri);
    if (m) byToken.set(m[2], r);
    if (r.token) byToken.set(r.token, r);
  }
  const origins = new Map<string, string>();

  const chatChain = (chatId: string) => {
    const c = chats.get(chatId) ?? { type: "other", title: "", latest: "" };
    return [
      { key: `chat:${c.type}`, title: CHAT_TYPES[c.type] ?? c.type, kind: "chat-type" as const, sort: `4${Object.keys(CHAT_TYPES).indexOf(c.type)}` },
      { key: `chat:${chatId}`, title: c.title || chatId, kind: "chat" as const, sort: desc(c.latest) },
    ];
  };
  const wikiChain = (token: string, wsid: string) => {
    const up: WikiRow[] = [];
    const seen = new Set([token]);
    let orphan = false;
    for (let p = wiki.get(token)?.parent_token; p; ) {
      const n = wiki.get(p);
      if (!n || seen.has(p) || up.length > 64) {
        orphan = true;
        break;
      }
      seen.add(p);
      up.push(n);
      p = n.parent_token;
    }
    const top = up.at(-1) ?? wiki.get(token);
    if (top?.error) orphan = true;
    return [
      { key: `wiki:${wsid}`, title: wikiNames.get(wsid) || "知识库", kind: "wiki-space" as const, sort: `1${wikiNames.get(wsid) ?? wsid}` },
      ...(orphan ? [{ key: `wiki:${wsid}:orphan`, title: "（无权限或未读取的上级）", kind: "group" as const, sort: "￿" }] : []),
      ...up.reverse().map((n) => ({ key: `wn:${n.token}`, title: n.title || "（未命名节点）", kind: "wiki-node" as const })),
    ];
  };

  for (const r of rows) {
    const leaf = { key: `src:${r.id}`, title: r.title, kind: "source" as const, sourceId: r.id };
    const month = MONTH(r.date) || MONTH(r.captured_at);
    let parent: string;
    const docUrl = r.kind === "doc" ? DOC_URL.exec(r.url ?? r.uri) : null;
    if (r.kind === "chat" || (r.kind === "image" && /^lark:oc_[\w-]+\//.test(r.uri))) {
      const chatId = r.kind === "chat" ? r.chat_id : r.uri.slice(5, r.uri.indexOf("/"));
      if (!chatId) {
        parent = chain([{ key: "chat:other", title: CHAT_TYPES.other, kind: "chat-type", sort: "49" }]);
        add({ ...leaf, parent });
      } else if (r.kind === "image") {
        parent = chain([...chatChain(chatId), { key: `chat:${chatId}:images`, title: "图片", kind: "images", sort: "￿" }]);
        add({ ...leaf, parent, sort: desc(r.captured_at) });
      } else {
        parent = chain(chatChain(chatId));
        add({ ...leaf, parent, title: r.month ? r.month : "最近", sort: r.month ? `1${desc(r.month)}` : "0" });
      }
    } else if (docUrl) {
      const token = r.wiki_node || (docUrl[1] === "wiki" ? docUrl[2] : "");
      const node = token ? wiki.get(token) : undefined;
      const wsid = node?.wiki_space_id || r.wiki_space || "";
      if (token && wsid) {
        if (!origins.has(wsid)) origins.set(wsid, (r.url ?? r.uri).replace(/^(https?:\/\/[^/]+).*$/, "$1"));
        parent = chain(wikiChain(token, wsid));
        const own = cat.nodes.get(`wn:${token}`);
        // The same node captured twice (a /docx/ and a /wiki/ copy): the second is a plain leaf beside it.
        if (own?.sourceId) add({ ...leaf, parent: own.key });
        else add({ key: `wn:${token}`, title: r.title, kind: "wiki-node", parent, sourceId: r.id });
      } else if (token) {
        parent = chain([{ key: "wiki:?", title: "知识库（位置还没读取）", kind: "group", sort: "2" }]);
        add({ key: `wn:${token}`, title: r.title, kind: "wiki-node", parent, sourceId: r.id });
      } else {
        const from = r.parent_url ? byToken.get(DOC_URL.exec(r.parent_url)?.[2] ?? "") : undefined;
        const group = from && from.id !== r.id
          ? { key: `from:${from.id}`, title: `由《${from.title}》链接`, kind: "group" as const }
          : r.parent_url
            ? { key: "lark-drive:linked", title: "由别处的链接导入", kind: "group" as const, sort: "￿" }
            : { key: "lark-drive:direct", title: "直接导入", kind: "group" as const, sort: "0" };
        parent = chain([{ key: "lark-drive", title: "飞书云文档", kind: "group", sort: "3" }, group]);
        add({ ...leaf, parent });
      }
    } else if (r.kind === "web" || /^https?:\/\//.test(r.uri)) {
      let host = "", seg = "";
      try {
        const u = new URL(r.url ?? r.uri);
        host = u.host;
        seg = u.pathname.split("/").filter(Boolean)[0] ?? "";
      } catch {}
      parent = chain([
        { key: `site:${host || "?"}`, title: host || "网页", kind: "site", sort: `5${host}` },
        ...(seg && seg !== (r.url ?? r.uri).split("/").pop() ? [{ key: `site:${host}/${seg}`, title: decodeSafe(seg), kind: "site" as const }] : []),
      ]);
      add({ ...leaf, parent });
    } else if (r.kind === "event" || r.kind === "meeting") {
      parent = chain([
        { key: `kind:${r.kind}`, title: KIND_GROUPS[r.kind], kind: "group", sort: `6${r.kind}` },
        ...(month ? [
          { key: `kind:${r.kind}:${month.slice(0, 4)}`, title: `${month.slice(0, 4)} 年`, kind: "period" as const, sort: desc(month.slice(0, 4)) },
          { key: `kind:${r.kind}:${month}`, title: `${Number(month.slice(5))} 月`, kind: "period" as const, sort: desc(month) },
        ] : []),
      ]);
      add({ ...leaf, parent, sort: desc(r.date ?? r.captured_at) });
    } else if ((r.kind === "code" || r.kind === "doc") && !hasScheme(r.uri) && /[\\/]/.test(r.uri)) {
      const parts = r.uri.replace(/\\/g, "/").split("/").filter(Boolean);
      parent = chain(parts.slice(0, -1).map((p, i) => ({ key: `dir:${parts.slice(0, i + 1).join("/")}`, title: p, kind: "dir" as const, sort: `0${p}` })));
      add({ ...leaf, parent, title: parts.at(-1) ?? r.title, sort: `1${parts.at(-1)}` });
    } else {
      const kind = r.kind;
      parent = chain([
        { key: `kind:${kind}`, title: KIND_GROUPS[kind] ?? kind, kind: "group", sort: `7${kind}` },
        ...(month && ["note", "work", "conversation", "activity", "image"].includes(kind) ? [{ key: `kind:${kind}:${month}`, title: month, kind: "period" as const, sort: desc(month) }] : []),
      ]);
      add({ ...leaf, parent, sort: kind === "doc" ? r.title : desc(r.updated_at) });
    }
  }
  for (const n of cat.nodes.values()) if (n.sourceId) cat.nodeOf.set(n.sourceId, n.key);

  // Knowledge-base nodes nobody captured, below captured ones or at the top of a knowledge base in this tree.
  for (let round = 0, grew = true; grew && round < 64; round++) {
    grew = false;
    for (const n of wiki.values()) {
      if (cat.nodes.has(`wn:${n.token}`) || !n.wiki_space_id) continue;
      const parent = n.parent_token ? `wn:${n.parent_token}` : `wiki:${n.wiki_space_id}`;
      if (!cat.nodes.has(parent)) continue;
      const origin = origins.get(n.wiki_space_id);
      add({ key: `wn:${n.token}`, title: n.title || "（未命名节点）", kind: "wiki-node", parent, uncaptured: true, ...(origin ? { url: `${origin}/wiki/${n.token}` } : {}) });
      grew = true;
    }
  }
  for (const [key, list] of cat.children) {
    list.sort((a, b) => {
      const x = cat.nodes.get(a)!, y = cat.nodes.get(b)!;
      return x.sort < y.sort ? -1 : x.sort > y.sort ? 1 : x.title.localeCompare(y.title, "zh");
    });
    cat.children.set(key, list);
  }
  return cat;
}

function chatType(kind: string | null) {
  return kind && CHAT_TYPES[kind] ? kind : kind ? "other" : "group";
}
function decodeSafe(s: string) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Every source below a node (the node's own source included). */
export function sourcesUnder(cat: Catalog, key: string): string[] {
  const out: string[] = [];
  const stack = [key];
  while (stack.length) {
    const k = stack.pop()!;
    const n = cat.nodes.get(k);
    if (n?.sourceId) out.push(n.sourceId);
    for (const c of cat.children.get(k) ?? []) stack.push(c);
  }
  return out;
}

/** The chain of node keys from the top down to a source's own node. */
export function chainOf(cat: Catalog, sourceId: string): string[] {
  const out: string[] = [];
  for (let k = cat.nodeOf.get(sourceId); k; k = cat.nodes.get(k)?.parent) out.unshift(k);
  return out;
}

/** Readable path of a node (“知识库 / 目录 / 文档”). */
export function nodePath(cat: Catalog, key: string): string {
  const out: string[] = [];
  for (let k: string | undefined = key; k; k = cat.nodes.get(k)?.parent) out.unshift(cat.nodes.get(k)?.title ?? k);
  return out.join(" / ");
}

// ---- one level of the tree, with counts --------------------------------------------------------

export type TreeFilter = { kind?: string; level?: string; q?: string };
export type TreeEntry = {
  key: string;
  title: string;
  kind: NodeKind;
  sourceId?: string;
  sourceKind?: string;
  /** Sources at or below this node (after the filter). */
  count: number;
  /** Of those, how many have each effective level. */
  levels: Record<Level, number>;
  /** Annotations on sources below. */
  notes: number;
  hasChildren: boolean;
  /** The level set on this node itself (folder level), or the source's own level for a source. */
  level?: { level: Level; by: string | null; status?: string; inherited?: boolean };
  uncaptured?: boolean;
  url?: string;
  updatedAt?: string;
};

const emptyLevels = (): Record<Level, number> => ({ focus: 0, normal: 0, reference: 0, ignore: 0 });

/** The children of a node (ROOT for the top), with counts under the filter; nodes with nothing left are dropped while filtering. */
export function treeChildren(app: App, spaceId: string, key: string, f: TreeFilter = {}) {
  const cat = catalog(app, spaceId);
  if (key !== ROOT && !cat.nodes.has(key)) return { path: [], nodes: [] as TreeEntry[], total: 0 };
  const filtering = !!(f.kind || f.level || f.q);
  const q = f.q?.toLowerCase();
  const notes = new Map(all<{ source_id: string; n: number }>(app.db, `select n.source_id, count(*) n from source_notes n join sources s on s.id = n.source_id
    where s.space_id = ? and s.deleted_at is null and ${NOTE_ACTIVE_SQL("n")} group by 1`, spaceId).map((r) => [r.source_id, r.n]));
  const stats = new Map<string, { count: number; levels: Record<Level, number>; notes: number }>();
  for (const r of cat.rows.values()) {
    const eff = effectiveLevel(r).level;
    if (f.kind && r.kind !== f.kind) continue;
    if (f.level && eff !== f.level) continue;
    if (q && !r.title.toLowerCase().includes(q) && !r.uri.toLowerCase().includes(q)) continue;
    const n = notes.get(r.id) ?? 0;
    for (let k: string | undefined = cat.nodeOf.get(r.id); k !== undefined; k = k === ROOT ? undefined : (cat.nodes.get(k)?.parent ?? ROOT)) {
      let s = stats.get(k);
      if (!s) stats.set(k, (s = { count: 0, levels: emptyLevels(), notes: 0 }));
      s.count++;
      s.levels[eff]++;
      s.notes += n;
    }
  }
  const levels = new Map(nodeLevels(app, spaceId, { all: true }).map((l) => [l.key, l]));
  const visible = (k: string) => (filtering ? (stats.get(k)?.count ?? 0) > 0 : true);
  const nodes: TreeEntry[] = [];
  for (const k of cat.children.get(key) ?? []) {
    if (!visible(k)) continue;
    const n = cat.nodes.get(k)!;
    const s = stats.get(k) ?? { count: 0, levels: emptyLevels(), notes: 0 };
    const row = n.sourceId ? cat.rows.get(n.sourceId) : undefined;
    const set = levels.get(k);
    const own = row ? effectiveLevel(row) : undefined;
    nodes.push({
      key: k,
      title: n.title,
      kind: n.kind,
      ...(n.sourceId ? { sourceId: n.sourceId, sourceKind: row?.kind, updatedAt: row?.updated_at } : {}),
      count: s.count,
      levels: s.levels,
      notes: s.notes,
      hasChildren: (cat.children.get(k) ?? []).some(visible),
      ...(set ? { level: { level: set.level, by: set.by, status: set.status } } : own && own.level !== "normal" ? { level: { level: own.level, by: own.by, inherited: own.inherited } } : {}),
      ...(n.uncaptured ? { uncaptured: true } : {}),
      ...(n.url ? { url: n.url } : {}),
    });
  }
  const path: { key: string; title: string }[] = [];
  for (let k: string | undefined = key; k; k = cat.nodes.get(k)?.parent) path.unshift({ key: k, title: cat.nodes.get(k)!.title });
  return { path, nodes, total: stats.get(ROOT)?.count ?? 0 };
}
