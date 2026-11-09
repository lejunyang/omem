<script setup lang="ts">
import { ref } from "vue";
import MockManagerPanel from "../panel/components/MockManagerPanel.vue";
import { provideMockContext } from "../panel/use-mock-context";
import DeviceEmulationPanel from "../shared/components/DeviceEmulationPanel.vue";
import { useCdpMode } from "../shared/use-cdp-mode";
import { useDeviceEmulationContext } from "../shared/use-device-emulation-context";
import UserStatePanel from "../shared/components/UserStatePanel.vue";
import { useUserStateContext } from "../shared/use-user-state-context";
import type { PickResponse, PickStartMode } from "../shared/pick-messages";
import { usePopupMockContext } from "./use-popup-mock-context";

const mock = usePopupMockContext();
const userState = useUserStateContext();
const deviceEmulation = useDeviceEmulationContext({
  source: "popup",
  resolveTabId: resolveActiveTabId
});
const cdp = useCdpMode();
const activeTab = ref<"mock" | "user-state" | "device-emulation">("mock");
const pickError = ref("");

provideMockContext(mock);

const pickModes: Array<{ mode: PickStartMode; label: string; title: string }> = [
  { mode: "element", label: "元素", title: "选中元素看样式、量间距（Alt+Shift+X）" },
  { mode: "region", label: "区域", title: "框选一块区域截图" },
  { mode: "viewport", label: "可视区", title: "截当前看到的部分" },
  { mode: "page", label: "整页", title: "截整个页面" }
];

async function resolveActiveTabId(): Promise<number | null> {
  // PopUp 没有 inspectedWindow，只能以当前窗口 active tab 作为目标；未命中时由共享 context 给出提示。
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0]?.id ?? null;
}

// 从 popup 发起时当前页自动获得 activeTab 权限，不需要额外授权；开始后关掉 popup，免得挡住页面。
async function startPick(mode: PickStartMode): Promise<void> {
  pickError.value = "";
  const tabId = await resolveActiveTabId();
  const response = (await chrome.runtime.sendMessage({ type: "omem-pick:start", mode, tabId })) as PickResponse | undefined;
  if (response?.ok) {
    window.close();
    return;
  }
  pickError.value = response?.error || "无法在这个页面上拾取。";
}

async function openBasket(): Promise<void> {
  const current = await chrome.windows.getCurrent();
  if (typeof current.id === "number") await chrome.sidePanel.open({ windowId: current.id });
  window.close();
}
</script>

<template>
  <main class="popup-app">
    <header class="popup-header">
      <div class="popup-brand"><span aria-hidden="true">o</span><strong>omem 助手</strong></div>
      <button
        class="cdp-chip"
        type="button"
        data-testid="popup-cdp-toggle"
        :class="{ 'is-on': cdp.mode.value === 'on' }"
        :title="cdp.mode.value === 'on' ? 'CDP 增强已开启：Chrome 顶部会显示调试提示条。点击关闭。' : 'CDP 增强已关闭：不连接调试接口，部分高级功能不可用。点击开启。'"
        @click="cdp.setMode(cdp.mode.value === 'on' ? 'off' : 'on')"
      >
        CDP 增强 {{ cdp.mode.value === "on" ? "开" : "关" }}
      </button>
    </header>

    <section class="pick-strip" aria-label="拾取">
      <div class="pick-strip-text">
        <strong>拾取</strong>
        <span>截图、看样式、量间距，记进拾取篮</span>
      </div>
      <div class="pick-strip-actions">
        <button
          v-for="item in pickModes"
          :key="item.mode"
          class="button"
          type="button"
          :data-testid="`popup-pick-${item.mode}`"
          :title="item.title"
          @click="startPick(item.mode)"
        >
          {{ item.label }}
        </button>
        <button class="button button-primary" type="button" data-testid="popup-open-basket" title="Alt+Shift+S" @click="openBasket">拾取篮</button>
      </div>
      <p v-if="pickError" class="pick-error">{{ pickError }}</p>
    </section>

    <nav class="popup-tabs" aria-label="功能切换">
      <button
        class="button"
        data-testid="popup-tab-mock"
        type="button"
        :class="{ 'is-active': activeTab === 'mock' }"
        @click="activeTab = 'mock'"
      >
        Mock
      </button>
      <button
        class="button"
        data-testid="popup-tab-user-state"
        type="button"
        :class="{ 'is-active': activeTab === 'user-state' }"
        @click="activeTab = 'user-state'"
      >
        用户状态
      </button>
      <button
        class="button"
        data-testid="popup-tab-device-emulation"
        type="button"
        :class="{ 'is-active': activeTab === 'device-emulation' }"
        @click="activeTab = 'device-emulation'"
      >
        设备模拟
      </button>
    </nav>
    <MockManagerPanel v-if="activeTab === 'mock'" />
    <UserStatePanel v-else-if="activeTab === 'user-state'" :context="userState" />
    <DeviceEmulationPanel v-else :context="deviceEmulation" />
    <footer v-if="activeTab === 'mock' && mock.mockSyncMessage.value" class="footer popup-footer">
      <span class="message">{{ mock.mockSyncMessage.value }}</span>
    </footer>
  </main>
</template>
