import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { json, now, sha256, truncate } from "../core/util.ts";

/**
 * Reactions as feedback. Every message omem's bots post is recorded in `lark_sent` (which run and
 * conversation it belongs to, and what it was: an answer, a notification, a card, a progress card),
 * so an emoji someone puts on it later finds the run that wrote it. Reactions arrive as bot events
 * (`im.message.reaction.created_v1` / `deleted_v1`, lark-bot.ts) and are kept in `feedback` with the
 * raw emoji_type and a polarity from `feedback.emoji`; removing one only fills `removed_at`.
 *
 * Everyone's reactions are kept: the owner's, registered users' (member), guests' — the statistics
 * show the owner's by default and the others apart. Reactions by apps (omem's own OnIt/DONE, other
 * bots) are ignored. Besides reactions on bot messages, the owner's reactions on other messages in
 * a bot's chats are kept too (`on_bot = 0`), so the notification gate knows the owner already
 * answered a message with an emoji without asking lark-cli.
 */
export type SentPurpose = "answer" | "notification" | "card" | "progress";
export type Polarity = "positive" | "negative" | "ack" | "neutral";
export type ActorKind = "owner" | "member" | "guest" | "bot";

/** What a bot just posted. Run and conversation may be filled in later (`markLarkSent`). */
export type SentRecord = { messageId: string; chatId?: string | null; runId?: string | null; conversationId?: string | null; purpose: SentPurpose; bot: string };

function conversationOfRun(app: App, runId: string | null | undefined) {
  if (!runId) return null;
  return one<{ c: string | null }>(app.db, "select coalesce(json_extract(input, '$.conversationId'), json_extract(input, '$.threadId')) c from runs where id = ?", runId)?.c ?? null;
}

export function recordLarkSent(app: App, s: SentRecord) {
  if (!s.messageId) return;
  const conversationId = s.conversationId ?? conversationOfRun(app, s.runId);
  run(
    app.db,
    `insert into lark_sent(message_id, chat_id, run_id, conversation_id, purpose, bot, at) values(?,?,?,?,?,?,?)
     on conflict(message_id) do update set chat_id = coalesce(excluded.chat_id, lark_sent.chat_id), run_id = coalesce(excluded.run_id, lark_sent.run_id),
       conversation_id = coalesce(excluded.conversation_id, lark_sent.conversation_id), purpose = excluded.purpose`,
    s.messageId,
    s.chatId ?? null,
    s.runId ?? null,
    conversationId,
    s.purpose,
    s.bot,
    now(),
  );
}

/** Later knowledge about a sent message: the progress card that became the answer, the run behind it. */
export function markLarkSent(app: App, messageId: string | null | undefined, patch: { purpose?: SentPurpose; runId?: string | null; conversationId?: string | null; chatId?: string | null; bot?: string }) {
  if (!messageId) return;
  const cur = one<{ purpose: SentPurpose; bot: string }>(app.db, "select purpose, bot from lark_sent where message_id = ?", messageId);
  recordLarkSent(app, { messageId, chatId: patch.chatId, runId: patch.runId, conversationId: patch.conversationId, purpose: patch.purpose ?? cur?.purpose ?? "answer", bot: patch.bot ?? cur?.bot ?? "main" });
  // Reactions that came before the run was known.
  if (patch.runId) run(app.db, "update feedback set run_id = ? where message_id = ? and run_id is null", patch.runId, messageId);
}

export function polarityOf(app: App, emoji: string): Polarity {
  const e = emoji.toLowerCase();
  const m = app.config.feedback.emoji;
  const has = (list: string[]) => list.some((x) => x.toLowerCase() === e);
  if (has(m.negative)) return "negative";
  if (has(m.positive)) return "positive";
  if (has(m.ack)) return "ack";
  return "neutral";
}

/**
 * What Feishu actually sends, kept for checking the field names (the first few events of each kind,
 * cut to 4 000 characters, in kv `lark_reaction_samples`). Read it with
 * `select value from kv where key = 'lark_reaction_samples'`.
 */
function sample(app: App, kind: string, value: unknown) {
  try {
    const all_ = json<Record<string, { at: string; value: string }[]>>(one<{ value: string }>(app.db, "select value from kv where key = 'lark_reaction_samples'")?.value, {});
    const list = all_[kind] ?? [];
    if (list.length >= 3) return;
    list.push({ at: now(), value: JSON.stringify(value).slice(0, 4000) });
    all_[kind] = list;
    run(app.db, "insert into kv(key,value) values('lark_reaction_samples', ?) on conflict(key) do update set value = excluded.value", JSON.stringify(all_));
  } catch {}
}

