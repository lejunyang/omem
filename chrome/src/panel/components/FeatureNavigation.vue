<script setup lang="ts">
export type FeatureTab = "network" | "resource-search" | "user-state" | "device-emulation";

defineProps<{ modelValue: FeatureTab }>();
defineEmits<{ "update:modelValue": [value: FeatureTab] }>();

const features: Array<{ id: FeatureTab; title: string; path: string }> = [
  { id: "network", title: "网络", path: "M3 12h4l3-8 4 16 3-8h4" },
  { id: "resource-search", title: "资源搜索", path: "M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0" },
  { id: "user-state", title: "用户状态", path: "M20 21v-2a7 7 0 0 0-14 0v2M17 6a4 4 0 1 1-8 0 4 4 0 0 1 8 0" },
  { id: "device-emulation", title: "设备模拟", path: "M7 2h10a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1M10 18h4" }
];
</script>

<template>
  <nav class="feature-navigation" aria-label="功能导航">
    <div class="feature-brand"><span aria-hidden="true">o</span><strong>omem</strong></div>
    <button
      v-for="feature in features"
      :key="feature.id"
      type="button"
      :data-testid="`panel-tab-${feature.id}`"
      :aria-current="modelValue === feature.id ? 'page' : undefined"
      :class="{ 'is-active': modelValue === feature.id }"
      @click="$emit('update:modelValue', feature.id)"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="feature.path" /></svg>
      {{ feature.title }}
    </button>
  </nav>
</template>

<style scoped>
.feature-navigation { display: flex; flex-direction: column; gap: 2px; padding: 12px 8px; border-right: 1px solid var(--border); background: var(--sunken); overflow: auto; }
.feature-brand { display: flex; align-items: center; gap: 7px; margin: 0 6px 14px; white-space: nowrap; }
.feature-brand span { display: grid; place-items: center; width: 20px; height: 20px; border-radius: 6px; color: var(--panel); background: var(--ink); font-weight: 700; font-size: 12px; line-height: 1; }
.feature-brand strong { font-size: 13px; font-weight: 650; letter-spacing: -0.01em; }
.feature-navigation button { display: flex; gap: 8px; align-items: center; flex-shrink: 0; height: 30px; padding: 0 8px; border: 0; border-radius: 6px; background: transparent; color: var(--ink-2); cursor: pointer; text-align: left; white-space: nowrap; }
.feature-navigation button:hover { background: var(--hover); color: var(--ink); }
.feature-navigation button.is-active { background: var(--panel); color: var(--ink); box-shadow: 0 0 0 1px var(--line), 0 1px 2px rgba(20, 20, 20, 0.04); font-weight: 600; }
.feature-navigation button.is-active svg { color: var(--accent); }
.feature-navigation svg { width: 15px; height: 15px; flex-shrink: 0; }
@media (max-width: 600px) {
  .feature-brand strong { display: none; }
  .feature-navigation { padding: 10px 6px; }
  .feature-brand { margin: 0 auto 12px; }
  .feature-navigation button { flex-direction: column; height: auto; gap: 4px; padding: 7px 2px; font-size: 10px; text-align: center; }
}
</style>
