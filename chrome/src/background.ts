import { createDeviceSimulatorService } from "./background/device-simulator-service";
import { syncPageHookRegistration } from "./background/page-hook-registration";
import { clearSimulatorFallback, configureSimulatorFallback } from "./background/simulator-fallback";
import { createPickService } from "./background/pick-service";
import {
  CDP_MODE_STORAGE_KEY,
  type CdpMode,
  createCdpDisabledError,
  isCdpDisabledError,
  loadCdpMode,
  normalizeCdpMode
} from "./shared/cdp-mode";
import { applyStaticMock, sanitizeMockHeaders } from "./shared/mock-response";
import { createTabOperationQueue } from "./background/tab-operation-queue";
import {
  filterMockRulesByDomain,
  groupMatchesPageUrl,
  type MockGroup,
  type MockRule,
  MOCK_GROUP_STORAGE_KEY,
  MOCK_RULE_STORAGE_KEY,
  normalizeMockGroups,
  normalizeMockRules,
  ruleMatchesRequest
} from "./shared/mock-rules";
import { normalizeFilterPresets } from "./shared/filter-presets";
import { getStorageItems } from "./shared/extension-storage";
import { handleUserStateCookieChange, handleUserStateMessage } from "./background/user-state-service";
import { createResourceSearchService } from "./background/resource-search-service";
import { isUserStateMessage } from "./shared/user-state-messages";
import { isResourceSearchMessage } from "./shared/resource-search-messages";
import {
  headersArrayToRecord,
  headersRecordToArray,
  createMockScriptRequest,
  normalizeMockScriptResult,
  type MockScriptInput,
  type MockScriptOutput
} from "./shared/mock-script";
import {
  type NetworkControlSettings,
  normalizeNetworkControlSettings,
  toCdpNetworkConditions
} from "./shared/network-controls";
import type { InitiatorStackFrame, RequestInitiator } from "./shared/network";
import {
  normalizeDeviceEmulationSettings,
  normalizeDeviceProfile,
  toDeviceMetricsOverrideParams,
  toTouchEmulationParams,
  toUserAgentOverrideParams,
  type AvailableViewportSize,
  type DeviceEmulationState
} from "./shared/device-emulation";
import {
  type DeviceEmulationMessage,
  type DeviceEmulationMessageResponse
} from "./shared/device-emulation-messages";

interface MockMessage {
  type:
    | "advanced-network:enable-cdp-observer"
    | "advanced-network:disable-cdp-observer"
    | "advanced-network:get-initiator"
    | "advanced-network:get-mock-status"
    | "advanced-network:set-network-controls"
    | "advanced-network:sync-mock-rules"
    | "advanced-network:disable-mock";
  tabId: number;
  rules?: MockRule[];
  groups?: MockGroup[];
  controls?: NetworkControlSettings;
  method?: string;
  url?: string;
  pageUrl?: string;
}

interface MessageResponse {
  ok: boolean;
  error?: string;
  debuggerUnavailable?: boolean;
  cdpDisabled?: boolean;
  recoveryHint?: string;
  initiator?: RequestInitiator;
  mocked?: boolean;
  /** "cdp"：后台 Fetch 域在处理；"hook"：不用 CDP，由页面钩子处理。 */
  mode?: "cdp" | "hook";
}

interface MockScriptRunResponse {
  ok: boolean;
  result?: MockScriptOutput;
  error?: string;
}

interface FetchPausedEvent {
  frameId?: string;
  resourceType?: string;
  requestId: string;
  request: {
    method: string;
    url: string;
    headers?: Record<string, string>;
    postData?: string;
  };
  responseStatusCode?: number;
  responseHeaders?: Array<{ name: string; value: string }>;
}

interface FetchBodyResult {
  body?: string;
  base64Encoded?: boolean;
}

interface NetworkRequestWillBeSentEvent {
  request: {
    method: string;
    url: string;
  };
  type?: string;
  documentURL?: string;
  initiator?: RawCdpInitiator;
}

interface RawCdpInitiator {
  type?: string;
  url?: string;
  lineNumber?: number;
  columnNumber?: number;
  stack?: {
    callFrames?: Array<{
      functionName?: string;
      url?: string;
      lineNumber?: number;
      columnNumber?: number;
    }>;
    parent?: RawCdpInitiator["stack"];
  };
}

const DEBUGGER_VERSION = "1.3";
const MOCK_OFFSCREEN_URL = "mock-offscreen.html";
const FILTER_PRESET_STORAGE_KEY = "advancedNetwork.filterPresets";
const DEVTOOLS_PANEL_PORT_NAME = "advanced-network-devtools-panel";
const INACTIVE_ICON_PATHS = iconPaths("inactive");
const ACTIVE_ICON_PATHS = iconPaths("active");
const tabRules = new Map<number, MockRule[]>();
const tabGroups = new Map<number, MockGroup[]>();
const tabInitiators = new Map<number, Map<string, RequestInitiator>>();
const tabNetworkControls = new Map<number, NetworkControlSettings>();
const tabPageUrls = new Map<number, string>();
const tabMockedRequests = new Map<number, Set<string>>();
const tabDeviceEmulations = new Map<number, DeviceEmulationState>();
const attachedTabs = new Set<number>();
const debuggerAttachments = new Map<number, Promise<void>>();
const runDeviceOperation = createTabOperationQueue();
const simulatorService = createDeviceSimulatorService({ attachDebugger, sendDebuggerCommand });
const observedTabs = new Set<number>();
const deviceEmulationReplayTimers = new Map<number, ReturnType<typeof setTimeout>>();
const devtoolsPanelPorts = new Map<number, Set<chrome.runtime.Port>>();
let creatingOffscreenDocument: Promise<void> | null = null;
const resourceSearchService = createResourceSearchService({
  attachDebugger,
  sendDebuggerCommand,
  isCdpEnabled: () => cdpMode === "on"
});
const pickService = createPickService({
  attachDebugger,
  sendDebuggerCommand,
  isCdpEnabled: () => cdpMode === "on",
  releaseDebugger: (tabId) => maybeDetachDebugger(tabId)
});
const fallbackSimulatorTabs = new Set<number>();

