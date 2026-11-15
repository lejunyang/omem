import type { FlowDefinition } from "./definitions.ts";

function calendar(timezone: string) {
  const format = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short" });
  return (at: Date) => {
    const p = Object.fromEntries(format.formatToParts(at).map((p) => [p.type, p.value]));
    return { date: `${p.year}-${p.month}-${p.day}`, minute: Number(p.hour) * 60 + Number(p.minute), weekday: p.weekday.toLowerCase() };
  };
}
const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
// Scanning real minutes also handles skipped and repeated wall-clock hours at DST boundaries.
function firstMinute(at: Date, matches: (d: Date) => boolean, days: number) {
  for (let t = Math.ceil(at.getTime() / 60000) * 60000, end = t + days * 86400000; t <= end; t += 60000) {
    const d = new Date(t);
    if (matches(d)) return d.toISOString();
  }
  throw new Error("找不到下一个开始时刻");
}

/** `at` belongs to the round's local date; a later day never makes that threshold pending again. */
export function stageTiming(now: Date, timezone: string, stage: { at?: string; window?: string }, roundStartedAt = now): { ready: boolean; nextAt: string | null } {
  if (!stage.at && !stage.window) return { ready: true, nextAt: null };
  const local = calendar(timezone), startDate = local(roundStartedAt).date;
  const range = stage.window?.split("-").map(minutes);
  const matches = (d: Date) => {
    const p = local(d);
    if (stage.at && (p.date < startDate || p.date === startDate && p.minute < minutes(stage.at))) return false;
    if (!range) return true;
    const [a, b] = range;
    return a < b ? p.minute >= a && p.minute < b : p.minute >= a || p.minute < b;
  };
  return matches(now) ? { ready: true, nextAt: null } : { ready: false, nextAt: firstMinute(now, matches, 3) };
}

/** Calendar repeats are scheduled after completion, never catch up missed days in a burst. */
export function nextRoundAt(now: Date, timezone: string, every: NonNullable<FlowDefinition["repeat"]>["every"]) {
  if (every === "manual") return null;
  if (every === "done") return now.toISOString();
  const local = calendar(timezone), today = local(now).date;
  return firstMinute(now, (d) => { const p = local(d); return p.date > today && (every === "day" || every.includes(p.weekday as typeof every[number])); }, 8);
}

export function roundDayMatches(now: Date, timezone: string, every: NonNullable<FlowDefinition["repeat"]>["every"]) {
  return !Array.isArray(every) || every.includes(calendar(timezone)(now).weekday as typeof every[number]);
}

export const timeLabel = (at: string, timezone: string) => new Date(at).toLocaleString("zh-CN", { timeZone: timezone, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
