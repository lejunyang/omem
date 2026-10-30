import { createHash } from "node:crypto";
import { z } from "zod";
import type { App } from "../core/app.ts";
import { all, one, run, tx } from "../core/db.ts";
import { notify } from "../core/notify.ts";
import { createSpace, findSpace, kindLabel, listSpaces, relatedSpaces } from "../core/spaces.ts";
import { HttpError, json, now, slugify } from "../core/util.ts";
import { runRole } from "../agents/runner.ts";
import { createRun, registerHandler } from "../agents/runs.ts";
import { setNodeLevel } from "../sources/attention.ts";
import { asOwner, cliUser } from "./lark-auth.ts";
import { larkCli } from "./lark-cli.ts";
import { continueCrawl, crawlBusy, crawlLoop, crawlSummary, forgetCrawl, getCrawl, startSpaceCrawl, stopCrawl, wikiChildren, type WikiCrawl } from "./lark-wiki.ts";

/**
 * Knowledge bases the owner can see in Feishu, read a little every day (read-only, as the owner).
 *
 * - Discovery (weekly, or on demand): `wiki +space-list` lists every knowledge base the owner's
 *   login can see (the personal library comes from `wiki spaces get my_library`); each is kept in
 *   `wiki_spaces` with its description and type. One no longer listed is marked gone, not deleted.
 *   A new one gets a shallow look — its top-level titles and a few of their children — so there is
 *   something to judge it by.
 * - Sorting: the host does not decide which space a knowledge base belongs to. The kb-scout role
 *   reads the owner's direction (`lark.knowledge.direction`), the spaces there are and a batch of
 *   unsorted knowledge bases, and proposes for each: an existing space, a new space, ignore, or
 *   later — with a priority (its share of the daily reading) and the level its pages start at
 *   (`propose_knowledge_mapping`). The owner accepts or changes it on the sources page; with
 *   `autoApply` the proposals take effect at once and one notification says what was done.
 * - Reading (nightly): `dailyDocs` docs in all, split across the mapped knowledge bases by
 *   priority. Each mapped one has a crawl from its top-level nodes into its space (lark-wiki.ts);
 *   the night continues it by its share. Pages the space already has are passed over without
 *   spending the budget (their updates come from the docs check); what was read goes to the usual
 *   understanding of new material (scheduleIngest), and the knowledge base's initial level sits on
 *   its catalog node so every page below inherits it.
 */

export const KB_STATUSES = ["new", "proposed", "later", "mapped", "ignored"] as const;
export type KbStatus = (typeof KB_STATUSES)[number];
export const PRIORITIES = ["high", "normal", "low"] as const;
export type Priority = (typeof PRIORITIES)[number];
export const KB_LEVELS = ["focus", "normal", "reference"] as const;
export type KbLevel = (typeof KB_LEVELS)[number];
export const NEW_SPACE_KINDS = ["project", "topic", "learning"] as const;

export const newSpaceSchema = z.object({
  id: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{1,40}$/, "空间 id 用小写字母、数字和连字符"),
  name: z.string().trim().min(1).max(40),
  kind: z.enum(NEW_SPACE_KINDS).default("topic"),
  description: z.string().trim().min(1).max(300),
});
export type NewSpace = z.infer<typeof newSpaceSchema>;

export type KbProposal = {
  action: "map" | "create" | "ignore" | "later";
  space?: string;
  newSpace?: NewSpace;
  priority: Priority;
  level: KbLevel;
  reason: string;
  by: string;
  runId: string | null;
  at: string;
  /** The direction the proposal was made under (hash): a `later` one is looked at again once it changes. */
  direction: string;
};
export type KbSample = { roots: { title: string; type: string; children: string[]; more: boolean }[]; rootCount: number; more: boolean; at: string; error?: string };

type Row = {
  id: string;
  name: string;
  description: string;
  space_type: string | null;
  visibility: string | null;
  discovered_at: string | null;
  last_seen_at: string | null;
  gone_at: string | null;
  sample: string | null;
  status: string;
  target_space: string | null;
  priority: string;
  level: string;
  daily_share: number | null;
  proposal: string | null;
  scouted_at: string | null;
  decided_at: string | null;
  decided_by: string | null;
  paused: number;
  crawl_id: string | null;
};
export type KnowledgeBase = {
  id: string;
  name: string;
  description: string;
  spaceType: string | null;
  visibility: string | null;
  discoveredAt: string | null;
  lastSeenAt: string | null;
  goneAt: string | null;
  sample: KbSample | null;
  status: KbStatus;
  targetSpace: string | null;
  priority: Priority;
  level: KbLevel;
  dailyShare: number | null;
  proposal: KbProposal | null;
  scoutedAt: string | null;
  decidedAt: string | null;
  decidedBy: string | null;
  paused: boolean;
  crawlId: string | null;
};
const toKb = (r: Row): KnowledgeBase => ({
  id: r.id,
  name: r.name,
  description: r.description,
  spaceType: r.space_type,
  visibility: r.visibility,
  discoveredAt: r.discovered_at,
  lastSeenAt: r.last_seen_at,
  goneAt: r.gone_at,
  sample: json<KbSample | null>(r.sample, null),
  status: (KB_STATUSES as readonly string[]).includes(r.status) ? (r.status as KbStatus) : "new",
  targetSpace: r.target_space,
  priority: (PRIORITIES as readonly string[]).includes(r.priority) ? (r.priority as Priority) : "normal",
  level: (KB_LEVELS as readonly string[]).includes(r.level) ? (r.level as KbLevel) : "normal",
  dailyShare: r.daily_share,
  proposal: json<KbProposal | null>(r.proposal, null),
  scoutedAt: r.scouted_at,
  decidedAt: r.decided_at,
  decidedBy: r.decided_by,
  paused: !!r.paused,
  crawlId: r.crawl_id,
});

