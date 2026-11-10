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
 * A limit of 0 (the owner does not want this model or backend used automatically), an account (or
 * one of its models) whose usage quota ran out and has not reset yet, or a model that reached the
 * owner's daily cap for it.
 */
export const excluded = (app: App, p: AgentProfile) => limitOf(app, p) <= 0 || outOfQuotaUntil(app, p) !== null || !!dailyCapReached(app, p);

/** Why the option is left out of automatic choices, in words, or null. */
export function excludedReason(app: App, p: AgentProfile): string | null {
  if (limitOf(app, p) <= 0) return "并行上限设成了 0";
  const until = outOfQuotaUntil(app, p);
  if (until) return `额度用完，${new Date(until).toLocaleString("zh-CN", { hour12: false, timeZone: app.config.timezone, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })} 恢复`;
  return dailyCapReached(app, p);
}

/**
 * The owner's cap on runs per day for one model (`limits[].perDay`): a provider that limits some
 * models per day without saying how much is left (in its model list or its errors) is kept under it
 * by omem's own count — runs that started on that backend and model since midnight in the owner's
 * time zone. Counted again at most every 30 seconds.
 */
export function perDayOf(app: App, p: AgentProfile): number | undefined {
  return limitsFor(app, p).find((l) => l.model && l.model === p.model && l.perDay !== undefined)?.perDay;
}
const dayCounts = new WeakMap<App, Map<string, { at: number; n: number }>>();
export function usedToday(app: App, p: AgentProfile, now = Date.now()): number {
  let m = dayCounts.get(app);
  if (!m) { m = new Map(); dayCounts.set(app, m); }
  const k = keyOf(p);
  const hit = m.get(k);
  if (hit && now - hit.at < 30_000) return hit.n;
  const since = new Date(now - msSinceMidnight(app.config.timezone, now)).toISOString();
  const ids = [...new Set([p.id, sourceOf(p), ...allProfiles(app.config).filter((q) => sourceOf(q) === sourceOf(p)).map((q) => q.id)])];
  const n = one<{ n: number }>(
    app.db,
    "select count(*) n from runs where coalesce(started_at, created_at) >= ? and json_extract(ai, '$.profile') in (select value from json_each(?)) and lower(coalesce(json_extract(ai, '$.model'), '')) = lower(?)",
    since,
    JSON.stringify(ids),
    p.model ?? "",
  )?.n ?? 0;
  m.set(k, { at: now, n });
  return n;
}
export function dailyCapReached(app: App, p: AgentProfile, now = Date.now()): string | null {
  const cap = perDayOf(app, p);
  if (cap === undefined || !app.db) return null;
  const used = usedToday(app, p, now);
  return used >= cap ? `今天已用 ${used} 次，达到本人设的每天 ${cap} 次` : null;
}

/** How long since midnight in a time zone (the owner's day for daily caps and daily quotas). */
export function msSinceMidnight(timeZone: string, now = Date.now()): number {
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "numeric", second: "numeric", hourCycle: "h23" }).formatToParts(new Date(now)).map((x) => [x.type, x.value]));
    return ((Number(parts.hour) % 24) * 3600 + Number(parts.minute) * 60 + Number(parts.second)) * 1000 + (now % 1000);
  } catch {
    const d = new Date(now);
    return now - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  }
}

/**
 * A backend that just broke down (its process died, the connection dropped, it went silent past the
 * idle watchdog), or one of its models that keeps failing upstream or queued past the owner's limit:
 * runs try it after the others for a while, so each of them does not wait out the same hang. A crash
 * sets the whole backend aside; an upstream stream error (twice within the window) or a queue
 * timeout only that model. Kept in memory: a restart gives every backend a fresh start.
 */
const DOWN_MS = 15 * 60_000;
type Down = { until: number; why: string };
const downs = new WeakMap<App, Map<string, Down>>();
const strikes = new WeakMap<App, Map<string, number[]>>();
const downMap = (app: App) => {
  let m = downs.get(app);
  if (!m) { m = new Map(); downs.set(app, m); }
  return m;
};
export function markDown(app: App, p: AgentProfile, why: string, now = Date.now(), scope: "backend" | "model" = "backend") {
  downMap(app).set(scope === "model" ? keyOf(p) : sourceOf(p), { until: now + DOWN_MS, why: why.slice(0, 200) });
}
/**
 * One failure of a kind that says the backend is not usable right now. `crash` and `queue` set it
 * aside at once; `transient` (the upstream stream broke) only on the second within the window, since
 * one broken stream says little. Returns what was set aside, in words, or null.
 */