export type ReactionEvent = {
  message_id?: string;
  reaction_type?: { emoji_type?: string };
  operator_type?: string;
  user_id?: { open_id?: string; user_id?: string; union_id?: string };
  action_time?: string | number;
};

/** Who reacted, as the bot's app sees them (resolved by lark-bot.ts: owner, registered user, or nobody known). */
export type ReactionActor = (ids: { open_id?: string; user_id?: string }) => "owner" | "member" | "guest";

function atOf(t: string | number | undefined) {
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) return now();
  return new Date(n < 1e12 ? n * 1000 : n).toISOString();
}

export function feedbackId(channel: string, messageId: string, actor: string, emoji: string) {
  return `fb_${sha256(`${channel}|${messageId}|${actor}|${emoji}`).slice(0, 24)}`;
}

/** One reaction event for bot `bot`. Returns what was stored, or why not. */
export function onLarkReaction(app: App, bot: string, d: ReactionEvent, kind: "created" | "deleted", actorOf: ReactionActor, postedByBot: (messageId: string) => boolean = () => false) {
  sample(app, kind, d);
  const messageId = d.message_id;
  const emoji = d.reaction_type?.emoji_type;
  if (!messageId || !emoji) return { skipped: "no message or emoji" };
  if (d.operator_type && d.operator_type !== "user") return { skipped: "app" };
  const ids = d.user_id ?? {};
  const actor = ids.user_id || ids.union_id || ids.open_id;
  if (!actor) return { skipped: "no operator" };
  const sent = one<{ run_id: string | null }>(app.db, "select run_id from lark_sent where message_id = ?", messageId);
  const onBot = !!sent || postedByBot(messageId);
  const actorKind = actorOf({ open_id: ids.open_id, user_id: ids.user_id });
  // On other people's messages only the owner's reactions matter (the notification gate reads them).
  if (!onBot && actorKind !== "owner") return { skipped: "not a bot message" };
  const id = feedbackId("lark", messageId, actor, emoji);
  if (kind === "deleted") {
    run(app.db, "update feedback set removed_at = ? where id = ? and removed_at is null", atOf(d.action_time), id);
    return { id, removed: true };
  }
  const polarity = polarityOf(app, emoji);
  run(
    app.db,
    `insert into feedback(id, channel, message_id, run_id, bot, on_bot, actor_id, actor_kind, emoji, polarity, at, removed_at) values(?,?,?,?,?,?,?,?,?,?,?,null)
     on conflict(id) do update set removed_at = null, at = excluded.at, polarity = excluded.polarity, run_id = coalesce(feedback.run_id, excluded.run_id)`,
    id,
    "lark",
    messageId,
    sent?.run_id ?? null,
    bot,
    onBot ? 1 : 0,
    actor,
    actorKind,
    emoji,
    polarity,
    atOf(d.action_time),
  );
  return { id, polarity, actorKind, onBot };
}

/** The emoji types the owner has on a message right now, from the bot's events; null when none were seen. */
export function ownerReactionsSeen(app: App, messageId: string): string[] | null {
  const rows = all<{ emoji: string }>(app.db, "select emoji from feedback where message_id = ? and actor_kind = 'owner' and removed_at is null", messageId);
  return rows.length ? rows.map((r) => r.emoji) : null;
}

/** Reactions on what one run sent (for the coach's evidence). */
export function runReactions(app: App, runId: string) {
  return all<{ emoji: string; polarity: Polarity; actor_kind: ActorKind; at: string; message_id: string }>(
    app.db,
    "select emoji, polarity, actor_kind, at, message_id from feedback where run_id = ? and on_bot = 1 and removed_at is null order by at",
    runId,
  );
}

export function runReactionsText(app: App, runId: string) {
  const rows = runReactions(app, runId);
  if (!rows.length) return "";
  const label: Record<Polarity, string> = { positive: "正面", negative: "负面", ack: "确认收到", neutral: "中性" };
  const who: Record<ActorKind, string> = { owner: "本人", member: "其他用户", guest: "访客", bot: "机器人" };
  return rows.map((r) => `${who[r.actor_kind]} ${r.emoji}（${label[r.polarity]}）`).join("、");
}

type Counts = { positive: number; negative: number; ack: number; neutral: number };
const zero = (): Counts => ({ positive: 0, negative: 0, ack: 0, neutral: 0 });
export type FeedbackRow = { key: string; owner: Counts; others: Counts; guests: Counts };

/** Which profile a run answers for: an agent spec, else its first built-in role, else its kind. */
export function runProfileName(r: { kind: string | null; roles: string | null; spec: string | null }) {
  if (r.spec) return r.spec;
  const role = (r.roles ?? "").split("|").find(Boolean);
  return role ?? r.kind ?? "（没有运行）";
}

