import { monitorEventLoopDelay, performance, type IntervalHistogram } from "node:perf_hooks";

/**
 * Who held the main thread. Every HTTP request, tool call, schedule, Agent reply and timer runs on
 * one event loop; a synchronous step that takes seconds (a big SQLite query, a `spawnSync` git, a
 * large JSON) stops all of them at once, and the symptom shows up somewhere else (a share page that
 * will not open, a tool call that "hangs"). A timer notices the gap; the names come from
 *
 * - spans: synchronous steps that time themselves (`syncSpan`, and the helpers that already go
 *   through one place: `all/one/run` in core/db.ts, `git()` in core/git.ts). One `performance.now()`
 *   before and after; only steps of `SPAN_MS` or more are kept.
 * - marks: what started running (`mark`: an HTTP route, a tool, a schedule). A stall that no span
 *   covers names what began just before it.
 *
 * Both are kept in small rings; nothing here allocates per call unless the step was slow.
 */

const TICK_MS = 100;
const SPAN_MS = 100;
let stallMs = 500;

type Span = { name: string; ms: number; end: number };
type Mark = { label: string; t: number };
export type Stall = { at: string; ms: number; spans: { name: string; ms: number }[]; started: string[] };

const spans: Span[] = [];
const marks: Mark[] = [];
const stalls: Stall[] = [];
const byName = new Map<string, { n: number; totalMs: number; maxMs: number; lastAt: string }>();
let histogram: IntervalHistogram | null = null;
let timer: NodeJS.Timeout | null = null;
let startedAt = "";
let maxLagMs = 0;

const push = <T>(ring: T[], item: T, keep: number) => {
  ring.push(item);
  if (ring.length > keep) ring.shift();
};

/** Something started on the main thread (cheap: a label and a timestamp in a ring). */
export function mark(label: string) {
  push(marks, { label: label.slice(0, 120), t: performance.now() }, 64);
}

/** A synchronous step finished `ms` after `start` (performance.now()); kept when slow. */
export function noteSync(name: string, start: number) {
  const end = performance.now();
  const ms = end - start;
  if (ms < SPAN_MS) return;
  const label = name.replace(/\s+/g, " ").trim().slice(0, 160);
  push(spans, { name: label, ms: Math.round(ms), end }, 64);
  const s = byName.get(label) ?? { n: 0, totalMs: 0, maxMs: 0, lastAt: "" };
  s.n++;
  s.totalMs += Math.round(ms);
  s.maxMs = Math.max(s.maxMs, Math.round(ms));
  s.lastAt = new Date().toISOString();
  byName.set(label, s);
  if (byName.size > 300) {
    // Keep the heaviest names; a long tail of one-off queries is not what diag is for.
    const keep = [...byName].sort((a, b) => b[1].totalMs - a[1].totalMs).slice(0, 200);
    byName.clear();
    for (const [k, v] of keep) byName.set(k, v);
  }
}

/** Run a synchronous step under a name; slow ones are reported with any stall they cause. */
export function syncSpan<T>(name: string, fn: () => T): T {
  const start = performance.now();
  try {
    return fn();
  } finally {
    noteSync(name, start);
  }
}

/** SQL text as a span name: one line, literals kept (they are parameters anyway), shortened. */
export function sqlName(sql: string) {
  return "sql " + sql.replace(/\s+/g, " ").trim().slice(0, 120);
}

function schedule() {
  const expected = performance.now() + TICK_MS;
  timer = setTimeout(() => tick(expected), TICK_MS);
  timer.unref();
}

function tick(expected: number) {
  const now = performance.now();
  const lag = now - expected;
  if (lag > maxLagMs) maxLagMs = lag;
  if (lag >= stallMs) {
    const from = expected - TICK_MS;
    const during = spans.filter((s) => s.end > from).sort((a, b) => b.ms - a.ms).slice(0, 3).map(({ name, ms }) => ({ name, ms }));
    const started = [...new Set(marks.filter((m) => m.t > from).map((m) => m.label))].slice(-5);
    const stall: Stall = { at: new Date().toISOString(), ms: Math.round(lag), spans: during, started };
    push(stalls, stall, 30);
    const who = during.length ? during.map((s) => `${s.name}（${s.ms} ms）`).join("；") : "没有计时的同步步骤";
    console.warn(`[omem] 事件循环卡了 ${stall.ms} ms：${who}${started.length ? `；期间开始的：${started.join("、")}` : ""}`);
  }
  schedule();
}

/** Start watching (idempotent). `thresholdMs`: a gap this long is logged. */
export function startLoopMonitor(opts: { thresholdMs?: number } = {}) {
  if (opts.thresholdMs) stallMs = opts.thresholdMs;
  if (timer) return;
  startedAt = new Date().toISOString();
  histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  schedule();
}

export function stopLoopMonitor() {
  if (timer) clearTimeout(timer);
  timer = null;
  histogram?.disable();
  histogram = null;
}

/** For diag: the loop's delay since start, recent stalls with their names, and the slowest synchronous steps. */
export function loopStats() {
  const h = histogram;
  const ms = (ns: number) => Math.round(ns / 1e6);
  return {
    since: startedAt || null,
    thresholdMs: stallMs,
    delay: h ? { p50Ms: ms(h.percentile(50)), p99Ms: ms(h.percentile(99)), maxMs: ms(h.max) } : null,
    maxLagMs: Math.round(maxLagMs),
    stalls: [...stalls].reverse(),
    slowestSync: [...byName].map(([name, s]) => ({ name, ...s })).sort((a, b) => b.maxMs - a.maxMs).slice(0, 15),
    heaviestSync: [...byName].map(([name, s]) => ({ name, ...s })).sort((a, b) => b.totalMs - a.totalMs).slice(0, 10),
  };
}

/** Tests. */
export function resetLoopStats() {
  spans.length = 0;
  marks.length = 0;
  stalls.length = 0;
  byName.clear();
  maxLagMs = 0;
}
