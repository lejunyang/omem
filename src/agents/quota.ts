import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { App } from "../core/app.ts";
import { one, run } from "../core/db.ts";
import type { AgentProfile } from "../core/config.ts";
import { catalogEntry } from "./catalog.ts";
import { sourceOf } from "./capacity.ts";
import { launch, resolveCommand, stop } from "./spawn.ts";
import type { AgentEvent } from "./types.ts";

/**
 * The plan usage limits of the account behind a backend (its source): what share of each window
 * (Codex: a 5-hour one on some plans and a weekly one; Claude: 5 hours, the week, per model) is used
 * and when it resets. Read without spending any of it — Codex through `codex app-server`
 * (account/rateLimits/read), Claude through its local `/usage` command in an ACP session — and kept
 * current by the rate-limit events a turn reports (`_claude/rateLimit` on usage_update, the CLI's
 * rate_limit_event). Kept in kv per source; a window whose reset has passed counts as unknown.
 *
 * What it is for: a role run's choices put an account that is nearly out last (`quotaAvoid`), and
 * list_ai_backends shows the numbers so the assistant can weigh them. A spent account is still left
 * out by the error path (capacity.ts markOutOfQuota).
 */

export type QuotaWindow = {
  /** "5h", "7d", "7d · Opus" … */
  name: string;
  usedPercent: number;
  windowMinutes?: number;
  resetsAt?: string;
  /** A window that counts only one family of models (lower case, matched against the model name). */
  model?: string;
};
export type QuotaSnapshot = { at: string; via: "codex-app-server" | "claude-usage" | "event"; plan?: string; windows: QuotaWindow[]; error?: string };

const KEY = "agent_quota";
const DAY = 86_400_000;

export const quotaKind = (p: AgentProfile) => catalogEntry(sourceOf(p))?.quota;

function store(app: App): Record<string, QuotaSnapshot> {
  if (!app.db) return {};
  try { return JSON.parse(one<{ value: string }>(app.db, "select value from kv where key = ?", KEY)?.value ?? "{}"); } catch { return {}; }
}
function save(app: App, source: string, snap: QuotaSnapshot) {
  const all = store(app);
  all[source] = snap;
  run(app.db, "insert into kv(key, value) values(?, ?) on conflict(key) do update set value = excluded.value", KEY, JSON.stringify(all));
}

export function quotaOf(app: App, p: AgentProfile): QuotaSnapshot | null {
  return quotaKind(p) ? store(app)[sourceOf(p)] ?? null : null;
}

/** Windows still running (their reset not past) and relevant to the profile's model. */
function liveWindows(snap: QuotaSnapshot | null, model?: string | null, now = Date.now()) {
  return (snap?.windows ?? []).filter((w) => (!w.resetsAt || Date.parse(w.resetsAt) > now) && (!w.model || !model || model.toLowerCase().includes(w.model)));
}

/**
 * Why this account should go after the others now, or null: a window used past `quotaAvoidAbove`,
 * or a window of a day or longer with less than `quotaPerDayBelow` percent left per day until it
 * resets (a day at least: the last hours before a reset are not stretched out).
 */
export function quotaAvoid(app: App, p: AgentProfile, now = Date.now()): string | null {
  if (!app.db || !quotaKind(p)) return null;
  const { quotaAvoidAbove = 90, quotaPerDayBelow = 0 } = app.config.agents.capacity;
  for (const w of liveWindows(quotaOf(app, p), p.model, now)) {
    if (quotaAvoidAbove < 100 && w.usedPercent >= quotaAvoidAbove) return `${w.name} 已用 ${Math.round(w.usedPercent)}%`;
    const perDay = perDayLeft(w, now);
    if (quotaPerDayBelow > 0 && perDay !== null && perDay < quotaPerDayBelow) return `${w.name} 剩 ${Math.round(100 - w.usedPercent)}%，距重置 ${days(w, now)} 天，每天约 ${perDay.toFixed(1)}%`;
  }
  return null;
}

const days = (w: QuotaWindow, now: number) => (w.resetsAt ? Math.round(((Date.parse(w.resetsAt) - now) / DAY) * 10) / 10 : null);
/** Remaining percent per day until the reset, for windows of a day or longer. */
export function perDayLeft(w: QuotaWindow, now = Date.now()): number | null {
  if (!w.resetsAt || (w.windowMinutes ?? 0) < 1440) return null;
  const d = Math.max((Date.parse(w.resetsAt) - now) / DAY, 1);
  return Math.max(0, 100 - w.usedPercent) / d;
}

