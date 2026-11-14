import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { now, truncate } from "../core/util.ts";
import { mentionChannel, type MentionChannel, type MentionMessage } from "./channel.ts";

/**
 * What the owner does when someone looks for them (docs/v2/mentions.md “学本人怎么回”). Each message
 * that reached this flow is one sample (`reply_samples`): what was asked, what the handler drafted,
 * what the owner did with the draft (sent, changed, not sent and why), and what the owner wrote there
 * themselves afterwards — or that they wrote nothing. The host only keeps these facts and shows the
 * nearest ones to the triage and the handler; how to answer stays the model's call.
 */

/** Why the owner did not send a draft (the buttons on the draft card). */
export const DROP_REASONS = { "no-need": "不用回", verbose: "太啰嗦", "no-conclusion": "没有结论", self: "我自己回" } as const;
export type DropReason = keyof typeof DROP_REASONS;

/** How long the owner's own reply is looked for after the message; after that the sample says they did not reply. */
const WATCH_MS = 24 * 3600_000;
/** How far back samples count. */
const RECENT_MS = 60 * 86400_000;

type Row = {
  id: string; handle_run: string | null; channel: string; chat_id: string; chat_kind: string; chat_name: string; topic_id: string | null;
  asker_id: string | null; asker_name: string; ask: string; what: string; message_ids: string; last_ms: number;
  draft: string | null; decision: string | null; final: string | null; reason: string | null;
  owner_reply: string | null; settled_at: string | null; created_at: string;
};

const flat = (s: string, n: number) => truncate(s.replace(/\s+/g, " ").trim(), n);

/** A message looking for the owner reached the flow (whether or not the owner had seen it by then). Once per mention run. */
export function noteAsk(app: App, runId: string, channel: MentionChannel, chat: { chatId: string; chatName: string; chatKind: string; topicId: string | null }, messages: MentionMessage[], what = "") {
  if (!messages.length) return;
  const last = messages[messages.length - 1];
  run(app.db,
    `insert into reply_samples(id, channel, chat_id, chat_kind, chat_name, topic_id, asker_id, asker_name, ask, what, message_ids, last_ms, created_at)
     values(?,?,?,?,?,?,?,?,?,?,?,?,?) on conflict(id) do update set what = case when excluded.what != '' then excluded.what else reply_samples.what end`,
    runId, channel.id, chat.chatId, chat.chatKind, chat.chatName, chat.topicId, last.senderId, last.sender,
    truncate(messages.map((m) => m.text).join("\n"), 800), what, JSON.stringify(messages.map((m) => m.id)), Math.max(...messages.map((m) => m.atMs)), now());
}
/** The handling that took the sample's messages. */
export function noteHandling(app: App, mentionRun: string, handleRun: string, what: string) {
  run(app.db, "update reply_samples set handle_run = ?, what = case when ? != '' then ? else what end where id = ?", handleRun, what, what, mentionRun);
}
/** The handler drafted (or, under the owner's standing permission, sent) a reply. */
export function noteDraft(app: App, handleRun: string, draft: string, sent = false) {
  run(app.db, "update reply_samples set draft = ?, decision = ?, final = ?, decided_at = ? where handle_run = ?", draft, sent ? "auto" : null, sent ? draft : null, sent ? now() : null, handleRun);
}
/** What the owner did with the draft. */
export function noteDecision(app: App, handleRun: string, decision: "sent" | "edited" | "dropped", final: string | null, reason: string | null) {
  run(app.db, "update reply_samples set decision = ?, final = ?, reason = ?, decided_at = ? where handle_run = ?", decision, final, reason && reason in DROP_REASONS ? reason : null, now(), handleRun);
}

/**
 * Fill in what the owner wrote themselves after the messages of open samples (a channel that can tell),
 * and close samples past the watch: no reply by then is “did not reply”. Cheap; called when a mention
 * run starts and before samples are read.
 */