// 「CDP 增强」开关：默认关闭。必须在第一次 attach 前读到，所以 attachDebugger 会等 cdpModeReady。
let cdpMode: CdpMode = "off";
const cdpModeReady = loadCdpMode().then((mode) => {
  cdpMode = mode;
});
void cdpModeReady.then(() => refreshPageHooks());

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !(CDP_MODE_STORAGE_KEY in changes)) return;
  cdpMode = normalizeCdpMode(changes[CDP_MODE_STORAGE_KEY].newValue);
  if (cdpMode === "off") void detachAllDebuggers();
  void refreshPageHooks();
});

chrome.permissions.onAdded.addListener(() => void refreshPageHooks());
chrome.permissions.onRemoved.addListener(() => void refreshPageHooks());

// 侧栏（拾取篮）不随工具栏图标打开：图标仍然打开 popup，侧栏由 popup 按钮或快捷键打开。
void chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: false }).catch(() => undefined);
chrome.commands?.onCommand.addListener((command, tab) => {
  void pickService.handleCommand(command, tab).catch(() => undefined);
});

void updateActionIconFromStorage();

chrome.runtime.onInstalled.addListener(() => {
  void updateActionIconFromStorage();
});

chrome.runtime.onStartup.addListener(() => {
  void updateActionIconFromStorage();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") {
    return;
  }
  if (
    FILTER_PRESET_STORAGE_KEY in changes ||
    MOCK_RULE_STORAGE_KEY in changes ||
    MOCK_GROUP_STORAGE_KEY in changes
  ) {
    void updateActionIconFromStorage();
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // 页面刷新或主文档重新加载后，部分站点会在初始化阶段读取 viewport/UA/touch；导航完成后重放一次设备模拟，避免刷新后状态半失效。
  if (changeInfo.status !== "complete" || !tabDeviceEmulations.has(tabId)) {
    return;
  }
  scheduleDeviceEmulationReplay(tabId);
});

// 离开模拟器外壳后释放它的覆盖，避免导航到普通页面仍携带模拟 UA/touch。
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (fallbackSimulatorTabs.has(tabId) && changeInfo.url && !changeInfo.url.startsWith(chrome.runtime.getURL("simulator.html"))) {
    fallbackSimulatorTabs.delete(tabId);
    void clearSimulatorFallback(tabId);
  }
  if (simulatorService.has(tabId) && changeInfo.url && !changeInfo.url.startsWith(chrome.runtime.getURL("simulator.html"))) {
    simulatorService.clear(tabId);
    void runDeviceOperation(tabId, () => disableDeviceEmulation(tabId)).catch(() => undefined);
  }
});
chrome.tabs.onRemoved.addListener((tabId) => {
  simulatorService.clear(tabId);
  if (fallbackSimulatorTabs.delete(tabId)) void clearSimulatorFallback(tabId);
  pickService.clearTab(tabId);
  tabDeviceEmulations.delete(tabId);
  clearDeviceEmulationReplayTimer(tabId);
  tabRules.delete(tabId); tabGroups.delete(tabId); tabInitiators.delete(tabId);
  tabNetworkControls.delete(tabId); tabPageUrls.delete(tabId); tabMockedRequests.delete(tabId);
  observedTabs.delete(tabId); attachedTabs.delete(tabId);
  resourceSearchService.clearTab(tabId);
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  // 用户切回已模拟 tab 时，Chrome 可能刚完成可视区域恢复；延迟重放可修正部分 compositor/viewport 状态不同步。
  if (!tabDeviceEmulations.has(activeInfo.tabId)) {
    return;
  }
  scheduleDeviceEmulationReplay(activeInfo.tabId);
});

