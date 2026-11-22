/**
 * How a piece of work split across agents is going (`GET /api/runs/:id/progress`, `GET /api/items/:id/progress`,
 * src/agents/progress.ts): the same shape for a work board, a coding delegation, a review, a flow and a study.
 * The helpers here turn one block into its summary line and its tasks into compact rows; no DOM.
 */
import { plainLine } from "./plain.js";

export type ProgressUsage = { input: number; output: number; cached?: number; runs: number; missing: number };
/**
 * Where an attempt ran (src/agents/work-board.ts): `mode` only when a board task was sent to another device —
 * `borrow` used that device's backend here, `remote` ran there (its run page at `remoteUrl` when reachable);
 * `lateAt`: its result came back after the deadline and was not used.
 */
export type AttemptPlace = { local?: boolean; device?: string; deviceName?: string; mode?: "borrow" | "remote"; access?: "read" | "write"; deadline?: string; remoteUrl?: string; remoteRunId?: string; lateAt?: string };
export type ProgressAttempt = { runId: string; status: string; startedAt?: string; endedAt?: string; queuedMs?: number; runMs?: number; usage: ProgressUsage } & AttemptPlace;
/** What a stage's evidence points at, as the server read it (only what the reader may open). */
export type EvidenceTarget = { kind: "source" | "design" | "run" | "object"; id: string; title: string };
/** `link`: an address the task handed you to open (ref is the http(s) URL), opened in a new tab. */
export type ProgressOutput = { kind: "report" | "commit" | "branch" | "finding" | "evidence" | "page" | "link"; ref: string; label: string; target?: EvidenceTarget };
export type ProgressDecision = { by?: string; at?: string; ref?: string; result: string; note?: string };
export type TaskState = "pending" | "queued" | "running" | "submitted" | "accepted" | "redo" | "blocked" | "failed" | "cancelled";
export type ProgressTask = {
  /** Where the task is seen in full (`#/runs/…?task=T2`, `#/items/…/flow?stage=…`); absent from an older server. */
  href?: string;
  id: string; title: string; state: TaskState; goal?: string; accept?: string; needs?: string[]; waitingOn?: string;
  /** `local`: the latest attempt ran on this machine; `device`: the machine's name otherwise. */
  who?: { agent?: string; model?: string; effort?: string; local?: boolean; device?: string; deviceName?: string; mode?: "borrow" | "remote" };
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

/**
 * One page of blocks (`?summary=true`): the blocks and their total, each run counted once across them
 * (src/agents/progress.ts `allocate`). An older server answers with the blocks alone: no total then.
 */
export function readProgress(data: unknown): { views: ProgressView[]; total: ProgressUsage | null } {
  if (Array.isArray(data)) return { views: data as ProgressView[], total: null };
  const page = data as { views?: ProgressView[]; totalUsage?: ProgressUsage } | null;
  return { views: Array.isArray(page?.views) ? page!.views : [], total: page?.totalUsage ?? null };
}

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

/** The model the latest attempt used (its last segment), or the agent's name; the device when it was not this machine. */
export function whoLabel(t: Pick<ProgressTask, "who">) {
  const w = t.who;
  if (!w) return "";
  const model = w.model ? w.model.split("/").pop()! : w.agent && w.agent !== "assistant" ? w.agent : "";
  const place = placeLabel(w) || (w.device && !w.local ? `在 ${w.device}` : "");
  return [model, place].filter(Boolean).join(" · ");
}

/** “在 lab-mac 跑” / “借 lab-mac 的后端” for a board task sent to another device; “” on this machine. */
export function placeLabel(a: Pick<AttemptPlace, "local" | "device" | "deviceName" | "mode">): string {
  if (!a.mode || a.local) return "";
  const name = a.deviceName || a.device || "另一台设备";
  return a.mode === "remote" ? `在 ${name} 跑` : `借 ${name} 的后端`;
}
/** The words for an attempt whose result came back too late (“” when it did not). */
export const lateText = (a: Pick<AttemptPlace, "lateAt">) => (a.lateAt ? "过了期限才回来，没采用" : "");
/** “只读” / “可写” for an attempt sent to another device. */
export const accessText = (a: Pick<AttemptPlace, "mode" | "access">) => (a.mode && a.access ? (a.access === "write" ? "可写" : "只读") : "");
/** The other device's run page, only when it is a web address (none through a relay). */
export function remoteHref(a: Pick<AttemptPlace, "remoteUrl">): string | null {
  return a.remoteUrl && /^https?:\/\//i.test(a.remoteUrl) ? a.remoteUrl : null;
}

const VERDICT: Record<string, string> = { approved: "通过", changes_requested: "要修改", failed: "没做成", passed: "通过", inconclusive: "说不清" };
export const EVIDENCE_KIND: Record<EvidenceTarget["kind"], string> = { source: "原件", design: "方案", run: "运行", object: "外部对象" };
/** An output's words: evidence by its title, review and trial verdict codes in front as words; no Markdown marks. */
export function outputLabel(o: ProgressOutput): string {
  if (o.kind === "evidence" && o.target) return plainLine(o.target.title || EVIDENCE_KIND[o.target.kind], 80);
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

/** Where a task is seen in full: the place the server names (a router path), else the block's own page. */
export function taskHref(b: Pick<ProgressView, "kind" | "runId" | "itemId">, t: Pick<ProgressTask, "href">): string | null {
  if (t.href) return t.href.replace(/^#/, "");
  return blockHref(b);
}
/** Where the block's own page is (its actions live there). */
export function blockHref(b: Pick<ProgressView, "kind" | "runId" | "itemId">): string | null {
  if (b.kind === "flow" || b.kind === "study") return b.itemId ? `/items/${encodeURIComponent(b.itemId)}/flow` : null;
  return b.runId ? `/runs/${encodeURIComponent(b.runId)}` : null;
}
/** A link for what a task handed in, when it has a page here; commits and branches have none. */
export function outputHref(b: Pick<ProgressView, "kind" | "runId" | "itemId">, o: ProgressOutput): string | null {
  if (o.kind === "commit" || o.kind === "branch" || o.kind === "link") return null;
  if (o.kind === "evidence") {
    const t = o.target;
    if (t?.kind === "source") return `/sources/${encodeURIComponent(t.id)}`;
    if (t?.kind === "design") return `/design/${encodeURIComponent(t.id)}`;
    if (t?.kind === "run") return `/runs/${encodeURIComponent(t.id)}`;
    return null;
  }
  if (o.kind === "page") return /^[\w-]+\/.+/.test(o.ref) ? `/wiki/${o.ref}` : null;
  if (b.kind === "board") return `/runs/${encodeURIComponent(o.ref)}`;
  return blockHref(b);
}

/** An outside address a task handed in (kind `link`), only when it is http(s). */
export function outputUrl(o: ProgressOutput): string | null {
  return o.kind === "link" && /^https?:\/\//i.test(o.ref) ? o.ref : null;
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
