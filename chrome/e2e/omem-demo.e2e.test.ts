import { expect, test } from "vitest";
import { commands } from "vitest/browser";
import type { OmemDemoScenarioResult } from "./omem-browser-commands";

declare module "vitest/browser" {
  interface BrowserCommands {
    runOmemDemoScenario: (origin: string) => Promise<OmemDemoScenarioResult>;
  }
}

test("在侧栏开始演示，拾取记进演示的对话，结束时交给助手整理", { timeout: 120_000 }, async () => {
  const result = await commands.runOmemDemoScenario(window.location.origin);
  expect(result.bannerGoal).toBe("退款按钮点了没反应时怎么查");
  // 演示中拾取篮只有一个发送按钮：记进演示
  expect(result.pickButtons).toEqual(["记进演示"]);
  expect(result.pickNote).toContain("已记进演示「退款按钮点了没反应时怎么查」");
  // 记进去的是演示对话里本人的一条消息，带元素上下文和截图原件
  expect(result.pickMessage).toMatch(/^我指给你看（拾取，http[^]*就是这个按钮，点了没有请求[^]*button#submit[^]*omem-file:[^]*src:/);
  expect(result.elapsed).toMatch(/^00:0[2-9]|^00:[1-5]\d$/);
  // 没连关注或事项：只能整理成技能或只结束
  expect(result.stopChoices).toEqual(["整理成技能", "只结束"]);
  expect(result.ended).toContain("「退款按钮点了没反应时怎么查」已结束，助手在整理");
  expect(result.organizeMessage).toMatch(/^我演示完了：退款按钮点了没反应时怎么查[^]*时间线（1 条[^]*拾取：[^]*skill-from-demo[^]*请整理成技能/);
  expect(result.currentAfterStop).toBeNull();
});
