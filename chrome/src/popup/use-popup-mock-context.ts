import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import {
  createBlankMockRule,
  createMockGroup,
  DEFAULT_MOCK_GROUP_ID,
  MOCK_GROUP_STORAGE_KEY,
  MOCK_RULE_STORAGE_KEY,
  type MockGroup,
  type MockRule
} from "../shared/mock-rules";
import {
  loadMockStateFromStorage,
  persistMockStateToStorage
} from "../panel/persistent-state";
import type { MockDraftPatch, MockManagerContext, MockRulePatch } from "../panel/use-mock-context";

type MockPanelApi = {
  scrollToTop: () => void;
};

export function usePopupMockContext(): MockManagerContext {
  const mockRules = ref<MockRule[]>([]);
  const mockGroups = ref<MockGroup[]>([]);
  const draftMockRule = ref<MockRule | null>(null);
  const collapsedMockRuleIds = ref<Set<string>>(new Set());
  const mockPanelApi = ref<MockPanelApi | null>(null);
  const mockSyncMessage = ref("");
  const selectedMockGroupId = ref(DEFAULT_MOCK_GROUP_ID);
  const showMockManager = ref(true);

  const selectedMockGroup = computed(
    () => mockGroups.value.find((group) => group.id === selectedMockGroupId.value) ?? mockGroups.value[0] ?? null
  );
  const selectedMockGroupRules = computed(() =>
    mockRules.value.filter((rule) => rule.groupId === selectedMockGroupId.value)
  );
  const visibleMockRules = selectedMockGroupRules;
  let mockWriteQueue: Promise<void> = Promise.resolve();
  let pendingLocalMockWrites = 0;

  onMounted(async () => {
    await loadMockRules();
    installMockStorageSync();
  });

  onBeforeUnmount(() => {
    uninstallMockStorageSync();
  });

  async function loadMockRules(): Promise<void> {
    const state = await loadMockStateFromStorage();
    mockRules.value = state.rules;
    mockGroups.value = state.groups;
    ensureSelectedMockGroup();
    mockSyncMessage.value = "Mock 数据已同步";
  }

  async function persistMockRules(): Promise<void> {
    const state = {
      rules: mockRules.value,
      groups: mockGroups.value
    };
    pendingLocalMockWrites += 1;
    const writeTask = mockWriteQueue
      .catch(() => undefined)
      .then(() => persistMockStateToStorage(state))
      .finally(() => {
        setTimeout(() => {
          pendingLocalMockWrites = Math.max(0, pendingLocalMockWrites - 1);
        }, 0);
      });
    mockWriteQueue = writeTask;
    await writeTask;
    mockSyncMessage.value = "Mock 数据已保存";
  }

  function registerMockPanel(api: MockPanelApi | null): void {
    mockPanelApi.value = api;
  }

  async function scrollMockPanelToTop(): Promise<void> {
    await nextTick();
    mockPanelApi.value?.scrollToTop();
  }

  async function createBlankMockDraft(groupId: string): Promise<void> {
    draftMockRule.value = createBlankMockRule({
      id: crypto.randomUUID(),
      groupId,
      now: Date.now()
    });
    selectedMockGroupId.value = groupId;
    expandMockRule(draftMockRule.value.id);
    await scrollMockPanelToTop();
    mockSyncMessage.value = "已创建空白 Mock 草稿，确认后才会保存并启用。";
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
    mockSyncMessage.value = `已保存 Mock 规则：${ruleName}`;
  }

  function cancelMockDraft(): void {
    draftMockRule.value = null;
    mockSyncMessage.value = "已取消 Mock 草稿。";
  }

  async function toggleMockRule(rule: MockRule): Promise<void> {
    await updateMockRule(rule.id, { enabled: !rule.enabled });
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

  function updateMockDraft(patch: MockDraftPatch): void {
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
      mockSyncMessage.value = "默认组不能删除。";
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
      if (pendingLocalMockWrites > 0) {
        return;
      }
      void loadMockRules();
    }
  }

  return {
    addMockGroup,
    cancelMockDraft,
    canCloseMockManager: false,
    collapsedMockRuleIds,
    confirmMockDraft,
    createBlankMockDraft,
    deleteMockGroup,
    deleteMockRule,
    draftMockRule,
    mockGroups,
    mockRules,
    mockSyncMessage,
    moveMockGroup,
    registerMockPanel,
    selectMockGroup,
    selectedMockGroup,
    selectedMockGroupId,
    selectedMockGroupRules,
    showMockManager,
    toggleMockRule,
    toggleMockRuleCollapsed,
    updateMockDraft,
    updateMockGroup,
    updateMockRule,
    visibleMockRules
  };
}
