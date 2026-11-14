import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { notify } from "../core/notify.ts";
import { findSpace, relatedIds } from "../core/spaces.ts";
import { OWNER, scopeFor } from "../core/users.ts";
import { json, newId, now, truncate } from "../core/util.ts";
import { createRun, registerHandler, type RunContext } from "../agents/runs.ts";
import { readPage } from "../wiki/store.ts";
import { checkPublished, type Finding } from "../wiki/verify.ts";

/**
 * The nightly audit: nobody reads everything the agents write on their own, so a sample of it is
 * checked every night and each kind of run gets a figure.
 *
 * - What: Wiki pages whose latest version an agent wrote outside a checked writing run — while taking
 *   material in, fixing pages after a source changed, distilling, answering (page_writes says who
 *   wrote what). Pages written by `wiki-write` were checked before they were saved and are left out.
 * - Which: pages written by a run another of whose pages was found wrong, or was corrected by the
 *   owner, come first; then pages that runs which answer or act actually read (page_reads); the rest
 *   at random. At most `max` a night and `perPipeline` from one kind of run.
 * - How: the `wiki-checker` role reads the published page with the lines it cites and the code, as
 *   it does for a draft (wiki/verify.ts checkPublished), on its own AI. Findings about facts (cite,
 *   code, negative, conflict) make the page `wrong`; findings about the writing only, `style`.
 * - Then: wrong pages go back to a writer with the findings (`fix`), through the usual checked
 *   writing run. A kind of run whose share of pages without factual findings over the last `days`
 *   falls below `threshold` (with at least `minSamples` judged) is flagged: every page it writes is
 *   audited (up to `strictMax` a night) until the share is back. The owner gets one message: the
 *   figures, the wrong pages, and any change of flags.
 *
 * docs/v2/quality.md.
 */

/** Findings about what the page says; the others are about how it is written. */
const FACT_KINDS = new Set(["cite", "code", "negative", "conflict"]);
/** How far back a run's wrong page or the owner's correction sends its other pages to the front. */
const SIBLING_DAYS = 7;
const READ_DAYS = 14;
const FLAGGED = "quality_flagged";

export type Verdict = "ok" | "style" | "wrong" | "unchecked";

export function verdictOf(findings: Finding[] | null): { verdict: Verdict; wrong: number; style: number } {
  if (!findings) return { verdict: "unchecked", wrong: 0, style: 0 };
  const wrong = findings.filter((f) => FACT_KINDS.has(f.kind)).length;
  const style = findings.length - wrong;
  return { verdict: wrong ? "wrong" : style ? "style" : "ok", wrong, style };
}

export type Candidate = {
  spaceId: string;
  slug: string;
  writtenAt: string;
  /** The kind of run that wrote it (`external` for a write outside any run). */
  pipeline: string;
  runId: string | null;
  ai: string;
  reads: number;
  /** 0 a sibling of a wrong page, 1 of a page the owner corrected, 2 read by answering runs, 3 the rest. */
  rank: number;
  why: string;
};

const daysAgo = (at: number, days: number) => new Date(at - days * 86400_000).toISOString();

