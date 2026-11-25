import { runPredicate, type RunAudience } from "../auth/run-scope.ts";
import { cancelBoard, maintainBoards, settleBoardRun } from "./work-board.ts";
import { releaseRun } from "./capacity.ts";
import { withBot } from "../core/bot-context.ts";
import { trySettleCodeChain } from "./code-chain.ts";
import { recordRunStart } from "./run-scope.ts";
import type { App } from "../core/app.ts";
import { enqueuePluginEvent } from "../plugins/event-store.ts";
import { all, one, run, tx, withinTx } from "../core/db.ts";
import { HttpError, json, newId, now, localStamp } from "../core/util.ts";
import { scopeFor } from "../core/users.ts";
import { triggerFor, withFollowUp, type RunTrigger } from "../core/run-trigger.ts";
import { offerReviewPublish } from "./review-sync.ts";
import { emitOmem, runOutputFacts } from "../rules/omem-events.ts";

import type { RunKind } from "./run-kinds.ts";
export type { RunKind } from "./run-kinds.ts";
export type RunStatus = "queued" | "running" | "done" | "failed" | "cancelled";
export type Run = {
  /** Background run that found nothing to do; hidden from the default run list. */
  quiet?: boolean;
  id: string;
  kind: RunKind;
  spaceId: string | null;
  status: RunStatus;
  title: string;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  profileId: string | null;
  /** Backend, model and effort the run used (its first successful Agent call). */
  ai: { profile: string; model?: string; effort?: string } | null;
  parentId: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  lane: string | null;
  /** How it came about and who was behind it (core/run-trigger.ts); null: the system's own work. */
  trigger: RunTrigger | null;
};
type Row = {
  id: string;
  kind: string;
  space_id: string | null;
  status: string;
  title: string;
  input: string;
  output: string;
  profile_id: string | null;
  ai: string | null;
  parent_id: string | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  lane: string | null;
  not_before: string | null;
  quiet: number;
  trigger: string | null;
};
const toRun = (r: Row): Run => ({
  id: r.id,
  kind: r.kind as RunKind,
  spaceId: r.space_id,
  status: r.status as RunStatus,
  title: r.title,
  input: json(r.input, {}),
  output: json(r.output, {}),
  profileId: r.profile_id,
  ai: r.ai ? json(r.ai, null) : null,
  parentId: r.parent_id,
  error: r.error,
  createdAt: r.created_at,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  lane: r.lane ?? null,
  quiet: !!r.quiet,
  trigger: r.trigger ? withFollowUp(json<RunTrigger | null>(r.trigger, null), { parentId: r.parent_id, input: json(r.input, {}) }) : null,
} as Run);

export function createRun(
  app: App,
  input: {
    kind: RunKind;
    spaceId?: string | null;
    title: string;
    input?: Record<string, unknown>;
    parentId?: string | null;
    /** Runs sharing a lane (a conversation thread) run one at a time, in order. */
    lane?: string | null;
    /** Do not start before this time (lets a burst of messages merge into one run). */
    notBefore?: string | null;
    /** Who asked for it (for per-user history and limits). */
    userId?: string | null;
    /** How it came about and who was behind it; left out, read from the input or taken over from the parent run (core/run-trigger.ts). */
    trigger?: RunTrigger | null;
  },
) {
  const id = newId("r");
  // The spaces it can read at most (src/auth/permissions.ts canReadRun: who else may read the run). Null: everything, the owner's.
  const asked = Array.isArray(input.input?.spaces) ? (input.input!.spaces as string[]) : null;
  const userId = input.userId ?? (input.parentId ? runUser(app, input.parentId) : null);
  const scope = scopeFor(app, userId ?? "owner", asked);
  const trigger = triggerFor(app, { ...input, userId });
  run(
    app.db,
    "insert into runs(id,kind,space_id,status,title,input,parent_id,created_at,lane,not_before,user_id,scope,trigger,trigger_by) values(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    id,
    input.kind,
    input.spaceId ?? null,
    "queued",
    input.title,
    JSON.stringify(input.input ?? {}),
    input.parentId ?? null,
    now(),
    input.lane ?? null,
    input.notBefore ?? null,
    userId,
    scope === null ? null : JSON.stringify(scope),
    trigger ? JSON.stringify(trigger) : null,
    trigger?.by?.key ?? null,
  );
  app.emit({ type: "run", runId: id, status: "queued" });
  queueMicrotask(() => kick(app));
  if (input.notBefore) setTimeout(() => kick(app), Math.max(0, Date.parse(input.notBefore) - Date.now()) + 20).unref();
  return getRun(app, id);
}

/**
 * A finished run queued again to go on from where it stopped (a delegation's first round that ended
 * waiting for its design to be confirmed, designs/work.ts): its output is kept, `output` patched in.
 * False when it is not finished (another call got there first).
 */
export function requeueRun(app: App, id: string, output: Record<string, unknown> = {}): boolean {
  const changed = run(app.db, "update runs set status = 'queued', started_at = null, finished_at = null, error = null where id = ? and status = 'done'", id).changes === 1;
  if (!changed) return false;
  if (Object.keys(output).length) setRunOutput(app, id, output);
  app.emit({ type: "run", runId: id, status: "queued" });
  queueMicrotask(() => kick(app));
  return true;
}

