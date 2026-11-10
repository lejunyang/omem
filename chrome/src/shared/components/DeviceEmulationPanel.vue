<script setup lang="ts">
import type { DeviceEmulationContext, DeviceProfilePatch } from "../use-device-emulation-context";
import type { DeviceOrientation } from "../device-emulation";
import DeviceAdvancedSettings from "./DeviceAdvancedSettings.vue";
import { useCdpMode } from "../use-cdp-mode";

const props = defineProps<{
  context: DeviceEmulationContext;
}>();

// 原页面模拟只能靠 CDP 的 Emulation 域；关闭时按钮置灰，引导用居中模拟器（不用 CDP 也能用）。
const cdp = useCdpMode();

function handleProfileChange(event: Event): void {
  props.context.setSelectedProfileId((event.target as HTMLSelectElement).value);
}

async function updateSelectedProfile(patch: DeviceProfilePatch): Promise<void> {
  await props.context.updateProfile(props.context.selectedProfile.value.id, patch);
}

async function updateOrientation(orientation: DeviceOrientation): Promise<void> {
  await props.context.setOrientation(orientation);
}

function numberValue(event: Event): number {
  return Number((event.target as HTMLInputElement).value);
}

function textValue(event: Event): string {
  return (event.target as HTMLInputElement | HTMLTextAreaElement).value;
}

function checkedValue(event: Event): boolean {
  return (event.target as HTMLInputElement).checked;
}

</script>