/** Pages an agent wrote lately on its own that no audit has looked at in this version (one the checker did not finish gets a second try, not a third). */
export function auditCandidates(app: App, at = Date.now()): Candidate[] {
  const cfg = app.config.quality.audit;
  const rows = all<{ space_id: string; slug: string; at: string; run_id: string | null; kind: string | null; ai: string | null }>(
    app.db,
    `select w.space_id, w.slug, w.at, w.run_id, r.kind, r.ai from page_writes w left join runs r on r.id = w.run_id
     where w.at > ? and w.actor = 'agent'
       and w.id = (select max(x.id) from page_writes x where x.space_id = w.space_id and x.slug = w.slug)
       and not exists (select 1 from quality_audits a where a.space_id = w.space_id and a.target = w.slug and a.written_at >= w.at and a.verdict != 'unchecked')
       and (select count(*) from quality_audits a where a.space_id = w.space_id and a.target = w.slug and a.written_at >= w.at and a.verdict = 'unchecked') < 2`,
    daysAgo(at, cfg.lookbackDays),
  ).filter((r) => r.kind !== "wiki-write" && r.kind !== "quality-audit");
  if (!rows.length) return [];
  const kinds = new Map(all<{ space_id: string; slug: string; kind: string | null }>(app.db, "select space_id, slug, kind from pages").map((p) => [`${p.space_id}/${p.slug}`, p.kind ?? "page"]));
  const reads = new Map(
    all<{ space_id: string; slug: string; n: number }>(app.db, "select space_id, slug, sum(n) n from page_reads where day >= ? group by space_id, slug", daysAgo(at, READ_DAYS).slice(0, 10)).map((r) => [`${r.space_id}/${r.slug}`, r.n]),
  );
  const since = daysAgo(at, SIBLING_DAYS);
  const wrongRuns = new Set(all<{ writer_run: string }>(app.db, "select distinct writer_run from quality_audits where verdict = 'wrong' and writer_run is not null and at > ?", since).map((r) => r.writer_run));
  const correctedRuns = new Set(
    all<{ run_id: string }>(
      app.db,
      `select distinct a.run_id from page_writes a join page_writes u on u.space_id = a.space_id and u.slug = a.slug and u.actor = 'user' and u.at > a.at
       where a.actor = 'agent' and a.run_id is not null and u.at > ?`,
      since,
    ).map((r) => r.run_id),
  );
  const out: Candidate[] = [];
  for (const r of rows) {
    const key = `${r.space_id}/${r.slug}`;
    const kind = kinds.get(key);
    // Gone since, an index, a running log (work state, a people card's history): nothing to check against sources.
    if (!kind || kind === "index" || kind === "log" || r.slug === "index" || r.slug.endsWith("/index")) continue;
    if (findSpace(app, r.space_id)?.kind === "worktree") continue;
    const n = reads.get(key) ?? 0;
    const sibling = r.run_id && wrongRuns.has(r.run_id) ? 0 : r.run_id && correctedRuns.has(r.run_id) ? 1 : n > 0 ? 2 : 3;
    out.push({
      spaceId: r.space_id,
      slug: r.slug,
      writtenAt: r.at,
      pipeline: r.kind ?? "external",
      runId: r.run_id,
      ai: aiName(r.ai),
      reads: n,
      rank: sibling,
      why: ["同一次运行写的另一页抽检出了事实问题", "本人改过同一次运行写的另一页", `近 ${READ_DAYS} 天被读过 ${n} 次`, "随机抽到"][sibling],
    });
  }
  return out;
}

function aiName(ai: string | null) {
  const v = json<{ profile?: string; model?: string }>(ai ?? "", {});
  return [v.profile, v.model].filter(Boolean).join(" · ");
}

/**
 * Tonight's sample. Flagged kinds of run are audited in full (up to `strictMax` pages in all); the
 * others share `max`, at most `perPipeline` each — except pages that came to the front because a
 * sibling was wrong or corrected, which are taken while `max` lasts.
 */
export function pickSamples(cands: Candidate[], opts: { max: number; perPipeline: number; strictMax: number; flagged: Set<string> }, rand: () => number = Math.random): Candidate[] {
  const order = cands.map((c) => ({ c, r: rand() })).sort((a, b) => a.c.rank - b.c.rank || b.c.reads - a.c.reads || a.r - b.r).map((x) => x.c);
  const per = new Map<string, number>();
  const taken: Candidate[] = [];
  let normal = 0;
  let strict = 0;
  for (const c of order) {
    const n = per.get(c.pipeline) ?? 0;
    if (opts.flagged.has(c.pipeline)) {
      if (strict >= opts.strictMax) continue;
      strict++;
      taken.push(c.rank < 2 ? c : { ...c, why: `这类运行写的页面在加严，每页都看；${c.why}` });
    } else {
      if (normal >= opts.max || (c.rank >= 2 && n >= opts.perPipeline)) continue;
      normal++;
      taken.push(c);
    }
    per.set(c.pipeline, n + 1);
  }
  return taken;
}

