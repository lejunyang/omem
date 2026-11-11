import type { App } from "../core/app.ts";
import { chatBinding } from "../core/capture-space.ts";
import { all, one, run, tx } from "../core/db.ts";
import { findSpace } from "../core/spaces.ts";
import { OWNER } from "../core/users.ts";
import { HttpError, json, now, sha256 } from "../core/util.ts";
import { lineRoot } from "../agents/home.ts";
import { scopeOf } from "../agents/run-scope.ts";
import { listArchiveRules, moveSource, prepareArchive, queueArchive, REJUDGE, sourceRoute } from "./archive.ts";
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
/** The ids a citation may use for this source: its own and those of duplicates merged into it. */
function citeIds(app: App, id: string) {
  return [id, ...all<{ alias_id: string }>(app.db, "select alias_id from source_aliases where source_id = ?", id).map((r) => r.alias_id)];
}
const refMatch = (col: string) => `exists (select 1 from json_each(${col}) j where j.value = 'src:' || x.id or j.value like 'src:' || x.id || '#%')`;

function citations(app: App, id: string, own: string) {
  const ids = citeIds(app, id);
  const by = new Map<string, { pages: string[]; items: string[]; memories: number }>();
  const at = (space: string) => by.get(space) ?? by.set(space, { pages: [], items: [], memories: 0 }).get(space)!;
  const idList = `(select value id from json_each(?)) x`;
  for (const r of all<{ space_id: string; slug: string }>(app.db, `select distinct p.space_id, p.slug from page_cites pc join pages p on p.id = pc.page_id where pc.source_id in (${placeholders(ids.length)}) and p.space_id != ? limit 60`, ...ids, own))
    at(r.space_id).pages.push(r.slug);
  for (const r of all<{ space_id: string; title: string }>(app.db,
    `select i.space_id, i.title from items i where i.space_id != ? and i.status not in ('cancelled') and (exists (select 1 from ${idList} where ${refMatch("i.source_refs")})
       or exists (select 1 from item_materials m where m.item_id = i.id and m.kind = 'source' and m.ref in (select value from json_each(?)))) limit 30`, own, JSON.stringify(ids), JSON.stringify(ids)))
    at(r.space_id).items.push(r.title);
  for (const r of all<{ space_id: string; n: number }>(app.db,
    `select m.space_id, count(*) n from memories m where m.status = 'active' and m.space_id != ? and exists (select 1 from ${idList} where ${refMatch("m.source_refs")}) group by m.space_id`, own, JSON.stringify(ids)))
    at(r.space_id).memories = r.n;
  return [...by].map(([space, v]) => ({ space, ...(v.pages.length ? { pages: v.pages.slice(0, 5) } : {}), ...(v.items.length ? { items: v.items.slice(0, 5) } : {}), ...(v.memories ? { memories: v.memories } : {}) }));
}

function siblingsOf(app: App, id: string, parent: string | undefined) {
  if (!parent) return [];
  return all<{ space: string; n: number }>(app.db,
    "select space_id space, count(*) n from sources where deleted_at is null and id != ? and json_extract(meta, '$.wikiParentNodeToken') = ? group by space_id order by n desc limit 8", id, parent);
}

function kbSpace(app: App, wikiSpaceId: string | undefined) {
  if (!wikiSpaceId) return undefined;
  const kb = one<{ status: string; target_space: string | null }>(app.db, "select status, target_space from wiki_spaces where id = ?", wikiSpaceId);
  return kb?.status === "mapped" && kb.target_space ? kb.target_space : undefined;
}

/** A Feishu document's token in its address (docx / wiki / sheets …), to find the messages that link it. */
export function docToken(uri: string, meta: Record<string, unknown>) {
  return /\/(?:docx|docs|wiki|sheets|base|mindnotes|slides|file)\/([A-Za-z0-9]{10,})/.exec(uri)?.[1] ?? str(meta.documentId) ?? str(meta.token);
}