function resetsIn(iso: string | undefined, now: number) {
  if (!iso) return undefined;
  const m = Math.max(0, Math.round((Date.parse(iso) - now) / 60_000));
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), min = m % 60;
  return d ? `${d}天${h}小时` : h ? `${h}小时${min}分` : `${min}分`;
}

/** What the assistant and the settings page see for one account. */
export function quotaView(app: App, p: AgentProfile, now = Date.now()) {
  const snap = quotaOf(app, p);
  if (!snap) return null;
  const windows = liveWindows(snap, null, now).map((w) => {
    const perDay = perDayLeft(w, now);
    return { name: w.name, used: Math.round(w.usedPercent), ...(w.model ? { model: w.model } : {}), ...(w.resetsAt ? { resetsAt: w.resetsAt, resetsIn: resetsIn(w.resetsAt, now) } : {}), ...(perDay !== null ? { perDayLeft: Math.round(perDay * 10) / 10 } : {}) };
  });
  const avoid = quotaAvoid(app, p, now);
  return { source: sourceOf(p), plan: snap.plan ?? null, readAt: snap.at, windows, ...(avoid ? { avoid } : {}), ...(snap.error ? { error: snap.error } : {}) };
}

// ---------------------------------------------------------------- reading

const windowName = (mins: number | undefined) => (mins === 300 ? "5h" : mins === 10080 ? "7d" : mins ? (mins % 1440 === 0 ? `${mins / 1440}d` : mins % 60 === 0 ? `${mins / 60}h` : `${mins}m`) : "?");

type CodexWindow = { usedPercent?: number; windowDurationMins?: number | null; resetsAt?: number | null } | null | undefined;
type CodexSnapshot = { limitId?: string | null; limitName?: string | null; primary?: CodexWindow; secondary?: CodexWindow; planType?: string | null };

/** account/rateLimits/read's result → windows. Which window is 5 hours or a week is told by its length, not its slot. */
export function parseCodexRateLimits(r: { rateLimits?: CodexSnapshot; rateLimitsByLimitId?: Record<string, CodexSnapshot | null> | null }): { plan?: string; windows: QuotaWindow[] } {
  const snaps = Object.entries(r.rateLimitsByLimitId ?? {}).filter((e): e is [string, CodexSnapshot] => !!e[1]);
  if (!snaps.length && r.rateLimits) snaps.push([r.rateLimits.limitId ?? "codex", r.rateLimits]);
  const windows: QuotaWindow[] = [];
  let plan: string | undefined;
  for (const [id, s] of snaps) {
    plan ??= s.planType ?? undefined;
    const own = (s.limitId ?? id) !== "codex";
    const label = own ? (s.limitName ?? s.limitId ?? id) : "";
    for (const w of [s.primary, s.secondary]) {
      if (!w || typeof w.usedPercent !== "number") continue;
      const mins = w.windowDurationMins ?? undefined;
      windows.push({
        name: own ? `${windowName(mins)} · ${label}` : windowName(mins),
        usedPercent: w.usedPercent,
        ...(mins ? { windowMinutes: mins } : {}),
        ...(w.resetsAt ? { resetsAt: new Date(w.resetsAt * 1000).toISOString() } : {}),
        ...(own ? { model: label.toLowerCase() } : {}),
      });
    }
  }
  return { plan, windows };
}

/** The `codex` that answers app-server requests: on PATH, else the one the codex-acp package carries. */
export function codexCommand(p: AgentProfile): { command: string; args: string[] } | null {
  if (p.transport === "codex-cli" && resolveCommand(p.command)) return { command: p.command, args: [] };
  if (resolveCommand("codex")) return { command: "codex", args: [] };
  const found = resolveCommand(p.command);
  if (!found) return null;
  try {
    const script = found.prefix.find((a) => /\.(c|m)?js$/i.test(a)) ?? realpathSync(found.file);
    const pkg = createRequire(script).resolve("@openai/codex/package.json");
    const bin = JSON.parse(readFileSync(pkg, "utf8")).bin;
    const rel = typeof bin === "string" ? bin : bin?.codex;
    return rel ? { command: process.execPath, args: [join(dirname(pkg), rel)] } : null;
  } catch {
    return null;
  }
}