export const STATUS_LABELS: Record<KbStatus, string> = { new: "还没判断", proposed: "有建议待确认", later: "先放着", mapped: "已归入空间", ignored: "不读" };
export const PRIORITY_LABELS: Record<Priority, string> = { high: "高", normal: "中", low: "低" };
const WEIGHT: Record<Priority, number> = { high: 3, normal: 2, low: 1 };
const RANK: Record<Priority, number> = { high: 0, normal: 1, low: 2 };
const SCOUT_BATCH = 25;
/** A knowledge base the scout passed over is offered again after this long. */
const RESCOUT_MS = 7 * 86400_000;
/** A sample older than this is taken again before the knowledge base is judged. */
const SAMPLE_MS = 30 * 86400_000;
/** A finished crawl is walked again after this long, for pages added since. */
const REWALK_MS = 7 * 86400_000;
/** What the shallow look reads of a new knowledge base: top-level titles, the children of the first few. */
export const KB_SAMPLE = { roots: 50, expand: 5, children: 10 };

let throttleMs = 300;
/** Tests: no pause between Feishu calls. */
export function setKbThrottleForTests(ms: number) {
  throttleMs = ms;
}
const pause = () => (throttleMs ? new Promise((r) => setTimeout(r, throttleMs)) : Promise.resolve());

const ROW = "select * from wiki_spaces";
export function getKb(app: App, id: string): KnowledgeBase | null {
  const r = one<Row>(app.db, `${ROW} where id = ? and discovered_at is not null`, id);
  return r ? toKb(r) : null;
}
function mustKb(app: App, id: string) {
  const kb = getKb(app, id);
  if (!kb) throw new HttpError(404, `没有这个知识库：${id}（先运行发现）`);
  return kb;
}

/** Host of doc links built from node tokens: the setting, else the one most captured Feishu docs use. */
export function knowledgeOrigin(app: App) {
  const set = app.config.lark.knowledge?.origin;
  if (set) return set.replace(/\/+$/, "");
  const row = one<{ origin: string }>(
    app.db,
    `select substr(uri, 1, instr(substr(uri, 9), '/') + 7) origin, count(*) n from (select uri from sources where kind = 'doc' and deleted_at is null and (uri like 'https://%/wiki/%' or uri like 'https://%/docx/%') order by updated_at desc limit 500) group by 1 order by n desc limit 1`,
  );
  return row?.origin || "https://www.feishu.cn";
}

/** Hash of the owner's direction, so a proposal knows which direction it answered. */
export function directionHash(app: App) {
  return createHash("sha256").update((app.config.lark.knowledge?.direction ?? "").trim()).digest("hex").slice(0, 12);
}

// ---- discovery ---------------------------------------------------------------------------------

type Listed = { space_id?: string; name?: string; description?: string; space_type?: string; visibility?: string };

/** Every knowledge base the owner's login can see (all pages), and whether the listing was complete. */
async function listSpacesAsOwner(app: App): Promise<{ spaces: Listed[]; complete: boolean }> {
  const v = await asOwner(app, "列出能看到的飞书知识库", () => larkCli(["wiki", "+space-list", "--as", "user", "--page-all", "--page-limit", "0", "--format", "json"], 300_000));
  const d = v?.data ?? v;
  const spaces = ((d?.spaces ?? d?.items ?? []) as Listed[]).filter((s) => s?.space_id);
  return { spaces, complete: !d?.has_more };
}

/** The personal library, which the listing never returns. */
async function myLibrary(app: App): Promise<Listed> {
  const v = await asOwner(app, "读取个人文档库", () => larkCli(["wiki", "spaces", "get", "--params", JSON.stringify({ space_id: "my_library" }), "--as", "user", "--format", "json"], 60_000));
  const d = v?.data ?? v;
  const s = d?.space ?? d;
  if (!s?.space_id) throw new Error("读不到个人文档库");
  return { ...s, space_type: s.space_type ?? "my_library", name: s.name || "我的文档库" };
}

export type DiscoveryReport = { at: string; found: number; added: number; gone: number; walked: number; errors: string[]; skipped?: string; scoutRunId?: string | null };

/**
 * List the knowledge bases, keep them, take a shallow look at new ones (at most `walk` per run, a
 * pause between calls), and hand the unsorted ones to the scout. Read-only on Feishu.
 */
