import type { App } from "../core/app.ts";
import { one } from "../core/db.ts";
import { truncate } from "../core/util.ts";
import type { Item } from "../items/store.ts";
import { ordinaryOwnerTurn, type FlowStage } from "./definitions.ts";
import { latestCodeWork } from "./objects.ts";
import type { StageRow } from "./store.ts";
import { stageTiming } from "./timing.ts";

export const OWNER_QUESTION_GRACE = 3600_000;

export function observableOwnerTurn(stage: FlowStage, row: StageRow) {
  return ordinaryOwnerTurn(stage) && row.state === "doing" && row.waitingOn === "owner" && !row.control.reported
    && !row.control.upstream && !row.control.gateReview && (!row.control.question || row.control.question === "owner");
}

const recognition = "做完不用回来点，助手会从群里的消息、事项上挂的对象和你说的话里认出来；这次不做就说一声。";

const ownerTask = (stage: FlowStage) => stage.note?.split(/[。！？\n]/).find(line => line.trim() && !/(?:^|后|再|请|回来|卡片上|[\s，,])点(?:击)?[“「\s]*(?:我做完|做完|完成)/.test(line))?.trim() || stage.name;
export const ownerTaskLine = (stage: FlowStage) => `${truncate(ownerTask(stage), 160)}。${recognition}`;

export function ownerTimingAt(app: App, stage: FlowStage, entered: string) {
  if (stage.window) return stageTiming(new Date(entered), app.config.timezone, { window: stage.window.split("-").reverse().join("-") }).nextAt ?? entered;
  return stage.at ? entered : undefined;
}

export function ownerPlanAt(app: App, item: Item, stage: FlowStage, row: StageRow) {
  return [item.dueAt, row.control.ownerPlanAt ?? ownerTimingAt(app, stage, row.enteredAt ?? row.since)]
    .filter((value): value is string => !!value && Number.isFinite(Date.parse(value))).map(value => new Date(value).toISOString()).sort()[0];
}

export function pendingPushConfirmation(app: App, item: Item, stage: FlowStage) {
  if (stage.by !== "owner" || typeof stage.done !== "object" || !("signal" in stage.done) || stage.done.signal !== "git.pushed") return false;
  const work = latestCodeWork(app, item);
  return !!work && !!one(app.db, `select 1 from asks where run_id=? and user_id=? and status='pending'
    and json_extract(context,'$.handler')='review-done' and json_extract(context,'$.codeRunId')=run_id
    and exists (select 1 from json_each(options) where json_extract(value,'$.label')='确认并推送') limit 1`, work.latestId, item.userId);
}

export function ownerTurnNote(stage: FlowStage, pushConfirmation: boolean) {
  return pushConfirmation ? "在『交办完成』那张卡片上点确认并推送，这一段随之完成。" : `等你：${ordinaryOwnerTurn(stage) ? ownerTask(stage) : stage.note?.trim() || stage.name}`;
}
