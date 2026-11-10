import { omemBrowserCommands } from "./omem-browser-commands";
import { pickBrowserCommands } from "./pick-browser-commands";
import { simulatorBrowserCommands } from "./simulator-browser-commands";
import type { Page, BrowserContext } from "playwright";
import type { BrowserCommand } from "vitest/node";
import {
  DEFAULT_MOCK_GROUP_ID,
  MOCK_GROUP_STORAGE_KEY,
  MOCK_RULE_STORAGE_KEY,
  type MockGroup,
  type MockRule,
  normalizeMockGroups,
  normalizeMockRules
} from "../src/shared/mock-rules";
import {
  ACTIVE_USER_STATE_PROFILE_STORAGE_KEY,
  createUserStateProfile,
  normalizeUserStateProfiles,
  storageScopeKey,
  USER_STATE_PROFILE_STORAGE_KEY
} from "../src/shared/user-state-profiles";
import {
  DEFAULT_DEVICE_EMULATION_SETTINGS,
  DEFAULT_DEVICE_PROFILES,
  DEVICE_PROFILE_STORAGE_KEY,
  type DeviceEmulationState,
  normalizeDeviceProfiles
} from "../src/shared/device-emulation";

type PlaywrightCommandContext = {
  context: BrowserContext;
  provider: {
    name: string;
  };
};

export interface UserStatePopupScenarioResult {
  activeProfileId: string | null | undefined;
  profileCount: number;
  profileName: string;
  profilePatterns: string[];
  cookieEnabled: boolean;
  storageEnabled: boolean;
  reloadedName: string;
  reloadedPatterns: string;
  reloadedStorageEnabled: boolean;
}

export interface UserStateDeleteScenarioResult {
  profileCountAfterCreate: number;
  profileCountAfterDelete: number;
  emptyStateVisible: boolean;
}

export interface UserStateCookieStorageSyncScenarioResult {
  cookieOnlyProfileCookieValue: string;
  firstTabStorageValue: string | null;
  matchedTabs: number;
  secondTabStorageValue: string | null;
  storageProfileValue: string;
}

export interface MockPopupScenarioResult {
  groupName: string;
  groupPageUrlContains: string;
  ruleName: string;
  ruleMatcherQuery: string;
  reloadedGroupVisible: boolean;
  reloadedRulePersisted: boolean;
}

export interface MockJsonBodyScenarioResult {
  ruleName: string;
  action: string;
  responseBody: string;
  reloadedRulePersisted: boolean;
}

export interface MockScriptScenarioResult {
  ruleName: string;
  action: string;
  script: string;
  reloadedRulePersisted: boolean;
}

export interface MockCancelDraftScenarioResult {
  draftVisibleBeforeCancel: boolean;
  draftVisibleAfterCancel: boolean;
  ruleCount: number;
}

export interface CdpMockResponseRewriteScenarioResult {
  outputText: string;
  responseBody: string;
  syncOk: boolean;
}

export interface PanelNetworkPreserveLogScenarioResult {
  clearedWithoutPreserveLog: boolean;
  keptWithPreserveLog: boolean;
  recordsAfterClear: number;
  recordsAfterPreserve: number;
}

export interface PanelJsonDetailScenarioResult {
  payloadTreeVisible: boolean;
  payloadNestedValueVisible: boolean;
  responseTreeVisible: boolean;
  responseNestedValueVisible: boolean;
}

export interface PanelToolbarPanelsScenarioResult {
  moreBeforeFilters: boolean;
  dialogClosedAfterSave: boolean;
  enabledFilterBadgeText: string;
}

export interface DeviceEmulationPopupProfileScenarioResult {
  createdProfileName: string;
  createdProfileWidth: number;
  reloadedProfileVisible: boolean;
  profileCount: number;
}

export interface DeviceEmulationCdpScenarioResult {
  enableOk: boolean;
  widthApplied: boolean;
  touchApplied: boolean;
  userAgentApplied: boolean;
  layoutMetricsReasonable: boolean;
  reloadWidthApplied: boolean;
  reloadTouchApplied: boolean;
  reloadUserAgentApplied: boolean;
  stateEnabled: boolean;
  disabledStateCleared: boolean;
}

interface RuntimeMessageResponse {
  ok: boolean;
  error?: string;
  matchedTabs?: number;
  state?: DeviceEmulationState | null;
}

interface PanelHarnessRequest {
  method?: string;
  url: string;
  requestBody?: string;
  responseBody?: string;
}

