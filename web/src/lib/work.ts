/**
 * The work page and a line's page as the web shows them (src/items/work-http.ts, src/items/lines.ts,
 * src/items/changes.ts). The web cannot import src/: the shapes here follow those files.
 */
import { toWallDate } from "./time.js";

/** What a reference that is no citation names (src/items/changes.ts refTargets): an item or a run of the same person. */
export type RefTarget = { kind: "item" | "run"; id: string; title: string };
export type ChangeLite = {
  id: string; at: string; type: string; summary: string; detail: string | null; risk: string | null; next: string | null;
  refs: string[]; status: string; origin: string; noise: boolean; itemId: string; itemTitle: string; lineId: string; lineTitle: string;
  refTargets?: Record<string, RefTarget>;
  /** The change ledger (src/items/changes.ts): the run that first noted it, its source key, who added to it later. */
  runId?: string;
  sourceKey?: string;
  added?: { origin: string; runId: string | null; at: string; fields: string[] }[];
  /** Paths that stepped aside on the message behind it, and why (src/core/handling.ts; the line page only). */
  yields?: { label: string; to: string; reason: string; at: string }[];
};
export type NextKind = "read" | "test" | "code" | "ask" | "data";
export type NextLite = {
  id: string; itemId: string; text: string; why: string; refs: string[]; kind: NextKind; status: "open" | "doing" | "done" | "declined" | "expired"; runId: string | null; createdAt: string; updatedAt: string; decidedAt: string | null;
  refTargets?: Record<string, RefTarget>;
};
export type StageLite = { id: string; name: string; state: string; enteredAt: string | null; doneAt: string | null; waitingOn: string | null };
export type FlowLite = { name: string; stages: StageLite[]; current: { id: string; name: string; state: string } | null };
export type Child = { id: string; title: string; kind: string; status: string; dueAt: string | null; parentId: string | null; waitingOn: string | null; flow: FlowLite | null; children?: Child[] };
export type LineNow = { text: string; people: { name: string; openId?: string; role: string }[]; weeks: { label: string; text: string }[]; at: string; runId: string | null; summary?: string; summaryAt?: string };
export type Line = {
  id: string; title: string; kind: string; status: string; dueAt: string | null; spaceId: string; now: LineNow | null;
  counts: { changes: number; today: number; lastAt: string | null }; timeline: ChangeLite[]; next: NextLite[]; children: Child[];
  listen: { id: string; assist: string } | null;
  /** src/items/lifecycle.ts: null 进行中, `watching` 观察中 until `watchUntil`. */
  phase: "watching" | null; phaseSince: string | null; watchUntil: string | null;
  watch?: { flaggedMetrics: number; openProblems: number; openItems: number };
  /**
   * For someone other than the owner (src/items/member-work.ts): whether some of what is under it is not theirs to see
   * (then no state, people or next steps of the line come), whether it is their own line, and whose it is.
   */
  partial?: boolean; mine?: boolean; person?: { id: string; name: string }; can?: { edit: boolean; operate: boolean };
};
/** A line that ended (GET /api/work `ended`, /api/work/ended). */
export type EndedLine = { id: string; title: string; status: string; closedAt: string | null; summary: string | null; reason: string | null; spaceId: string };
export type ItemLite = { id: string; title: string; kind: string; status: string; dueAt: string | null; remindAt: string | null; waitingOn: string | null; spaceId: string; updatedAt: string };
export type GateLite = { itemId: string; title: string; flowName: string; stage: { id: string; name: string; state: string }; since: string; askId: string | null };
export type ChatActivity = { chatId: string; name: string; total: number; perDay: number[]; lastAt: string | null };
export type Place = { id: string; name: string; openProblems: number };

/** What changed, in a word (the filter chips and the tag on a card). */
export const changeTypeLabel: Record<string, string> = {
  scope: "范围", decision: "决定", deadline: "时间", blocker: "风险", info: "信息", stage: "阶段", result: "结果", owner: "负责人", resolved: "解除", todo: "待办", question: "待定",
};
/** Where a change was seen. */
export const originLabel: Record<string, string> = { follow: "群聊和文档", flow: "流程", metric: "指标", problem: "在跟的问题", owner: "你定的", line: "观察与结束", meeting: "会议", review: "评审", commit: "提交认领", member: "成员回答" };
/**
 * Where a change was seen, for the person reading it: “你定的” is the reader's own word; someone reading
 * a line that is not theirs (`by`: the owner's name, lib/owner-name.ts) reads whose it was.
 */
