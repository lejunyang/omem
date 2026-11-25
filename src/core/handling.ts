import type { App } from "./app.ts";
import { all, one, run } from "./db.ts";
import { now, truncate } from "./util.ts";

/**
 * Who handled an event and who stepped aside for it (docs/v2/architecture.md “变化台账”). An event is a
 * Feishu message (its message id), or one the host names itself (`meeting:<id>`, `metric:<id>@<at>`…).
 *
 * The record is the table the message side already kept, `handled_messages` (channel, message id), with
 * what each path decided added to its rows (`actor`, `decision`, `change_id`, `reason`):
 *
 * - `lark` — the 关注 that took the message from capture or the bot (`rule`: its id, `read:<id>` when
 *   only reading ones took it), or `direct` when someone @-ed the bot and it answered there;
 * - `listen:<关注 id>` — a rule handed the message to that 关注 (`rule`: the rule id);
 * - `<channel>-mention` — 有人找你 picked it up; `listen-reply` — the 关注 that holds the reply to it;
 * - `handled:<actor>` — a path that noted something from it (a change, item-follow's batch, a meeting's summary);
 * - `yield:<actor>` — that path stepped aside (`rule`: for whom, `reason`: why).
 *
 * Rules keep their own claims (`rule_handled`, `rule_firings`): read here too, not copied.
 *
 * Only one path answers a message. Which one is REPLY_ORDER: the first that took it replies, the later
 * ones step aside and say so (yieldTo, noteYield). Noting what a message changed is not answering it:
 * any path may add to a change (items/changes.ts recordChange).
 */
export const HANDLERS = {
  direct: "当场回答（有人 @ 了机器人）",
  rule: "规则",
  watch: "关注",
  mention: "有人找你",
  follow: "跟进（item-follow）",
  assistant: "助手",
  patrol: "巡检",
  ingest: "采集整理",
  meeting: "会后整理",
} as const;
export type Handler = keyof typeof HANDLERS;
/**
 * Who answers a message, first to last. Someone @-ing the bot is answered where they asked (rules and
 * 关注 step aside, lark-bot.ts markAddressed / answeredDirectly); a rule that took the message comes before
 * the 关注 reading the group (its batch only notes it); 有人找你 is for what nobody else took.
 */
export const REPLY_ORDER: readonly Handler[] = ["direct", "rule", "watch", "mention"];
export type HandlingDecision = "replied" | "drafted" | "noted" | "ignored" | "handed" | "acted" | "taken" | "read" | "yielded";
export type Handling = { actor: Handler; label: string; decision: HandlingDecision; by: string | null; runId: string | null; changeId: string | null; reason: string | null; at: string };

const actorOf = (origin: string): Handler | null =>
  origin === "follow" ? "follow" : origin === "owner" ? "assistant" : origin === "problem" ? "watch" : origin === "meeting" ? "meeting" : null;
export { actorOf as handlerOfOrigin };

/** A path noted something from an event: what it decided, and the change or run it became. */
export function noteHandling(app: App, h: { event: string; actor: Handler; decision: HandlingDecision; by?: string | null; runId?: string | null; changeId?: string | null; reason?: string | null; stage?: "deep" }) {
  if (!h.event) return;
  run(app.db, `insert into handled_messages(channel,message_id,rule,run_id,at,actor,decision,change_id,reason) values(?,?,?,?,?,?,?,?,?)
    on conflict(channel,message_id) do update set decision = excluded.decision, change_id = coalesce(excluded.change_id, change_id),
      run_id = coalesce(excluded.run_id, run_id), reason = coalesce(excluded.reason, reason), at = excluded.at`,
    `handled:${h.actor}${h.stage ? `:${h.stage}` : ""}`, h.event, h.by ?? "", h.runId ?? null, now(), h.actor, h.decision, h.changeId ?? null, h.reason ? truncate(h.reason, 300) : null);
}

/** A path stepped aside for an event: for whom, why. Once per path and event (the first reason stays). */
export function noteYield(app: App, y: { event: string; actor: Handler; to: string; reason: string; runId?: string | null }) {
  if (!y.event) return;
  run(app.db, "insert or ignore into handled_messages(channel,message_id,rule,run_id,at,actor,decision,reason) values(?,?,?,?,?,?,'yielded',?)",
    `yield:${y.actor}`, y.event, truncate(y.to, 120), y.runId ?? null, now(), y.actor, truncate(y.reason, 300));
}