export const browserCommands = {
  ...simulatorBrowserCommands,
  ...pickBrowserCommands,
  ...omemBrowserCommands,
  runPanelNetworkPreserveLogScenario: createPlaywrightCommand(async (context, origin: string) => {
    const page = await context.newPage();
    try {
      await page.goto(`${origin}/e2e/panel-network-harness.html`);
      await page.getByTestId("panel-preserve-log").waitFor();

      await emitPanelRequest(page, "https://example.com/api/without-preserve");
      await page.getByTestId("request-row").first().waitFor();
      await emitPanelNavigation(page, "https://example.com/after-refresh");
      await expectRequestRowCount(page, 0);
      const recordsAfterClear = await page.getByTestId("request-row").count();

      await page.getByTestId("panel-preserve-log").check();
      await emitPanelRequest(page, "https://example.com/api/with-preserve");
      await page.getByTestId("request-row").first().waitFor();
      await emitPanelNavigation(page, "https://example.com/after-preserved-refresh");
      await expectRequestRowCount(page, 1);
      const recordsAfterPreserve = await page.getByTestId("request-row").count();

      return {
        clearedWithoutPreserveLog: recordsAfterClear === 0,
        keptWithPreserveLog: recordsAfterPreserve === 1,
        recordsAfterClear,
        recordsAfterPreserve
      };
    } finally {
      await page.close();
    }
  }),
  runPanelJsonDetailScenario: createPlaywrightCommand(async (context, origin: string) => {
    const page = await context.newPage();
    try {
      await page.goto(`${origin}/e2e/panel-network-harness.html`);
      await page.getByTestId("panel-preserve-log").waitFor();
      await page.getByTestId("panel-preserve-log").check();

      await emitPanelRequest(page, {
        method: "POST",
        url: "https://example.com/api/json-detail",
        requestBody: JSON.stringify({ user: { name: "Alice", roles: ["admin"] }, enabled: true }),
        responseBody: JSON.stringify({ data: { id: 1, tags: ["network", "json"] }, ok: true })
      });
      await page.getByTestId("request-row").first().click();

      await page.getByRole("button", { name: "Payload" }).click();
      await page.getByTestId("payload-json-toggle").click();
      const payloadTreeVisible = await page.getByTestId("payload-json-tree").isVisible();
      await page.getByTestId("json-toggle-$.user.roles").click();
      const payloadNestedValueVisible = await page.getByText('"admin"').isVisible();

      await page.getByRole("button", { name: "Response" }).click();
      await page.getByTestId("response-json-toggle").click();
      const responseTreeVisible = await page.getByTestId("response-json-tree").isVisible();
      await page.getByTestId("json-toggle-$.data.tags").click();
      const responseNestedValueVisible = await page.getByText('"json"').isVisible();

      return {
        payloadTreeVisible,
        payloadNestedValueVisible,
        responseTreeVisible,
        responseNestedValueVisible
      };
    } finally {
      await page.close();
    }
  }),
  runPanelToolbarPanelsScenario: createPlaywrightCommand(async (context, origin: string) => {
    const page = await context.newPage();
    try {
      await page.goto(`${origin}/e2e/panel-network-harness.html`);
      await page.getByTestId("panel-preserve-log").waitFor();

      await page.getByRole("button", { name: /^全部筛选/ }).click();
      await page.getByRole("button", { name: "更多" }).click();
      const moreBeforeFilters = await page.evaluate(() => {
        const morePanel = [...document.querySelectorAll(".action-panel")].find((panel) =>
          panel.textContent?.includes("更多操作")
        );
        const filterPanel = [...document.querySelectorAll(".action-panel")].find((panel) =>
          panel.textContent?.includes("全部筛选")
        );
        return Boolean(
          morePanel && filterPanel && (morePanel.compareDocumentPosition(filterPanel) & Node.DOCUMENT_POSITION_FOLLOWING)
        );
      });

      await page.getByPlaceholder("筛选，例如：/api/users method:POST status:2xx keyword:traceId url~/api\\/users/i").fill("url:toolbar-panel-e2e");
      await page.getByRole("button", { name: "保存筛选" }).click();
      await page.getByTestId("save-preset-dialog").waitFor();
      await page.getByTestId("save-preset-name").fill("toolbar panel e2e");
      await page.getByTestId("save-preset-confirm").click();
      await page.getByTestId("save-preset-dialog").waitFor({ state: "detached" });
      const dialogClosedAfterSave = (await page.getByTestId("save-preset-dialog").count()) === 0;
      const enabledFilterBadgeText = await page.locator(".button-badge").first().innerText();

      return {
        moreBeforeFilters,
        dialogClosedAfterSave,
        enabledFilterBadgeText
      };
    } finally {
      await page.close();
    }
  }),
  runDeviceEmulationPopupProfileScenario: createPlaywrightCommand(async (context) => {
    const page = await openExtensionPopup(context);
    try {
      await clearExtensionStorage(page);
      await page.getByTestId("popup-tab-device-emulation").click();
      await page.getByTestId("device-emulation-panel").waitFor();

      await page.getByTestId("device-create-profile").click();
      await page.getByTestId("device-name").fill("E2E Device");
      await blurFocusedElement(page);
      await page.getByTestId("device-width").fill("375");
      await blurFocusedElement(page);
      await waitForExtensionStorage(page, [DEVICE_PROFILE_STORAGE_KEY], (items) =>
        normalizeDeviceProfiles(items[DEVICE_PROFILE_STORAGE_KEY]).some(
          (profile) => profile.name === "E2E Device" && profile.width === 375
        )
      );

      const profiles = normalizeDeviceProfiles(await getExtensionStorage<unknown>(page, DEVICE_PROFILE_STORAGE_KEY));
      await page.reload();
      await page.getByTestId("popup-tab-device-emulation").click();
      await page.waitForFunction(() =>
        [...document.querySelectorAll("option")].some((option) => option.textContent?.includes("E2E Device"))
      );

      return {
        createdProfileName: profiles.find((profile) => profile.name === "E2E Device")?.name ?? "",
        createdProfileWidth: profiles.find((profile) => profile.name === "E2E Device")?.width ?? 0,
        reloadedProfileVisible: (await page.locator("option").filter({ hasText: "E2E Device" }).count()) > 0,
        profileCount: profiles.length
      };
    } finally {
      await page.close();
    }
  }),
  runDeviceEmulationCdpScenario: createPlaywrightCommand(async (context, origin: string) => {
    const testPage = await context.newPage();
    const extensionPage = await openExtensionPopup(context);
    let tabId: number | undefined;
    // 原页面设备模拟只在「CDP 增强」开启时可用（默认关闭）。
    await setCdpModeForTest(extensionPage, "on");
    try {
      const testPageUrl = await openTestPage(testPage, origin);
      tabId = await getTabIdForPage(extensionPage, testPageUrl);
      const initialState = await sendExtensionMessage(extensionPage, {
        type: "advanced-network:get-device-emulation-state",
        tabId
      });
      if (!initialState.ok) {
        throw new Error(`Device emulation message route failed: ${initialState.error ?? "unknown error"}`);
      }
      await testPage.bringToFront();
      const profile = {
        ...DEFAULT_DEVICE_PROFILES[0],
        id: "e2e-device",
        name: "E2E Device",
        width: 375,
        height: 812,
        userAgent: "AdvancedNetworkDeviceE2E/1.0",
        platform: "iPhone"
      };
      const enableResult = await sendExtensionMessage(extensionPage, {
        type: "advanced-network:set-device-emulation",
        tabId,
        profile,
        settings: {
          ...DEFAULT_DEVICE_EMULATION_SETTINGS,
          enabled: true,
          profileId: profile.id,
          orientation: "portrait",
          scaleMode: "fixed",
          scale: 1
        },
        source: "popup"
      });
      if (!enableResult.ok) {
        throw new Error(`Failed to enable device emulation: ${enableResult.error ?? "unknown error"}`);
      }
      await testPage.waitForTimeout(300);
      const cdpSession = await context.newCDPSession(testPage);
      await cdpSession.send("Page.enable");
      const layoutMetrics = await cdpSession.send("Page.getLayoutMetrics");
      const metrics = await testPage.evaluate(() => ({
        innerWidth: window.innerWidth,
        screenWidth: window.screen.width,
        maxTouchPoints: navigator.maxTouchPoints,
        userAgent: navigator.userAgent
      }));
      await testPage.reload();
      await testPage.waitForTimeout(300);
      const reloadedMetrics = await testPage.evaluate(() => ({
        screenWidth: window.screen.width,
        maxTouchPoints: navigator.maxTouchPoints,
        userAgent: navigator.userAgent
      }));
      const stateResult = await sendExtensionMessage(extensionPage, {
        type: "advanced-network:get-device-emulation-state",
        tabId
      });
      const [, disableResult] = await Promise.all([
        sendExtensionMessage(extensionPage, { type: "advanced-network:refresh-device-emulation", tabId }),
        sendExtensionMessage(extensionPage, { type: "advanced-network:disable-device-emulation", tabId })
      ]);
      await testPage.waitForTimeout(500);
      const disabledState = await sendExtensionMessage(extensionPage, {
        type: "advanced-network:get-device-emulation-state",
        tabId
      });

      return {
        enableOk: enableResult.ok,
        widthApplied: metrics.screenWidth === 375,
        touchApplied: metrics.maxTouchPoints === profile.maxTouchPoints,
        userAgentApplied: metrics.userAgent === profile.userAgent,
        layoutMetricsReasonable:
          layoutMetrics.cssVisualViewport.clientWidth <= layoutMetrics.cssLayoutViewport.clientWidth &&
          layoutMetrics.cssContentSize.width < 2000,
        reloadWidthApplied: reloadedMetrics.screenWidth === 375,
        reloadTouchApplied: reloadedMetrics.maxTouchPoints === profile.maxTouchPoints,
        reloadUserAgentApplied: reloadedMetrics.userAgent === profile.userAgent,
        stateEnabled: stateResult.state?.settings.enabled === true,
        disabledStateCleared: disableResult.ok && disabledState.state === null
      };
    } finally {
      if (tabId !== undefined) {
        await sendExtensionMessage(extensionPage, {
          type: "advanced-network:disable-device-emulation",
          tabId
        }).catch(() => undefined);
      }
      await setCdpModeForTest(extensionPage, "off").catch(() => undefined);
      await extensionPage.close();
      await testPage.close();
    }
  }),
  runUserStatePopupScenario: createPlaywrightCommand(async (context) => {
    const page = await openExtensionPopup(context);
    try {
      await clearExtensionStorage(page);
      await page.getByTestId("popup-tab-user-state").click();

      await page.getByTestId("user-state-draft-pattern").fill("http://127.0.0.1:*/*");
      await page.getByTestId("user-state-draft-pattern").press("Enter");
      await page.getByTestId("user-state-draft-pattern").fill("https://sso.example.com/*");
      await page.getByTestId("user-state-add-profile").click();
      await waitForUserStateProfile(page, (profile) =>
        profile.matchPatterns.includes("http://127.0.0.1:*/*") &&
        profile.matchPatterns.includes("https://sso.example.com/*")
      );
      await page.getByTestId("user-state-cookie-control").waitFor();

      const cookieEnabled = await page.getByTestId("user-state-cookie-control").isChecked();
      const storageInitiallyEnabled = await page.getByTestId("user-state-storage-control").isChecked();
      if (storageInitiallyEnabled) {
        throw new Error("Storage control should be disabled by default.");
      }

      await page.getByTestId("user-state-profile-name").fill("E2E 用户状态");
      await waitForUserStateProfile(page, (profile) => profile.name === "E2E 用户状态");
      await page.getByTestId("user-state-profile-patterns").fill("http://127.0.0.1:*/*\nhttps://sso.example.com/*");
      await waitForUserStateProfile(page, (profile) =>
        profile.matchPatterns.includes("http://127.0.0.1:*/*") &&
        profile.matchPatterns.includes("https://sso.example.com/*")
      );
      await page.getByTestId("user-state-storage-control").check({ force: true });
      await waitForUserStateProfile(page, (profile) => profile.controls.webStorage);

      const storedProfiles = normalizeUserStateProfiles(
        await getExtensionStorage<unknown>(page, USER_STATE_PROFILE_STORAGE_KEY)
      );
      const activeProfileId = await getExtensionStorage<string | null>(page, ACTIVE_USER_STATE_PROFILE_STORAGE_KEY);

      await page.reload();
      await page.getByTestId("popup-tab-user-state").click();

      return {
        activeProfileId,
        profileCount: storedProfiles.length,
        profileName: storedProfiles[0]?.name ?? "",
        profilePatterns: storedProfiles[0]?.matchPatterns ?? [],
        cookieEnabled,
        storageEnabled: Boolean(storedProfiles[0]?.controls.webStorage),
        reloadedName: await page.getByTestId("user-state-profile-name").inputValue(),
        reloadedPatterns: await page.getByTestId("user-state-profile-patterns").inputValue(),
        reloadedStorageEnabled: await page.getByTestId("user-state-storage-control").isChecked()
      };
    } finally {
      await page.close();
    }
  }),
  runUserStateDeleteScenario: createPlaywrightCommand(async (context) => {
    const page = await openExtensionPopup(context);
    try {
      await clearExtensionStorage(page);
      await page.getByTestId("popup-tab-user-state").click();
      await page.getByTestId("user-state-draft-pattern").fill("https://delete.example/*");
      await page.getByTestId("user-state-add-profile").click();
      await waitForUserStateProfile(page, (profile) => profile.matchPatterns.includes("https://delete.example/*"));

      const profilesAfterCreate = normalizeUserStateProfiles(
        await getExtensionStorage<unknown>(page, USER_STATE_PROFILE_STORAGE_KEY)
      );
      await page.getByTestId("user-state-delete-profile").click();
      await waitForExtensionStorage(page, [USER_STATE_PROFILE_STORAGE_KEY], (items) =>
        normalizeUserStateProfiles(items[USER_STATE_PROFILE_STORAGE_KEY]).length === 0
      );

      return {
        profileCountAfterCreate: profilesAfterCreate.length,
        profileCountAfterDelete: normalizeUserStateProfiles(
          await getExtensionStorage<unknown>(page, USER_STATE_PROFILE_STORAGE_KEY)
        ).length,
        emptyStateVisible: await page.getByText("暂无用户配置").isVisible()
      };
    } finally {
      await page.close();
    }
  }),
  runUserStateCookieStorageSyncScenario: createPlaywrightCommand(async (context, origin: string) => {
    const firstPage = await context.newPage();
    const secondPage = await context.newPage();
    const extensionPage = await openExtensionPopup(context);

    try {
      await clearExtensionStorage(extensionPage);
      const firstPageUrl = await openTestPage(firstPage, origin);
      await openTestPage(secondPage, origin);
      const profilePattern = matchPatternForUrl(firstPageUrl);

      await resetTestPageState(firstPage);
      await resetTestPageState(secondPage);

      const cookieProfile = createUserStateProfile({
        id: "e2e-cookie-profile",
        name: "E2E Cookie-only",
        matchPatterns: [profilePattern],
        now: Date.now(),
        controls: { cookie: true, webStorage: false }
      });
      const applyCookieResult = await sendExtensionMessage(extensionPage, {
        type: "advanced-network:user-state-apply-profile",
        profile: cookieProfile
      });
      if (!applyCookieResult.ok) {
        throw new Error(`Failed to apply cookie-only profile: ${applyCookieResult.error ?? "unknown error"}`);
      }
      await firstPage.evaluate(() => {
        document.cookie = "advanced_network_e2e=browser-cookie; path=/; SameSite=Lax";
      });
      await waitForUserStateProfile(extensionPage, (profile) =>
        profile.id === cookieProfile.id && profile.cookieJar.some((cookie) => cookie.name === "advanced_network_e2e")
      );

      const storageProfile = createUserStateProfile({
        id: "e2e-storage-profile",
        name: "E2E Storage",
        matchPatterns: [profilePattern],
        now: Date.now(),
        controls: { cookie: false, webStorage: true }
      });
      const applyStorageResult = await sendExtensionMessage(extensionPage, {
        type: "advanced-network:user-state-apply-profile",
        profile: storageProfile
      });
      if (!applyStorageResult.ok) {
        throw new Error(`Failed to apply storage profile: ${applyStorageResult.error ?? "unknown error"}`);
      }
      await firstPage.evaluate(() => {
        localStorage.setItem("advanced-network-e2e-storage", "browser-storage");
      });
      await waitForUserStateProfile(extensionPage, (profile) =>
        profile.id === storageProfile.id &&
        Object.values(profile.storageByScope).some((storage) =>
          storage.localStorage["advanced-network-e2e-storage"] === "browser-storage"
        )
      );

      const originUrl = new URL(firstPageUrl);
      const switchingProfile = {
        ...storageProfile,
        id: "e2e-switch-profile",
        name: "E2E Switch Storage",
        enabled: true,
        storageByScope: {
          [storageScopeKey({ origin: originUrl.origin, topLevelSite: originUrl.origin, frameUrl: firstPageUrl })]: {
            scope: {
              origin: originUrl.origin,
              topLevelSite: originUrl.origin,
              frameUrl: firstPageUrl
            },
            localStorage: { "advanced-network-e2e-storage": "profile-storage" },
            sessionStorageByTab: {}
          }
        },
        updatedAt: Date.now()
      };
      const switchResult = await sendExtensionMessage(extensionPage, {
        type: "advanced-network:user-state-apply-profile",
        profile: switchingProfile
      });
      if (!switchResult.ok) {
        throw new Error(`Failed to switch storage profile: ${switchResult.error ?? "unknown error"}`);
      }
      const profiles = normalizeUserStateProfiles(
        await getExtensionStorage<unknown>(extensionPage, USER_STATE_PROFILE_STORAGE_KEY)
      );
      await waitForLocalStorageValue(firstPage, "advanced-network-e2e-storage", "profile-storage", {
        label: "first tab",
        matchedTabs: switchResult.matchedTabs ?? 0,
        profiles
      });
      await waitForLocalStorageValue(secondPage, "advanced-network-e2e-storage", "profile-storage", {
        label: "second tab",
        matchedTabs: switchResult.matchedTabs ?? 0,
        profiles
      });
      const cookieOnlyProfile = profiles.find((profile) => profile.id === cookieProfile.id);

      return {
        cookieOnlyProfileCookieValue:
          cookieOnlyProfile?.cookieJar.find((cookie) => cookie.name === "advanced_network_e2e")?.value ?? "",
        firstTabStorageValue: await firstPage.evaluate(() => localStorage.getItem("advanced-network-e2e-storage")),
        matchedTabs: switchResult.matchedTabs ?? 0,
        secondTabStorageValue: await secondPage.evaluate(() => localStorage.getItem("advanced-network-e2e-storage")),
        storageProfileValue:
          profiles
            .flatMap((profile) => Object.values(profile.storageByScope))
            .find((storage) => storage.localStorage["advanced-network-e2e-storage"] === "browser-storage")
            ?.localStorage["advanced-network-e2e-storage"] ?? ""
      };
    } finally {
      await sendExtensionMessage(extensionPage, { type: "advanced-network:user-state-disable-profile" }).catch(() => undefined);
      await extensionPage.close();
      await firstPage.close();
      await secondPage.close();
    }
  }),
  runMockPopupScenario: createPlaywrightCommand(async (context) => {
    const page = await openExtensionPopup(context);
    try {
      await clearExtensionStorage(page);

      await page.getByTestId("mock-add-group").click();
      await page.getByTestId("mock-group-name").fill("E2E Mock 组");
      await blurFocusedElement(page);
      await page.getByTestId("mock-group-page-url").fill("test-page.html");
      await blurFocusedElement(page);

      await page.getByTestId("mock-add-rule").click();
      await page.getByTestId("mock-draft-name").fill("E2E Mock 规则");
      await blurFocusedElement(page);
      await page.getByTestId("mock-draft-matcher").fill("method:GET url:/fixtures/users.json");
      await blurFocusedElement(page);
      await page.getByTestId("mock-confirm-draft").click();

      const persisted = await waitForMockRule(page, "E2E Mock 组", "E2E Mock 规则");

      await page.reload();
      const reloadedGroupVisible = await page.locator(".mock-group-row").filter({ hasText: "E2E Mock 组" }).isVisible();
      const reloadedRulePersisted = Boolean(await findMockRule(page, "E2E Mock 组", "E2E Mock 规则"));

      return {
        groupName: persisted.group.name,
        groupPageUrlContains: persisted.group.pageUrlContains,
        ruleName: persisted.rule.name,
        ruleMatcherQuery: persisted.rule.matcherQuery,
        reloadedGroupVisible,
        reloadedRulePersisted
      };
    } finally {
      await page.close();
    }
  }),
  runMockCancelDraftScenario: createPlaywrightCommand(async (context) => {
    const page = await openExtensionPopup(context);
    try {
      await clearExtensionStorage(page);

      await page.getByTestId("mock-add-rule").click();
      const draftVisibleBeforeCancel = await page.locator(".mock-rule-draft").isVisible();
      await page.getByTestId("mock-cancel-draft").click();
      const draftVisibleAfterCancel = await page.locator(".mock-rule-draft").isVisible();
      const rules = normalizeMockRules(await getExtensionStorage<unknown>(page, MOCK_RULE_STORAGE_KEY));

      return {
        draftVisibleBeforeCancel,
        draftVisibleAfterCancel,
        ruleCount: rules.length
      };
    } finally {
      await page.close();
    }
  }),
  runMockJsonBodyScenario: createPlaywrightCommand(async (context) => {
    const page = await openExtensionPopup(context);
    try {
      await clearExtensionStorage(page);

      await page.getByTestId("mock-add-rule").click();
      await page.getByTestId("mock-draft-name").fill("E2E JSON Mock");
      await blurFocusedElement(page);
      await page.getByTestId("mock-draft-matcher").fill("method:GET url:/fixtures/users.json");
      await blurFocusedElement(page);
      await page.getByTestId("mock-draft-action").selectOption("replace-body");
      const responseBody = JSON.stringify({ users: [{ id: 1, name: "Mocked" }] }, null, 2);
      await page.getByTestId("mock-draft-response-body").fill(responseBody);
      await blurFocusedElement(page);
      await page.getByTestId("mock-confirm-draft").click();

      await waitForExtensionStorage(page, [MOCK_RULE_STORAGE_KEY], (items) =>
        normalizeMockRules(items[MOCK_RULE_STORAGE_KEY]).some(
          (rule) => rule.name === "E2E JSON Mock" && rule.action === "replace-body" && rule.responseBody === responseBody
        )
      );

      const rule = normalizeMockRules(await getExtensionStorage<unknown>(page, MOCK_RULE_STORAGE_KEY)).find(
        (item) => item.name === "E2E JSON Mock"
      );
      await page.reload();
      const reloadedRulePersisted = normalizeMockRules(await getExtensionStorage<unknown>(page, MOCK_RULE_STORAGE_KEY)).some(
        (item) => item.name === "E2E JSON Mock" && item.action === "replace-body" && item.responseBody === responseBody
      );

      return {
        ruleName: rule?.name ?? "",
        action: rule?.action ?? "",
        responseBody: rule?.responseBody ?? "",
        reloadedRulePersisted
      };
    } finally {
      await page.close();
    }
  }),
  runMockScriptScenario: createPlaywrightCommand(async (context) => {
    const page = await openExtensionPopup(context);
    try {
      await clearExtensionStorage(page);

      await page.getByTestId("mock-add-rule").click();
      await page.getByTestId("mock-draft-name").fill("E2E JS Mock");
      await blurFocusedElement(page);
      await page.getByTestId("mock-draft-matcher").fill("method:GET url:/fixtures/users.json");
      await blurFocusedElement(page);
      await page.getByTestId("mock-draft-action").selectOption("script");
      const script = [
        "function mock({ request, response }) {",
        "  return {",
        "    status: response.status,",
        "    headers: { ...response.headers, 'x-e2e-script': request.headers['x-advanced-network-demo'] || '1' },",
        "    body: JSON.stringify({ scripted: true, path: request.pathname, originalLength: response.body.length })",
        "  };",
        "}"
      ].join("\n");
      await page.getByTestId("mock-draft-script").fill(script);
      await blurFocusedElement(page);
      await page.getByTestId("mock-confirm-draft").click();

      await waitForExtensionStorage(page, [MOCK_RULE_STORAGE_KEY], (items) =>
        normalizeMockRules(items[MOCK_RULE_STORAGE_KEY]).some(
          (rule) => rule.name === "E2E JS Mock" && rule.action === "script" && rule.script === script
        )
      );

      const rule = normalizeMockRules(await getExtensionStorage<unknown>(page, MOCK_RULE_STORAGE_KEY)).find(
        (item) => item.name === "E2E JS Mock"
      );
      await page.reload();
      const reloadedRulePersisted = normalizeMockRules(await getExtensionStorage<unknown>(page, MOCK_RULE_STORAGE_KEY)).some(
        (item) => item.name === "E2E JS Mock" && item.action === "script" && item.script === script
      );

      return {
        ruleName: rule?.name ?? "",
        action: rule?.action ?? "",
        script: rule?.script ?? "",
        reloadedRulePersisted
      };
    } finally {
      await page.close();
    }
  }),
  runCdpMockResponseRewriteScenario: createPlaywrightCommand(async (context, origin: string) => {
    const testPage = await context.newPage();
    const extensionPage = await openExtensionPopup(context);
    let tabId: number | undefined;
    // 这个场景验证后台 Fetch 域改写，需要先开启「CDP 增强」；不开启时的页面钩子 Mock 见 pick-and-hook 场景。
    await setCdpModeForTest(extensionPage, "on");

    try {
      const testPageUrl = await openTestPage(testPage, origin);
      tabId = await getTabIdForPage(extensionPage, testPageUrl);
      const responseBody = JSON.stringify({ e2eMocked: true, source: "cdp-fetch" }, null, 2);
      const now = Date.now();
      const group: MockGroup = {
        id: DEFAULT_MOCK_GROUP_ID,
        name: "默认组",
        enabled: true,
        pageUrlContains: "test-page.html",
        createdAt: now,
        updatedAt: now
      };
      const rule: MockRule = {
        id: `e2e-cdp-${now}`,
        groupId: DEFAULT_MOCK_GROUP_ID,
        name: "E2E CDP Mock",
        enabled: true,
        scope: "global",
        domain: "",
        matcherQuery: "method:GET url:/fixtures/users.json",
        method: "GET",
        url: "/fixtures/users.json",
        action: "replace-body",
        responseHeaders: [{ name: "content-type", value: "application/json" }],
        responseBody,
        script: "",
        createdAt: now,
        updatedAt: now
      };

      const syncResult = await sendExtensionMessage(extensionPage, {
        type: "advanced-network:sync-mock-rules",
        tabId,
        pageUrl: testPageUrl,
        rules: [rule],
        groups: [group]
      });
      if (!syncResult.ok) {
        throw new Error(`Failed to sync CDP mock rules: ${syncResult.error ?? "unknown error"}`);
      }

      await testPage.getByRole("button", { name: "Fetch users" }).click();
      await testPage.waitForFunction(() => document.querySelector("#output")?.textContent?.includes("e2eMocked"));

      return {
        outputText: (await testPage.locator("#output").textContent()) ?? "",
        responseBody,
        syncOk: syncResult.ok
      };
    } finally {
      if (tabId !== undefined) {
        await sendExtensionMessage(extensionPage, {
          type: "advanced-network:disable-mock",
          tabId
        }).catch(() => undefined);
      }
      await setCdpModeForTest(extensionPage, "off").catch(() => undefined);
      await extensionPage.close();
      await testPage.close();
    }
  })
};

