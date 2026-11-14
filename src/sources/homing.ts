import { performance } from "node:perf_hooks";
import type { App } from "../core/app.ts";
import { chatBinding } from "../core/capture-space.ts";
import { all, one, run, tx } from "../core/db.ts";
import { findSpace } from "../core/spaces.ts";
import { OWNER } from "../core/users.ts";
import { HttpError, json, now, sha256 } from "../core/util.ts";
import { lineRoot } from "../agents/home.ts";
import { scopeOf } from "../agents/run-scope.ts";
import { listArchiveRules, moveSource, prepareArchive, queueArchive, REJUDGE, sourceRoute } from "./archive.ts";
import { backfillDocLinks, chatsLinking, docLinksComplete, docTokens } from "./doc-links.ts";
import { getSource, sourceText } from "./store.ts";
import { moveWorkFile } from "./work.ts";

/**
 * Material leaving the owner's personal space (docs/v2/archive-routing.md). The host gathers facts
 * about where a source belongs — where it sits in a Feishu knowledge base and where its siblings went,
 * which chats linked it, which pages, items and memories of other spaces cite it, what the owner
 * marked it — and hands them to the archivist with the source; the archivist decides. A source the
 * archivist kept is judged again when new facts appear (a business page cites it, its folder's
 * documents were filed, a space or an archive rule changed), a few each night. Working files follow
 * the item or rule they belong to. Every move is recorded with its facts and can be undone; undoing
 * pins the source where the owner put it.
 *
 * Libraries are large (tens of thousands of sources, hundreds of thousands of messages) and all of
 * this runs on the server's one event loop: nothing here queries per source in a loop over the whole
 * library. The check builds its maps in a few set queries, computes in memory, and yields to the
 * event loop every few tens of milliseconds (`yielder`); it runs one at a time, in the background,
 * under a time limit, and picks up where it stopped next time (§7 of the design).
 */

/** The owner's personal spaces: what is filed out of. Other people's personal spaces are theirs. */
export function homeSpaces(app: App): string[] {
  return all<{ id: string }>(app.db, "select id from spaces where kind = 'personal' and owner_id = ?", OWNER).map((r) => r.id);
}
/** Spaces material may be filed into: not personal, not a delegation's temporary index. */
function businessSpaces(app: App) {
  return all<{ id: string }>(app.db, "select id from spaces where kind not in ('personal', 'worktree')").map((r) => r.id);
}
const placeholders = (n: number) => Array(n).fill("?").join(",") || "''";
const NOT_ARCHIVED = ["code", "conversation", "activity", "work"];
const chunks = <T>(xs: T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, (i + 1) * n));

/** Gives the event loop a turn whenever `sliceMs` of synchronous work has gone by since the last one. */
export function yielder(sliceMs = 30) {
  let t = performance.now();
  return async () => {
    if (performance.now() - t < sliceMs) return;
    await new Promise((r) => setImmediate(r));
    t = performance.now();
  };
}

// ---- evidence -------------------------------------------------------------------

export type Evidence = {
  /** Where it sits in a Feishu knowledge base; `kbSpace`: the space the owner filed that knowledge base under. */
  wiki?: { kb?: string; path?: string; parent?: string; kbSpace?: string };
  /** Other documents of the same knowledge-base folder, by the space they are in now. */
  siblings?: { space: string; n: number }[];
  /** Pages, items and memories of other spaces that cite it. */
  citedBy?: { space: string; pages?: string[]; items?: string[]; memories?: number }[];
  /** Captured chats whose messages link it, and the space each chat is bound to or kept in. */
  linkedIn?: { chat: string; title: string; space: string | null; bound: boolean; messages: number }[];
  /** The level set on it by hand (focus, reference, ignore…), not by a rule or a folder. */
  attention?: { level: string; by: string | null };
  /** A working file: the item or rule it belongs to and that one's space. */
  belongsTo?: { kind: "item" | "rule"; id: string; title: string; space: string };
};

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
/** `src:<id>#L…` → id. */
const refId = (ref: unknown) => (typeof ref === "string" && ref.startsWith("src:") ? ref.slice(4).split("#")[0] : undefined);

