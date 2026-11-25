import type { App } from "../core/app.ts";
import { one } from "../core/db.ts";
import type { Item } from "../items/store.ts";
import type { FlowStage } from "./definitions.ts";
import { latestCodeWork } from "./objects.ts";

export function pendingPushConfirmation(app: App, item: Item, stage: FlowStage) {
  if (stage.by !== "owner" || typeof stage.done !== "object" || !("signal" in stage.done) || stage.done.signal !== "git.pushed") return false;
  const work = latestCodeWork(app, item);
  return !!work && !!one(app.db, `select 1 from asks where run_id=? and user_id=? and status='pending'
    and json_extract(context,'$.handler')='review-done' and json_extract(context,'$.codeRunId')=run_id
    and exists (select 1 from json_each(options) where json_extract(value,'$.label')='确认并推送') limit 1`, work.latestId, item.userId);
}

export function ownerTurnNote(stage: FlowStage, pushConfirmation: boolean) {
  return pushConfirmation ? "在『交办完成』那张卡片上点确认并推送，这一段随之完成。" : `等你：${stage.note?.trim() || stage.name}`;
}
