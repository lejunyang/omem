import { trySettleCodeChain } from "./code-chain.ts";
import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { HttpError, json, newId, now } from "../core/util.ts";

export type RunKind = "ask" | "agent" | "agent-followup" | "thread-summary" | "learn-feed" | "ingest" | "wiki-plan" | "wiki-write" | "wiki-lint" | "heartbeat" | "dream" | "code" | "review" | "tutor" | "sync" | "brief" | "curate" | "ingest-shadow" | "memory-review" | "role-merge" | "profile-review" | "rule-fire" | "guest" | "lark-command" | "lark-resource-parse";
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
  parentId: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  lane: string | null;
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
  parent_id: string | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  lane: string | null;
  not_before: string | null;
  quiet: number;
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
  parentId: r.parent_id,
  error: r.error,
  createdAt: r.created_at,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  lane: r.lane ?? null,
  quiet: !!r.quiet,
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
  },
) {
  const id = newId("r");
  run(
    app.db,
    "insert into runs(id,kind,space_id,status,title,input,parent_id,created_at,lane,not_before,user_id) values(?,?,?,?,?,?,?,?,?,?,?)",
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
    input.userId ?? null,
  );
  app.emit({ type: "run", runId: id, status: "queued" });
  queueMicrotask(() => kick(app));
  if (input.notBefore) setTimeout(() => kick(app), Math.max(0, Date.parse(input.notBefore) - Date.now()) + 20).unref();
  return getRun(app, id);
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

export function getRun(app: App, id: string): Run {
  const r = one<Row>(app.db, "select * from runs where id = ?", id);
  if (!r) throw new HttpError(404, `运行记录不存在：${id}`);
  return toRun(r);
}

type RunFilter = { kind?: string; spaceId?: string; status?: string; parentId?: string; includeQuiet?: boolean };

/**
 * `kind` may list several, comma-separated; `agent:<name>` is one agent spec's runs. Any of them
 * matches.
 */
function runWhere(opts: RunFilter) {
  const where: string[] = [];
  const params: (string | number)[] = [];
  const kinds = (opts.kind ?? "").split(",").map((k) => k.trim()).filter(Boolean);
  if (kinds.length) {
    const any: string[] = [];
    for (const k of kinds) {
      if (k.startsWith("agent:")) any.push("(kind = 'agent' and json_extract(input, '$.spec') = ?)"), params.push(k.slice(6));
      else any.push("kind = ?"), params.push(k);
    }
    where.push(`(${any.join(" or ")})`);
  }
  if (opts.spaceId) where.push("space_id = ?"), params.push(opts.spaceId);
  if (opts.status) where.push("status = ?"), params.push(opts.status);
  if (opts.parentId) where.push("parent_id = ?"), params.push(opts.parentId);
  if (!opts.includeQuiet && !opts.parentId) where.push("quiet = 0");
  return { sql: where.length ? `where ${where.join(" and ")}` : "", params };
}

export function listRuns(app: App, opts: RunFilter & { limit?: number; offset?: number } = {}) {
  const w = runWhere(opts);
  const limit = Math.min(opts.limit ?? 100, 500);
  return all<Row>(app.db, `select * from runs ${w.sql} order by created_at desc limit ? offset ?`, ...w.params, limit, opts.offset ?? 0).map(toRun);
}

export function countRuns(app: App, opts: RunFilter = {}) {
  const w = runWhere(opts);
  return one<{ n: number }>(app.db, `select count(*) n from runs ${w.sql}`, ...w.params)?.n ?? 0;
}

export function setRunOutput(app: App, id: string, output: Record<string, unknown>) {
  const prev = getRun(app, id).output;
  run(app.db, "update runs set output = ? where id = ?", JSON.stringify({ ...prev, ...output }), id);
}

// ---- events -------------------------------------------------------------

const seqs = new Map<string, number>();
const textBuffers = new Map<string, { type: string; text: string; timer: NodeJS.Timeout }>();

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
}

export function flushRunText(app: App, runId: string) {
  flushText(app, runId);
}
function flushText(app: App, runId: string) {
  const b = textBuffers.get(runId);
  if (!b) return;
  clearTimeout(b.timer);
  textBuffers.delete(runId);
  if (b.text) writeEvent(app, runId, b.type, { text: b.text });
}