export async function discoverKnowledgeBases(app: App, opts: { walk?: number; scheduled?: boolean } = {}): Promise<DiscoveryReport> {
  const at = now();
  const report: DiscoveryReport = { at, found: 0, added: 0, gone: 0, walked: 0, errors: [] };
  if (opts.scheduled && !(await cliUser())) return save(app, { ...report, skipped: "lark-cli 没有本人登录" });
  const listed = await listSpacesAsOwner(app);
  let library: Listed | null = null;
  try {
    library = await myLibrary(app);
  } catch (e) {
    report.errors.push(`个人文档库：${(e as Error).message.slice(0, 200)}`);
  }
  const byId = new Map<string, Listed>();
  for (const s of [...listed.spaces, ...(library ? [library] : [])]) byId.set(String(s.space_id), s);
  tx(app.db, () => {
    for (const [id, s] of byId) {
      const had = one<{ discovered_at: string | null }>(app.db, "select discovered_at from wiki_spaces where id = ?", id);
      if (!had?.discovered_at) report.added++;
      run(
        app.db,
        `insert into wiki_spaces(id, name, description, space_type, visibility, discovered_at, last_seen_at, gone_at, checked_at, updated_at) values(?,?,?,?,?,?,?,null,?,?)
         on conflict(id) do update set name = case when excluded.name != '' then excluded.name else wiki_spaces.name end, description = excluded.description,
         space_type = excluded.space_type, visibility = excluded.visibility, discovered_at = coalesce(wiki_spaces.discovered_at, excluded.discovered_at),
         last_seen_at = excluded.last_seen_at, gone_at = null, checked_at = excluded.checked_at, updated_at = excluded.updated_at`,
        id, String(s.name ?? ""), String(s.description ?? ""), s.space_type ?? null, s.visibility ?? null, at, at, at, at,
      );
    }
    report.found = byId.size;
    // Gone: listed before, not now. Only from a complete listing; the personal library only when it was read.
    if (listed.complete) {
      const missing = all<{ id: string; space_type: string | null }>(app.db, "select id, space_type from wiki_spaces where discovered_at is not null and gone_at is null")
        .filter((r) => !byId.has(r.id) && (library || r.space_type !== "my_library"));
      for (const r of missing) run(app.db, "update wiki_spaces set gone_at = ?, updated_at = ? where id = ?", at, at, r.id);
      report.gone = missing.length;
    } else report.errors.push("知识库列表没有读完（has_more），这次不标记消失的");
  });
  const stale = new Date(Date.now() - SAMPLE_MS).toISOString();
  const toWalk = all<{ id: string }>(
    app.db,
    `select id from wiki_spaces where discovered_at is not null and gone_at is null and status in ('new', 'later', 'proposed')
       and (sample is null or coalesce(json_extract(sample, '$.at'), '') < ?) order by sample is not null, discovered_at limit ?`,
    stale,
    Math.max(0, opts.walk ?? 100),
  );
  for (const { id } of toWalk) {
    await walkSample(app, id);
    report.walked++;
    await pause();
  }
  report.scoutRunId = scheduleScout(app);
  return save(app, report);
}

function save(app: App, report: DiscoveryReport) {
  run(app.db, "insert into kv(key,value) values('lark_kb_discovery', ?) on conflict(key) do update set value = excluded.value", JSON.stringify(report));
  return report;
}

/** A shallow look at a knowledge base: its top-level titles and the children of the first few. */
export async function walkSample(app: App, id: string, caps = KB_SAMPLE): Promise<KbSample> {
  let sample: KbSample;
  try {
    const { nodes, more } = await wikiChildren(app, { spaceId: id, nodeToken: "" }, caps.roots);
    const roots: KbSample["roots"] = [];
    let expanded = 0;
    for (const n of nodes) {
      const item = { title: n.title, type: n.objType, children: [] as string[], more: false };
      if (n.hasChild && n.nodeType !== "shortcut" && expanded < caps.expand) {
        expanded++;
        await pause();
        try {
          const c = await wikiChildren(app, n, caps.children);
          item.children = c.nodes.map((x) => x.title);
          item.more = c.more;
        } catch {}
      } else if (n.hasChild) item.more = true;
      roots.push(item);
    }
    sample = { roots, rootCount: nodes.length, more, at: now() };
  } catch (e) {
    sample = { roots: [], rootCount: 0, more: false, at: now(), error: (e as Error).message.slice(0, 300) };
  }
  run(app.db, "update wiki_spaces set sample = ?, updated_at = ? where id = ?", JSON.stringify(sample), now(), id);
  return sample;
}

const discovering = new WeakMap<App, Promise<DiscoveryReport>>();
/** Discovery in the background (the web, a peer): one at a time. */
export function startDiscovery(app: App) {
  const running = discovering.get(app);
  if (running) return { started: false, running: true, last: lastDiscovery(app) };
  const p = discoverKnowledgeBases(app)
    .catch((e) => {
      console.warn(`[omem] 发现飞书知识库失败：${(e as Error).message}`);
      return save(app, { at: now(), found: 0, added: 0, gone: 0, walked: 0, errors: [(e as Error).message.slice(0, 300)] });
    })
    .finally(() => discovering.delete(app));
  discovering.set(app, p);
  return { started: true, running: true, last: lastDiscovery(app) };
}
export const lastDiscovery = (app: App) => json<DiscoveryReport | null>(one<{ value: string }>(app.db, "select value from kv where key = 'lark_kb_discovery'")?.value, null);
export const discoveryRunning = (app: App) => discovering.has(app);

// ---- sorting (kb-scout) ------------------------------------------------------------------------

/** Knowledge bases waiting for a proposal: new ones, and `later` ones once the direction changed; not looked at in the last week. */
function scoutCandidates(app: App, limit = SCOUT_BATCH) {
  return all<{ id: string }>(
    app.db,
    `select id from wiki_spaces where discovered_at is not null and gone_at is null
       and (status = 'new' or (status = 'later' and coalesce(json_extract(proposal, '$.direction'), '') != ?))
       and (scouted_at is null or scouted_at < ?) order by discovered_at, id limit ?`,
    directionHash(app),
    new Date(Date.now() - RESCOUT_MS).toISOString(),
    limit,
  ).map((r) => r.id);
}

