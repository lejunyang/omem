import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { decide, decisionReady, type DecisionQuestion } from "../core/decision.ts";
import { OWNER, userName } from "../core/users.ts";
import { HttpError, json, now, truncate } from "../core/util.ts";

/**
 * Whether a reply helped, read from what people said after it (docs/v2/reply-outcomes.md).
 *
 * Emoji are rare, so they cannot be the only sign. Every reply an answering run sends — a message
 * in a conversation (threads.ts), a message a bot posts in Feishu as an answer (lark-feedback.ts)
 * — is noted here with the time it went out. Some hours later the host collects what was said
 * after it in the same conversation or chat and the decision model picks one label; nothing said
 * at all is “silent” without asking a model, an emoji alone is read as it is.
 *
 * The first label can be wrong. Whoever looks at the run again with a stronger model — the night
 * replay's judge, the coach, the nightly second reading (outcome-review.ts) — reads the follow-up and
 * may revise it; the first label is kept beside the revision, so how often the decision model was
 * overruled can be counted. The second reading also records when it agreed (`checked`). What the owner
 * set (a revision on the run page) is never changed by anyone else.
 */
export const REPLY_LABELS = {
  resolved: "解决了",
  followup: "被追问",
  corrected: "被纠正",
  taken_over: "别人接手了",
  unrelated: "看不出",
  silent: "没人接话",
  unjudged: "没判",
} as const;
export type ReplyLabel = keyof typeof REPLY_LABELS;
/** What a judge (the decision model, or a reviewer revising it) may answer. */
export const JUDGED_LABELS = ["resolved", "followup", "corrected", "taken_over", "unrelated"] as const;
export type JudgedLabel = (typeof JUDGED_LABELS)[number];
const judged = (v: unknown): v is JudgedLabel => (JUDGED_LABELS as readonly unknown[]).includes(v);

/** Runs that answer someone. Patrols, briefs and coordination turns also post, but nobody asked. */
const ANSWERING = new Set(["ask", "guest", "lark-command", "agent", "rule-fire"]);
/** In a busy group, only what comes this soon after a reply is taken to be about it (unless it is in its thread or quotes it). */
const NEARBY_MS = 2 * 3600_000;
/** A reply still not judged this long after it was sent (no decision model, or it keeps failing) is closed as “没判”. */
const GIVE_UP_MS = 7 * 86400_000;
const RETRY_MS = 3600_000;

export type FollowUp = { who: string; text: string; at: string };
export type OutcomeRow = {
  run_id: string; at: string; channel: string; chat_id: string | null; conversation_id: string | null; message_id: string | null;
  label: ReplyLabel | null; confidence: number | null; by: string | null; evidence: string; labelled_at: string | null;
  revised_label: ReplyLabel | null; revised_by: string | null; revised_why: string | null; revised_at: string | null; due_at: string;
  checked: "confirmed" | "revised" | null; checked_label: ReplyLabel | null; checked_by: string | null; checked_why: string | null; checked_pick: string | null; checked_at: string | null;
};
type Row = OutcomeRow;
/** Who stands for the owner in `by` / `revised_by`: what they set is ground truth, nobody else changes it. */
export const OWNER_BY = "本人";
export type ReplyOutcome = {
  runId: string; at: string; dueAt: string;
  /**
   * The label in force: the revision when there is one; a first label the model was unsure of counts as
   * 看不出, unless the nightly second reading agreed with it.
   */
  label: ReplyLabel | null; text: string;
  first: { label: ReplyLabel; confidence: number | null; by: string; at: string } | null;
  revised: { label: ReplyLabel; by: string; why: string; at: string } | null;
  /** The nightly second reading (outcome-review.ts): agreed with the first label, or changed it. */
  checked: { verdict: "confirmed" | "revised"; label: ReplyLabel; by: string; why: string; pick: string; at: string } | null;
  evidence: FollowUp[];
};

