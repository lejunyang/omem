import { computed, inject, nextTick, onBeforeUnmount, onMounted, provide, ref, type InjectionKey } from "vue";
import {
  type DevtoolsRequest,
  getResponseBodySkipReason,
  type NetworkRecord,
  type RequestInitiator,
  toNetworkRecord
} from "../shared/network";
import {
  STATUS_FILTERS,
  type StatusFilter,
  TYPE_FILTERS,
  type TypeFilter,
  validateAdvancedQuery
} from "../shared/network-filters";
import { getCopyText, type CopyAction } from "../shared/network-copy";
import { type NetworkControlSettings, THROTTLING_PROFILES, type ThrottlingProfileId } from "../shared/network-controls";
import {
  createBlankMockRule,
  createMockGroup,
  createMockRuleFromRecord,
  DEFAULT_MOCK_GROUP_ID,
  MOCK_GROUP_STORAGE_KEY,
  MOCK_RULE_STORAGE_KEY,
  type MockAction,
  type MockGroup,
  type MockRule
} from "../shared/mock-rules";
import { getHarLog, getRequestContent } from "./devtools-api";
import { COPY_ACTIONS, DETAIL_TABS, FILTER_EXAMPLES, FILTER_FIELD_OPTIONS } from "./panel-options";
import type { DetailTab } from "./panel-types";
import {
  matchesPanelRecordFilters,
  shouldClearRecordsBeforeRequest,
  shouldClearRecordsOnNavigation,
  shouldReplaceRecordsFromHar
} from "./network-records";
import {
  loadMockStateFromStorage,
  loadNetworkControlsFromStorage,
  persistMockStateToStorage,
  persistNetworkControlsToStorage
} from "./persistent-state";
import { useFilterManager } from "./use-filter-manager";
import { CDP_MODE_STORAGE_KEY, type CdpMode, loadCdpMode, normalizeCdpMode, saveCdpMode } from "../shared/cdp-mode";
import { injectPageHook, inspectedOriginPattern, pushRulesToPageHook, readHookInitiator, readHookMocked } from "./page-hook-client";
import type { MockManagerContext, MockRulePatch } from "./use-mock-context";

type RuntimeResponse = {
  ok?: boolean;
  error?: string;
  debuggerUnavailable?: boolean;
  cdpDisabled?: boolean;
  recoveryHint?: string;
  initiator?: RequestInitiator;
  mocked?: boolean;
  mode?: "cdp" | "hook";
};

type MockPanelApi = {
  scrollToTop: () => void;
};

const CONTEXT_MENU_WIDTH = 220;
const CONTEXT_MENU_HEIGHT = 280;
const CONTEXT_MENU_MARGIN = 8;

const panelContextKey: InjectionKey<PanelContext> = Symbol("AdvancedNetworkPanelContext");

