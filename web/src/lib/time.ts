import { ref } from "vue";

/**
 * The time zone the page shows times in: the service's `config.timezone` (设置 → 通用), not the
 * browser's. Set once `/api/me` (or a share link) answers; until then, and for a zone the browser
 * does not know, the browser's own zone. A ref, so what renders before it is set renders again.
 */
const zone = ref<string | undefined>(undefined);

export function validZone(z: string | undefined | null): z is string {
  if (!z) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: z });
    return true;
  } catch {
    return false;
  }
}

export function setTimeZone(z: string | undefined | null) {
  zone.value = validZone(z) ? z : undefined;
}

/** The zone in use (undefined = the browser's). */
export function timeZone(): string | undefined {
  return zone.value;
}

/** toLocaleString in the set zone. */
export function fmt(t: string | number | Date, opts: Intl.DateTimeFormatOptions = {}, locale = "zh-CN"): string {
  const d = t instanceof Date ? t : new Date(t);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(locale, { timeZone: zone.value, ...opts });
}

const partsFmt = new Map<string, Intl.DateTimeFormat>();
function wall(d: Date) {
  const key = zone.value ?? "";
  let f = partsFmt.get(key);
  if (!f) partsFmt.set(key, (f = new Intl.DateTimeFormat("en-US", { timeZone: zone.value, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" })));
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, Number(x.value)]));
  return { y: p.year, mo: p.month, d: p.day, h: p.hour % 24, mi: p.minute, s: p.second };
}

/**
 * The instant as a browser-local Date that reads the set zone's wall clock: its getFullYear,
 * getMonth, getDate, getDay, getHours… are the zone's. For calendar arithmetic and labels;
 * turn the result back into a real instant with fromWallDate.
 */
export function toWallDate(t: string | number | Date): Date {
  const d = t instanceof Date ? t : new Date(t);
  if (Number.isNaN(d.getTime()) || !zone.value) return new Date(d);
  const w = wall(d);
  return new Date(w.y, w.mo - 1, w.d, w.h, w.mi, w.s, d.getMilliseconds());
}

/** The real instant of a wall-clock Date made with toWallDate (or new Date(y, m, d, h, mi)). */
export function fromWallDate(local: Date): Date {
  if (!zone.value || Number.isNaN(local.getTime())) return new Date(local);
  const target = Date.UTC(local.getFullYear(), local.getMonth(), local.getDate(), local.getHours(), local.getMinutes(), local.getSeconds(), local.getMilliseconds());
  // The zone's offset at a guess, then once more at the result (it differs across a DST change).
  let t = target;
  for (let i = 0; i < 2; i++) {
    const w = wall(new Date(t));
    const asUtc = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s, local.getMilliseconds());
    t += target - asUtc;
  }
  return new Date(t);
}

/** "YYYY-MM-DD" of the instant in the set zone. */
export function dayKey(t: string | number | Date): string {
  const d = toWallDate(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
