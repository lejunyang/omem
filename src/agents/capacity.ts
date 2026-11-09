import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { allProfiles, builtinProfiles, type AgentProfile } from "../core/config.ts";
import { backendAvailable } from "./availability.ts";
import { quotaAvoid } from "./quota.ts";

/**
 * How many runs each model takes at a time. A provider's quota is per account (the source: an ACP
 * agent and its CLI fallback are one account) and per model, so slots are counted by source and
 * model, not by omem's own queue. Role runs take a slot before they start (and wait, or move to a
 * free alternative, when it is full); conversation turns are counted but never wait.
 */

type Slot = { key: string; runId: string | null; waiting: boolean };
type State = { slots: Set<Slot>; wake: Set<() => void> };
const states = new WeakMap<App, State>();
function state(app: App) {
  let s = states.get(app);
  if (!s) { s = { slots: new Set(), wake: new Set() }; states.set(app, s); }
  return s;
}

export function sourceOf(p: AgentProfile) {
  return p.source ?? builtinProfiles.find((b) => b.id === p.id)?.source ?? p.id;
}
const keyOf = (p: AgentProfile) => `${sourceOf(p)}|${p.model ?? ""}`;

const limitsFor = (app: App, p: AgentProfile) => {
  const src = sourceOf(p);
  return app.config.agents.capacity.limits.filter((l) => l.profile === p.id || l.profile === src);
};
/** One model's limit: its own `limits` entry, else `perModel`. */
export function limitOf(app: App, p: AgentProfile) {
  const own = limitsFor(app, p).find((l) => l.model && l.model === p.model);
  return Math.min(own ? own.max : app.config.agents.capacity.perModel, backendLimitOf(app, p) ?? Infinity);
}
/** The backend's cap across all its models, when one is set. */
export function backendLimitOf(app: App, p: AgentProfile): number | undefined {
  return limitsFor(app, p).find((l) => !l.model)?.max;
}

export function usedOf(app: App, p: AgentProfile) {
  const k = keyOf(p);
  return [...state(app).slots].filter((s) => s.key === k && !s.waiting).length;
}
export function backendUsedOf(app: App, p: AgentProfile) {
  const src = `${sourceOf(p)}|`;
  return [...state(app).slots].filter((s) => s.key.startsWith(src) && !s.waiting).length;
}

const hasRoom = (app: App, p: AgentProfile) => usedOf(app, p) < limitOf(app, p) && backendUsedOf(app, p) < (backendLimitOf(app, p) ?? Infinity);

function take(app: App, p: AgentProfile, runId: string | null) {
  const s = state(app);
  const slot: Slot = { key: keyOf(p), runId, waiting: false };
  s.slots.add(slot);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    s.slots.delete(slot);
    for (const w of [...s.wake]) w();
  };
}

/** Count a run that must not wait (a reply to the owner); released when the run ends. */
export function holdForRun(app: App, p: AgentProfile, runId: string) {
  const release = take(app, p, runId);
  runHolds.set(runId, [...(runHolds.get(runId) ?? []), release]);
}
const runHolds = new Map<string, (() => void)[]>();
export function releaseRun(runId: string) {
  for (const r of runHolds.get(runId) ?? []) r();
  runHolds.delete(runId);
}

/**
 * A limit of 0 (the owner does not want this model or backend used automatically), or an account
 * whose usage quota ran out and has not reset yet.
 */
export const excluded = (app: App, p: AgentProfile) => limitOf(app, p) <= 0 || outOfQuotaUntil(app, p) !== null;

/**
 * A backend that just broke down (its process died, the connection dropped, it went silent past the
 * idle watchdog): runs try it after the others for a while, so each of them does not wait out the
 * same hang. Kept in memory: a restart gives every backend a fresh start.
 */
const DOWN_MS = 15 * 60_000;
const downs = new WeakMap<App, Map<string, { until: number; why: string }>>();
export function markDown(app: App, p: AgentProfile, why: string, now = Date.now()) {
  let m = downs.get(app);
  if (!m) { m = new Map(); downs.set(app, m); }
  m.set(sourceOf(p), { until: now + DOWN_MS, why: why.slice(0, 200) });
}
/** Why this backend is set aside for now (it broke down a few minutes ago), or null. */
export function downReason(app: App, p: AgentProfile, now = Date.now()): string | null {
  const e = downs.get(app)?.get(sourceOf(p));
  return e && e.until > now ? e.why : null;
}
export function clearDown(app: App, p: AgentProfile) {
  downs.get(app)?.delete(sourceOf(p));
}