/** For a set of sources: who cites them, by space (pages, items, memories; ids of merged duplicates count). */
function citationsFor(app: App, ids: string[]) {
  const out = new Map<string, Map<string, { pages: string[]; items: string[]; memories: number }>>();
  if (!ids.length) return out;
  const owner = new Map<string, string>(ids.map((id) => [id, id]));
  for (const part of chunks(ids, 500))
    for (const a of all<{ alias_id: string; source_id: string }>(app.db, `select alias_id, source_id from source_aliases where source_id in (${placeholders(part.length)})`, ...part)) owner.set(a.alias_id, a.source_id);
  const at = (id: string, space: string) => {
    const bySpace = out.get(id) ?? out.set(id, new Map()).get(id)!;
    return bySpace.get(space) ?? bySpace.set(space, { pages: [], items: [], memories: 0 }).get(space)!;
  };
  const all_ = [...owner.keys()];
  for (const part of chunks(all_, 500)) {
    for (const r of all<{ source_id: string; space_id: string; slug: string }>(app.db,
      `select distinct pc.source_id, p.space_id, p.slug from page_cites pc join pages p on p.id = pc.page_id where pc.source_id in (${placeholders(part.length)})`, ...part)) {
      const e = at(owner.get(r.source_id)!, r.space_id);
      if (!e.pages.includes(r.slug)) e.pages.push(r.slug);
    }
    for (const r of all<{ ref: string; space_id: string; title: string }>(app.db,
      `select m.ref, i.space_id, i.title from item_materials m join items i on i.id = m.item_id where m.kind = 'source' and i.status != 'cancelled' and m.ref in (${placeholders(part.length)})`, ...part))
      at(owner.get(r.ref)!, r.space_id).items.push(r.title);
  }
  // Items and memories keep their citations in a JSON list: one pass over the rows that have any.
  for (const r of all<{ space_id: string; title: string; source_refs: string }>(app.db, "select space_id, title, source_refs from items where source_refs != '[]' and status != 'cancelled'"))
    for (const id of new Set(json<unknown[]>(r.source_refs, []).map(refId))) if (id && owner.has(id)) at(owner.get(id)!, r.space_id).items.push(r.title);
  for (const r of all<{ space_id: string; source_refs: string }>(app.db, "select space_id, source_refs from memories where status = 'active' and source_refs != '[]'"))
    for (const id of new Set(json<unknown[]>(r.source_refs, []).map(refId))) if (id && owner.has(id)) at(owner.get(id)!, r.space_id).memories++;
  return out;
}

function kbSpace(app: App, wikiSpaceId: string | undefined) {
  if (!wikiSpaceId) return undefined;
  const kb = one<{ status: string; target_space: string | null }>(app.db, "select status, target_space from wiki_spaces where id = ?", wikiSpaceId);
  return kb?.status === "mapped" && kb.target_space ? kb.target_space : undefined;
}

/** A Feishu document's token in its address (docx / wiki / sheets …), to find the messages that link it. */
export function docToken(uri: string, meta: Record<string, unknown>) {
  return docTokens(uri)[0] ?? str(meta.documentId) ?? str(meta.token);
}

function belongsTo(app: App, meta: Record<string, unknown>): Evidence["belongsTo"] {
  const links = (meta.links ?? {}) as { item?: string; rule?: string };
  if (links.item) {
    const i = one<{ space_id: string; title: string }>(app.db, "select space_id, title from items where id = ?", links.item);
    if (i) return { kind: "item", id: links.item, title: i.title, space: i.space_id };
  }
  if (links.rule) {
    const r = one<{ space_id: string | null; name: string }>(app.db, "select space_id, name from rules where id = ?", links.rule);
    if (r?.space_id) return { kind: "rule", id: links.rule, title: r.name, space: r.space_id };
  }
  return undefined;
}

/**
 * The facts the host knows about where these sources belong (nothing judged; empty parts left out).
 * Per source only indexed lookups; citations in items and memories are one pass for the whole set.
 */
export function archiveEvidenceFor(app: App, ids: string[]): Map<string, Evidence> {
  const cited = citationsFor(app, ids);
  const out = new Map<string, Evidence>();
  for (const id of ids) {
    const s = getSource(app, id);
    const meta = s.meta as Record<string, unknown>;
    const e: Evidence = {};
    if (meta.wikiSpaceName || meta.wikiPath || meta.wikiSpaceId) {
      const mapped = kbSpace(app, str(meta.wikiSpaceId));
      e.wiki = { kb: str(meta.wikiSpaceName), path: str(meta.wikiPath), parent: str(meta.wikiParentTitle), ...(mapped ? { kbSpace: mapped } : {}) };
    }
    const parent = str(meta.wikiParentNodeToken);
    if (parent) {
      // sources_wiki_parent (expression index).
      const sib = all<{ space: string; n: number }>(app.db,
        "select space_id space, count(*) n from sources where json_extract(meta, '$.wikiParentNodeToken') = ? and deleted_at is null and id != ? group by space_id order by n desc limit 8", parent, id);
      if (sib.length) e.siblings = sib;
    }
    const c = [...(cited.get(id) ?? [])].filter(([space]) => space !== s.spaceId)
      .map(([space, v]) => ({ space, ...(v.pages.length ? { pages: v.pages.slice(0, 5) } : {}), ...(v.items.length ? { items: [...new Set(v.items)].slice(0, 5) } : {}), ...(v.memories ? { memories: v.memories } : {}) }));
    if (c.length) e.citedBy = c;
    const token = docToken(s.uri, meta);
    // lark_doc_links (src/sources/doc-links.ts), not a scan of the messages.
    const chats = token ? chatsLinking(app, token).map((r) => {
      const bound = chatBinding(app, r.chat_id);
      const chat = one<{ space_id: string; title: string }>(app.db, "select s.space_id, s.title from lark_messages m join sources s on s.id = m.source_id where m.chat_id = ? and m.source_id is not null limit 1", r.chat_id);
      return { chat: r.chat_id, title: chat?.title ?? r.chat_id, space: bound ?? chat?.space_id ?? null, bound: !!bound, messages: r.n };
    }) : [];
    if (chats.length) e.linkedIn = chats;
    if (s.level && !s.level.inherited && s.level.by) e.attention = { level: s.level.level, by: s.level.by };
    const owner = s.kind === "work" ? belongsTo(app, meta) : undefined;
    if (owner) e.belongsTo = owner;
    out.set(id, e);
  }
  return out;
}
export function archiveEvidence(app: App, id: string): Evidence {
  return archiveEvidenceFor(app, [id]).get(id)!;
}

