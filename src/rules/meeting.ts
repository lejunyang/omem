import { describe, evaluate, eventReader, fieldsOf } from "./conditions.ts";
import { FIELDS, type RuleAction, type RuleEvent } from "./types.ts";

/** The same decision for execution and preview. Unknown facts require the owner's confirmation. */
export async function meetingConfirmation(action: Pick<Extract<RuleAction, { type: "meeting-bot" }>, "bots" | "confirm">, event: RuleEvent) {
  if (!action.bots.length) return { confirm: false, reason: "不拉机器人，无需确认" };
  if (typeof action.confirm === "boolean") return { confirm: action.confirm, reason: action.confirm ? "先发卡片问你" : "直接拉机器人入会" };
  const read = eventReader(event);
  const unknown: string[] = [];
  for (const field of new Set(fieldsOf(action.confirm))) {
    const value = await read(field);
    if (value === undefined || value === null || value === "") unknown.push(FIELDS[field]);
  }
  if (unknown.length) return { confirm: true, reason: `${unknown.join("、")}未知，先发卡片问你` };
  const confirm = await evaluate(action.confirm, read);
  return { confirm, reason: `${confirm ? "满足" : "不满足"}确认条件（${describe(action.confirm)}），${confirm ? "先发卡片问你" : "直接拉机器人入会"}` };
}
