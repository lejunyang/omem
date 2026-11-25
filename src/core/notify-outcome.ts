import type { App } from "./app.ts";
import { all, one, run, tx } from "./db.ts";
import { json, now } from "./util.ts";
import { resolveIdentity } from "./users.ts";
import { QUIET_HANDLED } from "./notify.ts";
import { queueNegativeNotification } from "./notify-reactions.ts";

export type Outcome = "negative" | "acted" | "known" | "read" | "unread" | "bundled";
export type OutcomeStats = { sent: number; acted: number; known: number; read: number; unread: number; negative: number };
type Context = { urgency?: string; replacedBy?: string; bundle?: string[]; pushed?: { channel?: string; messageId?: string }; larkMessageId?: string; entityId?: string; sourceRefs?: string[]; quiet?: string; runId?: string };
type Row = { id: string; at: string; read_at: string | null; context: string | null; outcome: Outcome };
const empty = (): OutcomeStats => ({ sent: 0, acted: 0, known: 0, read: 0, unread: 0, negative: 0 });

/** Resolve only cited source IDs: primary-key lookups, never a scan of the source library. */
function chats(app: App, refs: string[] = []) {
  const ids = [...new Set(refs.flatMap((ref) => /^src:([\w-]+)(?:#|$)/.exec(ref)?.[1] ?? []))];
  return ids.flatMap((id) => {
    const s = one<{ id: string; title: string; uri: string; meta: string }>(app.db, "select id, title, uri, meta from sources where id = ? and kind = 'chat'", id);
    if (!s) return [];
    const chatId = json<{ chatId?: string }>(s.meta, {}).chatId ?? /^lark:(oc_[^/#]+)/.exec(s.uri)?.[1];
    return [{ id: s.id, title: s.title, chatId }];
  });
}

/** One bounded pass after the owner has had two days to react. First matching rule wins. */
export function labelOutcomes(app: App, { limit = 300 } = {}) {
  const at = now();
  const negative: string[] = [];
  const rows = all<Row>(app.db, `select id, at, read_at, context from notifications indexed by notifications_outcome_pending
    where outcome is null and at < ? and user_id = 'owner'
      and coalesce(json_extract(context, '$.urgency'), '') != 'silent'
      and json_extract(context, '$.replacedBy') is null and json_extract(context, '$.bundle') is null
    order by at limit ?`, new Date(Date.now() - 48 * 3600_000).toISOString(), Math.max(0, Math.min(300, Math.floor(limit))));
  tx(app.db, () => { for (const n of rows) {
    const c = json<Context>(n.context, {});
    const message = c.larkMessageId ?? c.pushed?.messageId;
    const until = new Date(Date.parse(n.at) + 24 * 3600_000).toISOString();
    const signature = app.config.lark.commands.signature.trim();
    let outcome: Outcome;
    if (c.pushed?.channel === "bundle" && c.quiet !== QUIET_HANDLED) outcome = "bundled";
    else if (message && one(app.db, "select 1 from feedback where message_id = ? and actor_kind = 'owner' and polarity = 'negative' and removed_at is null limit 1", message)) outcome = "negative";
    else {
      const acted = (message && (
        all<{ handled_at: string; handled_by: string | null }>(app.db, "select handled_at, handled_by from card_interactions where message_id = ? and handled_at is not null", message).some((r) => {
          const time = Date.parse(r.handled_at.includes("T") ? r.handled_at : `${r.handled_at.replace(" ", "T")}Z`);
          return time >= Date.parse(n.at) && time <= Date.parse(until) && (r.handled_by === "owner" || resolveIdentity(app, "lark", r.handled_by) === "owner");
        }) ||
        one(app.db, "select 1 from feedback where message_id = ? and actor_kind = 'owner' and polarity in ('positive','ack') and removed_at is null and at >= ? and at <= ? limit 1", message, n.at, until)
      )) || (c.entityId && one(app.db, "select 1 from item_events where item_id = ? and actor = 'user' and at >= ? and at <= ? limit 1", c.entityId, n.at, until)) ||
        chats(app, c.sourceRefs).some((s) => s.chatId && one(app.db, "select 1 from lark_messages where chat_id = ? and create_ms >= ? and create_ms <= ? and sender_kind = 'owner' and msg_type in ('text','post') and trim(content) != '' and (? = '' or instr(content, ?) = 0) limit 1", s.chatId, Date.parse(n.at), Date.parse(until), signature, signature));
      outcome = acted ? "acted" : c.quiet === QUIET_HANDLED ? "known" : n.read_at ? "read" : "unread";
    }
    run(app.db, "update notifications set outcome = ?, outcome_at = ? where id = ? and outcome is null", outcome, at, n.id);
    // Catching up a reaction the event handler missed, not replaying old history: a dislike from long
    // ago (everything unlabelled is labelled on the first run) does not turn into a rule today.
    if (outcome === "negative" && Date.parse(n.at) > Date.now() - 7 * 86400_000) negative.push(n.id);
  } });
  for (const id of negative) queueNegativeNotification(app, id);
  return rows.length;
}

function labelled(app: App, days: number) {
  return all<Row>(app.db, "select id, at, context, outcome from notifications where user_id = 'owner' and outcome is not null and at >= ?", new Date(Date.now() - days * 86400_000).toISOString());
}
/** One sent as part of a list tells nothing about itself: it counts neither as sent nor as any reaction. */
function count(s: OutcomeStats, outcome: Outcome) {
  if (outcome === "bundled") return;
  s.sent++;
  s[outcome]++;
}
function senderOf(app: App, c: Context) {
  return c.runId ? one<{ kind: string }>(app.db, "select kind from runs where id = ?", c.runId)?.kind ?? "host" : "host";
}
export function outcomeStats(app: App, { days = 30, sender, sourceId }: { days?: number; sender?: string; sourceId?: string } = {}): OutcomeStats {
  const stats = empty();
  for (const n of labelled(app, days)) {
    const c = json<Context>(n.context, {});
    if (sender && senderOf(app, c) !== sender) continue;
    if (sourceId && !chats(app, c.sourceRefs).some((s) => s.id === sourceId)) continue;
    count(stats, n.outcome);
  }
  return stats;
}
export function outcomeBreakdown(app: App, days = 30) {
  const senders = new Map<string, OutcomeStats>();
  const sources = new Map<string, OutcomeStats & { sourceId: string; title: string }>();
  for (const n of labelled(app, days)) {
    const c = json<Context>(n.context, {});
    const sender = senderOf(app, c);
    if (!senders.has(sender)) senders.set(sender, empty());
    count(senders.get(sender)!, n.outcome);
    for (const s of chats(app, c.sourceRefs)) {
      if (!sources.has(s.id)) sources.set(s.id, { sourceId: s.id, title: s.title, ...empty() });
      count(sources.get(s.id)!, n.outcome);
    }
  }
  return { days, senders: [...senders].map(([sender, stats]) => ({ sender, ...stats })).sort((a, b) => b.sent - a.sent), sources: [...sources.values()].sort((a, b) => b.sent - a.sent).slice(0, 20) };
}
export function outcomeLine(stats: OutcomeStats) {
  return stats.sent < 5 ? "" : `近 30 天发了 ${stats.sent} 条：本人处理了 ${stats.acted} 条，本人先一步已经知道 ${stats.known} 条，只看了 ${stats.read} 条，没看 ${stats.unread} 条，表示过反感 ${stats.negative} 条`;
}
