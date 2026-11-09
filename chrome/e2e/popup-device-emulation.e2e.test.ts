import { describe, expect, test } from "vitest";
import { commands } from "vitest/browser";
import type {
  DeviceEmulationCdpScenarioResult,
  DeviceEmulationPopupProfileScenarioResult
} from "./browser-commands";

declare module "vitest/browser" {
  interface BrowserCommands {
    runDeviceEmulationPopupProfileScenario: () => Promise<DeviceEmulationPopupProfileScenarioResult>;
    runDeviceEmulationCdpScenario: (origin: string) => Promise<DeviceEmulationCdpScenarioResult>;
  }
}

describe("popup device emulation e2e", () => {
  test("creates and reloads custom device profiles", async () => {
    const result = await commands.runDeviceEmulationPopupProfileScenario();

    expect(result).toMatchObject({
      createdProfileName: "E2E Device",
      createdProfileWidth: 375,
      reloadedProfileVisible: true
    });
    expect(result.profileCount).toBeGreaterThan(3);
  });

  test("applies device emulation to one tab through CDP and clears background state", async () => {
    const result = await commands.runDeviceEmulationCdpScenario(window.location.origin);

    expect(result).toEqual({
      enableOk: true,
      widthApplied: true,
      touchApplied: true,
      userAgentApplied: true,
      layoutMetricsReasonable: true,
      reloadWidthApplied: true,
      reloadTouchApplied: true,
      reloadUserAgentApplied: true,
      stateEnabled: true,
      disabledStateCleared: true
    });
  });
});