<template>
  <section class="device-emulation-panel" data-testid="device-emulation-panel">
    <header class="device-emulation-header">
      <div>
        <strong>设备模拟</strong>
        <span>居中模拟器不需要 CDP；「在原页面启用」需要开启 CDP 增强。</span>
      </div>
      <div class="device-emulation-actions">
        <button class="button button-primary" data-testid="device-open-simulator" type="button" @click="context.openSimulator">打开居中模拟器 ↗</button>
        <button class="button" data-testid="device-refresh" type="button" @click="context.refresh">刷新状态</button>
        <button
          v-if="context.enabled.value"
          class="button button-danger"
          data-testid="device-disable"
          type="button"
          @click="context.disable"
        >
          关闭模拟
        </button>
        <button
          v-else
          class="button is-active"
          data-testid="device-enable"
          type="button"
          :disabled="cdp.mode.value !== 'on'"
          :title="cdp.mode.value === 'on' ? '' : '需要开启「CDP 增强」。不开启时请用居中模拟器。'"
          @click="context.enable"
        >
          在原页面启用
        </button>
      </div>
    </header>

    <div class="device-emulation-status" :class="{ 'is-enabled': context.enabled.value }">
      <strong>{{ context.enabled.value ? "当前页面已启用" : "当前页面未启用" }}</strong>
      <span v-if="context.state.value">来源：{{ context.state.value.source === "popup" ? "PopUp" : "DevTools" }}</span>
      <span v-if="context.message.value">{{ context.message.value }}</span>
    </div>

    <div class="device-emulation-grid">
      <section class="device-emulation-card">
        <div class="device-emulation-card-title">
          <strong>设备配置</strong>
          <button class="button" data-testid="device-create-profile" type="button" @click="context.createProfile">
            新增设备
          </button>
        </div>
        <label class="device-field">
          <span>选择设备</span>
          <select
            class="preset-select"
            data-testid="device-profile-select"
            :value="context.selectedProfileId.value"
            @change="handleProfileChange"
          >
            <option v-for="profile in context.profiles.value" :key="profile.id" :value="profile.id">
              {{ profile.name }}{{ profile.builtin ? "（内置）" : "" }}
            </option>
          </select>
        </label>
        <div class="device-emulation-actions">
          <button
            class="button button-danger"
            data-testid="device-delete-profile"
            type="button"
            :disabled="context.selectedProfile.value.builtin"
            @click="context.deleteProfile(context.selectedProfile.value.id)"
          >
            删除当前设备
          </button>
        </div>
      </section>

      <section class="device-emulation-card">
        <div class="device-emulation-card-title">
          <strong>尺寸和方向</strong>
        </div>
        <div class="device-two-columns">
          <label class="device-field">
            <span>宽度</span>
            <input
              class="filter-input"
              data-testid="device-width"
              min="1"
              type="number"
              :value="context.selectedProfile.value.width"
              @change="updateSelectedProfile({ width: numberValue($event) })"
            />
          </label>
          <label class="device-field">
            <span>高度</span>
            <input
              class="filter-input"
              data-testid="device-height"
              min="1"
              type="number"
              :value="context.selectedProfile.value.height"
              @change="updateSelectedProfile({ height: numberValue($event) })"
            />
          </label>
        </div>
        <div class="device-two-columns">
          <label class="device-field">
            <span>DPR</span>
            <input
              class="filter-input"
              data-testid="device-dpr"
              min="0"
              step="0.1"
              type="number"
              :value="context.selectedProfile.value.deviceScaleFactor"
              @change="updateSelectedProfile({ deviceScaleFactor: numberValue($event) })"
            />
          </label>
        </div>
        <p class="device-emulation-note">
          原页面模式直接覆盖 viewport，保持 100% 显示。需要居中外框、适应窗口或自由缩放，请打开居中模拟器。
        </p>
        <div class="device-emulation-actions">
          <button
            class="button"
            data-testid="device-orientation-portrait"
            type="button"
            :class="{ 'is-active': context.settings.value.orientation === 'portrait' }"
            @click="updateOrientation('portrait')"
          >
            竖屏
          </button>
          <button
            class="button"
            data-testid="device-orientation-landscape"
            type="button"
            :class="{ 'is-active': context.settings.value.orientation === 'landscape' }"
            @click="updateOrientation('landscape')"
          >
            横屏
          </button>
        </div>
      </section>

      <section class="device-emulation-card">
        <div class="device-emulation-card-title">
          <strong>移动端行为</strong>
        </div>
        <label class="toolbar-check">
          <input
            type="checkbox"
            :checked="context.selectedProfile.value.mobile"
            @change="updateSelectedProfile({ mobile: checkedValue($event) })"
          />
          模拟 mobile viewport
        </label>
        <label class="toolbar-check">
          <input
            type="checkbox"
            :checked="context.selectedProfile.value.touchEnabled"
            @change="updateSelectedProfile({ touchEnabled: checkedValue($event) })"
          />
          启用 touch 输入模拟
        </label>
        <p class="device-emulation-note">
          会尝试将鼠标输入转换为 touch 输入；普通 tab 无法完全复刻原生 Device Toolbar 的输入代理，CSS hover 可能仍由浏览器触发。
        </p>
        <label class="device-field">
          <span>触摸点数</span>
          <input
            class="filter-input"
            data-testid="device-touch-points"
            min="0"
            type="number"
            :value="context.selectedProfile.value.maxTouchPoints"
            @change="updateSelectedProfile({ maxTouchPoints: numberValue($event) })"
          />
        </label>
      </section>

      <section class="device-emulation-card device-emulation-card-wide">
        <div class="device-emulation-card-title">
          <strong>UA 和平台</strong>
        </div>
        <label class="device-field">
          <span>名称</span>
          <input
            class="filter-input"
            data-testid="device-name"
            :value="context.selectedProfile.value.name"
            @change="updateSelectedProfile({ name: textValue($event) })"
          />
        </label>
        <label class="device-field">
          <span>Platform</span>
          <input
            class="filter-input"
            data-testid="device-platform"
            :value="context.selectedProfile.value.platform"
            @change="updateSelectedProfile({ platform: textValue($event) })"
          />
        </label>
        <label class="device-field">
          <span>User-Agent</span>
          <textarea
            class="filter-input device-user-agent"
            data-testid="device-user-agent"
            :value="context.selectedProfile.value.userAgent"
            @change="updateSelectedProfile({ userAgent: textValue($event) })"
          />
        </label>
      </section>

      <DeviceAdvancedSettings :context="context" />
    </div>
  </section>
</template>