/** A reply went out. The last message of a run is the one what follows is measured from. */
export function noteReply(app: App, r: { runId?: string | null; channel: "lark" | "conversation"; chatId?: string | null; conversationId?: string | null; messageId?: string | null; at?: string }) {
  const cfg = app.config.replies.outcome;
  if (!r.runId || !cfg.enabled) return;
  const known = one<{ label: string | null }>(app.db, "select label from reply_outcomes where run_id = ?", r.runId);
  // Judged already: one more message from the same run does not reopen it.
  if (known?.label) return;
  if (!known) {
    const origin = one<{ kind: string; input: string }>(app.db, "select kind, input from runs where id = ?", r.runId);
    if (!origin || !ANSWERING.has(origin.kind)) return;
    const input = json<Record<string, unknown>>(origin.input, {});
    if (input.coordinate || input.wake || input.handoff || input.consultOf !== undefined || input.silent || input.meeting) return;
  }
  const at = r.at ?? now();
  run(
    app.db,
    `insert into reply_outcomes(run_id, at, channel, chat_id, conversation_id, message_id, due_at) values(?,?,?,?,?,?,?)
     on conflict(run_id) do update set at = max(at, excluded.at), due_at = max(due_at, excluded.due_at),
       channel = case when excluded.channel = 'lark' then 'lark' else channel end,
       chat_id = coalesce(excluded.chat_id, chat_id), conversation_id = coalesce(excluded.conversation_id, conversation_id),
       message_id = coalesce(excluded.message_id, message_id)`,
    r.runId, at, r.channel, r.chatId ?? null, r.conversationId ?? null, r.messageId ?? null, new Date(Date.parse(at) + cfg.afterHours * 3600_000).toISOString(),
  );
}

/**
 * Who said a turn of a conversation: the named speaker of a watched chat, a member by name in their own
 * conversation with the bot (those turns carry only `userId`), else the owner.
 */
export function turnSpeaker(app: App, meta: { speaker?: unknown; userId?: unknown }): { name: string; owner: boolean } {
  if (typeof meta.speaker === "string" && meta.speaker) return { name: meta.speaker, owner: false };
  if (typeof meta.userId === "string" && meta.userId && meta.userId !== OWNER) return { name: userName(app, meta.userId), owner: false };
  return { name: OWNER_BY, owner: true };
}

/**
 * What two copies of one message share: the conversation keeps the turn without the bot's @mention,
 * the captured chat line starts with it. Mentions are left out of the key on both sides.
 */
export function messageKey(text: string) {
  const t = text.replace(/\s+/g, " ").trim();
  return t.replace(/@\S+/g, "").replace(/\s+/g, " ").trim().slice(0, 60) || t.slice(0, 60);
}

/** What was said after the reply, oldest first: the conversation's own messages, then the captured chat. */
function followUps(app: App, o: Row, until: string): FollowUp[] {
  const out: FollowUp[] = [];
  const seen = new Set<string>();
  const add = (who: string, text: string, at: string) => {
    const t = text.replace(/\s+/g, " ").trim();
    // The same message can be both a turn of the conversation and a line of the captured chat.
    const key = messageKey(t);
    if (!t || seen.has(key)) return;
    seen.add(key);
    out.push({ who, text: truncate(t, 400), at });
  };
  if (o.conversation_id)
    for (const m of all<{ text: string; meta: string; created_at: string }>(
      app.db,
      "select text, meta, created_at from messages where conversation_id = ? and role = 'user' and created_at > ? and created_at <= ? and json_extract(meta, '$.command') is null order by created_at limit 8",
      o.conversation_id, o.at, until,
    )) {
      const meta = json<{ speaker?: unknown; userId?: unknown; wake?: unknown }>(m.meta, {});
      if (!meta.wake) add(turnSpeaker(app, meta).name, m.text, m.created_at);
    }
  if (o.chat_id) {
    const from = Date.parse(o.at);
    const rows = all<{ thread_id: string | null; parent_id: string | null; sender_name: string; sender_kind: string; content: string; create_ms: number }>(
      app.db,
      `select thread_id, parent_id, sender_name, sender_kind, content, create_ms from lark_messages
       where chat_id = ? and create_ms > ? and create_ms <= ? and sender_kind in ('user','owner') and msg_type in ('text','post') and trim(content) != ''
       order by create_ms limit 40`,
      o.chat_id, from, Date.parse(until),
    );
    const thread = o.message_id ? one<{ thread_id: string | null }>(app.db, "select thread_id from lark_messages where message_id = ?", o.message_id)?.thread_id : null;
    const close = rows.filter((m) => (o.message_id && m.parent_id === o.message_id) || (thread && m.thread_id === thread));
    for (const m of (close.length ? close : rows.filter((m) => m.create_ms - from <= NEARBY_MS)).slice(0, 10))
      add(m.sender_kind === "owner" ? "本人" : m.sender_name || "群里的人", m.content, new Date(m.create_ms).toISOString());
  }
  return out.sort((a, b) => a.at.localeCompare(b.at)).slice(0, 12);
}

