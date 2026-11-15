import type { App, AppEvent } from "../core/app.ts";
import { latestEach, testsOfWork } from "../items/req-tests.ts";
import { artifactsByIds } from "../agents/artifacts.ts";
import { all, one, run } from "../core/db.ts";
import { decide, decisionReady, describeDecision } from "../core/decision.ts";
import { notify } from "../core/notify.ts";
import { HttpError, json, now } from "../core/util.ts";
import { cancelAsk, createAsk, getAsk, registerAskHandler, type Ask } from "../agents/asks.ts";
import { createRun, getRun, registerHandler } from "../agents/runs.ts";
import { roleNames, type RoleName } from "../core/config.ts";
import { userBy } from "../core/run-trigger.ts";
import { findAgentSpec, readSkill, skillUsable } from "../agents/specs.ts";
import { getItem, type Item } from "../items/store.ts";
import { addMaterials, materialsBrief } from "../items/materials.ts";
import { itemPlaces } from "../items/places.ts";
import { createDesign } from "../designs/store.ts";
import { flowsFor, parseFlow, readFlow, saveFlow, type FlowStage, describeStage } from "./definitions.ts";
import { findObject, objectKind } from "./objects.ts";
import { checkGitSignals, waitingSignal, type GitSignal } from "./signals.ts";
import { atomic, changeStage, flushProgress, getStage, itemFlow, itemStages, stageLog, type FlowActor, type ItemFlow, type StageRow, type StageControl } from "./store.ts";

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
function definition(f: ItemFlow, id: string) {
  const s = f.definition.stages.find((x) => x.id === id);
  if (!s) throw new HttpError(404, `没有阶段 ${id}`);
  return s;
}
function resetStreak(app: App, id: string) { run(app.db, "update item_flows set auto_streak=0,updated_at=? where item_id=?", now(), id); }
function withdraw(app: App, s: StageRow) { if (s.askId) cancelAsk(app, s.askId, "阶段已有新的状态"); }
function question(app: App, f: ItemFlow, d: FlowStage, s: StageRow, kind: NonNullable<StageRow["control"]["question"]>, text: string, labels: string[]) {
  if (s.askId && getAsk(app, s.askId).status === "pending" && s.control.question === kind) return s.askId;
  withdraw(app, s);
  return createAsk(app, { runId: null, userId: getItem(app, f.itemId).userId, question: text, options: labels.map((label) => ({ label })), allowText: true,
    context: { handler: "flow-stage", itemId: f.itemId, stageId: d.id, startedAt: f.startedAt, kind } }).id;
}
function gate(app: App, f: ItemFlow, d: FlowStage, s: StageRow, kind: "when" | "gate") {
  const item = getItem(app, f.itemId);
  const first = d.note?.split(/[。！？\n]/)[0];
  const askId = question(app, f, d, s, kind, kind === "when" ? `「${d.name}」这一段要做吗？（${d.when}）` : `「${item.title}」到了「${d.name}」${first ? `：${first}` : ""}。开始吗？`, kind === "when" ? ["要做", "跳过"] : ["开始", "先别做", "跳过这一段"]);
  changeStage(app, f.itemId, d.id, "gated", { askId, waitingOn: "owner", control: { ...s.control, question: kind } }, host, kind === "when" ? "等本人判断这一段是否需要" : "等本人确认开始");
}

