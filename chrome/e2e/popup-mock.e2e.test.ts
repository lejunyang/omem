import { describe, expect, test } from "vitest";
import { commands } from "vitest/browser";
import type {
  CdpMockResponseRewriteScenarioResult,
  MockCancelDraftScenarioResult,
  MockJsonBodyScenarioResult,
  MockPopupScenarioResult,
  MockScriptScenarioResult
} from "./browser-commands";

declare module "vitest/browser" {
  interface BrowserCommands {
    runCdpMockResponseRewriteScenario: (origin: string) => Promise<CdpMockResponseRewriteScenarioResult>;
    runMockCancelDraftScenario: () => Promise<MockCancelDraftScenarioResult>;
    runMockJsonBodyScenario: () => Promise<MockJsonBodyScenarioResult>;
    runMockPopupScenario: () => Promise<MockPopupScenarioResult>;
    runMockScriptScenario: () => Promise<MockScriptScenarioResult>;
  }
}

describe("popup mock e2e", () => {
  test("creates a mock group and confirms a persisted mock rule", async () => {
    const result = await commands.runMockPopupScenario();

    expect(result).toMatchObject({
      groupName: "E2E Mock 组",
      groupPageUrlContains: "test-page.html",
      reloadedGroupVisible: true,
      reloadedRulePersisted: true,
      ruleMatcherQuery: "method:GET url:/fixtures/users.json",
      ruleName: "E2E Mock 规则"
    });
  });

  test("persists a replace-body mock rule", async () => {
    const result = await commands.runMockJsonBodyScenario();

    expect(result).toMatchObject({
      action: "replace-body",
      reloadedRulePersisted: true,
      responseBody: JSON.stringify({ users: [{ id: 1, name: "Mocked" }] }, null, 2),
      ruleName: "E2E JSON Mock"
    });
  });

  test("persists a script mock rule", async () => {
    const result = await commands.runMockScriptScenario();

    expect(result).toMatchObject({
      action: "script",
      reloadedRulePersisted: true,
      ruleName: "E2E JS Mock"
    });
    expect(result.script).toContain("request.headers['x-advanced-network-demo']");
    expect(result.script).toContain("scripted: true");
  });

  test("does not persist a cancelled mock draft", async () => {
    const result = await commands.runMockCancelDraftScenario();

    expect(result).toMatchObject({
      draftVisibleAfterCancel: false,
      draftVisibleBeforeCancel: true,
      ruleCount: 0
    });
  });

  test("rewrites a real test page response through CDP Fetch", async () => {
    const result = await commands.runCdpMockResponseRewriteScenario(window.location.origin);

    expect(result).toMatchObject({
      responseBody: JSON.stringify({ e2eMocked: true, source: "cdp-fetch" }, null, 2),
      syncOk: true
    });
    expect(result.outputText).toContain("fetch /fixtures/users.json -> 200");
    expect(result.outputText).toContain('"e2eMocked": true');
    expect(result.outputText).toContain('"source": "cdp-fetch"');
  });
});