/**
 * Usage quota per account (source): Codex says "You've hit your usage limit … try again at 2:36 PM"
 * when the plan's quota is spent, and every model of the account fails until then. The account is
 * left out of automatic choices until that time (an hour when the message gives none), so runs go to
 * the fallbacks right away instead of failing one by one. Kept in kv: a restart does not forget it.
 */
const QUOTA_KEY = "agent_quota_exhausted";
function quotaState(app: App): Record<string, { until: string; message: string }> {
  try { return JSON.parse(one<{ value: string }>(app.db, "select value from kv where key = ?", QUOTA_KEY)?.value ?? "{}"); } catch { return {}; }
}
export function outOfQuotaUntil(app: App, p: AgentProfile): string | null {
  const e = quotaState(app)[sourceOf(p)];
  return e && Date.parse(e.until) > Date.now() ? e.until : null;
}
export function markOutOfQuota(app: App, p: AgentProfile, message: string, at = new Date()) {
  const st = Object.fromEntries(Object.entries(quotaState(app)).filter(([, e]) => Date.parse(e.until) > at.getTime()));
  const until = quotaResetAt(message, at);
  st[sourceOf(p)] = { until: until.toISOString(), message: message.slice(0, 300) };
  run(app.db, "insert into kv(key, value) values(?, ?) on conflict(key) do update set value = excluded.value", QUOTA_KEY, JSON.stringify(st));
  return until;
}
/** Owner's "it has more credits now": use the account again. */
export function clearOutOfQuota(app: App, source: string) {
  const st = quotaState(app);
  delete st[source];
  run(app.db, "insert into kv(key, value) values(?, ?) on conflict(key) do update set value = excluded.value", QUOTA_KEY, JSON.stringify(st));
}
export function outOfQuotaList(app: App) {
  return Object.entries(quotaState(app)).filter(([, e]) => Date.parse(e.until) > Date.now()).map(([source, e]) => ({ source, ...e }));
}

/** Whether an error says the account's usage quota is spent (not a short rate limit). */
export const isQuotaMessage = (text: string) => /usage limit|usageLimitExceeded|quota_exhausted|insufficient_quota|exceeded your current quota|out of credits|额度(已)?用(完|尽)/i.test(text);

/**
 * When the quota resets, from the provider's message: "try again at 2:36 PM" (the machine's local
 * time, the next such time), "at Nov 6th, 2026 2:36 PM", or "in 3 hours 5 minutes". An hour when none.
 */
export function quotaResetAt(message: string, at = new Date()): Date {
  const ok = (d: Date) => d.getTime() > at.getTime() && d.getTime() - at.getTime() < 8 * 86_400_000;
  const tail = /try again (at|in) ([^.\n]+)/i.exec(message);
  let d: Date | null = null;
  if (tail?.[1].toLowerCase() === "in") {
    const unit: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000 };
    let ms = 0;
    for (const m of tail[2].matchAll(/(\d+)\s*(day|hour|hr|minute|min)/gi)) ms += Number(m[1]) * unit[m[2][0].toLowerCase()];
    if (ms) d = new Date(at.getTime() + ms);
  } else if (tail) {
    const text = tail[2].replace(/(\d)(st|nd|rd|th)\b/g, "$1").trim();
    const time = /^(\d{1,2}):(\d{2})\s*([AP]M)?$/i.exec(text);
    if (time) {
      d = new Date(at);
      const h = Number(time[1]);
      d.setHours(time[3] ? (h % 12) + (time[3].toUpperCase() === "PM" ? 12 : 0) : h, Number(time[2]), 0, 0);
      if (d.getTime() <= at.getTime()) d.setDate(d.getDate() + 1);
    } else d = new Date(Date.parse(text));
  }
  return d && ok(d) ? d : new Date(at.getTime() + 3_600_000);
}

/**
 * Take a slot on the first option with room (options in order of preference: the run's own choice
 * first, then its alternatives). With none free, wait until one frees up. An account whose plan limit
 * is nearly used (quota.ts quotaAvoid) goes after the others, and a backend that just broke down (markDown) after those. Excluded options (limit 0) are skipped; when every option is excluded — the run was pinned to one by the owner — the first
 * runs anyway, uncounted against anything else.
 */
