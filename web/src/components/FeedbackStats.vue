<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { get } from "../api";
import { relTime } from "../store";
import Skeleton from "./Skeleton.vue";
import UiSegmented from "./UiSegmented.vue";

/**
 * Emoji reactions on what the Feishu bots sent, by profile/role and by model (src/channels/lark-feedback.ts).
 * The owner's count by default; other users' and guests' are shown apart. Acknowledgements
 * (OK, DONE, +1…) mean "received" and are listed separately, not as good or bad.
 */
type Counts = { positive: number; negative: number; ack: number; neutral: number };
type Row = { key: string; owner: Counts; others: Counts; guests: Counts };
type Stats = { days: number; total: Row; byProfile: Row[]; byModel: Row[]; lastReactionAt: string | null; botMessages: number };

const stats = ref<Stats | null>(null);
const by = ref<"profile" | "model">("profile");
const who = ref<"owner" | "others" | "guests">("owner");
const failed = ref("");
onMounted(async () => {
  try {
    stats.value = await get<Stats>("/api/feedback/stats?days=30");
  } catch (e) {
    failed.value = (e as Error).message;
  }
});
const rows = computed(() => (stats.value ? (by.value === "profile" ? stats.value.byProfile : stats.value.byModel) : []).filter((r) => {
  const c = r[who.value];
  return c.positive + c.negative + c.ack + c.neutral > 0;
}));
const rate = (c: Counts) => (c.positive + c.negative ? Math.round((c.positive / (c.positive + c.negative)) * 100) : null);
</script>

<template>
  <section class="fb">
    <div class="fb-head">
      <h3>飞书里的表情反馈 <span class="muted small">近 30 天</span></h3>
      <span class="spacer" />
      <UiSegmented v-model="who" size="sm" aria-label="谁的表情" :options="[{ value: 'owner', label: '本人' }, { value: 'others', label: '其他用户' }, { value: 'guests', label: '访客' }]" />
      <UiSegmented v-model="by" size="sm" aria-label="分组" :options="[{ value: 'profile', label: '按档案' }, { value: 'model', label: '按模型' }]" />
    </div>
    <Skeleton v-if="!stats && !failed" :rows="3" />
    <p v-else-if="failed" class="muted small">{{ failed }}</p>
    <template v-else-if="stats">
      <p class="muted small">
        机器人近 30 天发了 {{ stats.botMessages }} 条消息<template v-if="stats.lastReactionAt">，最近一次收到表情 {{ relTime(stats.lastReactionAt) }}</template><template v-else>，还没有收到表情事件（设置 → 渠道 → 检查机器人权限与事件）</template>。确认类表情（OK、DONE、+1…）只表示收到，不算好坏。
      </p>
      <div v-for="r in rows" :key="r.key" class="fb-row">
        <span class="name mono ellipsis" :title="r.key">{{ r.key }}</span>
        <span class="counts small">
          <span>正面 <b>{{ r[who].positive }}</b></span>
          <span>负面 <b>{{ r[who].negative }}</b></span>
          <span class="muted">确认 {{ r[who].ack }}</span>
          <span v-if="r[who].neutral" class="muted">其他 {{ r[who].neutral }}</span>
          <span v-if="rate(r[who]) !== null" class="badge" :class="{ accent: rate(r[who])! >= 70, warn: rate(r[who])! < 50 }">好评 {{ rate(r[who]) }}%</span>
        </span>
      </div>
      <p v-if="!rows.length" class="muted small">这段时间没有{{ who === "owner" ? "你" : who === "others" ? "其他用户" : "访客" }}的表情。</p>
    </template>
  </section>
</template>

<style scoped>
.fb {
  text-align: left;
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 12px 14px;
  display: grid;
  gap: 8px;
  min-width: 0;
}
.fb-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.fb-head h3 {
  margin: 0;
  font-size: 14px;
}
.fb-row {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 12px;
  padding: 4px 0;
  border-top: 1px solid var(--line);
  min-width: 0;
}
.name {
  flex: 1 1 160px;
  min-width: 0;
}
.counts {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  align-items: baseline;
}
</style>