chrome.windows.onBoundsChanged.addListener((window) => {
  // DevTools dock/undock 或关闭后会改变窗口内容区域，主动重放同窗口内的模拟 tab，尝试修正滚动区域和可视区域错位。
  if (typeof window.id !== "number") {
    return;
  }
  void replayDeviceEmulationsInWindow(window.id);
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== DEVTOOLS_PANEL_PORT_NAME) {
    return;
  }
  handleDevToolsPanelPort(port);
});

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  const messageType = (message as { type?: string } | null)?.type;
  if (messageType === "advanced-network:configure-simulator") {
    const config = message as { profile?: unknown; orientation?: unknown };
    void cdpModeReady
      .then(() =>
        runDeviceOperation(sender.tab?.id ?? -1, async () => {
          if (cdpMode === "on") return simulatorService.configure(sender, config);
          const result = await configureSimulatorFallback(sender, config.profile);
          if (typeof sender.tab?.id === "number") fallbackSimulatorTabs.add(sender.tab.id);
          return result;
        })
      )
      .then(sendResponse)
      .catch((error) => sendResponse(toMessageResponse(error)));
    return true;
  }
  if (messageType === "advanced-network:hook-mocked") {
    const { method, url } = message as { method?: string; url?: string };
    if (typeof sender.tab?.id === "number" && method && url) rememberMockedRequest(sender.tab.id, method, url);
    return false;
  }
  if (messageType === "advanced-network:hook-run-script") {
    void runHookScript(message as { ruleId?: string; input?: MockScriptInput })
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  }
  if (messageType === "advanced-network:get-cdp-status") {
    void cdpModeReady.then(() => sendResponse({ ok: true, mode: cdpMode, attachedTabs: [...attachedTabs] }));
    return true;
  }
  if (pickService.isPickMessage(message)) {
    void pickService
      .handleMessage(message, sender)
      .then(sendResponse)
      .catch((error) => sendResponse(toMessageResponse(error)));
    return true;
  }
  if (isUserStateMessage(message)) {
    void handleUserStateMessage(message)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse(toMessageResponse(error)));
    return true;
  }

  if (isResourceSearchMessage(message)) {
    void resourceSearchService
      .handleMessage(message)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse(toMessageResponse(error)));
    return true;
  }

  if (isDeviceEmulationRuntimeMessage(message)) {
    if (message.type === "advanced-network:get-device-emulation-state") {
      sendResponse({
        ok: true,
        state: tabDeviceEmulations.get(message.tabId) ?? null
      });
      return false;
    }
    void runDeviceOperation(message.tabId, () => handleDeviceEmulationMessage(message))
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse(toMessageResponse(error)));
    return true;
  }

  if (!isMockMessage(message)) {
    return false;
  }

  void handleMessage(message)
    .then((result) => sendResponse(result))
    .catch((error) => sendResponse(toMessageResponse(error)));
  return true;
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (typeof source.tabId !== "number") {
    return;
  }
  const sessionId = (source as chrome.debugger.Debuggee & { sessionId?: string }).sessionId;
  simulatorService.handleEvent(source.tabId, sessionId, method, params);
  if (method === "Fetch.requestPaused") {
    void handleFetchPaused(source.tabId, params as FetchPausedEvent, sessionId).catch(() => undefined);
  }
  if (sessionId) return;
  if (method === "Network.requestWillBeSent") {
    rememberInitiator(source.tabId, params as NetworkRequestWillBeSentEvent);
  }
  resourceSearchService.handleDebuggerEvent(source.tabId, method, params);
});

chrome.debugger.onDetach.addListener((source) => {
  if (typeof source.tabId === "number") {
    attachedTabs.delete(source.tabId);
    tabDeviceEmulations.delete(source.tabId);
    if (simulatorService.has(source.tabId)) {
      void chrome.runtime.sendMessage({ type: "advanced-network:simulator-error", tabId: source.tabId, error: "模拟连接已断开，请点击应用并载入重新连接。" }).catch(() => undefined);
    }
    simulatorService.clear(source.tabId);
    clearDeviceEmulationReplayTimer(source.tabId);
    resourceSearchService.clearTab(source.tabId);
  }
});

chrome.cookies.onChanged.addListener((changeInfo) => {
  void handleUserStateCookieChange(changeInfo).catch(() => undefined);
});

async function handleMessage(message: MockMessage): Promise<MessageResponse> {
  if (message.type === "advanced-network:disable-mock") {
    tabRules.delete(message.tabId);
    await maybeDetachDebugger(message.tabId);
    return { ok: true };
  }

  await cdpModeReady;
  if (message.type === "advanced-network:enable-cdp-observer") {
    // 不用 CDP 时调用栈由页面钩子记录，这里什么都不连。
    if (cdpMode !== "on") return { ok: true, mode: "hook" };
    observedTabs.add(message.tabId);
    await attachDebugger(message.tabId);
    await sendDebuggerCommand(message.tabId, "Network.enable");
    return { ok: true, mode: "cdp" };
  }

  if (message.type === "advanced-network:disable-cdp-observer") {
    observedTabs.delete(message.tabId);
    await maybeDetachDebugger(message.tabId);
    return { ok: true };
  }

  if (message.type === "advanced-network:get-initiator") {
    return {
      ok: true,
      initiator: tabInitiators.get(message.tabId)?.get(requestKey(message.method ?? "", message.url ?? ""))
    };
  }

  if (message.type === "advanced-network:get-mock-status") {
    return {
      ok: true,
      mocked: tabMockedRequests
        .get(message.tabId)
        ?.has(requestKey(message.method ?? "", message.url ?? "")) ?? false
    };
  }

  if (message.type === "advanced-network:set-network-controls") {
    const controls = normalizeNetworkControlSettings(message.controls);
    if (cdpMode !== "on") {
      // 关闭时不记下这些设置：否则之后开启 CDP、做完别的事（如整页截图）也会因为它们一直连着调试器。
      tabNetworkControls.delete(message.tabId);
      // 禁用缓存、限速只能靠 CDP；关闭时只报告状态，不连接调试器。
      if (requiresNetworkControlDebugger(controls)) throw createCdpDisabledError("禁用缓存和网络限速");
      return { ok: true, mode: "hook" };
    }
    tabNetworkControls.set(message.tabId, controls);
    await applyNetworkControls(message.tabId, controls);
    await maybeDetachDebugger(message.tabId);
    return { ok: true };
  }

  if (message.type === "advanced-network:sync-mock-rules") {
    const rules = normalizeMockRules(message.rules).filter((rule) => rule.enabled);
    const groups = normalizeMockGroups(message.groups);
    tabRules.set(message.tabId, rules);
    tabGroups.set(message.tabId, groups);
    if (message.pageUrl) {
      tabPageUrls.set(message.tabId, message.pageUrl);
    }
    if (cdpMode !== "on") {
      // 页面钩子（内容脚本或面板注入）直接读 storage 里的规则，后台不需要连接调试器。
      return { ok: true, mode: "hook" };
    }
    if (rules.length) {
      await attachDebugger(message.tabId);
      await sendDebuggerCommand(message.tabId, "Network.enable");
      await sendDebuggerCommand(message.tabId, "Fetch.enable", {
        patterns: [{ urlPattern: "*", requestStage: "Response" }]
      });
    } else {
      await maybeDetachDebugger(message.tabId);
    }
    return { ok: true };
  }

  return { ok: false, error: "Unknown message type." };
}