type Row = { channel: string; message_id: string; rule: string; run_id: string | null; at: string; actor: string | null; decision: string | null; change_id: string | null; reason: string | null };
const contextName = (app: App, id: string) => one<{ name: string }>(app.db, "select name from listen_contexts where id = ?", id)?.name ?? id;
const ruleName = (app: App, id: string) => one<{ name: string }>(app.db, "select name from rules where id = ?", id)?.name ?? id;

function fromRow(app: App, r: Row): Handling | null {
  const base = { runId: r.run_id, changeId: r.change_id, reason: r.reason, at: r.at };
  if (r.channel.startsWith("yield:")) {
    const actor = r.channel.slice(6) as Handler;
    return { ...base, actor, label: HANDLERS[actor] ?? actor, decision: "yielded", by: r.rule || null };
  }
  if (r.channel.startsWith("handled:")) {
    const actor = r.channel.slice(8).split(":", 1)[0] as Handler;
    return { ...base, actor, label: HANDLERS[actor] ?? actor, decision: (r.decision as HandlingDecision) ?? "noted", by: r.rule || null };
  }
  if (r.channel === "lark") {
    if (r.rule === "direct") return { ...base, actor: "direct", label: HANDLERS.direct, decision: (r.decision as HandlingDecision) ?? "taken", by: null };
    const reading = r.rule.startsWith("read:");
    const id = reading ? r.rule.slice(5) : r.rule;
    return { ...base, actor: "watch", label: `关注「${contextName(app, id)}」`, decision: (r.decision as HandlingDecision) ?? (reading ? "read" : "taken"), by: id };
  }
  if (r.channel.startsWith("listen:")) return { ...base, actor: "rule", label: `规则「${ruleName(app, r.rule)}」交给关注「${contextName(app, r.channel.slice(7))}」`, decision: "handed", by: r.rule };
  if (r.channel === "listen-reply") return { ...base, actor: "watch", label: `关注「${contextName(app, r.rule)}」`, decision: (r.decision as HandlingDecision) ?? "drafted", by: r.rule };
  if (r.channel.endsWith("-mention")) return { ...base, actor: "mention", label: HANDLERS.mention, decision: (r.decision as HandlingDecision) ?? "taken", by: null };
  // Delivery bookkeeping (a bot's first delivery of an event), not a handling.
  return null;
}

/**
 * Everything recorded about one event, oldest first: who took it, what it became, who stepped aside.
 * Indexed lookups (handled_messages by message id, rule claims by key); a handful of rows.
 */
