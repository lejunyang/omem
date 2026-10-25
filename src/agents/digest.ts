import { z } from "zod";
import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { notify } from "../core/notify.ts";
import { getSpace } from "../core/spaces.ts";
import { HttpError, json, newId, now, truncate } from "../core/util.ts";
import { filterSql, LEVEL_LABELS, sourceFilter, sourceNotes, noteText, type Level, type SourceFilter } from "../sources/attention.ts";
import { executionSchema, type Execution } from "./execution.ts";
import { runRole } from "./runner.ts";
import { createRun, getRun, registerHandler } from "./runs.ts";
import { readAgentSpec } from "./specs.ts";

/**
 * Working through material already stored, in batches, by a job the owner (or the assistant on the
 * owner's word) starts. New material is digested as it arrives (ingest); the backlog — months of
 * backfilled chats, a whole Feishu wiki imported at once — needs its own pace and order:
 *
 * - triage: an Agent (triager) reads titles, paths and the head of each source, and gives it a level
 *   (focus / normal / reference / ignore) so search and later digestion know what matters.
 * - digest: an Agent (distiller) reads the sources in full, most important first, and turns them into
 *   knowledge: topic and case pages, notes on outdated / key parts of the source, memories (for one
 *   Agent profile when the job names it, e.g. an on-call investigator's experience).
 *
 * A job runs `parallel` batches at a time (each on whichever of the role's models has room, see
 * capacity.ts); the `digest` schedule (every 10 minutes) and each finished batch queue the next.
 * A digest batch carries the sources' text in the task, so the Agent reads a large batch in one go.
 * Sources done are remembered with their hash, so a changed source is read again.
 */

export const digestInput = z.object({
  mode: z.enum(["triage", "digest"]),
  space: z.string(),
  filter: sourceFilter.omit({ space: true }).default({}),
  /** What the owner wants out of it, in the owner's words. */
  goal: z.string().max(4000).default(""),
  /** Agent profile (or built-in role) whose experience the digest writes. */
  agent: z.string().optional(),
  execution: executionSchema.optional(),
  /** Most sources per batch. */
  batch: z.number().int().min(1).max(300).optional(),
  /** Characters of source text per digest batch (the text goes into the task). */
  chars: z.number().int().min(10_000).max(600_000).optional(),
  /** Batches at a time. */
  parallel: z.number().int().min(1).max(16).optional(),
  /** Start only once this job is no longer active or paused (e.g. digest after the triage of the same material). */
  after: z.string().optional(),
  title: z.string().max(80).optional(),
});
export type DigestInput = z.infer<typeof digestInput>;
type JobRow = { id: string; space_id: string; mode: "triage" | "digest"; body: string; status: string; total: number; done: number; run_id: string | null; created_at: string; updated_at: string };
export type DigestJob = Omit<JobRow, "body" | "space_id" | "run_id" | "created_at" | "updated_at"> & { spaceId: string; runId: string | null; createdAt: string; updatedAt: string; body: DigestInput & { failures?: number } };

const toJob = (r: JobRow): DigestJob => ({ id: r.id, spaceId: r.space_id, mode: r.mode, status: r.status, total: r.total, done: r.done, runId: r.run_id, createdAt: r.created_at, updatedAt: r.updated_at, body: json(r.body, {} as DigestInput) });

const TRIAGE_BATCH = 150;
const DIGEST_CHARS = 150_000;
const DIGEST_MAX = 40;
const MAX_FAILURES = 3;

/** Which sources a job covers: its filter in its space; a digest skips reference and ignore. */
function pendingSql(job: DigestJob, keepDone = false) {
  const f: SourceFilter = { ...job.body.filter, space: job.spaceId };
  const w = filterSql(f);
  const skip = job.mode === "digest" ? "(s.attention is null or s.attention in ('focus'))" : "(s.attention_by is null or s.attention_by != 'owner')";
  return {
    from: `from sources s left join digest_done d on d.job_id = ? and d.source_id = s.id where ${w.sql} and (${skip}${keepDone ? " or d.source_id is not null" : ""})`,
    params: [job.id, ...w.params],
    skip,
  };
}

/** Progress: sources this job already did count even when the batch then lowered their level. */
export function countDigest(app: App, job: DigestJob) {
  const q = pendingSql(job, true);
  const r = one<{ total: number; pending: number | null }>(app.db, `select count(*) total, sum((d.source_id is null or d.hash != s.hash) and ${q.skip}) pending ${q.from}`, ...q.params)!;
  return { total: r.total, left: r.pending ?? 0 };
}

