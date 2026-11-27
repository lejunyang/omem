import { groupPick, policyScope, policyReason, type PolicyScope } from "./ai-policy.ts";
import { z } from "zod";
import type { App } from "../core/app.ts";
import { HttpError } from "../core/util.ts";
import { effortsFor, probeFor, userProbe } from "./probe.ts";
import { isAiMember, memberAccountPlan } from "./accounts.ts";
import { allProfiles } from "../core/config.ts";
import { backendAvailable } from "./availability.ts";
import { resolveModelOption } from "./models.ts";
import { excluded, excludedReason } from "./capacity.ts";

/** A temporary choice, recorded with the task, never written back to a profile. */
export const executionSchema = z.object({
  profile: z.string().min(1).describe("后端 id，不是 Agent 档案名；先 list_ai_backends 核对"),
  model: z.string().min(1).optional(),
  effort: z.string().min(1).optional(),
  source: z.enum(["user", "auto", "flow"]).default("auto").describe("本人明确指定用 user；助手根据任务选择用 auto；流程指定用 flow"),
  reason: z.string().min(1).max(1000).describe("本人指定的要求，或为什么这个任务适合此 AI"),
});
export type Execution = z.infer<typeof executionSchema>;

/** `userId`: whose run it is: a member logged in to the backend is checked against their own account's models. */
export function validateExecution(app: App, choice?: Execution, userId?: string, recorded = false, scope: PolicyScope | null | undefined = policyScope(app, "agent"), ownerNamed = false): Execution | undefined {
  if (!choice) return undefined;
  const e = executionSchema.parse(choice);
  if (e.source === "auto" && !app.config.agents.routing.automatic) throw new HttpError(403, "已关闭助手自主选型；使用档案默认值，只有本人明确指定才能临时更换");
  if (app.config.agents.groups.some(g => g.id === e.profile)) {
    const pick = groupPick(app, e.profile, scope ?? undefined);
    if (!pick) throw new HttpError(400, "AI 组 " + e.profile + " 没有符合规则的可用后端");
    Object.assign(e, pick);
  }
  const backend = allProfiles(app.config).find((p) => p.id === e.profile);
  if (!backend || (!recorded && !backendAvailable(backend, app.home))) throw new HttpError(400, `后端 ${e.profile} 不可用，请先 list_ai_backends 核对`);
  const candidate = { ...backend, model: e.model ?? backend.model };
  const plan = userId && isAiMember(app, userId) ? memberAccountPlan(app, userId, candidate) : null;
  const probe = plan ? plan.kind === "ready" ? probeFor(app, plan.profile) : null : userProbe(app, userId, e.profile);
  if (e.model && probe?.models.length) {
    const resolved = resolveModelOption(e.model, probe.models);
    if (!resolved.matched) throw new HttpError(400, `模型 ${e.model} 不在 ${e.profile} 的检测结果中`);
    e.model = resolved.value;
  }
  const effective = plan?.kind === "ready" ? { ...plan.profile, model: e.model ?? backend.model } : candidate;
  const reason = policyReason(scope ?? undefined, { ...effective, model: e.model ?? effective.model, effort: e.effort ?? effective.effort });
  if (reason && !ownerNamed) throw new HttpError(400, "所选 AI 不符合规则：" + reason);
  if (!recorded && e.source === "auto" && (plan?.kind === "blocked" || (plan?.kind !== "login" && excluded(app, effective))))
    throw new HttpError(400, `${e.profile}${e.model ? ` · ${e.model}` : ""} 当前不可自动使用：${plan?.kind === "blocked" ? plan.reason : excludedReason(app, effective) ?? "不可用"}，换一个`);
  const levels = e.model ? effortsFor(probe, e.model) : [];
  const knownEmpty = e.model && probe?.effortsByModel && Object.hasOwn(probe.effortsByModel, e.model ?? backend.model ?? "") && !levels.length;
  if (e.effort && (knownEmpty || (levels.length && !levels.includes(e.effort)))) throw new HttpError(400, `思考强度 ${e.effort} 不适用于该模型`);
  return e;
}

export function executionArgs(e?: Execution) {
  return e ? { profileId: e.profile, model: e.model, effort: e.effort } : {};
}
