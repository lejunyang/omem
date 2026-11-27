import type { App } from "../core/app.ts";
import { createRun, getRun, setRunOutput, type Run } from "../agents/runs.ts";
import { noteHandling as noteLedger } from "../core/handling.ts";
import { notify } from "../core/notify.ts";
import { OWNER } from "../core/users.ts";
import { truncate } from "../core/util.ts";
import type { FirstLookInput, LookMessage, Outcome } from "../rules/first-look.ts";
import { evidenceLines } from "../rules/first-look-material.ts";
import { probesText, type ProbeResult } from "../rules/probes.ts";
import { mentionChannel, type MentionChannel, type MentionMessage } from "./channel.ts";
import { mentionInfo, replyMode, startHandling, type MentionRunInput } from "./mentions.ts";
import { noteHandling as noteSample } from "./reply-learn.ts";
import { localTime, type Triage } from "./triage.ts";

/**
 * 帮你回复 for 有人找你 (setting `mentions.firstLook`, docs/v2/first-look.md “有人找你”): after the triage
 * chose a handling, the fast first look (rules/first-look.ts, a run of kind first-look) goes first. It
 * reads what the triage gathered and answers within its budget:
 *
 * - answered: the reminder, the reply drafted under it (the 有人找你 draft card, mention-reply.ts) when the
 *   owner lets omem answer the asker, else written into the reminder. Never sent by itself, `auto` or not;
 * - owner: a reminder with what is the owner's to decide;
 * - quiet: nothing, the handling ledger says why;
 * - escalate, a time-out or nothing handed in: the handling the triage chose, as before, with what this
 *   look found in its task.
 *
 * The run carries `mention` as a handling does, so the draft card, its 发送 and what the owner does with
 * it (reply-learn.ts) work on it the same way.
 */
export type MentionLook = { input: MentionRunInput; triage: Triage; from: { id: string; spaceId: string | null } };

/** What of the triage's material the fast look reads with the brief (the talk around is its discussion). */
const BRIEF_PARTS = ["发送人", "本人的分诊说明", "本人给这个会话设的规则", "可能相关的在办事项", "相关的记忆和页面", "本人以往回不回", "相近的案例", "有人找你的经验", "本人说过不用提醒的"];

const whereOf = (input: Pick<MentionRunInput, "chatKind" | "chatName">, sender: string) => (input.chatKind === "p2p" ? `和 ${sender} 的私聊` : `群「${input.chatName}」`);
const handlerName = (t: Triage) => (t.handler === "assistant" ? "主助手" : t.handler);

/** Queue the fast look in place of the handling (mentions.ts, after the triage said handle). */
export function queueMentionLook(app: App, channel: MentionChannel, from: { id: string; spaceId: string | null }, input: MentionRunInput, open: MentionMessage[], t: Triage, material: Record<string, string>): Run {
  const last = open[open.length - 1];
  const reply = replyMode(app, channel, input.chatKind) === "off" ? "off" : "draft";
  const brief = [
    `${channel.label}上${whereOf(input, last.sender)}里有人找本人，本人还没看。${t.what ? `分诊看来：${t.what}。` : ""}`,
    `先看能不能直接答：答得了交 answered，text 就是拟给对方的回复（${reply === "off" ? "本人没开回复对方，它写进给本人的提醒" : "附在给本人的提醒下面，本人看过再发"}），照下面本人以往的样子写；要读代码、查日志、问人或多步排查的交 escalate，由${handlerName(t)}接着查；要本人拍板的交 owner；对方不用回、本人也不用知道的交 quiet。`,
    ...BRIEF_PARTS.filter((k) => material[k]).map((k) => `### ${k}\n\n${truncate(material[k], 1500)}`),
  ].join("\n\n");
  const look: FirstLookInput = {
    source: "mention",
    userId: OWNER,
    chat: { id: input.chatId, name: input.chatKind === "p2p" ? last.sender : input.chatName, kind: input.chatKind },
    messages: open.map((m): LookMessage => ({ id: m.id, text: m.text, sender: m.sender, topicId: m.topicId, at: new Date(m.atMs).toISOString() })),
    brief,
    probes: [],
    to: "dm",
    direct: false,
    ...(material["前后的聊天"] ? { discussion: material["前后的聊天"] } : {}),
    // As the handling: every space the owner can read.
    spaces: null,
    mention: mentionInfo(channel, input, open, reply, t.urgency, t.what, from.id),
    mentionLook: { input, triage: t, from },
  };
  const r = createRun(app, {
    kind: "first-look",
    spaceId: from.spaceId ?? channel.spaceOf(app, input.chatId, open[0].id),
    title: truncate(`帮你回复（有人找你）：${last.sender}：${last.text.replace(/\s+/g, " ")}`, 80),
    input: look,
    lane: `firstlook:mention:${input.chatId}#${input.topicId ?? ""}`,
    userId: OWNER,
  });
  // What the owner does with its draft is learnt as with a handling's (reply-learn.ts); a handling it hands on to takes the sample over.
  noteSample(app, from.id, r.id, t.what);
  return r;
}