export function originText(origin: string, by?: string) {
  if (origin === "owner" && by) return by + "定的";
  return originLabel[origin] ?? origin;
}
/** What a change's source key names, in a few words (src/items/changes.ts sourceKeys). */
export function sourceLabel(key: string | undefined) {
  if (!key) return "";
  const k = key.replace(/~\d+$/, "");
  if (k.startsWith("lark:")) return "一条飞书消息";
  if (k.startsWith("meeting:")) return "一场会议的记录";
  if (k.startsWith("metric:")) return "一次指标越线";
  if (k.startsWith("problem:")) return "一个在跟的问题";
  if (k.startsWith("stage:")) return "流程的一段";
  if (k.startsWith("review:")) return "一次评审";
  if (k.startsWith("commits:")) return "一批提交";
  if (k.startsWith("src:")) return "原件里的几行";
  if (k.startsWith("ask:")) return "替你问的一个问题";
  return "";
}
export const nextKindLabel: Record<NextKind, string> = { read: "读", test: "测", code: "改", ask: "问", data: "数据" };
export const nextStatusLabel: Record<NextLite["status"], string> = { open: "没定", doing: "在做", done: "做完", declined: "不用", expired: "已过期" };
export const itemStatusLabel: Record<string, string> = { open: "进行中", waiting: "等待中", snoozed: "稍后", done: "完成", cancelled: "取消", expired: "过期", candidate: "候选" };

/**
 * The colour a change's dot and tag take: a risk or a moved date warm, what was settled (scope,
 * decision) the accent, a result or a lifted risk green, the rest (a stage, news, a new owner) quiet.
 */
export function changeTone(type: string): "warn" | "accent" | "ok" | "quiet" {
  if (type === "blocker" || type === "deadline") return "warn";
  if (type === "decision" || type === "scope") return "accent";
  if (type === "result" || type === "resolved") return "ok";
  return "quiet";
}

/** The filter chips of 按时间: each chip is one or more change types. */
export const TYPE_FILTERS: { key: string; label: string; types: string[] }[] = [
  { key: "decision", label: "决定", types: ["decision"] },
  { key: "risk", label: "风险", types: ["blocker", "resolved"] },
  { key: "scope", label: "范围", types: ["scope"] },
  { key: "deadline", label: "时间", types: ["deadline"] },
  { key: "result", label: "结果", types: ["result"] },
  { key: "stage", label: "阶段", types: ["stage", "owner"] },
];
export const ORIGIN_FILTERS: { key: string; label: string }[] = [
  { key: "follow", label: "群聊" },
  { key: "flow", label: "流程" },
  { key: "metric", label: "指标" },
  { key: "problem", label: "问题" },
  { key: "owner", label: "你定的" },
  { key: "line", label: "观察与结束" },
  { key: "member", label: "成员回答" },
];

