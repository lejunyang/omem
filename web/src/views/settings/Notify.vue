<script setup lang="ts">
import { computed } from "vue";
import { state } from "../../store";
import { useSettings } from "./ctx";
import NotificationSettings from "../../components/NotificationSettings.vue";
import NotifyOutlets from "../../components/NotifyOutlets.vue";
import SetCard from "../../components/SetCard.vue";
import SetRow from "../../components/SetRow.vue";
import Skeleton from "../../components/Skeleton.vue";
import UiSegmented from "../../components/UiSegmented.vue";

/** 设置 → 助手 → 通知与打扰: when notifications go out, and how much of the agents' work shows in Feishu. */
const { config, load, saveConfig } = useSettings();
const owner = computed(() => !state.me || state.me.role === "owner");
/** agents.progress: what reaches Feishu while agents work (process messages, thinking bubbles). */
async function saveProgress(patch: { messages?: string; thinking?: string }) {
  const cur = config.value.agents?.progress ?? { messages: "milestones", thinking: "own" };
  const next = { ...cur, ...patch };
  await saveConfig({ agents: { ...config.value.agents, progress: next } }, patch.messages
    ? next.messages === "all" ? "多 Agent 工作的每轮回复都发到话题" : "多 Agent 工作只在完成和卡住时发消息"
    : `思考气泡：${({ all: "全部显示", own: "只在回答你的消息时显示", off: "关闭" } as Record<string, string>)[next.thinking]}`);
  void load();
}
</script>

<template>
  <Skeleton v-if="!config" :rows="5" />
  <div v-else class="stack">
    <NotificationSettings v-if="config.notify" :keys="['notify']" :config="config" :save="saveConfig" />
    <NotifyOutlets />
    <SetCard id="set-progress" title="过程消息" :keys="['agents.progress']">
      <template #help>Agent 干活时飞书里能看到多少过程。过程都留在网页的运行页和工作会话里，这里只决定发不发到飞书。</template>
      <SetRow label="多 Agent 工作的话题里">
        <template #hint>{{ (config.agents?.progress?.messages ?? 'milestones') === 'all' ? "主助手每轮看完报告的回复都发出来" : "只有一张原地更新的进度卡；做完、要你决定、卡住或回答你时才发消息" }}</template>
        <UiSegmented :model-value="config.agents?.progress?.messages ?? 'milestones'" size="sm" aria-label="多 Agent 工作的过程消息" :options="[{ value: 'milestones', label: '完成和卡住时' }, { value: 'all', label: '全部发' }]" @change="(v) => saveProgress({ messages: v })" />
      </SetRow>
      <SetRow label="思考气泡">
        <template #hint>{{ (config.agents?.progress?.thinking ?? 'own') === 'own' ? "回答你自己发的消息时显示；交办、唤醒、规则触发的运行不显示" : (config.agents?.progress?.thinking === 'all' ? "所有运行都显示" : "都不显示") }}</template>
        <UiSegmented :model-value="config.agents?.progress?.thinking ?? 'own'" size="sm" aria-label="思考气泡" :options="[{ value: 'own', label: '只在回答我时' }, { value: 'all', label: '全部' }, { value: 'off', label: '关' }]" @change="(v) => saveProgress({ thinking: v })" />
      </SetRow>
    </SetCard>
    <div v-if="owner" class="card set-link">
      <span class="grow">提醒有没有用：发了多少、处理了多少、哪些会话总是没人看</span>
      <RouterLink to="/insights?tab=omem">在数据页看</RouterLink>
    </div>
  </div>
</template>

<style scoped>
.grow {
  flex: 1;
  min-width: 0;
}
</style>