function linkedIn(app: App, uri: string, meta: Record<string, unknown>) {
  const token = docToken(uri, meta);
  if (!token) return [];
  return all<{ chat_id: string; n: number; sid: string | null }>(app.db,
    "select chat_id, count(*) n, max(source_id) sid from lark_messages where content like ? group by chat_id order by n desc limit 5", `%${token}%`)
    .map((r) => {
      const bound = chatBinding(app, r.chat_id);
      const chat = r.sid ? one<{ space_id: string; title: string }>(app.db, "select space_id, title from sources where id = ?", r.sid) : undefined;
      return { chat: r.chat_id, title: chat?.title ?? r.chat_id, space: bound ?? chat?.space_id ?? null, bound: !!bound, messages: r.n };
    });
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

/** The facts the host knows about where a source belongs (nothing judged; empty parts left out). */
export function archiveEvidence(app: App, id: string): Evidence {
  const s = getSource(app, id);
  const meta = s.meta as Record<string, unknown>;
  const e: Evidence = {};
  if (meta.wikiSpaceName || meta.wikiPath || meta.wikiSpaceId) {
    const mapped = kbSpace(app, str(meta.wikiSpaceId));
    e.wiki = { kb: str(meta.wikiSpaceName), path: str(meta.wikiPath), parent: str(meta.wikiParentTitle), ...(mapped ? { kbSpace: mapped } : {}) };
  }
  const sib = siblingsOf(app, id, str(meta.wikiParentNodeToken));
  if (sib.length) e.siblings = sib;
  const cited = citations(app, id, s.spaceId);
  if (cited.length) e.citedBy = cited;
  const chats = linkedIn(app, s.uri, meta);
  if (chats.length) e.linkedIn = chats;
  if (s.level && !s.level.inherited && s.level.by) e.attention = { level: s.level.level, by: s.level.by };
  const owner = s.kind === "work" ? belongsTo(app, meta) : undefined;
  if (owner) e.belongsTo = owner;
  return e;
}

/**
 * The cheap part of the evidence, as a fingerprint: the other spaces citing it, the spaces its
 * folder's documents went to, the space its knowledge base is filed under. A source is judged
 * again only when this changed since it was last judged ("" when nothing points elsewhere).
 */
export function evidenceFingerprint(app: App, id: string): string {
  const s = getSource(app, id);
  const homes = new Set(homeSpaces(app));
  const meta = s.meta as Record<string, unknown>;
  const away = (spaces: string[]) => [...new Set(spaces)].filter((x) => !homes.has(x) && x !== s.spaceId).sort();
  const cites = away(citations(app, id, s.spaceId).map((c) => c.space));
  const sib = away(siblingsOf(app, id, str(meta.wikiParentNodeToken)).map((x) => x.space));
  const kb = away([kbSpace(app, str(meta.wikiSpaceId)) ?? ""].filter(Boolean));
  if (!cites.length && !sib.length && !kb.length) return "";
  return JSON.stringify({ cites, sib, kb });
}
/** Recorded when the archivist is handed a source: what it was judged with. */
export function noteJudged(app: App, id: string) {
  run(app.db, "insert into archive_evidence(source_id, fingerprint, at) values(?,?,?) on conflict(source_id) do update set fingerprint = excluded.fingerprint, at = excluded.at", id, evidenceFingerprint(app, id), now());
}
const judgedWith = (app: App, id: string) => one<{ fingerprint: string }>(app.db, "select fingerprint from archive_evidence where source_id = ?", id)?.fingerprint ?? "";

// ---- the queue ------------------------------------------------------------------

/** Priorities: lower first. */
export const PRIORITY = { unreachable: 0, citedByPage: 0, cited: 1, knowledgeBase: 1, siblings: 2, context: 3 } as const;

/** Sources in the owner's personal spaces that the archivist may judge again (not pinned by hand, a binding or a rule). */
function eligibleSql(homes: string[], alias = "s") {
  return `${alias}.deleted_at is null and ${alias}.space_id in (${placeholders(homes.length)}) and ${alias}.kind not in (${NOT_ARCHIVED.map((k) => `'${k}'`).join(",")})
    and not exists (select 1 from source_routes r where r.source_id = ${alias}.id and (r.mode in ('manual', 'binding', 'rule') or r.pending = 1))`;
}
export function isEligible(app: App, id: string) {
  const homes = homeSpaces(app);
  return !!homes.length && !!one(app.db, `select 1 from sources s where s.id = ? and ${eligibleSql(homes)}`, id, ...homes);
}

/** Put sources in the queue (an earlier, more urgent entry stays). Returns how many are queued now. */
export function queueRecheck(app: App, ids: string[], reason: string, priority: number) {
  let n = 0;
  for (const id of new Set(ids)) {
    if (!isEligible(app, id)) continue;
    run(app.db, `insert into archive_recheck(source_id, reason, priority, queued_at) values(?,?,?,?)
      on conflict(source_id) do update set reason = case when excluded.priority < archive_recheck.priority then excluded.reason else archive_recheck.reason end,
        priority = min(archive_recheck.priority, excluded.priority)`, id, reason, priority, now());
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

/**
 * Find sources with new evidence and queue them. Cheap SQL picks the candidates (cited elsewhere,
 * knowledge base filed, folder siblings filed); each is queued only when its evidence fingerprint
 * differs from the one it was last judged with. A change of spaces or rules queues everything kept,
 * last in line (the first sweep only records the state).
 */
export function collectRecheck(app: App) {
  const homes = homeSpaces(app);
  const counts = { citedByPage: 0, cited: 0, knowledgeBase: 0, siblings: 0, context: 0 };
  if (!homes.length || !businessSpaces(app).length) return counts;
  const el = eligibleSql(homes);
  const notHome = `not in (${placeholders(homes.length)})`;
  const candidates: [keyof typeof counts, string, string, unknown[]][] = [
    ["citedByPage", "被其他空间的 Wiki 页面引用",
      `select distinct s.id from page_cites pc join pages p on p.id = pc.page_id
         join sources s on s.id = coalesce((select a.source_id from source_aliases a where a.alias_id = pc.source_id), pc.source_id)
         where p.space_id != s.space_id and p.space_id ${notHome} and ${el}`, [...homes, ...homes]],
    ["cited", "被其他空间的事项或记忆引用",
      `select distinct s.id from (
          select j.value v from items i, json_each(i.source_refs) j where i.space_id ${notHome} and j.value like 'src:%'
          union all select j.value from memories m, json_each(m.source_refs) j where m.status = 'active' and m.space_id ${notHome} and j.value like 'src:%'
          union all select 'src:' || m.ref from item_materials m join items i on i.id = m.item_id where m.kind = 'source' and i.space_id ${notHome}
        ) r join sources s on s.id = substr(r.v, 5, case when instr(r.v, '#') > 0 then instr(r.v, '#') - 5 else length(r.v) end) where ${el}`, [...homes, ...homes, ...homes, ...homes]],
    ["knowledgeBase", "所在的飞书知识库已归入业务空间",
      `select s.id from sources s join wiki_spaces w on w.id = json_extract(s.meta, '$.wikiSpaceId') where w.status = 'mapped' and w.target_space ${notHome} and ${el}`, [...homes, ...homes]],
    ["siblings", "同一目录的文档已归入业务空间",
      `with placed as (select distinct json_extract(meta, '$.wikiParentNodeToken') p from sources where deleted_at is null and space_id ${notHome} and json_extract(meta, '$.wikiParentNodeToken') is not null)
       select s.id from sources s join placed on placed.p = json_extract(s.meta, '$.wikiParentNodeToken') where ${el}`, [...homes, ...homes]],
  ];
  for (const [key, reason, sql, params] of candidates) {
    for (const { id } of all<{ id: string }>(app.db, sql, ...(params as string[]))) {
      if (one(app.db, "select 1 from archive_recheck where source_id = ?", id)) continue;
      const fp = evidenceFingerprint(app, id);
      if (!fp || fp === judgedWith(app, id)) continue;
      counts[key] += queueRecheck(app, [id], reason, PRIORITY[key]);
    }
  }
  const ctx = contextHash(app);
  const before = one<{ value: string }>(app.db, "select value from kv where key = 'archive_context'")?.value;
  if (before !== ctx) {
    run(app.db, "insert into kv(key, value) values('archive_context', ?) on conflict(key) do update set value = excluded.value", ctx);
    if (before) {
      const ids = all<{ id: string }>(app.db, `select s.id from sources s where ${el} and not exists (select 1 from archive_recheck q where q.source_id = s.id)`, ...homes).map((r) => r.id);
      counts.context = queueRecheck(app, ids, "空间或归档规则有变化", PRIORITY.context);
    }
  }
  return counts;
}

/**
 * Working files in the owner's personal space that belong to an item or a rule of a business space
 * go there (no model involved). A file the owner put back stays.
 */
export function followWorkFiles(app: App) {
  const homes = homeSpaces(app);
  if (!homes.length) return 0;
  let moved = 0;
  const rows = all<{ id: string; meta: string }>(app.db,
    `select s.id, s.meta from sources s where s.kind = 'work' and s.deleted_at is null and s.space_id in (${placeholders(homes.length)})
       and (json_extract(s.meta, '$.links.item') is not null or json_extract(s.meta, '$.links.rule') is not null)
       and not exists (select 1 from source_routes r where r.source_id = s.id and r.mode = 'manual')`, ...homes);
  for (const r of rows) {
    const owner = belongsTo(app, json(r.meta, {}));
    if (!owner || homes.includes(owner.space) || findSpace(app, owner.space)?.kind === "worktree") continue;
    try {
      moveWorkFile(app, r.id, owner.space, `跟着${owner.kind === "item" ? "事项" : "规则"}「${owner.title}」`, "follow");
      moved++;
    } catch (e) {
      console.warn(`[omem] 工作文件 ${r.id} 没能跟着${owner.kind === "item" ? "事项" : "规则"}移走：${(e as Error).message}`);
    }
  }
  return moved;
}

export type SweepReport = { at: string; followed: number; found: ReturnType<typeof collectRecheck>; byRule: number; queued: number; left: number };

/**
 * The nightly check: working files follow their item or rule, sources with new evidence are queued,
 * and up to `budget` of the queue go to the archivist (most urgent first). A queued source an
 * archive rule or binding now decides is moved without counting against the budget. With nothing to
 * judge no run starts.
 */
export function sweepHoming(app: App, opts: { budget?: number } = {}): SweepReport {
  const budget = opts.budget ?? app.config.archive.nightly;
  const followed = followWorkFiles(app);
  const found = collectRecheck(app);
  let byRule = 0;
  let queued = 0;
  const rows = all<{ source_id: string; reason: string }>(app.db, "select source_id, reason from archive_recheck order by priority, queued_at limit 1000");
  for (const q of rows) {
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
    if (queued >= budget) continue;
    tx(app.db, () => {
      run(app.db, `insert into source_routes(source_id, origin_space, mode, reason, pending) values(?,?,'fallback',?,1)
        on conflict(source_id) do update set pending = 1, decision_hash = null, mode = 'fallback', reason = excluded.reason`, s.id, s.spaceId, `${REJUDGE}：${q.reason}`);
      run(app.db, "delete from archive_recheck where source_id = ?", s.id);
    });
    queueArchive(app, s.id);
    queued++;
  }
  const left = one<{ n: number }>(app.db, "select count(*) n from archive_recheck")!.n;
  const report = { at: now(), followed, found, byRule, queued, left };
  run(app.db, "insert into kv(key, value) values('archive_sweep_last', ?) on conflict(key) do update set value = excluded.value", JSON.stringify(report));
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

/** Automatic moves out of the owner's personal spaces, the archivist's open questions, the queue. */
export function homingOverview(app: App, opts: { limit?: number } = {}) {
  const homes = homeSpaces(app);
  const limit = opts.limit ?? 100;
  const inHomes = `(${placeholders(homes.length)})`;
  const moved: MovedEntry[] = homes.length
    ? all<{ id: number; source_id: string; from_space: string; to_space: string; reason: string; at: string; mode: string | null; detail: string; title: string; kind: string; cur: string; rmode: string | null }>(app.db,
      `select m.id, m.source_id, m.from_space, m.to_space, m.reason, m.at, coalesce(m.mode, r.mode) mode, m.detail, s.title, s.kind, s.space_id cur, r.mode rmode
         from source_moves m join sources s on s.id = m.source_id left join source_routes r on r.source_id = m.source_id
         where m.from_space in ${inHomes} and m.to_space not in ${inHomes} and s.deleted_at is null and coalesce(m.mode, r.mode, '') in ('ai', 'rule', 'binding', 'follow')
         order by m.id desc limit ?`, ...homes, ...homes, limit)
      .map((r) => ({ moveId: r.id, sourceId: r.source_id, title: r.title, kind: r.kind, from: r.from_space, to: r.to_space, now: r.cur, reason: r.reason, mode: r.mode, at: r.at, detail: json(r.detail, {}),
        // Only the latest move of a source, while it is still there.
        returnable: r.cur === r.to_space && !one(app.db, "select 1 from source_moves where source_id = ? and id > ?", r.source_id, r.id) }))
    : [];
  const undecided = homes.length
    ? all<{ id: string; title: string; space_id: string; reason: string; verdict: string; suggested: string; hash: string }>(app.db,
      `select s.id, s.title, s.space_id, r.reason, r.verdict, r.suggested, s.hash from source_routes r join sources s on s.id = r.source_id
         where r.verdict in ('unsure', 'proposed') and r.mode != 'manual' and s.space_id in ${inHomes} and s.deleted_at is null order by s.updated_at desc limit 300`, ...homes)
      .map((r) => ({ id: r.id, title: r.title, space: r.space_id, reason: r.reason, verdict: r.verdict, suggested: json<string[]>(r.suggested, []), hash: r.hash }))
    : [];
  const queue = all<{ priority: number; n: number }>(app.db, "select priority, count(*) n from archive_recheck group by priority order by priority");
  const last = json<SweepReport | null>(one<{ value: string }>(app.db, "select value from kv where key = 'archive_sweep_last'")?.value, null);
  return { moved, undecided, queue, last, settings: app.config.archive };
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

/** The owner files sources by hand (into a space, or keeps them where they are); each one pinned. */
export function assignSources(app: App, ids: string[], target: string) {
  const sp = findSpace(app, target);
  if (!sp) throw new HttpError(404, `空间不存在：${target}`);
  if (sp.kind === "worktree") throw new HttpError(400, "不能放进临时工作区");
  return ids.map((id) => {
    try {
      const s = getSource(app, id);
      if (s.deletedAt) throw new HttpError(409, "原件已删除");
      if (NOT_ARCHIVED.includes(s.kind) && s.kind !== "work") throw new HttpError(400, "代码、对话和活动由所属工作区管理");
      moveTo(app, id, target, s.spaceId === target ? "本人确认放在这里" : "本人指定空间");
      return { id, ok: true };
    } catch (e) {
      return { id, ok: false, error: (e as Error).message };
    }
  });
}

/** For the archive run: who is being judged again and why (the route's reason), shown with the evidence. */
export function previousJudgement(app: App, id: string) {
  const r = sourceRoute(app, id);
  return r?.reason?.startsWith(REJUDGE) ? r.reason : undefined;
}