export async function acquire(app: App, options: AgentProfile[], opts: { runId: string | null; signal?: AbortSignal; onWait?: (text: string) => void }) {
  const allowed = options.filter((p) => !excluded(app, p));
  // Healthy first, then accounts whose plan is nearly used, then backends that just broke down.
  const rank = (p: AgentProfile) => (downReason(app, p) ? 2 : quotaAvoid(app, p) ? 1 : 0);
  const usable = [0, 1, 2].flatMap((r) => allowed.filter((p) => rank(p) === r));
  if (!usable.length) return { index: 0, release: take(app, options[0], opts.runId) };
  const s = state(app);
  const marker: Slot = { key: keyOf(usable[0]), runId: opts.runId, waiting: true };
  let told = false;
  try {
    for (;;) {
      if (opts.signal?.aborted) throw new Error("CANCELLED");
      const free = usable.find((p) => hasRoom(app, p));
      if (free) return { index: options.indexOf(free), release: take(app, free, opts.runId) };
      if (!told) {
        s.slots.add(marker);
        opts.onWait?.(`等模型空位：${usable.map((p) => `${label(p)} ${usedOf(app, p)}/${limitOf(app, p)}${backendLimitOf(app, p) !== undefined ? `（${p.id} 共 ${backendUsedOf(app, p)}/${backendLimitOf(app, p)}）` : ""}`).join("，")}`);
        told = true;
      }
      await new Promise<void>((resolve) => {
        const wake = () => { s.wake.delete(wake); clearTimeout(timer); opts.signal?.removeEventListener("abort", wake); resolve(); };
        // A periodic look as well: limits change in settings without any release.
        const timer = setTimeout(wake, 30_000);
        s.wake.add(wake);
        opts.signal?.addEventListener("abort", wake, { once: true });
      });
    }
  } finally {
    s.slots.delete(marker);
  }
}

const label = (p: { id: string; model?: string }) => `${p.id}${p.model ? ` · ${p.model}` : ""}`;

/**
 * Profiles worth offering as a choice: installed, and not a CLI fallback whose ACP agent of the
 * same source is installed (the two share one account; ACP has sessions and tools).
 */
export function choosableProfiles(app: App) {
  const installed = allProfiles(app.config).filter((p) => backendAvailable(p, app.home));
  const acpSources = new Set(installed.filter((p) => p.transport === "acp").map(sourceOf));
  return installed.filter((p) => p.transport === "acp" || p.transport === "doubao" || !acpSources.has(sourceOf(p)));
}

/** Models in use or waiting now, and how each did in the last 7 days. */
export function loadReport(app: App) {
  const s = state(app);
  const byKey = new Map<string, { source: string; model: string; used: number; waiting: number }>();
  for (const slot of s.slots) {
    const [source, model] = slot.key.split("|");
    const e = byKey.get(slot.key) ?? { source, model, used: 0, waiting: 0 };
    if (slot.waiting) e.waiting++; else e.used++;
    byKey.set(slot.key, e);
  }
  return [...byKey.values()];
}

export type ModelStats = { profile: string; model: string; done: number; failed: number; medianMinutes: number | null };
/** Finished runs per backend and model over the last 7 days: how often they fail and how long they take. */
export function recentStats(app: App): ModelStats[] {
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const rows = all<{ profile: string | null; model: string | null; status: string; started_at: string | null; finished_at: string | null }>(
    app.db,
    `select json_extract(ai, '$.profile') profile, json_extract(ai, '$.model') model, status, started_at, finished_at
       from runs where ai is not null and finished_at >= ? and status in ('done', 'failed')`,
    since,
  );
  const groups = new Map<string, { profile: string; model: string; done: number; failed: number; minutes: number[] }>();
  for (const r of rows) {
    if (!r.profile) continue;
    const k = `${r.profile}|${r.model ?? ""}`;
    const g = groups.get(k) ?? { profile: r.profile, model: r.model ?? "", done: 0, failed: 0, minutes: [] };
    if (r.status === "done") g.done++; else g.failed++;
    if (r.started_at && r.finished_at) g.minutes.push((Date.parse(r.finished_at) - Date.parse(r.started_at)) / 60_000);
    groups.set(k, g);
  }
  return [...groups.values()].map((g) => {
    const m = g.minutes.sort((a, b) => a - b);
    return { profile: g.profile, model: g.model, done: g.done, failed: g.failed, medianMinutes: m.length ? Math.round(m[Math.floor(m.length / 2)] * 10) / 10 : null };
  });
}

