import type { App } from "../core/app.ts";
import { all, one, run, withinTx } from "../core/db.ts";
import { HttpError } from "../core/util.ts";
import { autoFollowFor, ensureAutoFollow } from "../agents/auto-follow.ts";
import { cancelAsk, conversationOfRun, createAsk, getAsk, type Ask } from "../agents/asks.ts";
import { followAiLabel, type LongTask } from "../agents/long-tasks.ts";
import { wakeSupervisor } from "../agents/supervisor.ts";
import { findThread } from "../agents/threads.ts";
import { CLOSED_STATUSES, getItem } from "../items/store.ts";
import { changeStage, getStage, itemFlow, itemStages, type ItemFlow } from "../flows/store.ts";
import { idleRounds, isStudy } from "./store.ts";

/** `owner`: the owner asked for a follow-up on this study, also after an earlier "不用跟进" or with the switch off. */
export function followStudyRound(app: App, f: ItemFlow, reason: "start" | "backfill" | "owner", runId?: string, note?: string) {
  if (!isStudy(f)) return null;
  const item = getItem(app, f.itemId);
  const origin = conversationOfRun(app, runId ?? null);
  const thread = origin ? findThread(app, origin) : null;
  return ensureAutoFollow(app, { kind: "study", startingRound: reason === "start", explicit: reason === "owner", sourceId: item.id, userId: item.userId, spaceId: item.spaceId,
    threadId: thread?.spaceId === item.spaceId && thread.userId === item.userId ? thread.id : undefined,
    goal: note || item.detail || item.title });
}

/** Attach a follow-up to a running study and hand it the study's open decisions (directions, results to accept, the next round). */
function adoptStudy(app: App, f: ItemFlow, reason: "backfill" | "owner") {
  const id = f.itemId;
  const origin = one<{ run_id: string }>(app.db, "select run_id from item_stage_log where item_id=? and at>=? and run_id is not null and note='加入流程' order by at limit 1", id, f.startedAt);
  const follow = followStudyRound(app, f, reason, origin?.run_id);
  if (!follow) return null;
  for (const s of itemStages(app, id)) {
    if (!s.askId) continue;
    const old = getAsk(app, s.askId);
    if (old.status !== "pending") continue;
    // The owner's "next round?" card is asked again below, of the follow-up.
    if (old.handler === "study-next-round") { cancelAsk(app, old.id, "研究关卡已交给跟进助手"); continue; }
    const stage = f.definition.stages.find(d => d.id === s.id);
    const confirmResult = old.handler === "flow-stage" && s.control.question === "done" && stage?.confirm === "supervisor";
    if (old.handler !== "study-plan" && !confirmResult) continue;
    const ctx = one<{ context: string }>(app.db, "select context from asks where id=?", old.id)!;
    cancelAsk(app, old.id, "研究关卡已交给跟进助手");
    const ask = studyGate(app, follow, { runId: null, userId: old.userId, question: old.question, options: old.options, allowText: old.allowText, context: { ...JSON.parse(ctx.context), round: f.round } });
    changeStage(app, id, s.id, s.state, { askId: ask.id, waitingOn: "跟进助手" }, { actor: "host" }, confirmResult ? "等跟进助手验收结果" : "等跟进助手选方向");
  }
  if (f.roundClosedAt && f.definition.repeat && !f.nextRoundAt) askStudyNextRound(app, f, follow, idleRounds(app, id));
  return follow;
}

/** The owner hands a running study to a follow-up again (the auto switch can stay off). */
export function followStudy(app: App, itemId: string, userId: string) {
  const item = getItem(app, itemId), f = itemFlow(app, itemId);
  if (item.userId !== userId) throw new HttpError(403, "只有研究本人可以交给跟进");
  if (!f || f.endedAt || !isStudy(f) || CLOSED_STATUSES.includes(item.status)) throw new HttpError(409, "这件事项没有进行中的研究");
  return autoFollowFor(app, "study", itemId) ?? withinTx(app.db, () => adoptStudy(app, f, "owner"))!;
}

/** Who follows a study now, for its flow view. */
export function studyFollowView(app: App, itemId: string) {
  const task = autoFollowFor(app, "study", itemId);
  return task ? { id: task.id, status: task.status, ai: followAiLabel(task.ai) } : null;
}