export function settleSamples(app: App) {
  const open = all<Row>(app.db, "select * from reply_samples where settled_at is null order by created_at limit 200");
  for (const s of open) {
    let channel: MentionChannel;
    try {
      channel = mentionChannel(s.channel);
    } catch {
      continue;
    }
    const until = s.last_ms + WATCH_MS;
    const said = channel.ownerSaid?.(app, { chatId: s.chat_id, chatKind: s.chat_kind as "p2p" | "group", topicId: s.topic_id, messageIds: JSON.parse(s.message_ids) as string[] }, s.last_ms, until) ?? [];
    // What omem sent for the owner (the draft they sent) is not their own wording.
    const own = said.filter((m) => !s.final || flat(m.text, 400) !== flat(s.final, 400));
    const done = Date.now() > until;
    if (own.length) run(app.db, "update reply_samples set owner_reply = ?, owner_reply_at = ?, settled_at = case when ? then ? else settled_at end where id = ?", truncate(own.map((m) => m.text).join("\n"), 800), new Date(own[0].atMs).toISOString(), done ? 1 : 0, now(), s.id);
    else if (done) run(app.db, "update reply_samples set settled_at = ? where id = ?", now(), s.id);
  }
}

const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0);

/** How long the owner's replies usually are (their own wording, and drafts they changed before sending); 0 with fewer than five. */
export function typicalReplyLength(app: App) {
  const rows = all<{ t: string }>(app.db,
    `select coalesce(owner_reply, final) t from reply_samples where created_at > ? and (owner_reply is not null or decision = 'edited') order by created_at desc limit 60`,
    new Date(Date.now() - RECENT_MS).toISOString());
  return rows.length < 5 ? 0 : median(rows.map((r) => r.t.length));
}

function outcome(s: Row) {
  const ask = `${s.asker_name || "对方"}${s.chat_kind === "p2p" ? "（私聊）" : `（${s.chat_name}）`}：「${flat(s.ask, 110)}」`;
  const own = s.owner_reply ? `本人自己回：「${flat(s.owner_reply, 140)}」` : "";
  if (s.decision === "sent") return `${ask} → 你拟的「${flat(s.final ?? s.draft ?? "", 140)}」本人照发了`;
  if (s.decision === "edited") return `${ask} → 你拟的「${flat(s.draft ?? "", 100)}」本人改成「${flat(s.final ?? "", 140)}」才发`;
  if (s.decision === "dropped") return `${ask} → 你拟的「${flat(s.draft ?? "", 100)}」本人没发${s.reason ? `（${DROP_REASONS[s.reason as DropReason]}）` : ""}${own ? `，${own}` : ""}`;
  if (own) return `${ask} → ${own}`;
  return s.settled_at ? `${ask} → 本人没回` : "";
}

/** The samples that say something (a decision, the owner's own reply, or a settled silence), nearest first: this person, this chat, then the rest. */
function nearest(app: App, to: { askerId: string | null; chatId: string }, limit: number) {
  const since = new Date(Date.now() - RECENT_MS).toISOString();
  const said = "(decision is not null or owner_reply is not null or settled_at is not null)";
  const pick = (where: string, n: number, ...params: (string | number)[]) => all<Row>(app.db, `select * from reply_samples where created_at > ? and ${said} and ${where} order by created_at desc limit ?`, since, ...params, n);
  const seen = new Set<string>();
  const out: Row[] = [];
  const add = (rows: Row[]) => {
    for (const r of rows) if (!seen.has(r.id) && out.length < limit) (seen.add(r.id), out.push(r));
  };
  if (to.askerId) add(pick("asker_id = ?", 3, to.askerId));
  add(pick("chat_id = ?", 2, to.chatId));
  // The rest: what teaches most first — drafts the owner changed or refused, then their own replies.
  add(pick("decision in ('edited', 'dropped')", 3));
  add(pick("owner_reply is not null", 3));
  // And what they left unanswered: when not to reply at all.
  add(pick("owner_reply is null and decision is null and settled_at is not null", 2));
  return out;
}