/** Reactions people put on the run's messages; OK / DONE and the like only say "seen" and are left out. */
export function reactions(app: App, runId: string) {
  const rows = all<{ actor_kind: string; emoji: string; polarity: string; at: string }>(
    app.db,
    "select actor_kind, emoji, polarity, at from feedback where run_id = ? and removed_at is null and on_bot = 1 and actor_kind != 'bot' and polarity in ('positive','negative')",
    runId,
  );
  return {
    positive: rows.some((r) => r.polarity === "positive"),
    negative: rows.some((r) => r.polarity === "negative"),
    lines: rows.map((r): FollowUp => ({ who: r.actor_kind === "owner" ? "本人" : "有人", text: `点了表情 ${r.emoji}（${r.polarity === "positive" ? "正面" : "负面"}）`, at: r.at })),
  };
}

/** The question the reply answered and the reply itself, short enough for a decision model. */
export function exchange(app: App, o: Pick<Row, "run_id" | "at" | "chat_id" | "conversation_id">) {
  const asked = o.conversation_id
    ? all<{ text: string }>(app.db, "select text from messages where conversation_id = ? and role = 'user' and created_at <= ? and json_extract(meta, '$.command') is null order by created_at desc limit 2", o.conversation_id, o.at).reverse().map((m) => m.text)
    : o.chat_id
      ? all<{ sender_name: string; content: string }>(app.db, "select sender_name, content from lark_messages where chat_id = ? and create_ms <= ? and sender_kind in ('user','owner') and trim(content) != '' order by create_ms desc limit 3", o.chat_id, Date.parse(o.at)).reverse().map((m) => `${m.sender_name}：${m.content}`)
      : [];
  const answer = one<{ text: string }>(app.db, "select text from messages where run_id = ? and role = 'assistant' order by created_at desc limit 1", o.run_id)?.text
    ?? String(json<{ answer?: unknown }>(one<{ output: string }>(app.db, "select output from runs where id = ?", o.run_id)?.output ?? "", {}).answer ?? "");
  return { asked: truncate(asked.join("\n").replace(/[ \t]+/g, " "), 1200), answer: truncate(answer.replace(/[ \t]+/g, " "), 1500) };
}

const QUESTION: DecisionQuestion = {
  type: "choice",
  instructions: "助手（机器人）回答了一个问题。只根据回答之后大家说的话，判断这条回答的结果；不评价回答本身写得好不好。",
  options: {
    resolved: "提问的人接受了回答：道谢、确认解决、照着去做了，或在回答的基础上继续往下推进",
    followup: "提问的人就同一件事追问、要求补充或又问了一遍，说明回答还不够",
    corrected: "有人指出回答不对、不全、答非所问，或让它重查",
    taken_over: "本人或别人自己把问题答了、处理了，没有用上这条回答",
    unrelated: "后面的话和这条回答无关，看不出它有没有用",
  },
};

/**
 * Once, when this first runs on a library that already has answers: the last week's are noted too
 * (by when their last message went out), so the first numbers do not take a week to appear.
 */
