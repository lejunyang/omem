import { describe, expect, test } from "vitest";
import { commands } from "vitest/browser";
import type {
  UserStateCookieStorageSyncScenarioResult,
  UserStateDeleteScenarioResult,
  UserStatePopupScenarioResult
} from "./browser-commands";

declare module "vitest/browser" {
  interface BrowserCommands {
    runUserStateCookieStorageSyncScenario: (origin: string) => Promise<UserStateCookieStorageSyncScenarioResult>;
    runUserStateDeleteScenario: () => Promise<UserStateDeleteScenarioResult>;
    runUserStatePopupScenario: () => Promise<UserStatePopupScenarioResult>;
  }
}

describe("popup user state e2e", () => {
  test("creates a profile with default controls and persists edits", async () => {
    const result = await commands.runUserStatePopupScenario();

    expect(result).toMatchObject({
      activeProfileId: null,
      cookieEnabled: true,
      profileCount: 1,
      profileName: "E2E 用户状态",
      profilePatterns: ["http://127.0.0.1:*/*", "https://sso.example.com/*"],
      reloadedName: "E2E 用户状态",
      reloadedPatterns: "http://127.0.0.1:*/*\nhttps://sso.example.com/*",
      reloadedStorageEnabled: true,
      storageEnabled: true
    });
  });

  test("deletes a user state profile without leaving storage data", async () => {
    const result = await commands.runUserStateDeleteScenario();

    expect(result).toMatchObject({
      emptyStateVisible: true,
      profileCountAfterCreate: 1,
      profileCountAfterDelete: 0
    });
  });

  test("syncs test page cookie and storage state", async () => {
    const result = await commands.runUserStateCookieStorageSyncScenario(window.location.origin);

    expect(result).toMatchObject({
      cookieOnlyProfileCookieValue: "browser-cookie",
      firstTabStorageValue: "profile-storage",
      secondTabStorageValue: "profile-storage",
      storageProfileValue: "browser-storage"
    });
    expect(result.matchedTabs).toBeGreaterThanOrEqual(2);
  });
});
