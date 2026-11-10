import type { FilterPreset } from "../shared/filter-presets";
import { normalizeFilterPresets } from "../shared/filter-presets";
import { getStorageItems, setStorageItemsAndVerify } from "../shared/extension-storage";
import {
  type DeviceProfile,
  DEVICE_PROFILE_STORAGE_KEY,
  normalizeDeviceProfiles
} from "../shared/device-emulation";
import {
  type MockGroup,
  type MockRule,
  MOCK_GROUP_STORAGE_KEY,
  MOCK_RULE_STORAGE_KEY,
  normalizeMockGroups,
  normalizeMockRules
} from "../shared/mock-rules";
import {
  type NetworkControlSettings,
  NETWORK_CONTROL_STORAGE_KEY,
  normalizeNetworkControlSettings
} from "../shared/network-controls";

export const PRESET_STORAGE_KEY = "advancedNetwork.filterPresets";

export interface MockStorageState {
  rules: MockRule[];
  groups: MockGroup[];
}

export async function loadFilterPresetsFromStorage(): Promise<FilterPreset[]> {
  // 读取后只在确实需要修复结构时回写，避免缺失 key 被误写为空数组导致用户规则被清空。
  const result = await getStorageItems(chrome.storage.local, PRESET_STORAGE_KEY);
  const storedPresets = result[PRESET_STORAGE_KEY];
  const presets = normalizeFilterPresets(storedPresets);
  if (shouldRepairStoredValue(storedPresets, presets)) {
    await persistFilterPresetsToStorage(presets);
  }
  return presets;
}

export async function persistFilterPresetsToStorage(presets: FilterPreset[]): Promise<void> {
  await setStorageItemsAndVerify(chrome.storage.local, { [PRESET_STORAGE_KEY]: presets });
}

export async function loadMockStateFromStorage(): Promise<MockStorageState> {
  // Mock 规则和组需要一起修复，保证规则 groupId 与默认组结构在重开 DevTools 后仍可匹配。
  const result = await getStorageItems(chrome.storage.local, [MOCK_RULE_STORAGE_KEY, MOCK_GROUP_STORAGE_KEY]);
  const storedRules = result[MOCK_RULE_STORAGE_KEY];
  const storedGroups = result[MOCK_GROUP_STORAGE_KEY];
  const rules = normalizeMockRules(storedRules);
  const groups = normalizeMockGroups(storedGroups);
  if (shouldRepairStoredValue(storedRules, rules) || shouldRepairStoredValue(storedGroups, groups)) {
    await persistMockStateToStorage({ rules, groups });
  }
  return { rules, groups };
}

export async function persistMockStateToStorage(state: MockStorageState): Promise<void> {
  await setStorageItemsAndVerify(chrome.storage.local, {
    [MOCK_RULE_STORAGE_KEY]: state.rules,
    [MOCK_GROUP_STORAGE_KEY]: state.groups
  });
}

export async function loadNetworkControlsFromStorage(): Promise<NetworkControlSettings> {
  // Network 控制项是面板本地状态，读取失败不能回退到裸默认值后立刻覆盖用户保存值。
  const result = await getStorageItems(chrome.storage.local, NETWORK_CONTROL_STORAGE_KEY);
  const storedControls = result[NETWORK_CONTROL_STORAGE_KEY];
  const controls = normalizeNetworkControlSettings(storedControls);
  if (shouldRepairStoredValue(storedControls, controls)) {
    await persistNetworkControlsToStorage(controls);
  }
  return controls;
}

export async function persistNetworkControlsToStorage(controls: NetworkControlSettings): Promise<void> {
  await setStorageItemsAndVerify(chrome.storage.local, { [NETWORK_CONTROL_STORAGE_KEY]: controls });
}

export async function loadDeviceProfilesFromStorage(): Promise<DeviceProfile[]> {
  // 设备配置与筛选/Mock 一样可能被 DevTools 展示成数字键对象；只修复已存在的旧结构，避免首次打开时写入默认值覆盖用户数据。
  const result = await getStorageItems(chrome.storage.local, DEVICE_PROFILE_STORAGE_KEY);
  const storedProfiles = result[DEVICE_PROFILE_STORAGE_KEY];
  const profiles = normalizeDeviceProfiles(storedProfiles);
  if (shouldRepairStoredValue(storedProfiles, profiles)) {
    await persistDeviceProfilesToStorage(profiles);
  }
  return profiles;
}

export async function persistDeviceProfilesToStorage(profiles: DeviceProfile[]): Promise<void> {
  await setStorageItemsAndVerify(chrome.storage.local, { [DEVICE_PROFILE_STORAGE_KEY]: profiles });
}

function shouldRepairStoredValue(storedValue: unknown, normalizedValue: unknown): boolean {
  // undefined 表示 key 不存在，不是旧结构；只有存在但归一化后不同才允许回写迁移结果。
  if (storedValue === undefined) {
    return false;
  }
  return JSON.stringify(storedValue) !== JSON.stringify(normalizedValue);
}
