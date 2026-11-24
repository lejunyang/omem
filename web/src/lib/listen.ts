/**
 * 「关注」on the web (server: src/channels/listen.ts, listen-http.ts): the shapes the API returns and
 * the words for its knobs, cases and handling, shared by the settings list, the detail page and rules.
 */
export type ListenKind = "place" | "item" | "default" | "situation";
export type ListenKnobs = {
  listen: "addressed" | "relevant" | "all";
  pattern?: string;
  depth: "answer" | "investigate";
  reply: "none" | "draft" | "auto";
  wantsAuto?: boolean;
  promoteAfter: number;
  ownerAsks: "notify" | "draft" | "answer";
  othersAsks: "leave" | "handle";
  backlog: "off" | "24h" | "72h";
  strictness?: number;
  perDay: number;
  meetings: "off" | "ask" | "listen";
  /** Stored by the server, nothing uses it yet: not shown. */
  seeOthers?: boolean;
  assist?: "off" | "suggest" | "act";
  batchMinutes: number;
  prefilter?: boolean;
  /** 快速通道 (docs/v2/first-look.md): look first with a fast model, the probes before it, where its first message goes. */
  firstLook?: boolean;
  probes?: string[];
  firstTo?: "chat" | "dm" | "ephemeral";
};
export type ListenBrief = { handle: string[]; skip: string[]; valid: string; at?: string; confirmedAt?: string };
export type ListenView = {
  id: string;
  kind: ListenKind;
  name: string;
  chats: string[];
  groups: { id: string; name: string }[];
  itemId: string | null;
  /** A matter's 关注: its line, and whether the line launched and is being watched (phase `watching`). */
  item: { id: string; title: string; status: string; phase?: "watching" | null; watchUntil?: string | null } | null;
  /** A matter's 关注: groups the owner added beyond its items' / took out of them. */
  added?: string[];
  dropped?: string[];
  spec: string;
  spaceId: string | null;
  conversationId: string | null;
  note?: string;
  /** A 情境: how it is recognized (one sentence the host compiles into the rule `ruleId`). */
  recognize?: string;
  ruleId?: string;
  brief?: ListenBrief;
  knobs: ListenKnobs;
  status: "active" | "paused";
  since: string;
  playbookAt?: string;
  expiresAt: string | null;
  summaryAt?: string | null;
  stats: { cases: number; corrections: number; ownReplies: number; lastCase: string | null };
};
export type Verdict = "should-reply" | "should-not" | "wrong";
export type ListenCase = {
  id: string;
  context_id: string | null;
  source: string;
  chat_id: string;
  chat_name: string;
  chat_kind: string;
  asker_name: string;
  ask: string;
  draft: string | null;
  decision: string | null;
  final: string | null;
  reason: string | null;
  owner_reply: string | null;
  verdict: Verdict | null;
  note: string | null;
  scene: string | null;
  checked: string | null;
  handle_run: string | null;
  created_at: string;
  decided_at: string | null;
  settled_at: string | null;
};
export type ListenMemory = { id: string; kind: string; subject: string | null; content: string; created_at: string };
export type ListenHandling = { id: string; status: string; title: string; at: string; outcome: "handled" | "quiet" | "screened"; reason: string | null };
export type ListenDetail = {
  context: ListenView;
  summary: string;
  playbook: { text: string; path: string; sourceId: string | null; updatedAt: string | null };
  cases: ListenCase[];
  memories: ListenMemory[];
  handling: ListenHandling[];
  coaching: { id: string; status: string } | null;
};
export type ChatDetail = { chat: { id: string; name: string }; contexts: ListenView[]; paused: ListenView[]; cases: ListenCase[]; memories: ListenMemory[] };

export const KIND_LABEL: Record<ListenKind, string> = { place: "群", item: "事情", default: "默认", situation: "情境" };

/**
 * One time a 情境 happened (src/situations/instances.ts): its own item and conversation, a window that a new
 * signal pushes on, what it stands at now, and a summary once it ended.
 */