/** Queue a kb-scout run for the next batch, unless one is waiting or running (other than `except`). */
export function scheduleScout(app: App, except?: string): string | null {
  if (one(app.db, "select 1 from runs where kind = 'kb-scout' and status in ('queued','running') and id != ?", except ?? "")) return null;
  const ids = scoutCandidates(app);
  if (!ids.length) return null;
  return createRun(app, { kind: "kb-scout", spaceId: "personal", title: `给 ${ids.length} 个飞书知识库提归属建议`, input: { kbIds: ids } }).id;
}

/** The owner changed the direction: what was put aside or passed over is looked at again. */
export function directionChanged(app: App) {
  run(app.db, "update wiki_spaces set scouted_at = null where discovered_at is not null and gone_at is null and status in ('new', 'later')");
  return scheduleScout(app);
}

const kbLine = (kb: KnowledgeBase) => {
  const s = kb.sample;
  const roots = s?.roots.map((r) => `  - ${r.title || "（未命名）"}${r.type && r.type !== "docx" ? `（${r.type}）` : ""}${r.children.length ? `：${r.children.join("、")}${r.more ? "……" : ""}` : r.more ? "（下面还有页面）" : ""}`).join("\n");
  const nodes = s ? `顶层 ${s.rootCount}${s.more ? "+" : ""} 个页面` : "还没看过目录";
  return [
    `### ${kb.id}《${kb.name || "（无名称）"}》`,
    `类型：${kb.spaceType === "my_library" ? "个人文档库" : kb.spaceType === "person" ? "个人知识库" : kb.spaceType === "team" ? "团队知识库" : (kb.spaceType ?? "未知")}${kb.visibility ? `，${kb.visibility === "public" ? "公开" : "私有"}` : ""}；${nodes}`,
    kb.description ? `简介：${kb.description}` : "",
    s?.error ? `目录读不了：${s.error}` : roots ? `目录：\n${roots}` : "",
    kb.status === "later" && kb.proposal ? `上次的判断（先放着）：${kb.proposal.reason}` : "",
  ].filter(Boolean).join("\n");
};

function scoutTask(app: App, kbs: KnowledgeBase[]) {
  const direction = app.config.lark.knowledge?.direction?.trim();
  const mapped = all<Row>(app.db, `${ROW} where discovered_at is not null and status = 'mapped'`).map(toKb);
  const spaces = listSpaces(app)
    .filter((s) => s.kind !== "repo")
    .map((s) => {
      const rel = relatedSpaces(app, s.id).map((r) => r.space);
      const kbsHere = mapped.filter((k) => k.targetSpace === s.id).map((k) => `《${k.name}》`);
      return `- ${s.id}（${s.name}，${kindLabel(s.kind)}）${s.description ? `：${s.description}` : ""}${rel.length ? `；相关：${rel.join("、")}` : ""}${kbsHere.length ? `；已归入的知识库：${kbsHere.join("、")}` : ""}`;
    });
  return [
    `本人的方向：${direction || "（本人还没写方向：只把明显属于已有空间、或明显和本人的工作相关的知识库提出来，其余 later）"}`,
    `已有空间（代码仓库空间不列，不往里放）：\n${spaces.join("\n") || "（只有个人空间）"}`,
    `待判断的知识库（${kbs.length}）：\n\n${kbs.map(kbLine).join("\n\n")}`,
    `对每个知识库调用一次 propose_knowledge_mapping（kb 填上面的 id）。${app.config.lark.knowledge?.autoApply ? "本人开了自动应用：建议会直接生效。" : "建议要等本人确认。"}`,
  ].join("\n\n");
}

registerHandler("kb-scout", async (ctx) => {
  const ids = (ctx.run.input.kbIds as string[] | undefined) ?? [];
  const kbs = ids.map((id) => getKb(ctx.app, id)).filter((k): k is KnowledgeBase => !!k && !k.goneAt && (k.status === "new" || k.status === "later"));
  if (!kbs.length) return { quiet: true, summary: "没有待判断的知识库" };
  try {
    const r = await runRole(ctx.app, { role: "kb-scout", spaceId: "personal", spaces: null, task: scoutTask(ctx.app, kbs), runId: ctx.run.id, signal: ctx.signal, onEvent: (e) => ctx.event(e.type, e) });
    run(ctx.app.db, "update runs set profile_id = ? where id = ?", r.profileId, ctx.run.id);
    const made = ids.map((id) => getKb(ctx.app, id)).filter((k): k is KnowledgeBase => !!k && k.proposal?.runId === ctx.run.id);
    notifyProposals(ctx.app, made, ctx.run.id);
    return { summary: r.text.trim(), proposals: made.length };
  } finally {
    const at = now();
    for (const id of ids) run(ctx.app.db, "update wiki_spaces set scouted_at = ? where id = ?", at, id);
    if (!ctx.signal.aborted) scheduleScout(ctx.app, ctx.run.id);
  }
});

const describeProposal = (app: App, kb: KnowledgeBase, p: KbProposal | null = kb.proposal) => {
  if (!p) return "";
  const where = p.action === "create" ? `新建空间「${p.newSpace?.name}」（${p.newSpace?.id}）` : p.action === "map" ? `归入「${findSpace(app, p.space ?? "")?.name ?? p.space}」` : p.action === "ignore" ? "不读" : "先放着";
  return `${where}${p.action === "map" || p.action === "create" ? `，优先级${PRIORITY_LABELS[p.priority]}` : ""}`;
};

