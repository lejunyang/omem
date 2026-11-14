import type { App } from "../core/app.ts";
import { all, one, run, tx } from "../core/db.ts";
import { findSpace } from "../core/spaces.ts";
import { accessibleSpaces, OWNER } from "../core/users.ts";
import { HttpError, now } from "../core/util.ts";
import { moveSource } from "./archive.ts";
import { catalogChanged } from "./catalog.ts";
import { mergeSources } from "./duplicates.ts";

/**
 * Where a Feishu knowledge-base document lives. The owner files a knowledge base under a space
 * (lark-knowledge.ts `applyMapping`); that is where its documents go, whichever way they came in —
 * the nightly reading, a link followed from another document, a link in a chat, a document the owner
 * opened lately. A directory can be filed under another space (`wiki_node_homes`: it and everything
 * below it); a document the owner moved by hand stays where they put it.
 *
 * One document, one place: a page of another space cites it across spaces (the spaces are related, or
 * the reader can read both), it is not copied there.
 *
 * Knowledge bases filed under a personal space have no such home: what sits in the owner's own
 * library is distributed by content (the archivist, src/sources/homing.ts), not pulled back.
 */

/** The route reason upsertSource records for a source stored without automatic routing. */
export const IMPORTED = "导入时指定空间";

type WikiMeta = { wikiSpaceId?: unknown; wikiNodeToken?: unknown; wikiParentNodeToken?: unknown };
export type KbHome = { space: string; why: string; kb: string; dir?: string };

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
const isHome = (app: App, space: string | null | undefined) => {
  const s = space ? findSpace(app, space) : null;
  return !!s && s.kind !== "personal" && s.kind !== "worktree" && s.kind !== "repo";
};

/** The nearest directory above (or at) a node that the owner filed under a space of its own. */
function dirHome(app: App, node: string | undefined, parent: string | undefined) {
  const seen = new Set<string>();
  let at = node ?? parent;
  // The document's own parent, for a node the tree has not recorded yet.
  let fallback = node ? parent : undefined;
  while (at && !seen.has(at) && seen.size < 40) {
    seen.add(at);
    const h = one<{ space_id: string; title: string }>(app.db, "select h.space_id, coalesce(n.title, '') title from wiki_node_homes h left join wiki_nodes n on n.token = h.token where h.token = ?", at);
    if (h) return { token: at, space: h.space_id, title: h.title };
    at = one<{ parent_token: string | null }>(app.db, "select parent_token from wiki_nodes where token = ?", at)?.parent_token ?? fallback;
    fallback = undefined;
  }
  return null;
}

/** The space a knowledge-base document belongs in, or null when its knowledge base is not filed under a business space. */
export function kbHome(app: App, meta: WikiMeta | null | undefined): KbHome | null {
  const kbId = str(meta?.wikiSpaceId);
  if (!kbId) return null;
  const kb = one<{ name: string; status: string; target_space: string | null }>(app.db, "select name, status, target_space from wiki_spaces where id = ?", kbId);
  const hasDirs = !!one(app.db, "select 1 from wiki_node_homes where wiki_space_id = ? limit 1", kbId);
  const dir = hasDirs ? dirHome(app, str(meta?.wikiNodeToken), str(meta?.wikiParentNodeToken)) : null;
  if (dir && isHome(app, dir.space)) return { space: dir.space, kb: kbId, dir: dir.token, why: `所在的知识库目录「${dir.title || dir.token}」归入这个空间` };
  if (kb?.status !== "mapped" || !isHome(app, kb.target_space)) return null;
  return { space: kb.target_space!, kb: kbId, why: `所在的飞书知识库《${kb.name || kbId}》归入这个空间` };
}

/**
 * The home of a document being captured into `askedSpace` (by `actingUser`, when someone other than the
 * owner captures): none when that would take it out of a member's own personal space, or into a space
 * the capturing member cannot read — their copy stays where they can see it.
 */
export function kbHomeFor(app: App, meta: WikiMeta | null | undefined, askedSpace: string, actingUser?: string | null): KbHome | null {
  const home = kbHome(app, meta);
  if (!home || home.space === askedSpace) return home;
  const asked = one<{ kind: string; owner_id: string | null }>(app.db, "select kind, owner_id from spaces where id = ?", askedSpace);
  if (asked?.kind === "personal" && asked.owner_id && asked.owner_id !== OWNER) return null;
  if (actingUser && actingUser !== OWNER && !(accessibleSpaces(app, actingUser) ?? [home.space]).includes(home.space)) return null;
  return home;
}

/** The owner put this source where it is by hand (a move, an undone move): it stays. */
export function pinned(route: { mode: string; reason: string } | null | undefined) {
  return route?.mode === "manual" && route.reason !== IMPORTED;
}

