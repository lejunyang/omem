import { continuedUpstream, finishStage, overrideStageGate } from "./plugin-gates.ts";
import { pollFlowSignal } from "./plugin-signals.ts";
import { spacesWithCapability } from "../auth/capabilities.ts";
import { requireItem } from "../items/access.ts";
import type { App, AppEvent } from "../core/app.ts";
import { latestEach, testsOfRuns } from "../items/req-tests.ts";
import { artifactsByIds, runImages } from "../agents/artifacts.ts";
import { all, one, run } from "../core/db.ts";
import { decide, decisionReady, describeDecision } from "../core/decision.ts";
import { notify } from "../core/notify.ts";
import { HttpError, json, now, truncate } from "../core/util.ts";
import { cancelAsk, createAsk, getAsk, registerAskHandler, type Ask } from "../agents/asks.ts";
import { stopRun, createRun, getRun, registerHandler } from "../agents/runs.ts";
import { validateExecution, executionArgs, type Execution } from "../agents/execution.ts";
import { dailyCapReached, outOfQuotaUntil } from "../agents/capacity.ts";
import { roleNames, type RoleName } from "../core/config.ts";
import { userBy } from "../core/run-trigger.ts";
import { findAgentSpec, readSkill, skillUsable } from "../agents/specs.ts";
import { getItem, type Item } from "../items/store.ts";
import { addLocalMaterials, materialsBrief } from "../items/materials.ts";
import { itemPlaces } from "../items/places.ts";
import { createDesign } from "../designs/store.ts";
import { hasRunner, runnerApproved, retainItemRunnerGrant, flowAppliesTo, flowsFor, parseFlow, parseFlowForSave, runnerIdentity, readFlow, saveFlow, type FlowStage, describeStage, describeFlow, budgetSchema } from "./definitions.ts";
import { stageTiming, nextRoundAt, roundDayMatches, timeLabel } from "./timing.ts";
import { codeWorkSettledAt, codeWorkSince, findObject, latestCodeWork, objectKind } from "./objects.ts";
import { pollObjects } from "./plugin-objects.ts";
import { checkGitSignals, waitingSignal } from "./signals.ts";
import { agreedGate, gateGranted, resetGateStreak, revokeGate } from "./gates.ts";
import { continuing, idleRounds, isStudy } from "../studies/store.ts";
import { cancelTrials, isTrials, tickTrials } from "../studies/trials.ts";
import { capabilitiesPath, planningMaterials } from "../studies/materials.ts";
import { envMaterials, trialStage } from "../studies/envs.ts";
import { trial } from "../studies/store.ts";
import { isFixes, tickFixes, cancelFixReruns, fixModelStage, fixMinutes } from "../studies/fixes.ts";
import { pushAuthorized, pushSummary } from "../studies/push.ts";
import { isClosed } from "../items/store.ts";
import { initFollow, followContexts, followLimit, followView, shownChanges, changesBrief } from "./follow.ts";
import { atomic, changeStage, flushProgress, markProgress, getStage, itemFlow, itemStages, stageLog, roundHistory, type FlowActor, type ItemFlow, type StageRow, type StageControl, type StageLink } from "./store.ts";
import { saveReview, storedReview, type FlowEnd } from "./review.ts";
import { stopCodeWork } from "../agents/code-steer.ts";

const host: FlowActor = { actor: "host" };
// This is an execution lock, not a projection/cache: each pass reads the item's own rows.
const queues = new WeakMap<App, Map<string, Promise<unknown>>>();
function serial<T>(app: App, id: string, fn: () => Promise<T>): Promise<T> {
  let map = queues.get(app);
  if (!map) queues.set(app, map = new Map());
  const prev = map.get(id) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn).finally(() => {
    // The card shows where the flow stands after the whole operation, once.
    try { flushProgress(app, id); } catch (e) { console.warn(`[omem] 流程进度没有发出：${(e as Error).message}`); }
  });
  map.set(id, next);
  void next.finally(() => { if (map!.get(id) === next) map!.delete(id); }).catch(() => {});
  return next;
}
function running(app: App, id: string) {
  const f = itemFlow(app, id);
  if (!f || f.endedAt) throw new HttpError(409, "事项没有进行中的流程");
  return f;
}
/** Study writes and owner choices share the flow's existing execution lock. */
export function studyOperation<T>(app: App, itemId: string, fn: () => Promise<T>) {
  return serial(app, itemId, async () => {
    const result = await fn();
    await advanceNow(app, itemId, "课题台账变化");
    app.emit({ type: "changed", entity: "item", id: itemId });
    return result;
  });
}
function definition(f: ItemFlow, id: string) {
  const s = f.definition.stages.find((x) => x.id === id);
  if (!s) throw new HttpError(404, `没有阶段 ${id}`);
  return s;
}
function resetStreak(app: App, id: string) { run(app.db, "update item_flows set auto_streak=0,updated_at=? where item_id=?", now(), id); }
function withdraw(app: App, s: StageRow) { if (s.askId) cancelAsk(app, s.askId, "阶段已有新的状态"); }
/** Take back the card asking whether to stop this stage after an upstream reopen (it is not the stage's own question). */
function dropUpstream(app: App, s: StageRow, why: string): StageRow {
  if (!s.control.upstream) return s;
  cancelAsk(app, s.control.upstream.askId, why);
  const control = { ...s.control, upstream: undefined };
  run(app.db, "update item_stages set control=?,updated_at=? where item_id=? and stage_id=?", JSON.stringify(control), now(), s.itemId, s.id);
  return { ...s, control };
}
const stageName = (f: ItemFlow, id: string) => f.definition.stages.find((d) => d.id === id)?.name ?? id;
/**
 * An upstream stage was reopened while this one was being done: it goes on, and the owner is asked
 * whether to stop it. A newer reopen replaces the card.
 */
function askUpstream(app: App, f: ItemFlow, d: FlowStage, s: StageRow, from: string, reason: string, refs: string[], by: FlowActor) {
  s = dropUpstream(app, s, `「${stageName(f, from)}」又重开了，换成新的一张`);
  const item = getItem(app, f.itemId), up = stageName(f, from);
  const ask = createAsk(app, { runId: null, userId: item.userId, allowText: false, options: [{ label: "停下" }, { label: "继续做" }],
    question: `「${item.title}」的「${up}」重开了：${truncate(reason.trim(), 300)}\n\n正在做的「${d.name}」是按重开前的「${up}」做的，要停下吗？\n- 停下：取消这一段正在做的，等「${up}」做完再重新做\n- 继续做：接着做完，不再问`,
    context: { handler: "flow-stage", itemId: f.itemId, stageId: d.id, startedAt: f.startedAt, kind: "upstream" } });
  changeStage(app, f.itemId, d.id, s.state, { control: { ...s.control, upstream: { askId: ask.id, stage: from, reason: truncate(reason.trim(), 500) } } }, by, `上游「${up}」重开了，问本人要不要停下这一段`, refs, "upstream-ask");
}
/** The owner's answer: stop it (cancel what it is doing, stale until the upstream is done) or let it go on. */
async function answerUpstream(app: App, f: ItemFlow, d: FlowStage, s: StageRow, stop: boolean) {
  const up = stageName(f, s.control.upstream!.stage), reason = s.control.upstream!.reason;
  const owner: FlowActor = { actor: "owner", userId: getItem(app, f.itemId).userId };
  if (!stop) { changeStage(app, f.itemId, d.id, s.state, { control: { ...s.control, upstream: undefined } }, owner, `上游「${up}」重开了，本人让这一段接着做`, [], "upstream-continue"); return; }
  resetStreak(app, f.itemId);
  if (isTrials(d)) await cancelTrials(app, f.itemId);
  if (isFixes(d)) await cancelFixReruns(app, f.itemId);
  if (s.control.runId) await stopStageRun(app, s.itemId, s.control.runId);
  // A delegation is stopped where it stands, never discarded: its workspace and branch stay for the redo.
  let kept = "";
  if (s.by?.startsWith("code-work:")) {
    try { if (stopCodeWork(app, s.by.slice("code-work:".length), `上游「${up}」重开了，本人让这一段先停下`).stopped.length) kept = "；交办正在做的一轮停下了，工作区和分支都留着"; }
    catch (e) { console.warn(`[omem] 交办没有停下：${(e as Error).message}`); }
  }
  withdraw(app, s);
  changeStage(app, f.itemId, d.id, "stale", { askId: null, waitingOn: null, control: { ...finishUsage(app, s, new Date()), upstream: undefined, runId: undefined, reported: false, question: undefined, confirmed: undefined, waitUntil: undefined, admitted: undefined, objectAfter: now(), feedback: `上游「${up}」重开了：${reason}。按重做后的「${up}」重新做这一段` } },
    owner, `上游「${up}」重开了，本人让这一段停下，等「${up}」做完再重新开始${kept}`, [], "upstream-stop");
  await advanceNow(app, f.itemId, "本人让下游停下");
}
/**
 * A stage asked about leaves doing without an answer: the card goes. One that got done was done against
 * the upstream as it was before the reopen, so it waits to be checked again like any done stage would.
 */
function settleUpstream(app: App, itemId: string) {
  const f = itemFlow(app, itemId)!;
  let changed = false;
  for (const s of itemStages(app, itemId)) {
    if (!s.control.upstream || s.state === "doing") continue;
    const up = stageName(f, s.control.upstream.stage);
    if (s.state !== "done" && !s.control.gateReview) { dropUpstream(app, s, "这一段已有新的状态"); continue; }
    if (s.control.gateReview) withdraw(app, s);
    cancelAsk(app, s.control.upstream.askId, "这一段已经做完");
    changeStage(app, itemId, s.id, "stale", { askId: null, waitingOn: null, control: { ...s.control, upstream: undefined, gateReview: undefined, gateReviewResult: undefined } }, host, `做完时上游「${up}」还在重做、本人没答要不要停：它是按重开前的「${up}」做的，等「${up}」做完再复核`, [], "upstream-done");
    changed = true;
  }
  return changed;
}
type AskParts = { ask: string; result?: string; evidence?: string[]; plan?: boolean; before?: boolean; after?: boolean };
/**
 * A question the owner can decide from the card alone: which item and stage, what is being decided,
 * then only what bears on it (the result, what the stage will do, what is done before it, what starts
 * after it, how much evidence) as short labelled paragraphs. Internal ids stay on the item page.
 */
