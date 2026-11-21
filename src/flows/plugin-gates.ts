import { z } from "zod";
import type { App } from "../core/app.ts";
import { one, run } from "../core/db.ts";
import { HttpError, untilAbort } from "../core/util.ts";
import { createAsk, cancelAsk } from "../agents/asks.ts";
import { getItem } from "../items/store.ts";
import { stageGates } from "../plugins/process-hooks.ts";
import { audit } from "../auth/permissions.ts";
import { readFlow } from "./definitions.ts";
import { evidenceSchema } from "./plugin-signals.ts";
import { changeStage, getStage, itemFlow, type FlowActor, type StageRow, type StageState } from "./store.ts";

export const gateChecksSchema = z.array(z.object({
  id: z.string().regex(/^[a-z][a-z0-9]*:[a-z][a-z0-9-]{0,47}$/),
  stages: z.array(z.string()).max(20).optional(), mandatory: z.boolean().default(false),
}).strict()).max(30).refine(v => new Set(v.map(c => c.id)).size === v.length, "检查不能重复");
type Check = z.infer<typeof gateChecksSchema>[number];
type StoredCheck = Check & { scope?: { stages?: string[]; spaces: readonly string[] } };
export type CompletionPatch = Partial<Omit<StageRow, "itemId" | "id" | "state">>;
export type GateReview = { summary: string; refs: string[];
  failed: { id: string; reason: string; evidence?: z.infer<typeof evidenceSchema> }[] };
function storedChecks(app: App, id: string): StoredCheck[] {
  const saved = one<{ value: string }>(app.db, "select value from kv where key=?", "flow-checks:" + id);
  return saved ? JSON.parse(saved.value) : [];
}
export function checksForFlow(app: App, id: string): Check[] {
  return storedChecks(app,id).map(({scope: _, ...check}) => check);
}
export function saveGateChecks(app: App, id: string, checks: Check[]) {
  const f = readFlow(app, id), validated = gateChecksSchema.parse(checks);
  const stored = validated.map(c => {
    const entry = stageGates.get(c.id);
    if (!entry) throw new HttpError(400, "检查不可用：" + c.id);
    if (entry.def.applies?.flows && !entry.def.applies.flows.includes(id)) throw new HttpError(400, "检查不适用于这个流程");
    for (const stage of c.stages ?? []) {
      if (!f.stages.some(s => s.id === stage) || entry.def.applies?.stages && !entry.def.applies.stages.includes(stage))
        throw new HttpError(400, "检查不适用于这个阶段：" + stage);
    }
    return { ...c, scope: {stages:entry.def.applies?.stages, spaces:entry.spaces} };
  });
  run(app.db, "insert or replace into kv(key,value) values(?,?)", "flow-checks:" + id, JSON.stringify(stored));
  audit(app, "owner", "flow.checks", id, { checks: validated });
  return validated;
}
const verdict = z.union([z.object({ ok: z.literal(true) }), z.object({ ok: z.literal(false), reason: z.string().trim().min(1).max(2000), evidence: evidenceSchema.optional() })]);

/** The host calls this only after its own completion rules and approval have passed. */
export async function finishStage(app: App, itemId: string, stageId: string, state: StageState, patch: CompletionPatch,
  by: FlowActor, note: string, refs: string[] = []) {
  const f = itemFlow(app, itemId)!, s = getStage(app, itemId, stageId);
  if (state !== "done") {
    if (s.control.gateReview && s.askId) cancelAsk(app, s.askId, "阶段结果已变化");
    changeStage(app, itemId, stageId, state, { ...patch, control: { ...s.control, ...patch.control, gateReview: undefined } }, by, note, refs);
    return;
  }
  const item = getItem(app, itemId), d = f.definition.stages.find(d => d.id === stageId)!;
  const summary = s.control.question === "done" ? s.note : note;
  const failed: GateReview["failed"] = [], budget = AbortSignal.timeout(8000);
  const evidence = patch.control?.pluginEvidence ?? s.control.pluginEvidence ?? (patch.evidence ?? s.evidence).map(text => ({ text }));
  for (const check of storedChecks(app, f.id).filter(c => !c.stages || c.stages.includes(stageId)).sort((a,b) => a.id.localeCompare(b.id))) {
    const entry = stageGates.get(check.id);
    const applies = entry ? entry.def.applies : check.scope;
    const spaces = entry?.spaces ?? check.scope?.spaces;
    if (entry?.def.applies?.flows && !entry.def.applies.flows.includes(f.id)) continue;
    if (applies?.stages && !applies.stages.includes(stageId) || spaces?.length && !spaces.includes(item.spaceId)) continue;
    let reason: string | undefined;
    try {
      if (!entry) throw Error("检查插件已停用");
      const signal = entry.context(app, item.userId, item.spaceId, AbortSignal.any([budget, AbortSignal.timeout(2000)])).signal;
      const result = verdict.parse(await untilAbort(signal, () => entry.def.review({
        item: { id: item.id, title: item.title, spaceId: item.spaceId },
        stage: { id: d.id, name: d.name, since: s.enteredAt ?? s.since }, result: { summary, evidence }, by: by.actor,
      }, signal)));
      if (!result.ok) failed.push({ id: check.id, reason: result.reason, evidence: result.evidence });
    } catch (e) {
      reason = "检查问不到：" + String(e).slice(0, 500);
      if (check.mandatory) failed.push({ id: check.id, reason });
      else changeStage(app, itemId, stageId, s.state, {}, { actor: "host" }, `${check.id}：${reason}，按非强制检查放行`);
    }
  }
  if (!failed.length) {
    changeStage(app, itemId, stageId, state, { ...patch, control: { ...s.control, ...patch.control, gateReview: undefined } }, by, note, refs);
    return;
  }
  if (s.askId) cancelAsk(app, s.askId, "完成结果重新检查");
  const review: GateReview = { summary, refs, failed };
  const ask = createAsk(app, { userId: "owner", runId: by.runId ?? null, question: `「${d.name}」被检查拦下，是否仍然通过？\n\n${failed.map(v => `${v.id}：${v.reason}`).join("\n")}`,
    options: [{ label: "仍然通过" }, { label: "等处理" }], context: { handler: "flow-plugin-gate", itemId, stageId } });
  changeStage(app, itemId, stageId, "blocked", { ...patch, askId: ask.id, waitingOn: "owner", control: { ...s.control, ...patch.control, gateReview: review } }, by,
    failed.map(v => `${v.id}：${v.reason}`).join("\n"), refs);
}
export async function overrideStageGate(app: App, itemId: string, stageId: string, askId: string) {
  const s = getStage(app, itemId, stageId), review = s.control.gateReview;
  if (s.state !== "blocked" || s.askId !== askId || !review) throw new HttpError(409, "这次检查已经处理");
  changeStage(app, itemId, stageId, "done", { askId: null, waitingOn: null,
    control: { ...s.control, gateReview: undefined } }, { actor: "owner", userId: "owner" },
    `本人仍然通过，越过检查 ${review.failed.map(v => v.id).join("、")}\n${review.summary}`, review.refs);
  audit(app, "owner", "flow.gate-override", itemId, { stage: stageId, checks: review.failed.map(v => v.id), askId });
}
