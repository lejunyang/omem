<script setup lang="ts">
import type { ThrottlingProfileId } from "../../shared/network-controls";
import { useInjectedPanelContext } from "../use-panel-context";

const {
  cdpEnabled,
  clearRecords,
  disableCache,
  enabledFilterSummaryText,
  enabledMockCount,
  enabledPresets,
  filter,
  filterValidation,
  isRecording,
  loadAllVisibleResponses,
  preserveLog,
  saveCurrentPreset,
  setCdpMode,
  showFilterBuilderDialog,
  showFilterSyntaxDialog,
  showMoreActions,
  showPresetManager,
  throttlingProfile,
  throttlingProfiles,
  toggleMockManager,
  updateDisableCache,
  updatePreserveLog,
  updateThrottlingProfile
} = useInjectedPanelContext();

const CDP_ONLY_TITLE = "需要开启「CDP 增强」。也可以用 DevTools 自带 Network 面板的同名开关，效果一样。";
</script>

<template>
  <header class="toolbar">
    <button
      class="button button-ghost"
      type="button"
      :class="{ 'is-recording': isRecording }"
      :title="isRecording ? '点击暂停记录' : '点击继续记录'"
      @click="isRecording = !isRecording"
    >
      <span class="record-dot" aria-hidden="true" />
      {{ isRecording ? "录制中" : "已暂停" }}
    </button>
    <button class="button button-ghost" type="button" title="清空当前列表" @click="clearRecords">清空</button>
    <label class="toolbar-check">
      <input
        :checked="preserveLog"
        data-testid="panel-preserve-log"
        type="checkbox"
        @change="updatePreserveLog(($event.target as HTMLInputElement).checked)"
      />
      保留日志
    </label>
    <span class="toolbar-divider" aria-hidden="true" />
    <div class="toolbar-filter-group">
      <input
        class="filter-input"
        :value="filter"
        :class="{ 'is-invalid': !filterValidation.valid }"
        placeholder='筛选，例如：/api/users method:POST status:2xx keyword:traceId url~/api\/users/i'
        @input="filter = ($event.target as HTMLInputElement).value"
      />
      <button class="button toolbar-filter-addon" type="button" title="点击查看筛选语法" @click="showFilterSyntaxDialog = true">?</button>
      <button class="button toolbar-filter-addon" type="button" title="添加筛选条件" @click="showFilterBuilderDialog = true">+</button>
    </div>
    <button class="button" type="button" @click="saveCurrentPreset">保存筛选</button>
    <button class="button" type="button" :title="enabledFilterSummaryText || '还没有启用的筛选方案'" @click="showPresetManager = !showPresetManager">
      全部筛选
      <span v-if="enabledPresets.length > 0" class="button-badge">{{ enabledPresets.length }}</span>
    </button>
    <button class="button" type="button" @click="toggleMockManager">
      Mock
      <span v-if="enabledMockCount > 0" class="button-badge">{{ enabledMockCount }}</span>
    </button>
    <button class="button" type="button" title="读取当前列表里所有响应体，之后可用 keyword: 搜索正文" @click="loadAllVisibleResponses">读取响应</button>
    <span class="toolbar-divider" aria-hidden="true" />
    <label class="toolbar-check" :class="{ 'is-cdp-only': !cdpEnabled }" :title="cdpEnabled ? '' : CDP_ONLY_TITLE">
      <input
        :checked="disableCache && cdpEnabled"
        :disabled="!cdpEnabled"
        type="checkbox"
        @change="updateDisableCache(($event.target as HTMLInputElement).checked)"
      />
      禁用缓存
    </label>
    <select
      class="preset-select"
      :class="{ 'is-cdp-only': !cdpEnabled }"
      :value="cdpEnabled ? throttlingProfile : 'none'"
      :disabled="!cdpEnabled"
      :title="cdpEnabled ? '网络限速' : CDP_ONLY_TITLE"
      @change="updateThrottlingProfile(($event.target as HTMLSelectElement).value as ThrottlingProfileId)"
    >
      <option v-for="profile in throttlingProfiles" :key="profile.id" :value="profile.id">
        {{ profile.label }}
      </option>
    </select>
    <button
      class="cdp-chip"
      type="button"
      data-testid="panel-cdp-toggle"
      :class="{ 'is-on': cdpEnabled }"
      :title="cdpEnabled ? 'CDP 增强已开启：Chrome 顶部会显示调试提示条。点击关闭。' : 'CDP 增强已关闭：Mock 只改 fetch / XHR，禁用缓存和限速不可用。点击开启（Chrome 会显示调试提示条）。'"
      @click="setCdpMode(cdpEnabled ? 'off' : 'on')"
    >
      CDP {{ cdpEnabled ? "开" : "关" }}
    </button>
    <button class="button button-ghost" type="button" @click="showMoreActions = !showMoreActions">更多</button>
  </header>
</template>
