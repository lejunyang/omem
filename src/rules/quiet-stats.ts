import type { App } from "../core/app.ts";
import { all, one } from "../core/db.ts";
import { json, truncate } from "../core/util.ts";
import { listRules } from "./store.ts";
import type { ActionResult } from "./actions.ts";

export type QuietWindow = { fired: number; quiet: number };
export type QuietStats = { days7: QuietWindow; days30: QuietWindow };
const DAY = 86400_000;
export const emptyQuietStats = (): QuietStats => ({ days7: { fired: 0, quiet: 0 }, days30: { fired: 0, quiet: 0 } });
const direct = new Set(["notify", "forward", "meeting-bot"]);

/** Per firing, not per Agent: merged runs can account for several triggers; delays are not new triggers. */
export function ruleQuietStats(app: App, ids: string[], until = new Date()) {
  const out = new Map(ids.map((id) => [id, { ...emptyQuietStats(), reasons: [] as string[] }]));
  if (!out.size) return out;
  const since7 = new Date(until.getTime() - 7 * DAY).toISOString();
  const since30 = new Date(until.getTime() - 30 * DAY).toISOString();
  type Firing = { rule_id: string; event_key: string; at: string; results: string };
  // Notifications from newer runs carry runId; older default rule replies linked to their run.
  const ownerNotices = new Set(all<{ id: string | null; link: string | null }>(app.db,
    "select json_extract(context, '$.runId') id, link from notifications where user_id = 'owner' and at >= ?", since30)
    .map((n) => n.id ?? (n.link?.startsWith("#/runs/") ? n.link.slice(7) : null)));
  const classify = new Map<string, { done: boolean; told: boolean; reason: string }>();
  const get = (id: string) => {
    const seen = classify.get(id);
    if (seen) return seen;
    const r = one<{ status: string; output: string; sent: number; asked: number; delivered: number }>(app.db, `select status, output,
      exists(select 1 from lark_sent where run_id = runs.id and purpose != 'progress') sent,
      exists(select 1 from asks where run_id = runs.id and user_id = 'owner' and shown_at is not null) asked,
      exists(select 1 from messages where run_id = runs.id and role = 'assistant' and json_extract(meta, '$.larkMessageId') is not null) delivered
      from runs where id = ?`, id);
    const output = json<{ stayQuiet?: string; channelDelivered?: boolean }>(r?.output ?? "{}", {});
    const outcome = { done: r?.status === "done", told: !!(r?.sent || r?.asked || r?.delivered || output.channelDelivered || ownerNotices.has(id)), reason: output.stayQuiet?.trim() || "没有对外发消息，也没有通知本人" };
    classify.set(id, outcome);
    return outcome;
  };
  for (const [id, stats] of out) {
    const rows = all<Firing>(app.db, "select event_key, at, results from rule_firings where rule_id = ? and at >= ? and at <= ? order by at desc, id desc", id, since30, until.toISOString());
    const later = new Map<string, ActionResult[]>();
    for (const r of rows) if (r.event_key.endsWith("#later")) {
      const key = r.event_key.slice(0, -6);
      later.set(key, [...(later.get(key) ?? []), ...json<ActionResult[]>(r.results, [])]);
    }
    for (const r of rows) {
      const results = json<ActionResult[]>(r.results, []);
      if (r.event_key.endsWith("#later") || results.some((a) => a.action === "skip")) continue;
      const actions = [...results, ...(later.get(r.event_key) ?? [])];
      const outcomes = actions.flatMap((a) => a.runId ? [get(a.runId)] : []);
      const quiet = outcomes.length > 0 && outcomes.every((o) => o.done && !o.told) && !actions.some((a) => !a.ok || direct.has(a.action));
      stats.days30.fired++;
      if (quiet) stats.days30.quiet++;
      if (r.at >= since7) {
        stats.days7.fired++;
        if (quiet) {
          stats.days7.quiet++;
          if (stats.reasons.length < 2) stats.reasons.push(truncate(outcomes.at(-1)!.reason.replace(/\s+/g, " "), 160));
        }
      }
    }
  }
  return out;
}

export function highQuietRules(app: App, until: Date) {
  const rules = listRules(app).filter((r) => !r.temporary);
  const stats = ruleQuietStats(app, rules.map((r) => r.id), until);
  return rules.flatMap((r) => {
    const { days7, reasons } = stats.get(r.id)!;
    return days7.fired >= 5 && days7.quiet * 10 >= days7.fired * 9
      ? [`- 「${truncate(r.name, 60)}」：${days7.fired} 次触发，${days7.quiet} 次安静结束；最近两次：${reasons.join("；")}`]
      : [];
  });
}