/**
 * The cheap part of the evidence, as a fingerprint: the other spaces citing it, the spaces its
 * folder's documents went to, the space its knowledge base is filed under. A source is judged
 * again only when this changed since it was last judged ("" when nothing points elsewhere).
 * The nightly check computes the same thing from its maps (fingerprintOf).
 */
function fingerprintOf(own: string, homes: Set<string>, cites: Iterable<string>, sib: Iterable<string>, kb: string | undefined) {
  const away = (xs: Iterable<string>) => [...new Set(xs)].filter((x) => !homes.has(x) && x !== own).sort();
  const c = away(cites);
  const s = away(sib);
  const k = away(kb ? [kb] : []);
  if (!c.length && !s.length && !k.length) return "";
  return JSON.stringify({ cites: c, sib: s, kb: k });
}
export function evidenceFingerprint(app: App, id: string, e: Evidence = archiveEvidence(app, id)): string {
  const s = getSource(app, id);
  return fingerprintOf(s.spaceId, new Set(homeSpaces(app)), (e.citedBy ?? []).map((c) => c.space), (e.siblings ?? []).map((x) => x.space), e.wiki?.kbSpace);
}
/** Recorded when the archivist is handed a source: what it was judged with. */
export function noteJudged(app: App, id: string, e?: Evidence) {
  run(app.db, "insert into archive_evidence(source_id, fingerprint, at) values(?,?,?) on conflict(source_id) do update set fingerprint = excluded.fingerprint, at = excluded.at", id, evidenceFingerprint(app, id, e), now());
}

// ---- the queue ------------------------------------------------------------------

/** Priorities: lower first. */
export const PRIORITY = { unreachable: 0, citedByPage: 0, cited: 1, knowledgeBase: 1, siblings: 2, context: 3 } as const;

/** Sources in the owner's personal spaces that the archivist may judge again (not pinned by hand, a binding or a rule). */
function eligibleSql(homes: string[], alias = "s") {
  return `${alias}.deleted_at is null and ${alias}.space_id in (${placeholders(homes.length)}) and ${alias}.kind not in (${NOT_ARCHIVED.map((k) => `'${k}'`).join(",")})
    and not (${alias}.kind = 'chat' and coalesce(json_extract(${alias}.meta, '$.chatKind'), json_extract(${alias}.meta, '$.chatMode'), '') = 'p2p')
    and not exists (select 1 from source_routes r where r.source_id = ${alias}.id and (r.mode in ('manual', 'binding', 'rule') or r.pending = 1))`;
}
export function isEligible(app: App, id: string) {
  const homes = homeSpaces(app);
  return !!homes.length && !!one(app.db, `select 1 from sources s where s.id = ? and ${eligibleSql(homes)}`, id, ...homes);
}

const QUEUE_SQL = `insert into archive_recheck(source_id, reason, priority, queued_at) values(?,?,?,?)
  on conflict(source_id) do update set reason = case when excluded.priority < archive_recheck.priority then excluded.reason else archive_recheck.reason end,
    priority = min(archive_recheck.priority, excluded.priority)`;
/** Put sources in the queue (an earlier, more urgent entry stays). Returns how many are queued now. */
export function queueRecheck(app: App, ids: string[], reason: string, priority: number) {
  let n = 0;
  for (const id of new Set(ids)) {
    if (!isEligible(app, id)) continue;
    run(app.db, QUEUE_SQL, id, reason, priority, now());
    n++;
  }
  return n;
}

/** What the spaces and enabled archive rules say now: a change means everything kept may be judged differently. */
function contextHash(app: App) {
  const spaces = all(app.db, "select id, name, description, parent_id from spaces where kind not in ('personal', 'worktree') order by id");
  const rules = listArchiveRules(app).filter((r) => r.enabled).map((r) => ({ t: r.target, c: r.conditions }));
  return sha256(JSON.stringify({ spaces, rules }));
}