/** The run still waiting in a lane (for merging new messages into it), if any. */
export function queuedInLane(app: App, lane: string, kind: RunKind): Run | null {
  const r = one<Row>(app.db, "select * from runs where lane = ? and kind = ? and status = 'queued' order by created_at desc limit 1", lane, kind);
  return r ? toRun(r) : null;
}

export function updateQueuedRun(app: App, id: string, patch: { input?: Record<string, unknown>; notBefore?: string; title?: string }) {
  const changed = run(
    app.db,
    "update runs set input = coalesce(?, input), not_before = coalesce(?, not_before), title = coalesce(?, title) where id = ? and status = 'queued'",
    patch.input ? JSON.stringify(patch.input) : null,
    patch.notBefore ?? null,
    patch.title ?? null,
    id,
  ).changes;
  if (changed && patch.notBefore) setTimeout(() => kick(app), Math.max(0, Date.parse(patch.notBefore) - Date.now()) + 20).unref();
  return changed === 1;
}

export function runsInLane(app: App, lane: string) {
  return all<Row>(app.db, "select * from runs where lane = ? and status in ('queued','running') order by created_at", lane).map(toRun);
}

/** Who a run was started for (the owner when nobody else was recorded). */
export function runUser(app: App, id: string | null) {
  if (!id) return "owner";
  // Older children did not persist the inherited identity. Each step looks up a single primary key.
  return one<{ user_id: string }>(app.db, `with recursive lineage(id) as (
    values(?)
    union
    select case when r.kind='code' then coalesce(json_extract(r.input,'$.continueFrom'),r.parent_id) else r.parent_id end
    from lineage l join runs r on r.id=l.id where r.user_id is null
  ) select r.user_id from lineage l join runs r on r.id=l.id where r.user_id is not null limit 1`, id)?.user_id ?? "owner";
}

export function getRun(app: App, id: string): Run {
  const r = one<Row>(app.db, "select * from runs where id = ?", id);
  if (!r) throw new HttpError(404, `运行记录不存在：${id}`);
  return toRun(r);
}

export function reviewRounds(app: App, ids: string[], audience?: RunAudience) {
  const filter = audience && runPredicate(audience);
  const where = filter ? " and " + filter.sql : "";
  const params = filter?.params ?? [];
  const rows = all<Row>(app.db, "select * from runs where id in (select value from json_each(?))" + where, JSON.stringify(ids), ...params);
  const byId = new Map(rows.map(r => [r.id, toRun(r)]));
  const rounds = ids.flatMap(id => {
    const round = byId.get(id);
    if (!round && !audience) throw new HttpError(404, `运行记录不存在：${id}`);
    return round ? [round] : [];
  });
  type Child = { id: string; status: string; title: string };
  const children = new Map<string, Child[]>();
  for (const { parent_id, ...child } of all<Child & { parent_id: string }>(app.db,
    "select parent_id,id,status,title from runs where kind='review' and parent_id in (select value from json_each(?))" + where + " order by created_at",
    JSON.stringify([...byId.keys()]), ...params)) {
    if (!children.has(parent_id)) children.set(parent_id, []);
    children.get(parent_id)!.push(child);
  }
  return { rounds, children };
}

type RunFilter = { id?: string; kind?: string; exclude?: string; spaceId?: string; spaceIds?: string[]; status?: string; parentId?: string; includeQuiet?: boolean; q?: string; by?: string; via?: string; ai?: string; model?: string; visibleTo?: RunAudience; reviewAudience?: RunAudience };

/** The backend a run used: what it recorded, or the profile it was queued with (older runs). */
const RUN_PROFILE = "coalesce(json_extract(ai, '$.profile'), profile_id)";

/**
 * `kind` may list several, comma-separated; `agent:<name>` is one agent spec's runs, `role:<name>`
 * the runs a built-in role took part in. Any of them matches; `exclude` lists kinds left out (the run
 * page lists coding work on its own). `q` matches the title, the id or the
 * task. `by`: the person behind it (a trigger key, `user:<id>` / `lark:<open_id>` …; `name:<name>` is that person by name,
 * whichever app's id came with each run). `via`: how it came about (chat, mention, guest, rule…). `ai` / `model`:
 * the backend (AI profile) and model it ran on. `visibleTo`: someone other than the owner sees their own runs, and those whose every
 * readable space is in `spaces` (src/auth/permissions.ts canReadRun).
 */