async function readCodex(p: AgentProfile, timeoutMs = 20_000): Promise<{ plan?: string; windows: QuotaWindow[] }> {
  const cmd = codexCommand(p);
  if (!cmd) throw new Error("找不到 codex 命令（app-server）");
  const child = launch(cmd.command, [...cmd.args, "app-server"], { cwd: process.cwd(), env: p.env });
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("codex app-server 没有及时回答")), timeoutMs);
      let buf = "";
      const send = (m: unknown) => child.stdin.write(JSON.stringify(m) + "\n");
      child.once("error", (e) => { clearTimeout(timer); reject(e); });
      child.once("close", (code) => { clearTimeout(timer); reject(new Error(`codex app-server 退出（${code}）`)); });
      child.stdout.on("data", (d: Buffer) => {
        buf += d.toString();
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          let m: { id?: number; result?: unknown; error?: { message?: string } };
          try { m = JSON.parse(line); } catch { continue; }
          if (m.id === 1) {
            send({ method: "initialized" });
            send({ id: 2, method: "account/rateLimits/read" });
          } else if (m.id === 2) {
            clearTimeout(timer);
            if (m.error) reject(new Error(m.error.message ?? "account/rateLimits/read 失败"));
            else resolve(parseCodexRateLimits(m.result as never));
          }
        }
      });
      send({ id: 1, method: "initialize", params: { clientInfo: { name: "omem", version: "0" } } });
    });
  } finally {
    stop(child);
  }
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Nov 9, 3:00 PM GMT+8" (no year) → the next such moment. */
export function parseResetText(text: string, now = new Date()): string | undefined {
  const m = /^([A-Z][a-z]{2}) (\d{1,2}), (\d{1,2}):(\d{2})\s*([AP]M)?\s*(?:GMT|UTC)?([+-]\d{1,2}(?::?\d{2})?)?/.exec(text.trim());
  if (!m || !MONTHS.includes(m[1])) return undefined;
  let h = Number(m[3]) % (m[5] ? 12 : 24);
  if (m[5]?.toUpperCase() === "PM") h += 12;
  const tz = m[6] ? /^([+-])(\d{1,2}):?(\d{2})?$/.exec(m[6]) : null;
  const offset = tz ? (tz[1] === "-" ? -1 : 1) * (Number(tz[2]) * 60 + Number(tz[3] ?? 0)) : -now.getTimezoneOffset();
  for (const year of [now.getUTCFullYear(), now.getUTCFullYear() + 1]) {
    const at = Date.UTC(year, MONTHS.indexOf(m[1]), Number(m[2]), h, Number(m[4])) - offset * 60_000;
    if (at > now.getTime() - DAY) return new Date(at).toISOString();
  }
  return undefined;
}

/**
 * The `/usage` answer of claude-agent-acp ("**5-hour limit** — **42%** · Resets Nov 9, 3:00 PM GMT+8",
 * "**Weekly · all models** — …", "**Weekly · Opus** — …") → windows. Claude Code's own text, when
 * the adapter falls back to it, has "Current session" / "Current week (all models)" and "N% used".
 */
export function parseClaudeUsage(text: string, now = new Date()): { plan?: string; windows: QuotaWindow[] } {
  const windows: QuotaWindow[] = [];
  const plan = /Claude (\S+) subscription usage/.exec(text)?.[1];
  const named = (label: string): Pick<QuotaWindow, "name" | "windowMinutes" | "model"> | null => {
    const l = label.toLowerCase();
    if (/5-hour|current session/.test(l)) return { name: "5h", windowMinutes: 300 };
    if (/all models|^weekly$|current week$/.test(l) || /current week \(all models\)/.test(l)) return { name: "7d", windowMinutes: 10080 };
    const fam = /(?:weekly|current week)\s*(?:·|\()\s*([^)]+?)\)?(?: only)?$/i.exec(label)?.[1]?.trim();
    return fam ? { name: `7d · ${fam}`, windowMinutes: 10080, model: fam.toLowerCase() } : null;
  };
  for (const m of text.matchAll(/^\*\*(.+?)\*\* — \*\*(\d+(?:\.\d+)?)%\*\*(?: · Resets (.+))?$/gm)) {
    const w = named(m[1].replace(/\\(.)/g, "$1"));
    if (w) windows.push({ ...w, usedPercent: Number(m[2]), ...(m[3] ? { resetsAt: parseResetText(m[3], now) } : {}) });
  }
  if (!windows.length) {
    const lines = text.split(/\r?\n/).map((l) => l.trim());
    lines.forEach((l, i) => {
      const w = named(l);
      if (!w) return;
      const near = lines.slice(i + 1, i + 4).join(" ");
      const used = /(\d+(?:\.\d+)?)%\s*used/i.exec(near);
      if (used) windows.push({ ...w, usedPercent: Number(used[1]) });
    });
  }
  return { plan, windows };
}