type Clock = { tick: () => Promise<void>; over: () => boolean; progress: (phase: string, done: number, total: number) => void };
const PAGE = 1000;

/** Rows of `sql` (which ends in `rowid > ? order by rowid limit ?` and selects `rowid`), a page at a time, yielding between pages. */
async function scan<T extends { rowid: number }>(app: App, clock: Clock, sql: string, params: unknown[], each: (r: T) => void) {
  let after = 0;
  for (;;) {
    const rows = all<T>(app.db, sql, ...(params as string[]), after, PAGE);
    for (const r of rows) each(r);
    await clock.tick();
    if (rows.length < PAGE) return;
    after = rows.at(-1)!.rowid;
  }
}

/**
 * Find sources with new evidence and queue them. The maps (who cites what from which space, where
 * each folder's documents went, where each knowledge base is filed) are built with a few paged set
 * queries; each kept source's fingerprint is then computed in memory and compared with the one it
 * was last judged with. A change of spaces or rules queues everything kept, last in line (the first
 * check only records the state).
 */
export async function collectRecheck(app: App, clock: Clock = freeClock()) {
  const homes = homeSpaces(app);
  const counts = { citedByPage: 0, cited: 0, knowledgeBase: 0, siblings: 0, context: 0 };
  if (!homes.length || !businessSpaces(app).length) return counts;
  const homeSet = new Set(homes);
  clock.progress("收集旁证", 0, 0);
  // Kept sources: the only ones that can be queued.
  const kept = all<{ id: string; space_id: string; p: string | null; kb: string | null }>(app.db,
    `select s.id, s.space_id, json_extract(s.meta, '$.wikiParentNodeToken') p, json_extract(s.meta, '$.wikiSpaceId') kb from sources s where ${eligibleSql(homes)}`, ...homes);
  await clock.tick();
  const keptIds = new Set(kept.map((k) => k.id));
  const alias = new Map(all<{ alias_id: string; source_id: string }>(app.db, "select alias_id, source_id from source_aliases").map((a) => [a.alias_id, a.source_id]));
  const resolve = (id: string | undefined) => (id ? (alias.get(id) ?? id) : undefined);
  // Who cites each kept source, from which space, and how (page / item or memory).
  const byPage = new Map<string, Set<string>>();
  const byOther = new Map<string, Set<string>>();
  const add = (m: Map<string, Set<string>>, id: string | undefined, space: string) => {
    if (!id || !keptIds.has(id) || homeSet.has(space)) return;
    (m.get(id) ?? m.set(id, new Set()).get(id)!).add(space);
  };
  const pageSpace = new Map(all<{ id: string; space_id: string }>(app.db, "select id, space_id from pages").map((p) => [p.id, p.space_id]));
  await scan<{ rowid: number; page_id: string; source_id: string }>(app, clock, "select rowid, page_id, source_id from page_cites where rowid > ? order by rowid limit ?", [], (r) => {
    const sp = pageSpace.get(r.page_id);
    if (sp) add(byPage, resolve(r.source_id), sp);
  });
  await scan<{ rowid: number; space_id: string; source_refs: string }>(app, clock,
    "select rowid, space_id, source_refs from items where source_refs != '[]' and status != 'cancelled' and rowid > ? order by rowid limit ?", [],
    (r) => { for (const ref of json<unknown[]>(r.source_refs, [])) add(byOther, resolve(refId(ref)), r.space_id); });
  await scan<{ rowid: number; space_id: string; source_refs: string }>(app, clock,
    "select rowid, space_id, source_refs from memories where status = 'active' and source_refs != '[]' and rowid > ? order by rowid limit ?", [],
    (r) => { for (const ref of json<unknown[]>(r.source_refs, [])) add(byOther, resolve(refId(ref)), r.space_id); });
  for (const r of all<{ ref: string; space_id: string }>(app.db, "select m.ref, i.space_id from item_materials m join items i on i.id = m.item_id where m.kind = 'source' and i.status != 'cancelled'"))
    add(byOther, resolve(r.ref), r.space_id);
  await clock.tick();
  // Where each knowledge-base folder's documents are (sources_wiki_parent), and where each knowledge base is filed.
  const folders = new Map<string, Set<string>>();
  for (const r of all<{ p: string; space_id: string }>(app.db,
    "select distinct json_extract(meta, '$.wikiParentNodeToken') p, space_id from sources where json_extract(meta, '$.wikiParentNodeToken') is not null and deleted_at is null")) {
    if (!homeSet.has(r.space_id)) (folders.get(r.p) ?? folders.set(r.p, new Set()).get(r.p)!).add(r.space_id);
  }
  const kbs = new Map(all<{ id: string; target_space: string }>(app.db, "select id, target_space from wiki_spaces where status = 'mapped' and target_space is not null").map((k) => [k.id, k.target_space]));
  const judged = new Map(all<{ source_id: string; fingerprint: string }>(app.db, "select source_id, fingerprint from archive_evidence").map((r) => [r.source_id, r.fingerprint]));
  const queued = new Set(all<{ source_id: string }>(app.db, "select source_id from archive_recheck").map((r) => r.source_id));
  await clock.tick();

  const reasons: Record<keyof typeof counts, string> = {
    citedByPage: "被其他空间的 Wiki 页面引用", cited: "被其他空间的事项或记忆引用", knowledgeBase: "所在的飞书知识库已归入业务空间", siblings: "同一目录的文档已归入业务空间", context: "空间或归档规则有变化",
  };
  const toQueue: [string, keyof typeof counts][] = [];
  kept.forEach((k) => {
    if (queued.has(k.id)) return;
    const pages = byPage.get(k.id) ?? new Set<string>();
    const other = byOther.get(k.id) ?? new Set<string>();
    const sib = (k.p && folders.get(k.p)) || new Set<string>();
    const kb = k.kb ? kbs.get(k.kb) : undefined;
    const fp = fingerprintOf(k.space_id, homeSet, [...pages, ...other], sib, kb);
    if (!fp || fp === (judged.get(k.id) ?? "")) return;
    const why = pages.size ? "citedByPage" : other.size ? "cited" : kb && !homeSet.has(kb) ? "knowledgeBase" : "siblings";
    toQueue.push([k.id, why]);
  });
  await enqueue(app, clock, toQueue.map(([id, why]) => [id, reasons[why], PRIORITY[why]]));
  for (const [, why] of toQueue) counts[why]++;
  const ctx = contextHash(app);
  const before = one<{ value: string }>(app.db, "select value from kv where key = 'archive_context'")?.value;
  if (before !== ctx) {
    run(app.db, "insert into kv(key, value) values('archive_context', ?) on conflict(key) do update set value = excluded.value", ctx);
    if (before) {
      const fresh = new Set(toQueue.map(([id]) => id));
      const rest = kept.filter((k) => !queued.has(k.id) && !fresh.has(k.id)).map((k) => k.id);
      await enqueue(app, clock, rest.map((id) => [id, reasons.context, PRIORITY.context]));
      counts.context = rest.length;
    }
  }
  return counts;
}
/** Queue entries in transactions of a few hundred, yielding between them. */
async function enqueue(app: App, clock: Clock, entries: [string, string, number][]) {
  for (const part of chunks(entries, 100)) {
    tx(app.db, () => { for (const [id, reason, priority] of part) run(app.db, QUEUE_SQL, id, reason, priority, now()); });
    await clock.tick();
  }
}

