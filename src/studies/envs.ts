import type { App } from "../core/app.ts";
import { HttpError } from "../core/util.ts";
import type { FlowStage } from "../flows/definitions.ts";
import { studyScope } from "./scope.ts";

export function studyEnvs(app: App, item: string) {
  return [{ id: "local", name: "本机", note: "在本机的课题工作区里执行。", thirdParty: studyScope(app, item).thirdParty, ai: undefined as FlowStage["ai"] }, ...app.config.studies.envs];
}
export function resolveEnv(app: App, item: string, value: string) {
  const key = value.trim().toLowerCase() || "local", envs = studyEnvs(app, item);
  const found = envs.find((e) => e.id.toLowerCase() === key || e.name.trim().toLowerCase() === key);
  if (!found) throw new HttpError(400, `不认识执行环境「${value}」。可以用的执行环境：\n${envs.map((e) => `${e.id} / ${e.name}：${e.note.split(/\r?\n/)[0]}`).join("\n")}`);
  return found;
}
export function envMaterials(app: App, item: string) {
  return `## 可以用的执行环境\n${studyEnvs(app, item).map((e) => `- ${e.id} / ${e.name}\n${e.note}\n${e.thirdParty ? "可以" : "不可以"}执行第三方样本的代码`).join("\n\n")}`;
}
export const thirdPartyReason = "这个方向要执行第三方样本的代码：在课题的范围里打开本机执行，或让它换一个允许的环境";
export function checkDirectionChoice(app: App, item: string, d: { env: string; third_party: number }, allowCode?: boolean) {
  if (d.third_party && !resolveEnv(app, item, d.env).thirdParty) throw new HttpError(409, thirdPartyReason);
  const scope = studyScope(app, item);
  if (allowCode && !scope.allowCode) throw new HttpError(409, "先在课题范围里打开可以改代码");
  return allowCode ?? scope.allowCode;
}
export function trialStage(app: App, item: string, env: string, d: FlowStage): FlowStage {
  return { ...d, ai: resolveEnv(app, item, env).ai ?? d.ai };
}