export function createDigestJob(app: App, input: unknown) {
  const body = digestInput.parse(input);
  getSpace(app, body.space);
  if (body.agent) readAgentSpec(app, body.agent);
  const id = newId("dj");
  const at = now();
  run(app.db, "insert into digest_jobs(id, space_id, mode, body, created_at, updated_at) values(?,?,?,?,?,?)", id, body.space, body.mode, JSON.stringify(body), at, at);
  const job = getDigestJob(app, id);
  const c = countDigest(app, job);
  run(app.db, "update digest_jobs set total = ?, done = ? where id = ?", c.total, c.total - c.left, id);
  queueNextBatch(app, id);
  return getDigestJob(app, id);
}

export function getDigestJob(app: App, id: string) {
  const r = one<JobRow>(app.db, "select * from digest_jobs where id = ?", id);
  if (!r) throw new HttpError(404, `没有整理任务 ${id}`);
  return toJob(r);
}

/** Batches queued or running now, for the web list. */
export function inflightCount(app: App, jobId: string) {
  return inflight(app, jobId).length;
}

export function listDigestJobs(app: App, opts: { space?: string; all?: boolean } = {}) {
  return all<JobRow>(app.db, `select * from digest_jobs where 1=1 ${opts.space ? "and space_id = ?" : ""} ${opts.all ? "" : "and status in ('active','paused')"} order by created_at desc limit 100`, ...(opts.space ? [opts.space] : [])).map(toJob);
}

export function setDigestStatus(app: App, id: string, status: "active" | "paused" | "stopped") {
  const job = getDigestJob(app, id);
  const body = status === "active" ? { ...job.body, failures: 0 } : job.body;
  run(app.db, "update digest_jobs set status = ?, body = ?, updated_at = ? where id = ?", status, JSON.stringify(body), now(), id);
  if (status === "active") queueNextBatch(app, id);
  return getDigestJob(app, id);
}

/** Batches of a job that are queued or running, with the sources each one took. */
function inflight(app: App, jobId: string) {
  return all<{ id: string; input: string }>(app.db, "select id, input from runs where kind in ('triage', 'digest') and status in ('queued', 'running') and json_extract(input, '$.jobId') = ?", jobId)
    .map((r) => ({ id: r.id, sourceIds: json<{ sourceIds?: string[] }>(r.input, {}).sourceIds ?? [] }));
}

/** The next sources of a job, leaving out those other batches took: focus first, then the most recently updated. */
function nextBatch(app: App, job: DigestJob, taken: Set<string>) {
  const q = pendingSql(job);
  const rows = all<{ id: string; size: number }>(
    app.db,
    `select s.id, length(s.text) size ${q.from} and (d.source_id is null or d.hash != s.hash) order by s.attention = 'focus' desc, s.updated_at desc limit ?`,
    ...q.params,
    400 + taken.size,
  ).filter((r) => !taken.has(r.id));
  if (job.mode === "triage") return rows.slice(0, job.body.batch ?? TRIAGE_BATCH).map((r) => r.id);
  const max = job.body.batch ?? DIGEST_MAX;
  const budget = job.body.chars ?? DIGEST_CHARS;
  const out: string[] = [];
  let chars = 0;
  for (const r of rows) {
    if (out.length && (chars + r.size > budget || out.length >= max)) break;
    out.push(r.id);
    chars += r.size;
  }
  return out;
}

/**
 * Queue batches until the job has `parallel` in flight, or nothing is left. Returns the new runs.
 * `finishing` is the batch calling this as it ends (still marked running).
 */
export function queueNextBatch(app: App, id: string, finishing?: string) {
  const job = getDigestJob(app, id);
  if (job.status !== "active") return [];
  if (job.body.after) {
    const before = one<{ status: string }>(app.db, "select status from digest_jobs where id = ?", job.body.after);
    if (before && ["active", "paused"].includes(before.status)) return [];
  }
  const running = inflight(app, id).filter((r) => r.id !== finishing);
  const taken = new Set(running.flatMap((r) => r.sourceIds));
  const c = countDigest(app, job);
  const queued = [];
  let done = c.total - c.left;
  while (running.length + queued.length < (job.body.parallel ?? 1)) {
    const ids = nextBatch(app, job, taken);
    if (!ids.length) break;
    for (const s of ids) taken.add(s);
    const r = createRun(app, {
      kind: job.mode === "triage" ? "triage" : "digest",
      spaceId: job.spaceId,
      title: `${job.mode === "triage" ? "分级" : "整理存量"}：${truncate(job.body.title ?? describeJob(job), 50)}（${done + 1}–${done + ids.length} / ${c.total}）`,
      input: { jobId: id, sourceIds: ids },
    });
    done += ids.length;
    queued.push(r);
  }
  if (!running.length && !queued.length) {
    run(app.db, "update digest_jobs set status = 'done', run_id = null, total = ?, done = ?, updated_at = ? where id = ?", c.total, c.total, now(), id);
    notify(app, { title: `整理任务完成：${job.body.title ?? describeJob(job)}`, body: `共 ${c.total} 份材料`, link: "#/sources" });
    // Jobs waiting for this one start now rather than at the next schedule tick.
    for (const j of listDigestJobs(app)) if (j.body.after === id) queueNextBatch(app, j.id);
    return [];
  }
  const latest = queued.at(-1)?.id ?? running.at(-1)?.id ?? null;
  run(app.db, "update digest_jobs set run_id = ?, total = ?, done = ?, updated_at = ? where id = ?", latest, c.total, c.total - c.left, now(), id);
  return queued;
}

