/** Presentation only: the server remains the authority for stage transitions. */
import { dayKey, toWallDate } from "./time.js";
import type { GateReview, PluginEvidence, WaitingSignal } from "./flow-hooks.js";
export type StageState = "pending" | "gated" | "doing" | "blocked" | "done" | "skipped" | "stale";
export type FlowStage = {
  id: string; name: string; instruction: string; state: StageState; attempt: number;
  since: string; enteredAt: string | null; doneAt: string | null; by: string | null;
  waitingOn: string | null; evidence: string[]; note: string; gate: string; fixed: boolean;
  /** `runner`: the plugin's job the stage is given to, by full name and display name (the id again when its plugin is gone). */
  question: string | null; carrier: { kind: string; label: string; link?: string; runner?: { id: string; name: string } };
  /** What the stage follows. A plugin's object says its state in words and may carry a few fields. */
  object?: { title: string; status: string; link: string; statusLabel?: string; fields?: { label: string; value: string }[]; disabled?: boolean };
  /** Rounds, model tier, timing and budget (docs/v2/studies.md): what the definition says, in words, and what has been used. */
  round?: number; waitUntil?: string | null; usedMinutes?: number; escalations?: number;
  budget?: { minutes?: number; trials?: number } | null; escalate?: { to: string; max: number } | null;
  actualAI?: { profile: string; model?: string; effort?: string } | null;
  descriptions?: { ai: string; time: string; budget: string };
  /**
   * The stage completes by itself when this is seen (a push, a merge, a plugin's signal); what the last look found.
   * A plugin's (`type` with a colon) also says whether anyone can answer now, how often asking failed and when it asks again.
   */
  waitingSignal?: WaitingSignal;
  /** What a plugin handed in as evidence (a signal, a job, or a check that stopped the stage). */
  pluginEvidence?: PluginEvidence[];
  /** A plugin's check stopped the stage before it could finish: why, and what was handed in. `askId` is the owner's card. */
  gateReview?: GateReview | null;
  /** The stage asked the owner something that is answered elsewhere on the page: a study's direction for this round. */
  asking?: "direction";
  /** The owner recorded this stage as already done before the flow began. */
  recorded?: boolean;
  /** It began without asking because the owner agreed to that for this gate; stopping it takes the agreement back. */
  autoStarted?: boolean;
  /** What this stage's runs reported case by case (a verification stage), failed first, then the ones not done. */
  tests?: StageTest[];
  /** Screenshots the stage's runs handed in outside test results. */
  shots?: (StageTest["artifacts"][number] & { earlier?: boolean })[];
  /** An upstream stage was reopened while this one was being done: the card asking the owner whether to stop it. */
  upstream?: { askId: string; stage: string; name: string; reason: string } | null;
  /** The card asking the owner about this stage, answered by a button or in words. */
  askId?: string;
  /** What the stage's carrier last wrote in full, when its line is now something else ("本人确认"). */
  result?: string;
};
/** One stage in a flow's review: figures the host worked out from the records when the flow ended (src/flows/review.ts). */
export type StageReview = {
  id: string; name: string; state: StageState; doingMinutes: number; gatedMinutes: number; blockedMinutes: number; ownerMinutes: number;
  blocks: { at: string; minutes: number; waitingOn: string | null; note: string }[];
  starts: number; reopened: number; refused: number; staled: number; escalated: number; reworks: number;
  skipped: boolean; skipNote: string | null; recorded: boolean; rounds: number; streak: number; grantedNow: boolean;
  gate: { asked: number; agreed: number; agreedWithNote: number; held: number; granted: number; direct: boolean };
};
export type FlowReview = {
  how: "completed" | "stopped" | "closed"; startedAt: string; endedAt: string; minutes: number; rounds: number; reworks: number;
  stages: StageReview[]; longestOwnerWait: { stage: string; name: string; minutes: number } | null;
  changes: { total: number; byType: Record<string, number>; byStatus: Record<string, number> };
};
export const reviewHow: Record<FlowReview["how"], string> = { completed: "走完了", stopped: "你停下了", closed: "事项关闭时结束" };
/** "40 分钟", "3.5 小时", "2.1 天": a span of minutes in the unit it reads best in. */
export function minutesWords(n: number) {
  return n < 1 ? "不到 1 分钟" : n < 120 ? `${Math.round(n)} 分钟` : n < 2880 ? `${Math.round(n / 6) / 10} 小时` : `${Math.round(n / 144) / 10} 天`;
}
/** The few things worth a line in a review: why a stage was skipped or stuck, rework, a gate that was let through every time. */
export function reviewNotes(r: FlowReview) {
  const notes: string[] = [];
  for (const s of r.stages) {
    if (s.skipped) notes.push(`「${s.name}」跳过了${s.skipNote ? `：${s.skipNote}` : ""}`);
    if (s.recorded) notes.push(`「${s.name}」是补录的`);
    if (s.blocks.length) notes.push(`「${s.name}」卡住 ${s.blocks.length} 次，共 ${minutesWords(s.blockedMinutes)}：${s.blocks[0].note}`);
    const redo = [s.reopened ? `重开 ${s.reopened} 次` : "", s.refused ? `你说还不行 ${s.refused} 次` : "", s.staled ? `上游重开后复核 ${s.staled} 次` : ""].filter(Boolean);
    if (redo.length) notes.push(`「${s.name}」${redo.join("，")}`);
    if (s.gate.direct) notes.push(`「${s.name}」开始前问了 ${s.gate.asked} 次，你都直接同意了${s.grantedNow ? "（已经授权以后直接开始）" : s.streak ? `（已经连着 ${s.streak} 次）` : ""}`);
  }
  return notes;
}
export type StageTest = {
  id: string; name: string; status: "passed" | "failed" | "skipped"; mode: string; note: string; at: string; runId: string;
  req: { id: string; title: string } | null;
  /** The owner's own word on this case, after looking at what was done. */
  verdict?: "ok" | "wrong" | null; verdictNote?: string | null; verdictAt?: string | null;
  artifacts: { id: string; runId: string; task: number | null; req: string | null; name: string; caption: string; kind: "image" | "video" | "html" | "site" | "text" | "file"; mime: string; size: number; source: "agent" | "check" | "command"; createdBy: string; createdAt: string; url: string }[];
};
export const verdictWords: Record<"ok" | "wrong", string> = { ok: "你看过，对", wrong: "你看过，不对" };
export const testWords: Record<StageTest["status"], string> = { passed: "通过", failed: "没通过", skipped: "没做" };
/** "5 条：通过 3，没通过 1，没做 1" — the ones that are zero are left out. */
export function testSummary(tests: StageTest[]) {
  const n = (s: StageTest["status"]) => tests.filter((t) => t.status === s).length;
  return `${tests.length} 条：${(["passed", "failed", "skipped"] as const).filter((s) => n(s)).map((s) => `${testWords[s]} ${n(s)}`).join("，")}`;
}
export type FlowDefinition = { id: string; name: string; description?: string; stages: { id: string; name: string; note?: string; gate: string; by: string | { run?: { agent?: string }; object?: string } }[] };
export type FlowFile = { id: string; raw: string; definition: FlowDefinition | null; problem: string | null; /** Gates of this flow the owner agreed to stop being asked at. */ grants?: { stage: string; grantedAt: string }[] };
/** Something this item's chats and documents said after the flow began, as the follow-up run put it (docs/v2/flows.md). */
export type FlowChange = {
  id: string; at: string; type: "scope" | "decision" | "deadline" | "blocker" | "info"; summary: string; detail: string | null;
  req: string | null; stages: string[]; refs: string[]; runId: string;
  status: "noted" | "asked" | "merged" | "split" | "dismissed"; askId: string | null;
  /** The time a deadline change names. Somebody's proposal waits for the owner; a settled one has already moved the deadline. */
  due?: string | null;
};
/** A chat or document the flow keeps reading, and how much new content is waiting to be read together. */
export type FollowPlace = { sourceId: string; title: string; pending: number; latestAt: string | null };
export const changeWords: Record<FlowChange["type"], string> = { scope: "范围", decision: "决定", deadline: "截止时间", blocker: "阻塞", info: "信息" };
export function changeStatus(c: FlowChange) {
  if (c.status === "asked") return "等你定";
  if (c.status === "merged") return c.type === "deadline" ? "截止时间已改" : "已并进这件事";
  if (c.status === "split") return "另开了一件事";
  if (c.status === "dismissed") return c.type === "deadline" ? "没有改" : "不用管";
  return "记下了";
}
/** How a change that waits for the owner is announced. */
export const changeHeads: Record<FlowChange["type"], string> = { scope: "范围变了", decision: "有了新决定", deadline: "有人提出改期", blocker: "有阻塞", info: "新信息" };
const scopeChoices = [{ choice: "merge", label: "并进这件事" }, { choice: "split", label: "另开一件事" }, { choice: "dismiss", label: "不用管" }];
const deadlineChoices = [{ choice: "merge", label: "改成这个时间" }, { choice: "dismiss", label: "不改" }];
/** What the owner can answer: a proposed deadline is taken or left, anything else is folded in, split off or left. */
export const changeChoices = (c: FlowChange) => c.type === "deadline" ? deadlineChoices : scopeChoices;
export type FlowView = {
  flow: { id: string; name: string; startedAt: string; endedAt: string | null; round?: number; repeat?: { from: string; every: string | string[] } | null; roundClosedAt?: string | null; nextRoundAt?: string | null; canStartRound?: boolean; repeatDescription?: string; /** A study: directions, trials and findings are kept for it. */ study?: boolean; idleRounds?: number; /** Today's limit of follow-up batches was reached; the rest waits for tomorrow. */ followCapped?: boolean } | null;
  /** What changed around this item since the flow began: the ones waiting for the owner and the latest ten. */
  changes?: FlowChange[];
  follow?: FollowPlace[];
  /** Earlier rounds of a repeating flow, newest first: how each stage ended. */
  rounds?: { round: number; endedAt: string; stages: { id: string; state: StageState; note: string }[] }[];
  stages: FlowStage[]; suits: FlowDefinition[];
  log: { id: number; stageId: string; at: string; fromState: StageState | null; toState: StageState; actor: string; note: string; runId: string | null }[];
  /** How it went, once the flow ended. */
  review?: FlowReview | null;
};
/** One item on the flow board: the stage to look at now and whether it waits for the owner. */
export type BoardRow = {
  itemId: string; title: string; spaceId: string; flowId: string; flowName: string; round?: number | null;
  stage: { id: string; name: string; state: StageState }; waiting: "owner" | "blocked" | null; since: string | null; stale: boolean; dueAt: string | null;
};
/** "等你 · 3 天" / "卡住 · 2 天" / "进行中 · 5 小时" / "还没开始". */
export function boardLine(r: BoardRow, now = Date.now()) {
  const how = duration(r.since, now);
  if (r.stage.state === "blocked") return how ? `卡住 · ${how}` : "卡住";
  if (r.waiting === "owner") return how ? `等你 · ${how}` : "等你";
  if (r.stage.state === "doing") return how ? `进行中 · ${how}` : "进行中";
  return r.stage.state === "pending" ? "还没开始" : stageWords[r.stage.state];
}
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
/**
 * `who`: the name of the person whose item it is, when that is not whoever reads the page (an observer,
 * another member): their turn reads “等 小王”, not “等你”.
 */
