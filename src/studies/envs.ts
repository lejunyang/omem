import type { App } from "../core/app.ts";
import { HttpError } from "../core/util.ts";
import { findPeer } from "../core/peers.ts";
import type { FlowStage } from "../flows/definitions.ts";
import { studyScope } from "./scope.ts";

export type StudyEnv = { id: string; name: string; note: string; thirdParty: boolean; ai?: FlowStage["ai"]; peer?: string };
export function studyEnvs(app: App, item: string): StudyEnv[] {
  return [{ id: "local", name: "本机", note: "在本机的课题工作区里执行。", thirdParty: studyScope(app, item).thirdParty }, ...app.config.studies.envs];
}
export function resolveEnv(app: App, item: string, value: string) {
  const key = value.trim().toLowerCase() || "local", envs = studyEnvs(app, item);
  const found = envs.find((e) => e.id.toLowerCase() === key || e.name.trim().toLowerCase() === key);
  if (!found) throw new HttpError(400, `不认识执行环境「${value}」。可以用的执行环境：\n${envs.map((e) => `${e.id} / ${e.name}：${e.note.split(/\r?\n/)[0]}`).join("\n")}`);
  return found;
}
export function envMaterials(app: App, item: string) {
  return `## 可以用的执行环境\n${studyEnvs(app, item).map((e) => `- ${e.id} / ${e.name}\n${e.note}${e.peer ? `\n试验派给本人的另一台设备 ${e.peer}，由它用自己的模型、在它自己的工作区里跑；那台要有同一个仓库（按远端地址认）` : ""}\n${e.thirdParty ? "可以" : "不可以"}执行第三方样本的代码`).join("\n\n")}`;
}
/**
 * Settings → 流程: an environment that hands its trials to another device names one paired here, and
 * not a server known to be someone else's. Only the entries whose device is new or changed are
 * checked, so unpairing a device later does not lock the rest of the settings (its trials are then
 * recorded as unable to run, with why).
 */
export async function checkEnvPeers(app: App, next: StudyEnv[], before: StudyEnv[] = app.config.studies.envs) {
  const { knownCards } = await import("../core/mesh.ts");
  for (const e of next) {
    if (!e.peer || before.some((b) => b.id === e.id && b.peer === e.peer)) continue;
    if (!findPeer(app, e.peer)) throw new HttpError(400, `执行环境「${e.name}」的设备 ${e.peer} 没有配对：先在 设置 → 设备 里添加它`);
    if (knownCards(app).find((c) => c.peer === e.peer)?.card?.as === "service") throw new HttpError(400, `执行环境「${e.name}」：${e.peer} 是别人的服务，试验只派给你自己的设备`);
  }
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