// ------------------------------------------------------------------ figures and flags

export type PipelineStats = {
  pipeline: string;
  audited: number;
  ok: number;
  style: number;
  wrong: number;
  unchecked: number;
  /** Pages without factual findings among those the checker finished; null when none was. */
  accuracy: number | null;
  flagged: boolean;
};

export const flaggedPipelines = (app: App): string[] => json<string[]>(one<{ value: string }>(app.db, "select value from kv where key = ?", FLAGGED)?.value ?? "", []);

export function pipelineStats(app: App, at = Date.now()): PipelineStats[] {
  const flagged = new Set(flaggedPipelines(app));
  return all<{ pipeline: string; audited: number; ok: number; style: number; wrong: number; unchecked: number }>(
    app.db,
    `select pipeline, count(*) audited, sum(verdict = 'ok') ok, sum(verdict = 'style') style, sum(verdict = 'wrong') wrong, sum(verdict = 'unchecked') unchecked
     from quality_audits where at > ? group by pipeline order by audited desc`,
    daysAgo(at, app.config.quality.audit.days),
  ).map((r) => {
    const judged = r.ok + r.style + r.wrong;
    return { ...r, accuracy: judged ? (r.ok + r.style) / judged : null, flagged: flagged.has(r.pipeline) };
  });
}

/** Flags follow the figures: on below the threshold, off once back at it, both only with enough judged pages. */
export function updateFlags(app: App, at = Date.now()): { flagged: string[]; added: PipelineStats[]; cleared: PipelineStats[] } {
  const cfg = app.config.quality.audit;
  const before = new Set(flaggedPipelines(app));
  const after = new Set(before);
  const added: PipelineStats[] = [];
  const cleared: PipelineStats[] = [];
  for (const s of pipelineStats(app, at)) {
    if (s.accuracy === null || s.ok + s.style + s.wrong < cfg.minSamples) continue;
    if (s.accuracy < cfg.threshold && !before.has(s.pipeline)) after.add(s.pipeline), added.push(s);
    if (s.accuracy >= cfg.threshold && before.has(s.pipeline)) after.delete(s.pipeline), cleared.push(s);
  }
  const flagged = [...after].sort();
  run(app.db, "insert into kv(key,value) values(?, ?) on conflict(key) do update set value = excluded.value", FLAGGED, JSON.stringify(flagged));
  return { flagged, added, cleared };
}

// ------------------------------------------------------------------ the run

export type AuditRow = {
  id: string;
  at: string;
  pipeline: string;
  spaceId: string;
  target: string;
  writtenAt: string;
  writerRun: string | null;
  writerAi: string;
  checkerAi: string;
  auditRun: string | null;
  verdict: Verdict;
  wrong: number;
  style: number;
  findings: Finding[];
  why: string;
  fixRun: string | null;
};

type Row = { id: string; at: string; pipeline: string; space_id: string; target: string; written_at: string; writer_run: string | null; writer_ai: string | null; checker_ai: string | null; audit_run: string | null; verdict: string; wrong: number; style: number; findings: string; why: string; fix_run: string | null };
const toAudit = (r: Row): AuditRow => ({
  id: r.id, at: r.at, pipeline: r.pipeline, spaceId: r.space_id, target: r.target, writtenAt: r.written_at, writerRun: r.writer_run, writerAi: r.writer_ai ?? "", checkerAi: r.checker_ai ?? "",
  auditRun: r.audit_run, verdict: r.verdict as Verdict, wrong: r.wrong, style: r.style, findings: json<Finding[]>(r.findings, []), why: r.why, fixRun: r.fix_run,
});

