import { describe, expect, it } from "vitest";
import { duration, nextWords, stageActions, stageColour, stageLine, evidenceLink, type FlowStage } from "../web/src/lib/flow.ts";

const at = "2026-11-15T00:00:00Z";
const s = (patch: Partial<FlowStage> = {}): FlowStage => ({ id: "push", name: "推送", instruction: "核对评审后推送", state: "pending", attempt: 1, since: at, enteredAt: at, doneAt: null, by: null, waitingOn: null, evidence: [], note: "", gate: "auto", fixed: false, question: null, carrier: { kind: "owner", label: "本人" }, ...patch });
describe("流程呈现", () => {
  it("时长有分钟、小时、天边界，未来时间不显示负数", () => {
    for (const [minutes, word] of [[0, "不足 1 分钟"], [1, "1 分钟"], [59, "59 分钟"], [60, "1 小时"], [1439, "23 小时"], [1440, "1 天"]] as const) expect(duration(at, Date.parse(at) + minutes * 60000)).toBe(word);
    expect(duration(at, Date.parse(at) - 1000)).toBe("不足 1 分钟");
    expect(duration(null)).toBe("");
    expect(duration("invalid")).toBe("");
  });
  it("七种状态只用四种颜色，跳过和复核通过文字区分", () => {
    const states = ["pending", "gated", "doing", "blocked", "done", "skipped", "stale"] as const;
    expect(states.map((state) => stageColour(s({ state })))).toEqual(["quiet", "warn", "accent", "warn", "ok", "quiet", "quiet"]);
    expect(stageColour(s({ state: "doing", by: "owner" }))).toBe("warn");
    expect(stageLine(s({ state: "doing", attempt: 2 }), Date.parse(at) + 3600000)).toBe("1 小时前开始 · 第 2 次");
    expect(stageLine(s({ state: "gated" }), Date.parse(at) + 14400000)).toBe("等你 · 4 小时");
    expect(stageLine(s({ state: "done", doneAt: "2026-11-15T02:00:00Z" }))).toBe("2 小时");
    expect(stageLine(s({ state: "stale" }))).toBe("待复核");
    expect(stageLine(s())).toBe("");
  });
  it("按钮区分进入关卡、本人执行、完成确认和卡住，要求原因的动作不会遗漏", () => {
    expect(stageActions(s({ state: "gated" })).map((a) => a.label)).toEqual(["开始", "先别做", "跳过这一段"]);
    expect(stageActions(s({ state: "doing", by: "owner" })).map((a) => a.label)).toEqual(["做完了", "跳过这一段"]);
    expect(stageActions(s({ state: "doing", question: "done" })).map((a) => a.label)).toEqual(["确认", "还不行"]);
    expect(stageActions(s({ state: "blocked" })).every((a) => a.reason)).toBe(true);
    expect(stageActions(s({ state: "doing" }))).toEqual([]);
    expect(stageActions(s({ state: "doing", waitingOn: "owner", question: "refuse" }))).toEqual([{ action: "reopen", label: "还不行", reason: true }]);
    expect(stageColour(s({ state: "doing", waitingOn: "owner" }))).toBe("warn");
    expect(stageActions(s({ state: "done" }))).toEqual([]);
    expect(nextWords(s({ state: "blocked", waitingOn: "小王" }))).toContain("卡住：等 小王 回复");
  });
  it("依据使用现有引用入口及运行、方案路由", () => {
    expect(evidenceLink("src:s123#L1-L3")).toBeNull();
    expect(evidenceLink("design:d123")).toBe("#/design/d123");
    expect(evidenceLink("run:r123")).toBe("#/runs/r123");
  });
});
