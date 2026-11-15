<script setup lang="ts">
export type Improvement = {
  goal: { name: string; metric_command: string; baseline: number; best: number; target: number | null; direction: string; state: string; stop_reason: string | null; rounds: number; max_rounds: number };
  rounds: { seq: number; note: string; before: number; after: number | null; verdict: string; why: string; revert_commit: string | null }[];
};
defineProps<{ data: Improvement }>();
const states: Record<string, string> = { running: "进行中", done: "完成", stopped: "停止" };
</script>

<template>
  <section class="card pad improvement" data-ask-label="改进目标">
    <div class="row wrap"><strong>改进目标</strong><span>{{ data.goal.name }}</span><span class="badge">{{ states[data.goal.state] }}</span></div>
    <code class="metric small">{{ data.goal.metric_command }}</code>
    <p>基线 {{ data.goal.baseline }} → 最佳 <strong>{{ data.goal.best }}</strong><span v-if="data.goal.target !== null"> · 目标 {{ data.goal.target }}</span><span class="muted small">（{{ data.goal.direction === 'down' ? '越低越好' : '越高越好' }}）</span></p>
    <p class="muted small">已做 {{ data.goal.rounds }} / {{ data.goal.max_rounds }} 轮<span v-if="data.goal.stop_reason"> · {{ data.goal.stop_reason }}</span></p>
    <div v-for="r in data.rounds" :key="r.seq" class="improve-round small">
      <span class="muted">第 {{ r.seq }} 轮</span>
      <div>{{ r.note }}<div class="muted">{{ r.before }} → {{ r.after ?? '未量出' }}</div></div>
      <div><strong>{{ r.verdict === 'kept' ? '留下' : r.verdict === 'nothing' ? '没有提交' : r.revert_commit ? '回退' : '未能回退' }}</strong><div class="muted reason">{{ r.why }}</div></div>
    </div>
  </section>
</template>

<style scoped>
.improvement { display: flex; flex-direction: column; gap: 8px; min-width: 0; overflow-wrap: anywhere; }
.metric { white-space: pre-wrap; overflow-wrap: anywhere; }
.improve-round { display: grid; grid-template-columns: 4em minmax(0, 1fr) minmax(0, 1fr); gap: 10px; border-top: 1px solid var(--line); padding-top: 8px; }
.improve-round > * { min-width: 0; }
.reason { white-space: pre-wrap; }
@media (max-width: 760px) { .improve-round { grid-template-columns: 4em minmax(0, 1fr); } .improve-round > :last-child { grid-column: 2; } }
</style>
