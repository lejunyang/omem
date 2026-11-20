/**
 * A cron line in a few words ("每天 02:50", "每 15 分钟", "工作日 08:45"), for lists. The forms are the
 * ones components/CronEditor writes; anything else is shown as the expression itself.
 */
const WEEK = ["日", "一", "二", "三", "四", "五", "六"];
const pad = (n: number) => String(n).padStart(2, "0");

export function cronText(cron: string): string {
  const f = cron.trim().split(/\s+/);
  if (f.length !== 5) return cron;
  const [mi, h, dom, mon, dow] = f;
  if (dom !== "*" || mon !== "*") return cron;
  const num = (s: string) => (/^\d+$/.test(s) ? Number(s) : NaN);
  let m: RegExpExecArray | null;
  if ((m = /^\*\/(\d+)$/.exec(mi)) && h === "*" && dow === "*") return `每 ${m[1]} 分钟`;
  if (mi === "*" && h === "*" && dow === "*") return "每分钟";
  if (!Number.isNaN(num(mi)) && dow === "*") {
    if (h === "*") return `每小时第 ${num(mi)} 分`;
    if ((m = /^\*\/(\d+)$/.exec(h))) return `每 ${m[1]} 小时`;
  }
  if (Number.isNaN(num(mi)) || Number.isNaN(num(h))) return cron;
  const at = `${pad(num(h))}:${pad(num(mi))}`;
  if (dow === "*") return `每天 ${at}`;
  if (dow === "1-5") return `工作日 ${at}`;
  if (/^[0-7](,[0-7])*$/.test(dow)) return `每周${[...new Set(dow.split(",").map((d) => Number(d) % 7))].sort().map((d) => WEEK[d]).join("、")} ${at}`;
  return cron;
}