function runWhere(opts: RunFilter) {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (opts.visibleTo) {
    const filter = runPredicate(opts.visibleTo);
    where.push(filter.sql);
    params.push(...filter.params);
  }
  if (opts.id) where.push("id = ?"), params.push(opts.id);
  const kinds = (opts.kind ?? "").split(",").map((k) => k.trim()).filter(Boolean);
  if (kinds.length) {
    const any: string[] = [];
    for (const k of kinds) {
      if (k.startsWith("agent:")) any.push("(kind = 'agent' and json_extract(input, '$.spec') = ?)"), params.push(k.slice(6));
      else if (k.startsWith("role:")) any.push("instr(coalesce(roles, ''), ?) > 0"), params.push(`|${k.slice(5)}|`);
      else any.push("kind = ?"), params.push(k);
    }
    where.push(`(${any.join(" or ")})`);
  }
  const exclude = (opts.exclude ?? "").split(",").map((k) => k.trim()).filter(Boolean);
  if (exclude.length) where.push(`kind not in (${exclude.map(() => "?").join(",")})`), params.push(...exclude);
  if (opts.spaceId) where.push("space_id = ?"), params.push(opts.spaceId);
  if (opts.spaceIds?.length) where.push(`space_id in (${opts.spaceIds.map(() => "?").join(",")})`), params.push(...opts.spaceIds);
  if (opts.status) where.push("status = ?"), params.push(opts.status);
  if (opts.by?.startsWith("name:")) where.push("trigger_by is not null and trigger_by != 'user:owner' and json_extract(trigger, '$.by.name') = ?"), params.push(opts.by.slice(5));
  else if (opts.by) where.push("trigger_by = ?"), params.push(opts.by);
  if (opts.via) where.push("json_extract(trigger, '$.via') = ?"), params.push(opts.via);
  if (opts.ai) where.push(`${RUN_PROFILE} = ?`), params.push(opts.ai);
  if (opts.model) where.push("json_extract(ai, '$.model') = ?"), params.push(opts.model);
  if (opts.parentId) where.push("parent_id = ?"), params.push(opts.parentId);
  const q = opts.q?.trim();
  // A run looked up by its exact id is shown even when it ended quietly.
  if (!opts.includeQuiet && !opts.parentId) where.push(q ? "(quiet = 0 or id = ?)" : "quiet = 0"), q && params.push(q);
  if (q) {
    const like = `%${q.replace(/[!%_]/g, (c) => `!${c}`)}%`;
    where.push("(id = ? or title like ? escape '!' or json_extract(input, '$.task') like ? escape '!')"), params.push(q, like, like);
  }
  return { sql: where.length ? `where ${where.join(" and ")}` : "", params };
}

/** `brief` leaves input and output empty: a list shows titles, and outputs can hold whole diffs. */
export function listRuns(app: App, opts: RunFilter & { limit?: number; offset?: number; brief?: boolean } = {}) {
  const w = runWhere(opts);
  const limit = Math.min(opts.limit ?? 100, 500);
  // Titles are short labels; a brief list keeps the head of the task for the hover hint.
  const cols = opts.brief
    ? "*, json_object('task', substr(coalesce(json_extract(input,'$.task'), json_extract(input,'$.text'), ''), 1, 600), 'wake', json_extract(input,'$.wake')) as input, '{}' as output"
    : "*";
  const review = opts.reviewAudience && runPredicate(opts.reviewAudience);
  const hidden = review ? `, (kind in ('code','review') and not ${review.sql}) hide_review` : "";
  return all<Row & { hide_review?:number }>(app.db, `select ${cols}${hidden} from runs ${w.sql} order by created_at desc limit ? offset ?`, ...(review?.params ?? []), ...w.params, limit, opts.offset ?? 0).map(row => row.hide_review ? { ...toRun(row), input:{}, output:{}, error:null } : toRun(row));
}

/** Backends and models of recent runs (the run page's “后端 / 模型” filter), the most used first. */
export function runAis(app: App, opts: { days?: number; visibleTo?: RunAudience } = {}) {
  const since = new Date(Date.now() - (opts.days ?? 30) * 86400_000).toISOString();
  const filter = opts.visibleTo && runPredicate(opts.visibleTo);
  const rows = all<{ profile: string; model: string | null; n: number }>(app.db,
    `select ${RUN_PROFILE} profile, json_extract(ai, '$.model') model, count(*) n from runs
      where created_at > ? and ${RUN_PROFILE} is not null ${filter ? `and ${filter.sql}` : ""} group by profile, model`,
    since, ...(filter?.params ?? []));
  const backends = new Map<string, { profile: string; runs: number; models: { model: string; runs: number }[] }>();
  for (const r of rows) {
    const b = backends.get(r.profile) ?? { profile: r.profile, runs: 0, models: [] };
    b.runs += r.n;
    if (r.model) b.models.push({ model: r.model, runs: r.n });
    backends.set(r.profile, b);
  }
  return [...backends.values()].sort((a, b) => b.runs - a.runs).map((b) => ({ ...b, models: b.models.sort((x, y) => y.runs - x.runs) }));
}

export function countRuns(app: App, opts: RunFilter = {}) {
  const w = runWhere(opts);
  return one<{ n: number }>(app.db, `select count(*) n from runs ${w.sql}`, ...w.params)?.n ?? 0;
}

