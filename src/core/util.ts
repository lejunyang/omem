import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const COMMAND_TIMEOUT_SEC = 3600;
export const COMMAND_OUTPUT_LIMIT = 20_000;
export const now = () => new Date().toISOString();

/** Short sortable id: time prefix + randomness. */
export function newId(prefix = ""): string {
  const time = Date.now().toString(36).padStart(9, "0");
  return prefix + time + randomBytes(5).toString("hex");
}

/** Terminal colour and cursor codes (ESC `[32m`): a page shows them as stray “[32m”, and a model reads them as noise. */
export const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");

export const sha256 = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
/** Compare a presented secret with the expected one in constant time (hashed, so lengths match). */
export const sameSecret = (given: string, expected: string) => !!expected && timingSafeEqual(createHash("sha256").update(given).digest(), createHash("sha256").update(expected).digest());

export function slugify(text: string): string {
  const slug = text
    .trim()
    .toLowerCase()
    .replace(/[\s/\\:*?"<>|#%[\]{}]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return slug.slice(0, 80) || "page";
}

export function json<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export function truncate(text: string, max: number) {
  return text.length <= max ? text : text.slice(0, max - 1) + "…";
}

/** Lines are 1-based and inclusive, like editors and citations. */
export function sliceLines(text: string, start: number, end: number) {
  return text
    .split("\n")
    .slice(Math.max(0, start - 1), Math.max(start, end))
    .join("\n");
}

export function lineCount(text: string) {
  if (!text) return 0;
  return text.split("\n").length;
}

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * A link to one of omem's pages (`#/...`): absolute when `webUrl` is configured, so it opens from
 * another device or a Feishu card; otherwise left as it is (opens only inside omem's own pages).
 */
export function webLink(app: { config: { webUrl?: string } }, link: string) {
  const base = app.config.webUrl?.trim().replace(/\/+$/, "");
  if (!base || !link.startsWith("#/")) return link;
  return `${base}/${link}`;
}

/**
 * "YYYY-MM-DD HH:mm" in the given time zone (the owner's `config.timezone`; omitted = this machine's).
 * Stored times are UTC ISO strings; anything shown to the owner or handed to a model to relay goes through this.
 * `short` drops the year.
 */
/** This machine's own time zone (what `config.timezone` starts as). */
export function systemZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** An IANA zone name this runtime knows ("Asia/Shanghai", "UTC"). */
export function validZone(z: unknown): z is string {
  if (typeof z !== "string" || !z.trim()) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: z });
    return true;
  } catch {
    return false;
  }
}

/**
 * The owner's time zone for this process's own local-time calls (`getHours`, `toLocaleString` without
 * a zone) and for the agents and tools it starts: they read TZ. The service and the CLI set it from
 * `config.timezone`, so the machine's own zone is not used anywhere.
 */
export function useProcessZone(z: string) {
  if (validZone(z) && process.env.TZ !== z) process.env.TZ = z;
}

/** Wall-clock parts of an instant in a time zone (month 1–12, weekday 0 = Sunday). */
export function zonedParts(t: string | number | Date, timeZone: string) {
  const d = t instanceof Date ? t : new Date(t);
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", weekday: "short", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" }).formatToParts(d).map((x) => [x.type, x.value]));
  const year = Number(p.year), month = Number(p.month), day = Number(p.day);
  return { year, month, day, hour: Number(p.hour) % 24, minute: Number(p.minute), weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday), date: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}` };
}

/** The instant a day ("YYYY-MM-DD") starts in a time zone. */
export function zoneMidnight(day: string, timeZone: string): Date {
  const target = Date.parse(`${day}T00:00:00Z`);
  let ms = target;
  for (let i = 0; i < 3; i++) {
    const p = zonedParts(ms, timeZone);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    if (asUtc === target) break;
    ms += target - asUtc;
  }
  return new Date(ms);
}

export function localStamp(t: string | number | Date, timeZone?: string, opts: { short?: boolean; seconds?: boolean } = {}): string {
  const d = t instanceof Date ? t : new Date(t);
  if (Number.isNaN(d.getTime())) return String(t);
  const s = d.toLocaleString("sv-SE", { timeZone, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", ...(opts.seconds ? { second: "2-digit" } : {}) });
  return opts.short ? s.slice(5) : s;
}

export async function untilAbort<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let abort!: () => void;
  const expired = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([work(), expired]); }
  finally { signal.removeEventListener("abort", abort); }
}
