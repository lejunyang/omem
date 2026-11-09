import { describe, expect, test } from "vitest";
import { commands } from "vitest/browser";
import type {
  PanelJsonDetailScenarioResult,
  PanelNetworkPreserveLogScenarioResult,
  PanelToolbarPanelsScenarioResult
} from "./browser-commands";

declare module "vitest/browser" {
  interface BrowserCommands {
    runPanelNetworkPreserveLogScenario: (origin: string) => Promise<PanelNetworkPreserveLogScenarioResult>;
    runPanelJsonDetailScenario: (origin: string) => Promise<PanelJsonDetailScenarioResult>;
    runPanelToolbarPanelsScenario: (origin: string) => Promise<PanelToolbarPanelsScenarioResult>;
  }
}

describe("panel network e2e", () => {
  test("clears requests on navigation unless preserve log is enabled", async () => {
    const result = await commands.runPanelNetworkPreserveLogScenario(window.location.origin);

    expect(result).toMatchObject({
      clearedWithoutPreserveLog: true,
      keptWithPreserveLog: true,
      recordsAfterClear: 0,
      recordsAfterPreserve: 1
    });
  });

  test("shows expandable JSON tree views for payload and response", async () => {
    const result = await commands.runPanelJsonDetailScenario(window.location.origin);

    expect(result).toEqual({
      payloadTreeVisible: true,
      payloadNestedValueVisible: true,
      responseTreeVisible: true,
      responseNestedValueVisible: true
    });
  });

  test("keeps more actions panel above filter panel and closes save dialog", async () => {
    const result = await commands.runPanelToolbarPanelsScenario(window.location.origin);

    expect(result).toEqual({
      moreBeforeFilters: true,
      dialogClosedAfterSave: true,
      enabledFilterBadgeText: "1"
    });
  });
});