async function handleDeviceEmulationMessage(
  message: DeviceEmulationMessage
): Promise<DeviceEmulationMessageResponse> {
  if (message.type === "advanced-network:get-device-emulation-state") {
    return {
      ok: true,
      state: tabDeviceEmulations.get(message.tabId) ?? null
    };
  }

  if (message.type === "advanced-network:set-device-emulation") {
    const profile = normalizeDeviceProfile(message.profile);
    if (!profile) {
      return { ok: false, error: "设备配置无效，无法启用模拟。" };
    }
    const settings = normalizeDeviceEmulationSettings(message.settings);
    const state: DeviceEmulationState = {
      tabId: message.tabId,
      settings: {
        ...settings,
        enabled: true,
        profileId: profile.id
      },
      profile,
      appliedAt: Date.now(),
      source: message.source
    };
    await applyDeviceEmulation(state, message.availableSize);
    if (!attachedTabs.has(message.tabId)) throw createDebuggerError("Debugger detached while applying device emulation.");
    tabDeviceEmulations.set(message.tabId, state);
    return {
      ok: true,
      state
    };
  }

  if (message.type === "advanced-network:refresh-device-emulation") {
    const state = tabDeviceEmulations.get(message.tabId);
    if (!state) {
      return { ok: true, state: null };
    }
    await applyDeviceEmulation(state, message.availableSize);
    const nextState = {
      ...state,
      appliedAt: Date.now()
    };
    tabDeviceEmulations.set(message.tabId, nextState);
    return { ok: true, state: nextState };
  }

  if (message.type === "advanced-network:device-viewport-changed") {
    // DevTools 分界线拖动和 dock 开关不会触发 windows.onBoundsChanged，只能由面板侧 inspectedWindow 轮询发现。
    if (tabDeviceEmulations.has(message.tabId)) {
      scheduleDeviceEmulationReplay(message.tabId, 180);
    }
    return { ok: true, state: tabDeviceEmulations.get(message.tabId) ?? null };
  }

  if (message.type === "advanced-network:disable-device-emulation") {
    const uaRecoveryRequired = await disableDeviceEmulation(message.tabId);
    return {
      ok: true,
      state: null,
      uaRecoveryRequired
    };
  }

  return { ok: false, error: "Unknown device emulation message type." };
}

function isMockMessage(value: unknown): value is MockMessage {
  if (!value || typeof value !== "object") {
    return false;
  }

  const type = (value as { type?: unknown }).type;
  return (
    type === "advanced-network:enable-cdp-observer" ||
    type === "advanced-network:disable-cdp-observer" ||
    type === "advanced-network:get-initiator" ||
    type === "advanced-network:get-mock-status" ||
    type === "advanced-network:set-network-controls" ||
    type === "advanced-network:sync-mock-rules" ||
    type === "advanced-network:disable-mock"
  );
}

function isDeviceEmulationRuntimeMessage(value: unknown): value is DeviceEmulationMessage {
  // background 分发使用本地字符串判断，避免共享 UI 类型文件变化影响 service worker 是否能响应设备消息。
  if (!value || typeof value !== "object") {
    return false;
  }
  const type = (value as { type?: unknown }).type;
  return (
    type === "advanced-network:get-device-emulation-state" ||
    type === "advanced-network:set-device-emulation" ||
    type === "advanced-network:disable-device-emulation" ||
    type === "advanced-network:refresh-device-emulation" ||
    type === "advanced-network:device-viewport-changed"
  );
}

