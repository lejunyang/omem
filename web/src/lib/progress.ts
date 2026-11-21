/**
 * How a piece of work split across agents is going (`GET /api/runs/:id/progress`, `GET /api/items/:id/progress`,
 * src/agents/progress.ts): the same shape for a work board, a coding delegation, a review, a flow and a study.
 * The helpers here turn one block into its summary line and its tasks into compact rows; no DOM.
 */
import { plainLine } from "./plain.js";

export type ProgressUsage = { input: number; output: number; cached?: number; runs: number; missing: number };
export type ProgressAttempt = { runId: string; status: string; startedAt?: string; endedAt?: string; queuedMs?: number; runMs?: number; usage: ProgressUsage };
export type ProgressOutput = { kind: "report" | "commit" | "branch" | "finding" | "evidence" | "page"; ref: string; label: string };
export type ProgressDecision = { by?: string; at?: string; ref?: string; result: string; note?: string };
export type TaskState = "pending" | "queued" | "running" | "submitted" | "accepted" | "redo" | "blocked" | "failed" | "cancelled";
export type ProgressTask = {
  id: string; title: string; state: TaskState; goal?: string; accept?: string; needs?: string[]; waitingOn?: string;
  who?: { agent?: string; model?: string; effort?: string; device?: string };
  attempts: ProgressAttempt[]; usage: ProgressUsage; outputs?: ProgressOutput[]; decision?: ProgressDecision; decisions?: ProgressDecision[];
  round?: number; parentId?: string;
};
export type ProgressKind = "board" | "code" | "review" | "flow" | "study";
export type BlockState = "running" | "waiting" | "done" | "failed" | "cancelled";
export type ProgressView = {
  kind: ProgressKind; id: string; title: string; runId?: string; itemId?: string;
  state: BlockState; waitingOn?: string; tasks: ProgressTask[]; usage: ProgressUsage;
  rounds?: { runId: string; round?: number; status: string }[];
  previousRounds?: { round: number; directions: number; trials: number; usage: ProgressUsage }[];
};

export const KIND_LABEL: Record<ProgressKind, string> = { board: "任务板", code: "编码交办", review: "评审", flow: "流程", study: "课题" };
export const TASK_LABEL: Record<TaskState, string> = {
  pending: "待开始", queued: "排队", running: "在做", submitted: "交了，待验收", accepted: "已接受",
  redo: "退回重做", blocked: "阻塞", failed: "没做成", cancelled: "已取消",
};
export const BLOCK_LABEL: Record<BlockState, string> = { running: "在做", waiting: "在等", done: "已完成", failed: "没做成", cancelled: "已取消" };

/** The three things that stand out (waiting for the owner, failed or stuck, running); everything else is quiet. */
export type Tone = "owner" | "danger" | "running" | "ok" | "quiet";
/** A wait the owner is the one to end: “等本人确认”, “等你选”. */
export const ownerWait = (text?: string | null) => !!text && /本人|你/.test(text);

export function taskTone(t: Pick<ProgressTask, "state" | "waitingOn">): Tone {
  if (ownerWait(t.waitingOn)) return "owner";
  if (t.state === "failed" || t.state === "blocked") return "danger";
  if (t.state === "running") return "running";
  if (t.state === "accepted") return "ok";
  return "quiet";
}
export function blockTone(b: Pick<ProgressView, "state" | "waitingOn" | "tasks">): Tone {
  if (ownerWait(b.waitingOn) || b.tasks.some((t) => t.state !== "cancelled" && t.state !== "accepted" && ownerWait(t.waitingOn))) return "owner";
  if (b.state === "failed" || b.tasks.some((t) => t.state === "failed" || t.state === "blocked")) return "danger";
  if (b.state === "running") return "running";
  if (b.state === "done") return "ok";
  return "quiet";
}