export type SituationInstance = {
  id: string; contextId: string; itemId: string; conversationId: string; spaceId: string; title: string;
  status: "active" | "ended"; startedAt: string; windowUntil: string; current: string; summary: string | null;
  endedAt: string | null; closingRun: string | null; closingDeadline: string | null;
};
/** What a 情境 is, against a rule and a flow: for the empty states and the new-situation dialog. */
export const SITUATION_WHAT = "情境是一类会反复发生的事，比如项目 A 的例行演练：每发生一次是一回，各回有自己的对象、时间窗口和事项，但共用你写的说明和攒下的经验。";
export const SITUATION_VERSUS = "和规则不同，它不是“遇到 X 就做 Y”的一步，而是整段跟下来：认出开始的信号后开一回，窗口里有新动静就接着看，需要你知道时私下告诉你，结束时写小结、攒经验。和流程不同，它不规定阶段和步骤，只写你在意什么，怎么查由处理者按技能判断。";

/*
 * The knobs in the owner's words: each option says what happens, and each knob has one line on what it
 * does in practice (KNOB). The facts behind them: src/channels/lark-watch.ts (batches, the 30 seconds for
 * an @, the prefilter and its threshold, the daily limit), src/agents/sessions.ts watchedNote (how the
 * handler reads the others). The assistant changes the same settings with set_chat_watch.
 */
type Opt<V> = { value: V; label: string; title?: string };
export const REPLY_OPTIONS: Opt<ListenKnobs["reply"]>[] = [
  { value: "none", label: "不回，只看" },
  { value: "draft", label: "先给我看" },
  { value: "auto", label: "直接回" },
];
export const LISTEN_OPTIONS: Opt<ListenKnobs["listen"]>[] = [
  { value: "addressed", label: "只看 @ 我或机器人的" },
  { value: "relevant", label: "挑和说明有关的" },
  { value: "all", label: "每批都看" },
];
export const DEPTH_OPTIONS: Opt<ListenKnobs["depth"]>[] = [
  { value: "answer", label: "能直接答的才答" },
  { value: "investigate", label: "值得查的就去查" },
];
export const OWNER_ASKS_OPTIONS: Opt<ListenKnobs["ownerAsks"]>[] = [
  { value: "notify", label: "只私下告诉我" },
  { value: "draft", label: "拟一条给我看" },
  { value: "answer", label: "可以替我答" },
];
export const OTHERS_ASKS_OPTIONS: Opt<ListenKnobs["othersAsks"]>[] = [
  { value: "leave", label: "不管" },
  { value: "handle", label: "能帮上就处理" },
];
export const BACKLOG_OPTIONS: Opt<ListenKnobs["backlog"]>[] = [
  { value: "off", label: "不管" },
  { value: "24h", label: "最近一天的" },
  { value: "72h", label: "最近三天的" },
];
export const ASSIST_OPTIONS: { value: "off" | "suggest" | "act"; label: string }[] = [
  { value: "off", label: "不主动" },
  { value: "suggest", label: "每天提几条下一步" },
  { value: "act", label: "只读的事先做" },
];
export const MEETING_OPTIONS: Opt<ListenKnobs["meetings"]>[] = [
  { value: "off", label: "不管" },
  { value: "ask", label: "问我要不要进会" },
  { value: "listen", label: "直接进会旁听" },
];
export const STRICTNESS_OPTIONS: { value: number | null; label: string }[] = [
  { value: null, label: "按决策设置的默认" },
  { value: 0.5, label: "0.5 · 宁可多看" },
  { value: 0.6, label: "0.6" },
  { value: 0.7, label: "0.7" },
  { value: 0.8, label: "0.8" },
  { value: 0.9, label: "0.9" },
  { value: 0.95, label: "0.95 · 尽量少打扰" },
];
export const PREFILTER_OPTIONS: { value: "global" | "on" | "off"; label: string }[] = [
  { value: "global", label: "按全局设置" },
  { value: "on", label: "先用决策模型筛" },
  { value: "off", label: "不筛，每批都交给助手" },
];
/** Each knob: its name on the page and one line on what it does in practice. */
export const KNOB: Record<"listen" | "prefilter" | "strictness" | "batchMinutes" | "perDay" | "backlog" | "depth" | "reply" | "ownerAsks" | "othersAsks" | "meetings" | "assist", { label: string; hint: string }> = {
  listen: { label: "看哪些消息", hint: "“挑和说明有关的”先把和上面说明无关的批次筛掉；@ 你或机器人的消息总会看。" },
  prefilter: { label: "怎么挑", hint: "用决策模型先看一眼这批消息，无关的不叫助手，记在处理记录里。没配决策模型时不筛。" },
  strictness: { label: "挑的门槛", hint: "决策模型有多大把握说这批和说明有关，才交给助手。越高越少打扰。" },
  batchMinutes: { label: "攒多久再看", hint: "来了新消息先等这么久，把这段时间的消息一起看；@ 你或机器人的 30 秒内就看；没有新消息就不看。讨论热起来时助手会自己调短，平静了再调回来。" },
  perDay: { label: "每天最多看几批", hint: "到了上限，当天剩下的消息不再看；@ 你或机器人的不受这个限制。" },
  backlog: { label: "关注开始前没人答的", hint: "刚建这个关注时，这段时间里还没人答的问题当作新消息看一遍。" },
  depth: { label: "要不要去查", hint: "去查：用技能、日志、代码和资料核实了再说；不查：只回答手头资料就能答的。" },
  reply: { label: "在群里回复", hint: "先给我看：回复先变成只有你看得到的草稿卡片，你点发送才发出去。" },
  ownerAsks: { label: "问我、要我拍板的", hint: "排期、承诺、对外的说法这类，默认不在群里替你表态，只把谁问了什么、它查到的告诉你。" },
  othersAsks: { label: "找别人或别的机器人的", hint: "消息 @ 了别人，或者叫的是别人的助理、别的机器人。" },
  meetings: { label: "群里有人开会时", hint: "进会是机器人入会旁听，记下的内容和会后小结写回这个关注。" },
  assist: { label: "主动推进这件事", hint: "大约每天一次，有变化或快到截止时看一遍，写现状和最多三条下一步；“只读的事先做”会直接挂材料、列测试清单这类不改东西的事。" },
};
const BATCH = [0, 5, 10, 30, 60, 120];
const PER_DAY = [5, 10, 20, 50, 100, 200];
/** The usual values, plus the current one when it is something else. */
export const batchOptions = (cur: number) => [...new Set([...BATCH, cur])].sort((a, b) => a - b).map((v) => ({ value: v, label: !v ? "不等，来一条看一条" : v < 60 || v % 60 ? `等 ${v} 分钟` : `等 ${v / 60} 小时` }));
export const perDayOptions = (cur: number) => [...new Set([...PER_DAY, cur])].sort((a, b) => a - b).map((v) => ({ value: v, label: `${v} 批` }));