export function setRunOutput(app: App, id: string, output: Record<string, unknown>) {
  function write() {
    const prev = getRun(app, id).output;
    run(app.db, "update runs set output = ? where id = ?", JSON.stringify({ ...prev, ...output }), id);
    if (!("appliedAt" in output || "discardedAt" in output || "reviewStage" in output)) return null;
    const facts = runOutputFacts(app, id, prev, output);
    if (facts?.type === "review.done") {
      offerReviewPublish(app, id);
      const lead = output.reviewLead as { verdict?: string } | undefined;
      enqueuePluginEvent(app, "review.finished", facts.space ?? null, () => ({
        userId: runUser(app, id), entity: { kind: "run", id }, actor: { kind: "host" },
        data: { runId: id, verdict: facts.status || lead?.verdict, findingCount: facts.newFindings ?? 0 },
      }));
    }
    return facts;
  }
  const facts = output.reviewStage === "done" ? withinTx(app.db, write) : write();
  if (facts) emitOmem(app, facts);
}

// ---- events -------------------------------------------------------------

const seqs = new Map<string, number>();
type TextBuffer = { type: string; text: string; tags: Record<string, unknown>; timer: NodeJS.Timeout };
/** Per run, one buffer per stream: sessions running side by side in one run (a review's checks) tag their text and keep apart. */
const textBuffers = new Map<string, Map<string, TextBuffer>>();

function nextSeq(app: App, runId: string) {
  let s = seqs.get(runId);
  if (s === undefined) s = one<{ s: number | null }>(app.db, "select max(seq) s from run_events where run_id = ?", runId)?.s ?? 0;
  s++;
  seqs.set(runId, s);
  return s;
}

function writeEvent(app: App, runId: string, type: string, data: unknown) {
  const seq = nextSeq(app, runId);
  const at = now();
  run(app.db, "insert into run_events(run_id,seq,at,type,data) values(?,?,?,?,?)", runId, seq, at, type, JSON.stringify(data));
  app.emit({ type: "run-event", runId, seq, event: { type, data, at } });
  return seq;
}

export function flushRunText(app: App, runId: string) {
  flushText(app, runId);
}
function flushText(app: App, runId: string, stream?: string) {
  const bufs = textBuffers.get(runId);
  if (!bufs) return;
  for (const [key, b] of [...bufs]) {
    if (stream !== undefined && key !== stream) continue;
    clearTimeout(b.timer);
    bufs.delete(key);
    if (b.text) writeEvent(app, runId, b.type, { ...b.tags, text: b.text });
  }
  if (!bufs.size) textBuffers.delete(runId);
}

/** Streaming text is coalesced so a long answer is a handful of rows, not thousands. */
export function addRunEvent(app: App, runId: string, type: string, data: unknown) {
  if (type === "text" || type === "thought") {
    const { text, ...tags } = data as { text: string } & Record<string, unknown>;
    delete tags.type;
    const stream = JSON.stringify(tags);
    // Live listeners still get each delta immediately.
    const delta = () => app.emit({ type: "run-event", runId, seq: -1, event: { type: `${type}-delta`, data: { ...tags, text }, at: now() } });
    const b = textBuffers.get(runId)?.get(stream);
    if (b && b.type === type) {
      b.text += text;
      delta();
      return;
    }
    flushText(app, runId, stream);
    let bufs = textBuffers.get(runId);
    if (!bufs) textBuffers.set(runId, (bufs = new Map()));
    bufs.set(stream, { type, text, tags, timer: setTimeout(() => flushText(app, runId, stream), 1500) });
    delta();
    return;
  }
  flushText(app, runId);
  return writeEvent(app, runId, type, data);
}

export function runEvents(app: App, runId: string, afterSeq = 0) {
  flushText(app, runId);
  return all<{ seq: number; at: string; type: string; data: string }>(app.db, "select seq, at, type, data from run_events where run_id = ? and seq > ? order by seq", runId, afterSeq).map((e) => ({
    seq: e.seq,
    at: e.at,
    type: e.type,
    data: json(e.data, {}),
  }));
}

// ---- queue --------------------------------------------------------------

export type RunContext = {
  app: App;
  run: Run;
  signal: AbortSignal;
  event(type: string, data: unknown): void;
  output(data: Record<string, unknown>): void;
};
/** Ask the worker to resume this same durable run at the next poll, without occupying a slot. */
export class ResumeRunAt extends Error {
  at: string;
  constructor(at: number) { super("等待下一次检查"); this.at = new Date(at).toISOString(); }
}
/** The account login may succeed while this attempt is returning to the queue. */
export class ResumeAfterAiLogin extends ResumeRunAt {}
type Handler = (ctx: RunContext) => Promise<Record<string, unknown> | void>;
const handlers = new Map<string, Handler>();
const controllers = new Map<string, AbortController>();
/** Conversations get their own slots so a long background job never delays a reply. */
const INTERACTIVE = new Set<string>(["ask", "agent", "first-look"]);
/**
 * The bulk digest of stored material (digest.ts: grading and distilling batch after batch) gets a
 * slot of its own, one at a time: new material (ingest), the heartbeat and other background work
 * keep their slots and are never queued behind a long digest batch.
 * A correction sweep also uses this slot: it waits for checked writing runs in the background
 * class, so it must not occupy their last slot when background concurrency is one.
 */