async function readClaude(app: App, p: AgentProfile): Promise<{ plan?: string; windows: QuotaWindow[] }> {
  const { listAgentProfiles } = await import("./runner.ts");
  const acp = p.transport === "acp" ? p : listAgentProfiles(app).find((q) => q.transport === "acp" && q.installed && sourceOf(q) === sourceOf(p) && !q.keyRef);
  if (!acp) throw new Error("读 Claude 额度要装 claude-agent-acp");
  const { runAcp } = await import("./acp.ts");
  const { sessionCleanup } = await import("./session-cleanup.ts");
  const cwd = app.home;
  const cleanup = await sessionCleanup(app, acp, { cwd }, () => {});
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60_000);
  try {
    // /usage is a local command: Claude Code answers it without the model.
    const r = await runAcp({ ...acp, model: undefined, effort: undefined }, { cwd, cleanup, prompt: "/usage", modes: ["read-only"], signal: ctrl.signal }, () => {});
    const parsed = parseClaudeUsage(r.text);
    if (!parsed.windows.length)
      throw new Error(/^## Usage/m.test(r.text) && !/### Limits/.test(r.text) ? "Claude Code 没有报套餐额度（没登录订阅账号，或用的是 API Key）" : `没有从 /usage 的回答里读到额度：${r.text.slice(0, 160)}`);
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

const inflight = new WeakMap<App, Map<string, Promise<QuotaSnapshot | null>>>();
/** A failed read is not retried for a while (a backend that is not logged in is not started every few minutes). */
const RETRY_AFTER_ERROR = 6 * 3_600_000;

/** Read the account's limits again when what is kept is older than `maxAgeMs`. Never throws. */
export async function refreshQuota(app: App, p: AgentProfile, maxAgeMs = 10 * 60_000): Promise<QuotaSnapshot | null> {
  const kind = quotaKind(p);
  if (!kind || p.keyRef) return null;
  const source = sourceOf(p);
  const old = store(app)[source];
  // maxAgeMs 0: the owner asked to read now, failed or not.
  if (old && maxAgeMs > 0 && Date.now() - Date.parse(old.at) < (old.error && old.via !== "event" ? Math.max(maxAgeMs, RETRY_AFTER_ERROR) : maxAgeMs)) return old;
  let map = inflight.get(app);
  if (!map) { map = new Map(); inflight.set(app, map); }
  const running = map.get(source);
  if (running) return running;
  const job = (async () => {
    try {
      const r = kind === "codex-app-server" ? await readCodex(p) : await readClaude(app, p);
      const snap: QuotaSnapshot = { at: new Date().toISOString(), via: kind, ...(r.plan ? { plan: r.plan } : {}), windows: r.windows };
      save(app, source, snap);
      return snap;
    } catch (e) {
      const snap: QuotaSnapshot = { ...(old ?? { windows: [] }), at: new Date().toISOString(), via: kind, error: (e as Error).message.slice(0, 300) };
      save(app, source, snap);
      return snap;
    } finally {
      map!.delete(source);
    }
  })();
  map.set(source, job);
  return job;
}

/** Every account worth reading on this machine (installed, plan-backed), one profile each. */
export async function quotaProfiles(app: App) {
  const { choosableProfiles } = await import("./capacity.ts");
  const seen = new Set<string>();
  return choosableProfiles(app).filter((p) => {
    if (!quotaKind(p) || p.keyRef || seen.has(sourceOf(p))) return false;
    seen.add(sourceOf(p));
    return true;
  });
}

/**
 * Keep the numbers fresh: every few minutes, an account used in the last 6 hours is read when older
 * than 15 minutes, any other when older than 2 hours (Claude's read starts Claude Code briefly).
 */
export function startQuotaWatch(app: App) {
  const tick = async () => {
    const since = new Date(Date.now() - 6 * 3_600_000).toISOString();
    for (const p of await quotaProfiles(app)) {
      const used = one(app.db, "select 1 from runs where json_extract(ai, '$.profile') in (select value from json_each(?)) and coalesce(finished_at, started_at) >= ? limit 1", JSON.stringify(sameSource(app, p)), since);
      await refreshQuota(app, p, used ? 15 * 60_000 : 2 * 3_600_000);
    }
  };
  setTimeout(() => void tick().catch(() => {}), 30_000).unref?.();
  setInterval(() => void tick().catch(() => {}), 5 * 60_000).unref?.();
}
function sameSource(app: App, p: AgentProfile) {
  const src = sourceOf(p);
  return [...new Set([p.id, ...app.config.agents.profiles.filter((q) => sourceOf(q) === src).map((q) => q.id), src, `${src}-cli`])];
}

// ---------------------------------------------------------------- events from turns

const EVENT_WINDOWS: Record<string, Pick<QuotaWindow, "name" | "windowMinutes" | "model">> = {
  five_hour: { name: "5h", windowMinutes: 300 },
  seven_day: { name: "7d", windowMinutes: 10080 },
  seven_day_opus: { name: "7d · Opus", windowMinutes: 10080, model: "opus" },
  seven_day_sonnet: { name: "7d · Sonnet", windowMinutes: 10080, model: "sonnet" },
};

/** Claude's rate_limit_info (utilization is a fraction, resetsAt in seconds) → an event for the host. */
export function claudeRateLimitEvent(info: unknown): Extract<AgentEvent, { type: "rate-limit" }> | null {
  const i = info as { status?: string; rateLimitType?: string; utilization?: number; resetsAt?: number } | null;
  if (!i?.rateLimitType || !EVENT_WINDOWS[i.rateLimitType]) return null;
  const used = typeof i.utilization === "number" ? i.utilization * 100 : i.status === "rejected" ? 100 : undefined;
  return { type: "rate-limit", window: i.rateLimitType, ...(used !== undefined ? { usedPercent: used } : {}), ...(i.resetsAt ? { resetsAt: new Date(i.resetsAt * 1000).toISOString() } : {}) };
}

/** Fold one event into the account's kept numbers (a window whose share is not told only gets its reset time). */
export function noteRateLimit(app: App, p: AgentProfile, e: Extract<AgentEvent, { type: "rate-limit" }>) {
  if (!quotaKind(p) || p.keyRef) return;
  const def = EVENT_WINDOWS[e.window];
  if (!def) return;
  const source = sourceOf(p);
  const snap = store(app)[source] ?? { at: new Date().toISOString(), via: "event" as const, windows: [] };
  const windows = snap.windows.filter((w) => w.name !== def.name);
  const prev = snap.windows.find((w) => w.name === def.name);
  const sameWindow = prev && (!e.resetsAt || prev.resetsAt === e.resetsAt);
  const used = e.usedPercent ?? (sameWindow ? prev.usedPercent : undefined);
  if (used === undefined) return;
  windows.push({ ...def, usedPercent: used, ...(e.resetsAt ?? prev?.resetsAt ? { resetsAt: e.resetsAt ?? prev?.resetsAt } : {}) });
  save(app, source, { ...snap, windows });
}

/** Take rate-limit events out of a turn's stream into the account's numbers; the rest goes on. */
export function quotaEvents(app: App, p: AgentProfile, emit: (e: AgentEvent) => void): (e: AgentEvent) => void {
  return (e) => {
    if (e.type !== "rate-limit") return emit(e);
    try { noteRateLimit(app, p, e); } catch {}
  };
}

/**
 * After a turn: read the account again soon (the turn used some of it). Only where reading is cheap
 * (Codex); Claude's turns report their own events, and its read starts Claude Code.
 */
export function afterTurn(app: App, p: AgentProfile) {
  if (quotaKind(p) !== "codex-app-server" || p.keyRef || !app.db) return;
  void refreshQuota(app, p, 5 * 60_000).catch(() => {});
}
