import { computed, onBeforeUnmount, onMounted, ref, type ComputedRef, type Ref } from "vue";
import { getStorageItems, setStorageItemsAndVerify } from "./extension-storage";
import type { UserStateMessage, UserStateMessageResponse } from "./user-state-messages";
import {
  ACTIVE_USER_STATE_PROFILE_STORAGE_KEY,
  createUserStateProfile,
  normalizeUserStateProfiles,
  originsFromMatchPatterns,
  USER_STATE_PROFILE_STORAGE_KEY,
  type UserStateApplyMode,
  type UserStateControls,
  type UserStateProfile,
  withSingleActiveProfile
} from "./user-state-profiles";

export interface UserStateContext {
  addProfile: () => Promise<void>;
  addProfileDraftPattern: () => void;
  applyProfile: (profileId: string) => Promise<void>;
  captureProfile: (profileId: string) => Promise<void>;
  deleteProfile: (profileId: string) => Promise<void>;
  disableProfile: () => Promise<void>;
  profileDraftPattern: Ref<string>;
  profileDraftPatterns: Ref<string[]>;
  profiles: Ref<UserStateProfile[]>;
  removeProfileDraftPattern: (pattern: string) => void;
  selectedProfile: ComputedRef<UserStateProfile | null>;
  selectedProfileId: Ref<string>;
  updateProfile: (profileId: string, patch: UserStateProfilePatch) => Promise<void>;
  userStateMessage: Ref<string>;
}

export type UserStateProfilePatch = Partial<Pick<UserStateProfile, "name" | "matchPatterns" | "applyMode">> & {
  controls?: Partial<UserStateControls>;
};

