import { z } from "zod";
import { HttpError, newId, truncate } from "../core/util.ts";
import { hasRunner, parseFlow, stageFields, type FlowDefinition } from "./definitions.ts";

export const inlineStages = z.array(stageFields.extend({
  gate: z.enum(["auto", "confirm"]).optional(),
  effect: z.enum(["read", "local", "external"]).optional().describe("只读 / 本地可回退 / 写外部系统或发消息；有疑问就留空或填 external"),
})).min(1).max(20);
export type InlineStart = { name?: string; stages: z.infer<typeof inlineStages> };
export const inlineId = (id: string) => /^once-[a-z0-9]{19}$/.test(id);

export function inlineDefinition(start: InlineStart, title: string) {
  const stages = inlineStages.parse(start.stages).map(({ effect, ...s }) => {
    // Unknown actions ask first. A wait, absent an explicit effect, starts without doing anything.
    const safe = effect === "read" || effect === "local" || (!effect && s.by === "wait");
    return { ...s, gate: safe ? s.gate ?? "auto" : "confirm" };
  });
  const flow = parseFlow(JSON.stringify({ id: newId("once-"), name: start.name ?? truncate(title, 200), stages }));
  if (hasRunner(flow)) throw new HttpError(403, "插件运行器须由本人授权流程版本；请先保存并启用模板");
  if (flow.stages.some(s => s.tools?.length || typeof s.by === "object" && "object" in s.by && ["trials", "fixes"].includes(s.by.object)))
    throw new HttpError(400, "研究专用阶段请用研究流程模板");
  return flow;
}

export function inlineTemplate(space: string, definition: FlowDefinition) {
  const id = definition.id.replace(/^once-/, "template-");
  return { ...definition, id, for: { spaces: [space] }, name: definition.name };
}
