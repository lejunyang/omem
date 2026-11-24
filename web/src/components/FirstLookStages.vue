<script setup lang="ts">
import { computed } from "vue";
import { aiText, DEST_TEXT, msText, OUTCOME_TEXT, type FirstLookStages, type ProbeStage } from "../lib/first-look";

/**
 * A first-look run's layers (output.stages, src/rules/first-look.ts), one row each: the 关注's prefilter,
 * the probes (each with how it went and its own run), the fast look (its outcome, who gave it, on what AI),
 * the decision model's second opinion, where the first message went (and why it went elsewhere), and the
 * deeper run it handed to. How long each took sits at the row's end. A layer that did not happen is left out.
 */
const props = defineProps<{ stages: FirstLookStages; outcome?: string }>();
const s = computed(() => props.stages);
const probeWord = (p: ProbeStage) => (p.skipped ? "跳过" : p.ok ? "完成" : p.timedOut ? "超时" : "失败");
const BY: Record<string, string> = { model: "快模型", host: "宿主兜底（没交结论按要接着查）", probe: "预查直接给的" };
const tone = (o?: string) => (o === "answered" ? "ok" : o === "owner" ? "warn" : "accent");
const decisionLine = computed(() => {
  const d = s.value.decision;
  if (!d) return "";
  if (d.skipped) return d.skipped;
  const p = d.probabilities ? Object.entries(d.probabilities).map(([k, v]) => `${k} ${Number(v).toFixed(2)}`).join("，") : "";
  return [d.said, d.threshold !== undefined ? `门槛 ${d.threshold}` : "", p].filter(Boolean).join(" · ");
});
</script>

<template>
  <ol class="stages" aria-label="先看一眼的各层">
    <li v-if="s.prefilter">
      <span class="dot" />
      <span class="what"><strong>预筛</strong><span class="muted">{{ s.prefilter }}</span></span>
    </li>
    <li v-if="s.probes">
      <span class="dot" :class="s.probes.results.some((p) => !p.ok && !p.skipped) ? 'warn' : 'ok'" />
      <span class="what">
        <strong>预查</strong>
        <span v-if="!s.probes.results.length" class="muted">没有选预查</span>
        <span v-for="p in s.probes.results" :key="p.name" class="probe">
          <router-link v-if="p.runId" :to="`/runs/${p.runId}`" class="mono">{{ p.name }}</router-link><span v-else class="mono">{{ p.name }}</span>
          <span :class="{ bad: !p.ok && !p.skipped }">{{ probeWord(p) }}</span><span v-if="p.skipped" class="muted">：{{ p.skipped }}</span>
          <span v-if="!p.skipped" class="muted">{{ msText(p.ms) }}</span>
        </span>
      </span>
      <span class="ms">{{ msText(s.probes.ms) }}</span>
    </li>
    <li v-if="s.look">
      <span class="dot" :class="tone(s.look.outcome)" />
      <span class="what">
        <strong>先看一眼</strong>
        <span><span class="out" :class="tone(s.look.outcome)">{{ OUTCOME_TEXT[s.look.outcome] ?? s.look.outcome }}</span> · {{ BY[s.look.by] ?? s.look.by }}<template v-if="aiText(s.look.ai)"> · <span class="muted">{{ aiText(s.look.ai) }}</span></template></span>
        <span v-if="s.look.reason" class="muted">{{ s.look.reason }}</span>
      </span>
      <span class="ms">{{ msText(s.look.ms) }}</span>
    </li>
    <li v-if="s.decision">
      <span class="dot" :class="s.decision.skipped ? '' : s.decision.taken === 'yes' ? 'ok' : 'accent'" />
      <span class="what"><strong>决策模型复核</strong><span class="muted">{{ decisionLine }}</span></span>
    </li>
    <li v-if="s.first">
      <span class="dot" :class="s.first.to === 'none' ? 'warn' : 'ok'" />
      <span class="what">
        <strong>第一条</strong>
        <span>{{ DEST_TEXT[s.first.to] ?? s.first.to }}</span>
        <span v-if="s.first.why?.length" class="muted">{{ s.first.why.join("；") }}</span>
      </span>
    </li>
    <li v-if="s.deep">
      <span class="dot accent" />
      <span class="what">
        <strong>深查</strong>
        <router-link v-if="s.deep.runId" :to="`/runs/${s.deep.runId}`">看深查的运行</router-link>
        <span v-if="s.deep.detail" class="muted">{{ s.deep.detail }}</span>
      </span>
    </li>
    <li v-else-if="outcome === 'escalate' && s.first" class="pending">
      <span class="dot" />
      <span class="what"><strong>深查</strong><span class="muted">还没开始，或这一次没有可交的深查</span></span>
    </li>
  </ol>
</template>

<style scoped>
.stages {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  min-width: 0;
}
li {
  display: grid;
  grid-template-columns: 10px minmax(0, 1fr) auto;
  gap: 10px;
  align-items: baseline;
  padding: 8px 0;
  border-top: 1px solid var(--line);
  font-size: 13.5px;
  line-height: 1.55;
}
li:first-child {
  border-top: 0;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  border: 2px solid var(--muted);
  align-self: center;
}
.dot.ok {
  border-color: var(--ok);
  background: var(--ok);
}
.dot.warn {
  border-color: var(--warn);
}
.dot.accent {
  border-color: var(--accent);
}
.what {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 10px;
  min-width: 0;
  overflow-wrap: anywhere;
}
.what strong {
  font-weight: 600;
  min-width: 6em;
}
.probe {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 0 6px;
}
.mono {
  font-family: var(--mono);
  font-size: 12.5px;
}
.bad {
  color: var(--danger);
}
.out.ok {
  color: var(--ok);
}
.out.warn {
  color: var(--warn);
}
.out.accent {
  color: var(--accent);
}
.ms {
  font-size: 12px;
  color: var(--muted);
  white-space: nowrap;
}
</style>