/** For the triage: what the owner did with this person's and this chat's earlier messages, in a line or two. */
export function habitLine(app: App, to: { askerId: string | null; askerName: string; chatId: string; chatKind: string }) {
  settleSamples(app);
  const since = new Date(Date.now() - RECENT_MS).toISOString();
  const count = (where: string, ...p: string[]) => one<{ n: number; own: number; silent: number; sent: number; dropped: number; no_need: number }>(app.db,
    `select count(*) n, sum(owner_reply is not null) own, sum(owner_reply is null and settled_at is not null and coalesce(decision, '') not in ('sent', 'edited', 'auto')) silent,
            sum(decision in ('sent', 'edited', 'auto')) sent, sum(decision = 'dropped') dropped, sum(reason = 'no-need') no_need
       from reply_samples where created_at > ? and ${where}`, since, ...p)!;
  const line = (label: string, c: ReturnType<typeof count>) =>
    c.n ? `${label}近 60 天找过本人 ${c.n} 次：本人自己回了 ${c.own ?? 0} 次，没回 ${c.silent ?? 0} 次${(c.sent ?? 0) + (c.dropped ?? 0) ? `；拟好的回复发了 ${c.sent ?? 0} 次、没发 ${c.dropped ?? 0} 次${c.no_need ? `（其中 ${c.no_need} 次本人说不用回）` : ""}` : ""}。` : "";
  return [to.askerId ? line(`${to.askerName} `, count("asker_id = ?", to.askerId)) : "", to.chatKind === "group" ? line("这个群里", count("chat_id = ?", to.chatId)) : ""].filter(Boolean).join("\n");
}

/** For the handler: how the owner answers, from their own replies and what they did with earlier drafts. Empty when there is nothing yet. */
export function replyHabits(app: App, to: { askerId: string | null; chatId: string }) {
  settleSamples(app);
  const lines = nearest(app, to, 10).map(outcome).filter(Boolean);
  if (!lines.length) return "";
  const since = new Date(Date.now() - RECENT_MS).toISOString();
  const d = one<{ n: number; sent: number; edited: number; dropped: number }>(app.db,
    "select count(*) n, sum(decision = 'sent') sent, sum(decision = 'edited') edited, sum(decision = 'dropped') dropped from reply_samples where created_at > ? and decision in ('sent', 'edited', 'dropped')", since)!;
  const why = all<{ reason: string; n: number }>(app.db, "select reason, count(*) n from reply_samples where created_at > ? and decision = 'dropped' and reason is not null group by reason order by n desc", since)
    .map((r) => `${DROP_REASONS[r.reason as DropReason] ?? r.reason} ${r.n}`).join("、");
  const len = typicalReplyLength(app);
  return [
    ...(len ? [`本人自己的回复通常 ${len} 字左右。`] : []),
    ...(d.n ? [`近 60 天你拟的回复 ${d.n} 条：照发 ${d.sent ?? 0}、改后发 ${d.edited ?? 0}、没发 ${d.dropped ?? 0}${why ? `（${why}）` : ""}。`] : []),
    ...lines.map((l) => `- ${l}`),
  ].join("\n");
}

/** Counts for the settings page: what happened to the drafts lately. */
export function replyStats(app: App) {
  settleSamples(app);
  const since = new Date(Date.now() - RECENT_MS).toISOString();
  const d = one<{ n: number; drafts: number; sent: number; edited: number; dropped: number; own: number; silent: number }>(app.db,
    `select count(*) n, sum(draft is not null) drafts, sum(decision = 'sent') sent, sum(decision = 'edited') edited, sum(decision = 'dropped') dropped,
            sum(owner_reply is not null) own, sum(owner_reply is null and settled_at is not null and coalesce(decision, '') not in ('sent', 'edited', 'auto')) silent
       from reply_samples where created_at > ?`, since)!;
  const reasons = Object.fromEntries(all<{ reason: string; n: number }>(app.db, "select reason, count(*) n from reply_samples where created_at > ? and decision = 'dropped' and reason is not null group by reason", since).map((r) => [r.reason, r.n]));
  return { days: 60, samples: d.n, drafts: d.drafts ?? 0, sent: d.sent ?? 0, edited: d.edited ?? 0, dropped: d.dropped ?? 0, ownReplies: d.own ?? 0, noReply: d.silent ?? 0, reasons, typicalLength: typicalReplyLength(app) };
}