export function backfillReplies(app: App, days = 7): number {
  if (one(app.db, "select 1 from kv where key = 'reply_outcomes_backfill'")) return 0;
  run(app.db, "insert or replace into kv(key, value) values('reply_outcomes_backfill', ?)", now());
  const runs = all<{ id: string; input: string; created_at: string; finished_at: string | null }>(app.db, "select id, input, created_at, finished_at from runs where created_at >= ? and kind in ('ask','guest','lark-command','agent','rule-fire') and status = 'done'", new Date(Date.now() - days * 86400_000).toISOString());
  let n = 0;
  for (const r of runs) {
    const sent = one<{ message_id: string; chat_id: string | null; conversation_id: string | null; at: string }>(app.db, "select message_id, chat_id, conversation_id, at from lark_sent where run_id = ? and purpose = 'answer' order by at desc limit 1", r.id);
    const input = json<{ conversationId?: unknown; threadId?: unknown }>(r.input, {});
    const conversationId = sent?.conversation_id ?? (typeof input.conversationId === "string" ? input.conversationId : typeof input.threadId === "string" ? input.threadId : null);
    // Only the stretch of the conversation this run wrote in: a long-lived conversation is not read through for every run.
    const said = conversationId ? one<{ created_at: string }>(app.db, "select created_at from messages where conversation_id = ? and created_at >= ? and created_at <= ? and run_id = ? and role = 'assistant' order by created_at desc limit 1", conversationId, r.created_at, new Date(Date.parse(r.finished_at ?? r.created_at) + 600_000).toISOString(), r.id) : undefined;
    const at = [sent?.at, said?.created_at].filter((x): x is string => !!x).sort().at(-1);
    if (!at) continue;
    noteReply(app, { runId: r.id, channel: sent ? "lark" : "conversation", chatId: sent?.chat_id, conversationId, messageId: sent?.message_id, at });
    n++;
  }
  return n;
}

let labelling = false;
/**
 * One bounded pass over replies whose waiting time is over. Called from the patrol tick without
 * being awaited: a slow decision model delays these labels, not the patrol.
 */
export async function labelReplies(app: App, { limit = 12, at = now() }: { limit?: number; at?: string } = {}): Promise<number> {
  if (!app.config.replies.outcome.enabled || labelling) return 0;
  labelling = true;
  try {
    backfillReplies(app);
    const rows = all<Row>(app.db, "select * from reply_outcomes indexed by reply_outcomes_due where label is null and due_at <= ? order by due_at limit ?", at, Math.max(1, Math.min(50, Math.floor(limit))));
    let done = 0;
    for (const o of rows) {
      const lines = followUps(app, o, at);
      const emoji = reactions(app, o.run_id);
      const save = (label: ReplyLabel, by: string, confidence: number | null) => {
        run(app.db, "update reply_outcomes set label = ?, confidence = ?, \"by\" = ?, evidence = ?, labelled_at = ? where run_id = ? and label is null", label, confidence, by, JSON.stringify([...lines, ...emoji.lines]), at, o.run_id);
        done++;
      };
      const later = () => {
        // Keep trying for a week; after that say plainly that nobody judged it.
        if (Date.parse(at) - Date.parse(o.at) > GIVE_UP_MS) save("unjudged", "宿主", null);
        else run(app.db, "update reply_outcomes set due_at = ? where run_id = ?", new Date(Date.parse(at) + RETRY_MS).toISOString(), o.run_id);
      };
      if (!lines.length) { save(emoji.negative ? "corrected" : emoji.positive ? "resolved" : "silent", emoji.lines.length ? "表情" : "宿主", null); continue; }
      if (!decisionReady(app)) { later(); continue; }
      try {
        const { asked, answer } = exchange(app, o);
        const r = await decide(app, { 问题: asked || "（没有记录到提问）", 助手的回答: answer || "（没有记录到回答）", 回答之后的消息: [...lines, ...emoji.lines].map((l) => `${l.who}：${l.text}`) }, QUESTION, { timeoutMs: 20_000 });
        if (!r) later();
        else {
          // How sure it was: the probability it gave its own choice (the model's separate confidence field when it has no probabilities).
          const p = r.probabilities[r.choice];
          save(judged(r.choice) ? r.choice : "unrelated", r.by, typeof p === "number" && Number.isFinite(p) ? p : r.confidence);
        }
      } catch (e) {
        console.warn("[omem] 判断回复有没有用失败：", (e as Error).message);
        later();
      }
    }
    return done;
  } finally {
    labelling = false;
  }
}