async function emitPanelRequest(page: Page, request: string | PanelHarnessRequest): Promise<void> {
  await page.evaluate((requestInput) => {
    const harness = (window as unknown as {
      __advancedNetworkHarness: { emitRequest: (input: string | PanelHarnessRequest) => void };
    }).__advancedNetworkHarness;
    harness.emitRequest(requestInput);
  }, request);
}

async function emitPanelNavigation(page: Page, url: string): Promise<void> {
  await page.evaluate((navigationUrl) => {
    const harness = (window as unknown as { __advancedNetworkHarness: { emitNavigated: (url: string) => void } }).__advancedNetworkHarness;
    harness.emitNavigated(navigationUrl);
  }, url);
}

async function expectRequestRowCount(page: Page, expectedCount: number): Promise<void> {
  await page.waitForFunction((count) => document.querySelectorAll('[data-testid="request-row"]').length === count, expectedCount);
}

function createPlaywrightCommand<Args extends unknown[], T>(
  handler: (context: BrowserContext, ...args: Args) => Promise<T>
): BrowserCommand<Args, T> {
  return async (commandContext, ...args) => {
    if (commandContext.provider.name !== "playwright") {
      throw new Error(`Unsupported browser provider: ${commandContext.provider.name}`);
    }
    return handler((commandContext as unknown as PlaywrightCommandContext).context, ...args);
  };
}

