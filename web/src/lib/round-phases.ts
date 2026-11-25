/**
 * A coding round's activity split into what it went through, in order (编码 → 宿主检查 → 阶段评审,
 * and back to 编码 when review feedback comes back within the round): the work page shows one row per
 * stretch, the current one open and the earlier ones folded into a line. Read from the run's events,
 * told apart by the `phase` / `check` / `verify` tags the host puts on them (code.ts, code-overlap.ts,
 * review-chain.ts); host lines without a tag stay in the stretch they happened in.
 */
export type PhaseEvent = { seq: number; at: string; type: string; data: any };
export type SegmentKind = "precheck" | "design" | "coding" | "checking" | "verify" | "review";
export const SEGMENT_LABEL: Record<SegmentKind, string> = { precheck: "编码前检查", design: "写方案", coding: "编码", checking: "宿主检查", verify: "逐项验证", review: "阶段评审" };

/** One session inside a stretch: the coder, a check verifying tasks, a check of the stage review, review-lead. */
export type SessionKey = string;
export type Segment = {
  kind: SegmentKind;
  from: string;
  to: string;
  /** Indexes into the events given, in order. */
  events: number[];
  /** Tool calls (one per call id). */
  steps: number;
  /** Tasks the host's lines in it name (“规范验证 T11”, “检查点 9：完成 T12、T15”), in order. */
  tasks: number[];
  /** The checks the host ran in it. */
  checks: { command: string; code: number; ms?: number; output?: string; space?: string; at: string }[];
  /** Sessions in it, in the order they first spoke. */
  sessions: SessionKey[];
};

const REVIEW_START = /^(评审负责人决定这次评审看什么|阶段评审：|独立评审中)/;

/** Which kind of stretch an event belongs to; null: it stays where it happened (a host line). */
export function eventKind(e: PhaseEvent): SegmentKind | "verify-side" | null {
  const d = e.data ?? {};
  if (e.type === "check") return "checking";
  const text = typeof d.text === "string" ? d.text : "";
  if (e.type === "status" && !d.phase && text.startsWith("运行检查")) return "checking";
  if (d.phase === "pre-check") return "precheck";
  if (d.phase === "design") return "design";
  if (d.phase === "coder") return "coding";
  if (d.phase === "reviewer" && d.verify) return "verify-side";
  if (d.phase === "reviewer" || d.phase === "lead") return "review";
  if (e.type === "status" && !d.phase && REVIEW_START.test(text)) return "review";
  return null;
}

/** The session an event is part of; null for host lines. */
export function sessionOf(e: PhaseEvent): SessionKey | null {
  const d = e.data ?? {};
  if (!d.phase) return null;
  if (d.phase === "reviewer") return `${d.verify ? "verify" : "check"}:${d.check ?? ""}`;
  return d.phase;
}

const TASK_REF = /\bT(\d{1,4})\b/g;

export function roundSegments(events: PhaseEvent[]): Segment[] {
  const out: Segment[] = [];
  const tools = new Map<Segment, Set<string>>();
  let cur: Segment | null = null;
  const open = (kind: SegmentKind, at: string) => {
    cur = { kind, from: at, to: at, events: [], steps: 0, tasks: [], checks: [], sessions: [] };
    out.push(cur);
    tools.set(cur, new Set());
    return cur;
  };
  events.forEach((e, i) => {
    if (e.type === "text-delta" || e.type === "usage") return;
    const k = eventKind(e);
    let seg: Segment = cur ?? open(k === "verify-side" ? "verify" : k ?? "coding", e.at);
    if (k === "verify-side") {
      // A check verifying finished tasks while the coder goes on is part of the coding stretch.
      if (seg.kind !== "coding" && seg.kind !== "verify") seg = open("verify", e.at);
    } else if (k && k !== seg.kind) seg = open(k, e.at);
    seg.events.push(i);
    seg.to = e.at;
    const s = sessionOf(e);
    if (s && !seg.sessions.includes(s)) seg.sessions.push(s);
    if (e.type === "tool") tools.get(seg)!.add(String(e.data?.id ?? e.seq));
    if (e.type === "check") seg.checks.push({ command: String(e.data?.command ?? ""), code: Number(e.data?.code ?? 0), ms: e.data?.ms, output: e.data?.output, space: e.data?.space, at: e.at });
    if (e.type === "status" && !e.data?.phase && typeof e.data?.text === "string")
      for (const m of e.data.text.matchAll(TASK_REF)) { const n = Number(m[1]); if (!seg.tasks.includes(n)) seg.tasks.push(n); }
  });
  for (const s of out) s.steps = tools.get(s)!.size;
  return out;
}

/** “11:45–12:58 · 73 分钟”. */
export function spanText(from: string, to: string, clock: (iso: string) => string) {
  const ms = Date.parse(to) - Date.parse(from);
  const min = Math.round(ms / 60000);
  const long = min >= 90 ? `${Math.floor(min / 60)} 小时${min % 60 ? ` ${min % 60} 分钟` : ""}` : min < 1 ? "不到 1 分钟" : `${min} 分钟`;
  return `${clock(from)}${to !== from ? `–${clock(to)}` : ""} · ${long}`;
}

/** “T11、T12、T15 等 9 项”: a few task numbers, the rest counted. */
export function taskList(tasks: number[], max = 6) {
  const shown = tasks.slice(0, max).map((n) => `T${n}`).join("、");
  return tasks.length > max ? `${shown} 等 ${tasks.length} 项` : shown;
}
