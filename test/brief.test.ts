import { describe, expect, it } from "vitest";
import { briefParts, briefProblem, checkBrief } from "../src/agents/brief.ts";

const wall = "已定位需要在后端服务处理，本仓库没有对应的修复位置。" + "新的请求日志里带了完整字段，但实际命中的是另一套环境的服务，收到的包里没有这个字段，返回了空输入的错误。".repeat(8);

describe("what the owner reads to decide", () => {
  it("lets a short question through as it is", () => {
    expect(briefProblem("退款按行算还是按单算？")).toBeNull();
  });
  it("sends back a wall of text, with how to write it", () => {
    expect(briefProblem(wall)).toContain("没有分段");
    expect(() => checkBrief(wall, "reason ")).toThrow("第一段只写一句");
    expect(briefProblem(`${wall}\n\n**依据**\n- 运行 r1`)).toContain("第一段");
  });
  it("takes one sentence, then short sections; lists may run long", () => {
    const ok = [
      "这个缺陷的修复在后端服务，不在前端仓库：要不要转给后端的负责人？",
      "**现在**\n前端把字段完整传给了中间层，日志里能看到。",
      "**问题**\n请求落到了另一套环境的服务上，那边的版本还不认这个字段。",
      `**依据**\n${Array.from({ length: 20 }, (_, i) => `- 日志 ${i + 1}：示例链接`).join("\n")}`,
    ].join("\n\n");
    expect(briefProblem(ok)).toBeNull();
    expect(briefParts(ok).lead).toContain("要不要转给");
  });
});
