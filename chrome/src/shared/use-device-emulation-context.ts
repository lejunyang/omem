import { normalizeSimulatorUrl } from "./device-simulator";
import { computed, onBeforeUnmount, onMounted, ref, type Ref } from "vue";
import {
  createDeviceProfile,
  DEFAULT_DEVICE_EMULATION_SETTINGS,
  DEFAULT_DEVICE_PROFILES,
  DEVICE_PROFILE_STORAGE_KEY,
  getOrCreateSelectedDeviceProfile,
  normalizeDeviceEmulationSettings,
  type AvailableViewportSize,
  type DeviceEmulationSettings,
  type DeviceEmulationSource,
  type DeviceEmulationState,
  type DeviceOrientation,
  type DeviceProfile,
  type DeviceScaleMode
} from "./device-emulation";
import type { DeviceEmulationMessage, DeviceEmulationMessageResponse } from "./device-emulation-messages";
import { loadDeviceProfilesFromStorage, persistDeviceProfilesToStorage } from "../panel/persistent-state";

export interface DeviceEmulationContext {
  profiles: Ref<DeviceProfile[]>;
  selectedProfileId: Ref<string>;
  selectedProfile: Ref<DeviceProfile>;
  settings: Ref<DeviceEmulationSettings>;
  state: Ref<DeviceEmulationState | null>;
  message: Ref<string>;
  enabled: Ref<boolean>;
  createProfile: () => Promise<void>;
  deleteProfile: (profileId: string) => Promise<void>;
  updateProfile: (profileId: string, patch: DeviceProfilePatch) => Promise<void>;
  setSelectedProfileId: (profileId: string) => void;
  setOrientation: (orientation: DeviceOrientation) => Promise<void>;
  setScaleMode: (scaleMode: DeviceScaleMode) => Promise<void>;
  setScale: (scale: number) => Promise<void>;
  openSimulator: () => Promise<void>;
  enable: () => Promise<void>;
  disable: () => Promise<void>;
  refresh: () => Promise<void>;
}

export type DeviceProfilePatch = Partial<
  Pick<
    DeviceProfile,
    | "name"
    | "width"
    | "height"
    | "deviceScaleFactor"
    | "mobile"
    | "userAgent"
    | "platform"
    | "touchEnabled"
    | "maxTouchPoints"
    | "metricsAdvanced"
  >
>;

export interface UseDeviceEmulationContextOptions {
  source: DeviceEmulationSource;
  resolveTabId: () => number | Promise<number | null> | null;
  resolveAvailableSize?: () => AvailableViewportSize | Promise<AvailableViewportSize | undefined> | undefined;
}