export function recentAudits(app: App, limit = 60): AuditRow[] {
  return all<Row>(app.db, "select * from quality_audits order by at desc limit ?", Math.max(1, Math.min(limit, 500))).map(toAudit);
}

/** What the quality page shows. */
export function qualityOverview(app: App) {
  return { settings: app.config.quality.audit, pipelines: pipelineStats(app), flagged: flaggedPipelines(app), recent: recentAudits(app), waiting: auditCandidates(app).length };
}


/** Queue tonight's audit when there is something to look at and none is under way. */
export function scheduleAudit(app: App) {
  if (!app.config.quality.audit.enabled) return null;
  if (one(app.db, "select 1 from runs where kind = 'quality-audit' and status in ('queued', 'running') limit 1")) return null;
  if (!auditCandidates(app).length) return null;
  return createRun(app, { kind: "quality-audit", spaceId: "personal", title: "抽检昨天写的页面" });
}

registerHandler("quality-audit", async (ctx: RunContext) => {
  const app = ctx.app;
  const cfg = app.config.quality.audit;
  const picks = pickSamples(auditCandidates(app), { max: cfg.max, perPipeline: cfg.perPipeline, strictMax: cfg.strictMax, flagged: new Set(flaggedPipelines(app)) });
  if (!picks.length) return { quiet: true, summary: "没有要抽检的页面" };
  const done: AuditRow[] = [];
  for (const c of picks) {
    if (ctx.signal.aborted) break;
    let page;
    try {
      page = readPage(app, c.spaceId, c.slug);
    } catch {
      continue;
    }
    ctx.event("status", { text: `抽检 ${c.spaceId}/${c.slug}（${c.pipeline} 写的；${c.why}）` });
    const scope = [...new Set([c.spaceId, ...relatedIds(app, c.spaceId)])];
    let got: Awaited<ReturnType<typeof checkPublished>> = null;
    try {
      got = await checkPublished(ctx, c.spaceId, { slug: page.slug, title: page.meta.title, summary: page.meta.summary ?? "", kind: page.meta.kind ?? "page", body: page.body }, scopeFor(app, OWNER, scope) ?? scope);
    } catch (e) {
      if (ctx.signal.aborted) throw e;
      ctx.event("status", { text: `这一页没核完：${truncate((e as Error).message, 160)}` });
    }
    const v = verdictOf(got?.findings ?? null);
    const row: AuditRow = {
      id: newId("qa"), at: now(), pipeline: c.pipeline, spaceId: c.spaceId, target: page.slug, writtenAt: c.writtenAt, writerRun: c.runId, writerAi: c.ai, checkerAi: got?.ai ?? "",
      auditRun: ctx.run.id, verdict: v.verdict, wrong: v.wrong, style: v.style, findings: got?.findings ?? [], why: c.why, fixRun: null,
    };
    run(
      app.db,
      "insert into quality_audits(id, at, pipeline, space_id, target, written_at, writer_run, writer_ai, checker_ai, audit_run, verdict, wrong, style, findings, why) values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      row.id, row.at, row.pipeline, row.spaceId, row.target, row.writtenAt, row.writerRun, row.writerAi, row.checkerAi, row.auditRun, row.verdict, row.wrong, row.style, JSON.stringify(row.findings), row.why,
    );
    done.push(row);
    ctx.event("status", { text: v.verdict === "ok" ? "没有问题" : v.verdict === "unchecked" ? "没核完" : `${v.wrong} 处事实问题，${v.style} 处写法问题` });
  }
  const fixing = cfg.fix === "off" ? [] : await sendBack(ctx, done.filter((r) => r.verdict === "wrong" || (cfg.fix === "all" && r.verdict === "style")));
  const flags = updateFlags(app);
  const text = reportText(app, done, fixing.length, flags);
  const count = (v: Verdict) => done.filter((r) => r.verdict === v).length;
  try {
    notify(app, {
      title: count("wrong") ? `抽检 ${done.length} 页，${count("wrong")} 页有事实问题` : `抽检 ${done.length} 页，没有事实问题`,
      body: text,
      link: "#/quality",
      runId: ctx.run.id,
      // Nothing wrong and no flag changed: on the web only.
      urgency: count("wrong") || flags.added.length || flags.cleared.length ? "normal" : "silent",
    });
  } catch (e) {
    console.warn(`[omem] 抽检报告发送失败：${(e as Error).message}`);
  }
  return { summary: text, audited: done.length, ok: count("ok"), style: count("style"), wrong: count("wrong"), unchecked: count("unchecked"), fixing: fixing.length, flagged: flags.flagged };
});

