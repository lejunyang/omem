import { expect, test } from "vitest";
import { commands } from "vitest/browser";
import type { SimulatorScenarioResult } from "./simulator-browser-commands";
declare module "vitest/browser" { interface BrowserCommands { runSimulatorScenario: () => Promise<SimulatorScenarioResult>; runUiLayoutScenario: (origin: string) => Promise<{ panelFits: boolean; popupFits: boolean }> } }

test("centers a real framed page, applies device parameters and preserves real input and scoped CSP", async () => {
  const result = await commands.runSimulatorScenario();
  expect(result).toMatchObject({ width: 393, height: 852, dpr: 3, touchPoints: 5, coarse: false, userAgentMobile: true, centered: true, typed: "手机测试 Mobile", landscapeWidth: 852, landscapeHeight: 393, disabledTouchPoints: 0, originalUnchanged: true, cspPreserved: true, navigationWorked: true, dragScrolled: true, touchIsSynthetic: true, disabledTouchEvents: 0, initialDpr: 3, narrowFits: true });
  expect(result.touchEvents).toBeGreaterThan(0);
}, 60000);

test("keeps panel and popup usable at narrow and native popup sizes without startup errors", async () => {
  expect(await commands.runUiLayoutScenario(window.location.origin)).toEqual({ panelFits: true, popupFits: true });
});
