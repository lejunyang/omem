/** Presentation only: the server remains the authority for stage transitions. */
export type StageState = "pending" | "gated" | "doing" | "blocked" | "done" | "skipped" | "stale";
export type FlowStage = {
  id: string; name: string; instruction: string; state: StageState; attempt: number;
  since: string; enteredAt: string | null; doneAt: string | null; by: string | null;
  waitingOn: string | null; evidence: string[]; note: string; gate: string; fixed: boolean;
  question: string | null; carrier: { kind: string; label: string; link?: string };
  object?: { title: string; status: string; link: string };
};
export type FlowDefinition = { id: string; name: string; description?: string; stages: { id: string; name: string; note?: string; gate: string; by: string | { run?: { agent?: string }; object?: string } }[] };
export type FlowFile = { id: string; raw: string; definition: FlowDefinition | null; problem: string | null };
export type FlowView = {
  flow: { id: string; name: string; startedAt: string; endedAt: string | null } | null;
  stages: FlowStage[]; suits: FlowDefinition[];
  log: { id: number; stageId: string; at: string; fromState: StageState | null; toState: StageState; actor: string; note: string; runId: string | null }[];
};
export const stageWords: Record<StageState, string> = { pending: "未到", gated: "等你确认", doing: "进行中", blocked: "卡住", done: "完成", skipped: "跳过", stale: "待复核" };
export const ownerTurn = (s: FlowStage) => s.state === "gated" || s.state === "doing" && (s.by === "owner" || s.waitingOn === "owner" || s.question === "done");
export function stageColour(s: FlowStage) {
  return s.state === "done" ? "ok" : ownerTurn(s) || s.state === "blocked" ? "warn" : s.state === "doing" ? "accent" : "quiet";
}
export function duration(from: string | null, to = Date.now()): string {
  if (!from || !Number.isFinite(Date.parse(from))) return "";
  const minutes = Math.max(0, Math.floor((to - Date.parse(from)) / 60000));
  return minutes < 1 ? "不足 1 分钟" : minutes < 60 ? `${minutes} 分钟` : minutes < 1440 ? `${Math.floor(minutes / 60)} 小时` : `${Math.floor(minutes / 1440)} 天`;
}
export function stageLine(s: FlowStage, now = Date.now()) {
  if (s.state === "done") return duration(s.enteredAt, s.doneAt ? Date.parse(s.doneAt) : now);
  if (ownerTurn(s)) return `等你 · ${duration(s.since, now)}`;
  if (s.state === "doing") return `${duration(s.since, now)}前开始${s.attempt > 1 ? ` · 第 ${s.attempt} 次` : ""}`;
  return s.state === "pending" ? "" : stageWords[s.state];
}
export type FlowAction = { action: "confirm" | "hold" | "skip" | "done" | "reopen"; label: string; reason?: boolean };
export function stageActions(s: FlowStage): FlowAction[] {
  if (s.state === "blocked") return [{ action: "done", label: "我来处理了，继续", reason: true }, { action: "reopen", label: "重开", reason: true }];
  if (s.question === "skip" && ownerTurn(s)) return [{ action: "skip", label: "跳过这一段", reason: true }];
  if (s.question === "refuse" && ownerTurn(s)) return [{ action: "reopen", label: "还不行", reason: true }];
  if (s.question === "done" && ["doing", "gated"].includes(s.state)) return [{ action: "confirm", label: "确认" }, { action: "reopen", label: "还不行", reason: true }];
  if (s.state === "gated") return [{ action: "confirm", label: "开始" }, { action: "hold", label: "先别做" }, { action: "skip", label: "跳过这一段", reason: true }];
  if (s.state === "doing" && s.by === "owner") return [{ action: "done", label: "做完了", reason: true }, { action: "skip", label: "跳过这一段", reason: true }];
  return [];
}
export function nextWords(s: FlowStage) {
  const task = (s.instruction || s.name).replace(/[。！？\s]+$/, "");
  if (s.state === "blocked") return `卡住：${s.waitingOn === "owner" ? "等你处理" : s.waitingOn ? `等 ${s.waitingOn} 回复` : "等待处理"}。${task}。处理好后继续，或重开这一段。`;
  if (s.question === "skip") return `等你补充跳过的原因：${task}。`;
  if (s.question === "refuse") return `等你补充哪里还不行：${task}。写明原因后重开这一段。`;
  if (s.question === "done") return `做完了，确认吗？${task}。确认后继续推进后面的阶段。`;
  if (s.state === "gated") return `要开始这一段了：${task}。你同意才开始。`;
  return `轮到你：${task}。做完点一下，后面的阶段会接着走。`;
}
export function evidenceLink(ref: string) {
  if (ref.startsWith("src:")) return null;
  if (ref.startsWith("design:")) return `#/design/${encodeURIComponent(ref.slice(7))}`;
  return `#/runs/${encodeURIComponent(ref.replace(/^(run:|code-work:)/, ""))}`;
}
export const actorWords = (actor: string) => ({ owner: "你", user: "你", host: "omem", assistant: "助理" }[actor] ?? actor);
export const objectStatusWords = (status: string) => ({ drafting: "在写", review: "等你确认", approved: "已通过", assessed: "已评估", recorded: "已记录", ended: "已结束", running: "进行中", reviewing: "评审中", peer: "等外部 Agent", "owner-tasks": "等你决定", sync: "同步有冲突", stopped: "已停止", assistant: "助手在处理", paused: "已暂停", "review-open": "有问题待定", "review-ok": "评审通过", done: "完成，等你处理", findings: "等你决定要改的问题", design: "确认方案", plan: "确认评审计划", "no-changes": "没有改动", stalled: "停住了" }[status] ?? "等待进展");