/** 1234 → 1.2k, 2_400_000 → 2.4M. */
export function compact(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const a = Math.abs(n);
  const short = (v: number, unit: string) => `${v >= 100 ? Math.round(v) : Number(v.toFixed(1))}${unit}`;
  if (a >= 1e6) return short(n / 1e6, "M");
  if (a >= 1e3) return short(n / 1e3, "k");
  return String(Math.round(n));
}
/** “输入 41k · 输出 3.2k”, or “” when nothing was reported. */
export function usageText(u: ProgressUsage | undefined): string {
  if (!u || (!u.input && !u.output)) return "";
  return `输入 ${compact(u.input)} · 输出 ${compact(u.output)}`;
}
/** Runs that reported no usage: “有 2 个没有用量数据”, or “没有用量数据” when none did. */
export function missingText(u: ProgressUsage | undefined): string {
  if (!u || !u.missing) return "";
  return !u.input && !u.output && u.missing >= u.runs ? "没有用量数据" : `有 ${u.missing} 个没有用量数据`;
}

/** “40 秒”, “12 分钟”, “1.5 小时”; “” under a second. */
export function took(ms: number | undefined): string {
  if (!ms || ms < 1000) return "";
  if (ms < 90_000) return `${Math.round(ms / 1000)} 秒`;
  if (ms < 5_400_000) return `${Math.round(ms / 60_000)} 分钟`;
  return `${(ms / 3_600_000).toFixed(1)} 小时`;
}

/** “3 / 5 完成”: accepted out of the tasks not cancelled. */
export function doneCount(b: Pick<ProgressView, "tasks">) {
  const live = b.tasks.filter((t) => t.state !== "cancelled");
  return { done: live.filter((t) => t.state === "accepted").length, total: live.length };
}

/** What the block waits on, in a few words: its own wait, then a task's, then “等 T2”, then “排队”. */
export function waitLabel(b: Pick<ProgressView, "state" | "waitingOn" | "tasks">): string {
  if (b.state === "done" || b.state === "cancelled") return "";
  if (b.waitingOn) return b.waitingOn;
  const open = b.tasks.filter((t) => !["accepted", "cancelled"].includes(t.state));
  const own = open.find((t) => t.waitingOn);
  if (own) return own.waitingOn!;
  if (open.length && open.every((t) => pendingNeeds(t, b.tasks).length)) return `等 ${pendingNeeds(open[0], b.tasks).map((n) => shortId(n, b.tasks)).join("、")}`;
  if (open.length && open.every((t) => t.state === "queued" || t.state === "pending")) return "排队";
  return "";
}

/** The tasks this one still waits for: named in `needs` and not accepted or cancelled yet. */
export function pendingNeeds(t: Pick<ProgressTask, "needs">, all: ProgressTask[]) {
  return (t.needs ?? []).filter((id) => {
    const dep = all.find((x) => x.id === id);
    return !dep || !["accepted", "cancelled"].includes(dep.state);
  });
}
/** A task as a dependency is named: its id when short (T2), else its title. */
export function shortId(id: string, all: ProgressTask[]) {
  if (/^T\d+$/.test(id)) return id;
  const t = all.find((x) => x.id === id);
  return t ? plainLine(t.title, 16) : id;
}

/** A study's trials go under their direction (one level of indent); the rest keep their order. */
export function orderTasks(tasks: ProgressTask[]): { task: ProgressTask; depth: number }[] {
  const ids = new Set(tasks.map((t) => t.id));
  const kids = new Map<string, ProgressTask[]>();
  for (const t of tasks) if (t.parentId && ids.has(t.parentId)) kids.set(t.parentId, [...(kids.get(t.parentId) ?? []), t]);
  const out: { task: ProgressTask; depth: number }[] = [];
  for (const t of tasks) {
    if (t.parentId && ids.has(t.parentId)) continue;
    out.push({ task: t, depth: 0 });
    for (const k of kids.get(t.id) ?? []) out.push({ task: k, depth: 1 });
  }
  return out;
}