/** Wrong pages go back to a writer with what was found, a space at a time (one generation, one report). */
async function sendBack(ctx: RunContext, rows: AuditRow[]): Promise<AuditRow[]> {
  const app = ctx.app;
  const { sendPagesBack } = await import("../wiki/generate.ts");
  const sent: AuditRow[] = [];
  for (const spaceId of new Set(rows.map((r) => r.spaceId))) {
    const here = rows.filter((r) => r.spaceId === spaceId);
    const focus = "夜间抽检在下面几页里发现了问题。你负责的是任务开头写的那一页：只改它名下列出的这些，事实以原件和代码为准，其余内容原样保留；别的页不用管。";
    try {
      const g = sendPagesBack(app, { spaceId, pages: here.map((r) => ({ slug: r.target, findings: r.findings })), focus, parentId: ctx.run.id });
      here.forEach((r, i) => {
        r.fixRun = g.writeRuns?.[i] ?? null;
        run(app.db, "update quality_audits set fix_run = ? where id = ?", r.fixRun, r.id);
      });
      sent.push(...here);
    } catch (e) {
      ctx.event("status", { text: `空间 ${spaceId} 的页面没能交回修改：${truncate((e as Error).message, 160)}` });
    }
  }
  return sent;
}

const pct = (x: number | null) => (x === null ? "—" : `${Math.round(x * 100)}%`);

export function reportText(app: App, done: AuditRow[], fixing: number, flags: { added: PipelineStats[]; cleared: PipelineStats[] }) {
  const cfg = app.config.quality.audit;
  const n = (v: Verdict) => done.filter((r) => r.verdict === v).length;
  const lines = [
    `抽检了 ${done.length} 页：${n("wrong")} 页有事实问题${fixing ? `（${fixing} 页已交回修改）` : ""}，${n("style")} 页只有写法问题，${n("ok")} 页没有问题${n("unchecked") ? `，${n("unchecked")} 页没核完` : ""}。`,
    ...done.filter((r) => r.verdict === "wrong").map((r) => `- [[${r.spaceId}:${r.target}]]（${r.pipeline} 写的）：${truncate(r.findings.find((f) => FACT_KINDS.has(f.kind))?.problem ?? "", 120)}`),
  ];
  const stats = pipelineStats(app).filter((s) => s.accuracy !== null);
  if (stats.length) lines.push(`近 ${cfg.days} 天没有事实问题的比例：${stats.map((s) => `${s.pipeline} ${pct(s.accuracy)}（${s.ok + s.style + s.wrong} 页）`).join("，")}。`);
  for (const s of flags.added) lines.push(`${s.pipeline} 写的页面近 ${cfg.days} 天 ${s.ok + s.style + s.wrong} 页里 ${s.wrong} 页有事实问题，低于 ${pct(cfg.threshold)}：从现在起它写的每一页都核（每晚最多 ${cfg.strictMax} 页），回到 ${pct(cfg.threshold)} 以上再恢复抽检。`);
  for (const s of flags.cleared) lines.push(`${s.pipeline} 写的页面回到 ${pct(s.accuracy)}，恢复抽检。`);
  return lines.join("\n");
}
