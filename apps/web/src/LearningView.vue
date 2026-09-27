<script setup lang="ts">
import { ref } from "vue";
import { OmBadge, OmButton, OmCitation, OmEmpty, OmPanel } from "@omem/ui";
import { api, type Job, type Proposal } from "./api";

const props = defineProps<{ jobs: Job[]; proposals: Proposal[] }>();
const emit = defineEmits<{
  refresh: [];
  open: [id: string];
  error: [text: string];
}>();
const details = ref<Record<string, Job>>({});
const busy = ref("");

const stateText: Record<string, string> = {
  queued: "等待处理",
  leased: "已领取",
  running: "正在学习",
  succeeded: "处理完成",
  skipped: "已跳过",
  awaiting_decision: "等待判断",
  retry_wait: "等待重试",
  failed: "处理失败",
  cancelled: "已取消",
  proposed: "候选",
  validating: "核验中",
  rejected: "已拒绝",
  approved: "已批准",
  applied: "已生效",
  stale: "已过期",
};
const tone = (state: string) =>
  ["failed", "rejected", "stale"].includes(state)
    ? "danger"
    : ["awaiting_decision", "retry_wait", "queued"].includes(state)
      ? "warning"
      : ["succeeded", "applied", "approved"].includes(state)
        ? "success"
        : "neutral";
const jobProposals = (job: Job) =>
  props.proposals.filter((proposal) => proposal.origin.job_id === job.id);

async function load(job: Job) {
  try {
    details.value[job.id] = await api<Job>(`/jobs/${job.id}`);
  } catch (error) {
    emit("error", String(error));
  }
}
async function control(job: Job, action: "cancel" | "retry") {
  busy.value = job.id;
  try {
    await api(`/jobs/${job.id}/${action}`, {
      expectedGeneration: job.generation,
      requestId: crypto.randomUUID(),
    });
    emit("refresh");
  } catch (error) {
    emit("error", String(error));
  } finally {
    busy.value = "";
  }
}
</script>

<template>
  <section class="page learning-page">
    <span class="eyebrow">材料进入后，每一步都保留状态</span>
    <h1>学习流程</h1>
    <p class="muted">
      这里显示真实持久任务、模型尝试和提案结果。等待 worker
      的任务保持“等待处理”，失败不会显示为完成。
    </p>
    <OmPanel v-for="job in jobs" :key="job.id" class="stack">
      <template #heading>
        <div class="panel-heading">
          <div>
            <small>{{ job.kind }} · {{ job.roleVersion }}</small>
            <h3>学习任务 {{ job.id.slice(0, 8) }}</h3>
          </div>
          <OmBadge :tone="tone(job.state)">{{
            stateText[job.state] || job.state
          }}</OmBadge>
        </div>
      </template>
      <div
        class="status-track"
        :aria-label="`任务状态：${stateText[job.state] || job.state}`"
      >
        <span class="done">材料已保存</span
        ><span :class="{ done: job.attempt > 0 }">提炼与核验</span
        ><span :class="{ done: jobProposals(job).length > 0 }">形成提案</span
        ><span
          :class="{
            done: jobProposals(job).some((p) => p.state === 'applied'),
          }"
          >应用并通知</span
        >
      </div>
      <p v-if="job.lastError" class="inline-error">
        {{ job.errorKind || "error" }}：{{ job.lastError }}
      </p>
      <small>
        第 {{ job.generation }} 代 · {{ job.attempt }} 次尝试 · 更新于
        {{ new Date(job.updatedAt).toLocaleString("zh-CN") }}
      </small>
      <details
        @toggle="($event.currentTarget as HTMLDetailsElement).open && load(job)"
      >
        <summary>运行详情与尝试记录</summary>
        <p v-if="!details[job.id]" class="muted">正在读取…</p>
        <div
          v-for="attempt in details[job.id]?.attempts || []"
          :key="attempt.id"
          class="attempt-row"
        >
          <b>第 {{ attempt.attempt }} 次</b>
          <span
            >{{ attempt.model || "模型未知" }} /
            {{ attempt.effort || "effort 未提供" }}</span
          >
          <span>{{ attempt.outcome || "进行中" }}</span>
          <small v-if="attempt.error"
            >{{ attempt.errorKind }}：{{ attempt.error }}</small
          >
        </div>
        <p
          v-if="details[job.id] && !details[job.id]?.attempts?.length"
          class="muted"
        >
          尚未产生模型尝试；这不是处理成功。
        </p>
      </details>
      <OmPanel
        v-for="proposal in jobProposals(job)"
        :key="proposal.id"
        class="proposal-card"
        :title="
          String(
            proposal.body.title || proposal.body.statement || proposal.kind,
          )
        "
      >
        <div class="row">
          <OmBadge :tone="tone(proposal.state)">{{
            stateText[proposal.state] || proposal.state
          }}</OmBadge>
          <small
            >{{ proposal.operation }} · 影响
            {{ proposal.impactCount }} 项</small
          >
        </div>
        <p>{{ proposal.reason }}</p>
        <p v-if="proposal.policyResult?.reasons.length" class="muted">
          策略原因：{{ proposal.policyResult.reasons.join("、") }}
        </p>
        <div class="row">
          <OmCitation
            v-for="(item, index) in proposal.evidence"
            :key="item.fragment_revision_id"
            :label="`查看原证据 ${index + 1}`"
            @open="emit('open', item.fragment_revision_id)"
          />
        </div>
      </OmPanel>
      <template #actions>
        <OmButton
          v-if="
            [
              'queued',
              'leased',
              'running',
              'retry_wait',
              'awaiting_decision',
            ].includes(job.state)
          "
          :loading="busy === job.id"
          @click="control(job, 'cancel')"
          >取消任务</OmButton
        >
        <OmButton
          v-if="['failed', 'cancelled'].includes(job.state)"
          :loading="busy === job.id"
          @click="control(job, 'retry')"
          >重新处理</OmButton
        >
      </template>
    </OmPanel>
    <OmEmpty
      v-if="!jobs.length"
      title="尚无学习任务"
      description="输入一份材料后，证据和首个学习任务会在同一事务中保存。"
    />
  </section>
</template>

<style scoped>
.panel-heading {
  display: flex;
  width: 100%;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.panel-heading h3 {
  margin: 4px 0 0;
}
.status-track {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  border: 1px solid var(--om-line);
  border-radius: 6px;
  overflow: hidden;
  margin: 18px 0;
}
.status-track span {
  min-height: 44px;
  padding: 12px 10px;
  color: var(--om-muted);
  border-right: 1px solid var(--om-line);
  font-size: 12px;
}
.status-track span:last-child {
  border: 0;
}
.status-track .done {
  background: #292929;
  color: white;
}
.attempt-row {
  display: grid;
  grid-template-columns: 90px 1fr auto;
  gap: 12px;
  padding: 10px 0;
  border-top: 1px solid var(--om-line);
  font-size: 12px;
}
.attempt-row small {
  grid-column: 1 / -1;
  color: var(--om-danger);
}
.proposal-card {
  margin-top: 14px;
  background: var(--om-soft);
}
.inline-error {
  color: var(--om-danger);
  overflow-wrap: anywhere;
}
@media (max-width: 700px) {
  .status-track {
    grid-template-columns: 1fr 1fr;
  }
  .status-track span:nth-child(2) {
    border-right: 0;
  }
  .status-track span:nth-child(-n + 2) {
    border-bottom: 1px solid var(--om-line);
  }
  .attempt-row {
    grid-template-columns: 1fr;
  }
}
</style>
