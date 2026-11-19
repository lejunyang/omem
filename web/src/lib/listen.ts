/**
 * 「关注」on the web (server: src/channels/listen.ts, listen-http.ts): the shapes the API returns and
 * the words for its knobs, cases and handling, shared by the settings list, the detail page and rules.
 */
export type ListenKind = "place" | "item" | "default";
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
  seeOthers: boolean;
  batchMinutes: number;
  prefilter?: boolean;
};
export type ListenBrief = { handle: string[]; skip: string[]; valid: string; at?: string; confirmedAt?: string };
export type ListenView = {
  id: string;
  kind: ListenKind;
  name: string;
  chats: string[];
  groups: { id: string; name: string }[];
  itemId: string | null;
  item: { id: string; title: string; status: string } | null;
  spec: string;
  spaceId: string | null;
  conversationId: string | null;
  note?: string;
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

export const KIND_LABEL: Record<ListenKind, string> = { place: "群", item: "事情", default: "默认" };

type Opt<V> = { value: V; label: string; title?: string };
export const REPLY_OPTIONS: Opt<ListenKnobs["reply"]>[] = [
  { value: "none", label: "只看不回" },
  { value: "draft", label: "先给我看" },
  { value: "auto", label: "直接回" },
];
export const LISTEN_OPTIONS: Opt<ListenKnobs["listen"]>[] = [
  { value: "addressed", label: "只看找我或机器人的" },
  { value: "relevant", label: "预筛后看相关的" },
  { value: "all", label: "全看" },
];
export const DEPTH_OPTIONS: Opt<ListenKnobs["depth"]>[] = [
  { value: "answer", label: "只答能直接答的" },
  { value: "investigate", label: "值得查的主动查" },
];
export const OWNER_ASKS_OPTIONS: Opt<ListenKnobs["ownerAsks"]>[] = [
  { value: "notify", label: "只私下告诉我" },
  { value: "draft", label: "拟草稿给我" },
  { value: "answer", label: "可以直接答" },
];
export const OTHERS_ASKS_OPTIONS: Opt<ListenKnobs["othersAsks"]>[] = [
  { value: "leave", label: "不接" },
  { value: "handle", label: "也处理" },
];
export const BACKLOG_OPTIONS: Opt<ListenKnobs["backlog"]>[] = [
  { value: "off", label: "不处理" },
  { value: "24h", label: "最近 24 小时" },
  { value: "72h", label: "最近 72 小时" },
];
export const MEETING_OPTIONS: Opt<ListenKnobs["meetings"]>[] = [
  { value: "off", label: "不管" },
  { value: "ask", label: "开会时问我要不要进会" },
  { value: "listen", label: "直接旁听" },
];
export const STRICTNESS_OPTIONS: { value: number | null; label: string }[] = [
  { value: null, label: "默认（按决策设置）" },
  { value: 0.5, label: "0.5 · 多看一些" },
  { value: 0.6, label: "0.6" },
  { value: 0.7, label: "0.7" },
  { value: 0.8, label: "0.8" },
  { value: 0.9, label: "0.9" },
  { value: 0.95, label: "0.95 · 最少打扰" },
];
export const PREFILTER_OPTIONS: { value: "global" | "on" | "off"; label: string }[] = [
  { value: "global", label: "按全局设置" },
  { value: "on", label: "先预筛" },
  { value: "off", label: "不预筛，每批都看" },
];
const BATCH = [0, 5, 10, 30, 60, 120];
const PER_DAY = [5, 10, 20, 50, 100, 200];
/** The usual values, plus the current one when it is something else. */
export const batchOptions = (cur: number) => [...new Set([...BATCH, cur])].sort((a, b) => a - b).map((v) => ({ value: v, label: v ? `每 ${v} 分钟一批` : "来了就看" }));
export const perDayOptions = (cur: number) => [...new Set([...PER_DAY, cur])].sort((a, b) => a - b).map((v) => ({ value: v, label: `每天最多 ${v} 批` }));

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