export function noteFailure(app: App, p: AgentProfile, kind: "crash" | "transient" | "queue", why: string, now = Date.now()): string | null {
  const label = `${p.id}${p.model ? ` · ${p.model}` : ""}`;
  if (kind === "crash") {
    markDown(app, p, why, now);
    return `${p.id} 刚出故障，15 分钟内排在其他后端之后`;
  }
  if (kind === "queue") {
    markDown(app, p, why, now, "model");
    return `${label} 排队太久，15 分钟内排在其他模型之后`;
  }
  let m = strikes.get(app);
  if (!m) { m = new Map(); strikes.set(app, m); }
  const k = keyOf(p);
  const recent = [...(m.get(k) ?? []).filter((t) => now - t < DOWN_MS), now];
  m.set(k, recent);
  if (recent.length < 2) return null;
  markDown(app, p, why, now, "model");
  return `${label} ${Math.round(DOWN_MS / 60_000)} 分钟内上游出错 ${recent.length} 次，暂时排在其他模型之后`;
}
/** Why this backend or model is set aside for now (it broke down a few minutes ago), or null. */
export function downReason(app: App, p: AgentProfile, now = Date.now()): string | null {
  const m = downs.get(app);
  for (const k of [sourceOf(p), keyOf(p)]) {
    const e = m?.get(k);
    if (e && e.until > now) return e.why;
  }
  return null;
}
export function clearDown(app: App, p: AgentProfile) {
  downs.get(app)?.delete(sourceOf(p));
  downs.get(app)?.delete(keyOf(p));
  strikes.get(app)?.delete(keyOf(p));
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
/**
 * Kept per account (`source`), or per model of an account (`source|model`) when the provider said a
 * limit of one model was reached (a model's own daily limit): the account's other models stay usable.
 */
export function outOfQuotaUntil(app: App, p: AgentProfile): string | null {
  const st = quotaState(app);
  for (const k of [sourceOf(p), ...(p.model ? [keyOf(p)] : [])]) {
    const e = st[k];
    if (e && Date.parse(e.until) > Date.now()) return e.until;
  }
  return null;
}
export function markOutOfQuota(app: App, p: AgentProfile, message: string, at = new Date()) {
  const st = Object.fromEntries(Object.entries(quotaState(app)).filter(([, e]) => Date.parse(e.until) > at.getTime()));
  const perModel = !!p.model && isModelQuotaMessage(message, p.model);
  const until = quotaResetAt(message, at, app.config.timezone);
  st[perModel ? keyOf(p) : sourceOf(p)] = { until: until.toISOString(), message: message.slice(0, 300) };
  run(app.db, "insert into kv(key, value) values(?, ?) on conflict(key) do update set value = excluded.value", QUOTA_KEY, JSON.stringify(st));
  return until;
}
/** Owner's "it has more credits now": use the account (or the one model) again. */
export function clearOutOfQuota(app: App, source: string) {
  const st = quotaState(app);
  delete st[source];
  run(app.db, "insert into kv(key, value) values(?, ?) on conflict(key) do update set value = excluded.value", QUOTA_KEY, JSON.stringify(st));
}
export function outOfQuotaList(app: App) {
  return Object.entries(quotaState(app)).filter(([, e]) => Date.parse(e.until) > Date.now()).map(([key, e]) => {
    const [source, model] = key.split("|");
    return { source: key, ...(model ? { account: source, model } : {}), ...e };
  });
}

/** Wording of a limit counted per day ("daily limit", "今日额度"). */
const DAILY = /\bdaily\b|per[ -]day|\btoday\b|今日|今天|每日|每天|单日|当日/i;

/**
 * Whether an error says a usage quota is spent (not a short rate limit): the account's plan, or one
 * model's own limit ("daily limit reached for this model", "该模型今日额度已用完").
 */
export const isQuotaMessage = (text: string) =>
  /usage limit|usageLimitExceeded|quota_exhausted|insufficient_quota|exceeded your current quota|out of credits|额度(已)?(用(完|尽)|耗尽)|(daily|per[ -]day) (usage |request |token )?(limit|quota)|(limit|quota) (has been |was )?(reached|exceeded|exhausted) for (this |the )?model|(今日|今天|每日|每天|单日|当日)[^。\n]{0,12}(上限|限额|额度|次数)[^。\n]{0,8}(已|用|达|超)/i.test(text);

/** The spent limit is one model's (it is named, or the limit is per day): only that model is left out. */
export function isModelQuotaMessage(text: string, model: string) {
  return DAILY.test(text) || (model.length > 2 && text.toLowerCase().includes(model.toLowerCase()));
}

/**
 * When the quota resets, from the provider's message: "try again at 2:36 PM" (the machine's local
 * time, the next such time), "at Nov 6th, 2026 2:36 PM", or "in 3 hours 5 minutes". A limit worded
 * per day without a time resets at the owner's next midnight; anything else in an hour.
 */
export function quotaResetAt(message: string, at = new Date(), timeZone?: string): Date {
  const fallback = DAILY.test(message) && timeZone ? new Date(at.getTime() + 86_400_000 - msSinceMidnight(timeZone, at.getTime())) : null;
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
  return d && ok(d) ? d : fallback ?? new Date(at.getTime() + 3_600_000);
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