async function updateActionIconFromStorage(): Promise<void> {
  try {
    const items = await getStorageItems(chrome.storage.local, [
      FILTER_PRESET_STORAGE_KEY,
      MOCK_RULE_STORAGE_KEY,
      MOCK_GROUP_STORAGE_KEY
    ]);
    const enabledFilterExists = normalizeFilterPresets(items[FILTER_PRESET_STORAGE_KEY]).some((preset) => preset.enabled);
    const groups = normalizeMockGroups(items[MOCK_GROUP_STORAGE_KEY]);
    const enabledGroupIds = new Set(groups.filter((group) => group.enabled).map((group) => group.id));
    const enabledMockExists = normalizeMockRules(items[MOCK_RULE_STORAGE_KEY]).some(
      (rule) => rule.enabled && enabledGroupIds.has(rule.groupId)
    );

    await chrome.action.setIcon({
      path: enabledFilterExists || enabledMockExists ? ACTIVE_ICON_PATHS : INACTIVE_ICON_PATHS
    });
  } catch {
    // Icon state is best-effort and should not affect DevTools/background features.
  }
}

function iconPaths(state: "active" | "inactive"): Record<string, string> {
  return {
    "16": `icons/icon-${state}-16.png`,
    "32": `icons/icon-${state}-32.png`,
    "48": `icons/icon-${state}-48.png`,
    "128": `icons/icon-${state}-128.png`
  };
}

async function applyNetworkControls(tabId: number, controls: NetworkControlSettings): Promise<void> {
  if (!requiresNetworkControlDebugger(controls) && !attachedTabs.has(tabId)) {
    return;
  }

  await attachDebugger(tabId);
  await sendDebuggerCommand(tabId, "Network.enable");
  await sendDebuggerCommand(tabId, "Network.setCacheDisabled", {
    cacheDisabled: controls.disableCache
  });
  await sendDebuggerCommand(tabId, "Network.emulateNetworkConditions", {
    ...toCdpNetworkConditions(controls.throttlingProfile)
  });
}

async function applyDeviceEmulation(state: DeviceEmulationState, availableSize?: AvailableViewportSize): Promise<void> {
  // 设备模拟必须按 tabId 独立下发到 CDP，状态留在 background 内存中；DevTools 关闭不会触发清理。
  const metrics = toDeviceMetricsOverrideParams({
    profile: state.profile,
    settings: state.settings,
    availableSize
  });
  await attachDebugger(state.tabId);
  await sendDebuggerCommand(state.tabId, "Network.enable");
  await sendDebuggerCommand(state.tabId, "Emulation.setDeviceMetricsOverride", {
    ...metrics
  });
  await sendDebuggerCommand(state.tabId, "Emulation.setTouchEmulationEnabled", {
    ...toTouchEmulationParams(state.profile)
  });
  // DevTools 原生设备模式会把鼠标输入代理成触摸；普通 tab 无法完全复刻，但该 CDP 能力可尽量让鼠标输入发出 touch 事件。
  await sendDebuggerCommand(state.tabId, "Emulation.setEmitTouchEventsForMouse", {
    enabled: state.profile.touchEnabled && state.profile.maxTouchPoints > 0,
    configuration: "mobile"
  }).catch(() => undefined);
  await sendDebuggerCommand(state.tabId, "Emulation.setUserAgentOverride", {
    ...toUserAgentOverrideParams(state.profile)
  });
}

async function disableDeviceEmulation(tabId: number): Promise<boolean> {
  // 关闭时先停掉输入/UA 侧效果，再清 viewport metrics，避免清理过程中页面短暂处于“桌面布局 + 移动输入”的混合状态。
  const wasEnabled = tabDeviceEmulations.has(tabId);
  clearDeviceEmulationReplayTimer(tabId);
  if (!wasEnabled && !attachedTabs.has(tabId)) {
    return false;
  }

  let uaRecoveryRequired = false;
  try {
    if (attachedTabs.has(tabId)) {
      await sendDebuggerCommand(tabId, "Emulation.setTouchEmulationEnabled", { enabled: false });
      await sendDebuggerCommand(tabId, "Emulation.setEmitTouchEventsForMouse", { enabled: false }).catch(() => undefined);
      try {
        await sendDebuggerCommand(tabId, "Emulation.setUserAgentOverride", {
          userAgent: "",
          platform: ""
        });
      } catch {
        uaRecoveryRequired = true;
      }
      await sendDebuggerCommand(tabId, "Emulation.clearDeviceMetricsOverride");
      await sendDebuggerCommand(tabId, "Emulation.resetPageScaleFactor").catch(() => undefined);
    }
    tabDeviceEmulations.delete(tabId);
  } finally {
    // 关闭模拟时 DevTools 可能正在打开并争用 debugger，延后一拍释放可降低“关闭后 DevTools 弹出/页面异常”的概率。
    setTimeout(() => {
      void maybeDetachDebugger(tabId).catch(() => undefined);
    }, 0);
  }
  return uaRecoveryRequired;
}

async function replayDeviceEmulation(tabId: number): Promise<void> {
  await runDeviceOperation(tabId, () => replayDeviceEmulationNow(tabId));
}

// 在队列内读取当前状态，排在关闭之后的旧计时器不能重新启用模拟。
async function replayDeviceEmulationNow(tabId: number): Promise<void> {
  const state = tabDeviceEmulations.get(tabId);
  if (!state) {
    return;
  }
  try {
    await applyDeviceEmulation(state);
    if (!attachedTabs.has(tabId)) return;
    tabDeviceEmulations.set(tabId, {
      ...state,
      appliedAt: Date.now()
    });
  } catch {
    // 导航后的重放是稳定性增强，失败时保留原状态，由用户手动刷新/关闭时再看到具体 debugger 错误。
  }
}