export const replyLabel = (k: Pick<ListenKnobs, "reply" | "wantsAuto">) =>
  k.reply === "draft" && k.wantsAuto ? "直接回（试运行中）" : (REPLY_OPTIONS.find((o) => o.value === k.reply)?.label ?? k.reply);

export const VERDICT_LABEL: Record<Verdict, string> = { "should-reply": "该回", "should-not": "不该回", wrong: "回得不对" };
/** Why a draft was not sent: the 有人找你 reasons and the 关注 card's. */
const DROP_REASON: Record<string, string> = {
  "no-need": "不用回", verbose: "太啰嗦", "no-conclusion": "没有结论", self: "我自己回",
  "not-ours": "不该回", "owner-decides": "该我来定", wrong: "结论不对或没依据", useless: "没帮上忙",
};
/** What the assistant did with a case, in a few words. */
export function caseOutcome(c: ListenCase): { label: string; tone: "" | "ok" | "warn" | "danger" | "accent"; why: string } {
  const why = c.reason ? (DROP_REASON[c.reason] ?? c.reason) : "";
  switch (c.decision) {
    case "sent": return { label: "草稿你照发了", tone: "ok", why: "" };
    case "edited": return { label: "草稿你改了再发", tone: "warn", why: "" };
    case "dropped": return { label: "草稿你没发", tone: "danger", why };
    case "auto": return { label: "直接回了", tone: "accent", why: "" };
    case "disliked": return { label: "直接回了，你不满意", tone: "danger", why };
    case "quiet": return { label: "看了，没回", tone: "", why };
  }
  if (c.draft) return { label: c.settled_at ? "拟了草稿，你没处理" : "草稿等你决定", tone: "warn", why: "" };
  return { label: "没拟回复", tone: "", why };
}
/** The owner corrected it: not sent, edited, disliked, or marked on the web. */
export const corrected = (c: ListenCase) => !!c.verdict || c.decision === "dropped" || c.decision === "edited" || c.decision === "disliked";
/** Nothing went out from the assistant. */
export const unanswered = (c: ListenCase) => !(c.decision === "sent" || c.decision === "edited" || c.decision === "auto" || c.decision === "disliked");

