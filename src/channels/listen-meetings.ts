import type { App } from "../core/app.ts";
import { run } from "../core/db.ts";
import { json, newId, now, truncate } from "../core/util.ts";
import { addMessage, findThread } from "../agents/threads.ts";
import type { RuleAction } from "../rules/types.ts";
import type { MeetingPlan } from "./lark-meetings.ts";
import type { CardBlock, CardSpec } from "./lark-send.ts";
import { playbookOf } from "./listen-cases.ts";
import { contextsOfChat, defaultContext, getContext, noteInContext, saveContext, type ListenContext } from "./listen.ts";
import { briefText, ownerCard } from "./watch-trial.ts";

/**
 * Meetings as part of 「关注」 (knob `meetings`). A place or item 关注 cares about meetings started in
 * one of its groups, the default one (“someone looks for you”) about meetings the owner joins. After the
 * rules have looked at a meeting (lark-meetings.ts) and none took it, the most specific 关注 that cares
 * (item, place, default) either asks the owner on a card only they see (`ask`: 进会旁听 / 这次不用 /
 * 这个会以后不用问) or goes in (`listen`). Going in is the same bot join and listening a meeting rule
 * plans, with the 关注's brief, lessons and conversation in the listening agent's task; what it notes and
 * the summary afterwards also go into the 关注's conversation. Each answer is a case (source `meeting`).
 * One 关注 per meeting (lark_meetings.context_id); a topic the owner said not to ask about is left alone.
 */

/** The parts of a lark_meetings row read here. */
type MeetingRow = {
  meeting_id: string;
  meeting_no: string | null;
  topic: string;
  status: string;
  plan: string | null;
  chat_id: string | null;
  chat_name: string | null;
  started_by: string | null;
  owner_in: number;
  ended_at: string | null;
  context_id?: string | null;
};
export type ListenMeetingCard = { meetingId: string; contextId: string };
/** On a listening run's input: the 关注 whose conversation gets what it noted (agents/jobs.ts). */
export type ListenMeetingRun = { contextId: string; meetingId: string; topic: string; final?: boolean };

const log = (text: string) => console.log(`[omem] 关注 · 会议：${text}`);
const topicOf = (row: Pick<MeetingRow, "topic">) => row.topic.trim();
const KIND_LABEL: Record<ListenContext["kind"], string> = { place: "看着几个群", item: "跟着一件事项和它的群", situation: "情境", default: "有人找你，以及本人加入的会议" };

/**
 * Whether the default 关注 looks at the owner's meetings: Feishu and its bot are set up, the owner's
 * Feishu is read (lark-cli), 有人找你 is on, and its meetings knob is not off. The meeting event stream
 * runs while this holds, rules or not (lark-meetings.ts tickMeetings).
 */
export function ownerMeetingsWanted(app: App) {
  const l = app.config.lark;
  if (!l.enabled || !l.appId || l.capture.mode === "off" || !app.config.mentions.enabled) return false;
  const c = defaultContext(app);
  return c.status === "active" && c.knobs.meetings !== "off";
}

/** Whether a 关注 on this group looks at meetings started there. */
export function groupMeetingWanted(app: App, chatId: string) {
  return contextsOfChat(app, chatId).some((c) => c.knobs.meetings !== "off");
}

/** The 关注 a meeting belongs to: the most specific one that has not turned meetings off. */
function contextFor(app: App, row: MeetingRow): ListenContext | null {
  const mine = row.chat_id ? contextsOfChat(app, row.chat_id) : [];
  if (row.owner_in && ownerMeetingsWanted(app)) mine.push(defaultContext(app));
  return mine.find((c) => c.knobs.meetings !== "off") ?? null;
}

/**
 * After the rules looked at a meeting: the 关注 that cares asks the owner or goes in. Once per meeting,
 * never for one a rule took (it has a plan) or one that is over. Returns what happened, or null.
 */