export function useUserStateContext(): UserStateContext {
  const profiles = ref<UserStateProfile[]>([]);
  const selectedProfileId = ref("");
  const profileDraftPattern = ref("");
  const profileDraftPatterns = ref<string[]>(["*.example.com"]);
  const userStateMessage = ref("");
  const selectedProfile = computed(
    () => profiles.value.find((profile) => profile.id === selectedProfileId.value) ?? profiles.value[0] ?? null
  );
  let profileWriteQueue: Promise<void> = Promise.resolve();
  let pendingLocalProfileWrites = 0;
  let profileRevision = 0;
  let latestRead = 0;

  onMounted(() => {
    void loadProfiles();
    chrome.storage.onChanged.addListener(handleStorageChanged);
  });

  onBeforeUnmount(() => {
    chrome.storage.onChanged.removeListener(handleStorageChanged);
  });

  async function loadProfiles(): Promise<void> {
    const revision = profileRevision;
    const read = ++latestRead;
    const result = await getStorageItems(chrome.storage.local, [
      USER_STATE_PROFILE_STORAGE_KEY,
      ACTIVE_USER_STATE_PROFILE_STORAGE_KEY
    ]);
    // 初始化或跨页同步的旧读取不能盖掉用户刚创建/编辑的配置，即使 storage 写入已经成功。
    if (revision !== profileRevision || read !== latestRead) return;
    profiles.value = normalizeUserStateProfiles(result[USER_STATE_PROFILE_STORAGE_KEY]);
    const activeId = typeof result[ACTIVE_USER_STATE_PROFILE_STORAGE_KEY] === "string"
      ? result[ACTIVE_USER_STATE_PROFILE_STORAGE_KEY]
      : "";
    selectedProfileId.value = activeId || profiles.value[0]?.id || "";
  }

  async function addProfile(): Promise<void> {
    const now = Date.now();
    const matchPatterns = normalizeDraftPatterns([...profileDraftPatterns.value, profileDraftPattern.value]);
    const profile = createUserStateProfile({
      id: crypto.randomUUID(),
      name: `用户配置 ${profiles.value.length + 1}`,
      matchPatterns,
      now
    });
    profiles.value = [...profiles.value, profile];
    selectedProfileId.value = profile.id;
    profileDraftPattern.value = "";
    profileDraftPatterns.value = ["*.example.com"];
    await persistProfiles(profiles.value);
    userStateMessage.value = "已创建用户配置。";
  }

  function addProfileDraftPattern(): void {
    const pattern = profileDraftPattern.value.trim();
    if (!pattern || profileDraftPatterns.value.includes(pattern)) {
      profileDraftPattern.value = "";
      return;
    }
    profileDraftPatterns.value = [...profileDraftPatterns.value, pattern];
    profileDraftPattern.value = "";
  }

  function removeProfileDraftPattern(pattern: string): void {
    profileDraftPatterns.value = profileDraftPatterns.value.filter((item) => item !== pattern);
  }

  async function updateProfile(profileId: string, patch: UserStateProfilePatch): Promise<void> {
    if (!profileId) {
      return;
    }
    profiles.value = profiles.value.map((profile) =>
      profile.id === profileId
        ? {
            ...profile,
            ...patch,
            controls: patch.controls ? { ...profile.controls, ...patch.controls } : profile.controls,
            updatedAt: Date.now()
          }
        : profile
    );
    await persistProfiles(profiles.value);
  }

  async function deleteProfile(profileId: string): Promise<void> {
    if (!profileId) {
      return;
    }
    profiles.value = profiles.value.filter((profile) => profile.id !== profileId);
    if (selectedProfileId.value === profileId) {
      selectedProfileId.value = profiles.value[0]?.id || "";
    }
    await persistProfiles(profiles.value);
    userStateMessage.value = "已删除用户配置。";
  }

  async function applyProfile(profileId: string): Promise<void> {
    if (!profileId) {
      return;
    }
    const profile = profiles.value.find((item) => item.id === profileId);
    if (!profile) {
      return;
    }
    const origins = originsFromMatchPatterns(profile.matchPatterns);
    if (!origins.length) {
      userStateMessage.value = "请先填写有效的域名通配符规则。";
      return;
    }
    if ((profile.controls.cookie || profile.controls.webStorage) && !(await ensureHostPermissions(origins))) {
      userStateMessage.value = "用户拒绝域名权限，配置未开启。";
      return;
    }

    const enabledProfiles = withSingleActiveProfile(profiles.value, profileId);
    const enabledProfile = enabledProfiles.find((item) => item.id === profileId) ?? profile;
    profiles.value = enabledProfiles;
    await persistProfiles(enabledProfiles, profileId);
    const result = await sendUserStateMessage({
      type: "advanced-network:user-state-apply-profile",
      profile: enabledProfile
    });
    userStateMessage.value = result.ok
      ? `已开启配置并应用到 ${result.matchedTabs ?? 0} 个匹配标签页。`
      : result.error ?? "开启配置失败。";
  }

  async function disableProfile(): Promise<void> {
    profiles.value = withSingleActiveProfile(profiles.value, null);
    await persistProfiles(profiles.value, null);
    const result = await sendUserStateMessage({ type: "advanced-network:user-state-disable-profile" });
    userStateMessage.value = result.ok ? "已停用用户状态配置。" : result.error ?? "停用配置失败。";
  }

  async function captureProfile(profileId: string): Promise<void> {
    if (!profileId) {
      return;
    }
    const profile = profiles.value.find((item) => item.id === profileId);
    if (!profile) {
      return;
    }
    const result = await sendUserStateMessage({
      type: "advanced-network:user-state-capture",
      profile
    });
    userStateMessage.value = result.ok
      ? `已从 ${result.matchedTabs ?? 0} 个匹配标签页捕获状态。`
      : result.error ?? "捕获状态失败。";
    await loadProfiles();
  }

  async function persistProfiles(nextProfiles: UserStateProfile[], activeProfileId?: string | null): Promise<void> {
    profileRevision += 1;
    const items = {
      [USER_STATE_PROFILE_STORAGE_KEY]: nextProfiles,
      [ACTIVE_USER_STATE_PROFILE_STORAGE_KEY]: activeProfileId ?? nextProfiles.find((profile) => profile.enabled)?.id ?? null
    };
    pendingLocalProfileWrites += 1;
    const writeTask = profileWriteQueue
      .catch(() => undefined)
      .then(() => setStorageItemsAndVerify(chrome.storage.local, items))
      .finally(() => {
        setTimeout(() => {
          pendingLocalProfileWrites = Math.max(0, pendingLocalProfileWrites - 1);
        }, 0);
      });
    profileWriteQueue = writeTask;
    await writeTask;
  }

  async function ensureHostPermissions(origins: string[]): Promise<boolean> {
    const permissions = { origins };
    if (await chrome.permissions.contains(permissions)) {
      return true;
    }
    return chrome.permissions.request(permissions);
  }

  async function sendUserStateMessage(message: UserStateMessage): Promise<UserStateMessageResponse> {
    return chrome.runtime.sendMessage(message);
  }

  function handleStorageChanged(
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: chrome.storage.AreaName
  ): void {
    if (areaName !== "local") {
      return;
    }
    if (USER_STATE_PROFILE_STORAGE_KEY in changes || ACTIVE_USER_STATE_PROFILE_STORAGE_KEY in changes) {
      if (pendingLocalProfileWrites > 0) {
        return;
      }
      void loadProfiles();
    }
  }

  return {
    addProfile,
    addProfileDraftPattern,
    applyProfile,
    captureProfile,
    deleteProfile,
    disableProfile,
    profileDraftPattern,
    profileDraftPatterns,
    profiles,
    removeProfileDraftPattern,
    selectedProfile,
    selectedProfileId,
    updateProfile,
    userStateMessage
  };
}

function normalizeDraftPatterns(patterns: string[]): string[] {
  const normalizedPatterns = patterns.map((pattern) => pattern.trim()).filter(Boolean);
  return [...new Set(normalizedPatterns)].length ? [...new Set(normalizedPatterns)] : ["*.example.com"];
}