/** One notification for a scout run: what was applied (autoApply), or what waits for the owner. */
export function notifyProposals(app: App, made: KnowledgeBase[], runId: string | null) {
  const shown = made.filter((k) => k.proposal && k.proposal.action !== "later");
  if (!shown.length) return;
  const lines = shown.slice(0, 15).map((k) => `- 《${k.name}》：${describeProposal(app, k)}。${k.proposal!.reason}`);
  if (shown.length > 15) lines.push(`- 另有 ${shown.length - 15} 个`);
  const applied = shown.every((k) => k.status !== "proposed");
  notify(app, {
    title: applied ? `飞书知识库：按建议处理了 ${shown.length} 个` : `飞书知识库：${shown.length} 个有归属建议等你确认`,
    body: `${lines.join("\n")}\n\n${applied ? "已归入的每天夜里读一些；要改在原件 → 知识库。" : "在原件 → 知识库确认、改目标或忽略；确认后每天夜里读一些。"}`,
    link: "#/sources/kb",
    runId,
    urgency: applied ? "silent" : "normal",
  });
}

/**
 * Record a proposal for a knowledge base (the scout's tool). An owner's decision is not reopened. With
 * autoApply the proposal takes effect at once (`later` only records the judgement).
 */
export async function proposeMapping(app: App, id: string, p: Pick<KbProposal, "action" | "space" | "newSpace" | "priority" | "level" | "reason">, meta: { by: string; runId: string | null }) {
  const kb = mustKb(app, id);
  if (kb.goneAt) throw new HttpError(409, "这个知识库已经看不到了");
  if ((kb.status === "mapped" || kb.status === "ignored") && kb.decidedBy === "owner") throw new HttpError(409, `本人已经定过（${STATUS_LABELS[kb.status]}），不要再提`);
  const proposal: KbProposal = { ...p, by: meta.by, runId: meta.runId, at: now(), direction: directionHash(app) };
  run(app.db, "update wiki_spaces set proposal = ?, status = ?, updated_at = ? where id = ?", JSON.stringify(proposal), p.action === "later" ? "later" : "proposed", now(), id);
  if (app.config.lark.knowledge?.autoApply && p.action !== "later") {
    const r = await acceptProposal(app, id, "agent");
    return { applied: true, kb: r.kb, crawl: r.crawl, error: r.error };
  }
  return { applied: false, kb: getKb(app, id)! };
}

// ---- the owner's decisions ---------------------------------------------------------------------

export type Mapping = { action: "map" | "create" | "ignore" | "later"; space?: string; newSpace?: NewSpace; priority?: Priority; level?: KbLevel; dailyShare?: number | null };

/** Take the proposal as it stands. */
export async function acceptProposal(app: App, id: string, by: "owner" | "agent") {
  const kb = mustKb(app, id);
  if (!kb.proposal) throw new HttpError(409, "这个知识库还没有建议");
  return applyMapping(app, id, { ...kb.proposal }, by);
}

/**
 * Decide where a knowledge base goes. map / create: the space (created when new; an existing one of
 * the same id is used), its priority and initial level, and a crawl from its top-level nodes that the
 * nightly reading continues. ignore / later: nothing is read; an open crawl stops.
 */
export async function applyMapping(app: App, id: string, m: Mapping, by: "owner" | "agent") {
  const kb = mustKb(app, id);
  const at = now();
  if (m.action === "ignore" || m.action === "later") {
    if (kb.crawlId) stopQuietly(app, kb.crawlId);
    run(app.db, "update wiki_spaces set status = ?, decided_at = ?, decided_by = ?, crawl_id = null, updated_at = ? where id = ?", m.action === "ignore" ? "ignored" : "later", at, by, at, id);
    return { kb: getKb(app, id)!, crawl: null, error: null };
  }
  let target: string;
  if (m.action === "create") {
    const r = newSpaceSchema.safeParse(m.newSpace);
    if (!r.success) throw new HttpError(400, `新空间：${r.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("；")}`);
    const ns = r.data;
    const have = findSpace(app, slugify(ns.id));
    target = have ? have.id : createSpace(app, { id: ns.id, name: ns.name, kind: ns.kind, description: ns.description }).id;
  } else {
    if (!m.space || !findSpace(app, m.space)) throw new HttpError(400, `没有空间 ${m.space ?? "（未填）"}`);
    if (findSpace(app, m.space)!.kind === "repo" || findSpace(app, m.space)!.kind === "worktree") throw new HttpError(400, "知识库不放进代码仓库空间");
    target = m.space;
  }
  if (kb.crawlId && kb.targetSpace && kb.targetSpace !== target) stopQuietly(app, kb.crawlId);
  run(
    app.db,
    `update wiki_spaces set status = 'mapped', target_space = ?, priority = ?, level = ?, daily_share = ?, decided_at = ?, decided_by = ?, paused = 0,
       crawl_id = case when target_space = ? then crawl_id else null end, updated_at = ? where id = ?`,
    target, m.priority ?? kb.proposal?.priority ?? kb.priority, m.level ?? kb.proposal?.level ?? kb.level, m.dailyShare === undefined ? kb.dailyShare : m.dailyShare, at, by, target, at, id,
  );
  const mapped = getKb(app, id)!;
  applyLevel(app, mapped, by);
  let crawl: ReturnType<typeof crawlSummary> | null = null;
  let error: string | null = null;
  try {
    crawl = crawlSummary(await ensureCrawl(app, mapped));
  } catch (e) {
    // The nightly reading tries again.
    error = (e as Error).message.slice(0, 300);
  }
  return { kb: getKb(app, id)!, crawl, error };
}

function stopQuietly(app: App, crawlId: string) {
  try {
    const c = getCrawl(app, crawlId);
    if (c.status === "running" || c.status === "paused") stopCrawl(app, crawlId);
  } catch {}
}