/**
 * Working files in the owner's personal space that belong to an item or a rule of a business space
 * go there (no model involved). A file the owner put back stays.
 */
export async function followWorkFiles(app: App, clock: Clock = freeClock()) {
  const homes = homeSpaces(app);
  if (!homes.length) return 0;
  let moved = 0;
  const rows = all<{ id: string; meta: string }>(app.db,
    `select s.id, s.meta from sources s where s.space_id in (${placeholders(homes.length)}) and s.kind = 'work' and s.deleted_at is null
       and (json_extract(s.meta, '$.links.item') is not null or json_extract(s.meta, '$.links.rule') is not null)
       and not exists (select 1 from source_routes r where r.source_id = s.id and r.mode = 'manual')`, ...homes);
  for (const r of rows) {
    if (clock.over()) break;
    const owner = belongsTo(app, json(r.meta, {}));
    if (!owner || homes.includes(owner.space) || findSpace(app, owner.space)?.kind === "worktree") continue;
    try {
      moveWorkFile(app, r.id, owner.space, `跟着${owner.kind === "item" ? "事项" : "规则"}「${owner.title}」`, "follow");
      moved++;
    } catch (e) {
      console.warn(`[omem] 工作文件 ${r.id} 没能跟着${owner.kind === "item" ? "事项" : "规则"}移走：${(e as Error).message}`);
    }
    await clock.tick();
  }
  return moved;
}

/** Documents of filed knowledge bases the nightly check brings home by itself; more than this waits for the owner. */
const KB_HOME_NIGHTLY = 50;
export type SweepReport = { at: string; followed: number; kbHome?: { moved: number; merged: number; failed: number; waiting?: number }; found: Awaited<ReturnType<typeof collectRecheck>>; byRule: number; queued: number; left: number; links: { read: number; complete: boolean }; ms: number; stopped: boolean };
export type SweepProgress = { running: boolean; phase: string; done: number; total: number; startedAt: string };