/** After a document was stored in its knowledge base's space instead of the one asked for: say why, and let the asking space find it. */
export function noteKbRoute(app: App, id: string, askedSpace: string, uri: string, home: KbHome) {
  run(app.db, `insert into source_routes(source_id,origin_space,mode,reason,decision_hash,pending) values(?,?,'binding',?,(select hash from sources where id = ?),0)
    on conflict(source_id) do update set mode='binding', reason=excluded.reason, pending=0 where source_routes.mode != 'manual' or source_routes.reason = ?`, id, askedSpace, home.why, id, IMPORTED);
  if (askedSpace !== home.space) run(app.db, "insert or ignore into source_locations(origin_space,uri,source_id) values(?,?,?)", askedSpace, uri, id);
}

// ---- a directory filed under another space ----------------------------------------------

export function listDirHomes(app: App) {
  return all<{ token: string; wiki_space_id: string | null; space_id: string; title: string; kb: string; at: string }>(app.db,
    `select h.token, h.wiki_space_id, h.space_id, coalesce(n.title, '') title, coalesce(w.name, '') kb, h.at
       from wiki_node_homes h left join wiki_nodes n on n.token = h.token left join wiki_spaces w on w.id = h.wiki_space_id order by h.at desc`)
    .map((r) => ({ token: r.token, kb: r.wiki_space_id, kbName: r.kb, title: r.title, space: r.space_id, at: r.at }));
}

/** File a knowledge-base directory (and what is below it) under a space; null: back to its knowledge base's space. */
export function setDirHome(app: App, token: string, space: string | null, by = "owner") {
  const node = one<{ wiki_space_id: string | null }>(app.db, "select wiki_space_id from wiki_nodes where token = ?", token);
  if (!node) throw new HttpError(404, "没有这个知识库目录");
  if (space === null) {
    run(app.db, "delete from wiki_node_homes where token = ?", token);
    return listDirHomes(app);
  }
  if (!isHome(app, space)) throw new HttpError(400, "目录只能归到业务空间（不是个人空间、代码仓库或临时工作区）");
  run(app.db, "insert into wiki_node_homes(token, wiki_space_id, space_id, by, at) values(?,?,?,?,?) on conflict(token) do update set space_id = excluded.space_id, by = excluded.by, at = excluded.at", token, node.wiki_space_id, space, by, now());
  return listDirHomes(app);
}

// ---- documents that are somewhere else ---------------------------------------------------

export type Stray = { id: string; title: string; from: string; to: string; kb: string; action: "move" | "merge" | "keep"; into?: string; why: string };

type Row = { id: string; space_id: string; uri: string; title: string; kb: string; node: string | null; parent: string | null; doc: string | null; mode: string | null; reason: string | null };

/** Homes of a knowledge base's documents, with the parent chain read once (only where a directory has its own home). */
function homeResolver(app: App) {
  const kbs = new Map(all<{ id: string; name: string; target_space: string | null }>(app.db, "select id, name, target_space from wiki_spaces where status = 'mapped'").map((k) => [k.id, k]));
  const dirs = new Map(all<{ token: string; wiki_space_id: string | null; space_id: string }>(app.db, "select token, wiki_space_id, space_id from wiki_node_homes").map((d) => [d.token, d]));
  const withDirs = new Set([...dirs.values()].map((d) => d.wiki_space_id));
  const parents = new Map<string, string | null>();
  for (const kb of withDirs) if (kb) for (const n of all<{ token: string; parent_token: string | null }>(app.db, "select token, parent_token from wiki_nodes where wiki_space_id = ?", kb)) parents.set(n.token, n.parent_token);
  const ok = new Map<string, boolean>();
  const home = (space: string | null | undefined) => (space ? ok.get(space) ?? ok.set(space, isHome(app, space)).get(space)! : false);
  return (r: Pick<Row, "kb" | "node" | "parent">): { space: string; why: string } | null => {
    if (withDirs.has(r.kb)) {
      let at = r.node ?? r.parent;
      for (let i = 0; at && i < 40; i++) {
        const d = dirs.get(at);
        if (d && home(d.space_id)) return { space: d.space_id, why: "所在的知识库目录归入这个空间" };
        at = parents.get(at) ?? (at === r.node ? r.parent : null);
      }
    }
    const kb = kbs.get(r.kb);
    return kb && home(kb.target_space) ? { space: kb.target_space!, why: `所在的飞书知识库《${kb.name || r.kb}》归入这个空间` } : null;
  };
}

function rows(app: App, kb?: string) {
  return all<Row>(app.db,
    `select s.id, s.space_id, s.uri, s.title, json_extract(s.meta, '$.wikiSpaceId') kb, json_extract(s.meta, '$.wikiNodeToken') node,
            json_extract(s.meta, '$.wikiParentNodeToken') parent, json_extract(s.meta, '$.documentId') doc, r.mode, r.reason
       from sources s left join source_routes r on r.source_id = s.id
      where s.kind = 'doc' and s.deleted_at is null and json_extract(s.meta, '$.wikiSpaceId') ${kb ? "= ?" : "is not null"}`, ...(kb ? [kb] : []));
}

/**
 * Documents of filed knowledge bases that sit in another space, and what bringing them home would do:
 * move, merge into the copy already there (the same node or document), or keep (the owner put it there).
 */
