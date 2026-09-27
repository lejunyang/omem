<script setup lang="ts">
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
        <OmBadge>{{ detail.changeKind || "通知" }}</OmBadge>
        <small>{{ new Date(detail.createdAt).toLocaleString("zh-CN") }}</small>
      </div>
      <h3>{{ detail.title }}</h3>
      <p>{{ detail.body }}</p>
      <section class="detail-block">
        <h4>已生效记录</h4>
        <p v-if="detail.receipt">
          {{ detail.receipt.entityType }} · {{ detail.receipt.entityId }} · v{{
            detail.receipt.entityVersion
          }}
        </p>
        <p v-else class="muted">
          此通知没有 application receipt，不会把通知本身当作事实已生效。
        </p>
        <p v-if="detail.details">{{ detail.details }}</p>
        <div class="row">
          <OmButton
            v-if="detail.beforeId"
            @click="emit('openRevision', detail.beforeId)"
            >查看变更前</OmButton
          >
          <OmButton
            v-if="detail.afterId && detail.changeKind !== 'decision'"
            @click="emit('openRevision', detail.afterId)"
            >查看变更后</OmButton
          >
        </div>
      </section>
      <section class="detail-block">
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
      <section class="detail-block">
        <h4>投递状态</h4>
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
            delivery.supersededBy ? "已合并" : delivery.state
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
