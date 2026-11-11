import type { App } from "../core/app.ts";
import type { Run } from "../agents/runs.ts";
import { designMarkdown } from "./render.ts";
import { getDesign, type Design } from "./store.ts";

/**
 * The owner's own design, before coding (docs/v2/coding-plan.md §3): `designer` investigates in the
 * delegation's workspace (read-only) and hands in the design with submit_design, which writes into
 * the design the run is bound to (`run.input.designId`). When it is called, how the owner confirms
 * and how coding goes on afterwards is the delegation's business; this only runs the role.
 * `design`: the design to write (drafting; with versions already, the next one goes by what was
 * said about the last). Returns it as handed in, or null when the role handed nothing in.
 */
export async function runDesigner(app: App, o: {
  design: Design; run: Run; task: string; cwd?: string; spaces?: string[] | null; signal: AbortSignal; event: (type: string, data: unknown) => void;
}): Promise<{ design: Design | null; text: string; ai: { profile: string; model?: string; effort?: string } }> {
  const { runRole } = await import("../agents/runner.ts");
  if ((o.run.input as { designId?: string }).designId !== o.design.id) throw new Error(`运行 ${o.run.id} 没有绑定方案 ${o.design.id}`);
  o.event("status", { phase: "design", text: o.design.revision ? `改方案：按意见写第 ${o.design.revision + 1} 版` : "写方案：调查后交一份方案，等本人确认后再编码" });
  const before = o.design.revision;
  const res = await runRole(app, {
    role: "designer",
    spaceId: o.run.spaceId ?? o.design.spaceId,
    spaces: o.spaces,
    task: [
      "# 写方案",
      `下面这次交办编码之前先写方案（方案 ${o.design.id}）。按角色说明里“自己写方案”做：只读地调查，写事实、整体行为表、和要求不一致的地方，再逐个写决定；用 submit_design 交一次。本人确认后编码 Agent 照它实现。`,
      `## 交办的任务\n\n${o.task}`,
      before
        ? `## 上一版（第 ${before} 版）和本人的意见\n\n按意见改出新的一版：意见没提到的决定保留它的 id 和内容；“换个思路”就重新考虑做法，不要只改措辞。\n\n${designMarkdown(app, o.design, { mode: "full" })}`
        : "",
    ].filter(Boolean).join("\n\n"),
    runId: o.run.id,
    cwd: o.cwd,
    signal: o.signal,
    onEvent: (e) => o.event(e.type, { ...e, phase: "design" }),
  });
  const after = getDesign(app, o.design.id);
  return { design: after.revision > before && after.runId === o.run.id ? after : null, text: String(res.text ?? ""), ai: res.ai };
}
