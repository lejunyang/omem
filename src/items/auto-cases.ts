import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { json, newId, now, truncate } from "../core/util.ts";

/**
 * Items the assistant made on its own — a background run (整理、巡检、简报、有人找你、规则、唤醒),
 * not the owner's own turn — carry an `auto` event saying why the owner would want them
 * (agents/tools.ts upsert_item, items/auto.ts). What the owner then did with one is a case
 * (reply_samples, source `item`, chat_kind `item`): kept or dropped, and how. The creating roles
 * read the latest ones before they create more (items/auto.ts itemLessons).
 *
 * Only database work here: items/store.ts calls noteAutoOutcome on every status change.
 */

export const AUTO_EVENT = "auto";
export const WHY_PREFIX = "为什么建：";

/** Who made an auto item: the run kind, `mention` for 有人找你, `rule` for a rule's agent. */
export function creatorOf(app: App, runId: string | null): string {
  if (!runId) return "assistant";
  const r = one<{ kind: string; input: string }>(app.db, "select kind, input from runs where id = ?", runId);
  if (!r) return "unknown";
  const input = json<{ mention?: unknown; spec?: string; ruleId?: string }>(r.input, {});
  if (input.mention) return "mention";
  if (input.ruleId) return "rule";
  if (r.kind === "ask") return "assistant";
  if (r.kind === "agent") return input.spec && input.spec !== "assistant" ? `agent:${input.spec}` : "agent";
  return r.kind;
}

const CREATORS: Record<string, string> = { ingest: "整理新材料", heartbeat: "巡检", dream: "夜间整理", brief: "简报", mention: "有人找你", rule: "规则", assistant: "主助手的后续轮次", agent: "后台 Agent" };
export const creatorLabel = (c: string) => CREATORS[c] ?? (c.startsWith("agent:") ? `Agent ${c.slice(6)}` : c);

export type AutoInfo = { why: string; runId: string | null; creator: string; at: string };

/** Why an auto item was made and by whom; null for items the owner asked for (or made before this existed). */
export function autoInfo(app: App, itemId: string): AutoInfo | null {
  const e = one<{ text: string; run_id: string | null; at: string }>(app.db, "select text, run_id, at from item_events where item_id = ? and kind = ? order by id limit 1", itemId, AUTO_EVENT);
  if (!e) return null;
  const why = (e.text.startsWith(WHY_PREFIX) ? e.text.slice(WHY_PREFIX.length) : e.text).split("\n")[0].trim();
  return { why, runId: e.run_id, creator: creatorOf(app, e.run_id), at: e.at };
}

/** How the owner kept or dropped an auto item. */
export const CASE_REASONS = {
  "candidate-kept": "从候选里留下",
  done: "本人标了完成",
  "candidate-dropped": "候选里本人点了不要",
  "candidate-expired": "候选三天没人要，自动放下",
  ignored: "本人忽略或取消了",
  expired: "本人一直没动，自动过期",
} as const;
export type CaseReason = keyof typeof CASE_REASONS;

/** One case per item and reason: the same thing happening twice to an item teaches nothing new. */
export function noteItemCase(app: App, item: { id: string; title: string; spaceId: string }, info: AutoInfo, decision: "sent" | "dropped", reason: CaseReason) {
  if (one(app.db, "select 1 from reply_samples where source = 'item' and final = ? and reason = ?", item.id, reason)) return;
  const at = now();
  run(
    app.db,
    `insert into reply_samples(id, handle_run, channel, chat_id, chat_kind, chat_name, asker_name, ask, last_ms, decision, final, reason, decided_at, settled_at, created_at, source)
     values(?,?,'omem',?,'item','',?,?,?,?,?,?,?,?,?,'item')`,
    newId("rs"), info.runId, item.spaceId, info.creator, truncate(`${item.title}\n${info.why}`, 800), Date.now(), decision, item.id, reason, at, at, at,
  );
}

/**
 * Called by upsertItem when an item's status changed. Auto items only: the owner keeping or dropping
 * a candidate, cancelling (忽略) or finishing one, the sweep putting down an unanswered candidate,
 * or one expiring that the owner never touched.
 */
export function noteAutoOutcome(app: App, old: { id: string; title: string; spaceId: string; status: string }, status: string, actor: "agent" | "user") {
  if (old.status === status) return;
  const info = autoInfo(app, old.id);
  if (!info) return;
  const drop = status === "cancelled" || status === "expired";
  let c: ["sent" | "dropped", CaseReason] | null = null;
  if (old.status === "candidate") {
    if (actor === "user") c = drop ? ["dropped", "candidate-dropped"] : ["sent", "candidate-kept"];
    else if (drop) c = ["dropped", "candidate-expired"];
  } else if (actor === "user") {
    if (drop) c = ["dropped", "ignored"];
    else if (status === "done") c = ["sent", "done"];
  } else if (status === "expired" && !one(app.db, "select 1 from item_events where item_id = ? and actor = 'user' limit 1", old.id)) c = ["dropped", "expired"];
  if (c) noteItemCase(app, old, info, c[0], c[1]);
}

export type ItemCase = { id: string; ask: string; decision: string; reason: CaseReason | null; creator: string; at: string; itemId: string };

/** The latest cases, newest first; `creator` puts that creator's own first. */
export function itemCases(app: App, opts: { creator?: string; limit?: number; days?: number } = {}): ItemCase[] {
  const since = new Date(Date.now() - (opts.days ?? 60) * 86400_000).toISOString();
  const rows = all<{ id: string; ask: string; decision: string; reason: string | null; asker_name: string; decided_at: string; final: string }>(
    app.db,
    "select id, ask, decision, reason, asker_name, decided_at, final from reply_samples where source = 'item' and decided_at > ? order by decided_at desc limit 200",
    since,
  );
  const cases = rows.map((r) => ({ id: r.id, ask: r.ask, decision: r.decision, reason: (r.reason as CaseReason) ?? null, creator: r.asker_name, at: r.decided_at, itemId: r.final }));
  const limit = opts.limit ?? 8;
  if (!opts.creator) return cases.slice(0, limit);
  const own = cases.filter((c) => c.creator === opts.creator);
  return [...own, ...cases.filter((c) => c.creator !== opts.creator)].slice(0, limit);
}
