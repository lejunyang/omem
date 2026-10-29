import type { App } from "../core/app.ts";
import { all, one } from "../core/db.ts";
import { truncate } from "../core/util.ts";
import { negativeReactions, positiveReactionCount } from "../channels/lark-feedback.ts";

/**
 * Shortcomings visible in daily use, collected without a model: runs that failed, answers that
 * found nothing, the owner correcting an answer, memory writes the checks or the reviewer threw
 * out, memories passive recall offered but nobody used, and negative emoji reactions on what the
 * bots sent in Feishu (src/channels/lark-feedback.ts). The dreamer reads them each night and
 * fills what it can (a missing fact, an experience, a case page); the Memory page lists them.
 * Signals are hints, not verdicts: "没找到" can be a correct answer.
 */
export type Shortcomings = {
  since: string;
  failedRuns: { kind: string; n: number; lastError: string; lastRunId: string }[];
  notFound: { messageId: string; conversationId: string; question: string; answer: string; at: string }[];
  corrections: { messageId: string; conversationId: string; said: string; answer: string; at: string }[];
  rejectedWrites: { n: number; codes: Record<string, number>; examples: string[] };
  retracted: { id: string; content: string; note: string }[];
  passive: { shown: number; used: number };
  /** Negative reactions on bot messages (the owner's first), and how many positive ones there were. */
  reactions: { negative: ReturnType<typeof negativeReactions>; positive: number };
};

/** An answer saying it could not find what was asked. */
export const NOT_FOUND = /没(有)?(找到|查到|搜到)|找不到|查不到|没有(相关|这方面)的?(记录|资料|信息|内容|原件)|知识库里没有|记忆里没有/;
/** The owner pushing back on the previous answer (opening words only). */
export const CORRECTION = /^\s*(不对|错了|不是这样|不是的|你(搞|弄|记|说)错|搞错了|记错了|说错了|不准确|不是这个)/;

export function shortcomings(app: App, opts: { since?: string; limit?: number } = {}): Shortcomings {
  const since = opts.since ?? new Date(Date.now() - 7 * 86400_000).toISOString();
  const limit = opts.limit ?? 12;
  const failedRuns = all<{ kind: string; n: number; error: string | null; id: string }>(
    app.db,
    `select kind, count(*) n, (select error from runs r2 where r2.kind = r.kind and r2.status = 'failed' and r2.created_at > ? order by created_at desc limit 1) error,
            (select id from runs r2 where r2.kind = r.kind and r2.status = 'failed' and r2.created_at > ? order by created_at desc limit 1) id
       from runs r where status = 'failed' and created_at > ? group by kind order by n desc limit ?`,
    since, since, since, limit,
  ).map((r) => ({ kind: r.kind, n: r.n, lastError: truncate(r.error ?? "", 200), lastRunId: r.id }));

  // Pairs of (owner message, the assistant's next reply) and (assistant reply, the owner's next message).
  const assistant = all<{ id: string; conversation_id: string; text: string; created_at: string }>(
    app.db,
    "select id, conversation_id, text, created_at from messages where role = 'assistant' and created_at > ? order by created_at desc limit 400",
    since,
  );
  const notFound: Shortcomings["notFound"] = [];
  for (const m of assistant) {
    if (notFound.length >= limit) break;
    if (!NOT_FOUND.test(m.text.slice(0, 600))) continue;
    const q = one<{ text: string }>(app.db, "select text from messages where conversation_id = ? and role = 'user' and created_at <= ? order by created_at desc limit 1", m.conversation_id, m.created_at);
    if (!q) continue;
    notFound.push({ messageId: m.id, conversationId: m.conversation_id, question: truncate(q.text.replace(/\s+/g, " "), 200), answer: truncate(m.text.replace(/\s+/g, " "), 200), at: m.created_at });
  }
  const owner = all<{ id: string; conversation_id: string; text: string; created_at: string }>(
    app.db,
    "select id, conversation_id, text, created_at from messages where role = 'user' and created_at > ? and json_extract(meta, '$.command') is null order by created_at desc limit 400",
    since,
  );
  const corrections: Shortcomings["corrections"] = [];
  for (const m of owner) {
    if (corrections.length >= limit) break;
    if (!CORRECTION.test(m.text)) continue;
    const a = one<{ text: string }>(app.db, "select text from messages where conversation_id = ? and role = 'assistant' and created_at <= ? order by created_at desc limit 1", m.conversation_id, m.created_at);
    if (!a) continue;
    corrections.push({ messageId: m.id, conversationId: m.conversation_id, said: truncate(m.text.replace(/\s+/g, " "), 200), answer: truncate(a.text.replace(/\s+/g, " "), 200), at: m.created_at });
  }

  const rejected = all<{ content: string; codes: string }>(app.db, "select content, codes from memory_rejections where shadow = 0 and at > ? order by at desc limit 200", since);
  const codes: Record<string, number> = {};
  for (const r of rejected) for (const c of JSON.parse(r.codes) as string[]) codes[c] = (codes[c] ?? 0) + 1;
  const retracted = all<{ id: string; content: string; review_note: string | null }>(
    app.db,
    "select id, content, review_note from memories where review_verdict = 'retract' and reviewed_at > ? order by reviewed_at desc limit ?",
    since,
    limit,
  ).map((r) => ({ id: r.id, content: truncate(r.content, 120), note: truncate(r.review_note ?? "", 120) }));
  const passive = one<{ shown: number; used: number }>(app.db, "select count(*) shown, coalesce(sum(used), 0) used from memory_recalls where via = 'passive' and at > ?", since)!;
  return {
    since,
    failedRuns,
    notFound,
    corrections,
    rejectedWrites: { n: rejected.length, codes, examples: rejected.slice(0, 3).map((r) => truncate(r.content, 100)) },
    retracted,
    passive,
    reactions: { negative: negativeReactions(app, since, limit), positive: positiveReactionCount(app, since) },
  };
}