export function kbStrays(app: App, opts: { kb?: string } = {}): Stray[] {
  const resolve = homeResolver(app);
  const list = rows(app, opts.kb);
  // The copy at home, by node and by document.
  const atHome = new Map<string, string>();
  const homes = new Map<string, { space: string; why: string } | null>();
  for (const r of list) {
    const h = resolve(r);
    homes.set(r.id, h);
    if (!h || h.space !== r.space_id) continue;
    if (r.node) atHome.set(`${h.space}|n:${r.node}`, r.id);
    if (r.doc) atHome.set(`${h.space}|d:${r.doc}`, r.id);
    atHome.set(`${h.space}|u:${r.uri}`, r.id);
  }
  // A member's own personal space keeps what the member captured there.
  const theirs = new Set(all<{ id: string }>(app.db, "select id from spaces where kind = 'personal' and owner_id is not null and owner_id != ?", OWNER).map((s) => s.id));
  const out: Stray[] = [];
  for (const r of list) {
    const h = homes.get(r.id);
    if (!h || h.space === r.space_id || theirs.has(r.space_id)) continue;
    const base = { id: r.id, title: r.title, from: r.space_id, to: h.space, kb: r.kb };
    if (pinned(r.mode ? { mode: r.mode, reason: r.reason ?? "" } : null)) {
      out.push({ ...base, action: "keep", why: `本人放在这里的（${r.reason}）` });
      continue;
    }
    const into = (r.node && atHome.get(`${h.space}|n:${r.node}`)) || (r.doc && atHome.get(`${h.space}|d:${r.doc}`)) || atHome.get(`${h.space}|u:${r.uri}`);
    out.push(into ? { ...base, action: "merge", into, why: `${h.why}，那里已有这篇` } : { ...base, action: "move", why: h.why });
  }
  return out;
}

/** Per knowledge base: how many of its documents sit outside its space, and where. */
export function kbStrayCounts(app: App) {
  const by = new Map<string, { away: number; kept: number; spaces: Record<string, number> }>();
  for (const s of kbStrays(app)) {
    const e = by.get(s.kb) ?? by.set(s.kb, { away: 0, kept: 0, spaces: {} }).get(s.kb)!;
    if (s.action === "keep") e.kept++;
    else {
      e.away++;
      e.spaces[s.from] = (e.spaces[s.from] ?? 0) + 1;
    }
  }
  return by;
}

export type RehomeReport = { dryRun: boolean; moved: number; merged: number; kept: number; failed: { id: string; title: string; error: string }[]; bySpace: Record<string, number>; sample: Stray[] };

/**
 * Bring the documents of filed knowledge bases home (all, or one knowledge base). `dryRun` (the
 * default) only lists. Ids, chunks, notes and citations stay (moveSource); a document already at home
 * absorbs the stray copy, whose id keeps resolving (source_aliases). Yields to the event loop as it goes.
 */
export async function rehomeKb(app: App, opts: { kb?: string; dryRun?: boolean; limit?: number } = {}): Promise<RehomeReport> {
  const strays = kbStrays(app, { kb: opts.kb });
  const todo = strays.filter((s) => s.action !== "keep").slice(0, opts.limit ?? 5000);
  const bySpace: Record<string, number> = {};
  for (const s of todo) bySpace[s.from] = (bySpace[s.from] ?? 0) + 1;
  const report: RehomeReport = { dryRun: opts.dryRun !== false, moved: 0, merged: 0, kept: strays.length - strays.filter((s) => s.action !== "keep").length, failed: [], bySpace, sample: todo.slice(0, 50) };
  if (report.dryRun) {
    report.moved = todo.filter((s) => s.action === "move").length;
    report.merged = todo.length - report.moved;
    return report;
  }
  let t = Date.now();
  for (const s of todo) {
    try {
      if (s.action === "merge") {
        tx(app.db, () => mergeSources(app, s.id, s.into!, "kb-home"));
        report.merged++;
      } else {
        try {
          moveSource(app, s.id, s.to, s.why, "binding");
          report.moved++;
        } catch (e) {
          // The address is taken there by a copy that carries no knowledge-base position: that one absorbs it.
          const there = (e as HttpError).status === 409 ? one<{ id: string }>(app.db, "select t.id from sources t join sources s on s.uri = t.uri where s.id = ? and t.space_id = ? and t.deleted_at is null", s.id, s.to) : undefined;
          if (!there) throw e;
          tx(app.db, () => mergeSources(app, s.id, there.id, "kb-home"));
          report.merged++;
        }
      }
    } catch (e) {
      report.failed.push({ id: s.id, title: s.title, error: (e as Error).message.slice(0, 200) });
    }
    if (Date.now() - t > 30) {
      await new Promise((r) => setImmediate(r));
      t = Date.now();
    }
  }
  if (report.moved || report.merged) {
    catalogChanged(app);
    console.log(`[omem] 知识库归位：移动 ${report.moved} 份，合并 ${report.merged} 份${report.failed.length ? `，${report.failed.length} 份没成` : ""}`);
  }
  return report;
}
