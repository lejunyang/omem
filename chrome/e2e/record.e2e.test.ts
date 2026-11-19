import { expect, test } from "vitest";
import { commands } from "vitest/browser";
import type { RecordScenarioResult } from "./record-browser-commands";

declare module "vitest/browser" {
  interface BrowserCommands {
    runRecordScenario: (origin: string) => Promise<RecordScenarioResult>;
  }
}

test("录制：记下填写、点击、标记和换页，密码和验证码不记值，请求里的令牌遮掉，侧栏能删步骤", { timeout: 90_000 }, async () => {
  const result = await commands.runRecordScenario(window.location.origin);
  expect(result.started).toBe(true);
  expect(result.badge).toBe("REC");
  expect(result.badgeAfterStop).toBe("");
  expect(result.steps.map((s) => s.action)).toEqual(["input", "input", "input", "click", "mark", "click", "navigate"]);
  const [merchant, password, sms, grant, mark, link, page] = result.steps;
  expect(merchant).toMatchObject({ label: "商户号", value: "B-1001", protected: false });
  expect(password).toMatchObject({ label: "操作密码", value: null, protected: true });
  expect(sms).toMatchObject({ label: "短信验证码", value: null, protected: true });
  expect(grant).toMatchObject({ label: "开通退款", screenshot: true });
  expect(mark.kind).toBe("mark");
  expect(link.label).toBe("查看商户详情");
  expect(page.url).toMatch(/record-fixture\.html\?step=2$/);
  expect(result.images).toBeGreaterThanOrEqual(1);
  // 不用调试器：webRequest 记下的 POST，地址和请求体里的令牌、密码换成占位
  expect(result.grant).toMatchObject({ method: "POST", type: "XHR" });
  expect(result.grant?.url).toContain("access_token=%5BREDACTED%5D&from=record");
  expect(JSON.parse(result.grant?.requestBody ?? "{}")).toEqual({ merchant: "B-1001", password: "[REDACTED]" });
  expect(result.leaked).toBe(false);
  expect(result.sideSteps).toBe(7);
  expect(result.sideStepsAfterDelete).toBe(6);
});
