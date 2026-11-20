<script setup lang="ts">
import { watch } from "vue";
import { toast } from "../../store";
import { useBackends, useSettings } from "./ctx";
import ReplaySettings from "../../components/ReplaySettings.vue";
import SetCard from "../../components/SetCard.vue";
import SetRow from "../../components/SetRow.vue";
import Skeleton from "../../components/Skeleton.vue";
import UiCheckbox from "../../components/UiCheckbox.vue";
import UiSegmented from "../../components/UiSegmented.vue";

/** 设置 → 助手 → 自检与复盘: the nightly check of pages the assistant wrote, and the nightly replay of recent questions. */
const { config, profiles, saveConfig } = useSettings();
const { profileOptions, modelOptionsFor, loadProbes } = useBackends(profiles);
watch(() => profiles.value.length, (n) => { if (n) void loadProbes(); }, { immediate: true });

const auditFields = [
  { key: "max", label: "每晚最多几页", hint: "1–100", max: 100 },
  { key: "perPipeline", label: "每类运行最多几页", hint: "1–50", max: 50 },
  { key: "strictMax", label: "加严时每晚最多几页", hint: "1–100", max: 100 },
  { key: "levels", label: "每晚最多抽检几条定级", hint: "0 关闭", max: 100 },
] as const;
function saveAudit(change: Record<string, unknown>) {
  return saveConfig({ quality: { ...config.value.quality, audit: { ...config.value.quality.audit, ...change } } });
}
function auditNumber(event: Event, key: string, max: number, percentage = false) {
  const input = event.target as HTMLInputElement;
  const value = Number(input.value);
  if (!input.value || !Number.isFinite(value) || value < (percentage || key === "levels" ? 0 : 1) || value > max || (!percentage && !Number.isInteger(value))) {
    input.value = String(config.value.quality.audit[key] * (percentage ? 100 : 1));
    toast("请输入范围内的数字", "error");
    return;
  }
  void saveAudit({ [key]: percentage ? value / 100 : value });
}
</script>

<template>
  <Skeleton v-if="!config" :rows="5" />
  <div v-else class="stack">
    <SetCard v-if="config.quality?.audit" id="set-audit" title="每晚抽检">
      <template #help>助手在整理材料、修正页面时自己写的页面没有人逐页看；每晚抽几页由核对角色对照原件和代码看一遍，有事实问题的交回修改。某一类运行写的页面准确率掉到门槛以下，就改成它写的每一页都看，直到恢复。核对角色用的模型在 Agent 页给 wiki-checker 选，最好和写作的不是同一个。</template>
      <template #aside><RouterLink class="small" to="/quality">查看抽检结果</RouterLink></template>
      <SetRow label="启用每晚抽检">
        <UiCheckbox :model-value="config.quality.audit.enabled" switch aria-label="启用每晚抽检" @change="(v) => saveAudit({ enabled: v })" />
      </SetRow>
      <SetRow v-for="f in auditFields" :key="f.key" :label="f.label" :hint="f.hint" :off="!config.quality.audit.enabled">
        <input class="input set-num" type="number" :min="f.key === 'levels' ? 0 : 1" :max="f.max" step="1" :aria-label="f.label" :value="config.quality.audit[f.key]" @change="auditNumber($event, f.key, f.max)" />
      </SetRow>
      <SetRow label="低于多少算不合格" hint="准确率，%" :off="!config.quality.audit.enabled">
        <input class="input set-num" type="number" min="0" max="100" aria-label="低于多少算不合格（%）" :value="config.quality.audit.threshold * 100" @change="auditNumber($event, 'threshold', 100, true)" />
      </SetRow>
      <SetRow label="抽检后交回修改" :off="!config.quality.audit.enabled">
        <UiSegmented :model-value="config.quality.audit.fix" size="sm" aria-label="抽检后交回修改" :options="[{ value: 'off', label: '不交回' }, { value: 'wrong', label: '有事实问题的' }, { value: 'all', label: '写法问题也交回' }]" @change="(v) => saveAudit({ fix: v })" />
      </SetRow>
    </SetCard>
    <ReplaySettings v-if="config.replay" id="set-replay" :value="config.replay" :backends="profileOptions" :model-options="modelOptionsFor" @save="(replay, note) => saveConfig({ replay }, note)" />
  </div>
</template>