const BULK = new Set<string>(["digest", "triage", "wiki-sweep"]);
export const BULK_SLOTS = 1;
type Cls = "interactive" | "background" | "bulk";
const classOf = (kind: string): Cls => (INTERACTIVE.has(kind) ? "interactive" : BULK.has(kind) ? "bulk" : "background");
const limitOf = (app: App, cls: Cls) => (cls === "interactive" ? app.config.interactiveConcurrency : cls === "bulk" ? BULK_SLOTS : app.config.concurrency);
const inList = (s: Set<string>) => [...s].map((k) => `'${k}'`).join(",");
const classSql = (cls: Cls, col = "kind") => (cls === "interactive" ? `${col} in (${inList(INTERACTIVE)})` : cls === "bulk" ? `${col} in (${inList(BULK)})` : `${col} not in (${inList(INTERACTIVE)},${inList(BULK)})`);
const active: Record<Cls, number> = { interactive: 0, background: 0, bulk: 0 };
let started = false;
/** Last activity (run event / output) per live run; watchdog fails interactive
 *  runs silent for too long, so a dead agent process cannot wedge a whole
 *  conversation lane (later messages queue forever and never get answered). */
const heartbeats = new Map<string, number>();
const INTERACTIVE_STALL_MS = 30 * 60_000;

export function registerHandler(kind: RunKind, handler: Handler) {
  handlers.set(kind, handler);
}

/**
 * The service is stopping (a restart, an upgrade): runs that fail from now on failed because their
 * agent sessions are being closed, not on their own. They stay running, and the next start puts them
 * back in the queue like any run a restart cut off; nothing new starts meanwhile.
 */
let stopping = false;
export function stopWorker() {
  stopping = true;
}

/** How long after it started an interrupted run still continues in its agent session. */
export const RESTART_RESUME_MS = 12 * 3600_000;

/**
 * Before a restart's interrupted runs are queued again: what each had written so far and, for a
 * recent one on an ACP agent, the session it was in. The session is kept from cleanup (ready -1,
 * its earlier state saved) until the run continues in it or ends (session-cleanup.ts).
 */
export function markRestarted(app: App) {
  const cut = all<{ id: string; started_at: string | null }>(app.db, "select id, started_at from runs where status = 'running' and json_extract(input,'$.boardDevice.mode') is not 'remote'");
  const recent = new Date(Date.now() - RESTART_RESUME_MS).toISOString();
  for (const r of cut) {
    const writes = one<{ n: number }>(app.db, "select count(*) n from run_events where run_id = ? and type = 'tool-write'", r.id)!.n;
    const sid = one<{ data: string }>(app.db, "select data from run_events where run_id = ? and type = 'session' order by seq desc limit 1", r.id);
    const sessionId = sid ? json<{ sessionId?: string }>(sid.data, {}).sessionId : undefined;
    const kept = sessionId && r.started_at && r.started_at >= recent
      ? one<{ ready: number; profile_id: string | null; cwd: string }>(app.db, "select ready, profile_id, cwd from session_cleanup where session_id = ? and transport = 'acp' order by rowid desc limit 1", sessionId)
      : undefined;
    if (kept) run(app.db, "update session_cleanup set ready = -1 where session_id = ? and transport = 'acp'", sessionId!);
    const note = { at: now(), writes, ...(kept ? { sessionId, profileId: kept.profile_id, cwd: kept.cwd, ready: kept.ready } : {}) };
    run(app.db, "update runs set input = json_set(input, '$.restarted', json(?)) where id = ?", JSON.stringify(note), r.id);
  }
}

export function startWorker(app: App) {
  if (started) return;
  started = true;
  // Channel adapters waiting for these answers belonged to the previous process.
  // The resumed handler must deliver its result itself, including turns still queued at restart.
  run(app.db, `update runs set input = json_set(input, '$.recoverReply', json('true'))
    where kind = 'ask' and status in ('queued','running')
    and json_extract(input, '$.conversationId') in (select id from conversations where channel not in ('web','cli'))`);
  // Runs interrupted by a restart go back to the queue; handlers are written to be re-runnable.
  // Each is told it was cut off, and its agent session is kept so it continues there (runner.ts).
  maintainBoards(app, true);
  markRestarted(app);
  run(app.db, "update runs set status = 'queued', started_at = null where status = 'running' and json_extract(input,'$.boardDevice.mode') is not 'remote'");
  setInterval(() => { if (!stopping) maintainBoards(app); kick(app); }, 2000).unref();
  setInterval(() => {
    if (!stopping) void import("./inbox.ts").then(m => m.flushRecoveredReplies(app)).catch(e => console.warn(`[omem] 恢复会话回复失败：${(e as Error).message}`));
  }, 30_000).unref();
  setInterval(() => watchStalls(app), 60_000).unref();
  kick(app);
}

/**
 * Why a queued run has not started. This is omem's own queue: the backend and model are chosen
 * only when the run starts. A backend's own queue (a provider queue) shows inside a running run.
 */
