import { inject, provide, type ComputedRef, type InjectionKey, type Ref } from "vue";
import type { HeaderPair } from "../shared/network";
import type { MockAction, MockGroup, MockRule } from "../shared/mock-rules";

type MockPanelApi = {
  scrollToTop: () => void;
};

export type MockRulePatch = Partial<
  Pick<MockRule, "enabled" | "groupId" | "name" | "matcherQuery" | "action" | "responseHeaders" | "responseBody" | "script">
>;

export type MockDraftPatch = Partial<
  Pick<MockRule, "groupId" | "name" | "matcherQuery" | "action" | "responseHeaders" | "responseBody" | "script">
>;

export interface MockManagerContext {
  addMockGroup: () => Promise<void>;
  cancelMockDraft: () => void;
  canCloseMockManager: boolean;
  collapsedMockRuleIds: Ref<Set<string>>;
  confirmMockDraft: () => Promise<void>;
  createBlankMockDraft: (groupId: string) => Promise<void>;
  deleteMockGroup: (groupId: string) => Promise<void>;
  deleteMockRule: (ruleId: string) => Promise<void>;
  draftMockRule: Ref<MockRule | null>;
  mockGroups: Ref<MockGroup[]>;
  mockRules: Ref<MockRule[]>;
  mockSyncMessage: Ref<string>;
  moveMockGroup: (groupId: string, direction: "up" | "down") => Promise<void>;
  registerMockPanel: (api: MockPanelApi | null) => void;
  selectMockGroup: (groupId: string) => void;
  selectedMockGroup: ComputedRef<MockGroup | null>;
  selectedMockGroupId: Ref<string>;
  selectedMockGroupRules: ComputedRef<MockRule[]>;
  showMockManager: Ref<boolean>;
  toggleMockRule: (rule: MockRule) => Promise<void>;
  toggleMockRuleCollapsed: (ruleId: string) => void;
  updateMockDraft: (patch: MockDraftPatch) => void;
  updateMockGroup: (
    groupId: string,
    patch: Partial<Pick<MockGroup, "enabled" | "name" | "pageUrlContains">>
  ) => Promise<void>;
  updateMockRule: (ruleId: string, patch: MockRulePatch) => Promise<void>;
  visibleMockRules: ComputedRef<MockRule[]>;
}

export type MockHeaderPatch = Partial<HeaderPair>;

const mockContextKey: InjectionKey<MockManagerContext> = Symbol("AdvancedNetworkMockContext");

export function provideMockContext(context: MockManagerContext): void {
  provide(mockContextKey, context);
}

export function useInjectedMockContext(): MockManagerContext {
  const context = inject(mockContextKey);
  if (!context) {
    throw new Error("Advanced Network mock context is not provided.");
  }
  return context;
}