/** The knowledge base's level on its catalog node in the target space (an owner's own choice there is kept). */
function applyLevel(app: App, kb: KnowledgeBase, by: "owner" | "agent") {
  if (!kb.targetSpace || kb.level === "normal") return;
  try {
    setNodeLevel(app, kb.targetSpace, `wiki:${kb.id}`, kb.level, by, { reason: `飞书知识库《${kb.name}》归入时定的初始关注程度`, future: true });
  } catch (e) {
    console.warn(`[omem] 知识库《${kb.name}》的初始关注程度没有设上：${(e as Error).message}`);
  }
}

/** The crawl the nightly reading continues: the open one, a new one when there is none, or again a week after the last finished. */
export async function ensureCrawl(app: App, kb: KnowledgeBase) {
  if (!kb.targetSpace) throw new HttpError(409, "这个知识库还没有归入空间");
  let c: WikiCrawl | null = null;
  if (kb.crawlId) {
    try {
      c = getCrawl(app, kb.crawlId);
    } catch {}
  }
  if (c && c.spaceId === kb.targetSpace && (c.status === "running" || c.status === "paused")) return c;
  if (c && c.spaceId === kb.targetSpace && c.status === "done" && Date.now() - Date.parse(c.updatedAt) < REWALK_MS) return c;
  // A finished or stopped crawl of this knowledge base gives way to the new one (its queue is not kept).
  if (c && (c.status === "done" || c.status === "stopped")) forgetCrawl(app, c.id);
  const s = await startSpaceCrawl(app, { spaceId: kb.targetSpace, wikiSpaceId: kb.id, title: kb.name, origin: knowledgeOrigin(app), batch: Math.max(1, kb.dailyShare ?? 1), by: "lark-knowledge" });
  run(app.db, "update wiki_spaces set crawl_id = ?, updated_at = ? where id = ?", s.id, now(), kb.id);
  return getCrawl(app, s.id);
}

export const kbActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("accept") }),
  z.object({ action: z.literal("map"), space: z.string().min(1).max(80), priority: z.enum(PRIORITIES).optional(), level: z.enum(KB_LEVELS).optional(), dailyShare: z.number().int().min(0).max(2000).nullable().optional() }),
  z.object({ action: z.literal("create"), newSpace: newSpaceSchema, priority: z.enum(PRIORITIES).optional(), level: z.enum(KB_LEVELS).optional(), dailyShare: z.number().int().min(0).max(2000).nullable().optional() }),
  z.object({ action: z.literal("ignore") }),
  z.object({ action: z.literal("later") }),
  /** Back to “not judged yet”: the scout looks at it again. */
  z.object({ action: z.literal("reset") }),
  z.object({ action: z.literal("pause") }),
  z.object({ action: z.literal("resume") }),
  /** Read one batch (its share of the daily budget, or `limit`) now, in the background. */
  z.object({ action: z.literal("read"), limit: z.number().int().min(1).max(500).optional() }),
  z.object({ action: z.literal("update"), priority: z.enum(PRIORITIES).optional(), level: z.enum(KB_LEVELS).optional(), dailyShare: z.number().int().min(0).max(2000).nullable().optional() }),
]);
export type KbAction = z.infer<typeof kbActionSchema>;

/** The owner's action on one knowledge base (web, CLI, peer). Writes only omem's own data; reading stays read-only on Feishu. */
export async function kbAction(app: App, id: string, input: unknown) {
  const parsed = kbActionSchema.safeParse(input);
  if (!parsed.success) throw new HttpError(400, parsed.error.issues.map((i) => `${i.path.join(".") || "action"}: ${i.message}`).join("; "));
  const a = parsed.data;
  const kb = mustKb(app, id);
  const at = now();
  switch (a.action) {
    case "accept":
      return acceptProposal(app, id, "owner");
    case "map":
    case "create":
      return applyMapping(app, id, a, "owner");
    case "ignore":
    case "later":
      return applyMapping(app, id, { action: a.action }, "owner");
    case "reset":
      if (kb.crawlId) stopQuietly(app, kb.crawlId);
      run(app.db, "update wiki_spaces set status = 'new', proposal = null, scouted_at = null, decided_at = null, decided_by = null, crawl_id = null, paused = 0, updated_at = ? where id = ?", at, id);
      return { kb: getKb(app, id)!, scoutRunId: scheduleScout(app) };
    case "pause":
    case "resume":
      if (kb.status !== "mapped") throw new HttpError(409, "只有已归入空间的知识库能暂停或继续");
      run(app.db, "update wiki_spaces set paused = ?, updated_at = ? where id = ?", a.action === "pause" ? 1 : 0, at, id);
      return { kb: getKb(app, id)! };
    case "update": {
      if (kb.status !== "mapped") throw new HttpError(409, "只有已归入空间的知识库能改优先级和份额");
      run(app.db, "update wiki_spaces set priority = coalesce(?, priority), level = coalesce(?, level), daily_share = case when ? then ? else daily_share end, updated_at = ? where id = ?",
        a.priority ?? null, a.level ?? null, a.dailyShare !== undefined ? 1 : 0, a.dailyShare ?? null, at, id);
      const next = getKb(app, id)!;
      if (a.level && a.level !== kb.level) applyLevel(app, next, "owner");
      return { kb: next };
    }
    case "read": {
      if (kb.status !== "mapped") throw new HttpError(409, "这个知识库还没有归入空间");
      const limit = a.limit ?? shareOf(app, kb);
      return { kb, ...startReading(app, { kb: id, limit }) };
    }
  }
}

