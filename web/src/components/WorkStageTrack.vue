<script setup lang="ts">
import { computed } from "vue";
import { dayLabel, stageTone, type FlowLite } from "../lib/work";
import { duration, stageWords, type StageState } from "../lib/flow";

/**
 * A work item's flow as a stage track (omem-design: a row of thin bars in the flow's order, four
 * colours). `mini` is the bars alone, for a chip; otherwise each bar has its name and a line of small
 * text under it (when it was done, how long it has waited for the owner), wrapping when narrow.
 */
const props = defineProps<{ flow: FlowLite; mini?: boolean }>();
const current = computed(() => props.flow.current?.id ?? null);
const stages = computed(() => props.flow.stages.map((s) => ({ ...s, tone: stageTone(s, current.value) })));
function note(s: (typeof stages.value)[number]) {
  if (s.state === "done") return s.doneAt ? `${dayLabel(s.doneAt)}完成` : "完成";
  if (s.tone === "warn") return s.state === "blocked" ? `卡住${s.enteredAt ? ` · ${duration(s.enteredAt)}` : ""}` : `等你${s.enteredAt ? ` · ${duration(s.enteredAt)}` : ""}`;
  if (s.state === "doing") return s.enteredAt ? `${dayLabel(s.enteredAt)}开始` : "进行中";
  return stageWords[s.state as StageState] ?? s.state;
}
const summary = computed(() => `${props.flow.name}：${stages.value.map((s) => `${s.name}${note(s)}`).join("，")}`);
</script>

<template>
  <span v-if="mini" class="mini" role="img" :aria-label="summary" :title="summary">
    <i v-for="s in stages" :key="s.id" :class="s.tone" />
  </span>
  <ol v-else class="track" :aria-label="`${flow.name}的阶段`">
    <li v-for="s in stages" :key="s.id" :class="[s.tone, { now: s.id === current }]">
      <span class="bar" />
      <span class="name">{{ s.name }}</span>
      <span class="note">{{ note(s) }}</span>
    </li>
  </ol>
</template>

<style scoped>
.mini { display: inline-flex; gap: 2px; align-items: center; flex: none; }
.mini i { width: 12px; height: 4px; border-radius: 2px; background: var(--line-strong); }
.mini i.ok { background: var(--ok); }
.mini i.accent { background: var(--accent); }
.mini i.warn { background: var(--warn); }
.mini i.skip { background: var(--line); }

.track { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 10px 6px; }
.track li { flex: 1 1 96px; min-width: 84px; display: grid; gap: 3px; align-content: start; }
.bar { height: 4px; border-radius: 2px; background: var(--line-strong); }
.ok .bar { background: var(--ok); }
.accent .bar { background: var(--accent); }
.warn .bar { background: var(--warn); }
.skip .bar { background: var(--line); }
.name { font-size: 13px; color: var(--ink-2); overflow-wrap: anywhere; }
.now .name, .warn .name { color: var(--ink); font-weight: 600; }
.note { font-size: 12px; color: var(--muted); }
.warn .note { color: var(--warn); }
</style>