export function usePanelContext() {
  const records = ref<NetworkRecord[]>([]);
  const selectedId = ref("");
  const filter = ref("");
  const mockRules = ref<MockRule[]>([]);
  const mockGroups = ref<MockGroup[]>([]);
  const draftMockRule = ref<MockRule | null>(null);
  const mockPanelApi = ref<MockPanelApi | null>(null);
  const collapsedMockRuleIds = ref<Set<string>>(new Set());
  const selectedMockGroupId = ref(DEFAULT_MOCK_GROUP_ID);
  const message = ref("");
  const mockSyncMessage = ref("");
  const networkControlMessage = ref("");
  const debuggerWarning = ref("");
  const cdpMode = ref<CdpMode>("off");
  const cdpEnabled = computed(() => cdpMode.value === "on");
  /** 不用 CDP 时 Mock 和调用栈由页面钩子处理；sitePermission 表示被检查站点是否已授权（已授权才能从第一个请求生效）。 */
  const hookMode = ref(false);
  const sitePermission = ref<"granted" | "missing" | "unknown">("unknown");
  let inspectedOrigin: string | null = null;
  const isRecording = ref(true);
  const preserveLog = ref(false);
  const disableCache = ref(false);
  const throttlingProfile = ref<ThrottlingProfileId>("none");
  const showPresetManager = ref(false);
  const showMoreActions = ref(false);
  const showMockManager = ref(false);
  const showFilterSyntaxDialog = ref(false);
  const showFilterBuilderDialog = ref(false);
  const selectedTypeFilter = ref<TypeFilter>("all");
  const selectedStatusFilter = ref<StatusFilter>("all");
  const activeDetailTab = ref<DetailTab>("headers");
  const contextMenu = ref<{
    visible: boolean;
    x: number;
    y: number;
    record: NetworkRecord | null;
  }>({
    visible: false,
    x: 0,
    y: 0,
    record: null
  });

  const filterManager = useFilterManager({
    filter,
    message,
    selectedStatusFilter,
    selectedTypeFilter
  });

  const filteredRecords = computed(() =>
    records.value.filter((record) =>
      matchesPanelRecordFilters({
        record,
        filter: filter.value,
        typeFilter: selectedTypeFilter.value,
        statusFilter: selectedStatusFilter.value,
        matchesEnabledPresets: filterManager.matchesEnabledFilterPresets
      })
    )
  );
  const selectedRecord = computed(
    () => records.value.find((record) => record.id === selectedId.value) ?? null
  );
  const selectedMockGroup = computed(
    () => mockGroups.value.find((group) => group.id === selectedMockGroupId.value) ?? mockGroups.value[0] ?? null
  );
  const selectedMockGroupRules = computed(() =>
    mockRules.value.filter((rule) => rule.groupId === selectedMockGroupId.value)
  );
  const visibleMockRules = selectedMockGroupRules;
  const enabledMockCount = computed(() => mockRules.value.filter((rule) => rule.enabled).length);
  const statsText = computed(() => `${filteredRecords.value.length} / ${records.value.length} 次请求`);
  const filterValidation = computed(() => validateAdvancedQuery(filter.value));
  const enabledFilterSummaryText = computed(() =>
    filterManager.enabledPresetQueryPreview.value
      ? `${filterManager.enabledPresetSummary.value} / ${filterManager.enabledPresetQueryPreview.value}`
      : filterManager.enabledPresetSummary.value
  );
  const footerMessage = computed(() => {
    if (!filterValidation.value.valid) {
      return `筛选语法错误：${filterValidation.value.errors[0]}`;
    }
    if (networkControlMessage.value) {
      return networkControlMessage.value;
    }
    return message.value;
  });
  // 只有失败类提示标红；各处直接写 message 的文案都带「失败 / 错误 / 不可用」等字样，按文案判断最省事也最一致。
  const footerMessageIsError = computed(() => /失败|错误|不可用|无法|未生效/.test(footerMessage.value));
  let requestFinishedListener: ((request: unknown) => void) | null = null;
  let navigatedListener: ((url: string) => void) | null = null;

  onMounted(async () => {
    cdpMode.value = await loadCdpMode();
    chrome.storage.onChanged.addListener(handleCdpModeChange);
    await filterManager.loadPresets();
    await enableCdpObserver();
    await loadMockRules();
    await loadNetworkControls();
    await syncNetworkControls("");
    await loadExistingHar();
    installPanelVisibilitySync();
    installMockStorageSync();
    installNetworkListeners();
  });

  onBeforeUnmount(() => {
    chrome.storage.onChanged.removeListener(handleCdpModeChange);
    void chrome.runtime
      .sendMessage({ type: "advanced-network:disable-cdp-observer", tabId: chrome.devtools.inspectedWindow.tabId })
      .catch(() => undefined);
    uninstallNetworkListeners();
    uninstallPanelVisibilitySync();
    uninstallMockStorageSync();
  });

  async function loadExistingHar(): Promise<void> {
    try {
      const har = await getHarLog(chrome.devtools.network as unknown as Parameters<typeof getHarLog>[0]);
      const entries = har.entries ?? [];
      if (!shouldReplaceRecordsFromHar({ currentCount: records.value.length, entryCount: entries.length })) {
        return;
      }
      records.value = [];
      entries.forEach((entry) => addRequest(entry, false));
      message.value = "";
    } catch (error) {
      message.value = `读取 HAR 失败：${formatError(error)}`;
    }
  }

  function addRequest(request: DevtoolsRequest, shouldRender = true): void {
    const record = toNetworkRecord(request, records.value.length);
    if (
      shouldRender &&
      shouldClearRecordsBeforeRequest({
        preserveLog: preserveLog.value,
        record,
        currentCount: records.value.length
      })
    ) {
      records.value = [];
      selectedId.value = "";
    }

    const duplicated = records.value.some(
      (item) => item.url === record.url && item.startedAt === record.startedAt
    );

    if (!duplicated) {
      records.value.push(record);
      void enrichInitiator(record);
      void enrichMockStatus(record);
    }

    if (shouldRender && !selectedId.value) {
      selectedId.value = record.id;
    }
  }

  async function enableCdpObserver(): Promise<void> {
    try {
      const response = (await chrome.runtime.sendMessage({
        type: "advanced-network:enable-cdp-observer",
        tabId: chrome.devtools.inspectedWindow.tabId
      })) as RuntimeResponse | undefined;
      if (!response?.ok) {
        setFooter(formatAndStoreFeatureError("调用栈观察启动失败", response), true);
        return;
      }
      clearDebuggerWarning();
      hookMode.value = response.mode === "hook";
      if (hookMode.value) await installPageHook();
    } catch (error) {
      setFooter(formatAndStoreFeatureError("调用栈观察启动失败", error), true);
    }
  }

  /** 不用 CDP：把页面钩子注入被检查页面并下发规则，同时检查站点授权。导航后会重复调用（幂等）。 */
  async function installPageHook(): Promise<void> {
    await injectPageHook();
    await pushRulesToPageHook(mockRules.value, mockGroups.value);
    inspectedOrigin = await inspectedOriginPattern();
    sitePermission.value = inspectedOrigin
      ? (await chrome.permissions.contains({ origins: [inspectedOrigin] }).catch(() => false))
        ? "granted"
        : "missing"
      : "unknown";
  }

  /** 授权当前站点：之后页面钩子由内容脚本在页面最开始注入，Mock 对最早的请求也生效，不打开 DevTools 也生效。 */
  async function grantSitePermission(): Promise<void> {
    if (!inspectedOrigin) return;
    const granted = await chrome.permissions.request({ origins: [inspectedOrigin] }).catch(() => false);
    sitePermission.value = granted ? "granted" : "missing";
    if (granted) setFooter("已授权此站点，刷新页面后 Mock 从第一个请求开始生效。", false);
  }

  async function setCdpMode(next: CdpMode): Promise<void> {
    await saveCdpMode(next);
  }

  function handleCdpModeChange(changes: Record<string, chrome.storage.StorageChange>, areaName: string): void {
    if (areaName !== "local" || !(CDP_MODE_STORAGE_KEY in changes)) return;
    cdpMode.value = normalizeCdpMode(changes[CDP_MODE_STORAGE_KEY].newValue);
    // 切换后重新走一遍：CDP 开启时由后台连接并接管 Mock；关闭时回到页面钩子。
    void enableCdpObserver().then(() => syncMockRulesToBackground()).then(() => syncNetworkControls(""));
  }

  function setFooter(text: string, _isError: boolean): void {
    message.value = text;
  }

  async function enrichInitiator(record: NetworkRecord): Promise<void> {
    if (record.initiator) {
      return;
    }
    if (hookMode.value) {
      const initiator = await readHookInitiator(record.method, record.url).catch(() => null);
      if (initiator) record.initiator = initiator;
      return;
    }
    try {
      const response = (await chrome.runtime.sendMessage({
        type: "advanced-network:get-initiator",
        tabId: chrome.devtools.inspectedWindow.tabId,
        method: record.method,
        url: record.url
      })) as RuntimeResponse | undefined;
      const initiator = response?.initiator;
      if (response?.ok && initiator) {
        record.initiator = initiator;
      }
    } catch {
      // Initiator is best-effort; keep HAR data as the primary source.
    }
  }

  async function enrichMockStatus(record: NetworkRecord): Promise<void> {
    try {
      const response = (await chrome.runtime.sendMessage({
        type: "advanced-network:get-mock-status",
        tabId: chrome.devtools.inspectedWindow.tabId,
        method: record.method,
        url: record.url
      })) as RuntimeResponse | undefined;
      if (response?.ok && response.mocked) {
        record.isMocked = true;
        return;
      }
      if (hookMode.value && (await readHookMocked(record.method, record.url))) {
        record.isMocked = true;
      }
    } catch {
      // Mock status is best-effort and only affects row decoration.
    }
  }

  async function selectRecord(record: NetworkRecord): Promise<void> {
    selectedId.value = record.id;
    if (record.bodyState === "unloaded") {
      await loadResponseBody(record);
    }
  }

  async function loadResponseBody(record: NetworkRecord): Promise<void> {
    const skipReason = getResponseBodySkipReason(record);
    if (skipReason) {
      record.bodyState = "skipped";
      record.responseBody = skipReason;
      message.value = skipReason;
      return;
    }

    record.bodyState = "loading";

    try {
      const { content, encoding } = await getRequestContent(record.har);
      record.responseBody = content;
      record.bodyEncoding = encoding;
      record.bodyState = "loaded";
      message.value = "";
    } catch (error) {
      record.bodyState = "failed";
      record.responseBody = `读取响应体失败：${formatError(error)}`;
    }
  }

  async function loadMockRules(): Promise<void> {
    const state = await loadMockStateFromStorage();
    mockRules.value = state.rules;
    mockGroups.value = state.groups;
    ensureSelectedMockGroup();
    await syncMockRulesToBackground();
  }

  async function loadNetworkControls(): Promise<void> {
    const controls = await loadNetworkControlsFromStorage();
    preserveLog.value = controls.preserveLog;
    disableCache.value = controls.disableCache;
    throttlingProfile.value = controls.throttlingProfile;
  }

  async function persistMockRules(): Promise<void> {
    await persistMockStateToStorage({
      rules: mockRules.value,
      groups: mockGroups.value
    });
    await syncMockRulesToBackground();
  }

  async function persistNetworkControls(): Promise<void> {
    const controls = getNetworkControls();
    await persistNetworkControlsToStorage(controls);
    await syncNetworkControls("设置已更新");
  }

  async function updatePreserveLog(value: boolean): Promise<void> {
    preserveLog.value = value;
    await persistNetworkControls();
  }

  async function updateDisableCache(value: boolean): Promise<void> {
    disableCache.value = value;
    await persistNetworkControls();
  }

  async function updateThrottlingProfile(value: ThrottlingProfileId): Promise<void> {
    throttlingProfile.value = value;
    await persistNetworkControls();
  }

  /** reason 为空时静默同步（初始化、面板重新显示），只在出错时提示；用户改了设置才显示「已同步」。 */
  async function syncNetworkControls(reason: string): Promise<void> {
    if (!reason && !cdpEnabled.value) {
      // 没开 CDP 时禁用缓存 / 限速本来就不可用（界面已置灰），静默同步不再反复报同一件事。
      networkControlMessage.value = "";
      return;
    }
    try {
      const response = (await chrome.runtime.sendMessage({
        type: "advanced-network:set-network-controls",
        tabId: chrome.devtools.inspectedWindow.tabId,
        controls: getNetworkControls()
      })) as RuntimeResponse | undefined;
      networkControlMessage.value = response?.ok
        ? reason
          ? `${reason}：网络控制已生效`
          : ""
        : formatAndStoreFeatureError("禁用缓存 / 限速未生效", response);
      if (response?.ok) {
        clearDebuggerWarning();
      }
    } catch (error) {
      networkControlMessage.value = formatAndStoreFeatureError("Network 控制不可用", error);
    }
  }

  function getNetworkControls(): NetworkControlSettings {
    return {
      preserveLog: preserveLog.value,
      disableCache: disableCache.value,
      throttlingProfile: throttlingProfile.value
    };
  }

  async function syncMockRulesToBackground(): Promise<void> {
    const enabledRules = mockRules.value.filter((rule) => rule.enabled);
    try {
      const pageUrl = await getInspectedPageUrl();
      const response = (await chrome.runtime.sendMessage({
        type: enabledRules.length ? "advanced-network:sync-mock-rules" : "advanced-network:disable-mock",
        tabId: chrome.devtools.inspectedWindow.tabId,
        rules: enabledRules,
        groups: mockGroups.value,
        pageUrl
      })) as RuntimeResponse | undefined;
      mockSyncMessage.value = response?.ok
        ? enabledRules.length
          ? response.mode === "hook"
            ? `Mock 已生效：${enabledRules.length} 条规则（页面钩子，只改 fetch / XHR）`
            : `Mock 已生效：${enabledRules.length} 条规则`
          : "Mock 已停用"
        : formatAndStoreFeatureError("Mock 同步失败", response);
      if (response?.ok) {
        clearDebuggerWarning();
        if (response.mode === "hook") await pushRulesToPageHook(mockRules.value, mockGroups.value);
      }
    } catch (error) {
      mockSyncMessage.value = formatAndStoreFeatureError("Mock 同步失败", error);
    }
  }

  async function getInspectedPageUrl(): Promise<string> {
    return new Promise((resolve) => {
      chrome.devtools.inspectedWindow.eval("location.href", (result, exceptionInfo) => {
        resolve(exceptionInfo ? "" : typeof result === "string" ? result : "");
      });
    });
  }

  function toggleMockManager(): void {
    showMockManager.value = !showMockManager.value;
  }

  function registerMockPanel(api: MockPanelApi | null): void {
    mockPanelApi.value = api;
  }

  async function scrollMockPanelToTop(): Promise<void> {
    await nextTick();
    mockPanelApi.value?.scrollToTop();
  }

  function openRequestMenu(event: MouseEvent, record: NetworkRecord): void {
    selectedId.value = record.id;
    contextMenu.value = {
      visible: true,
      x: clampToViewport(event.clientX, CONTEXT_MENU_WIDTH, window.innerWidth),
      y: clampToViewport(event.clientY, CONTEXT_MENU_HEIGHT, window.innerHeight),
      record
    };
  }

  function closeRequestMenu(): void {
    contextMenu.value.visible = false;
  }

  async function copyFromContextMenu(action: CopyAction): Promise<void> {
    const record = contextMenu.value.record;
    if (!record) {
      return;
    }

    if (action === "response" && record.bodyState === "unloaded") {
      await loadResponseBody(record);
    }

    await navigator.clipboard.writeText(getCopyText(record, action));
    message.value = COPY_ACTIONS.find((item) => item.value === action)?.label ?? "已复制";
    closeRequestMenu();
  }

  async function createMockFromContextMenu(action: MockAction): Promise<void> {
    const record = contextMenu.value.record;
    if (!record) {
      return;
    }

    if ((action === "replace-body" || action === "script") && record.bodyState === "unloaded") {
      await loadResponseBody(record);
    }

    draftMockRule.value = createMockRuleFromRecord({
      id: crypto.randomUUID(),
      record,
      scope: "domain",
      action,
      groupId: mockGroups.value[0]?.id ?? DEFAULT_MOCK_GROUP_ID,
      now: Date.now()
    });
    selectedMockGroupId.value = draftMockRule.value.groupId;
    expandMockRule(draftMockRule.value.id);
    showMockManager.value = true;
    await scrollMockPanelToTop();
    message.value = "已创建 Mock 草稿，确认后才会保存并启用。";
    closeRequestMenu();
  }

  async function confirmMockDraft(): Promise<void> {
    if (!draftMockRule.value) {
      return;
    }
    mockRules.value = [draftMockRule.value, ...mockRules.value];
    const ruleName = draftMockRule.value.name;
    selectedMockGroupId.value = draftMockRule.value.groupId;
    draftMockRule.value = null;
    await persistMockRules();
    await scrollMockPanelToTop();
    message.value = `已保存 Mock 规则：${ruleName}`;
  }

  function cancelMockDraft(): void {
    draftMockRule.value = null;
    message.value = "已取消 Mock 草稿。";
  }

  async function toggleMockRule(rule: MockRule): Promise<void> {
    await updateMockRule(rule.id, { enabled: !rule.enabled });
  }

  async function createBlankMockDraft(groupId: string): Promise<void> {
    draftMockRule.value = createBlankMockRule({
      id: crypto.randomUUID(),
      groupId,
      now: Date.now()
    });
    selectedMockGroupId.value = groupId;
    expandMockRule(draftMockRule.value.id);
    showMockManager.value = true;
    await scrollMockPanelToTop();
    message.value = "已创建空白 Mock 草稿，确认后才会保存并启用。";
  }

  async function updateMockRule(ruleId: string, patch: MockRulePatch): Promise<void> {
    mockRules.value = mockRules.value.map((rule) =>
      rule.id === ruleId
        ? {
            ...rule,
            ...patch,
            updatedAt: Date.now()
          }
        : rule
    );
    await persistMockRules();
  }

  function updateMockDraft(
    patch: Partial<Pick<MockRule, "groupId" | "name" | "matcherQuery" | "action" | "responseHeaders" | "responseBody" | "script">>
  ): void {
    if (!draftMockRule.value) {
      return;
    }
    draftMockRule.value = {
      ...draftMockRule.value,
      ...patch,
      updatedAt: Date.now()
    };
  }

  async function addMockGroup(): Promise<void> {
    const group = createMockGroup({
      id: crypto.randomUUID(),
      name: `Mock 组 ${mockGroups.value.length + 1}`,
      now: Date.now()
    });
    mockGroups.value = [...mockGroups.value, group];
    selectedMockGroupId.value = group.id;
    await persistMockRules();
  }

  async function updateMockGroup(
    groupId: string,
    patch: Partial<Pick<MockGroup, "enabled" | "name" | "pageUrlContains">>
  ): Promise<void> {
    mockGroups.value = mockGroups.value.map((group) =>
      group.id === groupId
        ? {
            ...group,
            ...patch,
            updatedAt: Date.now()
          }
        : group
    );
    await persistMockRules();
  }

  async function deleteMockGroup(groupId: string): Promise<void> {
    if (groupId === DEFAULT_MOCK_GROUP_ID) {
      message.value = "默认组不能删除。";
      return;
    }
    mockGroups.value = mockGroups.value.filter((group) => group.id !== groupId);
    mockRules.value = mockRules.value.map((rule) =>
      rule.groupId === groupId
        ? {
            ...rule,
            groupId: DEFAULT_MOCK_GROUP_ID,
            updatedAt: Date.now()
          }
        : rule
    );
    if (draftMockRule.value?.groupId === groupId) {
      draftMockRule.value = {
        ...draftMockRule.value,
        groupId: DEFAULT_MOCK_GROUP_ID,
        updatedAt: Date.now()
      };
    }
    if (selectedMockGroupId.value === groupId) {
      selectedMockGroupId.value = DEFAULT_MOCK_GROUP_ID;
    }
    ensureSelectedMockGroup();
    await persistMockRules();
  }

  async function moveMockGroup(groupId: string, direction: "up" | "down"): Promise<void> {
    const index = mockGroups.value.findIndex((group) => group.id === groupId);
    const targetIndex = direction === "up" ? index - 1 : index + 1;
    if (index < 0 || targetIndex < 0 || targetIndex >= mockGroups.value.length) {
      return;
    }
    const nextGroups = [...mockGroups.value];
    const [group] = nextGroups.splice(index, 1);
    nextGroups.splice(targetIndex, 0, {
      ...group,
      updatedAt: Date.now()
    });
    mockGroups.value = nextGroups;
    await persistMockRules();
  }

  function selectMockGroup(groupId: string): void {
    selectedMockGroupId.value = groupId;
  }

  function ensureSelectedMockGroup(): void {
    if (mockGroups.value.some((group) => group.id === selectedMockGroupId.value)) {
      return;
    }
    selectedMockGroupId.value = mockGroups.value[0]?.id ?? DEFAULT_MOCK_GROUP_ID;
  }

  async function deleteMockRule(ruleId: string): Promise<void> {
    mockRules.value = mockRules.value.filter((rule) => rule.id !== ruleId);
    const nextIds = new Set(collapsedMockRuleIds.value);
    nextIds.delete(ruleId);
    collapsedMockRuleIds.value = nextIds;
    await persistMockRules();
  }

  function toggleMockRuleCollapsed(ruleId: string): void {
    const nextIds = new Set(collapsedMockRuleIds.value);
    if (nextIds.has(ruleId)) {
      nextIds.delete(ruleId);
    } else {
      nextIds.add(ruleId);
    }
    collapsedMockRuleIds.value = nextIds;
  }

  function expandMockRule(ruleId: string): void {
    if (!collapsedMockRuleIds.value.has(ruleId)) {
      return;
    }
    const nextIds = new Set(collapsedMockRuleIds.value);
    nextIds.delete(ruleId);
    collapsedMockRuleIds.value = nextIds;
  }

  function clearRecords(): void {
    records.value = [];
    selectedId.value = "";
    message.value = "";
  }

  function installNetworkListeners(): void {
    // 请求完成事件只负责追加记录；是否因为刷新清空交给 onNavigated，避免单个请求误判导致列表突然消失。
    requestFinishedListener = (request) => {
      if (!isRecording.value) {
        return;
      }
      addRequest(request as DevtoolsRequest);
    };
    chrome.devtools.network.onRequestFinished.addListener(requestFinishedListener);

    navigatedListener = () => {
      // 不用 CDP 时，新文档里没有钩子（未授权站点）：导航后分几次补注入，幂等。
      if (hookMode.value) {
        for (const delay of [0, 300, 1500]) setTimeout(() => void installPageHook(), delay);
      }
      // DevTools 导航事件是刷新/跳转的权威信号：未开启保留日志时清空，开启时保留旧请求。
      if (shouldClearRecordsOnNavigation({ preserveLog: preserveLog.value, currentCount: records.value.length })) {
        clearRecords();
      }
    };
    chrome.devtools.network.onNavigated.addListener(navigatedListener);
  }

  function uninstallNetworkListeners(): void {
    // DevTools 面板可能被销毁后重新创建，卸载监听可避免重复注册导致同一个请求被追加多次。
    if (requestFinishedListener) {
      chrome.devtools.network.onRequestFinished.removeListener(requestFinishedListener);
      requestFinishedListener = null;
    }
    if (navigatedListener) {
      chrome.devtools.network.onNavigated.removeListener(navigatedListener);
      navigatedListener = null;
    }
  }

  function installPanelVisibilitySync(): void {
    document.addEventListener("visibilitychange", syncNetworkControlsWhenVisible);
    window.addEventListener("focus", syncNetworkControlsWhenVisible);
    window.addEventListener("pageshow", syncNetworkControlsWhenVisible);
  }

  function uninstallPanelVisibilitySync(): void {
    document.removeEventListener("visibilitychange", syncNetworkControlsWhenVisible);
    window.removeEventListener("focus", syncNetworkControlsWhenVisible);
    window.removeEventListener("pageshow", syncNetworkControlsWhenVisible);
  }

  function syncNetworkControlsWhenVisible(): void {
    if (document.visibilityState === "hidden") {
      return;
    }
    void syncNetworkControls("");
  }

  function installMockStorageSync(): void {
    chrome.storage.onChanged.addListener(handleMockStorageChange);
  }

  function uninstallMockStorageSync(): void {
    chrome.storage.onChanged.removeListener(handleMockStorageChange);
  }

  function handleMockStorageChange(changes: Record<string, chrome.storage.StorageChange>, areaName: string): void {
    if (areaName !== "local") {
      return;
    }
    if (MOCK_RULE_STORAGE_KEY in changes || MOCK_GROUP_STORAGE_KEY in changes) {
      void loadMockRules();
    }
  }

  async function loadAllVisibleResponses(): Promise<void> {
    const targets = records.value.filter(
      (record) =>
        record.bodyState === "unloaded" &&
        matchesPanelRecordFilters({
          record,
          filter: filter.value,
          typeFilter: selectedTypeFilter.value,
          statusFilter: selectedStatusFilter.value,
          matchesEnabledPresets: filterManager.matchesEnabledFilterPresets
        })
    );
    for (const record of targets) {
      await loadResponseBody(record);
    }
    message.value = targets.length
      ? `已读取 ${targets.length} 条当前范围内请求的响应体，可继续使用筛选框搜索。`
      : "当前类型、状态和启用规则范围内的响应体均已读取。";
  }

  function exportHar(): void {
    const payload = {
      log: {
        version: "1.2",
        creator: {
          name: "高级网络",
          version: "0.1.0"
        },
        entries: records.value.map((record) => record.har)
      }
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json"
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `advanced-network-${Date.now()}.har`;
    link.click();
    URL.revokeObjectURL(url);
  }

  function openSourceLocation(url: string, lineNumber: number | null): void {
    if (!url) {
      message.value = "当前调用栈帧没有可打开的源文件 URL。";
      return;
    }
    chrome.devtools.panels.openResource(url, lineNumber ?? 0, () => {
      const error = chrome.runtime.lastError;
      message.value = error ? `打开源文件失败：${error.message}` : "";
    });
  }

  function clearDebuggerWarning(): void {
    debuggerWarning.value = "";
  }

  function formatAndStoreFeatureError(prefix: string, errorOrResponse: unknown): string {
    const response = normalizeRuntimeError(errorOrResponse);
    if (response.cdpDisabled) {
      // 没开 CDP 不是故障，不弹调试器警告，只说明需要什么。
      return `${prefix}：需要开启「CDP 增强」`;
    }
    if (response.debuggerUnavailable) {
      const hint = response.recoveryHint ? ` ${response.recoveryHint}` : "";
      const messageText = `${prefix}：debugger 不可用（${response.error}）。${hint}`;
      debuggerWarning.value = messageText;
      return messageText;
    }

    return `${prefix}：${response.error}`;
  }

  return {
    ...filterManager,
    activeDetailTab,
    addMockGroup,
    cancelMockDraft,
    canCloseMockManager: true,
    cdpEnabled,
    cdpMode,
    footerMessageIsError,
    grantSitePermission,
    hookMode,
    setCdpMode,
    sitePermission,
    clearDebuggerWarning,
    clearRecords,
    closeRequestMenu,
    collapsedMockRuleIds,
    confirmMockDraft,
    contextMenu,
    copyActions: COPY_ACTIONS,
    copyFromContextMenu,
    createMockFromContextMenu,
    createBlankMockDraft,
    debuggerWarning,
    deleteMockGroup,
    deleteMockRule,
    detailTabs: DETAIL_TABS,
    disableCache,
    draftMockRule,
    enabledFilterSummaryText,
    enabledMockCount,
    exportHar,
    filter,
    filterExamples: FILTER_EXAMPLES,
    filterFieldOptions: FILTER_FIELD_OPTIONS,
    filteredRecords,
    filterValidation,
    footerMessage,
    isRecording,
    loadAllVisibleResponses,
    loadExistingHar,
    mockGroups,
    mockRules,
    mockSyncMessage,
    moveMockGroup,
    openRequestMenu,
    openSourceLocation,
    preserveLog,
    records,
    registerMockPanel,
    selectedId,
    selectedMockGroup,
    selectedMockGroupId,
    selectedMockGroupRules,
    selectedRecord,
    selectMockGroup,
    selectRecord,
    selectedStatusFilter,
    selectedTypeFilter,
    showFilterBuilderDialog,
    showFilterSyntaxDialog,
    showMockManager,
    showMoreActions,
    showPresetManager,
    statsText,
    statusFilters: STATUS_FILTERS,
    throttlingProfile,
    throttlingProfiles: THROTTLING_PROFILES,
    toggleMockManager,
    toggleMockRule,
    toggleMockRuleCollapsed,
    typeFilters: TYPE_FILTERS,
    updateDisableCache,
    updateMockDraft,
    updateMockGroup,
    updateMockRule,
    updatePreserveLog,
    updateThrottlingProfile,
    visibleMockRules
  };
}

export type PanelContext = ReturnType<typeof usePanelContext>;
export type PanelMockContext = Pick<PanelContext, keyof MockManagerContext>;

export function providePanelContext(context: PanelContext): void {
  provide(panelContextKey, context);
}

export function useInjectedPanelContext(): PanelContext {
  const context = inject(panelContextKey);
  if (!context) {
    throw new Error("Advanced Network panel context is not provided.");
  }
  return context;
}

function clampToViewport(position: number, size: number, viewportSize: number): number {
  const maxPosition = Math.max(CONTEXT_MENU_MARGIN, viewportSize - size - CONTEXT_MENU_MARGIN);
  return Math.max(CONTEXT_MENU_MARGIN, Math.min(position, maxPosition));
}

function normalizeRuntimeError(errorOrResponse: unknown): Required<Pick<RuntimeResponse, "error">> &
  Pick<RuntimeResponse, "debuggerUnavailable" | "recoveryHint" | "cdpDisabled"> {
  if (errorOrResponse && typeof errorOrResponse === "object" && !(errorOrResponse instanceof Error)) {
    const response = errorOrResponse as RuntimeResponse;
    return {
      error: response.error ?? "后台没有响应，请重新打开 DevTools。",
      debuggerUnavailable: response.debuggerUnavailable,
      recoveryHint: response.recoveryHint,
      cdpDisabled: response.cdpDisabled
    };
  }

  return {
    error: formatError(errorOrResponse),
    debuggerUnavailable: false,
    recoveryHint: ""
  };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