// ---- nightly reading ---------------------------------------------------------------------------

/**
 * The day's budget split across knowledge bases: a fixed `dailyShare` first (in priority order),
 * the rest by priority weight (high 3, normal 2, low 1), the remainder one by one from the top.
 */
export function splitBudget(kbs: Pick<KnowledgeBase, "id" | "priority" | "dailyShare">[], budget: number): Map<string, number> {
  const out = new Map<string, number>();
  const ordered = [...kbs].sort((a, b) => RANK[a.priority] - RANK[b.priority]);
  let left = Math.max(0, Math.floor(budget));
  for (const k of ordered)
    if (k.dailyShare !== null && k.dailyShare !== undefined) {
      const n = Math.min(k.dailyShare, left);
      out.set(k.id, n);
      left -= n;
    }
  const rest = ordered.filter((k) => k.dailyShare === null || k.dailyShare === undefined);
  const total = rest.reduce((n, k) => n + WEIGHT[k.priority], 0);
  let given = 0;
  for (const k of rest) {
    const n = total ? Math.floor((left * WEIGHT[k.priority]) / total) : 0;
    out.set(k.id, n);
    given += n;
  }
  for (let i = 0; given < left && rest.length; i = (i + 1) % rest.length, given++) out.set(rest[i].id, out.get(rest[i].id)! + 1);
  return out;
}

const readable = (app: App) =>
  all<Row>(app.db, `${ROW} where discovered_at is not null and gone_at is null and status = 'mapped' and target_space is not null`).map(toKb).filter((k) => !!findSpace(app, k.targetSpace!));

/** One knowledge base's share of today's budget (a manual “read now”). */
function shareOf(app: App, kb: KnowledgeBase) {
  const active = readable(app).filter((k) => !k.paused || k.id === kb.id);
  return Math.max(1, splitBudget(active, app.config.lark.knowledge?.dailyDocs ?? 30).get(kb.id) ?? 1);
}

/** The material read yesterday is still waiting to be understood: the next night skips this space. */
function backlog(app: App, spaceId: string) {
  return !!one(app.db, "select 1 from runs where kind = 'ingest' and space_id = ? and status = 'queued' and coalesce(json_extract(input, '$.note'), '') like '飞书知识库%' limit 1", spaceId);
}

export type KbReadResult = { kb: string; name: string; space: string; share: number; read: number; known: number; skipped: number; failed: number; done?: boolean; skippedBecause?: string; error?: string };

async function readOne(app: App, kb: KnowledgeBase, share: number): Promise<KbReadResult> {
  const out: KbReadResult = { kb: kb.id, name: kb.name, space: kb.targetSpace!, share, read: 0, known: 0, skipped: 0, failed: 0 };
  let c: WikiCrawl;
  try {
    c = await ensureCrawl(app, kb);
  } catch (e) {
    return { ...out, error: (e as Error).message.slice(0, 300) };
  }
  if (c.status === "done") return { ...out, done: true };
  if (crawlBusy(c.id)) return { ...out, skippedBecause: "正在读" };
  const before = { read: c.read, known: c.known ?? 0, skipped: c.skipped, failed: c.failed };
  continueCrawl(app, c.id, { batch: share, background: false });
  const after = await crawlLoop(app, c.id);
  Object.assign(out, { read: after.read - before.read, known: (after.known ?? 0) - before.known, skipped: after.skipped - before.skipped, failed: after.failed - before.failed, done: after.status === "done" });
  if (after.status === "paused" && after.errors.length && /缺少飞书权限/.test(after.errors.at(-1) ?? "")) out.error = after.errors.at(-1);
  if (out.read || out.known || out.skipped || out.failed)
    run(app.db, "insert into lark_kb_reads(at, kb_id, space_id, read, known, skipped, failed) values(?,?,?,?,?,?,?)", now(), kb.id, kb.targetSpace!, out.read, out.known, out.skipped, out.failed);
  return out;
}

export type DailyReport = { at: string; budget: number; read: number; results: KbReadResult[]; skipped?: string };

const reading = new WeakMap<App, Promise<DailyReport>>();

/**
 * The nightly reading: `limit` docs (default `dailyDocs`) across the mapped knowledge bases that are
 * not paused (or only `kb`). A knowledge base that runs out of pages leaves its share to the others.
 */
export async function readKnowledgeDaily(app: App, opts: { limit?: number; kb?: string; scheduled?: boolean } = {}): Promise<DailyReport> {
  const running = reading.get(app);
  if (running) await running.catch(() => {});
  const p = readDaily(app, opts);
  reading.set(app, p);
  try {
    return await p;
  } finally {
    if (reading.get(app) === p) reading.delete(app);
  }
}