export function queueReason(app: App, r: Run): string | null {
  if (r.status !== "queued") return null;
  const row = one<Row>(app.db, "select * from runs where id = ?", r.id);
  if (!row) return null;
  const end = r.kind === "wake" ? (r.input as import("./wakes.ts").WakeInput).onRunEnd : undefined;
  if (end && end.expiresAt > now() && one(app.db, "select 1 from runs where id = ? and status in ('queued','running')", end.runId)) return `等编码轮次 ${end.runId} 结束`;
  const login = r.input.aiLoginWait as import("./credential-wait.ts").AiLoginWait | undefined;
  if (login && !login.ready && row.not_before && row.not_before > now()) return "等待成员登录 " + login.name;
  if (row.not_before && row.not_before > now()) return `定时，${localStamp(row.not_before, app.config.timezone)} 开始`;
  if (row.lane) {
    const busy = one<{ id: string }>(app.db, "select id from runs where lane = ? and status = 'running'", row.lane);
    const older = one<{ n: number }>(app.db, "select count(*) n from runs where lane = ? and status = 'queued' and created_at < ?", row.lane, row.created_at)!.n;
    if (busy || older) return `等同一会话里前面的运行${busy ? `（${busy.id} 进行中）` : ""}${older ? `，前面还有 ${older} 个` : ""}`;
  }
  const cls = classOf(row.kind);
  const limit = limitOf(app, cls);
  const same = classSql(cls);
  const running = one<{ n: number }>(app.db, `select count(*) n from runs where status = 'running' and ${same}`)!.n;
  const ahead = one<{ n: number }>(app.db, `select count(*) n from runs where status = 'queued' and ${same} and created_at < ? and (not_before is null or not_before <= ?)`, row.created_at, now())!.n;
  return `等${cls === "interactive" ? "对话" : cls === "bulk" ? "存量整理" : "后台任务"}空位：同时最多 ${limit} 个，正在运行 ${running} 个${ahead ? `，前面还排着 ${ahead} 个` : ""}`;
}

// Count physical attempts, including a cancelled worker that is still releasing its slot.
const boardSlot = `(json_extract(q.input,'$.boardTaskId') is null or (
  (select count(*) from runs live where live.parent_id=q.parent_id and live.status='running'
    and json_extract(live.input,'$.boardTaskId') is not null) < ?
  and exists (select 1 from agent_work_tasks t where t.run_id=q.id and t.deadline_at>?)
))`;

function claimRun(app: App, row: Row) {
  const input = JSON.parse(row.input);
  const at = now();
  if (!input.boardTaskId)
    return run(app.db, "update runs set status='running',started_at=? where id=? and status='queued'", at, row.id).changes === 1;
  const claimed = tx(app.db, () => {
    const changed = run(app.db, `update runs as q set status='running',started_at=?
      where id=? and status='queued' and ${boardSlot}`, at, row.id, app.config.agents.workBoard.concurrency, at).changes;
    if (!changed) return false;
    run(app.db, `update agent_work_tasks set status='running',updated_at=?,
      attempts=json_set(attempts,'$[#-1].status','running','$[#-1].startedAt',?) where run_id=?`, at, at, row.id);
    return true;
  });
  if (claimed) app.emit({ type: "work", workId: input.agentWorkId });
  return claimed;
}

function nextRunnable(app: App): Row | undefined {
  const open = (["interactive", "background", "bulk"] as Cls[]).filter((c) => active[c] < limitOf(app, c));
  if (!open.length) return;
  const candidates = all<Row>(
    app.db,
    `select * from runs q where q.status = 'queued' and json_extract(q.input,'$.boardDevice.mode') is not 'remote' and (q.not_before is null or q.not_before <= ?)
       and (q.kind != 'wake' or json_extract(q.input, '$.onRunEnd.runId') is null
         or json_extract(q.input, '$.onRunEnd.expiresAt') <= ?
         or exists (select 1 from runs target where target.id = json_extract(q.input, '$.onRunEnd.runId') and target.status in ('done','failed','cancelled')))
       and ${boardSlot}
       and (${open.map((c) => classSql(c, "q.kind")).join(" or ")})
       and (q.lane is null or not exists (select 1 from runs r where r.lane = q.lane and r.status = 'running'))
       and (q.lane is null or not exists (select 1 from runs r where r.lane = q.lane and r.status = 'queued'
         and (r.created_at < q.created_at or (r.created_at = q.created_at and r.rowid < q.rowid))))
     order by q.created_at limit 100`,
    now(), now(), app.config.agents.workBoard.concurrency, now(),
  );
  const seenLanes = new Set<string>();
  for (const c of candidates) {
    // Strict order inside a lane: only its oldest queued run may start.
    if (c.lane) {
      if (seenLanes.has(c.lane)) continue;
      seenLanes.add(c.lane);
      const older = one<{ n: number }>(app.db, "select count(*) n from runs where lane = ? and status = 'queued' and created_at < ?", c.lane, c.created_at);
      if (older?.n) continue;
    }
    const cls = classOf(c.kind);
    if (active[cls] < limitOf(app, cls)) return c;
  }
  return undefined;
}

/**
 * Fail interactive runs that have produced no event for a long time. Agent CLIs
 * can hang on prompts/network without ever settling; without this the lane stays
 * occupied, queued user messages never start, and every later message goes silent.
 */