export async function considerMeeting(app: App, meetingId: string): Promise<string | null> {
  const lm = await import("./lark-meetings.ts");
  const row = lm.meetingRow(app, meetingId) as MeetingRow | undefined;
  if (!row || row.plan || row.context_id || row.ended_at || row.status !== "seen") return null;
  const c = contextFor(app, row);
  if (!c) return null;
  const topic = topicOf(row);
  if ((c.knobs.meetingSkip ?? []).includes(topic)) {
    log(`「${topic || "无标题"}」（${meetingId}）：关注「${c.name}」说过这个会不用问`);
    return null;
  }
  if (!row.meeting_no) return null;
  // One 关注 per meeting: the owner joining a group's meeting later finds it taken.
  if (run(app.db, "update lark_meetings set context_id = ? where meeting_id = ? and context_id is null and plan is null", c.id, meetingId).changes !== 1) return null;
  if (c.knobs.meetings === "listen") {
    const detail = await joinFor(app, c, row);
    if (detail === null) return null;
    meetingCase(app, c, row, "auto");
    noteInContext(app, c, `（直接进会旁听会议「${topic || "无标题"}」：${detail}）`);
    log(`关注「${c.name}」直接进会「${topic}」（${meetingId}）：${detail}`);
    return detail;
  }
  const { buildCard } = await import("./lark-send.ts");
  try {
    await ownerCard(app, row.chat_id, buildCard(cardSpec(c, row)), "listen-meeting", { meetingId, contextId: c.id } satisfies ListenMeetingCard, c.conversationId);
  } catch (e) {
    run(app.db, "update lark_meetings set context_id = null where meeting_id = ? and context_id = ?", meetingId, c.id);
    throw e;
  }
  log(`关注「${c.name}」问你要不要进会「${topic}」（${meetingId}）`);
  return "已发卡片问本人";
}

/** The card asking the owner; once answered, the same facts with what was decided (`decided`). */
function cardSpec(c: ListenContext, row: MeetingRow, decided?: { color: string; blocks: CardBlock[] }): CardSpec {
  const topic = topicOf(row) || "无标题";
  const away = row.owner_in === 0;
  const blocks: CardBlock[] = [
    {
      fields: [
        { label: "会议", value: topic },
        { label: "会议号", value: row.meeting_no ?? "—" },
        { label: "关注", value: c.name },
        ...(row.chat_name ? [{ label: "发起", value: `${row.started_by || "有人"}在「${row.chat_name}」` }] : []),
      ],
    },
  ];
  if (decided) return { title: `会议「${topic}」`, color: decided.color, blocks: [...blocks, ...decided.blocks] };
  blocks.push({ markdown: away ? "你不在会上。我进去替你听，按这个关注的说明记下有关的事，会后把纪要发给你。" : "我进去旁听，会上不打扰你，记下和你、和这个关注有关的事，会后把纪要发给你。" });
  blocks.push({ buttons: [{ text: "进会旁听", value: "join", style: "primary" }, { text: "这次不用", value: "skip" }, { text: "这个会以后不用问", value: "never" }] });
  blocks.push({ note: "只有你能看到这张卡片。机器人入会后所有参会人都能看到它；会议要打开「AI 纪要」并允许智能体加入。" });
  return { title: row.chat_name ? `「${row.chat_name}」在开会，要我进去听吗？` : `会议「${topic}」，要我进去旁听吗？`, color: "blue", blocks };
}

/** The owner answered the card (lark-actions.ts). Returns the card to show instead. */
export async function decideListenMeeting(app: App, p: ListenMeetingCard, act: string, by: string) {
  const { buildCard, decidedBlocks } = await import("./lark-send.ts");
  const lm = await import("./lark-meetings.ts");
  const row = lm.findMeetingRow(app, p.meetingId) as MeetingRow | undefined;
  const c = getContext(app, p.contextId);
  if (!row || !c) return buildCard({ title: "这张卡片过期了", color: "grey", blocks: decidedBlocks({ verdict: row ? "已经不关注了" : "没有这场会议的记录", by, at: now(), timeZone: app.config.timezone }) });
  const shown = (verdict: string, color: string, result?: string) => buildCard(cardSpec(c, row, { color, blocks: decidedBlocks({ verdict, by, at: now(), timeZone: app.config.timezone, result, plain: true }) }));
  const topic = topicOf(row);
  const name = topic || "无标题";
  if (act === "never") {
    // Later meetings of this topic in this 关注 are left alone (contextFor still picks this 关注 first).
    saveContext(app, { id: c.id, kind: c.kind, knobs: { meetingSkip: [...new Set([...(c.knobs.meetingSkip ?? []), topic])].slice(-50) } });
    meetingCase(app, c, row, "dropped", "never");
    noteInContext(app, c, `（本人说会议「${name}」以后不用问）`);
    return shown("这个会以后不用问", "grey");
  }
  if (act !== "join") {
    meetingCase(app, c, row, "dropped", "not-this-time");
    noteInContext(app, c, `（本人说会议「${name}」这次不用进去听）`);
    return shown("这次不用", "grey");
  }
  if (row.status === "ended" || row.ended_at) return shown("会议已经结束", "grey");
  const taken = row.plan ? json<MeetingPlan | null>(row.plan, null) : null;
  if (taken) return shown(`这场会议已经由${taken.contextId ? taken.ruleName : `规则「${taken.ruleName}」`}处理`, "grey");
  const detail = await joinFor(app, c, row);
  if (detail === null) return shown("这场会议已经有别的处理", "grey");
  meetingCase(app, c, row, "sent");
  noteInContext(app, c, `（本人让我进会旁听会议「${name}」：${detail}）`);
  return shown("进会旁听", "green", detail);
}

