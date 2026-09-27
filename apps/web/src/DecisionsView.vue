<script setup lang="ts">
import { ref } from "vue";
import { OmBadge, OmButton, OmCitation, OmEmpty, OmPanel } from "@omem/ui";
import { api, type Decision } from "./api";

defineProps<{ decisions: Decision[] }>();
const emit = defineEmits<{
  refresh: [];
  open: [id: string];
  error: [text: string];
  notice: [text: string];
}>();
const busy = ref("");
const stateLabel: Record<string, string> = {
  pending: "等待你的判断",
  approved: "已确认",
  rejected: "已拒绝",
  context_requested: "已要求补充背景",
  expired: "已过期",
  stale: "来源已变化，旧判断失效",
};
const title = (decision: Decision) =>
  String(
    decision.proposal.body.title ||
      decision.proposal.body.statement ||
      decision.proposal.kind,
  );
async function decide(
  decision: Decision,
  action: "approve" | "reject" | "request_context",
) {
  busy.value = decision.id + action;
  try {
    await api(`/decisions/${decision.id}`, {
      action,
      proposalDigest: decision.proposalDigest,
      requestId: crypto.randomUUID(),
      actorId: decision.actorId,
    });
    emit(
      "notice",
      action === "approve"
        ? "提案已确认并生成独立回执"
        : action === "reject"
          ? "提案已拒绝并生成独立回执"
          : "已记录补充背景请求",
    );
    emit("refresh");
  } catch (error) {
    emit("error", String(error));
    emit("refresh");
  } finally {
    busy.value = "";
  }
}
</script>

<template>
  <section class="page decisions-page">
    <span class="eyebrow">只把歧义、冲突和较大影响交给你</span>
    <h1>待判断</h1>
    <p class="muted">
      每个动作都有独立 request receipt；来源变化或判断过期后不会沿用旧批准。
    </p>
    <OmPanel
      v-for="decision in decisions"
      :key="decision.id"
      class="stack"
      :title="title(decision)"
    >
      <div class="row">
        <OmBadge
          :tone="
            decision.state === 'pending'
              ? 'warning'
              : decision.state === 'approved'
                ? 'success'
                : ['stale', 'expired'].includes(decision.state)
                  ? 'danger'
                  : 'neutral'
          "
        >
          {{ stateLabel[decision.state] || decision.state }}
        </OmBadge>
        <small
          >有效至
          {{ new Date(decision.expiresAt).toLocaleString("zh-CN") }}</small
        >
        <small v-if="decision.requestId" class="receipt-id"
          >处理回执 {{ decision.requestId }}</small
        >
      </div>
      <p>{{ decision.proposal.reason }}</p>
      <details open>
        <summary>查看具体变化</summary>
        <div class="diff-grid">
          <div>
            <small>动作</small><b>{{ decision.proposal.operation }}</b>
          </div>
          <div>
            <small>对象</small><b>{{ decision.proposal.kind }}</b>
          </div>
          <div>
            <small>影响范围</small><b>{{ decision.proposal.impactCount }} 项</b>
          </div>
        </div>
        <pre>{{ JSON.stringify(decision.proposal.body, null, 2) }}</pre>
        <p v-if="decision.proposal.uncertainties.length" class="inline-warning">
          尚不确定：{{ decision.proposal.uncertainties.join("、") }}
        </p>
      </details>
      <div class="evidence-list">
        <OmCitation
          v-for="(item, index) in decision.proposal.evidence"
          :key="item.fragment_revision_id"
          :label="`依据 ${index + 1}${item.exact_quote ? `：${item.exact_quote.slice(0, 36)}` : ''}`"
          @open="emit('open', item.fragment_revision_id)"
        />
      </div>
      <p v-if="decision.state === 'stale'" class="inline-error" role="alert">
        原件已更新，这个判断不能再提交。请等待基于新版本重新核验。
      </p>
      <template v-if="decision.state === 'pending'" #actions>
        <OmButton
          :loading="busy === decision.id + 'request_context'"
          @click="decide(decision, 'request_context')"
          >补充背景</OmButton
        >
        <OmButton
          :loading="busy === decision.id + 'reject'"
          @click="decide(decision, 'reject')"
          >拒绝</OmButton
        >
        <OmButton
          variant="primary"
          :loading="busy === decision.id + 'approve'"
          @click="decide(decision, 'approve')"
          >确认并应用</OmButton
        >
      </template>
    </OmPanel>
    <OmEmpty
      v-if="!decisions.length"
      title="没有需要判断的变化"
      description="高置信小范围变化会自动生效，其余会连同 diff 和原证据出现在这里。"
    />
  </section>
</template>

<style scoped>
.diff-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
  margin: 4px 0 12px;
}
.diff-grid div {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 12px;
  background: var(--om-soft);
  border-radius: 5px;
}
pre {
  max-width: 100%;
  overflow: auto;
  padding: 14px;
  background: #222;
  color: #eee;
  border-radius: 6px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.evidence-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 16px;
}
.inline-warning {
  color: #7a5900;
}
.inline-error {
  color: var(--om-danger);
}
.receipt-id {
  max-width: 100%;
  overflow-wrap: anywhere;
}
@media (max-width: 700px) {
  .diff-grid {
    grid-template-columns: 1fr;
  }
}
</style>