function view(app: App, o: Row): ReplyOutcome {
  const unsure = !!o.label && judged(o.label) && o.confidence !== null && o.confidence < app.config.replies.outcome.threshold;
  // A stronger reading that agreed with an unsure first label settles it.
  const label = o.revised_label ?? (unsure && o.checked !== "confirmed" ? "unrelated" : o.label);
  return {
    runId: o.run_id, at: o.at, dueAt: o.due_at, label, text: label ? REPLY_LABELS[label] : "还没到判断的时候",
    first: o.label ? { label: o.label, confidence: o.confidence, by: o.by ?? "", at: o.labelled_at ?? "" } : null,
    revised: o.revised_label ? { label: o.revised_label, by: o.revised_by ?? "", why: o.revised_why ?? "", at: o.revised_at ?? "" } : null,
    checked: o.checked && o.checked_label ? { verdict: o.checked, label: o.checked_label, by: o.checked_by ?? "", why: o.checked_why ?? "", pick: o.checked_pick ?? "", at: o.checked_at ?? "" } : null,
    evidence: json<FollowUp[]>(o.evidence, []),
  };
}

/** The owner set this label themselves (a revision on the run page): nobody else changes it. */
export const ownerJudged = (o: Pick<Row, "by" | "revised_by">) => o.revised_by === OWNER_BY || o.by === OWNER_BY || o.by === "owner";

/**
 * A label the nightly second reading may look at again: one the decision model gave, or a host's
 * “没人接话” (more may have been said later). Never the owner's, nor one an emoji set (a reaction is
 * what someone said about it), nor one somebody already revised or the reading already saw.
 */
export const reviewable = (o: Pick<Row, "label" | "by" | "revised_label" | "revised_by" | "checked">) =>
  !!o.label && !o.revised_label && !o.checked && !ownerJudged(o) && (o.label === "silent" ? o.by === "宿主" : judged(o.label) && o.by !== "表情" && o.by !== "宿主");

export function replyOutcome(app: App, runId: string): ReplyOutcome | null {
  const o = one<Row>(app.db, "select * from reply_outcomes where run_id = ?", runId);
  return o ? view(app, o) : null;
}

/** The outcome as a few lines of text: for `read_run`, the replay judge and the coach. */
export function replyOutcomeText(o: ReplyOutcome): string {
  if (!o.label) return "这条回复发出后的后续还没到判断的时候。";
  const first = o.first ? `${REPLY_LABELS[o.first.label]}（${o.first.by}${o.first.confidence !== null ? `，把握 ${o.first.confidence.toFixed(2)}` : ""}）` : "";
  return [
    o.revised ? `按后续消息标的结果：${REPLY_LABELS[o.revised.label]}（${o.revised.by} 改判：${o.revised.why || "没写原因"}；原先标的是 ${first}）` : `按后续消息标的结果：${o.first && o.first.label !== o.label ? `${o.text}（${first}，把握不够）` : first}`,
    ...(o.checked?.verdict === "confirmed" ? [`夜里复查（${o.checked.by}）同意这个标注：${o.checked.why || "没写原因"}`] : []),
    ...(o.evidence.length ? ["依据的后续消息：", ...o.evidence.map((l) => `- ${l.who}：${l.text}`)] : []),
  ].join("\n");
}

/** A reviewer read the same follow-up and disagrees. The first label stays; the revision is what counts from now on. */
export function reviseReply(app: App, runId: string, label: string, by: string, why: string): ReplyOutcome {
  if (!judged(label)) throw new HttpError(400, `结果只能是 ${JUDGED_LABELS.join(" / ")}`);
  const cur = replyOutcome(app, runId);
  if (!cur) throw new HttpError(404, "这次运行没有记录到发出的回复，没有可改的结果");
  if (!cur.first) throw new HttpError(400, "这条回复还没到判断的时候，等第一次标注出来再改");
  if (by !== OWNER_BY && cur.revised?.by === OWNER_BY) throw new HttpError(409, "本人改判过这条，以本人的为准，不再改");
  if (cur.label !== label) run(app.db, "update reply_outcomes set revised_label = ?, revised_by = ?, revised_why = ?, revised_at = ? where run_id = ?", label, truncate(by, 80), truncate(why.trim(), 400), now(), runId);
  return replyOutcome(app, runId)!;
}