export function handlingOf(app: App, event: string): Handling[] {
  const id = event.replace(/^lark:/, "");
  const out = all<Row>(app.db, "select * from handled_messages where message_id = ? order by at limit 40", id).map((r) => fromRow(app, r)).filter((h): h is Handling => !!h);
  for (const r of all<{ rule_id: string; at: string }>(app.db, "select rule_id, at from rule_handled where key in (?, ?) limit 20", `lark:${id}`, `follow:lark:${id}`)) {
    if (r.rule_id === "@bot") { if (!out.some((h) => h.actor === "direct")) out.push({ actor: "direct", label: HANDLERS.direct, decision: "taken", by: null, runId: null, changeId: null, reason: null, at: r.at }); continue; }
    const fired = one<{ reason: string; results: string }>(app.db, "select reason, results from rule_firings where rule_id = ? and event_key in (?, ?) order by id desc limit 1", r.rule_id, `lark:${id}`, `follow:lark:${id}`);
    const skipped = fired && /"action":"skip"/.test(fired.results);
    out.push({ actor: "rule", label: `规则「${ruleName(app, r.rule_id)}」`, decision: !fired ? "taken" : skipped ? "ignored" : handsOnReply(fired.results) ? "handed" : "acted", by: r.rule_id, runId: null, changeId: null, reason: fired?.reason ? truncate(fired.reason, 200) : null, at: r.at });
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

/**
 * The rule actions that put a message in the hands of something that answers it: an agent, a 关注, a
 * woken conversation. A rule that only forwarded it, told the owner, pulled the bot in or kept it did
 * something else with it and holds no reply.
 */
const REPLY_ACTIONS = new Set(["agent", "watch", "context", "wake"]);
function handsOnReply(results: string) {
  try {
    return (JSON.parse(results) as { action?: string; ok?: boolean }[]).some((r) => r.ok !== false && REPLY_ACTIONS.has(r.action ?? ""));
  } catch {
    return false;
  }
}

/** The one answering this message, by REPLY_ORDER: the earliest path that took it (not only read it, noted it or did something else with it). */
export function replyHolder(app: App, event: string): Handling | null {
  const taken = handlingOf(app, event).filter((h) => h.decision !== "yielded" && h.decision !== "read" && h.decision !== "noted" && h.decision !== "ignored" && h.decision !== "acted" && REPLY_ORDER.includes(h.actor));
  return taken.sort((a, b) => REPLY_ORDER.indexOf(a.actor) - REPLY_ORDER.indexOf(b.actor))[0] ?? null;
}

/**
 * Whom `actor` steps aside for on this message: a path before it in REPLY_ORDER that took it. Null: it is
 * this one's. A rule that claimed the message and has not decided yet (`taken`) makes nobody step aside:
 * it may still decline, and the message would be left unanswered (有人找你 waits for it on its own,
 * mentions.ts).
 */
export function yieldTo(app: App, actor: Handler, event: string): Handling | null {
  const mine = REPLY_ORDER.indexOf(actor);
  if (mine < 0) return null;
  const h = replyHolder(app, event);
  if (!h || REPLY_ORDER.indexOf(h.actor) >= mine) return null;
  return h.actor === "rule" && h.decision !== "handed" ? null : h;
}

const DECISION: Record<HandlingDecision, string> = { replied: "回复了", drafted: "起草了回复", noted: "记成了变化", ignored: "判断不用管", handed: "交给了别处", acted: "做了别的动作（转发、通知这类），没有接手回复", taken: "接手了", read: "只读了", yielded: "让开了" };
/** A few short lines for a person or an agent: “关注「项目 A」接手了；跟进记成了变化 ic…；有人找你让开了（因为…）”. */
export function handlingText(app: App, event: string, limit = 6, except: Handler[] = []): string {
  const list = handlingOf(app, event).filter((h) => !except.includes(h.actor)).slice(-limit);
  return list.map((h) => `${h.label}${DECISION[h.decision] ?? h.decision}${h.changeId ? `（变化 ${h.changeId}）` : ""}${h.decision === "yielded" && h.by ? `，因为${h.by}已经在处理` : ""}${h.reason ? `：${h.reason}` : ""}`).join("；");
}

/**
 * For read_source on a chat: the lines between `from` and `to` whose message someone handled, each with
 * what became of it (“L12 关注「项目 A」接手了；跟进记成了变化 ic…”). At most `limit` lines; "" when none.
 */
export function handlingOfLines(app: App, sourceId: string, from: number, to: number, limit = 8): string {
  const lines = all<{ line: number; message_id: string }>(app.db, `select line, message_id from lark_message_lines where source_id = ? and line between ? and ?
    union select line, message_id from lark_messages where source_id = ? and line between ? and ? order by line limit 400`, sourceId, from, to, sourceId, from, to);
  if (!lines.length) return "";
  const ids = [...new Set(lines.map((l) => l.message_id))];
  const marks = ids.map(() => "?").join(",");
  const had = new Set([
    ...all<{ message_id: string }>(app.db, `select distinct message_id from handled_messages where message_id in (${marks}) and channel not like 'lark-bot%'`, ...ids).map((r) => r.message_id),
    ...all<{ key: string }>(app.db, `select distinct key from rule_handled where key in (${marks})`, ...ids.map((id) => `lark:${id}`)).map((r) => r.key.slice(5)),
  ]);
  const out: string[] = [];
  for (const l of lines) {
    if (out.length >= limit) break;
    if (!had.has(l.message_id)) continue;
    const text = handlingText(app, l.message_id, 4);
    if (text) out.push(`L${l.line} ${text}`);
    had.delete(l.message_id);
  }
  return out.join("\n");
}

/** How many times paths stepped aside on the events behind these changes, with who and why (the timeline's 让开). */
export function yieldsOf(app: App, events: string[], limit = 20): { event: string; actor: Handler; label: string; to: string; reason: string; at: string }[] {
  const ids = [...new Set(events.map((e) => e.replace(/^lark:/, "")))].slice(0, 100);
  if (!ids.length) return [];
  return all<Row>(app.db, `select * from handled_messages where message_id in (${ids.map(() => "?").join(",")}) and channel like 'yield:%' order by at desc limit ?`, ...ids, limit)
    .map((r) => ({ event: r.message_id, actor: r.channel.slice(6) as Handler, label: HANDLERS[r.channel.slice(6) as Handler] ?? r.channel.slice(6), to: r.rule, reason: r.reason ?? "", at: r.at }));
}