function scheduleDeviceEmulationReplay(tabId: number, delayMs = 120): void {
  // 多个浏览器事件可能在 DevTools 关闭或窗口 resize 时连续触发，合并重放可降低 debugger 命令抖动。
  clearDeviceEmulationReplayTimer(tabId);
  deviceEmulationReplayTimers.set(
    tabId,
    setTimeout(() => {
      deviceEmulationReplayTimers.delete(tabId);
      void replayDeviceEmulation(tabId);
    }, delayMs)
  );
}

function scheduleDeviceEmulationReplaySequence(tabId: number, delays: number[]): void {
  // DevTools 关闭后 inspected page 的可视区域可能分多阶段恢复，串行补偿重放可覆盖用户反馈的关闭后溢出宽度问题。
  for (const delay of delays) {
    setTimeout(() => {
      if (tabDeviceEmulations.has(tabId)) {
        void replayDeviceEmulation(tabId);
      }
    }, delay);
  }
}

function clearDeviceEmulationReplayTimer(tabId: number): void {
  // 关闭模拟或 debugger detach 时必须取消延迟重放，避免已经关闭后又重新下发旧的设备 metrics。
  const timer = deviceEmulationReplayTimers.get(tabId);
  if (!timer) {
    return;
  }
  clearTimeout(timer);
  deviceEmulationReplayTimers.delete(tabId);
}

function handleDevToolsPanelPort(port: chrome.runtime.Port): void {
  let tabId: number | null = null;
  const handleMessage = (message: unknown): void => {
    const candidate = message as { type?: unknown; tabId?: unknown };
    if (candidate.type !== "advanced-network:devtools-panel-connected" || typeof candidate.tabId !== "number") {
      return;
    }
    tabId = candidate.tabId;
    const ports = devtoolsPanelPorts.get(tabId) ?? new Set<chrome.runtime.Port>();
    ports.add(port);
    devtoolsPanelPorts.set(tabId, ports);
  };
  port.onMessage.addListener(handleMessage);
  port.onDisconnect.addListener(() => {
    port.onMessage.removeListener(handleMessage);
    if (tabId === null) {
      return;
    }
    const ports = devtoolsPanelPorts.get(tabId);
    ports?.delete(port);
    if (!ports?.size) {
      devtoolsPanelPorts.delete(tabId);
      // DevTools 关掉后不再需要调用栈观察，及时断开，Chrome 顶部的调试提示条随之消失。
      observedTabs.delete(tabId);
      const closedTabId = tabId;
      setTimeout(() => void maybeDetachDebugger(closedTabId).catch(() => undefined), 0);
    }
    if (tabDeviceEmulations.has(tabId)) {
      scheduleDeviceEmulationReplaySequence(tabId, [120, 400, 900]);
    }
  });
}

async function replayDeviceEmulationsInWindow(windowId: number): Promise<void> {
  // 窗口 bounds 事件没有 tabId，需要查询同窗口 tab 后只重放当前仍处于模拟状态的页面。
  try {
    const tabs = await chrome.tabs.query({ windowId });
    for (const tab of tabs) {
      if (typeof tab.id === "number" && tabDeviceEmulations.has(tab.id)) {
        scheduleDeviceEmulationReplay(tab.id);
      }
    }
  } catch {
    // bounds 变化重放只是稳定性增强，查询失败不影响已有模拟状态。
  }
}

function requiresNetworkControlDebugger(controls: NetworkControlSettings): boolean {
  return controls.disableCache || controls.throttlingProfile !== "none";
}

async function handleFetchPaused(tabId: number, event: FetchPausedEvent, sessionId?: string): Promise<void> {
  // OOPIF 的 requestId 属于子 session，正文读取和继续响应必须送回同一 session。
  const send = <T = unknown>(method: string, params?: Record<string, unknown>) => sendDebuggerCommand<T>(tabId, method, params, sessionId);
  const resume = () => continueRequest(tabId, event.requestId, sessionId);
  const embeddingHeaders = await simulatorService.responseHeaders(tabId, event, sessionId).catch(() => undefined);
  if (embeddingHeaders) event = { ...event, responseHeaders: embeddingHeaders };
  const rules = tabRules.get(tabId) ?? [];
  const groups = tabGroups.get(tabId) ?? [];
  const groupsById = new Map(groups.map((group) => [group.id, group]));
  const pageUrl = tabPageUrls.get(tabId) ?? "";
  const domainRules = filterMockRulesByDomain(rules, hostname(event.request.url));
  const matchedRule = domainRules
    .filter((rule) => groupMatchesPageUrl(groupsById.get(rule.groupId), pageUrl))
    .find((rule) =>
      ruleMatchesRequest(rule, {
        method: event.request.method,
        url: event.request.url,
        status: event.responseStatusCode ?? null,
        responseHeaders: event.responseHeaders ?? []
      })
    );

  if (!matchedRule || event.responseStatusCode === undefined) {
    if (embeddingHeaders && event.responseStatusCode !== undefined) {
      // Chromium 会缓存已解析的 frame-ancestors；continueResponse 虽然成功改头，仍会按旧策略拒绝嵌入。
      // 仅对确实需要去掉嵌入指令的主内页重新提供原正文，其他响应继续流式传输。
      try {
        const redirect = event.responseStatusCode >= 300 && event.responseStatusCode < 400;
        const body = redirect ? undefined : await send<FetchBodyResult>("Fetch.getResponseBody", { requestId: event.requestId });
        await send("Fetch.fulfillRequest", {
          requestId: event.requestId, responseCode: event.responseStatusCode,
          responseHeaders: embeddingHeaders.filter((header) => !["content-length", "content-encoding", "transfer-encoding"].includes(header.name.toLowerCase())),
          ...(body ? { body: body.base64Encoded ? body.body : encodeBase64(body.body ?? "") } : {})
        });
      } catch { await resume(); }
    } else {
      await resume();
    }
    return;
  }

  try {
    const bodyResult = await send<FetchBodyResult>("Fetch.getResponseBody", {
      requestId: event.requestId
    });
    const originalBody = decodeBody(bodyResult);
    const originalHeaders = event.responseHeaders ?? [];
    const nextResponse = await getMockResponse(matchedRule, {
      request: createMockScriptRequest({
        method: event.request.method,
        url: event.request.url,
        headers: event.request.headers,
        body: event.request.postData
      }),
      response: {
        status: event.responseStatusCode,
        headers: headersArrayToRecord(originalHeaders),
        body: originalBody
      }
    });

    await send("Fetch.fulfillRequest", {
      requestId: event.requestId,
      responseCode: nextResponse.status,
      responseHeaders: sanitizeMockHeaders(headersRecordToArray(nextResponse.headers)),
      body: encodeBase64(nextResponse.body)
    });
    rememberMockedRequest(tabId, event.request.method, event.request.url);
  } catch {
    await resume();
  }
}

