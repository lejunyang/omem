import { describe, expect, test } from "vitest";
import { commands } from "vitest/browser";
import type { NoCdpScenarioResult, PickScenarioResult } from "./pick-browser-commands";

declare module "vitest/browser" {
  interface BrowserCommands {
    runNoCdpScenario: (origin: string) => Promise<NoCdpScenarioResult>;
    runPickScenario: (origin: string) => Promise<PickScenarioResult>;
  }
}

describe("默认不用 CDP", () => {
  test("面板的几条消息都不连接调试器，Mock 由页面钩子改写 fetch 和 XHR", async () => {
    const result = await commands.runNoCdpScenario(window.location.origin);
    expect(result).toMatchObject({
      mode: "off",
      attachedAfterPanelCalls: 0,
      observerMode: "hook",
      controlsCdpDisabled: true,
      fetchText: '{"source":"mock"}',
      xhrText: '{"source":"mock"} 200',
      mockedStatus: true
    });
    expect(result.registered).toEqual(["omem-page-bridge", "omem-page-hook", "omem-simulator-env"]);
  });
});

describe("拾取", () => {
  test("元素、区域、整页都能记下，拾取篮能引用", async () => {
    const result = await commands.runPickScenario(window.location.origin);
    expect(result.records.map((record) => record.kind)).toEqual(["element", "region", "page"]);
    const [element, region, page] = result.records;
    expect(element.title).toBe("按钮 button#submit");
    expect(element.elementCount).toBe(2);
    expect(element.spacings).toEqual(["水平 12px"]);
    expect(region.title).toBe("区域 340×160");
    // 整页高于视口：逐屏拼接后的图比一屏高。
    expect(page.height).toBeGreaterThan(760);
    expect(result.basketCards).toBe(3);
    expect(result.chipText).toBe("#1 按钮 button#submit");
    expect(result.draftIsArray).toBe(true);
    expect(result.draftRefCount).toBe(1);
    expect(result.attachedAfter).toBe(0);
  });
});