function lookedText(o: Outcome, results: ProbeResult[]) {
  return [
    "# 帮你回复已经看过的（快模型几步内看的，要核对，不要照抄）",
    "",
    o.by === "model"
      ? `已经知道的：${o.text || "（没写）"}${o.evidence ? `\n依据：${o.evidence}` : ""}\n还要查：${o.next || "（没写）"}${o.reason ? `\n为什么还要查：${o.reason}` : ""}`
      : `帮你回复没有结论：${o.reason ?? "快模型没有交"}`,
    results.length ? `\n预查结果：\n${probesText(results, 2500)}` : "",
  ].filter(Boolean).join("\n");
}

/** The look ended (firstLookRun): tell the owner, say nothing, or hand on to the handling. */
export async function settleMentionLook(app: App, r: Run, input: FirstLookInput, messages: LookMessage[], o: Outcome, results: ProbeResult[]): Promise<{ to: "dm" | "none"; why: string[]; deep?: { runId: string; detail: string } }> {
  const m = input.mention!;
  const ml = input.mentionLook!;
  // As the short reminder says it (mentions.ts shortReminder).
  const where = ml.input.chatKind === "p2p" ? "私聊" : `在「${ml.input.chatName}」`;
  if (o.outcome === "quiet") {
    for (const x of messages) noteLedger(app, { event: x.id, actor: "mention", decision: "ignored", runId: r.id, reason: `帮你回复：不用告诉本人${o.text ? `（${truncate(o.text, 120)}）` : ""}` });
    return { to: "none", why: ["帮你回复认为对方不用回、本人也不用知道，没有提醒"] };
  }
  if (o.outcome === "escalate") {
    const channel = mentionChannel(m.channel);
    const open = channel.messages(app, ml.input.messageIds);
    if (!open.length) return { to: "none", why: ["消息已经不在了，没有接着查"] };
    const material = getRun(app, ml.from.id).output.material as Record<string, string> | undefined;
    const h = startHandling(app, channel, ml.from, ml.input, open, ml.triage, null, material, undefined, lookedText(o, results));
    setRunOutput(app, ml.from.id, { handleRun: h.id });
    return { to: "none", why: ["答不完：交给处理者接着查，查完再提醒"], deep: { runId: h.id, detail: `交给${handlerName(ml.triage)}接着查（${h.id}）` } };
  }
  // answered / owner: the reminder; an answer with the reply drafted under it.
  const what = ml.triage.what ? `：${truncate(ml.triage.what, 40)}` : "";
  const draft = o.outcome === "answered" && m.reply !== "off" ? o.text.trim() : "";
  const body = [
    messages.map((x) => `**${x.sender}**（${localTime(app, Date.parse(x.at))}）：${truncate(x.text.replace(/\s+/g, " "), 300)}`).join("\n"),
    o.outcome === "owner" ? `**要你定**：${o.text}` : draft ? "" : `**可以这样回**：\n${o.text}`,
    o.evidence ? `**背景和依据**\n${truncate(evidenceLines(o.evidence), 1500)}` : "",
    m.refs.length ? `[原消息](${m.refs.at(-1)})` : "",
  ].filter(Boolean).join("\n\n");
  try {
    notify(app, {
      title: o.outcome === "owner" ? `${m.senderName} ${where}找你，要你定${what}` : `${m.senderName} ${where}找你${what}`,
      body,
      sourceRefs: m.refs,
      runId: r.id,
      link: `#/runs/${r.id}`,
      urgency: m.urgency,
      agentInitiated: true,
      ...(draft ? { replyDraft: draft } : {}),
    });
  } catch (e) {
    return { to: "none", why: [`提醒没有发出：${truncate((e as Error).message, 120)}`] };
  }
  for (const x of messages) noteLedger(app, { event: x.id, actor: "mention", decision: o.outcome === "owner" ? "handed" : "drafted", runId: r.id, reason: o.outcome === "owner" ? "帮你回复：要本人定" : `帮你回复给本人看了${draft ? "，附了拟好的回复" : ""}` });
  return { to: "dm", why: draft || o.outcome === "owner" ? [] : ["本人没开回复对方，回复写在提醒里"] };
}