/** Change a running job's pace: batches at a time, sources and characters per batch. */
export function updateDigestJob(app: App, id: string, patch: unknown) {
  const p = Object.fromEntries(Object.entries(digestInput.pick({ parallel: true, batch: true, chars: true, after: true }).partial().parse(patch)).filter(([, v]) => v !== undefined));
  const job = getDigestJob(app, id);
  run(app.db, "update digest_jobs set body = ?, updated_at = ? where id = ?", JSON.stringify({ ...job.body, ...p }), now(), id);
  queueNextBatch(app, id);
  return getDigestJob(app, id);
}

/** Every active job gets its next batch (the schedule; restarts and failed batches resume here). */
export function tickDigestJobs(app: App) {
  for (const j of listDigestJobs(app)) if (j.status === "active") queueNextBatch(app, j.id);
}

export function describeJob(job: DigestJob) {
  const f = job.body.filter;
  const what = [f.title_contains && `标题含“${f.title_contains}”`, f.wiki_path_contains && `知识库目录含“${f.wiki_path_contains}”`, f.chat_id && `会话 ${f.chat_id}`, f.kind, f.level && LEVEL_LABELS[f.level]].filter(Boolean).join("、");
  return `${job.spaceId}${what ? ` · ${what}` : ""}`;
}

// ---- the batch runs ----------------------------------------------------------------------------

function sourceLines(app: App, ids: string[], head: number) {
  return ids.map((id) => {
    const s = one<{ id: string; kind: string; title: string; uri: string; meta: string; attention: string | null; attention_by: string | null; updated_at: string; text: string }>(
      app.db, "select id, kind, title, uri, meta, attention, attention_by, updated_at, text from sources where id = ?", id);
    if (!s) return "";
    const meta = json<Record<string, unknown>>(s.meta, {});
    const where = [meta.wikiSpaceName, meta.wikiPath].filter(Boolean).join(" / ");
    const lines = s.text.split("\n").length;
    const level = s.attention ? `，现在：${LEVEL_LABELS[s.attention as Level]}${s.attention_by === "owner" ? "（本人定的）" : ""}` : "";
    const notes = sourceNotes(app, id);
    const top = head ? `\n  开头：${truncate(s.text.slice(0, head).replace(/\s+/g, " "), head)}` : "";
    return `- ${s.id} 〔${s.kind}〕${s.title}${where ? `（${where}）` : ""} · ${lines} 行 · 更新于 ${s.updated_at.slice(0, 10)}${level}${notes.length ? `\n  已有标注：${notes.map(noteText).join(" ")}` : ""}${top}`;
  }).filter(Boolean).join("\n");
}

/**
 * The sources' text for the task, numbered by line, within the budget; what does not fit says how
 * many lines are left to read with read_source.
 */
function sourceBodies(app: App, ids: string[], budget: number) {
  let left = budget;
  return ids.map((id) => {
    const s = one<{ id: string; title: string; text: string }>(app.db, "select id, title, text from sources where id = ?", id);
    if (!s) return "";
    const lines = s.text.split("\n");
    const out: string[] = [];
    for (let i = 0; i < lines.length && left > 0; i++) {
      out.push(`${i + 1}│${lines[i]}`);
      left -= lines[i].length + 1;
    }
    const rest = lines.length - out.length;
    const more = rest ? `\n…（还有 ${rest} 行没附上，需要时 read_source(${s.id}) 从第 ${out.length + 1} 行读）` : "";
    return `### ${s.id} ${s.title}\n\n${out.join("\n")}${more}`;
  }).filter(Boolean).join("\n\n");
}