export function useDeviceEmulationContext(options: UseDeviceEmulationContextOptions): DeviceEmulationContext {
  const profiles = ref<DeviceProfile[]>(DEFAULT_DEVICE_PROFILES);
  const settings = ref<DeviceEmulationSettings>({ ...DEFAULT_DEVICE_EMULATION_SETTINGS });
  const state = ref<DeviceEmulationState | null>(null);
  const message = ref("");
  let profileWriteQueue: Promise<void> = Promise.resolve();
  let pendingLocalProfileWrites = 0;
  let profileRevision = 0;
  let latestRead = 0;

  const selectedProfileId = computed({
    get: () => settings.value.profileId,
    set: (profileId: string) => {
      settings.value = {
        ...settings.value,
        profileId
      };
    }
  });
  const selectedProfile = computed(() => getOrCreateSelectedDeviceProfile(profiles.value, selectedProfileId.value));
  const enabled = computed(() => Boolean(state.value?.settings.enabled));

  onMounted(async () => {
    await loadProfiles();
    await refresh();
    installProfileStorageSync();
  });

  onBeforeUnmount(() => {
    uninstallProfileStorageSync();
  });

  async function loadProfiles(): Promise<void> {
    // 设备配置可由 DevTools 或 PopUp 修改，读取统一走 storage helper，避免 UI 直接依赖 chrome.storage 结构。
    const revision = profileRevision;
    const read = ++latestRead;
    const loaded = await loadDeviceProfilesFromStorage();
    // 旧的初始化读取不能覆盖本地新建或编辑后的设备列表。
    if (revision !== profileRevision || read !== latestRead) return;
    profiles.value = loaded;
    if (!profiles.value.some((profile) => profile.id === selectedProfileId.value)) {
      selectedProfileId.value = profiles.value[0]?.id ?? DEFAULT_DEVICE_PROFILES[0].id;
    }
  }

  async function persistProfiles(): Promise<void> {
    profileRevision += 1;
    pendingLocalProfileWrites += 1;
    const nextProfiles = profiles.value;
    const writeTask = profileWriteQueue
      .catch(() => undefined)
      .then(() => persistDeviceProfilesToStorage(nextProfiles))
      .finally(() => {
        setTimeout(() => {
          pendingLocalProfileWrites = Math.max(0, pendingLocalProfileWrites - 1);
        }, 0);
      });
    profileWriteQueue = writeTask;
    await writeTask;
    message.value = "设备配置已保存。";
  }

  async function createProfile(): Promise<void> {
    const profile = createDeviceProfile({
      id: crypto.randomUUID(),
      name: `自定义设备 ${profiles.value.length + 1}`,
      width: selectedProfile.value.width,
      height: selectedProfile.value.height,
      deviceScaleFactor: selectedProfile.value.deviceScaleFactor,
      mobile: selectedProfile.value.mobile,
      userAgent: selectedProfile.value.userAgent,
      platform: selectedProfile.value.platform,
      touchEnabled: selectedProfile.value.touchEnabled,
      maxTouchPoints: selectedProfile.value.maxTouchPoints,
      metricsAdvanced: selectedProfile.value.metricsAdvanced,
      now: Date.now()
    });
    profiles.value = [...profiles.value, profile];
    selectedProfileId.value = profile.id;
    await persistProfiles();
    await refreshEnabledState();
  }

  async function deleteProfile(profileId: string): Promise<void> {
    const profile = profiles.value.find((item) => item.id === profileId);
    if (!profile) {
      return;
    }
    if (profile.builtin) {
      message.value = "内置设备不能删除。";
      return;
    }
    profiles.value = profiles.value.filter((item) => item.id !== profileId);
    if (selectedProfileId.value === profileId) {
      selectedProfileId.value = profiles.value[0]?.id ?? DEFAULT_DEVICE_PROFILES[0].id;
    }
    await persistProfiles();
    await refreshEnabledState();
  }

  async function updateProfile(profileId: string, patch: DeviceProfilePatch): Promise<void> {
    profiles.value = profiles.value.map((profile) =>
      profile.id === profileId
        ? createDeviceProfile({
            ...profile,
            ...patch,
            builtin: profile.builtin,
            now: profile.createdAt
          })
        : profile
    );
    profiles.value = profiles.value.map((profile) =>
      profile.id === profileId
        ? {
            ...profile,
            updatedAt: Date.now()
          }
        : profile
    );
    await persistProfiles();
    if (enabled.value && selectedProfileId.value === profileId) {
      await enable();
    }
  }

  function setSelectedProfileId(profileId: string): void {
    selectedProfileId.value = profileId;
    // 已启用时选择设备必须实际应用，避免界面显示新设备而页面仍使用旧配置。
    void refreshEnabledState();
  }

  async function setOrientation(orientation: DeviceOrientation): Promise<void> {
    settings.value = { ...settings.value, orientation };
    await refreshEnabledState();
  }

  async function setScaleMode(scaleMode: DeviceScaleMode): Promise<void> {
    settings.value = { ...settings.value, scaleMode };
    await refreshEnabledState();
  }

  async function setScale(scale: number): Promise<void> {
    settings.value = normalizeDeviceEmulationSettings({ ...settings.value, scale });
    await refreshEnabledState();
  }

  // 独立模拟器保留原 tab，配置通过现有 storage 读取，URL 只传目标地址和预设 id。
  async function openSimulator(): Promise<void> {
    try {
      const tabId = await resolveTabId();
      if (tabId === null) return;
      const tab = await chrome.tabs.get(tabId);
      const url = normalizeSimulatorUrl(tab.url || "");
      await chrome.tabs.create({ url: chrome.runtime.getURL("simulator.html") + "?" + new URLSearchParams({ url, profile: selectedProfileId.value }) });
    } catch (error) { message.value = error instanceof Error ? error.message : String(error); }
  }

  async function enable(): Promise<void> {
    const tabId = await resolveTabId();
    if (tabId === null) {
      return;
    }
    const nextSettings = normalizeDeviceEmulationSettings({
      ...settings.value,
      enabled: true,
      profileId: selectedProfile.value.id
    });
    const response = await sendMessageSafely({
      type: "advanced-network:set-device-emulation",
      tabId,
      profile: selectedProfile.value,
      settings: nextSettings,
      source: options.source,
      availableSize: await options.resolveAvailableSize?.()
    });
    handleResponse(response, "设备模拟已启用。");
    if (response?.ok) {
      settings.value = nextSettings;
      state.value = response.state ?? null;
    }
  }

  async function disable(): Promise<void> {
    const tabId = await resolveTabId();
    if (tabId === null) {
      return;
    }
    const response = await sendMessageSafely({
      type: "advanced-network:disable-device-emulation",
      tabId
    });
    handleResponse(response, response?.uaRecoveryRequired ? "设备模拟已关闭，UA 请求头可能需要刷新页面后恢复。" : "设备模拟已关闭。");
    if (response?.ok) {
      settings.value = { ...settings.value, enabled: false };
      state.value = null;
    }
  }

  async function refresh(): Promise<void> {
    const tabId = await resolveTabId();
    if (tabId === null) {
      return;
    }
    const response = await sendMessageSafely({
      type: "advanced-network:get-device-emulation-state",
      tabId
    });
    if (!response?.ok) {
      handleResponse(response, "");
      return;
    }
    state.value = response.state ?? null;
    if (response.state) {
      settings.value = response.state.settings;
      selectedProfileId.value = response.state.profile.id;
    }
  }

  async function refreshEnabledState(): Promise<void> {
    if (enabled.value) {
      await enable();
    }
  }

  async function resolveTabId(): Promise<number | null> {
    const tabId = await options.resolveTabId();
    if (typeof tabId !== "number") {
      message.value = "未找到可操作的当前页面。";
      return null;
    }
    return tabId;
  }

  function installProfileStorageSync(): void {
    chrome.storage.onChanged.addListener(handleProfileStorageChange);
  }

  function uninstallProfileStorageSync(): void {
    chrome.storage.onChanged.removeListener(handleProfileStorageChange);
  }

  function handleProfileStorageChange(changes: Record<string, chrome.storage.StorageChange>, areaName: string): void {
    if (areaName !== "local" || !(DEVICE_PROFILE_STORAGE_KEY in changes)) {
      return;
    }
    if (pendingLocalProfileWrites > 0) {
      return;
    }
    void loadProfiles();
  }

  function handleResponse(response: DeviceEmulationMessageResponse | undefined, successMessage: string): void {
    if (response?.ok) {
      message.value = successMessage;
      return;
    }
    message.value = [response?.error ?? "设备模拟操作失败。", response?.recoveryHint].filter(Boolean).join(" ");
  }

  async function sendMessage(message: DeviceEmulationMessage): Promise<DeviceEmulationMessageResponse | undefined> {
    return chrome.runtime.sendMessage(message) as Promise<DeviceEmulationMessageResponse | undefined>;
  }

  async function sendMessageSafely(message: DeviceEmulationMessage): Promise<DeviceEmulationMessageResponse | undefined> {
    try {
      return await sendMessage(message);
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  return {
    profiles,
    selectedProfileId,
    selectedProfile,
    settings,
    state,
    message,
    enabled,
    createProfile,
    deleteProfile,
    updateProfile,
    setSelectedProfileId,
    setOrientation,
    setScaleMode,
    setScale,
    openSimulator,
    enable,
    disable,
    refresh
  };
}