const DAY = 86_400_000;
/** Midnight of the instant's day in the set zone, as a wall-clock Date. */
function wallDay(t: string | number | Date) {
  const d = toWallDate(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
/** Whole days between the two instants' days in the set zone (today 0, yesterday 1). */
export function daysAgo(at: string, now = Date.now()) {
  return Math.round((wallDay(now).getTime() - wallDay(at).getTime()) / DAY);
}
/** "今天", "昨天", "11 月 9 日" (another year: "2025 年 11 月 9 日"). */
export function dayLabel(at: string, now = Date.now()) {
  const n = daysAgo(at, now);
  if (n === 0) return "今天";
  if (n === 1) return "昨天";
  const d = wallDay(at), t = wallDay(now);
  return `${d.getFullYear() !== t.getFullYear() ? `${d.getFullYear()} 年 ` : ""}${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}
/** "11 月 20 日" of a day key ("2026-11-20"), with 今天 / 昨天. */
export function dayKeyLabel(key: string, today: string) {
  const [y, m, d] = key.split("-").map(Number);
  const [ty, tm, td] = today.split("-").map(Number);
  const diff = Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(y, m - 1, d)) / DAY);
  const words = `${y !== ty ? `${y} 年 ` : ""}${m} 月 ${d} 日`;
  return diff === 0 ? `${words} · 今天` : diff === 1 ? `${words} · 昨天` : words;
}
/** "12/05" (another year: "2025/12/05"): a short date for a pill. */
export function shortDay(at: string, now = Date.now()) {
  const d = wallDay(at), t = wallDay(now);
  return `${d.getFullYear() !== t.getFullYear() ? `${d.getFullYear()}/` : ""}${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
}
/** Ended lines grouped by the month they ended in (set zone), newest first: "2026 年 11 月". */
export function byMonth<T extends { closedAt: string | null }>(rows: T[]) {
  const out: { key: string; label: string; items: T[] }[] = [];
  for (const r of rows) {
    const d = r.closedAt ? wallDay(r.closedAt) : null;
    const key = d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}` : "";
    let g = out.find((x) => x.key === key);
    if (!g) out.push((g = { key, label: d ? `${d.getFullYear()} 年 ${d.getMonth() + 1} 月` : "不知道哪天", items: [] }));
    g.items.push(r);
  }
  return out;
}
/** What an ended line's row says in one line: its closing summary's first sentence, else why it ended. */
export function endedLine(e: Pick<EndedLine, "summary" | "reason" | "status">) {
  const first = (e.summary ?? "").split(/\n/).filter((l) => !/^\s*#/.test(l)).map((l) => l.replace(/^[>*\-\s]+/, "").replace(/\*\*/g, "").trim()).find(Boolean);
  return first || e.reason || (e.status === "cancelled" ? "放弃了" : "结束了");
}

/** "14:05" in the set zone. */
export function clock(at: string) {
  const d = toWallDate(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Monday of the week the instant falls in (set zone), as a wall-clock Date. */
function weekStart(t: string | number | Date) {
  const d = wallDay(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
}
/** How many weeks before this one the instant's week is (this week 0). */
export function weeksAgo(at: string, now = Date.now()) {
  return Math.round((weekStart(now).getTime() - weekStart(at).getTime()) / (7 * DAY));
}
/** "本周 · 至今 5 天", "上周", "2 周前". */
export function weekLabel(n: number, now = Date.now()) {
  if (n <= 0) return `本周 · 至今 ${((wallDay(now).getDay() + 6) % 7) + 1} 天`;
  return n === 1 ? "上周" : `${n} 周前`;
}

/** Changes (newest first) grouped by the week they fall in, newest week first. */
export function byWeek(changes: ChangeLite[], now = Date.now()) {
  const groups: { n: number; label: string; items: ChangeLite[] }[] = [];
  for (const c of changes) {
    const n = Math.max(0, weeksAgo(c.at, now));
    let g = groups.find((x) => x.n === n);
    if (!g) groups.push((g = { n, label: weekLabel(n, now), items: [] }));
    g.items.push(c);
  }
  return groups.sort((a, b) => a.n - b.n);
}

/**
 * The four columns of “最近忙这些”: what the line's look wrote for each week when it has, else the
 * latest change of that week from the timeline (newest first), else nothing yet.
 */
export function weekColumns(now: LineNow | null, timeline: ChangeLite[], at = Date.now()) {
  const groups = byWeek(timeline, at);
  return [0, 1, 2, 3].map((n) => {
    const label = weekLabel(n, at);
    const written = now?.weeks[n]?.text?.trim();
    const g = groups.find((x) => x.n === n);
    return { label, text: written || g?.items[0]?.summary || "", count: g?.items.length ?? 0 };
  });
}

/** An item waits for the owner: its flow is at a gate, stuck, or on the owner's own step. */
export function waitsForOwner(c: Pick<Child, "flow">) {
  const cur = c.flow?.current;
  if (!cur) return false;
  const s = c.flow!.stages.find((x) => x.id === cur.id);
  return cur.state === "gated" || cur.state === "blocked" || s?.waitingOn === "owner";
}
/** The colour of one stage in a stage track (omem-design: done ok, under way accent, the owner's turn or stuck warn, not yet line). */
export function stageTone(s: StageLite, current?: string | null): "ok" | "accent" | "warn" | "quiet" | "skip" {
  if (s.state === "done") return "ok";
  if (s.state === "skipped") return "skip";
  if (s.state === "gated" || s.state === "blocked" || s.waitingOn === "owner") return "warn";
  if (s.state === "doing" || s.state === "stale" || s.id === current && s.state !== "pending") return "accent";
  return "quiet";
}

/** The items under a line, flattened with their depth (a defect under its requirement), open ones only unless `all`. */
export function flatChildren(children: Child[], all = false, depth = 0): { child: Child; depth: number }[] {
  const closed = ["done", "cancelled", "expired"];
  return children.flatMap((c) => (all || !closed.includes(c.status) ? [{ child: c, depth }, ...flatChildren(c.children ?? [], all, depth + 1)] : []));
}

/** A reference as a short label for a chip: 原件 / 记忆 / 消息 / 运行. */
export function refLabel(r: string, i: number) {
  if (r.startsWith("src:")) return `原件 ${i + 1}`;
  if (r.startsWith("mem:")) return `记忆 ${i + 1}`;
  if (r.startsWith("msg:")) return `消息 ${i + 1}`;
  if (r.startsWith("design:")) return "方案";
  if (/^r0/.test(r)) return `运行 ${i + 1}`;
  return r.length > 24 ? `${r.slice(0, 22)}…` : r;
}
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
/**
 * The references that are no citation, as the side sheet lists them under 来源: an item by its title (its
 * page under 工作), a run by its title, a plan; the server says which ones name something (`refTargets`).
 * Anything else — an id nothing answers to, a stage, a metric's name — is plain text, never a link to an empty page.
 */
export function otherRefs(refs: string[], targets: Record<string, RefTarget> = {}) {
  return refs.filter((r) => !/^(src|mem|msg):/.test(r)).map((r) => {
    const t = targets[r];
    if (t?.kind === "item") return { r, label: `事项：${clip(t.title, 40)}`, title: t.title, link: `#/work/${encodeURIComponent(t.id)}` };
    // Coding work (`code-work:`) opens under 编码 → 交办.
    if (t?.kind === "run") return { r, label: `运行：${clip(t.title, 30)}`, title: t.title, link: `#/${r.startsWith("code-work:") ? "code" : "runs"}/${encodeURIComponent(t.id)}` };
    if (r.startsWith("design:")) return { r, label: "方案", title: r, link: `#/code/designs/${encodeURIComponent(r.slice(7))}` };
    return { r, label: clip(r, 24), title: r, link: null };
  });
}
/**
 * Text an agent wrote, with the long technical strings in it made readable (for `RichText` / `Markdown`):
 * an id the server named in `targets` (an item, a run) becomes a link with its title, a source id a
 * citation; any other id, a commit hash or a path with several slashes becomes inline code (shown
 * small and monospace, and allowed to wrap). Code spans, links and URLs already there stay as they are.
 */
export function readableIds(text: string, targets: Record<string, RefTarget> = {}) {
  const KEEP = /`[^`\n]*`|\[[^\]\n]*\]\([^)\n]*\)|https?:\/\/[^\s)）]+|(?:src|mem|msg):[^\s)）]+/y;
  const ID = /(?:ask|[a-z]{1,3})0m[0-9a-z]{12,}/y;
  const HASH = /[0-9a-f]{7,40}/y;
  const PATH = /(?:origin\/[\w.-]+(?:\/[\w.-]+)*|\/?[\w.-]+(?:\/[\w.-]+){2,}\/?)/y;
  const word = /[0-9A-Za-z_]/;
  let out = "";
  for (let i = 0; i < text.length; ) {
    const atWordStart = i === 0 || !word.test(text[i - 1]);
    let m: RegExpExecArray | null = null;
    KEEP.lastIndex = i;
    if ((m = KEEP.exec(text))) { out += m[0]; i += m[0].length; continue; }
    if (atWordStart) {
      for (const re of [ID, HASH, PATH]) {
        re.lastIndex = i;
        const hit = re.exec(text);
        if (!hit || word.test(text[i + hit[0].length] ?? "")) continue;
        const s = hit[0];
        if (re === HASH && !(/\d/.test(s) && /[a-f]/.test(s))) continue;
        const t = targets[s];
        if (re === ID && t) out += `[${t.kind === "run" ? "运行" : "事项"}：${clip(t.title, 30)}](#/${t.kind === "run" ? "runs" : "work"}/${encodeURIComponent(t.id)})`;
        else if (re === ID && s.startsWith("s0m")) out += `[原件](src:${s})`;
        else out += `\`${s}\``;
        m = hit;
        break;
      }
      if (m) { i += m[0].length; continue; }
    }
    out += text[i++];
  }
  return out;
}
/** The references as one line of Markdown links, so src: / mem: / msg: open in the citation drawer. */
export function refsMarkdown(refs: string[]) {
  return refs.filter((r) => /^(src|mem|msg):/.test(r)).map((r, i) => `[${refLabel(r, i)}](${r})`).join("　");
}
