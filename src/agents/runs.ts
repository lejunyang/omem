import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { HttpError, json, newId, now } from "../core/util.ts";

export type RunKind = "ask" | "ingest" | "wiki-plan" | "wiki-write" | "wiki-lint" | "heartbeat" | "dream" | "code" | "review" | "tutor" | "sync" | "brief" | "curate";
export type RunStatus = "queued" | "running" | "done" | "failed" | "cancelled";
export type Run = {
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
});

export function createRun(app: App, input: { kind: RunKind; spaceId?: string | null; title: string; input?: Record<string, unknown>; parentId?: string | null }) {
  const id = newId("r");
  run(
    app.db,
    "insert into runs(id,kind,space_id,status,title,input,parent_id,created_at) values(?,?,?,?,?,?,?,?)",
    id,
    input.kind,
    input.spaceId ?? null,
    "queued",
    input.title,
    JSON.stringify(input.input ?? {}),
    input.parentId ?? null,
    now(),
  );
  app.emit({ type: "run", runId: id, status: "queued" });
  queueMicrotask(() => kick(app));
  return getRun(app, id);
}

export function getRun(app: App, id: string): Run {
  const r = one<Row>(app.db, "select * from runs where id = ?", id);
  if (!r) throw new HttpError(404, `运行记录不存在：${id}`);
  return toRun(r);
}

export function listRuns(app: App, opts: { kind?: string; spaceId?: string; status?: string; parentId?: string; limit?: number } = {}) {
  const where: string[] = [];
  const params: string[] = [];
  if (opts.kind) where.push("kind = ?"), params.push(opts.kind);
  if (opts.spaceId) where.push("space_id = ?"), params.push(opts.spaceId);
  if (opts.status) where.push("status = ?"), params.push(opts.status);
  if (opts.parentId) where.push("parent_id = ?"), params.push(opts.parentId);
  return all<Row>(app.db, `select * from runs ${where.length ? "where " + where.join(" and ") : ""} order by created_at desc limit ?`, ...params, opts.limit ?? 100).map(toRun);
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
let active = 0;
let started = false;

export function registerHandler(kind: RunKind, handler: Handler) {
  handlers.set(kind, handler);
}

export function startWorker(app: App) {
  if (started) return;
  started = true;
  // Runs interrupted by a restart go back to the queue; handlers are written to be re-runnable.
  run(app.db, "update runs set status = 'queued', started_at = null where status = 'running'");
  setInterval(() => kick(app), 2000).unref();
  kick(app);
}

function kick(app: App) {
  if (!started) return;
  while (active < app.config.concurrency) {
    const next = one<Row>(app.db, "select * from runs where status = 'queued' order by created_at limit 1");
    if (!next) return;
    const handler = handlers.get(next.kind);
    if (!handler) {
      run(app.db, "update runs set status='failed', error=?, finished_at=? where id=?", `没有处理器：${next.kind}`, now(), next.id);
      continue;
    }
    // Atomic claim: several processes (server, CLI) may share one library.
    if (run(app.db, "update runs set status='running', started_at=? where id=? and status='queued'", now(), next.id).changes !== 1) continue;
    app.emit({ type: "run", runId: next.id, status: "running" });
    active++;
    const controller = new AbortController();
    controllers.set(next.id, controller);
    const r = toRun({ ...next, status: "running" });
    const ctx: RunContext = {
      app,
      run: r,
      signal: controller.signal,
      event: (type, data) => addRunEvent(app, r.id, type, data),
      output: (data) => setRunOutput(app, r.id, data),
    };
    handler(ctx)
      .then((out) => {
        flushText(app, r.id);
        if (out) setRunOutput(app, r.id, out);
        const status = controller.signal.aborted ? "cancelled" : "done";
        run(app.db, "update runs set status=?, finished_at=? where id=?", status, now(), r.id);
        app.emit({ type: "run", runId: r.id, status });
      })
      .catch((error: Error) => {
        flushText(app, r.id);
        const cancelled = controller.signal.aborted || error.message === "CANCELLED";
        run(app.db, "update runs set status=?, error=?, finished_at=? where id=?", cancelled ? "cancelled" : "failed", cancelled ? null : error.message, now(), r.id);
        if (!cancelled) addRunEvent(app, r.id, "error", { message: error.message });
        app.emit({ type: "run", runId: r.id, status: cancelled ? "cancelled" : "failed" });
      })
      .finally(() => {
        active--;
        controllers.delete(r.id);
        seqs.delete(r.id);
        kick(app);
      });
  }
}

export function cancelRun(app: App, id: string) {
  const r = getRun(app, id);
  if (r.status === "queued") {
    run(app.db, "update runs set status='cancelled', finished_at=? where id=?", now(), id);
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
