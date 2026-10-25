import type { App } from "../core/app.ts";
import { all } from "../core/db.ts";
import { allProfiles, builtinProfiles, type AgentProfile } from "../core/config.ts";
import { backendAvailable } from "./availability.ts";

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

/** A limit of 0: the owner does not want this model (or backend) used automatically. */
export const excluded = (app: App, p: AgentProfile) => limitOf(app, p) <= 0;

/**
 * Take a slot on the first option with room (options in order of preference: the run's own choice
 * first, then its alternatives). With none free, wait until one frees up. Excluded options (limit 0)
 * are skipped; when every option is excluded — the run was pinned to one by the owner — the first
 * runs anyway, uncounted against anything else.
 */
export async function acquire(app: App, options: AgentProfile[], opts: { runId: string | null; signal?: AbortSignal; onWait?: (text: string) => void }) {
  const usable = options.filter((p) => !excluded(app, p));
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

/** One line per model: what it takes now, and its recent record (for the assistant choosing a model). */
export function loadLines(app: App, models: { profile: AgentProfile; model?: string }[]) {
  const stats = recentStats(app);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of models) {
    const p = { ...m.profile, model: m.model ?? m.profile.model };
    const k = `${p.id}|${p.model ?? ""}`;
    if (seen.has(k) || excluded(app, p)) continue;
    seen.add(k);
    const st = stats.find((x) => x.profile === p.id && x.model === (p.model ?? ""));
    const waiting = [...state(app).slots].filter((x) => x.waiting && x.key === keyOf(p)).length;
    const rec = st ? `；近 7 天完成 ${st.done}、失败 ${st.failed}${st.medianMinutes !== null ? `、中位 ${st.medianMinutes} 分钟` : ""}` : "";
    const cap = backendLimitOf(app, p);
    out.push(`- ${label(p)}：正在用 ${usedOf(app, p)}/${limitOf(app, p)}${cap !== undefined ? `（${p.id} 合计 ${backendUsedOf(app, p)}/${cap}）` : ""}${waiting ? `，等 ${waiting}` : ""}${rec}`);
  }
  return out;
}