export function studyGate(app: App, follow: LongTask | null, input: Parameters<typeof createAsk>[1]) {
  if (!follow) return createAsk(app, input);
  return withinTx(app.db, () => {
    // Reports return option text. Keep directions distinguishable even when the card shortens their titles.
    let options = input.options ?? [];
    if (new Set(options.map(o => o.label.trim().slice(0, 40))).size < options.length)
      options = options.map((o, i) => ({ ...o, label: `${i + 1}. ${o.label}` }));
    const ask = createAsk(app, { ...input, options, context: { ...input.context, notificationOnly: true, supervisorTaskId: follow.id } });
    wakeSupervisor(app, follow.id, [`研究第 ${input.context?.round} 轮的问题 ${ask.id}`, ask.question,
      `选项：${ask.options.map(o => o.label).join(" / ")}`,
      "授权内的选择用 answers 写回原选项并记录理由；任务书要求本人决定的用 askOwner 带上这个 questionId。"].join("\n"), { immediate: true });
    return ask;
  });
}

/** Study gates are tied to this attempt and round, including while an owner card is in flight. */
export function checkStudyGate(app: App, ask: Ask, ctx: Record<string, unknown>, by: string, choice: number | null, startsWork: boolean) {
  const id = String(ctx.itemId), item = getItem(app, id), f = itemFlow(app, id);
  if (ask.userId !== item.userId) throw new HttpError(403, "这个关卡不属于研究本人");
  if (by !== item.userId) {
    const follow = autoFollowFor(app, "study", id);
    if (by !== "supervisor" || !follow || follow.status !== "active" || follow.id !== ctx.supervisorTaskId || follow.userId !== item.userId)
      throw new HttpError(403, "只有事项本人或当前负责跟进的助手可以选择");
    if (startsWork && Date.now() >= Date.parse(follow.createdAt) + follow.budget.hours * 3_600_000)
      throw new HttpError(409, "跟进总时长预算已用完，继续研究前请本人决定");
    if (choice === null) throw new HttpError(400, "请按研究关卡的原选项回答");
  }
  if (!f || f.endedAt || f.startedAt !== ctx.startedAt || f.round !== ctx.round || getStage(app, id, String(ctx.stageId)).askId !== ask.id)
    throw new HttpError(409, "研究关卡或提案已失效");
  return f;
}

export function askStudyNextRound(app: App, f: ItemFlow, follow: LongTask, idle: number) {
  const stages = itemStages(app, f.itemId), last = getStage(app, f.itemId, f.definition.stages.at(-1)!.id);
  const wrap = f.definition.stages.find(d => d.tools?.includes("record_finding"));
  const summary = stages.find(s => s.id === wrap?.id)?.note || last.note;
  const ask = studyGate(app, follow, { runId: null, userId: follow.userId,
    question: [`第 ${f.round} 轮已完成，接下来怎么做？`, summary, idle ? `连续 ${idle} 轮没有新发现。` : ""].filter(Boolean).join("\n"),
    options: [{ label: "开始下一轮" }, { label: "停在这一轮" }], allowText: false,
    context: { handler: "study-next-round", itemId: f.itemId, stageId: last.id, startedAt: f.startedAt, round: f.round } });
  // Keep the stage's conclusion intact when attaching the round decision.
  run(app.db, "update item_stages set ask_id=? where item_id=? and stage_id=?", ask.id, f.itemId, last.id);
}

/** On detach the ordinary ask delivery restores the cards. Update the workflow's waiting party too. */
export function resumeStudyWithoutFollow(app: App, studyId: string) {
  for (const s of itemStages(app, studyId)) {
    if (s.waitingOn === "跟进助手" && s.askId && getAsk(app, s.askId).status === "pending")
      changeStage(app, studyId, s.id, s.state, { waitingOn: "owner" }, { actor: "host" }, "已退出跟进，等本人选择");
  }
}

export async function backfillStudyFollow(app: App) {
  if (!app.config.longTasks.auto.studies) return;
  let after = "";
  for (;;) {
    const rows = all<{ item_id: string; definition: string }>(app.db, `select f.item_id,f.definition from item_flows f join items i on i.id=f.item_id
      where f.item_id>? and f.ended_at is null and i.status not in (${CLOSED_STATUSES.map(() => "?").join(",")})
      and not exists (select 1 from long_tasks t where t.source_kind='study' and t.source_id=f.item_id)
      order by f.item_id limit 100`, after, ...CLOSED_STATUSES);
    for (const { item_id: id, definition } of rows) {
      if (!isStudy({ definition: JSON.parse(definition) })) continue;
      const f = itemFlow(app, id)!;
      withinTx(app.db, () => adoptStudy(app, f, "backfill"));
    }
    if (rows.length < 100) return;
    after = rows.at(-1)!.item_id;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}