async function openExtensionPopup(context: BrowserContext): Promise<Page> {
  const extensionId = await getExtensionId(context);
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  return page;
}

/** 切换「CDP 增强」并等后台读到（storage.onChanged 是异步的）。 */
export async function setCdpModeForTest(page: Page, mode: "on" | "off"): Promise<void> {
  await page.evaluate((value) => chrome.storage.local.set({ "advancedNetwork.cdpMode": value }), mode);
  // waitForFunction 不会等待返回的 Promise，这里自己轮询。
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const status = (await page.evaluate(() => chrome.runtime.sendMessage({ type: "advanced-network:get-cdp-status" }))) as { mode?: string } | undefined;
    if (status?.mode === mode) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`CDP 增强没有切换到 ${mode}`);
}

async function getExtensionId(context: BrowserContext): Promise<string> {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  return new URL(worker.url()).host;
}

async function clearExtensionStorage(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolveClear) => {
        chrome.storage.local.clear(() => resolveClear());
      })
  );
  await page.reload();
}

async function getExtensionStorage<T>(page: Page, key: string): Promise<T | undefined> {
  const result = await page.evaluate(
    (storageKey) =>
      new Promise<Record<string, unknown>>((resolveGet) => {
        chrome.storage.local.get([storageKey], (items) => resolveGet(items));
      }),
    key
  );
  return result[key] as T | undefined;
}