export function stageLine(s: FlowStage, now = Date.now(), who?: string | null) {
  if (s.state === "done") return s.recorded ? "补录" : duration(s.enteredAt, s.doneAt ? Date.parse(s.doneAt) : now);
  if (ownerTurn(s)) return `${who ? `等 ${who}` : "等你"} · ${duration(s.since, now)}`;
  if (s.state === "doing") return `${duration(s.since, now)}前开始${s.attempt > 1 ? ` · 第 ${s.attempt} 次` : ""}`;
  if (s.state === "pending") return s.waitUntil ? `等到 ${clockTime(s.waitUntil)}` : "";
  return stageWords[s.state];
}
/** A moment as the reader's clock shows it: the time today, the date as well on another day. */
export function clockTime(at: string) {
  if (Number.isNaN(new Date(at).getTime())) return at;
  const t = toWallDate(at);
  const time = `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
  return dayKey(at) === dayKey(Date.now()) ? time : `${t.getMonth() + 1}-${String(t.getDate()).padStart(2, "0")} ${time}`;
}
/** The model a stage ran on, as short as it can be said. */
export const aiName = (ai: { profile: string; model?: string; effort?: string }) => [ai.profile, ai.model, ai.effort].filter(Boolean).join(" · ");
export type FlowAction = { action: "confirm" | "hold" | "skip" | "done" | "reopen"; label: string; reason?: boolean };
export function stageActions(s: FlowStage): FlowAction[] {
  // Stopped by a plugin's check: 仍然通过 / 等处理 are the card's (FlowStagePlugin) while it waits for an answer;
  // after 等处理, finishing again checks again.
  if (s.state === "blocked" && s.gateReview) return [...(s.gateReview.ask?.status === "pending" ? [] : [{ action: "done" as const, label: "处理好了，重新检查", reason: true }]), { action: "reopen", label: "重开", reason: true }];
  if (s.state === "blocked") return [{ action: "done", label: "我来处理了，继续", reason: true }, { action: "reopen", label: "重开", reason: true }];
  if (s.question === "skip" && ownerTurn(s)) return [{ action: "skip", label: "跳过这一段", reason: true }];
  if (s.question === "refuse" && ownerTurn(s)) return [{ action: "reopen", label: "还不行", reason: true }];
  if (s.question === "done" && ["doing", "gated"].includes(s.state)) return [{ action: "confirm", label: "确认" }, { action: "reopen", label: "还不行", reason: true }];
  if (s.state === "gated") return [{ action: "confirm", label: "开始" }, { action: "hold", label: "先别做" }, { action: "skip", label: "跳过这一段", reason: true }];
  if (s.state === "doing" && s.by === "owner") return [{ action: "done", label: "做完了" }, { action: "skip", label: "跳过这一段", reason: true }];
  return [];
}
export function nextWords(s: FlowStage, who?: string | null) {
  const task = (s.instruction || s.name).replace(/[。！？\s]+$/, "");
  // Someone else's turn (see stageLine): what it waits for, without telling the reader to do it.
  if (who) {
    if (s.state === "blocked" && s.gateReview) return `被检查拦下，等 ${who} 处理：${task}。`;
    if (s.state === "blocked") return `卡住了，等 ${s.waitingOn === "owner" ? who : s.waitingOn || who} 处理：${task}。`;
    if (s.question === "done") return `做完了，等 ${who} 确认：${task}。`;
    if (s.state === "gated") return `要开始这一段了，等 ${who} 同意：${task}。`;
    return `等 ${who}：${task}。`;
  }
  if (s.state === "blocked" && s.gateReview) return `${s.instruction ? task + "。" : ""}核对下面的原因和证据：这一次仍然通过，或者等处理好以后重新检查。`;
  if (s.state === "blocked") return `卡住：${s.waitingOn === "owner" ? "等你处理" : s.waitingOn ? `等 ${s.waitingOn} 回复` : "等待处理"}。${task}。处理好后继续，或重开这一段。`;
  if (s.question === "skip") return `等你补充跳过的原因：${task}。`;
  if (s.question === "refuse") return `等你补充哪里还不行：${task}。写明原因后重开这一段。`;
  if (s.question === "done") return `做完了，确认吗？${task}。确认后继续推进后面的阶段。`;
  if (s.asking === "direction") return "这一轮的方向提出来了：在下面的台账里选一个，或者这一轮不跑。";
  if (s.state === "gated") return `要开始这一段了：${task}。你同意才开始。`;
  if (s.waitingSignal?.type.includes(":")) return `轮到你：${task}。${s.waitingSignal.available === false ? "等的信号现在没人能判断，做完以后点一下。" : "插件看到信号后这一段会自己完成；也可以直接点做完。"}`;
  if (s.waitingSignal) return `轮到你：${task}。${s.waitingSignal.type === "git.merged" ? "合进目标分支" : "推到远端"}以后这一段会自己完成，后面的阶段接着走；也可以直接点做完。`;
  return `轮到你：${task}。做完点一下，后面的阶段会接着走。`;
}
/**
 * Where a reference that is no citation opens: a plan, a run (`r0…`, `run:`, `code-work:`), an item's page
 * (`i0…`, `item:`). Anything else (a stage, a metric's name, a platform object) is no link: null, shown as text,
 * so it never opens an empty runs page.
 */
export function evidenceLink(ref: string) {
  const r = ref.trim();
  if (r.startsWith("design:")) return `#/design/${encodeURIComponent(r.slice(7))}`;
  const run = RUN_REF.exec(r);
  if (run) return `#/runs/${encodeURIComponent(run[1] ?? run[2])}`;
  const item = ITEM_REF.exec(r);
  if (item) return `#/work/${encodeURIComponent(item[1] ?? item[2])}`;
  return null;
}
/** A run: named with its prefix (any id), or a bare run id; an item likewise (src/items/changes.ts reads them the same way). */
const RUN_REF = /^(?:(?:run|code-work):([\w-]+)|(r[0-9a-z]{15,30}))$/;
const ITEM_REF = /^(?:item:([\w-]+)|(i[0-9a-z]{15,30}))$/;
/** What such a link is, in a word (“方案 / 运行 / 事项”). */
export const evidenceWord = (ref: string) => (ref.startsWith("design:") ? "方案" : ITEM_REF.test(ref.trim()) ? "事项" : "运行");
export const actorWords = (actor: string) => ({ owner: "你", user: "你", host: "omem", assistant: "助理" }[actor] ?? actor);
export const objectStatusWords = (status: string) => ({ drafting: "在写", review: "等你确认", approved: "已通过", assessed: "已评估", recorded: "已记录", ended: "已结束", running: "进行中", reviewing: "评审中", peer: "等外部 Agent", "owner-tasks": "等你决定", sync: "同步有冲突", stopped: "已停止", assistant: "助手在处理", paused: "已暂停", "review-open": "有问题待定", "review-ok": "评审通过", confirmed: "还没开始试", active: "在试", done: "完成，等你处理", findings: "等你决定要改的问题", design: "确认方案", plan: "确认评审计划", "no-changes": "没有改动", stalled: "停住了" }[status] ?? "等待进展");