/** Streaming text is coalesced so a long answer is a handful of rows, not thousands. */
export function addRunEvent(app: App, runId: string, type: string, data: unknown) {
  if (type === "text" || type === "thought") {
    const text = (data as { text: string }).text;
    const b = textBuffers.get(runId);
    if (b && b.type === type) {
      b.text += text;
      // Live listeners still get each delta immediately.
      app.emit({ type: "run-event", runId, seq: -1, event: { type: `${type}-delta`, data: { text }, at: now() } });
      return;
    }
    flushText(app, runId);
    textBuffers.set(runId, { type, text, timer: setTimeout(() => flushText(app, runId), 1500) });
    app.emit({ type: "run-event", runId, seq: -1, event: { type: `${type}-delta`, data: { text }, at: now() } });
    return;
  }
  flushText(app, runId);
  writeEvent(app, runId, type, data);
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
type Handler = (ctx: RunContext) => Promise<Record<string, unknown> | void>;
const handlers = new Map<string, Handler>();
const controllers = new Map<string, AbortController>();
/** Conversations get their own slots so a long background job never delays a reply. */
const INTERACTIVE = new Set<string>(["ask", "agent"]);
const active = { interactive: 0, background: 0 };
let started = false;
/** Last activity (run event / output) per live run; watchdog fails interactive
 *  runs silent for too long, so a dead agent process cannot wedge a whole
 *  conversation lane (later messages queue forever and never get answered). */
const heartbeats = new Map<string, number>();
const INTERACTIVE_STALL_MS = 30 * 60_000;

export function registerHandler(kind: RunKind, handler: Handler) {
  handlers.set(kind, handler);
}

export function startWorker(app: App) {
  if (started) return;
  started = true;
  // Runs interrupted by a restart go back to the queue; handlers are written to be re-runnable.
  run(app.db, "update runs set status = 'queued', started_at = null where status = 'running'");
  setInterval(() => kick(app), 2000).unref();
  setInterval(() => watchStalls(app), 60_000).unref();
  kick(app);
}

function nextRunnable(app: App): Row | undefined {
  const candidates = all<Row>(
    app.db,
    `select * from runs q where q.status = 'queued' and (q.not_before is null or q.not_before <= ?)
       and (q.lane is null or not exists (select 1 from runs r where r.lane = q.lane and r.status = 'running'))
     order by q.created_at limit 100`,
    now(),
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
    const cls = INTERACTIVE.has(c.kind) ? "interactive" : "background";
    const limit = cls === "interactive" ? app.config.interactiveConcurrency : app.config.concurrency;
    if (active[cls] < limit) return c;
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
  if (!started) return;
  for (;;) {
    const next = nextRunnable(app);
    if (!next) return;
    const cls = INTERACTIVE.has(next.kind) ? "interactive" : "background";
    const handler = handlers.get(next.kind);
    if (!handler) {
      run(app.db, "update runs set status='failed', error=?, finished_at=? where id=?", `没有处理器：${next.kind}`, now(), next.id);
      continue;
    }
    // Atomic claim: several processes (server, CLI) may share one library.
    if (run(app.db, "update runs set status='running', started_at=? where id=? and status='queued'", now(), next.id).changes !== 1) continue;
    app.emit({ type: "run", runId: next.id, status: "running" });
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
    handler(ctx)
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
        const status = controller.signal.aborted ? "cancelled" : "done";
        // A quiet background inspection (nothing new / QUIET) stays out of the run list.
        const quiet = status === "done" && !INTERACTIVE.has(r.kind) && out && (out as { quiet?: boolean }).quiet === true ? 1 : 0;
        run(app.db, "update runs set status=?, quiet=?, finished_at=? where id=?", status, quiet, now(), r.id);
        if (r.kind === "code") trySettleCodeChain(app, r.id);
        settleWorkRound(app, r);
        app.emit({ type: "run", runId: r.id, status });
      })
      .catch((error: Error) => {
        flushText(app, r.id);
        const cancelled = controller.signal.aborted || error.message === "CANCELLED";
        run(app.db, "update runs set status=?, error=?, finished_at=? where id=?", cancelled ? "cancelled" : "failed", cancelled ? null : error.message, now(), r.id);
        if (r.kind === "code") trySettleCodeChain(app, r.id);
        settleWorkRound(app, r);
        if (!cancelled) addRunEvent(app, r.id, "error", { message: error.message });
        app.emit({ type: "run", runId: r.id, status: cancelled ? "cancelled" : "failed" });
      })
      .finally(() => {
        active[cls]--;
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
  import("./agent-work.ts")
    .then(({ onWorkRunSettled }) => onWorkRunSettled(app, getRun(app, r.id)))
    .catch((e) => console.warn(`[omem] 多 Agent 工作推进失败：${(e as Error).message}`));
}

export function cancelRun(app: App, id: string) {
  const r = getRun(app, id);
  if (r.status === "queued") {
    run(app.db, "update runs set status='cancelled', finished_at=? where id=?", now(), id);
    if (r.kind === "code") trySettleCodeChain(app, id);
    app.emit({ type: "run", runId: id, status: "cancelled" });
  } else controllers.get(id)?.abort();
  return getRun(app, id);
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