async function resetTestPageState(page: Page): Promise<void> {
  await page.evaluate(() => {
    localStorage.removeItem("advanced-network-e2e-storage");
    sessionStorage.removeItem("advanced-network-e2e-storage");
    document.cookie = "advanced_network_e2e=; path=/; max-age=0; SameSite=Lax";
  });
}

function matchPatternForUrl(url: string): string {
  const parsedUrl = new URL(url);
  return `${parsedUrl.protocol}//${parsedUrl.hostname}:*/*`;
}

async function waitForLocalStorageValue(
  page: Page,
  key: string,
  expectedValue: string,
  debug: { label: string; matchedTabs: number; profiles: unknown }
): Promise<void> {
  const startedAt = Date.now();
  let actualValue: string | null = null;
  while (Date.now() - startedAt < 5000) {
    actualValue = await page.evaluate((storageKey) => localStorage.getItem(storageKey), key);
    if (actualValue === expectedValue) {
      return;
    }
    await page.waitForTimeout(100);
  }

  throw new Error(
    `Timed out waiting for ${debug.label} localStorage ${key}. Expected ${expectedValue}, got ${actualValue}. ` +
      `matchedTabs=${debug.matchedTabs}, profiles=${JSON.stringify(debug.profiles)}`
  );
}

async function openTestPage(page: Page, origin: string): Promise<string> {
  const candidateUrls = [`${origin}/src/test-page.html`, `${origin}/test-page.html`];
  let lastError: unknown;

  for (const url of candidateUrls) {
    try {
      await page.goto(url);
      await page.waitForSelector("#fetchUsers", { timeout: 5000 });
      return page.url();
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Cannot open test page.");
}

async function getTabIdForPage(extensionPage: Page, pageUrl: string): Promise<number> {
  const tabs = await extensionPage.evaluate(
    () =>
      new Promise<Array<{ id?: number; url?: string }>>((resolveQuery) => {
        chrome.tabs.query({}, (items) => resolveQuery(items.map((item) => ({ id: item.id, url: item.url }))));
      })
  );
  const tab = tabs.find((item) => item.url === pageUrl);
  if (typeof tab?.id !== "number") {
    throw new Error(`Cannot find tab id for ${pageUrl}. Known tabs: ${JSON.stringify(tabs)}`);
  }
  return tab.id;
}

async function sendExtensionMessage(
  extensionPage: Page,
  message: Record<string, unknown>
): Promise<RuntimeMessageResponse> {
  return extensionPage.evaluate(
    (runtimeMessage) =>
      new Promise<RuntimeMessageResponse>((resolveSend) => {
        chrome.runtime.sendMessage(runtimeMessage, (response) => {
          const error = chrome.runtime.lastError;
          if (error) {
            resolveSend({
              ok: false,
              error: error.message ?? "Runtime message failed."
            });
            return;
          }
          resolveSend(
            (response as RuntimeMessageResponse | undefined) ?? {
              ok: false,
              error: "No response."
            }
          );
        });
      }),
    message
  );
}

async function waitForExtensionStorage(
  page: Page,
  keys: string[],
  predicate: (items: Record<string, unknown>) => boolean,
  timeout = 10000
): Promise<Record<string, unknown>> {
  const startedAt = Date.now();
  let lastItems: Record<string, unknown> = {};
  while (Date.now() - startedAt < timeout) {
    lastItems = await page.evaluate(
      (storageKeys) =>
        new Promise<Record<string, unknown>>((resolveGet) => {
          chrome.storage.local.get(storageKeys, (items) => resolveGet(items));
        }),
      keys
    );
    if (predicate(lastItems)) {
      return lastItems;
    }
    await page.waitForTimeout(100);
  }
  throw new Error(`Timed out waiting for extension storage. Last value: ${JSON.stringify(lastItems)}`);
}

async function blurFocusedElement(page: Page): Promise<void> {
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  });
}