/** How long one check may run before it stops and leaves the rest for next time. */
export const SWEEP_MAX_MS = 5 * 60_000;
/** Older messages read for document links per check (src/sources/doc-links.ts), a share of the time. */
const LINK_SHARE = 0.4;

function freeClock(maxMs = SWEEP_MAX_MS, onProgress?: (p: Omit<SweepProgress, "running" | "startedAt">) => void): Clock {
  const tick = yielder();
  const start = performance.now();
  return { tick, over: () => performance.now() - start > maxMs, progress: (phase, done, total) => onProgress?.({ phase, done, total }) };
}

let current: Promise<SweepReport> | null = null;
let currentStart = "";
const PROGRESS = "archive_sweep_progress";

/**
 * The nightly check (and “现在检查”): working files follow their item or rule, older messages are
 * read for document links (a batch), sources with new evidence are queued, and up to `budget` of the
 * queue go to the archivist (most urgent first). A queued source an archive rule or binding now
 * decides is moved without counting against the budget. With nothing to judge no run starts. One at
 * a time: a second call waits for the one running. Yields to the event loop throughout; past
 * `maxMs` it stops and the next check carries on (the queue and the link cursor are kept).
 */
export function sweepHoming(app: App, opts: { budget?: number; maxMs?: number } = {}): Promise<SweepReport> {
  if (current) return current;
  currentStart = now();
  current = runSweep(app, opts).finally(() => {
    current = null;
  });
  return current;
}
/** Start a check in the background (HTTP, schedule); false when one is already running. */
export function startSweep(app: App, opts: { budget?: number; maxMs?: number } = {}) {
  const started = !current;
  void sweepHoming(app, opts).catch((e) => console.warn("[omem] 个人空间归位巡检失败：", (e as Error).message));
  return { started, progress: sweepProgress(app) };
}
export function sweepProgress(app: App): SweepProgress | null {
  const p = json<Omit<SweepProgress, "running"> | null>(one<{ value: string }>(app.db, "select value from kv where key = ?", PROGRESS)?.value, null);
  return p ? { ...p, running: !!current } : null;
}

async function runSweep(app: App, opts: { budget?: number; maxMs?: number }): Promise<SweepReport> {
  const budget = opts.budget ?? app.config.archive.nightly;
  const maxMs = opts.maxMs ?? SWEEP_MAX_MS;
  const start = performance.now();
  let lastWrite = 0;
  const save = (phase: string, done: number, total: number) => {
    const t = performance.now();
    if (t - lastWrite < 500 && done !== total) return;
    lastWrite = t;
    run(app.db, "insert into kv(key, value) values(?, ?) on conflict(key) do update set value = excluded.value", PROGRESS, JSON.stringify({ phase, done, total, startedAt: currentStart }));
  };
  const clock = freeClock(maxMs, (p) => save(p.phase, p.done, p.total));
  save("工作文件", 0, 0);
  const followed = await followWorkFiles(app, clock);
  // Documents of filed knowledge bases that sit elsewhere go to their knowledge base's space: the
  // owner's own decision (kb-home.ts), no judgement needed.
  save("知识库的文档归位", 0, 0);
  let kbHome: SweepReport["kbHome"];
  if (app.config.archive.autoMove) {
    // The nightly trickle only: a large backlog (the first time, a knowledge base newly filed) waits for the owner's own 收回 on the knowledge-base page.
    const { rehomeKb } = await import("./kb-home.ts");
    const plan = await rehomeKb(app, { dryRun: true }).catch(() => null);
    const waiting = plan ? plan.moved + plan.merged : 0;
    const r = waiting && waiting <= KB_HOME_NIGHTLY ? await rehomeKb(app, { dryRun: false }).catch((e) => void console.warn("[omem] 知识库归位失败：", (e as Error).message)) : null;
    kbHome = r ? { moved: r.moved, merged: r.merged, failed: r.failed.length } : { moved: 0, merged: 0, failed: 0, ...(waiting ? { waiting } : {}) };
  }
  // Older messages' document links: a share of the time, a batch at a time.
  let read = 0;
  save("读消息里的文档链接", 0, 0);
  while (!docLinksComplete(app) && performance.now() - start < maxMs * LINK_SHARE) {
    const n = backfillDocLinks(app, 500);
    read += n;
    save("读消息里的文档链接", read, 0);
    await clock.tick();
    if (!n) break;
  }
  const found = clock.over() ? { citedByPage: 0, cited: 0, knowledgeBase: 0, siblings: 0, context: 0 } : await collectRecheck(app, clock);
  let byRule = 0;
  const chosen: { id: string; space: string; reason: string }[] = [];
  const rows = all<{ source_id: string; reason: string }>(app.db, "select source_id, reason from archive_recheck order by priority, queued_at limit 1000");
  let i = 0;
  for (const q of rows) {
    if (clock.over()) break;
    save("交给归档判断", ++i, rows.length);
    await clock.tick();
    if (!isEligible(app, q.source_id)) {
      run(app.db, "delete from archive_recheck where source_id = ?", q.source_id);
      continue;
    }
    const s = getSource(app, q.source_id);
    const p = prepareArchive(app, { ...s, text: sourceText(app, s.id), archive: true });
    if (p && (p.mode === "rule" || p.mode === "binding") && p.input.spaceId !== s.spaceId) {
      try {
        moveSource(app, s.id, p.input.spaceId, p.reason, p.mode, p.ruleId);
        byRule++;
      } catch (e) {
        console.warn(`[omem] 原件 ${s.id} 按规则归档失败：${(e as Error).message}`);
        run(app.db, "delete from archive_recheck where source_id = ?", q.source_id);
      }
      continue;
    }
    if (chosen.length >= budget) continue;
    chosen.push({ id: s.id, space: s.spaceId, reason: q.reason });
  }
  // Handed over in one transaction (one commit, not two per source).
  tx(app.db, () => {
    for (const c of chosen) {
      run(app.db, `insert into source_routes(source_id, origin_space, mode, reason, pending) values(?,?,'fallback',?,1)
        on conflict(source_id) do update set pending = 1, decision_hash = null, mode = 'fallback', reason = excluded.reason`, c.id, c.space, `${REJUDGE}：${c.reason}`);
      run(app.db, "delete from archive_recheck where source_id = ?", c.id);
      queueArchive(app, c.id);
    }
  });
  const queued = chosen.length;
  const left = one<{ n: number }>(app.db, "select count(*) n from archive_recheck")!.n;
  const report: SweepReport = { at: now(), followed, ...(kbHome ? { kbHome } : {}), found, byRule, queued, left, links: { read, complete: docLinksComplete(app) }, ms: Math.round(performance.now() - start), stopped: clock.over() };
  run(app.db, "insert into kv(key, value) values('archive_sweep_last', ?) on conflict(key) do update set value = excluded.value", JSON.stringify(report));
  save("完成", 1, 1);
  return report;
}