async function runBatch(ctx: Parameters<Parameters<typeof registerHandler>[1]>[0], mode: "triage" | "digest") {
  const { jobId, sourceIds } = ctx.run.input as { jobId: string; sourceIds: string[] };
  const job = getDigestJob(ctx.app, jobId);
  const b = job.body;
  const goal = b.goal ? `\n\n## 本人要的\n\n${b.goal}` : "";
  const forAgent = b.agent ? `\n\n## 经验写给谁\n\n这批材料的经验（遇到 X 先看 Y、某类问题的判断方法）写成 \`${b.agent}\` 的专属记忆：\`remember(kind="experience", agent="${b.agent}", …)\`；案例写成页面（\`cases/<主题>\`），记忆里链接到它。` : "";
  const task = mode === "triage"
    ? `给下面 ${sourceIds.length} 份材料分级（空间 ${job.spaceId}）。${goal}\n\n## 材料\n\n${sourceLines(ctx.app, sourceIds, 300)}`
    : `整理下面 ${sourceIds.length} 份已经入库的材料（空间 ${job.spaceId}）。${goal}${forAgent}\n\n## 材料（重点关注的在前）\n\n${sourceLines(ctx.app, sourceIds, 0)}\n\n## 正文（带行号，标注时用这些行号）\n\n${sourceBodies(ctx.app, sourceIds, b.chars ?? DIGEST_CHARS)}`;
  let ok = false;
  try {
    const r = await runRole(ctx.app, {
      role: mode === "triage" ? "triager" : "distiller",
      execution: b.execution as Execution | undefined,
      spaceId: job.spaceId,
      spaces: [job.spaceId],
      task,
      runId: ctx.run.id,
      signal: ctx.signal,
      onEvent: (e) => ctx.event(e.type, e),
    });
    run(ctx.app.db, "update runs set profile_id = ? where id = ?", r.profileId, ctx.run.id);
    ok = true;
    return { summary: r.text.trim(), quiet: /^\s*QUIET\s*$/i.test(r.text) };
  } finally {
    const at = now();
    if (ok) {
      for (const id of sourceIds) {
        const h = one<{ hash: string }>(ctx.app.db, "select hash from sources where id = ?", id);
        if (h) run(ctx.app.db, "insert into digest_done(job_id, source_id, hash, at) values(?,?,?,?) on conflict(job_id, source_id) do update set hash = excluded.hash, at = excluded.at", jobId, id, h.hash, at);
      }
    }
    // Too many failures in a row pause the job (the model is out of quota, the backend is down…).
    const latest = getDigestJob(ctx.app, jobId);
    const failures = ok ? 0 : (latest.body.failures ?? 0) + 1;
    const paused = failures >= MAX_FAILURES && latest.status === "active";
    run(ctx.app.db, "update digest_jobs set body = ?, status = ?, run_id = case when run_id = ? then null else run_id end, updated_at = ? where id = ?", JSON.stringify({ ...latest.body, failures }), paused ? "paused" : latest.status, ctx.run.id, at, jobId);
    if (paused) notify(ctx.app, { title: `整理任务暂停：连续 ${failures} 批失败`, body: `${latest.body.title ?? describeJob(latest)}。看运行记录里的错误，处理后在原件页继续。`, link: `#/runs/${ctx.run.id}` });
    if (!ctx.signal.aborted) queueNextBatch(ctx.app, jobId, ctx.run.id);
  }
}

registerHandler("triage", (ctx) => runBatch(ctx, "triage"));
registerHandler("digest", (ctx) => runBatch(ctx, "digest"));

/** A short status of the jobs, for tools and the CLI. */
export function digestStatusText(app: App, jobs = listDigestJobs(app)) {
  if (!jobs.length) return "没有进行中的整理任务。";
  return jobs.map((j) => {
    const c = countDigest(app, j);
    const batches = inflight(app, j.id).map((b) => `${b.id}（${getRun(app, b.id).status}）`);
    const pace = `${j.body.after ? `等 ${j.body.after} 做完后开始，` : ""}同时 ${j.body.parallel ?? 1} 批${j.body.batch ? `、每批最多 ${j.body.batch} 份` : ""}${j.body.chars ? `、每批 ${j.body.chars} 字` : ""}`;
    return `- ${j.id} ${j.mode === "triage" ? "分级" : "整理"} · ${j.body.title ?? describeJob(j)} · ${j.status} · ${c.total - c.left}/${c.total} · ${pace}${batches.length ? ` · 进行中 ${batches.join("、")}` : ""}${j.body.agent ? ` · 经验写给 ${j.body.agent}` : ""}`;
  }).join("\n");
}