function stageTask(app: App, item: Item, f: ItemFlow, d: FlowStage, feedback?: string) {
  const rows = itemStages(app, item.id);
  return [materialsBrief(app, item.id, item.userId), `截止时间：${item.dueAt ?? "未定"}`,
    `进行的地方：\n${itemPlaces(app, item.id, item.userId).map((p) => `- ${p.title}（${p.ref}）：${p.summary}`).join("\n") || "尚未关联会话"}`,
    `## 流程：${f.definition.name}\n${f.definition.stages.map((s) => `- ${s.id} ${s.name}：${rows.find((r) => r.id === s.id)?.state ?? "pending"}`).join("\n")}`,
    `## 这一段：${d.name}（${d.id}）\n${d.note ?? ""}`,
    `完成要求：${typeof d.done === "string" ? d.done : d.done ? JSON.stringify(d.done) : "做完这一段并附上依据"}`,
    typeof d.by === "object" && "object" in d.by ? d.by.object === "code-work" ? `按这件事的需求点发起交办，delegate_code 带上 item_id=${item.id}；流程会跟随交办评审。` : `为这件事写方案，交给本人确认。` : "",
    feedback ? `本人说还不行，原因：${feedback}。这一轮按这个意见重做。` : "",
    `结束前必须用 stage_report(item="${item.id}", stage="${d.id}") 交代：done 附依据；blocked 写等谁或等什么；skip 写原因。不要以运行结束代替交结果；不要替本人确认。`,
  ].filter(Boolean).join("\n\n");
}

function start(app: App, item: Item, f: ItemFlow, d: FlowStage, s: StageRow, confirmed = false) {
  const at = now();
  let carrier: string | null = null;
  let askId: string | null = null;
  let waitingOn: string | null = null;
  const control: StageControl = { ...s.control, question: undefined, confirmed: undefined, reported: false };
  withdraw(app, s);
  if (typeof d.by === "object") {
    const obj = "object" in d.by ? findObject(app, item, d.by.object) : null;
    if (obj && !s.control.feedback) { carrier = obj.ref; }
    else {
      let designId: string | undefined;
      if ("object" in d.by && d.by.object === "design") designId = obj?.ref.slice("design:".length) ?? createDesign(app, { spaceId: item.spaceId, title: item.title, origin: "own", itemId: item.id, userId: item.userId }).id;
      const name = "run" in d.by ? d.by.run.agent ?? "assistant" : "assistant";
      const r = createRun(app, { kind: "flow-stage", spaceId: item.spaceId, title: `${item.title} · ${d.name}`, userId: item.userId,
        input: { itemId: item.id, flowId: f.id, flowStartedAt: f.startedAt, stageId: d.id, agent: name, skill: "run" in d.by ? d.by.run.skill : undefined, designId, task: stageTask(app, item, f, d, s.control.feedback), spaces: [item.spaceId] },
        trigger: { via: "flow", source: { kind: "flow", id: f.id, name: f.definition.name }, by: userBy(app, item.userId), where: d.name } });
      carrier = r.id;
      control.runId = r.id;
      addMaterials(app, item.id, [{ kind: "run", ref: r.id, label: r.title }], item.userId);
    }
  } else if (d.by === "owner") {
    carrier = "owner";
    waitingOn = "owner";
    askId = question(app, f, d, { ...s, askId: null }, "owner", `「${item.title}」轮到你：${d.name}。${d.note ?? ""}`, ["做完了", "这一段跳过"]);
    control.question = "owner";
  }
  run(app.db, "update item_flows set auto_streak=?,updated_at=? where item_id=?", confirmed ? 0 : f.autoStreak + 1, at, item.id);
  changeStage(app, item.id, d.id, "doing", { by: carrier, waitingOn, askId, attempt: s.attempt + 1, enteredAt: at, evidence: [], control }, host, confirmed ? "本人确认，开始这一段" : "开始这一段");
}

export async function startFlow(app: App, itemId: string, flowId: string, by: FlowActor) {
  attachFlows(app);
  return serial(app, itemId, async () => {
    const item = getItem(app, itemId);
    const f = readFlow(app, flowId);
    if (itemFlow(app, itemId)?.endedAt === null) throw new HttpError(409, "事项已经在走一个流程");
    atomic(app, () => {
      for (const s of itemStages(app, itemId)) withdraw(app, s);
      run(app.db, "delete from item_stages where item_id=?", itemId);
      const at = now();
      run(app.db, `insert into item_flows(item_id,flow_id,definition,started_at,started_by,updated_at) values(?,?,?,?,?,?) on conflict(item_id) do update set flow_id=excluded.flow_id,definition=excluded.definition,started_at=excluded.started_at,ended_at=null,auto_streak=0,card=null,started_by=excluded.started_by,updated_at=excluded.updated_at`, itemId, f.id, JSON.stringify(f), at, by.actor, at);
    });
    for (const d of f.stages) changeStage(app, itemId, d.id, "pending", {}, by, "加入流程");
    await advanceNow(app, item.id, "开始流程");
    return flowView(app, itemId);
  });
}