/** The model the latest attempt used (its last segment), or the agent's name. */
export function whoLabel(t: Pick<ProgressTask, "who">, home?: string | null) {
  const w = t.who;
  if (!w) return "";
  const model = w.model ? w.model.split("/").pop()! : w.agent && w.agent !== "assistant" ? w.agent : "";
  const device = w.device && w.device !== home ? w.device : "";
  return [model, device && `在 ${device}`].filter(Boolean).join(" · ");
}
/** The device most of the board's attempts ran on: this machine, whose name is not worth repeating. */
export function homeDevice(blocks: ProgressView[]): string | null {
  const counts = new Map<string, number>();
  for (const b of blocks) if (b.kind === "board") for (const t of b.tasks) if (t.who?.device) counts.set(t.who.device, (counts.get(t.who.device) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

const VERDICT: Record<string, string> = { approved: "通过", changes_requested: "要修改", failed: "没做成", passed: "通过", inconclusive: "说不清" };
/** An output's words: review and trial verdict codes in front read as words; no Markdown marks. */
export function outputLabel(o: ProgressOutput): string {
  // Evidence is named by its reference alone: say what it is, not its id.
  if (o.kind === "evidence" && o.label === o.ref) {
    if (/^src:/.test(o.ref)) return "原件";
    if (/^design:/.test(o.ref)) return "方案";
    if (/^r[0-9a-z]{8,}$/.test(o.ref)) return "运行";
  }
  const text = o.label.replace(/^([a-z_]+)(?= · )/, (m) => VERDICT[m] ?? m);
  return plainLine(text, 80);
}

const DECISION: Record<string, string> = {
  accept: "接受", redo: "退回重做", block: "标为阻塞", accepted: "采纳", rejected: "驳回", merged: "合并",
  fix: "要改", later: "以后再改", wontfix: "不改", open: "待定",
};
/** The acceptance in a few words: “接受”, or “3 条取舍” when a review check has several. */
export function decisionText(t: Pick<ProgressTask, "decision" | "decisions">): string {
  if ((t.decisions?.length ?? 0) > 1) return `${t.decisions!.length} 条取舍`;
  const d = t.decision ?? t.decisions?.[0];
  return d ? DECISION[d.result] ?? d.result : "";
}

/** Where a task is seen in full: its latest run, the flow tab of its item, or the work's own page. */
export function taskHref(b: Pick<ProgressView, "kind" | "runId" | "itemId">, t: Pick<ProgressTask, "attempts">): string | null {
  if (b.kind === "flow" || b.kind === "study") return b.itemId ? `/items/${encodeURIComponent(b.itemId)}/flow` : null;
  const last = t.attempts.at(-1)?.runId;
  if (last) return `/runs/${encodeURIComponent(last)}`;
  return b.runId ? `/runs/${encodeURIComponent(b.runId)}` : null;
}
/** Where the block's own page is (its actions live there). */
export function blockHref(b: Pick<ProgressView, "kind" | "runId" | "itemId">): string | null {
  if (b.kind === "flow" || b.kind === "study") return b.itemId ? `/items/${encodeURIComponent(b.itemId)}/flow` : null;
  return b.runId ? `/runs/${encodeURIComponent(b.runId)}` : null;
}
/** A link for what a task handed in, when it has a page here; commits and branches have none. */
export function outputHref(b: Pick<ProgressView, "kind" | "runId" | "itemId">, o: ProgressOutput): string | null {
  if (o.kind === "commit" || o.kind === "branch") return null;
  if (o.kind === "evidence") {
    if (/^src:/.test(o.ref)) return `/sources/${encodeURIComponent(o.ref.slice(4).split("#")[0])}`;
    if (/^design:/.test(o.ref)) return `/design/${encodeURIComponent(o.ref.slice(7))}`;
    if (/^r[0-9a-z]{8,}$/.test(o.ref)) return `/runs/${o.ref}`;
    return null;
  }
  if (o.kind === "page") return /^[\w-]+\/.+/.test(o.ref) ? `/wiki/${o.ref}` : null;
  if (b.kind === "board") return `/runs/${encodeURIComponent(o.ref)}`;
  return blockHref(b);
}

/** Every run the blocks name: an event about one of them means the view may have changed. */
export function runIdsOf(blocks: ProgressView[]): Set<string> {
  const ids = new Set<string>();
  for (const b of blocks) {
    if (b.runId) ids.add(b.runId);
    for (const r of b.rounds ?? []) ids.add(r.runId);
    for (const t of b.tasks) for (const a of t.attempts) ids.add(a.runId);
  }
  return ids;
}