function askText(app: App, f: ItemFlow, d: FlowStage, p: AskParts) {
  const rows = itemStages(app, f.itemId), item = getItem(app, f.itemId);
  const ups = d.needs.map((id) => ({ def: f.definition.stages.find((x) => x.id === id), row: rows.find((r) => r.id === id) })).filter((u) => u.def && u.row && ["done", "skipped"].includes(u.row.state));
  const next = f.definition.stages.filter((x) => x.needs.includes(d.id)).map((x) => x.name);
  const w = describeStage(d);
  return [
    // What is asked comes first (src/agents/brief.ts); which item it is about, right under it.
    `**「${d.name}」${p.ask}**`,
    `事项：${item.title}`,
    p.result ? `**结果**\n${askNote(p.result, 800)}` : "",
    p.plan && d.note ? `**这一段做什么**\n${askNote(d.note, 400)}\n（${w.carrier}；${w.done}）` : "",
    p.before && ups.length ? `**前面**\n${ups.map((u) => { const note = resultNote(app, f.itemId, u.row!); return `- ${u.def!.name}：${u.row!.state === "skipped" ? "跳过" : "已完成"}${note ? `，${askNote(note, 120)}` : ""}`; }).join("\n")}` : "",
    p.after && next.length ? `**之后**\n确认后接着：${next.join("、")}` : "",
    p.evidence?.length ? `**依据**\n${p.evidence.length} 项，在这件事的流程页「${d.name}」一段下面可以打开。` : "",
  ].filter(Boolean).join("\n\n");
}
// The owner's "确认" overwrites a stage's latest line; what the stage produced is the last thing its
// carrier said, falling back to that line.
function resultNote(app: App, itemId: string, row: StageRow) {
  const said = one<{ note: string }>(app.db, "select note from item_stage_log where item_id=? and stage_id=? and actor not in ('host','owner') and note<>'' order by id desc limit 1", itemId, row.id);
  return said?.note ?? row.note;
}
/** What the stage's carrier last wrote in full, when the stage's line is now something else ("本人确认"). */
function stageResult(app: App, itemId: string, row: StageRow) {
  const r = resultNote(app, itemId, row);
  return r && r !== row.note && !ROUTINE.has(r) && !WAITING_NOTE.test(r) ? r : "";
}
const askNote = (note: string, max: number) => truncate(note.replace(/\s*[（(]?\b(?:ask|r|n|i)0m[0-9a-z]{10,}\b[）)]?/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim(), max);

function question(app: App, f: ItemFlow, d: FlowStage, s: StageRow, kind: NonNullable<StageRow["control"]["question"]>, parts: AskParts, labels: string[]) {
  if (s.askId && getAsk(app, s.askId).status === "pending" && s.control.question === kind) return s.askId;
  withdraw(app, s);
  const text = askText(app, f, d, parts);
  return createAsk(app, { runId: null, userId: getItem(app, f.itemId).userId, question: text, options: labels.map((label) => ({ label })), allowText: true,
    context: { handler: "flow-stage", itemId: f.itemId, stageId: d.id, startedAt: f.startedAt, kind } }).id;
}
function gate(app: App, f: ItemFlow, d: FlowStage, s: StageRow, kind: "when" | "gate") {
  const askId = question(app, f, d, s, kind, kind === "when" ? { ask: `这一段要做吗？条件是：${d.when}`, plan: true, before: true } : { ask: "轮到这一段了，开始吗？", plan: true, before: true }, kind === "when" ? ["要做", "跳过"] : ["开始", "先别做", "跳过这一段"]);
  const limit = kind === "gate" && f.autoStreak >= app.config.flows.autoAdvance;
  changeStage(app, f.itemId, d.id, "gated", { askId, waitingOn: "owner", control: { ...s.control, question: kind, gateLimit: limit } }, host, kind === "when" ? "等本人判断这一段是否需要" : "等本人确认开始", [], kind === "when" ? "when-ask" : limit ? "limit-ask" : "gate-ask");
}

// The few most recent places; read_item lists them all with their latest lines.
function placesBrief(app: App, item: Item) {
  const all_ = itemPlaces(app, item.id, item.userId), shown = all_.slice(-5);
  if (!all_.length) return "进行的地方：尚未关联会话";
  return `进行的地方（最近 ${shown.length} 处${all_.length > shown.length ? `，共 ${all_.length} 处，用 read_item 看全部` : ""}）：\n${shown.map((p) => `- ${p.title.slice(0, 80)}（${p.ref}）：${p.summary.slice(0, 200)}`).join("\n")}`;
}

const ownerTurn = (app: App, f: ItemFlow, d: FlowStage, s: StageRow) =>
  question(app, f, d, { ...s, askId: null }, "owner", { ask: "轮到你了。做完点“做完了”。", plan: true, before: true, after: true }, ["做完了", "这一段跳过"]);
/** What the owner wrote in this round when they finished, skipped or redid stages, newest first ("将问题发到 MR 吧"). */
function ownerWords(app: App, f: ItemFlow, stages?: string[]) {
  return all<{ stage_id: string; note: string; at: string }>(app.db, `select stage_id, note, at from item_stage_log where item_id=? and round=? and actor='owner' and (to_state in ('done','skipped') or event='refuse') and note<>''
    ${stages ? `and stage_id in (select value from json_each(?))` : ""} and at>=? order by id desc limit 6`, f.itemId, f.round, ...(stages ? [JSON.stringify(stages)] : []), f.roundStartedAt)
    .filter((r) => !ROUTINE.has(r.note) && !OWNER_DEFAULT.has(r.note) && !r.note.startsWith("上游「"));
}
function ownerSaidBrief(app: App, f: ItemFlow) {
  const words = ownerWords(app, f);
  return words.length ? `本人在这一轮前面几段说的（以这些为准）：\n${words.map((r) => `- 「${stageName(f, r.stage_id)}」：${truncate(r.note, 400)}`).join("\n")}` : "";
}
const OWNER_DEFAULT = new Set(["本人确认完成", "本人做完了", "本人确认", "本人同意开始", "本人判断这一段要做"]);
/**
 * The owner's turn comes right after they finished the stage before it with words that already settle
 * it ("评审结论" finished with "将问题发到 MR 吧" settles "挑问题"): asking again is asking twice. A
 * decision model reads the words against what this stage asks; unsure or unavailable asks the owner.
 */
async function ownerAlreadySaid(app: App, item: Item, f: ItemFlow, d: FlowStage) {
  if (!d.needs.length || !decisionReady(app)) return null;
  const said = ownerWords(app, f, d.needs).find((r) => {
    const up = getStage(app, item.id, r.stage_id);
    return up.state === "done" && up.note === r.note;
  });
  if (!said) return null;
  const from = stageName(f, said.stage_id);
  try {
    const answer = await decide(app, { 事项: item.title, 本人在上一段说的: { 阶段: from, 原话: said.note }, 这一段: { 名称: d.name, 本人要做的: d.note ?? "", 完成条件: typeof d.done === "string" ? d.done : "本人说做完了" } },
      { type: "yesno", instructions: "本人完成上一段时写了这句话。按这句话，这一段要本人做的事是否已经定了（等于本人对这一段说了“做完了”）？只是相关、只说了一部分、或还要本人另外去做，答否。" });
    return answer?.choice === "yes" && (answer.probabilities.yes ?? 1) >= 0.7 ? { from, note: said.note } : null;
  } catch { return null; }
}
/** The owner's turn, asked once its signal check found the stage not done yet. */
function askOwnerNow(app: App, itemId: string, stageId: string, startedAt: string, attempt: number) {
  const f = itemFlow(app, itemId);
  if (!f || f.endedAt || f.startedAt !== startedAt) return;
  const s = getStage(app, itemId, stageId);
  if (s.state !== "doing" || s.attempt !== attempt || s.askId) return;
  changeStage(app, itemId, stageId, "doing", { askId: ownerTurn(app, f, definition(f, stageId), s) }, host, s.note);
}

async function stageTask(app: App, item: Item, f: ItemFlow, d: FlowStage, feedback?: string) {
  const rows = itemStages(app, item.id);
  const planner = d.tools?.includes("propose_directions");
  // A stage following a review of someone's branch: redoing it means reviewing again, never coding.
  const latest = typeof d.by === "object" && "object" in d.by && d.by.object === "code-work" ? latestCodeWork(app, item) : null;
  const review = latest?.branchReview ? latest : null;
  return [planner ? `## 所属事项：${item.title}（${item.id}）\n${item.detail}\n\n${await planningMaterials(app, item)}` : await materialsBrief(app, item.id, item.userId, { compact: true }), `截止时间：${item.dueAt ?? "未定"}`,
    changesBrief(app, item.id),
    ownerSaidBrief(app, f),
    placesBrief(app, item),
    `## 流程：${f.definition.name}\n${f.definition.stages.map((s) => `- ${s.id} ${s.name}：${rows.find((r) => r.id === s.id)?.state ?? "pending"}`).join("\n")}`,
    `## 这一段：${d.name}（${d.id}）\n${d.note ?? ""}`,
    `完成要求：${typeof d.done === "string" ? d.done : d.done ? JSON.stringify(d.done) : "做完这一段并附上依据"}`,
    typeof d.by === "object" && "object" in d.by ? d.by.object === "code-work" && review ? `这一段跟着分支评审「${review.title}」（${review.rootId}）：它只出评审意见，不是编码。要按本人的意见补查，用 review_branch 带 rereview_of=${review.latestId}，把意见写进 note（群聊、作者回复这类外面来的写进 inputs）；不要发起 delegate_code、不要改作者的代码。复审开始以后就结束，不用 stage_report，流程跟着复审出结论；本人的意见不需要复审（只是告知、或该作者自己改）时，用 stage_report 报 blocked 写清楚，交给本人定。` : d.by.object === "code-work" ? `按这件事的需求点发起交办，delegate_code 带上 item_id=${item.id}；同一分支上已有别的事项的交办在进行时，用 continue_code_run 把这件的修改交给它（when: now，new_item: true，item_id=${item.id}）。事项上已经有一个在做的交办、要改的已经在里面（本人先直接交办了）：不用再发，交代一句是哪个交办就结束。交办开始或并进去以后，这一段由流程跟着交办走、评审通过就完成：不要用 stage_report 报 blocked 去等交办，交代一句交给了哪个交办就结束；只有发不出交办、要本人拍板时才报 blocked。` : `为这件事写方案，交给本人确认。` : "",
    feedback ? rows.find((s) => s.id === d.id)?.control.escalated ? `上一次的结论或错误：${feedback}。这一轮重新核对并交结果。` : `本人说还不行，原因：${feedback}。这一轮按这个意见重做。` : "",
    typeof d.by === "object" && "run" in d.by && d.by.run.skill === "study-map" ? `功能清单用 write_file(path="${capabilitiesPath(item.id)}", space="${item.spaceId}", item="${item.id}", content=...) 写成工作文件；stage_report 的 evidence 填返回的 src: 引用。不要写 Wiki 页。` : "",
    planner ? `结束前用 propose_directions(item="${item.id}", directions=[...], note?) 交提案，允许空数组。这一段不能读取台账，不用 stage_report 完成，等本人选定以后宿主会推进。` : typeof d.by === "object" && "object" in d.by && d.by.object === "code-work" && review ? "" : typeof d.by === "object" && "object" in d.by && d.by.object === "code-work" ? `发起或并进交办（或确认要改的已在事项上在做的交办里）后就结束，不用 stage_report；发不出交办时用 stage_report(item="${item.id}", stage="${d.id}") 报 blocked 写清等谁或等什么，不要替本人确认。` : `结束前必须用 stage_report(item="${item.id}", stage="${d.id}") 交代：done 附依据；blocked 写等谁或等什么；skip 写原因。不要以运行结束代替交结果；不要替本人确认。`,
    planner ? envMaterials(app, item.id) : "",
  ].filter(Boolean).join("\n\n");
}

async function stageAI(app: App, f: ItemFlow, d: FlowStage, s: StageRow, at: Date) {
  const choice = s.control.escalated && d.escalate ? d.escalate.to : d.ai;
  const pick = typeof choice === "string" ? app.config.agents.tiers[choice] : choice;
  if (choice && !pick && !s.control.tierFallback?.includes(String(choice))) {
    s = changeStage(app, f.itemId, d.id, s.state, { control: { ...s.control, tierFallback: [...s.control.tierFallback ?? [], String(choice)] } }, host, `档位 ${choice} 没有配置，用了默认的 AI`);
  }
  if (!pick) return { s, execution: undefined, waitUntil: null };
  const execution = validateExecution(app, { ...pick, source: "flow", reason: `流程「${f.definition.name}」的「${d.name}」阶段指定` })!;
  const { resolveRunProfile } = await import("../agents/runner.ts");
  const name = typeof d.by === "object" ? "run" in d.by ? d.by.run.agent ?? "assistant" : "agent" in d.by ? d.by.agent ?? "assistant" : "assistant" : "assistant";
  const role = (roleNames as readonly string[]).includes(name) ? name as RoleName : null;
  const spec = role ? null : findAgentSpec(app, name);
  if (!role && !spec) throw new HttpError(400, `没有 Agent 档案 ${name}`);
  const profile = resolveRunProfile(app, { actor: spec ? { spec } : { role: role! }, ...executionArgs(execution) });
  const actual = validateExecution(app, { ...execution, model: profile.model, effort: profile.effort })!;
  const until = outOfQuotaUntil(app, profile, at);
  const daily = dailyCapReached(app, profile, at.getTime());
  return { s, execution: actual, waitUntil: until ?? (daily ? nextRoundAt(at, app.config.timezone, "day") : null) };
}

/** One item in a stage run (several when the stage is `together: push`). */
type StageItem = { itemId: string; title: string; spaceId: string; flowStartedAt: string; round: number; task: string };
const BATCH_WAIT_MS = 60_000;

/** The items a flow stage run is for: the batch's, or the one it was started for. */
export function stageItemsOf(input: Record<string, unknown>): string[] {
  if (Array.isArray(input.items) && input.items.length) return (input.items as StageItem[]).map((x) => x.itemId);
  return typeof input.itemId === "string" ? [input.itemId] : [];
}
function stageItemStart(input: Record<string, unknown>, itemId: string) {
  return (Array.isArray(input.items) ? (input.items as StageItem[]).find((x) => x.itemId === itemId)?.flowStartedAt : undefined) ?? input.flowStartedAt;
}

/** What this item's change went out in: each repository's pushed head of the delegation it follows. */
function pushKey(app: App, item: Item): string | null {
  const w = latestCodeWork(app, item);
  if (!w) return null;
  const pushed = (getRun(app, w.rootId).output.pushed as { space: string; branch?: string; head?: string }[] | undefined)?.filter((p) => p.head) ?? [];
  return pushed.length ? pushed.map((p) => `${p.space}@${p.branch ?? ""}@${p.head}`).sort().join(",") : null;
}

/** A run for the same stage and push that has not started yet takes this item too. */
function joinBatch(app: App, f: ItemFlow, d: FlowStage, userId: string, key: string, entry: StageItem) {
  const r = one<{ id: string }>(app.db, `select id from runs where kind='flow-stage' and status='queued' and coalesce(user_id,'owner')=?
    and json_extract(input,'$.batchKey')=? and json_extract(input,'$.flowId')=? and json_extract(input,'$.stageId')=? order by created_at limit 1`, userId, key, f.id, d.id);
  if (!r) return null;
  const input = getRun(app, r.id).input;
  const items = [...((input.items as StageItem[] | undefined) ?? []).filter((x) => x.itemId !== entry.itemId), entry];
  run(app.db, "update runs set input=json_set(input,'$.items',json(?),'$.spaces',json(?)),title=? where id=?", JSON.stringify(items), JSON.stringify([...new Set(items.map((x) => x.spaceId))]), `${items.length} 件事项 · ${d.name}`, r.id);
  return getRun(app, r.id);
}

/** Stops this item's stage run; a run shared with other items only lets this one go. */
function stopStageRun(app: App, itemId: string, runId: string, failure?: string) {
  const r = getRun(app, runId);
  const items = Array.isArray(r.input.items) ? r.input.items as StageItem[] : [];
  const rest = items.filter((x) => x.itemId !== itemId);
  if (items.length > 1 && rest.length && ["queued", "running"].includes(r.status)) {
    run(app.db, "update runs set input=json_set(input,'$.items',json(?)) where id=?", JSON.stringify(rest), runId);
    return;
  }
  return stopRun(app, runId, failure);
}

/** The task of a run for several items: what they share, then each item's own task. */
function batchTask(d: FlowStage, key: string, items: StageItem[]) {
  const heads = key.split(",").map((k) => { const [space, branch, head] = k.split("@"); return `${space}@${branch}（${head.slice(0, 8)}）`; }).join("、");
  return [
    `# 这一次一起做 ${items.length} 件事项的「${d.name}」`,
    `它们的改动在同一次推送里：${heads}。环境、账号、登录这类能共用的只准备一次，然后按事项逐件做。结果按事项分开交：report_tests 带 item=<事项 id>，截图放进那件事项的用例里；每件事项各用一次 stage_report(item=<事项 id>, stage="${d.id}")。一件做不下去不影响别的件，照实报那一件。`,
    `事项：${items.map((x) => `${x.itemId}「${x.title}」`).join("、")}`,
    ...items.map((x) => `---\n\n# 事项 ${x.itemId}：${x.title}\n\n${x.task}`),
  ].join("\n\n");
}

function deadlineAt(entered: string, stage: FlowStage) {
  return stage.budget?.minutes === undefined ? undefined : Date.parse(entered) + stage.budget.minutes * 60_000;
}
async function start(app: App, item: Item, f: ItemFlow, d: FlowStage, s: StageRow, confirmed = false, current = new Date()) {
  const at = current.toISOString();
  s = { ...s, control: { ...s.control, grantedGate: !confirmed && gateGranted(app, f.id, d, item.userId) } };
  if (d.tools?.includes("propose_directions")) {
    const previous = continuing(app, item.id);
    if (previous) {
      changeStage(app, item.id, d.id, "skipped", {}, host, `继续「${previous.direction.goal}」：还剩 ${previous.remaining} 个试验`);
      return true;
    }
  }
  if (isFixes(d)) {
    const next = changeStage(app, item.id, d.id, "doing", { attempt: s.attempt + 1, enteredAt: at }, host, "逐条改缺陷，评审通过后重跑");
    await tickFixes(app, item, f, d, next, current, stageAI);
    return true;
  }
  if (isTrials(d)) {
    run(app.db, "update item_flows set auto_streak=?,updated_at=? where item_id=?", confirmed ? 0 : f.autoStreak + 1, at, item.id);
    const next = changeStage(app, item.id, d.id, "doing", { attempt: s.attempt + 1, enteredAt: at, control: { ...s.control, confirmed: undefined } }, host, "按确认的方向逐个去试");
    await tickTrials(app, item, f, d, next, current, stageAI);
    return true;
  }
  if (d.by === "owner" && !(typeof d.done === "object" && "signal" in d.done)) {
    const said = await ownerAlreadySaid(app, item, f, d);
    if (said) {
      withdraw(app, s);
      await finishStage(app, item.id, d.id, "done", { by: "owner", waitingOn: null, askId: null, attempt: s.attempt + 1, enteredAt: at, evidence: [], control: { ...s.control, question: undefined, reported: true } }, host, `你在「${said.from}」时已经说了：${said.note}`);
      return true;
    }
  }
  function started(carrier: string | null, waitingOn: string | null, askId: string | null, control: StageControl, note: string) {
    run(app.db, "update item_flows set auto_streak=?,updated_at=? where item_id=?", confirmed ? 0 : f.autoStreak + (s.control.admitted ? 0 : 1), at, item.id);
    changeStage(app, item.id, d.id, "doing", { by: carrier, waitingOn, askId, attempt: s.attempt + 1, enteredAt: at, evidence: [], control },
      { ...host, runId: control.runId }, note, [], control.grantedGate ? "granted-start" : undefined);
  }
  if (typeof d.by === "object" && "runner" in d.by) {
    const runner = d.by.runner;
    if (!runnerApproved(app, f.definition, item.id)) throw new HttpError(403, "这个流程的插件运行器需本人确认");
    withdraw(app, s);
    atomic(app, () => {
      const r = createRun(app, { kind: "flow-runner", title: `${item.title} · ${d.name}`, spaceId: item.spaceId, userId: item.userId,
        input: { runner, itemId: item.id, stageId: d.id, flowId: f.id, flowStartedAt: f.startedAt, round: f.round, spaces: [item.spaceId] },
        trigger: { via: "flow", source: { kind: "flow", id: f.id, name: f.definition.name }, by: userBy(app, item.userId), where: d.name } });
      started(r.id, null, null, { runId: r.id, grantedGate: s.control.grantedGate, budgetStartedAt: at, runnerDeadline: deadlineAt(at, d) }, describeStage(d).carrier);
    });
    return true;
  }
  const ai = await stageAI(app, f, d, s, current);
  s = ai.s;
  if (ai.waitUntil) {
    const until = stageTiming(new Date(ai.waitUntil), app.config.timezone, d, new Date(f.roundStartedAt)).nextAt ?? ai.waitUntil;
    waitStage(app, f, d, s, until, "模型额度用完");
    return false;
  }
  let carrier: string | null = null;
  let askId: string | null = null;
  let waitingOn: string | null = null;
  const control: StageControl = { ...s.control, question: undefined, confirmed: undefined, reported: false, waitUntil: undefined, admitted: undefined, execution: ai.execution, budgetStartedAt: typeof d.by === "object" && "run" in d.by ? at : undefined };
  withdraw(app, s);
  if (typeof d.by === "object") {
    const obj = "object" in d.by ? findObject(app, item, d.by.object) : null;
    if ("object" in d.by && d.by.object.includes(":")) { carrier = obj?.ref ?? null; }
    else if (obj && !s.control.feedback) { carrier = obj.ref; }
    else {
      let designId: string | undefined;
      if ("object" in d.by && d.by.object === "design") designId = obj?.ref.slice("design:".length) ?? createDesign(app, { spaceId: item.spaceId, title: item.title, origin: "own", itemId: item.id, userId: item.userId }).id;
      const name = "run" in d.by ? d.by.run.agent ?? "assistant" : "assistant";
      const task = await stageTask(app, item, f, d, s.control.feedback);
      const batch = "run" in d.by && d.together === "push" ? pushKey(app, item) : null;
      const entry: StageItem = { itemId: item.id, title: item.title, spaceId: item.spaceId, flowStartedAt: f.startedAt, round: f.round, task };
      const r = (batch ? joinBatch(app, f, d, item.userId, batch, entry) : null) ?? createRun(app, { kind: "flow-stage", spaceId: item.spaceId, title: `${item.title} · ${d.name}`, userId: item.userId,
        input: { itemId: item.id, flowId: f.id, flowStartedAt: f.startedAt, round: f.round, stageId: d.id, stageTools: d.tools ?? [], execution: ai.execution, ownAI: !!d.ai && !ai.execution, agent: name, skill: "run" in d.by ? d.by.run.skill : undefined, designId, task, spaces: [item.spaceId], ...(batch ? { batchKey: batch, items: [entry] } : {}) },
        // Items pushed together reach this stage within moments of each other: wait a little for the rest.
        ...(batch ? { notBefore: new Date(current.getTime() + BATCH_WAIT_MS).toISOString() } : {}),
        trigger: { via: "flow", source: { kind: "flow", id: f.id, name: f.definition.name }, by: userBy(app, item.userId), where: d.name } });
      carrier = r.id;
      control.runId = r.id;
      addLocalMaterials(app, item.id, [{ kind: "run", ref: r.id, label: r.title }], item.userId);
    }
  } else if (d.by === "owner") {
    carrier = "owner";
    waitingOn = "owner";
    control.question = "owner";
    // A stage a push or merge completes may already be done (the owner pushed before the flow got
    // here): look first, and only ask when the signal is not there yet.
    if (typeof d.done === "object" && "signal" in d.done) {
      const attempt = s.attempt + 1, startedAt = f.startedAt;
      setImmediate(() => void checkGitSignals(app).catch(() => undefined).then(() => serial(app, item.id, async () => askOwnerNow(app, item.id, d.id, startedAt, attempt))));
    } else askId = ownerTurn(app, f, d, s);
  }
  const missing = typeof d.by === "object" && "object" in d.by && d.by.object.includes(":") && !carrier;
  const label = typeof d.by === "object" && "object" in d.by ? objectKind(d.by.object)?.label ?? d.by.object : "";
  started(carrier, waitingOn, askId, control, missing ? `还没有关联${label}：把链接发给助手，或在事项页挂上` : confirmed ? "本人确认，开始这一段" : "开始这一段");
  return true;
}

function waitStage(app: App, f: ItemFlow, d: FlowStage, s: StageRow, until: string, why = "") {
  if (s.control.waitUntil === until) return;
  changeStage(app, f.itemId, d.id, s.state, { waitingOn: "time", control: { ...s.control, waitUntil: until } }, host, `${why ? `${why}，` : ""}等到 ${timeLabel(until, app.config.timezone)} 再开始`);
}

function roundComplete(app: App, f: ItemFlow) {
  return itemStages(app, f.itemId).every((s) => ["done", "skipped"].includes(s.state));
}
function closeRound(app: App, f: ItemFlow, at: Date) {
  if (f.roundClosedAt) return;
  const ended = at.toISOString();
  const idle = idleRounds(app, f.itemId, true, ended);
  const pause = idle >= app.config.flows.idleRounds && f.definition.repeat?.every !== "manual";
  atomic(app, () => {
    run(app.db, `insert into item_flow_rounds(item_id,started_at,round,ended_at,stages,updated_at) values(?,?,?,?,?,?)
      on conflict(item_id,started_at,round) do update set ended_at=excluded.ended_at,stages=excluded.stages,updated_at=excluded.updated_at`, f.itemId, f.startedAt, f.round, ended, JSON.stringify(itemStages(app, f.itemId)), now());
    run(app.db, "update item_flows set round_closed_at=?,next_round_at=?,updated_at=? where item_id=?", ended, f.definition.repeat && !pause ? nextRoundAt(at, app.config.timezone, f.definition.repeat.every) : null, now(), f.itemId);
    const last = f.definition.stages.at(-1)!;
    const s = getStage(app, f.itemId, last.id);
    changeStage(app, f.itemId, last.id, s.state, {}, host, `第 ${f.round} 轮已完成${f.definition.repeat?.every === "manual" ? "，等本人开始下一轮" : ""}`);
    // The line above is for the history and the item's timeline; the stage keeps its own conclusion.
    run(app.db, "update item_stages set note=? where item_id=? and stage_id=?", s.note, f.itemId, last.id);
  });
  if (pause && f.definition.repeat) notify(app, { userId: getItem(app, f.itemId).userId, title: `连着 ${idle} 轮没有新发现`, body: `「${getItem(app, f.itemId).title}」连着 ${idle} 轮没有新发现，要换方向、暂停还是结束由你定。`, urgency: "later", link: `#/items/${f.itemId}` });
}
function roundNow(app: App, f: ItemFlow, by: FlowActor, at: Date) {
  if (!f.definition.repeat) throw new HttpError(409, "这份流程没有设置轮次");
  if (!roundComplete(app, f)) throw new HttpError(409, "这一轮还没做完，不能开始下一轮");
  closeRound(app, f, at);
  const from = f.definition.stages.findIndex((d) => d.id === f.definition.repeat!.from);
  const noStarts = !itemStages(app, f.itemId).some((s) => f.definition.stages.slice(from).some((d) => d.id === s.id) && s.attempt > 0);
  atomic(app, () => {
    run(app.db, "update item_flows set round=round+1,round_started_at=?,round_closed_at=null,next_round_at=null,updated_at=? where item_id=?", at.toISOString(), now(), f.itemId);
    for (const d of f.definition.stages.slice(from)) {
      const s = getStage(app, f.itemId, d.id);
      withdraw(app, s); dropUpstream(app, s, "开始了新的一轮");
      changeStage(app, f.itemId, d.id, "pending", { round: f.round + 1, attempt: 0, enteredAt: null, doneAt: null, by: null, waitingOn: null, evidence: [], askId: null, control: {} }, by, `开始第 ${f.round + 1} 轮`);
    }
    if (by.actor === "host" && noStarts) run(app.db, "update item_flows set auto_streak=auto_streak+1 where item_id=?", f.itemId);
    const next = itemFlow(app, f.itemId)!;
    if (by.actor === "host" && next.autoStreak >= app.config.flows.autoAdvance) {
      const d = f.definition.stages[from];
      gate(app, next, d, getStage(app, f.itemId, d.id), "gate");
    }
  });
}
export function startRound(app: App, itemId: string, by: FlowActor, at = new Date()) {
  return serial(app, itemId, async () => {
    if (getItem(app, itemId).userId !== by.userId) throw new HttpError(403, "只有事项本人能开始下一轮");
    const f = running(app, itemId);
    roundNow(app, f, by, at);
    resetStreak(app, itemId);
    await advanceNow(app, itemId, "本人开始下一轮", at);
    return flowView(app, itemId);
  });
}

export async function startFlow(app: App, itemId: string, flowId: string, by: FlowActor, runSpaces: string[] | null = null) {
  attachFlows(app);
  return serial(app, itemId, async () => {
    const item = by.userId ? requireItem(app, itemId, by.userId, "flow") : getItem(app, itemId);
    const range = by.userId ? spacesWithCapability(app, by.userId, "flows.view") : null;
    const visibleSpaces = range && new Set(runSpaces ? range.filter(id => runSpaces.includes(id)) : range);
    const f = readFlow(app, flowId, visibleSpaces);
    if (hasRunner(f) && !runnerApproved(app, f)) throw new HttpError(403, "含插件运行器的流程需要本人确认");
    if (visibleSpaces && !flowAppliesTo(f, item)) throw new HttpError(400, "这个流程不适用于该事项");
    if (itemFlow(app, itemId)?.endedAt === null) throw new HttpError(409, "事项已经在走一个流程");
    atomic(app, () => {
      for (const s of itemStages(app, itemId)) { withdraw(app, s); dropUpstream(app, s, "重新开始了流程"); }
      run(app.db, "delete from item_stages where item_id=?", itemId);
      const at = now();
      run(app.db, `insert into item_flows(item_id,flow_id,definition,started_at,started_by,updated_at,round_started_at) values(?,?,?,?,?,?,?) on conflict(item_id) do update set flow_id=excluded.flow_id,definition=excluded.definition,started_at=excluded.started_at,ended_at=null,auto_streak=0,card=null,started_by=excluded.started_by,updated_at=excluded.updated_at,round=1,round_started_at=excluded.round_started_at,round_closed_at=null,next_round_at=null`, itemId, f.id, JSON.stringify(f), at, by.actor, at, at);
    });
    for (const d of f.stages) changeStage(app, itemId, d.id, "pending", {}, by, "加入流程");
    // The matter gets its 「关注」 (only reading) if it has none: its groups, one context, later replies.
    try { (await import("../channels/listen-items.ts")).flowStarted(app, itemId); } catch (e) { console.warn(`[omem] 没能给事项建关注：${(e as Error).message}`); }
    initFollow(app, itemId, true);
    await advanceNow(app, item.id, "开始流程");
    return flowView(app, itemId);
  });
}

export function advance(app: App, itemId: string, cause = "状态变化") {
  return serial(app, itemId, () => advanceNow(app, itemId, cause));
}
function prerequisitesDone(d: FlowStage, rows: StageRow[]) {
  return d.needs.every(id => rows.some(s => s.id === id && ["done", "skipped"].includes(s.state) && !s.control.upstream));
}
async function advanceNow(app: App, itemId: string, _cause: string, at = new Date()) {
  if (!itemFlow(app, itemId) || itemFlow(app, itemId)!.endedAt) return;
  const item = getItem(app, itemId);
  if (isClosed(item.status)) { await end(app, itemId, "事项已关闭", "closed"); return; }
  for (let pass = 0; pass < 20; pass++) {
    let changed = settleUpstream(app, itemId);
    for (const d of itemFlow(app, itemId)!.definition.stages) {
      const f = itemFlow(app, itemId)!;
      let s = getStage(app, itemId, d.id);
      if (s.state === "doing" && !s.control.reported && s.control.runId && typeof d.by === "object" && "runner" in d.by
        && (deadlineAt(s.enteredAt!, d) ?? Infinity) <= at.getTime()) {
        const note = "已到阶段时限";
        await stopStageRun(app, itemId, s.control.runId, note);
        changeStage(app,itemId,d.id,"blocked",{waitingOn:"owner",control:{...finishUsage(app,s,at),reported:true,budgetExceeded:true}},host,note,[s.control.runId]);
        changed = true; continue;
      }
      if (!(typeof d.by === "object" && "runner" in d.by) && !isTrials(d) && !isFixes(d) && s.state === "doing" && s.control.runId && d.budget?.minutes !== undefined && !s.control.reported && usedMinutes(app, s, at) >= d.budget.minutes) {
        const control = finishUsage(app, s, at);
        stopStageRun(app, s.itemId, s.control.runId);
        changeStage(app, itemId, d.id, "blocked", { waitingOn: "owner", control: { ...control, reported: true, budgetExceeded: true } }, host, `到了这一段的时间预算（${d.budget.minutes} 分钟）`);
        changed = true; continue;
      }
      if (["pending", "stale"].includes(s.state)) {
        const rows = itemStages(app, itemId);
        // A stage still asked about after an upstream reopen is not settled yet, even once it got done.
        if (!prerequisitesDone(d, rows)) continue;
        const previous = d.tools?.includes("propose_directions") ? continuing(app, itemId) : null;
        if (previous) {
          changeStage(app, itemId, d.id, "skipped", {}, host, `继续「${previous.direction.goal}」：还剩 ${previous.remaining} 个试验`);
          changed = true; continue;
        }
        if (isTrials(d) && !continuing(app, itemId)) {
          await finishStage(app, itemId, d.id, "done", { control: { ...s.control, reported: true } }, host, "没有要做的试验");
          changed = true; continue;
        }
        const timing = stageTiming(at, app.config.timezone, d, new Date(f.roundStartedAt));
        if (!timing.ready) { waitStage(app, f, d, s, timing.nextAt!); continue; }
        if (!isTrials(d) && !isFixes(d) && d.budget?.minutes !== undefined && (s.control.usedMinutes ?? 0) >= d.budget.minutes) {
          changeStage(app, itemId, d.id, "blocked", { waitingOn: "owner", control: { ...s.control, budgetExceeded: true } }, host, `到了这一段的时间预算（${d.budget.minutes} 分钟）`); changed = true; continue;
        }
        if (s.state === "stale" && typeof d.by === "object" && "object" in d.by) {
          const obj = findObject(app, item, typeof d.done === "object" && "object" in d.done ? d.done.object : d.by.object);
          if (obj && objectDone(d, obj) && !obj.changedAt) {
            await finishStage(app, itemId, d.id, "done", { by: obj.ref, evidence: [obj.ref], waitingOn: null }, host, "复核对象仍已完成", [obj.ref]); changed = true; continue;
          }
        }
        if (d.when && !s.control.whenYes && s.control.whenAttempt !== s.attempt + 1) {
          let answer: Awaited<ReturnType<typeof decide>> = null;
          try { if (decisionReady(app)) answer = await decide(app, { title: item.title, detail: item.detail, stages: rows.map((r) => ({ id: r.id, state: r.state })) }, { type: "yesno", instructions: d.when }); } catch { /* Failure asks the owner; never treats uncertainty as consent. */ }
          if (!answer || !["yes", "no"].includes(answer.choice)) { gate(app, f, d, s, "when"); changed = true; continue; }
          const yes = answer.choice === "yes";
          s = changeStage(app, itemId, d.id, yes ? s.state : "skipped", { control: { ...s.control, whenYes: yes, whenNo: !yes, whenAttempt: s.attempt + 1 } }, host, `条件判断：${describeDecision(answer)}`);
          changed = true;
          if (!yes) continue;
        }
        if ((d.gate === "confirm" && !gateGranted(app, f.id, d, item.userId) || !isFixes(d) && f.autoStreak >= app.config.flows.autoAdvance) && !s.control.confirmed && !s.control.admitted) { gate(app, f, d, s, "gate"); changed = true; continue; }
        try { changed = await start(app, item, f, d, s, !!s.control.confirmed, at) || changed; }
        catch (e) { changeStage(app, itemId, d.id, "blocked", { waitingOn: "owner" }, host, `无法开始：${(e as Error).message}`); }
      }
      s = getStage(app, itemId, d.id);
      if (s.state === "blocked" && s.control.gateReview) continue;
      if (behindObject(app, item, d, s)) {
        const kind = typeof d.done === "object" && "object" in d.done ? d.done.object : (d.by as { object: string }).object;
        const obj = findObject(app, item, kind)!;
        withdraw(app, s);
        await finishStage(app, itemId, d.id, "done", { by: obj.ref, waitingOn: null, askId: null, evidence: [...new Set([...s.evidence, obj.ref])], control: { ...finishUsage(app, s, at), reported: true } }, host, `卡住以后${objectKind(kind)?.label ?? kind}有了结果（${obj.status}），按它继续`, [obj.ref]);
        changed = true; continue;
      }
      // A stage carried by an object keeps following it while its run said it waits for that object
      // (a delegation still coding): only the owner's own turn stops it.
      const following = s.state === "blocked" && typeof d.by === "object" && "object" in d.by && s.waitingOn !== "owner" && !s.control.budgetExceeded && !!findObject(app, item, d.by.object);
      if (s.state !== "doing" && !following) continue;
      if (isFixes(d)) {
        try { changed = await tickFixes(app, item, f, d, s, at, stageAI) || changed; }
        catch (e) { changeStage(app, itemId, d.id, "blocked", { waitingOn: "owner" }, host, `无法改：${(e as Error).message}`); }
        continue;
      }
      if (isTrials(d)) {
        try { changed = await tickTrials(app, item, f, d, s, at, stageAI) || changed; }
        catch (e) { changeStage(app, itemId, d.id, "blocked", { waitingOn: "owner" }, host, `无法开始试验：${(e as Error).message}`); }
        continue;
      }
      if (typeof d.done === "object" && "signal" in d.done && d.done.signal.includes(":")) void pollFlowSignal(app, f, d, s).catch(err => console.warn("流程信号检查失败", err));
      const carrierKind = typeof d.by === "object" && "object" in d.by ? d.by.object : null;
      const awaitingRevision = carrierKind && !carrierKind.includes(":") && s.control.feedback && !s.control.reported;
      const followed = carrierKind && !awaitingRevision ? findObject(app, item, carrierKind) : null;
      const kind = typeof d.done === "object" && "object" in d.done ? d.done.object : carrierKind;
      const statuses = typeof d.done === "object" && "object" in d.done ? [d.done.status].flat() : undefined;
      // `updated`: the revision moved after this stage started (or was reopened), whatever the status.
      const updatedAfter = statuses?.includes("updated") ? s.control.objectAfter ?? s.enteredAt ?? undefined : undefined;
      const obj = kind && !awaitingRevision ? findObject(app, item, kind, kind.includes(":") && kind !== carrierKind ? { statuses, after: s.control.objectAfter, updatedAfter } : undefined) : null;
      if (followed && s.by !== followed.ref) {
        s = changeStage(app, itemId, d.id, "doing", { by: followed.ref }, host, `跟随${objectKind(carrierKind!)?.label}：${followed.title}`, [followed.ref]); changed = true;
      }
      const ownRunBusy = !!s.control.runId && ["queued", "running"].includes(getRun(app, s.control.runId).status);
      if (obj?.dropped && !ownRunBusy) {
        // This item's own change in a shared delegation was declined: the delegation ending is not this fixed.
        if (s.state !== "blocked") { changeStage(app, itemId, d.id, "blocked", { waitingOn: "owner", evidence: [...new Set([...s.evidence, obj.ref])] }, host, `这件的修改没做：${obj.dropped}`, [obj.ref]); changed = true; }
        continue;
      }
      if (obj) {
        if (objectDone(d, obj) && (!kind?.includes(":") || !obj.disabled && (obj.updated || !s.control.objectAfter || !!obj.changedAt && obj.changedAt > s.control.objectAfter))) {
          await finishStage(app, itemId, d.id, "done", { by: followed?.ref ?? s.by, waitingOn: null, askId: null, evidence: [...new Set([...s.evidence, obj.ref])] }, host, obj.updated ? `${objectKind(kind!)?.label}有更新` : `${objectKind(kind!)?.label}已完成（${obj.status}）`, [obj.ref]); withdraw(app, s); changed = true;
        } else if (d.done === "confirm" && obj.done && !["done", "refuse"].includes(s.control.question ?? "")) {
          const askId = question(app, f, d, s, "done", { ask: `${obj.title}已完成，确认这一段做完了吗？`, evidence: [obj.ref], after: true }, ["确认", "还不行"]);
          changeStage(app, itemId, d.id, "doing", { askId, waitingOn: "owner", evidence: [obj.ref], control: { ...s.control, question: "done", reported: true } }, host, "对象已完成，等本人确认", [obj.ref]); changed = true;
        }
        if (followed || getStage(app, itemId, d.id).state === "done") continue;
      }
      if ((s.by === s.control.runId && !!s.by) && !s.control.reported) {
        const r = getRun(app, s.by);
        if (!["queued", "running"].includes(r.status)) {
          // A stage carried by a delegation, redone on the owner's word: its run started or joined a
          // delegation and ended, as it was told to. The stage follows that delegation; nothing is stuck.
          // So too when the owner had already handed the change to a delegation of this item after the
          // stage was last done (told the assistant directly, before the change reached the flow), and
          // the run found it there.
          const lastDone = one<{ at: string | null }>(app.db, "select max(at) at from item_stage_log where item_id=? and stage_id=? and to_state='done'", itemId, d.id)?.at;
          const started = carrierKind === "code-work" && !r.error ? codeWorkSince(app, item, r.createdAt) ?? (lastDone ? codeWorkSince(app, item, lastDone) : null) : null;
          if (started) {
            changeStage(app, itemId, d.id, "doing", { by: started.ref, control: { ...finishUsage(app, s, at), feedback: undefined } }, { ...host, runId: r.id }, `跟随编码交办：${started.title}`, [started.ref]);
            changed = true; continue;
          }
          const said = typeof r.output.text === "string" ? r.output.text.trim().slice(0, 4000) : "";
          const note = [`这一段的运行结束了，没有交代结果${r.error ? `：${r.error}` : ""}。`, said ? `**运行最后说的**\n${said}` : ""].filter(Boolean).join("\n\n");
          try {
            const ai = await stageAI(app, f, d, s, at);
            if (ai.waitUntil) {
              const pending = changeStage(app, itemId, d.id, "pending", { by: null, control: { ...finishUsage(app, s, at), runId: undefined, reported: false } }, { ...host, runId: r.id }, note);
              const until = stageTiming(new Date(ai.waitUntil), app.config.timezone, d, new Date(f.roundStartedAt)).nextAt ?? ai.waitUntil;
              waitStage(app, f, d, pending, until, "模型额度用完");
              changed = true; continue;
            }
          } catch (e) {
            changeStage(app, itemId, d.id, "blocked", { waitingOn: "owner", control: finishUsage(app, s, at) }, host, `无法开始：${(e as Error).message}`);
            changed = true; continue;
          }
          if (!escalateStage(app, f, d, s, note, at)) changeStage(app, itemId, d.id, "blocked", { waitingOn: "owner", control: finishUsage(app, s, at) }, host, note);
          changed = true;
        }
      }
    }
    changed = settleUpstream(app, itemId) || changed;
    const rows = itemStages(app, itemId);
    if (rows.every((s) => ["done", "skipped"].includes(s.state))) {
      const f = itemFlow(app, itemId)!;
      closeRound(app, f, at);
      if (!f.definition.repeat) { await end(app, itemId, "流程走完了", "completed"); return; }
      const closed = itemFlow(app, itemId)!;
      if (!closed.nextRoundAt || Date.parse(closed.nextRoundAt) > at.getTime()) return;
      if (!roundDayMatches(at, app.config.timezone, f.definition.repeat.every)) {
        run(app.db, "update item_flows set next_round_at=?,updated_at=? where item_id=?", nextRoundAt(at, app.config.timezone, f.definition.repeat.every), now(), itemId);
        return;
      }
      roundNow(app, closed, host, at);
      changed = true;
    }
    if (!changed) return;
  }
}
function objectDone(d: FlowStage, obj: NonNullable<ReturnType<typeof findObject>>) {
  if (typeof d.done === "object" && "object" in d.done) { const want = [d.done.status].flat(); return (want.includes(obj.status) || want.includes("updated") && !!obj.updated) && (d.done.object !== "design" || obj.done); }
  return d.done === "confirm" ? false : obj.done;
}

/**
 * A stage carried by a delegation or review, stuck (its run ended without a result, it reported a wait)
 * and the object then reached what the stage waits for: that result is the stage's answer, not the
 * stale "stuck". The owner's own block (three refusals) and a spent budget stay with the owner.
 */
function behindObject(app: App, item: Item, d: FlowStage, s: StageRow) {
  if (s.state !== "blocked" || s.control.budgetExceeded || typeof d.by !== "object" || !("object" in d.by) || d.by.object.includes(":")) return false;
  const kind = typeof d.done === "object" && "object" in d.done ? d.done.object : d.by.object;
  if (kind !== "code-work") return false;
  const obj = findObject(app, item, kind);
  if (!obj || obj.dropped || !objectDone(d, obj)) return false;
  const settled = codeWorkSettledAt(app, item);
  if (!settled || settled <= s.since) return false;
  const blockedBy = one<{ actor: string }>(app.db, "select actor from item_stage_log where item_id=? and stage_id=? and to_state='blocked' order by id desc limit 1", item.id, d.id)?.actor;
  return blockedBy !== "owner";
}
function usedMinutes(app: App, s: StageRow, at: Date) {
  const r = s.control.runId ? one<{ status: string; started_at: string | null; finished_at: string | null }>(app.db, "select status,started_at,finished_at from runs where id=?", s.control.runId) : null;
  const start = r?.status === "queued" ? undefined : s.control.budgetStartedAt;
  const end = r?.finished_at ? Math.min(Date.parse(r.finished_at), at.getTime()) : at.getTime();
  return (s.control.usedMinutes ?? 0) + (start ? Math.max(0, end - Math.max(Date.parse(start), r?.started_at ? Date.parse(r.started_at) : 0)) / 60000 : 0);
}
function actualStageAI(app: App, s: StageRow) {
  const row = s.control.runId ? one<{ ai: string | null }>(app.db, "select ai from runs where id=?", s.control.runId) : null;
  return json<{ profile: string; model?: string; effort?: string } | null>(row?.ai, null);
}
function finishUsage(app: App, s: StageRow, at: Date): StageControl {
  return { ...s.control, usedMinutes: usedMinutes(app, s, at), budgetStartedAt: undefined };
}
function escalateStage(app: App, f: ItemFlow, d: FlowStage, s: StageRow, feedback: string, at = new Date(), refs = s.evidence) {
  if (!d.ai || !d.escalate || (s.control.escalations ?? 0) >= d.escalate.max) return false;
  withdraw(app, s);
  if (s.control.runId) void stopStageRun(app, s.itemId, s.control.runId);
  changeStage(app, f.itemId, d.id, "pending", { by: null, askId: null, waitingOn: null, control: { ...finishUsage(app, s, at), escalated: true, escalations: (s.control.escalations ?? 0) + 1, runId: undefined, reported: false, question: undefined, feedback } }, { ...host, runId: s.control.runId }, `换上一档的模型重做：${feedback}`, refs, "escalate");
  return true;
}

export type StageReport = { state: "done" | "blocked" | "skip"; evidence?: string[]; pluginEvidence?: StageControl["pluginEvidence"]; links?: StageLink[]; note: string; waitingOn?: string; unsure?: boolean };
export function reportStage(app: App, itemId: string, stageId: string, report: StageReport, by: FlowActor) {
  return serial(app, itemId, async () => {
    const f = running(app, itemId), d = definition(f, stageId);
    if (d.tools?.includes("propose_directions") || isTrials(d) || isFixes(d)) throw new HttpError(403, "课题方向和试验由专门的工具交结果，不能用 stage_report 绕过本人选择或试验队列");
    let s = getStage(app, itemId, stageId);
    if (s.control.budgetExceeded && by.actor !== "owner") throw new HttpError(409, "到了这一段的时间预算，等本人处理");
    if (!report.note.trim()) throw new HttpError(400, "交结果需要说明");
    if (["done", "skip"].includes(report.state) && isStudy(f) && d.tools?.includes("record_finding")) report = { ...report, note: [report.note, pushSummary(app, f)].filter(Boolean).join("\n") };
    if (report.state === "skip" ? s.state === "done" : !["doing", "blocked"].includes(s.state)) throw new HttpError(409, "已完成阶段不能跳过；交结果需要阶段进行中或卡住");
    if (report.state === "skip" && s.state === "skipped") return flowView(app, itemId);
    // An old carrier cannot finish the replacement's attempt.
    if (by.runId && (s.by === s.control.runId && !!s.by) && s.by !== by.runId) throw new HttpError(409, "这不是当前阶段的承担运行");
    if (by.runId && getRun(app, by.runId).input.flowStartedAt && (stageItemStart(getRun(app, by.runId).input, itemId) !== f.startedAt || getRun(app, by.runId).input.stageId !== stageId || s.control.runId !== by.runId)) throw new HttpError(409, "这次运行所属的流程、阶段或尝试已变化");
    const evidence = report.evidence ?? [];
    if (report.state === "blocked" && report.unsure && escalateStage(app, f, d, s, report.note, new Date(), evidence)) {
      await advanceNow(app, itemId, "拿不准，升档重做");
      return flowView(app, itemId);
    }
    // What only the owner can settle stays the owner's: an agent saying "the owner has done it" becomes a
    // question to the owner, and an agent cannot skip a stage whose start or end waits for the owner.
    const ownerOnly = d.gate === "confirm" || d.done === "confirm" || d.by === "owner";
    if (report.state === "skip" && by.actor !== "owner" && ownerOnly) throw new HttpError(403, "这一段要本人确认或由本人承担，不能由你跳过：把理由告诉本人，由本人在卡片或事项页上跳过");
    const asksOwner = report.state === "done" && (d.done === "confirm" || d.by === "owner" && by.actor !== "owner");
    if (report.state === "done" && !asksOwner && (!evidence.length || evidence.some((r) => !validEvidence(app, r)))) throw new HttpError(400, "做完需要至少一项依据（src: 引用、运行 id 或对象引用）");
    if (by.actor === "owner") resetStreak(app, itemId);
    s = { ...s, control: finishUsage(app, s, new Date()) };
    withdraw(app, s);
    if (report.pluginEvidence) s.control.pluginEvidence = report.pluginEvidence;
    // A later report without links keeps the earlier ones: the sheet the owner is asked to confirm stays on the stage.
    if (report.links) {
      if (report.links.some((l) => !/^https?:\/\//i.test(l.url))) throw new HttpError(400, "链接要以 http:// 或 https:// 开头");
      s.control.links = report.links.length ? report.links : undefined;
    }
    if (asksOwner) {
      const askId = question(app, f, d, { ...s, askId: null }, "done", d.by === "owner" ? { ask: "这一段是你来做的，助手说已经做完了。是这样吗？", result: report.note, evidence, after: true } : { ask: "助手说这一段做完了，确认吗？不对就点“还不行”写意见。", result: report.note, evidence, after: true }, ["确认", "还不行"]);
      changeStage(app, itemId, stageId, "doing", { askId, evidence, waitingOn: "owner", control: { ...s.control, question: "done", reported: true } }, by, report.note, evidence);
    } else if (report.state === "done" && (typeof d.done === "object" || typeof d.by === "object" && "object" in d.by)) {
      changeStage(app, itemId, stageId, "doing", { askId: null, evidence, control: { ...s.control, reported: true } }, by, report.note, evidence);
    } else {
      await finishStage(app, itemId, stageId, report.state === "skip" ? "skipped" : report.state, { askId: null, evidence, waitingOn: report.state === "blocked" ? report.waitingOn?.trim() || "待处理" : null, control: { ...s.control, question: undefined, reported: true } }, by, report.note, evidence);
      if (report.state === "skip") notify(app, { userId: getItem(app, itemId).userId, title: `「${d.name}」已跳过`, body: report.note, urgency: "later" });
    }
    await advanceNow(app, itemId, "承担者交结果");
    return flowView(app, itemId);
  });
}
function validEvidence(app: App, ref: string) {
  if (/^src:[\w-]+(?:#L\d+(?:-L?\d+)?)?$/.test(ref)) return !!one(app.db, "select 1 from sources where id=? and deleted_at is null", ref.slice(4).split("#")[0]);
  if (/^design:/.test(ref)) return !!one(app.db, "select 1 from designs where id=?", ref.slice(7));
  // A plugin object linked to the item (a merge request), as its material brief names it.
  if (/^object:fo_/.test(ref)) return !!one(app.db, "select 1 from flow_objects where id=?", ref.slice(7));
  const id = ref.replace(/^(?:run:|code-work:)/, "");
  return !!one(app.db, "select 1 from runs where id=?", id);
}

export type OwnerAction = "confirm" | "hold" | "skip" | "done" | "reopen";
export function recordStage(app: App, itemId: string, stageId: string, note: string, refs: string[] = [], userId = "owner", expected?: { startedAt: string }) {
  return serial(app, itemId, async () => {
    if (getItem(app, itemId).userId !== userId) throw new HttpError(403, "只有事项本人能补录");
    const currentFlow = itemFlow(app, itemId);
    if (expected && (!currentFlow || currentFlow.endedAt || currentFlow.startedAt !== expected.startedAt || !["pending", "gated"].includes(getStage(app, itemId, stageId).state))) return flowView(app, itemId);
    const f = running(app, itemId);
    definition(f, stageId);
    const s = getStage(app, itemId, stageId);
    if (!["pending", "gated"].includes(s.state)) throw new HttpError(409, "只能补录未到或等确认的阶段");
    if (!note.trim()) throw new HttpError(400, "补录需要说明");
    if (refs.some((r) => !/^(src:|run:|design:)/.test(r) || !validEvidence(app, r))) throw new HttpError(400, "补录依据需要有效的 src:、run: 或 design: 引用");
    withdraw(app, s);
    resetStreak(app, itemId);
    await finishStage(app, itemId, stageId, "done", { askId: null, by: "owner", waitingOn: null, evidence: refs, control: { ...s.control, question: undefined, recorded: true, reported: true } }, { actor: "owner", userId }, `补录：${note.trim()}`, refs, "record");
    await advanceNow(app, itemId, "本人补录");
    return flowView(app, itemId);
  });
}
export function signStageTest(app: App, itemId: string, stageId: string, testId: string, verdict: "ok" | "wrong" | null, note: string | undefined, userId: string) {
  return serial(app, itemId, async () => {
    if (getItem(app, itemId).userId !== userId) throw new HttpError(403, "只有事项本人能签字");
    const f = itemFlow(app, itemId);
    if (!f) throw new HttpError(409, "事项没有流程");
    definition(f, stageId);
    const s = getStage(app, itemId, stageId);
    if (!stageTests(app, itemId, stageId, f.startedAt, s.round, s.control.runId).some((t) => t.id === testId)) throw new HttpError(404, "结果不属于这个阶段当前这一轮");
    run(app.db, "update req_tests set owner_verdict=?,owner_note=?,owner_at=? where id=?", verdict, verdict === null ? null : note?.trim() || null, verdict === null ? null : now(), testId);
    app.emit({ type: "changed", entity: "item", id: itemId });
    return flowView(app, itemId);
  });
}
function ownerFeedback(app: App, f: ItemFlow, s: StageRow, note: string) {
  const wrong = stageTests(app, f.itemId, s.id, f.startedAt, s.round, s.control.runId).filter((t) => t.verdict === "wrong");
  return [note, wrong.length ? `本人标了不对的：\n${wrong.map((t) => `- ${t.name}${t.verdictNote ? `：${t.verdictNote}` : ""}`).join("\n")}` : ""].filter(Boolean).join("\n\n");
}
export function ownerAction(app: App, itemId: string, stageId: string, action: OwnerAction, note = "", userId = "owner") {
  return serial(app, itemId, async () => {
    if (getItem(app, itemId).userId !== userId) throw new HttpError(403, "只有事项本人能处理流程");
    await actionNow(app, itemId, stageId, action, note, { actor: "owner", userId });
    return flowView(app, itemId);
  });
}
export function updateStageBudget(app: App, itemId: string, stageId: string, patch: { budget?: FlowStage["budget"]; escalate?: { max: number } }, userId: string) {
  return serial(app, itemId, async () => {
    if (getItem(app, itemId).userId !== userId) throw new HttpError(403, "只有事项本人能修改预算");
    const f = running(app, itemId), d = definition(f, stageId);
    if (patch.escalate && !d.escalate) throw new HttpError(400, "这一段没有设置升档");
    const copy = structuredClone(f.definition), target = copy.stages.find((s) => s.id === stageId)!;
    if (patch.budget) target.budget = budgetSchema.parse(patch.budget);
    if (patch.escalate) target.escalate!.max = patch.escalate.max;
    const validated = parseFlow(JSON.stringify(copy));
    atomic(app, () => {
      if (hasRunner(f.definition) && runnerApproved(app, f.definition, itemId)) retainItemRunnerGrant(app, itemId, validated);
      run(app.db, "update item_flows set definition=?,updated_at=? where item_id=?", JSON.stringify(validated), now(), itemId);
      const s = getStage(app, itemId, stageId);
      const control = { ...s.control };
      if (s.enteredAt && typeof d.by === "object" && "runner" in d.by) control.runnerDeadline = deadlineAt(s.enteredAt,target);
      changeStage(app, itemId, stageId, s.state, {control}, { actor: "owner", userId }, "本人修改了这一段的预算和升档上限");
    });
    await advanceNow(app, itemId, "本人修改预算");
    return flowView(app, itemId);
  });
}
async function actionNow(app: App, itemId: string, stageId: string, action: OwnerAction, note: string, by: FlowActor) {
  const f = action === "reopen" ? itemFlow(app, itemId) : running(app, itemId);
  if (!f) throw new HttpError(409, "事项没有流程");
  const d = definition(f, stageId);
  let s = getStage(app, itemId, stageId);
  // The owner's own turn done needs no reason: doing it was the point.
  if (action === "done" && d.by === "owner" && s.state === "doing" && !note.trim()) note = "本人做完了";
  if (["skip", "done", "reopen"].includes(action) && !note.trim()) throw new HttpError(400, "需要写明原因或说明");
  if (action === "skip" && s.state === "done") throw new HttpError(409, "已完成阶段不能跳过，请先重开");
  if (action === "done" && !["doing", "blocked", "gated"].includes(s.state)) throw new HttpError(409, "只能手动完成进行中、卡住或等确认的阶段");
  if (["hold", "confirm"].includes(action) && s.state !== "gated" && !(action === "confirm" && s.state === "doing" && s.control.question === "done") && !(action === "hold" && s.state === "doing" && s.control.grantedGate)) throw new HttpError(409, "这一段没有等确认的关卡");
  const userId = getItem(app, itemId).userId;
  // The owner deciding on this stage answers the upstream card too.
  s = dropUpstream(app, s, "本人已经处理了这一段");
  if (["hold", "skip"].includes(action)) resetGateStreak(app, f.id, stageId, userId);
  if (action === "confirm" && s.control.question === "gate" && !s.control.gateLimit) {
    if (note.trim()) resetGateStreak(app, f.id, stageId, userId);
    else agreedGate(app, f.definition, d, userId);
  }
  if (action === "hold" && s.control.grantedGate) {
    revokeGate(app, f.id, stageId, userId, itemId);
    if (s.control.runId) await stopStageRun(app, s.itemId, s.control.runId);
    s = { ...s, control: { ...finishUsage(app, s, new Date()), grantedGate: undefined, runId: undefined, question: "gate", confirmed: undefined, reported: false } };
  }
  resetStreak(app, itemId);
  if (isTrials(d) && ["done", "skip"].includes(action)) await cancelTrials(app, itemId);
  withdraw(app, s);
  if (isFixes(d) && ["skip", "done"].includes(action)) await cancelFixReruns(app, itemId);
  if (isStudy(f) && (isFixes(d) || d.tools?.includes("record_finding")) && (["done", "skip"].includes(action) || action === "confirm" && s.control.question === "done")) note = [note || "本人确认完成", pushSummary(app, f)].filter(Boolean).join("\n");
  if (action === "done" || action === "skip" || action === "confirm" && s.control.question === "done") {
    s = { ...s, control: finishUsage(app, s, new Date()) };
    if (s.control.runId) await stopStageRun(app, s.itemId, s.control.runId);
  }
  if (action === "reopen") { const feedback = ownerFeedback(app, f, s, note); await reopenNow(app, itemId, stageId, feedback, [], by, feedback); }
  else if (action === "hold") changeStage(app, itemId, stageId, "gated", { askId: null, control: { ...s.control, reminderAt: now(), reminders: 0 } }, by, note || "本人先别做，暂缓", [], "gate-hold");
  else if (action === "skip" || action === "done" || s.control.question === "done") await finishStage(app, itemId, stageId, action === "skip" ? "skipped" : "done", { askId: null, waitingOn: null, control: { ...s.control, question: undefined, reported: true } }, by, note || "本人确认完成");
  else if (s.control.question === "when") changeStage(app, itemId, stageId, "pending", { askId: null, waitingOn: null, control: { ...s.control, question: undefined, whenYes: true, whenAttempt: s.attempt + 1 } }, by, note || "本人判断这一段要做");
  else changeStage(app, itemId, stageId, "pending", { askId: null, waitingOn: null, control: { ...s.control, question: undefined, confirmed: true } }, by, note || "本人同意开始", [], s.control.question !== "gate" ? undefined : s.control.gateLimit ? "limit-agree" : note.trim() ? "gate-agree-note" : "gate-agree");
  await advanceNow(app, itemId, `本人${action}`);
}

export function reopenStage(app: App, itemId: string, stageId: string, reason: string, refs: string[], by: FlowActor, opts: { feedback?: boolean; startedAt?: string } = {}) {
  return serial(app, itemId, async () => {
    if (opts.startedAt && (itemFlow(app, itemId)?.startedAt !== opts.startedAt || itemFlow(app, itemId)?.endedAt)) throw new HttpError(409, "流程已有新的状态");
    if (!reason.trim()) throw new HttpError(400, "重开需要原因");
    await reopenNow(app, itemId, stageId, reason, refs, by, opts.feedback ? reason : undefined);
    if (by.actor === "owner") resetStreak(app, itemId);
    await advanceNow(app, itemId, "重开阶段");
    return flowView(app, itemId);
  });
}
async function reopenNow(app: App, itemId: string, stageId: string, reason: string, refs: string[], by: FlowActor, feedback?: string) {
  const f = itemFlow(app, itemId);
  if (!f) throw new HttpError(409, "事项没有流程");
  if (isFixes(definition(f, stageId))) await cancelFixReruns(app, itemId);
  if (isTrials(definition(f, stageId))) await cancelTrials(app, itemId);
  const s = dropUpstream(app, getStage(app, itemId, stageId), "这一段自己重开了");
  if (by.actor === "owner" && s.control.grantedGate) revokeGate(app, f.id, stageId, getItem(app, itemId).userId, itemId);
  withdraw(app, s);
  run(app.db, "update item_flows set ended_at=null,round_closed_at=null,next_round_at=null,updated_at=? where item_id=?", now(), itemId);
  if (s.control.runId) await stopStageRun(app, s.itemId, s.control.runId);
  changeStage(app, itemId, stageId, "pending", { askId: null, by: null, waitingOn: null, control: { ...finishUsage(app, s, new Date()), runId: undefined, recorded: undefined, gateReview: undefined, gateReviewResult: undefined, pluginEvidence: undefined, objectAfter: now(), grantedGate: undefined, gateLimit: undefined, reported: false, confirmed: undefined, question: undefined, feedback, waitUntil: undefined, budgetExceeded: undefined, escalated: undefined, admitted: undefined } }, by, reason, refs, "reopen");
  const affected = new Set([stageId]);
  for (const d of f.definition.stages) {
    if (!d.needs.some((n) => affected.has(n))) continue;
    affected.add(d.id);
    const row = getStage(app, itemId, d.id);
    if (row.state === "done" || row.control.gateReview) {
      withdraw(app, row);
      changeStage(app, itemId, d.id, "stale", { askId: null, waitingOn: null, control: { ...row.control, gateReview: undefined, gateReviewResult: undefined } },
        by, `上游「${stageId}」重开，等复核`, refs, "stale");
    }
    // Work in progress is not stopped behind the owner's back: they are asked (only while the flow runs).
    else if (row.state === "doing" && !f.endedAt) askUpstream(app, f, d, row, stageId, reason, refs, by);
  }
}
async function end(app: App, id: string, note: string, how: FlowEnd) {
  if (!itemFlow(app, id) || itemFlow(app, id)!.endedAt) return;
  await cancelFixReruns(app, id);
  await cancelTrials(app, id);
  for (const s of itemStages(app, id)) { withdraw(app, s); dropUpstream(app, s, "流程结束了"); if (s.state === "doing" && s.control.runId) await stopStageRun(app, s.itemId, s.control.runId); }
  run(app.db, "update item_flows set ended_at=?,next_round_at=null,updated_at=? where item_id=?", now(), now(), id);
  // Keep ending on the same audit/timeline path (no extra completion ping).
  const last = itemStages(app, id).at(-1);
  if (last) {
    const lastDef = itemFlow(app, id)!.definition.stages.find((d) => d.id === last.id);
    const keepSummary = lastDef && (isFixes(lastDef) || lastDef.tools?.includes("record_finding"));
    changeStage(app, id, last.id, last.state, {}, host, keepSummary && last.note ? `${last.note}\n${note}` : note);
    // Stopping or closing is the owner's own doing; only a flow that ran to its end is news.
    if (how === "completed") markProgress(app, id, { head: "流程走完了" });
    if (last.control.recorded) run(app.db, "update item_stages set note=? where item_id=? and stage_id=?", last.note, id, last.id);
  }
  // The review is figures from the records, no model; it may queue the coach for the definition (review.ts).
  try { saveReview(app, id, how); } catch (e) { console.warn(`[omem] 流程回顾没有存下：${(e as Error).message}`); }
  // A 关注 made for this flow ends with it; one the owner keeps goes on.
  try { (await import("../channels/listen-items.ts")).flowEnded(app, id); } catch (e) { console.warn(`[omem] 事项的关注没有停下：${(e as Error).message}`); }
  // A top-level item whose flow ran to its end, with nothing open under it, goes into 观察 (items/lifecycle.ts).
  if (how === "completed") {
    try { (await import("../items/lifecycle.ts")).flowCompleted(app, id); } catch (e) { console.warn(`[omem] 工作线没有进入观察：${(e as Error).message}`); }
  }
}
export function stopFlow(app: App, id: string, userId = "owner") {
  return serial(app, id, async () => {
    if (getItem(app, id).userId !== userId) throw new HttpError(403, "只有事项本人能停止流程");
    running(app, id); resetStreak(app, id); await end(app, id, "本人停止了流程", "stopped");
    return flowView(app, id);
  });
}

const answerText = (ask: Ask) => (ask.answer ?? "").replace(new RegExp(`^${ask.options[ask.choice ?? -1]?.label ?? "(?!)"}[：:，,\\s]*`), "").trim();
registerAskHandler("flow-stage", async (app, ask, ctx) => {
  const itemId = String(ctx.itemId), stageId = String(ctx.stageId);
  const f = running(app, itemId), d = definition(f, stageId), s = getStage(app, itemId, stageId);
  if (ctx.kind === "upstream") return answerUpstream(app, f, d, s, ask.choice === 0);
  let text = answerText(ask);
  // Words without a button: on "start?" they start the stage with them, on "done?" they send it back
  // with them; the owner's own stage takes only its buttons.
  const free = ask.choice == null && !!text;
  const skip = ctx.kind === "gate" && ask.choice === 2 || ["owner", "when"].includes(String(ctx.kind)) && ask.choice === 1 || ctx.kind === "skip";
  const refusal = ctx.kind === "done" && (ask.choice === 1 || free) || ctx.kind === "refuse";
  if (skip || refusal) {
    if (skip) resetGateStreak(app, f.id, stageId, ask.userId);
    if (!text) {
      const kind = skip ? "skip" : "refuse";
      const askId = question(app, f, d, { ...s, askId: null }, kind, { ask: skip ? "为什么跳过？请写原因。" : "哪里还不行？请写意见，会带给重做的那一次。" }, []);
      changeStage(app, itemId, stageId, s.state, { askId, control: { ...s.control, question: kind } }, { actor: "owner" }, "等本人补充原因"); resetStreak(app, itemId); return;
    }
    if (skip) await actionNow(app, itemId, stageId, "skip", text, { actor: "owner" });
    else {
      text = ownerFeedback(app, f, s, text);
      if (s.control.grantedGate) revokeGate(app, f.id, stageId, ask.userId, itemId);
      resetStreak(app, itemId);
      if (s.attempt >= 3) changeStage(app, itemId, stageId, "blocked", { askId: null, waitingOn: "owner", control: { ...s.control, question: undefined, reported: true } }, { actor: "owner" }, `三次仍未确认：${text}`, [], "refuse");
      else {
        changeStage(app, itemId, stageId, "pending", { askId: null, waitingOn: null, control: { ...s.control, question: undefined, confirmed: !s.control.grantedGate, grantedGate: undefined, feedback: text, objectAfter: now(), reported: false, escalated: undefined } }, { actor: "owner" }, `本人要求重做：${text}`, [], "refuse");
        await advanceNow(app, itemId, "本人要求重做");
      }
    }
  } else if (ask.choice === 0 || free && ["gate", "when"].includes(String(ctx.kind))) await actionNow(app, itemId, stageId, ctx.kind === "owner" ? "done" : "confirm", ctx.kind === "gate" ? text : text || "本人确认", { actor: "owner" });
  else if (ctx.kind === "gate" && ask.choice === 1) await actionNow(app, itemId, stageId, "hold", text, { actor: "owner" });
}, (app, ask, ctx, by) => {
  if (ask.userId !== by) throw new HttpError(403, "流程关卡只能由事项本人回答");
  const itemId = String(ctx.itemId);
  if (requireItem(app, itemId, by, "flow").userId !== by) throw new HttpError(403, "流程关卡只能由事项本人回答");
  const f = running(app, itemId);
  const s = getStage(app, itemId, String(ctx.stageId));
  const current = ctx.kind === "upstream" ? s.control.upstream?.askId === ask.id && s.state === "doing" : s.askId === ask.id && s.control.question === ctx.kind;
  if (f.startedAt !== ctx.startedAt || !current) throw new HttpError(409, "流程关卡已变化");
}, (app, ctx, answer) => serial(app, String(ctx.itemId), answer));

registerAskHandler("flow-plugin-gate", async (app, ask, ctx) => {
  const item = String(ctx.itemId), stage = String(ctx.stageId);
  if (ask.choice === 0) await overrideStageGate(app, item, stage, ask.id);
  await advanceNow(app, item, "本人处理插件检查");
}, (app, ask, ctx, by) => {
  if (by !== "owner" || ask.userId !== "owner") throw new HttpError(403, "插件检查只能由本人越过");
  const item = String(ctx.itemId), s = getStage(app, item, String(ctx.stageId));
  const f = running(app, item);
  if (s.askId !== ask.id || s.state !== "blocked" || !s.control.gateReview)
    throw new HttpError(409, "这次检查已经处理");
  const d = definition(f, s.id);
  // The card captures a host-accepted result, including an owner-approved continuation
  // or an out-of-order record. Only a later reopen can invalidate its upstream inputs.
  // Older cards could survive an unanswered upstream question. Recover explicit decisions from their log.
  if ((ctx.completion === "regular" || ctx.completion === undefined) && !s.control.recorded
      && !prerequisitesDone(d,itemStages(app,item)) && !continuedUpstream(app,s))
    throw new HttpError(409, "旧结果需要复核");
  const upstream = new Set(d.needs);
  for (const stage of [...f.definition.stages].reverse()) {
    if (upstream.has(stage.id)) for (const id of stage.needs) upstream.add(id);
  }
  if (upstream.size && one(app.db, `select 1 from item_stage_log where item_id=? and at>=? and id>?
    and event='reopen' and stage_id in (${[...upstream].map(() => "?").join(",")}) limit 1`,
    item, ask.createdAt, Number(ctx.logId ?? 0), ...upstream)) throw new HttpError(409, "上游已重开，结果需要复核");
}, (app, ctx, answer) => serial(app, String(ctx.itemId), answer));

export function proposeFlow(app: App, raw: string, by: FlowActor) {
  const f = parseFlowForSave(app, raw);
  return createAsk(app, { runId: by.runId ?? null, userId: hasRunner(f) ? "owner" : by.userId ?? "owner", question: `启用流程「${f.name}」吗？\n${describeFlow(f)}\n${f.stages.map((s) => { const w = describeStage(s); return `- ${s.name}：${w.carrier}；${w.gate}，${w.done}${w.when ? `；${w.when}` : ""}${[w.ai, w.time, w.budget].filter(Boolean).map((v) => `；${v}`).join("")}`; }).join("\n")}`,
    options: [{ label: "启用" }, { label: "不用" }], allowText: false, context: { handler: "flow-save", raw } });
}
registerAskHandler("flow-save", async (app, ask, ctx) => {
  if (ask.userId !== "owner" || ask.answeredBy !== "owner" || ask.choice !== 0) return;
  saveFlow(app, String(ctx.raw), "owner", true);
}, (_app, ask, _ctx, by) => {
  if (ask.userId !== "owner" || by !== "owner") throw new HttpError(403, "流程定义只能由主人确认启用");
});

/** What the host writes when a stage merely joins, starts or waits. The page already shows that state, so a stage's latest line leaves these out. */
const ROUTINE = new Set(["加入流程", "开始这一段", "本人确认，开始这一段", "等本人确认开始", "等本人判断这一段是否需要", "对象已完成，等本人确认", "复核对象仍已完成"]);
/**
 * What a stage's runs reported as tests (report_tests): the latest result of each case with its
 * screenshots and recordings, for the owner to go through case by case before confirming the stage.
 */
/** What needs the owner's eye first: the ones that did not pass, then the ones not done. */
const RANK = { failed: 0, skipped: 1, passed: 2 } as const;
function stageTests(app: App, itemId: string, stageId: string, since: string, round: number, current?: string) {
  const runs = new Set(all<{ run_id: string }>(app.db, "select distinct run_id from item_stage_log where item_id = ? and stage_id = ? and at >= ? and round = ? and run_id is not null", itemId, stageId, since, round).map((r) => r.run_id));
  if (current) runs.add(current);
  // A run for several items: only the results handed in for this one.
  const results = latestEach(testsOfRuns(app, [...runs]).filter((t) => !t.itemId || t.itemId === itemId)).sort((a, b) => RANK[a.status] - RANK[b.status] || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (!results.length) return [];
  const shots = new Map(artifactsByIds(app, [...new Set(results.flatMap((r) => r.artifacts))]).map((a) => [a.id, a]));
  const titles = new Map(all<{ id: string; title: string }>(app.db, `select id, title from req_nodes where id in (select value from json_each(?))`, JSON.stringify([...new Set(results.flatMap((r) => r.nodeId ?? []))])).map((n) => [n.id, n.title]));
  return results.map((r) => ({ id: r.id, name: r.name, status: r.status, mode: r.mode, note: r.note, at: r.at, runId: r.runId,
    verdict: r.verdict, verdictNote: r.verdictNote, verdictAt: r.verdictAt,
    req: r.nodeId && titles.has(r.nodeId) ? { id: r.nodeId, title: titles.get(r.nodeId)! } : null, artifacts: r.artifacts.flatMap((a) => shots.get(a) ?? []) }));
}

/**
 * Screenshots the stage's runs handed in outside test results (a reproduction, a check on a page), latest last.
 * The same picture handed in twice (a file in $OMEM_ARTIFACTS and again with a caption) shows once, the
 * captioned one. When the stage was redone, the earlier tries' pictures (a blank login page that stopped
 * the first try, say) are marked `earlier`: the page folds them under the latest run's.
 */
function stageShots(app: App, itemId: string, stageId: string, since: string, round: number, current?: string) {
  const log = all<{ run_id: string }>(app.db, "select run_id from item_stage_log where item_id = ? and stage_id = ? and at >= ? and round = ? and run_id is not null order by id", itemId, stageId, since, round).map((r) => r.run_id);
  const runs = new Set(log);
  if (current) runs.add(current);
  const inTests = new Set(testsOfRuns(app, [...runs]).flatMap((t) => t.artifacts));
  // A run for several items keeps its pictures in each item's test results; the loose ones belong to no item in particular.
  const shared = new Set(all<{ id: string }>(app.db, "select id from runs where id in (select value from json_each(?)) and json_array_length(json_extract(input,'$.items')) > 1", JSON.stringify([...runs])).map((r) => r.id));
  const list = runImages(app, [...runs].filter((r) => !shared.has(r)), 40).filter((a) => !inTests.has(a.id));
  const sha = new Map(list.length ? all<{ id: string; sha: string | null }>(app.db, `select id, sha from run_artifacts where id in (${list.map(() => "?").join(",")})`, ...list.map((a) => a.id)).map((r) => [r.id, r.sha]) : []);
  const kept = new Map<string, (typeof list)[number]>();
  for (const a of list) {
    const key = sha.get(a.id) ?? a.id, had = kept.get(key);
    if (!had || !had.caption && a.caption) kept.set(key, a);
  }
  const unique = list.filter((a) => kept.get(sha.get(a.id) ?? a.id) === a);
  const latest = current ?? log.at(-1);
  const hasLatest = !!latest && unique.some((a) => a.runId === latest);
  return unique.map((a) => ({ ...a, ...(hasLatest && a.runId !== latest ? { earlier: true } : {}) }));
}

/** "等到 01:00 再开始" with no reason in front: the stage's time line already says it. */
const WAITING_NOTE = /^等到 .+ 再开始$/;
export function flowView(app: App, id: string) {
  const item = getItem(app, id), f = itemFlow(app, id), rows = itemStages(app, id);
  const askIds = rows.flatMap(s => s.control.gateReview && s.askId ? [s.askId] : s.control.gateReviewResult ? [s.control.gateReviewResult.askId] : []);
  // One primary-key query for at most twenty stage cards; no private question or context leaves this projection.
  const gateAsks = new Map(askIds.length ? all<{ id: string; status: "pending" | "answered" | "cancelled"; choice: number | null; answered_at: string | null }>(app.db,
    "select id,status,choice,answered_at from asks where id in (select value from json_each(?))", JSON.stringify(askIds)).map(a => [a.id, {
      id: a.id, status: a.status, choice: a.choice === 0 ? "override" as const : a.choice === 1 ? "hold" as const : null, answeredAt: a.answered_at,
    }]) : []);
  return {
    flow: f ? { id: f.id, name: f.definition.name, startedAt: f.startedAt, endedAt: f.endedAt, autoStreak: f.autoStreak, followCapped: followLimit(app, id).capped, study: isStudy(f), idleRounds: idleRounds(app, id), round: f.round, repeat: f.definition.repeat ?? null, roundStartedAt: f.roundStartedAt, roundClosedAt: f.roundClosedAt, nextRoundAt: f.nextRoundAt, canStartRound: !f.endedAt && !!f.definition.repeat && roundComplete(app, f), repeatDescription: describeFlow(f.definition) } : null,
    stages: f?.definition.stages.map((d) => {
      const s = rows.find((r) => r.id === d.id)!;
      const kind = typeof d.by === "object" ? "object" in d.by ? d.by.object : "run" : d.by;
      const object = kind !== "run" && kind !== "owner" && kind !== "wait" ? findObject(app, item, kind) : typeof d.done === "object" && "object" in d.done ? findObject(app, item, d.done.object) : null;
      const signal = waitingSignal(app, id, d);
      const review = s.control.gateReview ?? s.control.gateReviewResult?.review;
      const reviewAskId = s.control.gateReview ? s.askId : s.control.gateReviewResult?.askId;
      const pluginEvidence = review
        ? [...(s.control.pluginEvidence ?? s.evidence.map(text => ({ text }))), ...review.failed.flatMap(v => v.evidence ?? [])]
        : s.control.pluginEvidence ?? [];
      return { id: d.id, name: d.name, instruction: d.note ?? "", state: s.state, recorded: !!s.control.recorded, autoStarted: !!s.control.grantedGate, attempt: s.attempt, since: s.since, enteredAt: s.enteredAt, doneAt: s.doneAt, by: s.by, waitingOn: s.waitingOn, evidence: s.evidence, links: s.control.links ?? [], pluginEvidence, gateReview: review ? { ...review, ask: reviewAskId ? gateAsks.get(reviewAskId) ?? null : null } : undefined, note: ROUTINE.has(s.note) || WAITING_NOTE.test(s.note) ? "" : s.note, result: stageResult(app, id, s), gate: d.gate, fixed: d.fixed,
        round: s.round, ai: d.ai ?? null, execution: s.control.execution ?? null, actualAI: actualStageAI(app, s), waitUntil: s.control.waitUntil ?? null, at: d.at ?? null, window: d.window ?? null, budget: d.budget ?? null, usedMinutes: isFixes(d) ? fixMinutes(app, s, new Date()) : usedMinutes(app, s, new Date()), escalate: d.escalate ?? null, escalations: s.control.escalations ?? 0, descriptions: describeStage(d),
        carrier: { kind, ...(typeof d.by === "object" && "runner" in d.by ? { runner: runnerIdentity(d.by.runner) } : {}), label: typeof d.by === "object" && "runner" in d.by ? describeStage(d).carrier : kind === "trials" ? "助手，一个一个去试" : kind === "fixes" ? "助手，一条一条去改" : objectKind(kind)?.label ?? (kind === "owner" ? "你" : kind === "wait" ? "只等进展" : typeof d.by === "object" && "run" in d.by && d.by.run.agent && d.by.run.agent !== "assistant" ? d.by.run.agent : "助手"), ...(object ? { link: object.link } : (s.by === s.control.runId && !!s.by) ? { link: `#/runs/${s.by}` } : {}) },
        ...(object ? { object: { title: object.title, status: object.status, link: object.link, ...(object.statusLabel !== undefined ? { statusLabel: object.statusLabel, fields: object.fields ?? [], disabled: !!object.disabled } : {}) } } : {}), ...(s.askId ? { askId: s.askId } : {}), ...(s.askId && s.state === "doing" && d.tools?.includes("propose_directions") ? { asking: "direction" } : {}), ...(signal ? { waitingSignal: signal } : {}), upstream: s.control.upstream ? { askId: s.control.upstream.askId, stage: s.control.upstream.stage, name: stageName(f!, s.control.upstream.stage), reason: s.control.upstream.reason } : null, tests: stageTests(app, id, d.id, f!.startedAt, s.round, s.control.runId), shots: stageShots(app, id, d.id, f!.startedAt, s.round, s.control.runId) };
    }) ?? [], log: stageLog(app, id), suits: f ? [] : flowsFor(app, item), rounds: f ? roundHistory(app, f) : [],
    changes: shownChanges(app, id), follow: followView(app, id),
    // How it went, once it ended: figures from its records (review.ts).
    review: f?.endedAt ? storedReview(app, id, f.startedAt) : null,
  };
}

export async function flowReminders(app: App, at = new Date()) {
  attachFlows(app);
  await checkGitSignals(app);
  await pollObjects(app, at);
  await followContexts(app, at);
  for (const { item_id: id } of all<{ item_id: string }>(app.db, "select item_id from item_flows where ended_at is null")) await serial(app, id, async () => {
    // Recover terminal runs missed during downtime, then remind only the still-waiting stages.
    await advanceNow(app, id, "例行检查", at);
    if (itemFlow(app, id)?.endedAt) return;
    for (const s of itemStages(app, id)) {
      if (!["gated", "blocked"].includes(s.state) && !(s.state === "doing" && s.by === "owner")) continue;
      const n = s.control.reminders ?? 0;
      if (at.getTime() - Date.parse(s.control.reminderAt ?? s.since) < app.config.flows.staleDays * 86400_000 * 2 ** n) continue;
      const item = getItem(app, id), f = itemFlow(app, id)!, d = definition(f, s.id);
      notify(app, { userId: item.userId, title: `「${item.title}」还停在「${d.name}」`, body: s.note, urgency: "later", link: `#/items/${id}` });
      changeStage(app, id, s.id, s.state, { control: { ...s.control, reminders: n + 1, reminderAt: at.toISOString() } }, host, s.note);
    }
  });
}

const attached = new WeakSet<App>();
export function attachFlows(app: App) {
  if (attached.has(app)) return;
  attached.add(app);
  const listener = (e: AppEvent) => {
    if (e.type === "changed" && e.entity === "item") {
      const f = itemFlow(app, e.id);
      if (f && !f.endedAt && isClosed(getItem(app, e.id).status)) void advance(app, e.id, "事项关闭").catch((err) => console.warn(`[omem] 事项关闭时结束流程失败：${(err as Error).message}`));
      return;
    }
    if (e.type !== "run" && !(e.type === "changed" && ["code-task", "design"].includes(e.entity))) return;
    const ids = new Set<string>();
    const runIds = new Set<string>();
    if (e.type === "run") {
      const r = getRun(app, e.runId);
      if (typeof r.input.itemId === "string" && ["flow-stage", "flow-runner", "study-trial"].includes(r.kind)) ids.add(r.input.itemId);
      runIds.add(r.id);
      if (typeof r.input.continueFrom === "string") runIds.add(r.input.continueFrom);
      if (r.parentId) runIds.add(r.parentId);
    } else if (e.entity === "code-task") runIds.add(e.id);
    else {
      const d = one<{ item_id: string | null; work_id: string | null }>(app.db, "select item_id,work_id from designs where id=?", e.id);
      if (d?.item_id) ids.add(d.item_id);
      if (d?.work_id) runIds.add(d.work_id);
    }
    for (const r of runIds) for (const m of all<{ item_id: string }>(app.db, "select m.item_id from item_materials m join item_flows f on f.item_id=m.item_id where m.kind='run' and m.ref=? and f.ended_at is null", r)) ids.add(m.item_id);
    for (const id of ids) if (itemFlow(app, id)?.endedAt === null) void advance(app, id, e.type === "run" ? `运行 ${e.status}` : e.entity).catch((err) => console.warn(`[omem] 流程推进失败：${(err as Error).message}`));
  };
  // Due jobs are taken directly from the deadline index even when every background slot is busy.
  let sweeping = false;
  const deadlines = setInterval(async () => {
    if (sweeping) return;
    sweeping = true;
    try {
      const due = all<{item_id:string}>(app.db, `select s.item_id from item_stages s join item_flows f on f.item_id=s.item_id where state='doing' and f.ended_at is null
        and json_extract(control,'$.runnerDeadline') <= ? and json_extract(control,'$.reported') is not 1
        order by json_extract(control,'$.runnerDeadline') limit 32`, Date.now());
      await Promise.all([...new Set(due.map(r => r.item_id))].map(id => advance(app,id,"运行器到期")));
    } catch (e) { console.warn("[omem] 检查运行器期限失败", e); }
    finally { sweeping = false; }
  }, 1000).unref();
  app.events.once("close", () => clearInterval(deadlines));
  app.events.on("event", listener);
  app.events.once("close", () => { app.events.off("event", listener); attached.delete(app); });
}

const runFlowStage: Parameters<typeof registerHandler>[1] = async (ctx) => {
  const input = ctx.run.input;
  Object.assign(input, getRun(ctx.app, ctx.run.id).input);
  const stageId = String(input.stageId);
  const listed = Array.isArray(input.items) && input.items.length ? input.items as StageItem[] : null;
  const entries = listed ?? [{ itemId: String(input.itemId), flowStartedAt: String(input.flowStartedAt) } as StageItem];
  const ready: StageItem[] = [];
  for (const e of entries) if (await prepareStage(ctx, e.itemId, stageId, e.flowStartedAt)) ready.push(e);
  if (!ready.length) return { quiet: true, summary: "阶段已有新的状态或等待新的开始条件，不再执行这次运行" };
  // Several items at once: the ones still waiting for this run, each with its own part of the task.
  if (listed) {
    run(ctx.app.db, "update runs set input=json_set(input,'$.items',json(?)) where id=?", JSON.stringify(ready), ctx.run.id);
    input.items = ready;
    if (ready.length > 1) input.task = batchTask(definition(itemFlow(ctx.app, ready[0].itemId)!, stageId), String(input.batchKey), ready);
    else input.task = ready[0].task;
  }
  const itemId = ready[0].itemId;
  const spaces = [...new Set(ready.map((e) => e.spaceId ?? getItem(ctx.app, e.itemId).spaceId))];
  return runStageAgent(ctx, input, itemId, stageId, spaces);
};

/** Whether this item's stage still waits for this run: a queued run may reach the worker after its window or daily allowance changed. */
async function prepareStage(ctx: Parameters<Parameters<typeof registerHandler>[1]>[0], itemId: string, stageId: string, flowStartedAt: unknown) {
  const input = ctx.run.input;
  const f = itemFlow(ctx.app, itemId);
  if (!f || f.endedAt || f.startedAt !== flowStartedAt) return false;
  return serial(ctx.app, itemId, async () => {
    const current = getStage(ctx.app, itemId, stageId), flow = itemFlow(ctx.app, itemId)!;
    if (flow.endedAt || current.control.runId !== ctx.run.id || current.state !== "doing") return false;
    // Enqueue may wake a worker while the item queue is still preparing its workspace.
    Object.assign(input, getRun(ctx.app, ctx.run.id).input);
    const d = definition(flow, stageId), at = new Date();
    try {
      const timing = stageTiming(at, ctx.app.config.timezone, d, new Date(flow.roundStartedAt));
      const effective = ctx.run.kind === "study-trial" && isFixes(d) ? { ...fixModelStage(flow, d), id: d.id, escalate: undefined } : ctx.run.kind === "study-trial" ? trialStage(ctx.app, itemId, trial(ctx.app, String(input.trialId)).env, d) : d;
      const ai = await stageAI(ctx.app, flow, effective, current, at);
      const wait = timing.nextAt && ai.waitUntil ? (timing.nextAt > ai.waitUntil ? timing.nextAt : ai.waitUntil) : timing.nextAt ?? ai.waitUntil;
      if (wait) {
        if (ctx.run.kind === "study-trial") {
          run(ctx.app.db, "update study_trials set state='queued',attempts=max(0,attempts-1),updated_at=? where id=? and run_id=?", now(), String(input.trialId), ctx.run.id);
          changeStage(ctx.app, itemId, stageId, "doing", { by: null, waitingOn: "time", control: { ...ai.s.control, runId: undefined, budgetStartedAt: undefined, waitUntil: wait } }, host, "排队后重新检查试验的开始条件");
          return false;
        }
        const pending = changeStage(ctx.app, itemId, stageId, "pending", { by: null, enteredAt: null, attempt: Math.max(0, current.attempt - 1), control: { ...ai.s.control, admitted: true, runId: undefined, budgetStartedAt: undefined } }, host, "排队后重新检查开始条件");
        waitStage(ctx.app, flow, d, pending, wait, ai.waitUntil ? "模型额度用完" : "");
        return false;
      }
      input.execution = ai.execution;
      input.ownAI = !!effective.ai && !ai.execution;
      run(ctx.app.db, "update item_stages set control=?,updated_at=? where item_id=? and stage_id=?", JSON.stringify({ ...ai.s.control, execution: ai.execution }), now(), itemId, stageId);
      return true;
    } catch (e) {
      changeStage(ctx.app, itemId, stageId, "blocked", { waitingOn: "owner", control: { ...current.control, reported: true, budgetStartedAt: undefined } }, host, `无法开始：${(e as Error).message}`);
      return false;
    }
  });
}

async function runStageAgent(ctx: Parameters<Parameters<typeof registerHandler>[1]>[0], input: Record<string, unknown>, itemId: string, stageId: string, stageSpaces: string[]) {
  const item = getItem(ctx.app, itemId);
  if (typeof input.designId === "string") {
    const { getDesign } = await import("../designs/store.ts");
    const { runDesigner } = await import("../designs/designer.ts");
    const result = await runDesigner(ctx.app, { design: getDesign(ctx.app, input.designId), run: ctx.run, task: String(input.task), spaces: [item.spaceId], signal: ctx.signal, event: ctx.event });
    await reportStage(ctx.app, itemId, stageId, result.design
      ? { state: "done", note: "方案已交，等本人确认", evidence: [`design:${result.design.id}`] }
      : { state: "blocked", note: "这一段的运行结束了，没有交代结果：没有提交方案", waitingOn: "owner" }, { actor: "designer", runId: ctx.run.id, userId: item.userId });
    return result;
  }
  const { runRole } = await import("../agents/runner.ts");
  const name = String(input.agent ?? "assistant");
  const role = (roleNames as readonly string[]).includes(name) ? name as RoleName : "assistant";
  const spec = (roleNames as readonly string[]).includes(name) ? undefined : findAgentSpec(ctx.app, name);
  if (spec === null) throw new HttpError(404, `没有 Agent 档案 ${name}`);
  if (spec?.status === "draft") throw new HttpError(400, `Agent 档案 ${name} 尚未启用`);
  let task = String(input.task);
  if (typeof input.skill === "string") {
    const skill = readSkill(ctx.app, input.skill);
    if (skill.status !== "active" || !skillUsable(ctx.app, skill)) throw new HttpError(400, `技能 ${skill.name} 尚未启用或缺少模型`);
    task += `\n\n## 这一轮的技能：${skill.name}\n${skill.body}`;
  }
  const d = definition(itemFlow(ctx.app, itemId)!, stageId), planner = d.tools?.includes("propose_directions");
  const canPush = ctx.run.kind === "study-trial" && (isTrials(d) || isFixes(d)) && pushAuthorized(ctx.app, itemId);
  const addTools = ctx.run.kind === "study-trial" ? ["trial_report", "attach_artifact", ...d.tools ?? [], ...(canPush ? ["study_push"] : [])] : planner ? ["propose_directions", "attach_artifact"] : ["stage_report", "report_tests", "attach_artifact", ...d.tools ?? []];
  // What the stage cannot finish without: the one tool it hands its result in with. The rest (files, tests,
  // the role's own tools) are welcome but optional, so a backend that reaches only a few tools (a cloud one
  // over HTTP, cloud-tools.ts) can still take the stage.
  const requiredTools = [ctx.run.kind === "study-trial" ? "trial_report" : planner ? "propose_directions" : "stage_report"];
  const result = await runRole(ctx.app, { role, spec: spec ?? undefined, execution: input.execution as Execution | undefined, ownAI: input.ownAI === true, spaceId: item.spaceId, requiredTools, spaces: ctx.run.kind === "study-trial" ? input.spaces as string[] : stageSpaces, cwd: ctx.run.kind === "study-trial" ? input.cwd as string | undefined : undefined, task, runId: ctx.run.id, userId: item.userId, signal: ctx.signal, addTools, denyTools: planner ? ["study_push", "read_ledger", "record_finding", "close_direction", "read_item", "read_run", "list_runs", "stage_report"] : ctx.run.kind === "study-trial" ? ["read_ledger", "read_item", "read_run", "list_runs", "stage_report", "delegate_code", ...(canPush ? [] : ["study_push"])] : ["study_push"], artifacts: true, onEvent: (e) => ctx.event(e.type, e) });
  return { text: result.text, ai: result.ai, sessionId: result.sessionId };
}
registerHandler("flow-stage", runFlowStage);
registerHandler("study-trial", runFlowStage);
registerHandler("flow-runner", async ctx => (await import("./plugin-runner.ts")).runPluginStage(ctx));

/** Git checks enter the same item queue as owner actions and revalidate the checked attempt. */
export function completeBySignal(app: App, itemId: string, stageId: string, note: string, evidence: string[], expected: { startedAt: string; attempt: number; enteredAt: string | null; type: string; work?: string; pluginEvidence?: StageControl["pluginEvidence"]; current?: () => boolean }) {
  return serial(app, itemId, async () => {
    const f = itemFlow(app, itemId);
    if (!f || f.endedAt || f.startedAt !== expected.startedAt) return false;
    const d = definition(f, stageId), s = getStage(app, itemId, stageId);
    if (s.state !== "doing" || s.attempt !== expected.attempt || s.enteredAt !== expected.enteredAt ||
      !(typeof d.done === "object" && "signal" in d.done && d.done.signal === expected.type) ||
      (d.by !== "owner" && d.by !== "wait") || expected.current?.() === false || expected.work !== undefined && findObject(app, getItem(app, itemId), "code-work")?.ref !== expected.work) return false;
    withdraw(app, s);
    await finishStage(app, itemId, stageId, "done", { askId: null, waitingOn: null, evidence: [...new Set([...s.evidence, ...evidence])], control: { ...s.control, pluginEvidence: expected.pluginEvidence, question: undefined, reported: true } }, host, note, evidence);
    await advanceNow(app, itemId, "完成信号");
    return true;
  });
}
