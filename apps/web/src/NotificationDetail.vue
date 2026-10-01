<script setup lang="ts">
import ChangeComparison from "./ChangeComparison.vue";
import { OmBadge, OmButton, OmCitation, OmDialog, OmEmpty } from "@omem/ui";
import type { NotificationDetail } from "./api";

defineProps<{
  open: boolean;
  detail: NotificationDetail | null;
  loading: boolean;
}>();
const emit = defineEmits<{
  close: [];
  openEvidence: [id: string];
  openRevision: [id: string];
}>();
const tone = (state: string, supersededBy?: string | null) =>
  state === "cancelled" && supersededBy
    ? "neutral"
    : ["failed", "unknown", "cancelled"].includes(state)
      ? "danger"
      : ["pending", "sending", "retry_wait"].includes(state)
        ? "warning"
        : state === "delivered"
          ? "success"
          : "neutral";
</script>

<template>
  <OmDialog
    :open="open"
    title="通知与变化详情"
    @close="emit('close')"
    @back="emit('close')"
  >
    <p v-if="loading" class="muted">正在读取持久状态…</p>
    <template v-else-if="detail">
      <div class="row">
        <OmBadge>{{ ({knowledge:"知识更新",capture:"材料更新",task:"事项",decision:"需要判断"} as Record<string,string>)[detail.changeKind || ""] || "通知" }}</OmBadge>
        <small>{{ new Date(detail.createdAt).toLocaleString("zh-CN") }}</small>
      </div>
      <h3>{{ detail.title }}</h3>
      <p>{{ detail.changeKind === "capture" ? "原始材料已保存，可在下方查看本次内容变化。" : detail.changeKind === "knowledge" && !detail.afterId ? "旧版知识整理通知，当时未记录可比较的正文版本。新产生的更新会提供章节变化和内容差异。" : detail.body }}</p><p class="muted">已读仅表示你看过这条消息，不改变待办或判断结果。</p>
      <p v-if="detail.receipt" class="muted">已更新{{ ({task:'事项',claim:'事实记忆',episode:'经历',procedure:'流程'} as Record<string,string>)[detail.receipt.entityType] || '记忆' }} · 第 {{ detail.receipt.entityVersion }} 版</p>
      <section v-if="detail.changeId && detail.afterId && ['knowledge','capture','restore'].includes(detail.changeKind || '')" class="detail-block">
        <h4>本次改动</h4><ChangeComparison :change-id="detail.changeId" />
        <OmButton v-if="detail.changeKind !== 'knowledge'" @click="emit('openRevision', detail.afterId)">阅读此版本</OmButton>
      </section>
      <p v-else-if="detail.details && detail.details !== detail.body">{{ detail.details }}</p>
      <section v-if="detail.evidenceIds.length" class="detail-block">
        <h4>原始证据</h4>
        <div class="evidence-list">
          <OmCitation
            v-for="(id, index) in detail.evidenceIds"
            :key="id"
            :label="`查看原证据 ${index + 1}`"
            @open="emit('openEvidence', id)"
          />
        </div>
        <OmEmpty
          v-if="!detail.evidenceIds.length"
          title="本条变化没有提案证据"
        />
      </section>
      <section v-if="detail.deliveries.length" class="detail-block">
        <h4>外部提醒发送情况</h4>
        <div
          v-for="delivery in detail.deliveries"
          :key="delivery.id"
          class="delivery-row"
        >
          <div>
            <b>{{ delivery.channel }}</b>
            <small>尝试 {{ delivery.attemptCount }} 次</small>
          </div>
          <OmBadge :tone="tone(delivery.state, delivery.supersededBy)">{{
            delivery.supersededBy ? "已合并" : ({pending:"等待发送",sending:"正在发送",retry_wait:"等待重试",delivered:"已发送",failed:"发送失败",cancelled:"已取消",unknown:"发送结果待确认"} as Record<string,string>)[delivery.state] || delivery.state
          }}</OmBadge>
          <p v-if="delivery.changeCount > 1" class="batch-count">
            该次摘要包含 {{ delivery.changeCount }} 条变化
          </p>
          <p v-if="delivery.lastError && !delivery.supersededBy" role="alert">
            {{ delivery.errorKind }}：{{ delivery.lastError }}
          </p>
        </div>
        <OmEmpty v-if="!detail.deliveries.length" title="没有外部投递" />
      </section>
    </template>
  </OmDialog>
</template>

<style scoped>
.detail-block {
  border-top: 1px solid var(--om-line);
  padding-top: 16px;
  margin-top: 20px;
}
.evidence-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.delivery-row {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 8px;
  align-items: center;
  padding: 12px 0;
  border-bottom: 1px solid var(--om-line);
}
.delivery-row div {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.delivery-row p {
  grid-column: 1 / -1;
  margin: 0;
  color: var(--om-danger);
  overflow-wrap: anywhere;
}
.delivery-row .batch-count {
  color: var(--om-muted);
}
</style>