async function readDaily(app: App, opts: { limit?: number; kb?: string; scheduled?: boolean }): Promise<DailyReport> {
  const budget = Math.max(0, opts.limit ?? app.config.lark.knowledge?.dailyDocs ?? 30);
  const report: DailyReport = { at: now(), budget, read: 0, results: [] };
  let kbs = readable(app).filter((k) => (opts.kb ? k.id === opts.kb : !k.paused));
  if (opts.kb && !kbs.length) throw new HttpError(409, "这个知识库还没有归入空间，或归入的空间已删除");
  if (!budget || !kbs.length) return { ...report, skipped: !budget ? "每天读的篇数是 0" : "没有归入空间的知识库" };
  if (opts.scheduled && !(await cliUser())) return finishDaily(app, { ...report, skipped: "lark-cli 没有本人登录" });
  kbs = kbs.sort((a, b) => RANK[a.priority] - RANK[b.priority]);
  const shares = splitBudget(kbs, budget);
  const exhausted = new Set<string>();
  for (const kb of kbs) {
    const share = shares.get(kb.id) ?? 0;
    if (!share) continue;
    if (!opts.kb && backlog(app, kb.targetSpace!)) {
      report.results.push({ kb: kb.id, name: kb.name, space: kb.targetSpace!, share, read: 0, known: 0, skipped: 0, failed: 0, skippedBecause: "前面读的还没整理完" });
      exhausted.add(kb.id);
      continue;
    }
    const r = await readOne(app, kb, share);
    report.results.push(r);
    report.read += r.read;
    if (r.done || r.error || r.skippedBecause || r.read < share) exhausted.add(kb.id);
  }
  // What a finished knowledge base did not use goes to the others, highest priority first.
  for (const kb of kbs) {
    const left = budget - report.read;
    if (left <= 0) break;
    if (exhausted.has(kb.id) || opts.kb) continue;
    const r = await readOne(app, kb, left);
    report.results.push(r);
    report.read += r.read;
  }
  return finishDaily(app, report);
}

function finishDaily(app: App, report: DailyReport) {
  run(app.db, "insert into kv(key,value) values('lark_kb_last_read', ?) on conflict(key) do update set value = excluded.value", JSON.stringify(report));
  return report;
}
export const lastReading = (app: App) => json<DailyReport | null>(one<{ value: string }>(app.db, "select value from kv where key = 'lark_kb_last_read'")?.value, null);
export const readingRunning = (app: App) => reading.has(app);

/** Reading in the background (a manual “read now”, a peer). */
export function startReading(app: App, opts: { limit?: number; kb?: string } = {}) {
  if (reading.has(app)) return { started: false, running: true };
  void readKnowledgeDaily(app, opts).catch((e) => console.warn(`[omem] 读飞书知识库失败：${(e as Error).message}`));
  return { started: true, running: true };
}

// ---- what there is to see ----------------------------------------------------------------------

export type KbProgress = { nodes: number; captured: number; read: number; known: number; skipped: number; failed: number; lastReadAt: string | null; crawl: { id: string; status: string; queued: number } | null };

/** Knowledge bases found by discovery, with progress (`gone` for those no longer listed). */
export function listKnowledgeBases(app: App, opts: { status?: KbStatus | "gone" | "all" } = {}) {
  const where = opts.status === "gone" ? "gone_at is not null" : opts.status && opts.status !== "all" ? "gone_at is null and status = ?" : opts.status === "all" ? "1" : "gone_at is null";
  const rows = all<Row>(app.db, `${ROW} where discovered_at is not null and ${where} order by name`, ...(opts.status && opts.status !== "all" && opts.status !== "gone" ? [opts.status] : [])).map(toKb);
  const nodes = new Map(all<{ id: string; n: number; c: number }>(app.db, "select wiki_space_id id, count(*) n, sum(source_id is not null) c from wiki_nodes where wiki_space_id is not null group by 1").map((r) => [r.id, r]));
  const reads = new Map(all<{ id: string; read: number; known: number; skipped: number; failed: number; last: string }>(app.db, "select kb_id id, sum(read) read, sum(known) known, sum(skipped) skipped, sum(failed) failed, max(at) last from lark_kb_reads group by 1").map((r) => [r.id, r]));
  return rows.map((kb) => {
    let crawl: KbProgress["crawl"] = null;
    if (kb.crawlId)
      try {
        const c = getCrawl(app, kb.crawlId);
        crawl = { id: c.id, status: c.status, queued: c.queue.length };
      } catch {}
    const n = nodes.get(kb.id);
    const r = reads.get(kb.id);
    const progress: KbProgress = { nodes: n?.n ?? 0, captured: n?.c ?? 0, read: r?.read ?? 0, known: r?.known ?? 0, skipped: r?.skipped ?? 0, failed: r?.failed ?? 0, lastReadAt: r?.last ?? null, crawl };
    return { ...kb, progress };
  });
}

/** Counts by status, discovery and the last night's reading, for the view, a peer and the CLI. */
export function knowledgeOverview(app: App) {
  const counts = Object.fromEntries(KB_STATUSES.map((s) => [s, 0])) as Record<KbStatus, number> & { gone: number };
  counts.gone = 0;
  for (const r of all<{ status: string; gone: number; n: number }>(app.db, "select status, gone_at is not null gone, count(*) n from wiki_spaces where discovered_at is not null group by 1, 2")) {
    if (r.gone) counts.gone += r.n;
    else if (r.status in counts) counts[r.status as KbStatus] += r.n;
  }
  return { counts, discovery: { running: discoveryRunning(app), last: lastDiscovery(app) }, reading: { running: readingRunning(app), last: lastReading(app) }, settings: app.config.lark.knowledge };
}

/** “From the knowledge bases since <since>: N docs (space X a, Y b)”, for the brief; empty when nothing was read. */
export function readsSince(app: App, since: string) {
  const rows = all<{ space_id: string; n: number }>(app.db, "select space_id, sum(read) n from lark_kb_reads where at > ? group by 1 having n > 0 order by n desc", since);
  const total = rows.reduce((n, r) => n + r.n, 0);
  if (!total) return "";
  return `从飞书知识库读了 ${total} 篇（${rows.map((r) => `${findSpace(app, r.space_id)?.name ?? r.space_id} ${r.n} 篇`).join("、")}）`;
}
