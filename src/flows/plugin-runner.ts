import { z } from "zod";
import type { App } from "../core/app.ts";
import { addRunEvent, getRun, setRunOutput, ResumeRunAt, type Run, type RunContext } from "../agents/runs.ts";
import { untilAbort } from "../core/util.ts";
import { getItem } from "../items/store.ts";
import { stageRunners } from "../plugins/process-hooks.ts";
import { runnerApproved } from "./definitions.ts";
import { reportStage } from "./engine.ts";
import { evidenceSchema, flowContext } from "./plugin-signals.ts";
import { getStage, itemFlow } from "./store.ts";

const resultSchema = z.object({ ref: z.string().min(1).max(1024), status: z.enum(["running", "done", "failed"]),
  summary: z.string().max(4000).optional(), evidence: evidenceSchema.optional() });

const cancellations = new Map<string, Promise<void>>();

/** Cancel the external job identified by the last durable receipt, including between polls. */
export async function cancelRunnerJob(app: App, r: Run) {
  const pending = cancellations.get(r.id);
  if (pending) return pending;
  const output = getRun(app, r.id).output;
  const result = resultSchema.optional().parse(output.runnerResult ?? undefined);
  if (result?.status !== "running" || output.cancelledRunnerRef === result.ref) return;
  const cancellation = cancelExternalJob(app, r, result.ref).finally(() => cancellations.delete(r.id));
  cancellations.set(r.id, cancellation);
  return cancellation;
}

async function cancelExternalJob(app: App, r: Run, ref: string) {
  const entry = stageRunners.get(String(r.input.runner));
  if (!entry || !r.spaceId || entry.spaces.length && !entry.spaces.includes(r.spaceId) || !entry.def.cancel) {
    addRunEvent(app, r.id, "status", {text:"外部作业未确认取消：当前空间的运行器未提供取消操作"});
    return;
  }
  const signal = entry.context(app, getItem(app,String(r.input.itemId)).userId, r.spaceId, AbortSignal.timeout(5000)).signal;
  try {
    await untilAbort(signal, () => entry.def.cancel!(ref, signal));
    setRunOutput(app, r.id, { cancelledRunnerRef: ref });
  }
  catch (err) { addRunEvent(app, r.id, "error", {message:"取消外部作业失败：" + String(err)}); }
}

export async function runPluginStage(ctx: RunContext) {
  const { app } = ctx, r = getRun(app, ctx.run.id);
  const itemId = String(r.input.itemId), stageId = String(r.input.stageId);
  const f = itemFlow(app, itemId), d = f?.definition.stages.find(stage => stage.id === stageId);
  if (!f || f.endedAt || f.startedAt !== r.input.flowStartedAt || !d || typeof d.by !== "object" || !("runner" in d.by)) return;
  const s = getStage(app, itemId, stageId);
  if (s.control.runId !== r.id || s.control.reported || s.state !== "doing") return;
  const item = getItem(app, itemId), entry = stageRunners.get(d.by.runner), by = { actor: d.by.runner, runId: r.id };
  const deadline = d.budget?.minutes === undefined ? Infinity : Date.parse(s.enteredAt!) + d.budget.minutes * 60_000;
  let result = r.output.runnerResult ? resultSchema.parse(r.output.runnerResult) : undefined;
  try {
    if (!entry || entry.spaces.length && !entry.spaces.includes(item.spaceId)) throw Error("当前空间的运行器不可用");
    if (!runnerApproved(app, f.definition, itemId)) throw Error("插件运行器需要本人确认");
    if (!result || result.status === "running") {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw Error("已到阶段时限");
      const signal = entry.context(app, item.userId, item.spaceId, AbortSignal.any([ctx.signal, AbortSignal.timeout(Math.min(5000, remaining))])).signal;
      if (result && entry.def.check) {
        const ref = result.ref;
        result = resultSchema.parse(await untilAbort(signal, () => entry.def.check!(ref, signal)));
      } else {
        const input = await flowContext(app, item, d, s, d.by.with);
        result = resultSchema.parse(await untilAbort(signal, () => entry.def.start({ ...input, settings: entry.settings(app, item.userId),
          attempt: s.attempt, idempotencyKey: r.id }, signal)));
      }
      ctx.output({ runnerResult: result });
      if (Date.now() >= deadline) throw Error("已到阶段时限");
      if (result.status === "running") throw new ResumeRunAt(Math.min(deadline, Date.now() + 30_000));
    }
    if (result.status === "failed") throw Error(result.summary || "插件执行失败");
  } catch (e) {
    if (e instanceof ResumeRunAt) throw e;
    const note = Date.now() >= deadline ? "已到阶段时限" : String(e);
    if (!ctx.signal.aborted && Date.now() >= deadline) await cancelRunnerJob(app, getRun(app, r.id));
    if (!ctx.signal.aborted) await reportStage(app, itemId, stageId, { state: "blocked", waitingOn: "owner", note,
      evidence: [r.id], pluginEvidence: result?.evidence }, by);
    throw Error(note);
  }
  await reportStage(app, itemId, stageId, { state: "done", note: result.summary || entry.def.describe,
    evidence: [r.id], pluginEvidence: result.evidence }, by);
  return { summary: result.summary ?? entry.def.describe };
}
