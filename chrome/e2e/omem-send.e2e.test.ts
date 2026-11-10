import { expect, test } from "vitest";
import { commands } from "vitest/browser";
import type { OmemSendScenarioResult } from "./omem-browser-commands";

declare module "vitest/browser" {
  interface BrowserCommands {
    runOmemSendScenario: (origin: string) => Promise<OmemSendScenarioResult>;
  }
}

test("连接真实的 omem，把拾取的元素存为原件、再问 omem", { timeout: 120_000 }, async () => {
  const result = await commands.runOmemSendScenario(window.location.origin);
  expect(result.connected).toBe(true);
  expect(result.userName).not.toBe("");
  // 存为原件：正文、元素位置和属性、截图换成图片原件
  expect(result.sourceTitle).toBe("退款按钮的埋点要核对");
  // 编号取决于之前的用例记过几条，只核对格式
  expect(result.sourceText).toMatch(/^退款按钮的埋点要核对 \[#\d+ 按钮 button#submit\]/);
  for (const part of ["section#refund-card > div.actions > button#submit", 'data-track="refund_submit"', "```html", "omem-file:", "src:"]) {
    expect(result.sourceText).toContain(part);
  }
  expect(result.sourceText).not.toContain("{{image:");
  expect(result.imageSourceKind).toBe("image");
  // 问 omem：同样的内容成了对话里的一条消息
  expect(result.askText).toContain("退款按钮的埋点要核对");
  expect(result.askText).toContain("omem-file:");
  expect(result.conversationLink).toBe(true);
});