// ---- where a working file goes ---------------------------------------------------

/**
 * The business space the work of a run (or the line it belongs to) is about: the items it was given
 * or touched, the conversation or bound chat it answers in, the rule that started it. Only asked
 * when the run works in the owner's personal space; null when nothing, or more than one space, is named.
 */
export function matterSpace(app: App, runId: string, current: string): { space: string; why: string } | null {
  const homes = homeSpaces(app);
  if (!homes.includes(current)) return null;
  const found = new Map<string, string>();
  const note = (space: string | null | undefined, why: string) => {
    if (!space || homes.includes(space) || found.has(space)) return;
    const sp = findSpace(app, space);
    if (sp && sp.kind !== "worktree") found.set(space, why);
  };
  const runs = [...new Set([runId, lineRoot(app, runId)].filter((x): x is string => !!x))];
  for (const r of runs) {
    for (const k of scopeOf(app, r)) {
      if (k.kind === "item") {
        const i = one<{ space_id: string; title: string }>(app.db, "select space_id, title from items where id = ?", k.key);
        note(i?.space_id, `事项「${i?.title}」`);
      } else if (k.kind === "conversation") {
        const c = one<{ space_id: string; title: string }>(app.db, "select space_id, title from conversations where id = ?", k.key);
        note(c?.space_id, `会话「${c?.title || k.key}」`);
      } else if (k.kind === "chat") note(chatBinding(app, k.key), "所在群绑定的空间");
    }
    const rule = json<{ rule?: { id?: string } }>(one<{ input: string }>(app.db, "select input from runs where id = ?", r)?.input, {}).rule?.id;
    if (rule) {
      const ru = one<{ space_id: string | null; name: string }>(app.db, "select space_id, name from rules where id = ?", rule);
      note(ru?.space_id, `规则「${ru?.name ?? rule}」`);
    }
  }
  if (found.size !== 1) return null;
  const [space, why] = [...found][0];
  return { space, why };
}

// ---- the owner's view -------------------------------------------------------------

export type MovedEntry = { moveId: number; sourceId: string; title: string; kind: string; from: string; to: string; now: string; reason: string; mode: string | null; at: string; detail: Evidence; returnable: boolean };