async function getMockResponse(rule: MockRule, input: MockScriptInput): Promise<MockScriptOutput> {
  if (rule.action === "script") {
    return runMockScript(rule, input);
  }

  return applyStaticMock(rule, input);
}

async function runMockScript(rule: MockRule, input: MockScriptInput): Promise<MockScriptOutput> {
  await ensureMockOffscreenDocument();

  const response = (await chrome.runtime.sendMessage({
    type: "advanced-network:run-mock-script",
    id: crypto.randomUUID(),
    script: rule.script,
    input
  })) as MockScriptRunResponse | undefined;

  if (!response?.ok) {
    throw new Error(response?.error ?? "Mock script failed.");
  }

  return normalizeMockScriptResult(response.result, {
    status: input.response.status,
    headers: input.response.headers,
    body: input.response.body
  });
}

async function ensureMockOffscreenDocument(): Promise<void> {
  if (await chrome.offscreen.hasDocument()) {
    return;
  }

  creatingOffscreenDocument ??= chrome.offscreen
    .createDocument({
      url: MOCK_OFFSCREEN_URL,
      reasons: [chrome.offscreen.Reason.IFRAME_SCRIPTING],
      justification: "Run Advanced Network mock scripts in an isolated sandbox iframe."
    })
    .finally(() => {
      creatingOffscreenDocument = null;
    });

  await creatingOffscreenDocument;
}

async function attachDebugger(tabId: number): Promise<void> {
  await cdpModeReady;
  // 唯一的连接入口：CDP 关闭时一律拒绝，回复里带 cdpDisabled，界面显示「需要开启 CDP 增强」。
  if (cdpMode !== "on") {
    throw createCdpDisabledError();
  }
  if (attachedTabs.has(tabId)) {
    return;
  }
  // Mock、设备和网络观察可能同时申请连接，合并在途 attach，避免第二个调用报 already attached。
  const pending = debuggerAttachments.get(tabId);
  if (pending) return pending;
  const attachment = new Promise<void>((resolve, reject) => {
    chrome.debugger.attach({ tabId }, DEBUGGER_VERSION, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(createDebuggerError(error.message));
        return;
      }
      attachedTabs.add(tabId);
      resolve();
    });
  });
  debuggerAttachments.set(tabId, attachment);
  try { await attachment; } finally { debuggerAttachments.delete(tabId); }
}

async function detachDebugger(tabId: number): Promise<void> {
  if (!attachedTabs.has(tabId)) {
    return;
  }
  await new Promise<void>((resolve) => {
    chrome.debugger.detach({ tabId }, () => {
      attachedTabs.delete(tabId);
      resolve();
    });
  });
}

async function maybeDetachDebugger(tabId: number): Promise<void> {
  const controls = tabNetworkControls.get(tabId);
  if (
    (tabRules.get(tabId)?.length ?? 0) > 0 ||
    observedTabs.has(tabId) ||
    tabDeviceEmulations.has(tabId) ||
    simulatorService.has(tabId) ||
    runDeviceOperation.has(tabId) ||
    resourceSearchService.hasActiveTab(tabId) ||
    (controls ? requiresNetworkControlDebugger(controls) : false)
  ) {
    return;
  }
  await detachDebugger(tabId);
}

async function continueRequest(tabId: number, requestId: string, sessionId?: string): Promise<void> {
  await sendDebuggerCommand(tabId, "Fetch.continueRequest", { requestId }, sessionId);
}

async function sendDebuggerCommand<T = unknown>(
  tabId: number,
  method: string,
  commandParams?: Record<string, unknown>,
  sessionId?: string
): Promise<T> {
  return new Promise((resolve, reject) => {
    // Chrome 125+ 支持 flat session；旧类型包未声明该字段，结构化变量保持 callback 兼容。
    const target = sessionId ? { tabId, sessionId } : { tabId };
    chrome.debugger.sendCommand(target, method, commandParams, (result) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(createDebuggerError(error.message));
        return;
      }
      resolve(result as T);
    });
  });
}