export const OUTCOME_LABEL: Record<ListenHandling["outcome"], string> = { handled: "处理了", quiet: "看了没说话", screened: "预筛跳过" };

/** Text areas hold one entry a line. */
export const lines = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean);
/** Group names can carry line breaks (a group named after a ticket). */
export const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** The groups a 关注 can read: captured group chats (not private ones, which the default covers), plus ones it already has. */
export function groupOptions(chats: { chatId: string; name: string; kind: string }[], keep: { id: string; name: string }[] = []) {
  const out: { value: string; label: string; hint?: string }[] = chats
    .filter((c) => c.kind === "group" || c.kind === "topic")
    .map((c) => ({ value: c.chatId, label: oneLine(c.name) || c.chatId, hint: c.kind === "topic" ? "话题群" : undefined }));
  for (const k of keep) if (!out.some((o) => o.value === k.id)) out.unshift({ value: k.id, label: oneLine(k.name) || k.id });
  return out;
}

/** Which 关注 each group is in (the chat list's chips). */
export function byChat(items: ListenView[]) {
  const m: Record<string, { id: string; name: string; paused: boolean }[]> = {};
  for (const v of items) for (const chat of v.chats) (m[chat] ??= []).push({ id: v.id, name: v.name, paused: v.status !== "active" });
  return m;
}

/** A 情境's form (components/SituationForm) from its view, and what saving it sends (POST / PUT /api/listen). */
export type SituationFormValue = { name: string; note: string; recognize: string; spec: string; spaceId: string; fast: { firstLook?: boolean; probes?: string[]; firstTo?: ListenKnobs["firstTo"] }; active: boolean };
export function situationForm(v: ListenView | null, defaults: Partial<SituationFormValue> = {}): SituationFormValue {
  const k = v?.knobs;
  return {
    name: v?.name ?? "", note: v?.note ?? "", recognize: v?.recognize ?? "", spec: v?.spec ?? "assistant", spaceId: v?.spaceId ?? "personal",
    fast: { ...(k?.firstLook ? { firstLook: true } : {}), ...(k?.probes?.length ? { probes: [...k.probes] } : {}), ...(k?.firstTo ? { firstTo: k.firstTo } : {}) },
    active: v ? v.status === "active" : true,
    ...defaults,
  };
}
/** The body to save: everything for a new one; for an existing one only what changed (the server keeps the rest). */
export function situationBody(f: SituationFormValue, was?: SituationFormValue) {
  const knobs = { firstLook: f.fast.firstLook ?? false, probes: f.fast.probes?.length ? f.fast.probes : null, firstTo: f.fast.firstTo ?? null };
  const all = { name: f.name.trim(), note: f.note.trim(), recognize: f.recognize.trim(), spec: f.spec, spaceId: f.spaceId, knobs, status: f.active ? "active" : "paused" };
  if (!was) return { kind: "situation", ...all };
  const before = situationBody(was) as typeof all;
  return Object.fromEntries(Object.entries(all).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(before[key as keyof typeof all])));
}
/** What keeps a 情境 from saving, in the owner's words (the server's limits: 80 / 2000 / 1000). */
export function situationProblem(f: SituationFormValue) {
  if (!f.name.trim()) return "写一个名字";
  if (!f.note.trim()) return "写下这类事发生时你在意什么";
  if (!f.recognize.trim()) return "写一句怎么认出来";
  return "";
}
