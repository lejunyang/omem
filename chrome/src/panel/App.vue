<script setup lang="ts">
import { ref } from "vue";
import FeatureNavigation from "./components/FeatureNavigation.vue";
import DeviceEmulationPanel from "../shared/components/DeviceEmulationPanel.vue";
import { useDeviceEmulationContext } from "../shared/use-device-emulation-context";
import UserStatePanel from "../shared/components/UserStatePanel.vue";
import { useUserStateContext } from "../shared/use-user-state-context";
import DebuggerWarning from "./components/DebuggerWarning.vue";
import FilterBuilderDialog from "./components/FilterBuilderDialog.vue";
import FilterManagerPanel from "./components/FilterManagerPanel.vue";
import FilterSyntaxDialog from "./components/FilterSyntaxDialog.vue";
import MockManagerPanel from "./components/MockManagerPanel.vue";
import MoreActionsPanel from "./components/MoreActionsPanel.vue";
import PanelToolbar from "./components/PanelToolbar.vue";
import RequestContextMenu from "./components/RequestContextMenu.vue";
import RequestDetail from "./components/RequestDetail.vue";
import ResourceSearchPanel from "./components/ResourceSearchPanel.vue";
import RequestTable from "./components/RequestTable.vue";
import SavePresetDialog from "./components/SavePresetDialog.vue";
import { useInspectedViewportWatcher } from "./use-inspected-viewport-watcher";
import { provideMockContext } from "./use-mock-context";
import { providePanelContext, usePanelContext } from "./use-panel-context";
import { useResourceSearchContext } from "./use-resource-search-context";

const panel = usePanelContext();
const userState = useUserStateContext();
const resourceSearch = useResourceSearchContext();
const deviceEmulation = useDeviceEmulationContext({
  source: "devtools",
  resolveTabId: () => chrome.devtools.inspectedWindow.tabId,
  resolveAvailableSize: getInspectedViewportSize
});
useInspectedViewportWatcher({
  resolveTabId: () => chrome.devtools.inspectedWindow.tabId,
  isEnabled: () => deviceEmulation.enabled.value
});
const activeFeatureTab = ref<"network" | "resource-search" | "user-state" | "device-emulation">("network");
providePanelContext(panel);
provideMockContext(panel);

const {
  closeRequestMenu,
  enabledMockCount,
  footerMessage,
  footerMessageIsError,
  grantSitePermission,
  hookMode,
  selectedStatusFilter,
  selectedTypeFilter,
  sitePermission,
  statsText,
  statusFilters,
  typeFilters
} = panel;

async function getInspectedViewportSize(): Promise<{ width: number; height: number } | undefined> {
  // 自适应窗口需要目标页当前可用 viewport；DevTools 面板只能通过 inspectedWindow.eval 读取，读取失败时回退为不缩放。
  return new Promise((resolve) => {
    chrome.devtools.inspectedWindow.eval(
      "({ width: window.innerWidth, height: window.innerHeight })",
      (result, exceptionInfo) => {
        if (exceptionInfo || !result || typeof result !== "object") {
          resolve(undefined);
          return;
        }
        const size = result as { width?: unknown; height?: unknown };
        resolve(
          typeof size.width === "number" && typeof size.height === "number"
            ? { width: size.width, height: size.height }
            : undefined
        );
      }
    );
  });
}
</script>

<template>
  <div class="app" @click="closeRequestMenu">
    <FeatureNavigation v-model="activeFeatureTab" />

    <div class="panel-feature-content">
      <template v-if="activeFeatureTab === 'network'">
        <PanelToolbar />
        <!-- “更多”是全局低频操作面板，必须紧跟工具栏展示在所有业务展开面板之前，避免后续面板把它挤到下方。 -->
        <MoreActionsPanel />
        <DebuggerWarning />
        <!-- 不用 CDP 时 Mock 靠页面钩子：站点没授权就只能在面板打开后注入，页面最早的请求赶不上。 -->
        <section v-if="hookMode && enabledMockCount > 0 && sitePermission === 'missing'" class="notice-bar">
          <span class="grow">Mock 由页面钩子处理（只改 fetch / XHR）。授权此站点后，刷新页面时从第一个请求开始生效，不开 DevTools 也生效。</span>
          <button class="button" type="button" @click="grantSitePermission">授权此站点</button>
        </section>
        <FilterManagerPanel />
        <FilterSyntaxDialog />
        <FilterBuilderDialog />
        <SavePresetDialog />
        <MockManagerPanel />

        <section class="filterbar">
          <div class="filter-group">
            <button
              v-for="typeFilter in typeFilters"
              :key="typeFilter.value"
              class="filter-chip"
              type="button"
              :class="{ 'is-active': selectedTypeFilter === typeFilter.value }"
              @click="selectedTypeFilter = typeFilter.value"
            >
              {{ typeFilter.label }}
            </button>
          </div>
          <select v-model="selectedStatusFilter" class="preset-select" title="状态筛选">
            <option
              v-for="statusFilter in statusFilters"
              :key="statusFilter.value"
              :value="statusFilter.value"
            >
              {{ statusFilter.label }}
            </option>
          </select>
        </section>

        <main class="content">
          <RequestTable />
          <RequestDetail />
        </main>

        <footer class="footer">
          <span>{{ statsText }}</span>
          <span class="message" :class="{ 'is-error': footerMessageIsError }" :title="footerMessage">{{ footerMessage }}</span>
        </footer>
      </template>

      <ResourceSearchPanel v-else-if="activeFeatureTab === 'resource-search'" :context="resourceSearch" />
      <UserStatePanel v-else-if="activeFeatureTab === 'user-state'" :context="userState" />
      <DeviceEmulationPanel v-else :context="deviceEmulation" />
    </div>

    <RequestContextMenu />
  </div>
</template>