function watchStalls(app: App) {
  const cutoff = Date.now() - INTERACTIVE_STALL_MS;
  for (const [id, last] of heartbeats) {
    if (last > cutoff) continue;
    const row = one<{ kind: string; status: string }>(app.db, "select kind, status from runs where id = ?", id);
    if (!row || row.status !== "running") { heartbeats.delete(id); continue; }
    if (!INTERACTIVE.has(row.kind)) continue; // long background jobs are allowed
    controllers.get(id)?.abort();
    const res = run(app.db, "update runs set status='failed', error=?, finished_at=? where id=? and status='running'",
      `长时间（${Math.round(INTERACTIVE_STALL_MS / 60000)} 分钟）没有任何进展，已自动中止；请重发消息，新的一轮会接管。`, now(), id);
    if (res.changes) {
      console.warn(`[omem] 运行 ${id} 静默超时，已标记失败以释放会话通道`);
      app.emit({ type: "run", runId: id, status: "failed" });
    }
    heartbeats.delete(id);
  }
}

function kick(app: App) {
  if (!started || stopping) return;
  for (;;) {
    const next = nextRunnable(app);
    if (!next) return;
    const cls = classOf(next.kind);
    const handler = handlers.get(next.kind);
    if (!handler) {
      run(app.db, "update runs set status='failed', error=?, finished_at=? where id=?", `没有处理器：${next.kind}`, now(), next.id);
      continue;
    }
    // Atomic claim: several processes (server, CLI) may share one library.
    if (!claimRun(app, next)) continue;
    app.emit({ type: "run", runId: next.id, status: "running" });
    // What it works on (the chat, conversation, messages and items its input names), for the runs beside it.
    recordRunStart(app, next.id);
    active[cls]++;
    heartbeats.set(next.id, Date.now());
    const controller = new AbortController();
    controllers.set(next.id, controller);
    const r = toRun({ ...next, status: "running" });
    const ctx: RunContext = {
      app,
      run: r,
      signal: controller.signal,
      event: (type, data) => { heartbeats.set(r.id, Date.now()); addRunEvent(app, r.id, type, data); },
      output: (data) => setRunOutput(app, r.id, data),
    };
    // A run is nobody's message handling: it speaks as the bot its conversation belongs to (tools
    // and channels decide), not as whichever bot's event happened to queue it.
    withBot("main", () => handler(ctx))
      .then((out) => {
        flushText(app, r.id);
        if (out) setRunOutput(app, r.id, out);
        // Recall accounting: memories surfaced by recall and actually referenced by this run
        // (its answer, messages, tool writes) count as used.
        try {
          const recalled = all<{ memory_id: string }>(app.db, "select distinct memory_id from memory_recalls where run_id = ? and used = 0", r.id).map((x) => x.memory_id);
          if (recalled.length) {
            void import("../memory/recall-stats.ts").then(({ usedMemoryIds, markUsed }) => {
              markUsed(app, r.id, usedMemoryIds(app, r.id, recalled));
            });
          }
        } catch {}
        if (controller.signal.aborted && controller.signal.reason instanceof RunFailure) throw controller.signal.reason;
        const status = controller.signal.aborted ? "cancelled" : "done";
        // A quiet background inspection (nothing new, stay_quiet) stays out of the run list; so does a
        // conversation turn that a wake-up or a watched group's batch started and that had nothing to say.
        const quiet = status === "done" && out && (out as { quiet?: boolean }).quiet === true && (!INTERACTIVE.has(r.kind) || r.input.wake === true || !!r.input.mention || r.kind === "ask") ? 1 : 0;
        run(app.db, "update runs set status=?, quiet=?, finished_at=? where id=?", status, quiet, now(), r.id);
        if (status === "done" && one(app.db, "select 1 from runs where id = ? and json_extract(output, '$.stayQuietState') = 'unresolved'", r.id)) {
          void import("./quiet-followup.ts").then(({ checkQuietFollowup }) => checkQuietFollowup(app, r.id))
            .catch((e) => console.warn(`[omem] 检查未恢复问题的后续失败：${(e as Error).message}`));
        }
        if (r.kind === "code") trySettleCodeChain(app, r.id);
        if (r.kind === "review" && typeof r.input.codeRunId === "string") trySettleCodeChain(app, r.input.codeRunId);
        settleWorkRound(app, r);
        settleWikiWrite(app, r);
        app.emit({ type: "run", runId: r.id, status });
      })
      .catch((error: Error) => {
        flushText(app, r.id);
        if (stopping && !controller.signal.aborted) return;
        if (error instanceof ResumeRunAt && !controller.signal.aborted) {
          run(app.db, `update runs set status='queued',not_before=case
            when ? and json_extract(input, '$.aiLoginWait.ready') = 1 then null else ? end where id=?`,
            Number(error instanceof ResumeAfterAiLogin), error.at, r.id);
          return;
        }
        const failure = controller.signal.reason;
        if (controller.signal.aborted && failure instanceof RunFailure) error = failure;
        const cancelled = controller.signal.aborted ? !(failure instanceof RunFailure) : error.message === "CANCELLED";
        run(app.db, "update runs set status=?, error=?, finished_at=? where id=?", cancelled ? "cancelled" : "failed", cancelled ? null : error.message, now(), r.id);
        if (r.kind === "code") trySettleCodeChain(app, r.id);
        if (r.kind === "review" && typeof r.input.codeRunId === "string") trySettleCodeChain(app, r.input.codeRunId);
        settleWorkRound(app, r);
        settleWikiWrite(app, r);
        if (!cancelled) addRunEvent(app, r.id, "error", { message: error.message });
        app.emit({ type: "run", runId: r.id, status: cancelled ? "cancelled" : "failed" });
      })
      .finally(() => {
        active[cls]--;
        releaseRun(r.id);
        controllers.delete(r.id);
        heartbeats.delete(r.id);
        seqs.delete(r.id);
        kick(app);
        // Answers that came in while it worked go to its conversation; its suggested next steps are shown.
        import("./asks.ts")
          .then(({ settleAsks }) => settleAsks(app, r.id))
          .catch((e) => console.warn(`[omem] 运行 ${r.id} 的提问收尾失败：${(e as Error).message}`));
      });
  }
}