/** What the nightly second reading may answer: the judged labels, or that nobody said anything about it. */
export const CHECK_LABELS = [...JUDGED_LABELS, "silent"] as const;
export type CheckLabel = (typeof CHECK_LABELS)[number];

/**
 * The nightly second reading's answer for one reply (outcome-review.ts). The same label as the first
 * one is recorded as `confirmed` (an unsure first label then counts as it is); another one is a
 * revision like any other (revised_*) and `revised`. The first label stays either way.
 */
export function checkReply(app: App, runId: string, r: { label: string; by: string; why: string; pick?: string | null }): { verdict: "confirmed" | "revised"; outcome: ReplyOutcome } {
  if (!(CHECK_LABELS as readonly unknown[]).includes(r.label)) throw new HttpError(400, `结果只能是 ${CHECK_LABELS.join(" / ")}`);
  const o = one<Row>(app.db, "select * from reply_outcomes where run_id = ?", runId);
  if (!o) throw new HttpError(404, "这次运行没有记录到发出的回复");
  if (!o.label) throw new HttpError(400, "这条回复还没有第一遍的标注");
  if (o.checked) throw new HttpError(409, "这条已经复查过");
  if (o.revised_label) throw new HttpError(409, `这条已经被${o.revised_by ?? "别人"}改判过，以那次为准`);
  if (!reviewable(o)) throw new HttpError(409, "这条是本人标的或按表情记的，不复查");
  const by = truncate(r.by, 80), why = truncate(r.why.trim(), 400), at = now();
  const verdict = r.label === o.label ? "confirmed" : "revised";
  if (verdict === "confirmed")
    run(app.db, "update reply_outcomes set checked = 'confirmed', checked_label = ?, checked_by = ?, checked_why = ?, checked_pick = ?, checked_at = ? where run_id = ? and checked is null", r.label, by, why, r.pick ?? null, at, runId);
  else
    run(app.db, "update reply_outcomes set revised_label = ?, revised_by = ?, revised_why = ?, revised_at = ?, checked = 'revised', checked_label = ?, checked_by = ?, checked_why = ?, checked_pick = ?, checked_at = ? where run_id = ? and checked is null and revised_label is null",
      r.label, truncate(`夜里复查（${by}）`, 80), why, at, r.label, by, why, r.pick ?? null, at, runId);
  return { verdict, outcome: replyOutcome(app, runId)! };
}

export type ReplyCount = { judged: number; resolved: number; followup: number; corrected: number; taken_over: number; unclear: number };
/** How the bot's replies in one chat went lately, as one line for whoever reads that chat next ("" when there is nothing to say). */
export function replyLine(app: App, chatId: string, days = 30): string {
  const rows = all<Row>(app.db, "select * from reply_outcomes indexed by reply_outcomes_chat where chat_id = ? and at >= ? and label is not null", chatId, new Date(Date.now() - days * 86400_000).toISOString());
  const c: ReplyCount = { judged: 0, resolved: 0, followup: 0, corrected: 0, taken_over: 0, unclear: 0 };
  for (const o of rows) {
    const label = view(app, o).label!;
    c.judged++;
    if (label === "resolved" || label === "followup" || label === "corrected" || label === "taken_over") c[label]++;
    else c.unclear++;
  }
  if (!c.judged || c.judged === c.unclear) return "";
  return `${c.judged} 条里，解决了 ${c.resolved}、被追问 ${c.followup}、被纠正 ${c.corrected}、别人接手 ${c.taken_over}，其余看不出`;
}

/** Replies sent in a period, for the data page. */
export function replyOutcomes(app: App, from: string, to: string): ReplyOutcome[] {
  return all<Row>(app.db, "select * from reply_outcomes indexed by reply_outcomes_at where at >= ? and at < ?", from, to).map((o) => view(app, o));
}