export function advance(app: App, itemId: string, cause = "状态变化") {
  return serial(app, itemId, () => advanceNow(app, itemId, cause));
}
async function advanceNow(app: App, itemId: string, _cause: string) {
  if (!itemFlow(app, itemId) || itemFlow(app, itemId)!.endedAt) return;
  const item = getItem(app, itemId);
  for (let pass = 0; pass < 20; pass++) {
    let changed = false;
    for (const d of itemFlow(app, itemId)!.definition.stages) {
      const f = itemFlow(app, itemId)!;
      let s = getStage(app, itemId, d.id);
      if (["pending", "stale"].includes(s.state)) {
        const rows = itemStages(app, itemId);
        if (!d.needs.every((n) => rows.some((r) => r.id === n && ["done", "skipped"].includes(r.state)))) continue;
        if (s.state === "stale" && typeof d.by === "object" && "object" in d.by) {
          const obj = findObject(app, item, typeof d.done === "object" && "object" in d.done ? d.done.object : d.by.object);
          if (obj && objectDone(d, obj)) {
            changeStage(app, itemId, d.id, "done", { by: obj.ref, evidence: [obj.ref], waitingOn: null }, host, "复核对象仍已完成", [obj.ref]); changed = true; continue;
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
        if ((d.gate === "confirm" || f.autoStreak >= app.config.flows.autoAdvance) && !s.control.confirmed) { gate(app, f, d, s, "gate"); changed = true; continue; }
        try { start(app, item, f, d, s, !!s.control.confirmed); }
        catch (e) { changeStage(app, itemId, d.id, "blocked", { waitingOn: "owner" }, host, `无法开始：${(e as Error).message}`); }
        changed = true;
      }
      s = getStage(app, itemId, d.id);
      if (s.state !== "doing") continue;
      const carrierKind = typeof d.by === "object" && "object" in d.by ? d.by.object : null;
      const awaitingRevision = carrierKind && s.control.feedback && !s.control.reported;
      const followed = carrierKind && !awaitingRevision ? findObject(app, item, carrierKind) : null;
      const kind = typeof d.done === "object" && "object" in d.done ? d.done.object : carrierKind;
      const obj = kind && !awaitingRevision ? findObject(app, item, kind) : null;
      if (followed && s.by !== followed.ref) {
        s = changeStage(app, itemId, d.id, "doing", { by: followed.ref }, host, `跟随${objectKind(carrierKind!)?.label}：${followed.title}`, [followed.ref]); changed = true;
      }
      if (obj) {
        if (objectDone(d, obj)) {
          changeStage(app, itemId, d.id, "done", { by: followed?.ref ?? s.by, waitingOn: null, askId: null, evidence: [...new Set([...s.evidence, obj.ref])] }, host, `${objectKind(kind!)?.label}已完成（${obj.status}）`, [obj.ref]); withdraw(app, s); changed = true;
        } else if (d.done === "confirm" && obj.done && !["done", "refuse"].includes(s.control.question ?? "")) {
          const askId = question(app, f, d, s, "done", `「${d.name}」做完了：${obj.title}已完成。确认吗？`, ["确认", "还不行"]);
          changeStage(app, itemId, d.id, "doing", { askId, waitingOn: "owner", evidence: [obj.ref], control: { ...s.control, question: "done", reported: true } }, host, "对象已完成，等本人确认", [obj.ref]); changed = true;
        }
        if (followed || getStage(app, itemId, d.id).state === "done") continue;
      }
      if ((s.by === s.control.runId && !!s.by) && !s.control.reported) {
        const r = getRun(app, s.by);
        if (!["queued", "running"].includes(r.status)) {
          changeStage(app, itemId, d.id, "blocked", { waitingOn: "owner" }, host, `这一段的运行结束了，没有交代结果${r.error ? `：${r.error}` : ""}`); changed = true;
        }
      }
    }
    const rows = itemStages(app, itemId);
    if (rows.every((s) => ["done", "skipped"].includes(s.state))) { end(app, itemId, "流程走完了"); return; }
    if (!changed) return;
  }
}
function objectDone(d: FlowStage, obj: NonNullable<ReturnType<typeof findObject>>) {
  if (typeof d.done === "object" && "object" in d.done) return (Array.isArray(d.done.status) ? d.done.status : [d.done.status]).includes(obj.status) && (d.done.object !== "design" || obj.done);
  return d.done === "confirm" ? false : obj.done;
}

export type StageReport = { state: "done" | "blocked" | "skip"; evidence?: string[]; note: string; waitingOn?: string };
export function reportStage(app: App, itemId: string, stageId: string, report: StageReport, by: FlowActor) {
  return serial(app, itemId, async () => {
    const f = running(app, itemId), d = definition(f, stageId), s = getStage(app, itemId, stageId);
    if (!report.note.trim()) throw new HttpError(400, "交结果需要说明");
    if (report.state === "skip" ? s.state === "done" : !["doing", "blocked"].includes(s.state)) throw new HttpError(409, "已完成阶段不能跳过；交结果需要阶段进行中或卡住");
    if (report.state === "skip" && s.state === "skipped") return flowView(app, itemId);
    // An old carrier cannot finish the replacement's attempt.
    if (by.runId && (s.by === s.control.runId && !!s.by) && s.by !== by.runId) throw new HttpError(409, "这不是当前阶段的承担运行");
    if (by.runId && getRun(app, by.runId).input.flowStartedAt && (getRun(app, by.runId).input.flowStartedAt !== f.startedAt || getRun(app, by.runId).input.stageId !== stageId || s.control.runId !== by.runId)) throw new HttpError(409, "这次运行所属的流程、阶段或尝试已变化");
    const evidence = report.evidence ?? [];
    // What only the owner can settle stays the owner's: an agent saying "the owner has done it" becomes a
    // question to the owner, and an agent cannot skip a stage whose start or end waits for the owner.
    const ownerOnly = d.gate === "confirm" || d.done === "confirm" || d.by === "owner";
    if (report.state === "skip" && by.actor !== "owner" && ownerOnly) throw new HttpError(403, "这一段要本人确认或由本人承担，不能由你跳过：把理由告诉本人，由本人在卡片或事项页上跳过");
    const asksOwner = report.state === "done" && (d.done === "confirm" || d.by === "owner" && by.actor !== "owner");
    if (report.state === "done" && !asksOwner && (!evidence.length || evidence.some((r) => !validEvidence(app, r)))) throw new HttpError(400, "做完需要至少一项依据（src: 引用、运行 id 或对象引用）");
    if (by.actor === "owner") resetStreak(app, itemId);
    withdraw(app, s);
    if (asksOwner) {
      const askId = question(app, f, d, { ...s, askId: null }, "done", d.by === "owner" ? `「${d.name}」是你来做的一段，助手说已经做完了：${report.note}。是这样吗？` : `「${d.name}」做完了：${report.note}。确认吗？`, ["确认", "还不行"]);
      changeStage(app, itemId, stageId, "doing", { askId, evidence, waitingOn: "owner", control: { ...s.control, question: "done", reported: true } }, by, report.note, evidence);
    } else if (report.state === "done" && (typeof d.done === "object" || typeof d.by === "object" && "object" in d.by)) {
      changeStage(app, itemId, stageId, "doing", { askId: null, evidence, control: { ...s.control, reported: true } }, by, report.note, evidence);
    } else {
      changeStage(app, itemId, stageId, report.state === "skip" ? "skipped" : report.state, { askId: null, evidence, waitingOn: report.state === "blocked" ? report.waitingOn?.trim() || "待处理" : null, control: { ...s.control, question: undefined, reported: true } }, by, report.note, evidence);
      if (report.state === "skip") notify(app, { userId: getItem(app, itemId).userId, title: `「${d.name}」已跳过`, body: report.note, urgency: "later" });
    }
    await advanceNow(app, itemId, "承担者交结果");
    return flowView(app, itemId);
  });
}
function validEvidence(app: App, ref: string) {
  if (/^src:[\w-]+(?:#L\d+(?:-L?\d+)?)?$/.test(ref)) return !!one(app.db, "select 1 from sources where id=? and deleted_at is null", ref.slice(4).split("#")[0]);
  if (/^design:/.test(ref)) return !!one(app.db, "select 1 from designs where id=?", ref.slice(7));
  const id = ref.replace(/^(?:run:|code-work:)/, "");
  return !!one(app.db, "select 1 from runs where id=?", id);
}

export type OwnerAction = "confirm" | "hold" | "skip" | "done" | "reopen";
export function ownerAction(app: App, itemId: string, stageId: string, action: OwnerAction, note = "", userId = "owner") {
  return serial(app, itemId, async () => {
    if (getItem(app, itemId).userId !== userId) throw new HttpError(403, "只有事项本人能处理流程");
    await actionNow(app, itemId, stageId, action, note, { actor: "owner", userId });
    return flowView(app, itemId);
  });
}
async function actionNow(app: App, itemId: string, stageId: string, action: OwnerAction, note: string, by: FlowActor) {
  const f = action === "reopen" ? itemFlow(app, itemId) : running(app, itemId);
  if (!f) throw new HttpError(409, "事项没有流程");
  const d = definition(f, stageId), s = getStage(app, itemId, stageId);
  if (["skip", "done", "reopen"].includes(action) && !note.trim()) throw new HttpError(400, "需要写明原因或说明");
  if (action === "skip" && s.state === "done") throw new HttpError(409, "已完成阶段不能跳过，请先重开");
  if (action === "done" && !["doing", "blocked", "gated"].includes(s.state)) throw new HttpError(409, "只能手动完成进行中、卡住或等确认的阶段");
  if (["hold", "confirm"].includes(action) && s.state !== "gated" && !(action === "confirm" && s.state === "doing" && s.control.question === "done")) throw new HttpError(409, "这一段没有等确认的关卡");
  resetStreak(app, itemId);
  withdraw(app, s);
  if (action === "reopen") { reopenNow(app, itemId, stageId, note, [], by); }
  else if (action === "hold") changeStage(app, itemId, stageId, "gated", { askId: null, control: { ...s.control, reminderAt: now(), reminders: 0 } }, by, note || "本人先别做，暂缓");
  else if (action === "skip" || action === "done" || s.control.question === "done") changeStage(app, itemId, stageId, action === "skip" ? "skipped" : "done", { askId: null, waitingOn: null, control: { ...s.control, question: undefined, reported: true } }, by, note || "本人确认完成");
  else if (s.control.question === "when") changeStage(app, itemId, stageId, "pending", { askId: null, waitingOn: null, control: { ...s.control, question: undefined, whenYes: true, whenAttempt: s.attempt + 1 } }, by, note || "本人判断这一段要做");
  else changeStage(app, itemId, stageId, "pending", { askId: null, waitingOn: null, control: { ...s.control, question: undefined, confirmed: true } }, by, note || "本人同意开始");
  await advanceNow(app, itemId, `本人${action}`);
}

export function reopenStage(app: App, itemId: string, stageId: string, reason: string, refs: string[], by: FlowActor) {
  return serial(app, itemId, async () => {
    if (!reason.trim()) throw new HttpError(400, "重开需要原因");
    reopenNow(app, itemId, stageId, reason, refs, by);
    if (by.actor === "owner") resetStreak(app, itemId);
    await advanceNow(app, itemId, "重开阶段");
    return flowView(app, itemId);
  });
}
function reopenNow(app: App, itemId: string, stageId: string, reason: string, refs: string[], by: FlowActor) {
  const f = itemFlow(app, itemId);
  if (!f) throw new HttpError(409, "事项没有流程");
  definition(f, stageId);
  const s = getStage(app, itemId, stageId);
  withdraw(app, s);
  run(app.db, "update item_flows set ended_at=null,updated_at=? where item_id=?", now(), itemId);
  changeStage(app, itemId, stageId, "pending", { askId: null, by: null, waitingOn: null, control: { whenYes: s.control.whenYes } }, by, reason, refs);
  const affected = new Set([stageId]);
  for (const d of f.definition.stages) {
    if (!d.needs.some((n) => affected.has(n))) continue;
    affected.add(d.id);
    const row = getStage(app, itemId, d.id);
    if (row.state === "done") changeStage(app, itemId, d.id, "stale", { askId: null, waitingOn: null }, by, `上游「${stageId}」重开，等复核`, refs);
  }
}
function end(app: App, id: string, note: string) {
  if (!itemFlow(app, id) || itemFlow(app, id)!.endedAt) return;
  for (const s of itemStages(app, id)) withdraw(app, s);
  run(app.db, "update item_flows set ended_at=?,updated_at=? where item_id=?", now(), now(), id);
  // Keep ending on the same audit/timeline path (no extra completion ping).
  const last = itemStages(app, id).at(-1);
  if (last) changeStage(app, id, last.id, last.state, {}, host, note);
}
export function stopFlow(app: App, id: string, userId = "owner") {
  return serial(app, id, async () => {
    if (getItem(app, id).userId !== userId) throw new HttpError(403, "只有事项本人能停止流程");
    running(app, id); resetStreak(app, id); end(app, id, "本人停止了流程");
    return flowView(app, id);
  });
}

const answerText = (ask: Ask) => (ask.answer ?? "").replace(new RegExp(`^${ask.options[ask.choice ?? -1]?.label ?? "(?!)"}[：:，,\\s]*`), "").trim();
registerAskHandler("flow-stage", async (app, ask, ctx) => {
  const itemId = String(ctx.itemId), stageId = String(ctx.stageId);
  const item = getItem(app, itemId), f = itemFlow(app, itemId);
  // Both the intended recipient and the actual author must be this item's owner.
  if (!f || f.endedAt || f.startedAt !== ctx.startedAt || ask.userId !== item.userId || ask.answeredBy !== item.userId) return;
  await serial(app, itemId, async () => {
    const s = getStage(app, itemId, stageId), d = definition(f, stageId);
    if (s.askId !== ask.id || s.control.question !== ctx.kind) return;
    const text = answerText(ask);
    const skip = ctx.kind === "gate" && ask.choice === 2 || ["owner", "when"].includes(String(ctx.kind)) && ask.choice === 1 || ctx.kind === "skip";
    const refusal = ctx.kind === "done" && ask.choice === 1 || ctx.kind === "refuse";
    if (skip || refusal) {
      if (!text) {
        const kind = skip ? "skip" : "refuse";
        const askId = question(app, f, d, { ...s, askId: null }, kind, skip ? `「${d.name}」为什么跳过？请写原因。` : `「${d.name}」哪里还不行？请写意见。`, []);
        changeStage(app, itemId, stageId, s.state, { askId, control: { ...s.control, question: kind } }, { actor: "owner" }, "等本人补充原因"); resetStreak(app, itemId); return;
      }
      if (skip) await actionNow(app, itemId, stageId, "skip", text, { actor: "owner" });
      else {
        resetStreak(app, itemId);
        if (s.attempt >= 3) changeStage(app, itemId, stageId, "blocked", { askId: null, waitingOn: "owner", control: { ...s.control, question: undefined, reported: true } }, { actor: "owner" }, `三次仍未确认：${text}`);
        else {
          changeStage(app, itemId, stageId, "pending", { askId: null, waitingOn: null, control: { ...s.control, question: undefined, confirmed: true, feedback: text, reported: false } }, { actor: "owner" }, `本人要求重做：${text}`);
          await advanceNow(app, itemId, "本人要求重做");
        }
      }
    } else if (ask.choice === 0) await actionNow(app, itemId, stageId, ctx.kind === "owner" ? "done" : "confirm", text || "本人确认", { actor: "owner" });
    else if (ctx.kind === "gate" && ask.choice === 1) await actionNow(app, itemId, stageId, "hold", text, { actor: "owner" });
  });
}, (app, ask, ctx, by) => {
  const userId = getItem(app, String(ctx.itemId)).userId;
  if (ask.userId !== userId || by !== userId) throw new HttpError(403, "流程关卡只能由事项本人回答");
});

export function proposeFlow(app: App, raw: string, by: FlowActor) {
  const f = parseFlow(raw);
  return createAsk(app, { runId: by.runId ?? null, userId: by.userId ?? "owner", question: `启用流程「${f.name}」吗？\n${f.stages.map((s) => { const w = describeStage(s); return `- ${s.name}：${w.carrier}；${w.gate}，${w.done}${w.when ? `；${w.when}` : ""}`; }).join("\n")}`,
    options: [{ label: "启用" }, { label: "不用" }], allowText: false, context: { handler: "flow-save", raw } });
}
registerAskHandler("flow-save", async (app, ask, ctx) => {
  if (ask.userId !== "owner" || ask.answeredBy !== "owner" || ask.choice !== 0) return;
  saveFlow(app, String(ctx.raw), "owner");
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
function stageTests(app: App, itemId: string, stageId: string, since: string, current?: string) {
  const runs = new Set(all<{ run_id: string }>(app.db, "select distinct run_id from item_stage_log where item_id = ? and stage_id = ? and at >= ? and run_id is not null", itemId, stageId, since).map((r) => r.run_id));
  if (current) runs.add(current);
  const results = latestEach([...runs].flatMap((runId) => testsOfWork(app, { runId }))).sort((a, b) => RANK[a.status] - RANK[b.status] || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (!results.length) return [];
  const shots = new Map(artifactsByIds(app, [...new Set(results.flatMap((r) => r.artifacts))]).map((a) => [a.id, a]));
  const titles = new Map(all<{ id: string; title: string }>(app.db, `select id, title from req_nodes where id in (select value from json_each(?))`, JSON.stringify([...new Set(results.flatMap((r) => r.nodeId ?? []))])).map((n) => [n.id, n.title]));
  return results.map((r) => ({ id: r.id, name: r.name, status: r.status, mode: r.mode, note: r.note, at: r.at, runId: r.runId,
    req: r.nodeId && titles.has(r.nodeId) ? { id: r.nodeId, title: titles.get(r.nodeId)! } : null, artifacts: r.artifacts.flatMap((a) => shots.get(a) ?? []) }));
}

export function flowView(app: App, id: string) {
  const item = getItem(app, id), f = itemFlow(app, id), rows = itemStages(app, id);
  return {
    flow: f ? { id: f.id, name: f.definition.name, startedAt: f.startedAt, endedAt: f.endedAt, autoStreak: f.autoStreak } : null,
    stages: f?.definition.stages.map((d) => {
      const s = rows.find((r) => r.id === d.id)!;
      const kind = typeof d.by === "object" ? "object" in d.by ? d.by.object : "run" : d.by;
      const object = kind !== "run" && kind !== "owner" && kind !== "wait" ? findObject(app, item, kind) : typeof d.done === "object" && "object" in d.done ? findObject(app, item, d.done.object) : null;
      const signal = waitingSignal(app, id, d);
      return { id: d.id, name: d.name, instruction: d.note ?? "", state: s.state, attempt: s.attempt, since: s.since, enteredAt: s.enteredAt, doneAt: s.doneAt, by: s.by, waitingOn: s.waitingOn, evidence: s.evidence, note: ROUTINE.has(s.note) ? "" : s.note, gate: d.gate, fixed: d.fixed,
        carrier: { kind, label: objectKind(kind)?.label ?? (kind === "owner" ? "你" : kind === "wait" ? "只等进展" : typeof d.by === "object" && "run" in d.by && d.by.run.agent && d.by.run.agent !== "assistant" ? d.by.run.agent : "助手"), ...(object ? { link: object.link } : (s.by === s.control.runId && !!s.by) ? { link: `#/runs/${s.by}` } : {}) },
        ...(object ? { object: { title: object.title, status: object.status, link: object.link } } : {}), ...(s.askId ? { askId: s.askId } : {}), ...(signal ? { waitingSignal: signal } : {}), tests: stageTests(app, id, d.id, f!.startedAt, s.control.runId) };
    }) ?? [], log: stageLog(app, id), suits: f ? [] : flowsFor(app, item),
  };
}

export async function flowReminders(app: App, at = new Date()) {
  attachFlows(app);
  await checkGitSignals(app);
  for (const { item_id: id } of all<{ item_id: string }>(app.db, "select item_id from item_flows where ended_at is null")) await serial(app, id, async () => {
    // Recover terminal runs missed during downtime, then remind only the still-waiting stages.
    await advanceNow(app, id, "例行检查");
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
    if (e.type !== "run" && !(e.type === "changed" && ["code-task", "design"].includes(e.entity))) return;
    const ids = new Set<string>();
    const runIds = new Set<string>();
    if (e.type === "run") {
      const r = getRun(app, e.runId);
      if (typeof r.input.itemId === "string" && r.kind === "flow-stage") ids.add(r.input.itemId);
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
  app.events.on("event", listener);
  app.events.once("close", () => { app.events.off("event", listener); attached.delete(app); });
}

registerHandler("flow-stage", async (ctx) => {
  const input = ctx.run.input;
  const itemId = String(input.itemId), stageId = String(input.stageId);
  const f = itemFlow(ctx.app, itemId), s = getStage(ctx.app, itemId, stageId);
  if (!f || f.endedAt || f.startedAt !== input.flowStartedAt || s.control.runId !== ctx.run.id || s.state !== "doing") return { quiet: true, summary: "阶段已有新的状态，不再执行旧运行" };
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
  const result = await runRole(ctx.app, { role, spec: spec ?? undefined, spaceId: item.spaceId, spaces: [item.spaceId], task, runId: ctx.run.id, userId: item.userId, signal: ctx.signal, addTools: ["stage_report", "report_tests", "attach_artifact"], artifacts: true, onEvent: (e) => ctx.event(e.type, e) });
  return { text: result.text, ai: result.ai, sessionId: result.sessionId };
});

/** Git checks enter the same item queue as owner actions and revalidate the checked attempt. */
export function completeBySignal(app: App, itemId: string, stageId: string, note: string, evidence: string[], expected: { startedAt: string; attempt: number; enteredAt: string | null; type: GitSignal; work: string }) {
  return serial(app, itemId, async () => {
    const f = itemFlow(app, itemId);
    if (!f || f.endedAt || f.startedAt !== expected.startedAt) return false;
    const d = definition(f, stageId), s = getStage(app, itemId, stageId);
    if (s.state !== "doing" || s.attempt !== expected.attempt || s.enteredAt !== expected.enteredAt ||
      !(typeof d.done === "object" && "signal" in d.done && d.done.signal === expected.type) ||
      (d.by !== "owner" && d.by !== "wait") || findObject(app, getItem(app, itemId), "code-work")?.ref !== expected.work) return false;
    withdraw(app, s);
    changeStage(app, itemId, stageId, "done", { askId: null, waitingOn: null, evidence: [...new Set([...s.evidence, ...evidence])], control: { ...s.control, question: undefined, reported: true } }, host, note, evidence);
    await advanceNow(app, itemId, "Git 信号");
    return true;
  });
}
