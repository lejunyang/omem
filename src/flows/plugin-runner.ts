import { z } from "zod";
import { getRun, ResumeRunAt, type RunContext } from "../agents/runs.ts";
import { untilAbort } from "../core/util.ts";
import { getItem } from "../items/store.ts";
import { stageRunners } from "../plugins/process-hooks.ts";
import { runnerApproved } from "./definitions.ts";
import { reportStage } from "./engine.ts";
import { evidenceSchema, flowContext } from "./plugin-signals.ts";
import { getStage, itemFlow } from "./store.ts";

const resultSchema = z.object({ ref: z.string().min(1).max(1024), status: z.enum(["running", "done", "failed"]),
  summary: z.string().max(4000).optional(), evidence: evidenceSchema.optional() });

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
    if (!runnerApproved(app, f.definition)) throw Error("插件运行器需要本人确认");
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
    let note = Date.now() >= deadline ? "已到阶段时限" : String(e);
    if ((Date.now() >= deadline || ctx.signal.aborted) && result?.ref && entry?.def.cancel) {
      const signal = AbortSignal.timeout(5000), ref = result.ref;
      try { await untilAbort(signal, () => entry.def.cancel!(ref, signal)); }
      catch (err) { note += "，取消失败：" + String(err); }
    }
    if (!ctx.signal.aborted) await reportStage(app, itemId, stageId, { state: "blocked", waitingOn: "owner", note,
      evidence: [r.id], pluginEvidence: result?.evidence }, by);
    throw Error(note);
  }
  await reportStage(app, itemId, stageId, { state: "done", note: result.summary || entry.def.describe,
    evidence: [r.id], pluginEvidence: result.evidence }, by);
  return { summary: result.summary ?? entry.def.describe };
}