/** Multi-agent work: a finished or failed round hands over to the main assistant (agent-work.ts). */
function settleWorkRound(app: App, r: Run) {
  if (r.kind !== "agent" || !(r.input as { agentWorkId?: string }).agentWorkId) return;
  if (r.input.boardTaskId) {
    settleBoardRun(app, getRun(app, r.id));
    return;
  }
  import("./agent-work.ts")
    .then(({ onWorkRunSettled }) => onWorkRunSettled(app, getRun(app, r.id)))
    .catch((e) => console.warn(`[omem] 多 Agent 工作推进失败：${(e as Error).message}`));
}

/** A Wiki page's writing ended: its generation retries what was not written, or reports (wiki/verify.ts). */
function settleWikiWrite(app: App, r: Run) {
  if (r.kind !== "wiki-write" && r.kind !== "wiki-resolve") return;
  import("../wiki/verify.ts")
    .then(({ settleWikiRun }) => settleWikiRun(app, getRun(app, r.id)))
    .catch((e) => console.warn(`[omem] Wiki 生成收尾失败：${(e as Error).message}`));
}

class RunFailure extends Error {}

export function cancelRun(app: App, id: string) {
  void stopRun(app, id);
  return getRun(app, id);
}

/** The queue transition is synchronous. Flow actions also await cancellation of the external job. */
export function stopRun(app: App, id: string, failure?: string) {
  const r = getRun(app, id);
  if ((r.status === "running" || r.status === "queued") && (r.input.boardDevice as import("./work-device.ts").BoardDevice | undefined)?.mode === "remote") {
    cancelBoard(app, String(r.input.agentWorkId), String(r.input.boardTaskId), id);
  } else if (r.status === "queued") {
    const status = failure ? "failed" : "cancelled";
    run(app.db, "update runs set status=?,error=?,finished_at=? where id=?", status, failure ?? null, now(), id);
    if (failure) addRunEvent(app,id,"error",{message:failure});
    if (r.kind === "code") trySettleCodeChain(app, id);
    // A confirmed review plan ran on its own: the coding run it reviewed now has its result.
    if (r.kind === "review" && typeof r.input.codeRunId === "string") trySettleCodeChain(app, r.input.codeRunId);
    if (r.input.boardTaskId) queueMicrotask(() => settleWorkRound(app, r));
    settleWikiWrite(app, r);
    app.emit({ type: "run", runId: id, status });
  } else controllers.get(id)?.abort(failure ? new RunFailure(failure) : undefined);
  if (r.kind === "flow-runner" && ["queued", "running"].includes(r.status))
    return import("../flows/plugin-runner.ts").then(m => m.cancelRunnerJob(app,r))
      .catch(e => { addRunEvent(app,id,"error",{message:"取消外部作业失败：" + String(e)}); });
}

/** A running run asked to stop (cancelRun) that has not ended yet. */
export function stopRequested(id: string) {
  return !!controllers.get(id)?.signal.aborted;
}

/**
 * Work that runs inside another run's handler but has a run of its own (a second look,
 * code-overlap.ts): cancelling that run aborts `controller`. Returns the undo.
 */
export function trackAbort(id: string, controller: AbortController) {
  controllers.set(id, controller);
  return () => {
    if (controllers.get(id) === controller) controllers.delete(id);
  };
}

/** Resolve when a run reaches a terminal state (used by CLI and tests). */
export function waitForRun(app: App, id: string): Promise<Run> {
  return new Promise((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    const finish = (r: Run) => {
      clearInterval(timer);
      app.events.off("event", listener);
      resolve(r);
    };
    const check = () => {
      const r = getRun(app, id);
      if (["done", "failed", "cancelled"].includes(r.status)) finish(r);
    };
    const listener = (e: { type: string; runId?: string }) => {
      if (e.type === "run" && e.runId === id) check();
    };
    app.events.on("event", listener);
    // Another process sharing the library may be the one running it.
    timer = setInterval(check, 1500);
    check();
  });
}

/** Test-only: override the handler for a run kind (real ACP agents are not needed in unit tests). */
export const __testHandlers = handlers;
