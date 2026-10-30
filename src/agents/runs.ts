import { releaseRun } from "./capacity.ts";
import { withBot } from "../core/bot-context.ts";
import { trySettleCodeChain } from "./code-chain.ts";
import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { HttpError, json, newId, now } from "../core/util.ts";

export type RunKind = "archive" | "archive-rule-draft" | "ask" | "agent" | "agent-followup" | "thread-summary" | "learn-feed" | "ingest" | "wiki-plan" | "wiki-write" | "wiki-lint" | "wiki-organize" | "heartbeat" | "dream" | "code" | "review" | "tutor" | "sync" | "brief" | "curate" | "ingest-shadow" | "memory-review" | "memory-organize" | "item-settle" | "role-merge" | "profile-review" | "rule-fire" | "guest" | "lark-command" | "lark-resource-parse" | "wake" | "triage" | "digest" | "peer-agent" | "replay" | "replay-arm" | "replay-judge";
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

/** Who a run was started for (the owner when nobody else was recorded). */
export function runUser(app: App, id: string) {
  return one<{ user_id: string | null }>(app.db, "select user_id from runs where id = ?", id)?.user_id ?? "owner";
}

export function getRun(app: App, id: string): Run {
  const r = one<Row>(app.db, "select * from runs where id = ?", id);
  if (!r) throw new HttpError(404, `运行记录不存在：${id}`);
  return toRun(r);
}

type RunFilter = { kind?: string; spaceId?: string; status?: string; parentId?: string; includeQuiet?: boolean; q?: string };

/**
 * `kind` may list several, comma-separated; `agent:<name>` is one agent spec's runs, `role:<name>`
 * the runs a built-in role took part in. Any of them matches. `q` matches the title, the id or the
 * task.
 */
function runWhere(opts: RunFilter) {
  const where: string[] = [];
  const params: (string | number)[] = [];
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
  if (opts.spaceId) where.push("space_id = ?"), params.push(opts.spaceId);
  if (opts.status) where.push("status = ?"), params.push(opts.status);
  if (opts.parentId) where.push("parent_id = ?"), params.push(opts.parentId);
  if (!opts.includeQuiet && !opts.parentId) where.push("quiet = 0");
  const q = opts.q?.trim();
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
    ? "*, json_object('task', substr(coalesce(json_extract(input,'$.task'), json_extract(input,'$.text'), ''), 1, 600)) as input, '{}' as output"
    : "*";
  return all<Row>(app.db, `select ${cols} from runs ${w.sql} order by created_at desc limit ? offset ?`, ...w.params, limit, opts.offset ?? 0).map(toRun);
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
/**
 * The bulk digest of stored material (digest.ts: grading and distilling batch after batch) gets a
 * slot of its own, one at a time: new material (ingest), the heartbeat and other background work
 * keep their slots and are never queued behind a long digest batch.
 */
const BULK = new Set<string>(["digest", "triage"]);
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

export function startWorker(app: App) {
  if (started) return;
  started = true;
  // Runs interrupted by a restart go back to the queue; handlers are written to be re-runnable.
  run(app.db, "update runs set status = 'queued', started_at = null where status = 'running'");
  setInterval(() => kick(app), 2000).unref();
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
  if (row.not_before && row.not_before > now()) return `定时，${row.not_before.slice(0, 16).replace("T", " ")} 开始`;
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

function nextRunnable(app: App): Row | undefined {
  const open = (["interactive", "background", "bulk"] as Cls[]).filter((c) => active[c] < limitOf(app, c));
  if (!open.length) return;
  const candidates = all<Row>(
    app.db,
    `select * from runs q where q.status = 'queued' and (q.not_before is null or q.not_before <= ?)
       and (${open.map((c) => classSql(c, "q.kind")).join(" or ")})
       and (q.lane is null or not exists (select 1 from runs r where r.lane = q.lane and r.status = 'running'))
       and (q.lane is null or not exists (select 1 from runs r where r.lane = q.lane and r.status = 'queued'
         and (r.created_at < q.created_at or (r.created_at = q.created_at and r.rowid < q.rowid))))
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
  if (!started) return;
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
        const status = controller.signal.aborted ? "cancelled" : "done";
        // A quiet background inspection (nothing new / QUIET) stays out of the run list; so does a
        // conversation turn that a wake-up or a watched group's batch started and that had nothing to say.
        const quiet = status === "done" && out && (out as { quiet?: boolean }).quiet === true && (!INTERACTIVE.has(r.kind) || r.input.wake === true || r.kind === "ask") ? 1 : 0;
        run(app.db, "update runs set status=?, quiet=?, finished_at=? where id=?", status, quiet, now(), r.id);
        if (r.kind === "code") trySettleCodeChain(app, r.id);
        if (r.kind === "review" && typeof r.input.codeRunId === "string") trySettleCodeChain(app, r.input.codeRunId);
        settleWorkRound(app, r);
        app.emit({ type: "run", runId: r.id, status });
      })
      .catch((error: Error) => {
        flushText(app, r.id);
        const cancelled = controller.signal.aborted || error.message === "CANCELLED";
        run(app.db, "update runs set status=?, error=?, finished_at=? where id=?", cancelled ? "cancelled" : "failed", cancelled ? null : error.message, now(), r.id);
        if (r.kind === "code") trySettleCodeChain(app, r.id);
        if (r.kind === "review" && typeof r.input.codeRunId === "string") trySettleCodeChain(app, r.input.codeRunId);
        settleWorkRound(app, r);
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
  import("./agent-work.ts")
    .then(({ onWorkRunSettled }) => onWorkRunSettled(app, getRun(app, r.id)))
    .catch((e) => console.warn(`[omem] 多 Agent 工作推进失败：${(e as Error).message}`));
}

export function cancelRun(app: App, id: string) {
  const r = getRun(app, id);
  if (r.status === "queued") {
    run(app.db, "update runs set status='cancelled', finished_at=? where id=?", now(), id);
    if (r.kind === "code") trySettleCodeChain(app, id);
    // A confirmed review plan ran on its own: the coding run it reviewed now has its result.
    if (r.kind === "review" && typeof r.input.codeRunId === "string") trySettleCodeChain(app, r.input.codeRunId);
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