export function hasShortcomings(s: Shortcomings) {
  return !!(s.failedRuns.length || s.notFound.length || s.corrections.length || s.rejectedWrites.n || s.retracted.length || s.reactions.negative.length);
}

/** The section of the dreamer's task. */
export function shortcomingsText(s: Shortcomings) {
  const parts = [
    s.notFound.length ? `回答说没找到（缺的知识，或检索没找对地方）：\n${s.notFound.map((x) => `- msg:${x.messageId} 问「${x.question}」→ 答「${x.answer}」`).join("\n")}` : "",
    s.reactions.negative.length
      ? `飞书里对回答加了负面表情（${s.reactions.positive} 个正面表情作对照）：\n${s.reactions.negative.map((x) => `- ${x.runId ? `运行 ${x.runId}` : `消息 ${x.messageId}`} ${x.actorKind === "owner" ? "本人" : x.actorKind === "member" ? "其他用户" : "访客"}加了 ${x.emoji}${x.answer ? `；回答「${x.answer}」` : ""}`).join("\n")}`
      : "",
    s.corrections.length ? `本人纠正了回答：\n${s.corrections.map((x) => `- msg:${x.messageId} 本人说「${x.said}」；之前答「${x.answer}」`).join("\n")}` : "",
    s.failedRuns.length ? `失败的运行：\n${s.failedRuns.map((x) => `- ${x.kind} ${x.n} 次，最近 ${x.lastRunId}：${x.lastError}`).join("\n")}` : "",
    s.retracted.length ? `复核撤回的记忆：\n${s.retracted.map((x) => `- ${x.id}「${x.content}」${x.note ? `：${x.note}` : ""}`).join("\n")}` : "",
    s.rejectedWrites.n ? `被写入检查拦下的记忆 ${s.rejectedWrites.n} 条（${Object.entries(s.rejectedWrites.codes).map(([k, v]) => `${k} ${v}`).join("，")}）` : "",
    s.passive.shown ? `被动召回附上 ${s.passive.shown} 次，回答用到 ${s.passive.used} 次` : "",
  ].filter(Boolean);
  return parts.join("\n\n");
}
