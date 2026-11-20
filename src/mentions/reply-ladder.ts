import type { App } from "../core/app.ts";
import { audit } from "../auth/permissions.ts";
import { all, one, run } from "../core/db.ts";
import { OWNER } from "../core/users.ts";
import { now } from "../core/util.ts";
import { createAsk, registerAskHandler, type Ask } from "../agents/asks.ts";
import { mentionChannel, type MentionChannel, type MentionInfo } from "./channel.ts";

/**
 * Answering the people who look for the owner has three rungs per kind of chat (`mentions.reply`:
 * off, draft, auto). Like a tool's approval (agents/approval-ladder.ts) a rung goes up only on the
 * owner's word and comes down by itself:
 *
 * - up: once the owner has sent `mentions.reply.promoteAfter` drafts in a row for that kind of chat
 *   exactly as they were drafted, the host asks — once, and not again within a month — whether such
 *   replies may go out by themselves. Saying yes is the same standing permission as choosing 自动 in
 *   settings: it still applies only where the triage finds the reply needs no decision of the owner's.
 *   A draft the owner changed or did not send starts the count again.
 * - down: the owner dislikes the reminder that told them what was sent on their behalf. That kind of
 *   chat goes back to drafts at once, and the count starts again.
 *
 * The host only counts and asks; what to reply stays the handler's, whether to send stays the owner's.
 */
type Kind = "p2p" | "group";

const STREAK_DAYS = 60;
const ASK_AGAIN_DAYS = 30;
const askedKey = (channel: string, kind: Kind) => `reply_promote:${channel}:${kind}`;
const resetKey = (channel: string, kind: Kind) => `reply_streak_reset:${channel}:${kind}`;
const kv = (app: App, key: string) => one<{ value: string }>(app.db, "select value from kv where key = ?", key)?.value;
const setKv = (app: App, key: string, value: string) => run(app.db, "insert into kv(key,value) values(?, ?) on conflict(key) do update set value = excluded.value", key, value);
const kindLabel = (kind: Kind) => (kind === "p2p" ? "私聊里找你的人" : "群里找你的人");

/** How many of the latest drafts for this kind of chat the owner sent unchanged, back to the first one changed or not sent. */
export function draftStreak(app: App, channel: string, kind: Kind): number {
  const window = new Date(Date.now() - STREAK_DAYS * 86400_000).toISOString();
  const reset = kv(app, resetKey(channel, kind));
  const since = reset && reset > window ? reset : window;
  const rows = all<{ decision: string }>(
    app.db,
    "select decision from reply_samples where channel = ? and chat_kind = ? and decision in ('sent', 'edited', 'dropped') and decided_at > ? order by decided_at desc limit 100",
    channel, kind, since,
  );
  let n = 0;
  for (const r of rows) {
    if (r.decision !== "sent") break;
    n++;
  }
  return n;
}

/**
 * After the owner sent a draft as it was: when the streak has reached `promoteAfter` and this kind of
 * chat is on drafts, ask once whether such replies may go out by themselves. Returns the question, or null.
 */
export function suggestReplyPromotion(app: App, channelId: string | undefined, kind: Kind): Ask | null {
  const after = app.config.mentions.reply.promoteAfter ?? 10;
  if (!after) return null;
  let channel: MentionChannel;
  try {
    channel = mentionChannel(channelId);
  } catch {
    return null;
  }
  if (!channel.reply?.setMode || channel.reply.mode(app, kind) !== "draft") return null;
  if (draftStreak(app, channel.id, kind) < after) return null;
  const last = Date.parse(kv(app, askedKey(channel.id, kind)) ?? "");
  if (Number.isFinite(last) && Date.now() - last < ASK_AGAIN_DAYS * 86400_000) return null;
  setKv(app, askedKey(channel.id, kind), now());
  return createAsk(app, {
    runId: null,
    conversationId: null,
    question: `最近 ${after} 次给${kindLabel(kind)}拟的回复，你都原样发了。以后这类回复在不用你拍板时直接发、发完告诉你回了什么，还是继续每次先给你看？（涉及承诺、排期、审批和你的意见的，仍然先给你看。）`,
    options: [{ label: "直接发，发完告诉我" }, { label: "继续先给我看" }],
    allowText: false,
    context: { handler: "reply-promote", channel: channel.id, kind },
  });
}

registerAskHandler("reply-promote", async (app, ask, context) => {
  const kind = context.kind === "p2p" || context.kind === "group" ? context.kind : null;
  // Only the owner's own answer gives a standing permission.
  if (!kind || ask.choice !== 0 || ask.userId !== OWNER || ask.answeredBy !== OWNER) return;
  let channel: MentionChannel;
  try {
    channel = mentionChannel(typeof context.channel === "string" ? context.channel : undefined);
  } catch {
    return;
  }
  if (!channel.reply?.setMode || channel.reply.mode(app, kind) !== "draft") return;
  channel.reply.setMode(app, kind, "auto");
  audit(app, OWNER, "mention-reply.promote", `${channel.id}:${kind}`, { askId: ask.id });
  run(app.db, "update asks set result = ? where id = ?", `以后给${kindLabel(kind)}的回复，不用你拍板的直接发、发完告诉你；要改回在 设置 → 代你回复 → 有人找你`, ask.id);
});

/**
 * The owner disliked a reminder. When that reminder is a handling's that answered the asker by itself,
 * that kind of chat goes back to drafts. Returns what was changed (for the note to the owner), or null
 * when the reminder is not such a one or the setting is no longer 自动.
 */
export function demoteReplyFor(app: App, runId: string | null | undefined): { kind: Kind; who: string } | null {
  if (!runId) return null;
  const r = one<{ input: string; output: string | null }>(app.db, "select input, output from runs where id = ? and kind = 'agent'", runId);
  if (!r) return null;
  const m = (JSON.parse(r.input) as { mention?: MentionInfo }).mention;
  const replied = (JSON.parse(r.output ?? "{}") as { mentionReply?: { by?: string; via?: string; ok?: boolean } }).mentionReply;
  if (!m || replied?.by !== "auto" || !replied.via || replied.ok === false) return null;
  let channel: MentionChannel;
  try {
    channel = mentionChannel(m.channel);
  } catch {
    return null;
  }
  if (!channel.reply?.setMode || channel.reply.mode(app, m.chatKind) !== "auto") return null;
  channel.reply.setMode(app, m.chatKind, "draft");
  setKv(app, resetKey(channel.id, m.chatKind), now());
  audit(app, OWNER, "mention-reply.demote", `${channel.id}:${m.chatKind}`, { runId });
  return { kind: m.chatKind, who: m.senderName };
}

/** For the note to the owner after a demotion. */
export const demotedText = (d: { kind: Kind; who: string }) =>
  `你对替你回复 ${d.who} 的那条表示了不满意，以后给${kindLabel(d.kind)}的回复先给你看草稿，你点了才发。要改回直接发，在 设置 → 代你回复 → 有人找你。`;