export function runModelLabel(ai: string | null) {
  const a = json<{ profile?: string; model?: string; effort?: string }>(ai, {});
  return [a.profile, a.model, a.effort].filter(Boolean).join(" / ") || "未知";
}

/**
 * Reactions on bot messages in the last `days`, by profile (agent spec or built-in role) and by
 * model (`runs.ai`); the owner's, registered users' and guests' apart.
 */
export function feedbackStats(app: App, days = 30) {
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const rows = all<{ polarity: Polarity; actor_kind: ActorKind; kind: string | null; roles: string | null; spec: string | null; ai: string | null }>(
    app.db,
    `select f.polarity, f.actor_kind, r.kind, r.roles, json_extract(r.input, '$.spec') spec, r.ai
       from feedback f left join runs r on r.id = f.run_id
      where f.on_bot = 1 and f.removed_at is null and f.at > ? and f.actor_kind != 'bot'`,
    since,
  );
  const byProfile = new Map<string, FeedbackRow>();
  const byModel = new Map<string, FeedbackRow>();
  const total: FeedbackRow = { key: "全部", owner: zero(), others: zero(), guests: zero() };
  const add = (map: Map<string, FeedbackRow>, key: string, r: (typeof rows)[number]) => {
    const row = map.get(key) ?? { key, owner: zero(), others: zero(), guests: zero() };
    map.set(key, row);
    bump(row, r);
  };
  const bump = (row: FeedbackRow, r: (typeof rows)[number]) => {
    const bucket = r.actor_kind === "owner" ? row.owner : r.actor_kind === "member" ? row.others : row.guests;
    bucket[r.polarity]++;
  };
  for (const r of rows) {
    add(byProfile, runProfileName(r), r);
    if (r.kind) add(byModel, runModelLabel(r.ai), r);
    bump(total, r);
  }
  const sort = (m: Map<string, FeedbackRow>) => [...m.values()].sort((a, b) => sum(b) - sum(a));
  const sum = (r: FeedbackRow) => Object.values(r.owner).reduce((a, b) => a + b, 0) + Object.values(r.others).reduce((a, b) => a + b, 0) + Object.values(r.guests).reduce((a, b) => a + b, 0);
  const lastEvent = one<{ at: string }>(app.db, "select max(at) at from feedback where on_bot = 1")?.at ?? null;
  return { days, since, total, byProfile: sort(byProfile), byModel: sort(byModel), lastReactionAt: lastEvent, botMessages: one<{ n: number }>(app.db, "select count(*) n from lark_sent where at > ?", since)!.n };
}

/** Negative reactions since `since` (the dreamer's and the Memory page's shortcomings). */
export function negativeReactions(app: App, since: string, limit = 12) {
  return all<{ id: string; message_id: string; run_id: string | null; emoji: string; actor_kind: ActorKind; at: string; text: string | null; conversation_id: string | null }>(
    app.db,
    `select f.id, f.message_id, f.run_id, f.emoji, f.actor_kind, f.at,
            (select m.text from messages m where m.run_id = f.run_id and m.role = 'assistant' order by m.created_at desc limit 1) text,
            s.conversation_id
       from feedback f left join lark_sent s on s.message_id = f.message_id
      where f.on_bot = 1 and f.removed_at is null and f.polarity = 'negative' and f.actor_kind != 'bot' and f.at > ?
      order by case f.actor_kind when 'owner' then 0 else 1 end, f.at desc limit ?`,
    since,
    limit,
  ).map((r) => ({ messageId: r.message_id, runId: r.run_id, emoji: r.emoji, actorKind: r.actor_kind, at: r.at, conversationId: r.conversation_id, answer: truncate((r.text ?? "").replace(/\s+/g, " "), 200) }));
}

export function positiveReactionCount(app: App, since: string) {
  return one<{ n: number }>(app.db, "select count(*) n from feedback where on_bot = 1 and removed_at is null and polarity = 'positive' and actor_kind != 'bot' and at > ?", since)!.n;
}

/**
 * Whether reaction events reach omem: bot messages exist but no reaction event (of anyone's, on
 * anything) arrived for `days`. A hint that the app does not subscribe to them, not proof.
 */
export function reactionEventsQuiet(app: App, days = 7) {
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const sent = one<{ n: number }>(app.db, "select count(*) n from lark_sent where at > ?", since)!.n;
  const seen = one<{ n: number }>(app.db, "select count(*) n from feedback where at > ? or removed_at > ?", since, since)!.n;
  const sampled = !!one(app.db, "select 1 from kv where key = 'lark_reaction_samples'");
  return { days, botMessages: sent, reactions: seen, everReceived: sampled, quiet: sent >= 20 && seen === 0 };
}