/** Automatic moves out of the owner's personal spaces, the archivist's open questions, the queue. All indexed, bounded. */
export function homingOverview(app: App, opts: { limit?: number } = {}) {
  const homes = homeSpaces(app);
  const limit = opts.limit ?? 100;
  const inHomes = `(${placeholders(homes.length)})`;
  const moved: MovedEntry[] = homes.length
    ? all<{ id: number; source_id: string; from_space: string; to_space: string; reason: string; at: string; mode: string | null; detail: string; title: string; kind: string; cur: string; later: number }>(app.db,
      `select m.id, m.source_id, m.from_space, m.to_space, m.reason, m.at, coalesce(m.mode, r.mode) mode, m.detail, s.title, s.kind, s.space_id cur,
          exists (select 1 from source_moves l where l.source_id = m.source_id and l.id > m.id) later
         from source_moves m join sources s on s.id = m.source_id left join source_routes r on r.source_id = m.source_id
         where m.from_space in ${inHomes} and m.to_space not in ${inHomes} and s.deleted_at is null and coalesce(m.mode, r.mode, '') in ('ai', 'rule', 'binding', 'follow')
         order by m.id desc limit ?`, ...homes, ...homes, limit)
      .map((r) => ({ moveId: r.id, sourceId: r.source_id, title: r.title, kind: r.kind, from: r.from_space, to: r.to_space, now: r.cur, reason: r.reason, mode: r.mode, at: r.at, detail: json(r.detail, {}),
        // Only the latest move of a source, while it is still there.
        returnable: r.cur === r.to_space && !r.later }))
    : [];
  const undecided = homes.length
    ? all<{ id: string; title: string; space_id: string; reason: string; verdict: string; suggested: string; hash: string }>(app.db,
      `select s.id, s.title, s.space_id, r.reason, r.verdict, r.suggested, s.hash from source_routes r join sources s on s.id = r.source_id
         where r.verdict in ('unsure', 'proposed') and r.mode != 'manual' and s.space_id in ${inHomes} and s.deleted_at is null order by s.updated_at desc limit 300`, ...homes)
      .map((r) => ({ id: r.id, title: r.title, space: r.space_id, reason: r.reason, verdict: r.verdict, suggested: json<string[]>(r.suggested, []), hash: r.hash }))
    : [];
  const queue = all<{ priority: number; n: number }>(app.db, "select priority, count(*) n from archive_recheck group by priority order by priority");
  const last = json<SweepReport | null>(one<{ value: string }>(app.db, "select value from kv where key = 'archive_sweep_last'")?.value, null);
  return { moved, undecided, queue, last, progress: sweepProgress(app), settings: app.config.archive };
}

/** Pin a source where it is: neither rules, the archivist nor the nightly check move it again. */
function pinHere(app: App, id: string, reason: string) {
  const s = getSource(app, id);
  run(app.db, `insert into source_routes(source_id, origin_space, mode, reason, decision_hash, pending) values(?,?,'manual',?,?,0)
    on conflict(source_id) do update set mode = 'manual', reason = excluded.reason, rule_id = null, decision_hash = excluded.decision_hash, pending = 0, verdict = null, suggested = '[]'`, id, s.spaceId, reason, s.hash);
  run(app.db, "delete from archive_recheck where source_id = ?", id);
}

function moveTo(app: App, id: string, target: string, reason: string) {
  const s = getSource(app, id);
  if (s.spaceId === target) return pinHere(app, id, reason);
  if (s.kind === "work") {
    moveWorkFile(app, id, target, reason);
    pinHere(app, id, reason);
  } else moveSource(app, id, target, reason, "manual");
}

/** Undo an automatic move: back where it came from, and kept there from now on. */
export function returnSource(app: App, id: string) {
  const s = getSource(app, id);
  const m = one<{ from_space: string; to_space: string }>(app.db, "select from_space, to_space from source_moves where source_id = ? order by id desc limit 1", id);
  if (!m || m.to_space !== s.spaceId || m.from_space === s.spaceId) throw new HttpError(409, "这份材料最近没有被移动过，或已经不在移去的空间");
  moveTo(app, id, m.from_space, "本人移回：就留在这里");
  return getSource(app, id);
}

/** The owner files sources by hand (into a space, or keeps them where they are); each one pinned. Yields between sources. */
export async function assignSources(app: App, ids: string[], target: string) {
  const sp = findSpace(app, target);
  if (!sp) throw new HttpError(404, `空间不存在：${target}`);
  if (sp.kind === "worktree") throw new HttpError(400, "不能放进临时工作区");
  const tick = yielder();
  const out: { id: string; ok: boolean; error?: string }[] = [];
  for (const id of ids) {
    try {
      const s = getSource(app, id);
      if (s.deletedAt) throw new HttpError(409, "原件已删除");
      if (NOT_ARCHIVED.includes(s.kind) && s.kind !== "work") throw new HttpError(400, "代码、对话和活动由所属工作区管理");
      moveTo(app, id, target, s.spaceId === target ? "本人确认放在这里" : "本人指定空间");
      out.push({ id, ok: true });
    } catch (e) {
      out.push({ id, ok: false, error: (e as Error).message });
    }
    await tick();
  }
  return out;
}

/** For the archive run: who is being judged again and why (the route's reason), shown with the evidence. */
export function previousJudgement(app: App, id: string) {
  const r = sourceRoute(app, id);
  return r?.reason?.startsWith(REJUDGE) ? r.reason : undefined;
}