async function waitForMockRule(page: Page, groupName: string, ruleName: string) {
  await waitForExtensionStorage(page, [MOCK_GROUP_STORAGE_KEY, MOCK_RULE_STORAGE_KEY], (items) =>
    Boolean(findMockRuleInStorage(items, groupName, ruleName))
  );
  const match = await findMockRule(page, groupName, ruleName);
  if (!match) {
    throw new Error(`Cannot find persisted mock rule ${ruleName}.`);
  }
  return match;
}

async function findMockRule(page: Page, groupName: string, ruleName: string) {
  const groups = normalizeMockGroups(await getExtensionStorage<unknown>(page, MOCK_GROUP_STORAGE_KEY));
  const rules = normalizeMockRules(await getExtensionStorage<unknown>(page, MOCK_RULE_STORAGE_KEY));
  const group = groups.find((item) => item.name === groupName);
  const rule = rules.find((item) => item.groupId === group?.id && item.name === ruleName);
  return group && rule ? { group, rule } : null;
}

function findMockRuleInStorage(items: Record<string, unknown>, groupName: string, ruleName: string) {
  const groups = normalizeMockGroups(items[MOCK_GROUP_STORAGE_KEY]);
  const rules = normalizeMockRules(items[MOCK_RULE_STORAGE_KEY]);
  const group = groups.find((item) => item.name === groupName);
  const rule = rules.find((item) => item.groupId === group?.id && item.name === ruleName);
  return group && rule ? { group, rule } : null;
}

async function waitForUserStateProfile(
  page: Page,
  predicate: (profile: ReturnType<typeof normalizeUserStateProfiles>[number]) => boolean
): Promise<void> {
  await waitForExtensionStorage(page, [USER_STATE_PROFILE_STORAGE_KEY], (items) =>
    normalizeUserStateProfiles(items[USER_STATE_PROFILE_STORAGE_KEY]).some(predicate)
  );
}