/** Bring the main bot in and listen, the way a meeting rule's plan does, for this 关注. Null when something else took the meeting. */
async function joinFor(app: App, c: ListenContext, row: MeetingRow): Promise<string | null> {
  const { actionSchema } = await import("../rules/types.ts");
  const lm = await import("./lark-meetings.ts");
  const base = actionSchema.parse({ type: "meeting-bot", bots: ["main"], confirm: false, record: true, spec: c.spec || "assistant" }) as Extract<RuleAction, { type: "meeting-bot" }>;
  const space = c.spaceId ?? (c.conversationId ? findThread(app, c.conversationId)?.spaceId : undefined);
  const plan: MeetingPlan = {
    ...base,
    confirm: false,
    ...(space ? { space } : {}),
    // What the decision model's pre-screening of a stretch weighs it against (lark-meetings.ts prefilter).
    task: [c.note ?? "", c.brief?.handle.length ? `要处理：${c.brief.handle.join("；")}` : ""].filter(Boolean).join("\n"),
    ruleId: `listen:${c.id}`,
    ruleName: `关注「${c.name}」`,
    ruleDescription: `替本人关注「${c.name}」：会上和它有关的事记下来，会后写纪要`,
    contextId: c.id,
  };
  return lm.startListenPlan(app, row.meeting_id, plan);
}

/** A decision about a meeting, as a case of the 关注 (reply_samples, source `meeting`; settled at once, nothing to watch for). */
function meetingCase(app: App, c: ListenContext, row: MeetingRow, decision: "sent" | "auto" | "dropped", reason: "not-this-time" | "never" | null = null) {
  const at = now();
  const ask = `会议「${topicOf(row) || "无标题"}」${row.chat_name ? `，在群「${row.chat_name}」` : "，本人加入的"}`;
  run(
    app.db,
    `insert into reply_samples(id,channel,chat_id,chat_kind,chat_name,asker_name,ask,last_ms,decision,reason,decided_at,settled_at,created_at,context_id,source)
     values(?,'lark',?,'meeting',?,?,?,?,?,?,?,?,?,?,'meeting')`,
    newId("rs"), row.chat_id ?? row.meeting_id, row.chat_name ?? "", row.started_by ?? "", ask, Date.now(), decision, reason, at, at, at, c.id,
  );
}

/** The 关注's part of the listening agent's task (lark-meetings.ts startAgent): its name, what the owner wants, brief, lessons and conversation. */
export function listenMeetingHead(app: App, contextId: string, ownerAway: boolean): string[] {
  const c = getContext(app, contextId);
  if (!c) return [];
  const summary = c.conversationId ? (findThread(app, c.conversationId)?.summary ?? "").trim() : "";
  const playbook = playbookOf(app, c, 3000);
  const brief = briefText(c);
  return [
    `你在替本人关注「${c.name}」（${KIND_LABEL[c.kind]}）。这场会${c.kind === "default" ? "是本人加入的" : "是在这个关注的群里开的"}${ownerAway ? "，本人不在会上" : ""}。`,
    c.note ? `本人要这个关注做的：${c.note}` : "",
    brief ? `\n${brief}` : "",
    playbook ? `\n# 这个关注的经验\n\n${playbook}` : "",
    summary ? `\n# 关注的群最近在聊的（会话摘要）\n\n${truncate(summary, 4000)}` : "",
    "\n会上什么值得记，按关注说明里的“要处理”“不处理”来；和这个关注、和本人都无关的讨论不记。",
  ].filter(Boolean);
}

/** What a listening run for a 关注 noted (a window that did not stay quiet, or the summary): into the 关注's conversation. */
export function noteMeetingRun(app: App, x: ListenMeetingRun, runId: string, answer: string) {
  const text = answer.trim();
  if (!text || text === "（没有输出）") return false;
  const c = getContext(app, x.contextId);
  if (!c?.conversationId || !findThread(app, c.conversationId)) return false;
  const topic = x.topic || "无标题";
  addMessage(app, c.conversationId, "user", `${x.final ? `（会议「${topic}」结束后的纪要）` : `（旁听会议「${topic}」时记下的）`}\n${truncate(text, 6000)}`, null, {
    speaker: `会议「${topic}」`,
    meeting: x.meetingId,
    meetingRun: runId,
    ...(x.final ? { final: true } : {}),
  });
  return true;
}
