<script setup lang="ts">
import { ref, computed } from "vue";
import { OmBadge, OmButton, OmCitation, OmEmpty, OmPanel, OmDisclosure } from "@omem/ui";
import { api, type Job, type Proposal, type Source } from "./api";

const props = defineProps<{ jobs: Job[]; proposals: Proposal[]; sources: Source[]; processing: { enabled: boolean; running: boolean } }>();
const emit = defineEmits<{
  refresh: [];
  open: [id: string];
  openRevision: [id: string];
  error: [text: string];
}>();
const details = ref<Record<string, Job>>({});
const busy = ref("");
const filter = ref("active");
const limit = ref(40);
const names: Record<string,string> = { extract_claims: "提炼记忆", verify_proposals: "核验候选记忆", refresh_dependents: "复查受影响记忆", knowledge_analyze: "分析材料", knowledge_synthesize: "整理知识正文" };
const waiting = computed(() => props.jobs.filter(j => j.state === "queued").length);
const filtered = computed(() => props.jobs.filter(j => filter.value === "all" || (filter.value === "queued" ? j.state === "queued" : filter.value === "failed" ? ["failed","retry_wait"].includes(j.state) : j.state !== "queued")));
function title(job: Job) {
  return job.materialTitle || props.sources.find(s => job.inputRefs.some(r => r.sourceId === s.sourceId || r.revisionId === s.id))?.title || names[job.kind] || "材料处理";
}
function outcome(job: Job) {
  const results = jobProposals(job);
  if (job.contextQuestion) return `${job.contextQuestion} 原文已保留，选择归属后会继续提炼记忆。`;
  if (job.state === "queued") return props.processing.enabled ? "已保存原文，等待后台处理。尚未调用模型。" : "自动处理未启用，原文已经保存；此任务还没有调用模型。";
  if (job.state === "succeeded") return results.length ? `形成 ${results.length} 条候选记忆，其中 ${results.filter(p => p.state === "applied").length} 条已应用。` : job.kind === "refresh_dependents" ? "已完成依赖检查；需要重新提炼的材料会进入后续任务。" : "此步骤已结束，没有直接关联的候选记忆。后续核验结果见对应任务。";
  if (job.state === "skipped") return "无需继续处理此任务，原材料仍可阅读与检索。";
  return "处理结果和候选记忆会显示在下方。";
}

const stateText: Record<string, string> = {
  queued: "等待处理",
  leased: "已领取",
  running: "正在处理",
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
    <span class="eyebrow">从原始材料提炼可用记忆</span>
    <h1>材料处理</h1>
    <p class="muted">保存新材料或更新原文后，系统排队提炼事实、经历、流程和待办，再独立核验；明确可靠的结果可写入记忆，需要你判断的内容进入“待判断”。语言学习与记忆卡复习尚未接入。当前最多显示 200 条，优先展示运行中、需处理和已有结果的任务。</p>
    <p role="status">{{ processing.running ? '后台处理服务已启动' : processing.enabled ? '自动处理已启用，当前后台未运行' : '自动处理未启用' }} · {{ waiting }} 个展示中的任务等待处理</p>
    <p v-if="!processing.enabled" class="muted">原文保存与检索仍可使用。启用自动处理需要在服务配置中开启 learning.enabled 并配置可用的 Agent；此页不会自动替你开启模型调用。</p>
    <label>查看任务<select v-model="filter" @change="limit = 40"><option value="active">已开始处理与已有结果</option><option value="failed">失败或等待重试</option><option value="queued">等待处理</option><option value="all">全部</option></select></label>
    <OmPanel v-for="job in filtered.slice(0, limit)" :key="job.id" class="stack">
      <template #heading>
        <div class="panel-heading">
          <div>
            <small>{{ names[job.kind] || "后台处理" }}</small>
            <h3>{{ title(job) }}</h3>
          </div>
          <OmBadge :tone="job.contextQuestion ? 'warning' : tone(job.state)">{{
            job.contextQuestion ? '待补充归属' : stateText[job.state] || job.state
          }}</OmBadge>
        </div>
      </template>
      <p>{{ outcome(job) }}</p>
      <div class="result-actions">
        <OmButton v-if="job.contextQuestion && job.sourceRevisionId" @click="emit('openRevision', job.sourceRevisionId)">选择所属项目或主题</OmButton>
        <OmCitation v-if="job.evidenceId" label="阅读这份原始材料" @open="emit('open', job.evidenceId)" />
      </div>
      <p v-if="job.lastError" class="inline-error">
        {{ job.errorKind || "error" }}：{{ job.lastError }}
      </p>
      <small>
        {{ job.attempt }} 次尝试 · 更新于
        {{ new Date(job.updatedAt).toLocaleString("zh-CN") }}
      </small>
      <OmDisclosure
        @update:open="$event && load(job)"
        title="运行详情与尝试记录"
      >
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
      </OmDisclosure>
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
    <OmButton v-if="filtered.length > limit" @click="limit += 40">显示更多任务</OmButton>
    <OmEmpty
      v-if="!filtered.length"
      title="此范围暂无处理记录"
      description="等待任务可切换上方筛选查看。未开始的任务没有模型结果。"
    />
  </section>
</template>

<style scoped>
.result-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin: 16px 0; }
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