function decodeBody(result: FetchBodyResult): string {
  if (!result.body) {
    return "";
  }
  if (!result.base64Encoded) {
    return result.body;
  }
  const binary = atob(result.body);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function encodeBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function rememberInitiator(tabId: number, event: NetworkRequestWillBeSentEvent): void {
  if (event.type === "Document") {
    tabPageUrls.set(tabId, event.request.url);
  }

  const initiator = normalizeCdpInitiator(event.initiator);
  if (!initiator) {
    return;
  }
  const initiators = tabInitiators.get(tabId) ?? new Map<string, RequestInitiator>();
  initiators.set(requestKey(event.request.method, event.request.url), initiator);
  tabInitiators.set(tabId, initiators);
}

function rememberMockedRequest(tabId: number, method: string, url: string): void {
  const mockedRequests = tabMockedRequests.get(tabId) ?? new Set<string>();
  mockedRequests.add(requestKey(method, url));
  tabMockedRequests.set(tabId, mockedRequests);
}

function normalizeCdpInitiator(initiator: RawCdpInitiator | undefined): RequestInitiator | null {
  if (!initiator) {
    return null;
  }
  return {
    type: initiator.type ?? "unknown",
    url: initiator.url ?? "",
    lineNumber: toNullableNumber(initiator.lineNumber),
    columnNumber: toNullableNumber(initiator.columnNumber),
    stack: flattenStackFrames(initiator.stack)
  };
}

function flattenStackFrames(stack: RawCdpInitiator["stack"] | undefined): InitiatorStackFrame[] {
  if (!stack) {
    return [];
  }
  return [
    ...(stack.callFrames ?? []).map((frame) => ({
      functionName: frame.functionName || "(anonymous)",
      url: frame.url ?? "",
      lineNumber: toNullableNumber(frame.lineNumber),
      columnNumber: toNullableNumber(frame.columnNumber)
    })),
    ...flattenStackFrames(stack.parent)
  ];
}

function requestKey(method: string, url: string): string {
  return `${method.toUpperCase()} ${url}`;
}

function toNullableNumber(value: number | undefined): number | null {
  return typeof value === "number" ? value : null;
}

function toMessageResponse(error: unknown): MessageResponse {
  if (isCdpDisabledError(error)) {
    return { ok: false, error: error.message, cdpDisabled: true };
  }
  if (isDebuggerUnavailableError(error)) {
    return {
      ok: false,
      error: error.message,
      debuggerUnavailable: true,
      recoveryHint: debuggerRecoveryHint(error.message)
    };
  }

  return {
    ok: false,
    error: error instanceof Error ? error.message : String(error)
  };
}

function createDebuggerError(message: string | undefined): Error {
  const error = new Error(message || "Debugger is unavailable.");
  if (isDebuggerUnavailableMessage(error.message)) {
    error.name = "DebuggerUnavailableError";
  }
  return error;
}

function isDebuggerUnavailableError(error: unknown): error is Error {
  return error instanceof Error && error.name === "DebuggerUnavailableError";
}

function isDebuggerUnavailableMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("another debugger") ||
    normalized.includes("debugger is not attached") ||
    normalized.includes("cannot access") ||
    normalized.includes("user") ||
    normalized.includes("canceled") ||
    normalized.includes("cancelled")
  );
}

function debuggerRecoveryHint(message: string): string {
  const normalized = message.toLowerCase();
  if (normalized.includes("another debugger")) {
    return "请关闭其他正在调试该页面的工具或扩展，然后切回「高级网络」面板重试。";
  }

  return "请在 chrome://extensions 重新加载「高级网络」扩展，刷新被检查页面，重新打开 DevTools；Chrome 出现调试器访问提示时选择「允许」。";
}

async function detachAllDebuggers(): Promise<void> {
  // 关闭 CDP 增强：清掉所有依赖调试器的状态并断开，提示条立刻消失。
  observedTabs.clear();
  tabDeviceEmulations.clear();
  for (const tabId of [...attachedTabs]) {
    simulatorService.clear(tabId);
    resourceSearchService.clearTab(tabId);
    clearDeviceEmulationReplayTimer(tabId);
    await detachDebugger(tabId).catch(() => undefined);
  }
}

async function refreshPageHooks(): Promise<void> {
  await syncPageHookRegistration(cdpMode === "on").catch(() => undefined);
}

async function runHookScript(message: { ruleId?: string; input?: MockScriptInput }): Promise<{ ok: boolean; result?: MockScriptOutput; error?: string }> {
  // 只按 id 取 storage 里的规则：页面能伪造这条消息，但只能跑本人写好的脚本。
  const items = await getStorageItems(chrome.storage.local, [MOCK_RULE_STORAGE_KEY]);
  const rule = normalizeMockRules(items[MOCK_RULE_STORAGE_KEY]).find((item) => item.id === message.ruleId && item.enabled && item.action === "script");
  if (!rule || !message.input) return { ok: false, error: "Mock 规则不存在或已停用。" };
  return { ok: true, result: await runMockScript(rule, message.input) };
}
