<script setup lang="ts">
import { computed, ref } from "vue";
import { relTime } from "../store";

/** A page's check records (src/wiki/verify.ts), newest first. */
export type Finding = { quote: string; kind: string; problem: string; basis: string; fix?: string };
export type CheckRecord = {
  runId: string;
  at: string;
  status: "passed" | "open" | "unchecked" | "off";
  rounds: number;
  fixed: number;
  rejected: number;
  restored: number;
  open: Finding[];
  notes: string[];
  history: { round: number; findings: Finding[]; summary?: string }[];
};

const props = defineProps<{ checks: CheckRecord[] }>();
const last = computed(() => props.checks[0]);
const expanded = ref(false);
const KIND: Record<string, string> = { cite: "引用", code: "代码", negative: "否定说法", duplicate: "重复", conflict: "冲突", wording: "写法", length: "篇幅", other: "其他" };
const STATUS: Record<CheckRecord["status"], string> = { passed: "核对通过", open: "有没解决的问题", unchecked: "没有核对完", off: "这个空间关了核对" };
const fixedText = computed(() => {
  const c = last.value;
  const parts = [c.rejected ? `写入时拦下 ${c.rejected} 处` : "", c.fixed ? `核对后改正 ${c.fixed} 处` : "", c.restored ? `补回入口 ${c.restored} 处` : ""].filter(Boolean);
  return parts.join("，");
});
</script>

<template>
  <div v-if="last" class="checks">
    <div class="section-title">核对</div>
    <div class="state" :class="last.status">
      <span>{{ STATUS[last.status] }}</span>
      <span class="muted small">{{ relTime(last.at) }}{{ last.rounds ? ` · ${last.rounds} 轮` : "" }}</span>
    </div>
    <div v-if="fixedText" class="muted small">{{ fixedText }}</div>
    <ul v-if="last.open.length" class="open">
      <li v-for="(f, i) in last.open" :key="i">
        <span class="kind">{{ KIND[f.kind] ?? f.kind }}</span>
        <span>{{ f.problem }}</span>
        <span class="muted small quote">“{{ f.quote }}”</span>
      </li>
    </ul>
    <div v-for="(n, i) in last.notes" :key="`n${i}`" class="muted small note">{{ n }}</div>
    <a v-if="last.history.length" href="#" class="small" @click.prevent="expanded = !expanded">{{ expanded ? "收起" : "每轮的结论" }}</a>
    <div v-if="expanded" class="rounds">
      <div v-for="h in last.history" :key="h.round" class="round">
        <div class="small"><strong>第 {{ h.round }} 轮</strong> · {{ h.findings.length ? `${h.findings.length} 个问题` : "没有问题" }}</div>
        <div v-if="h.summary" class="muted small">{{ h.summary }}</div>
        <div v-for="(f, i) in h.findings" :key="i" class="small finding">
          <span class="kind">{{ KIND[f.kind] ?? f.kind }}</span>{{ f.problem }}
          <div class="muted basis">{{ f.basis }}</div>
        </div>
      </div>
      <router-link :to="`/runs/${last.runId}`" class="small">打开这次运行</router-link>
    </div>
  </div>
</template>

<style scoped>
.checks {
  display: grid;
  gap: 6px;
  min-width: 0;
}
.state {
  display: grid;
  font-size: 12.5px;
}
.state.passed > span:first-child {
  color: var(--ok);
}
.state.open > span:first-child,
.state.unchecked > span:first-child {
  color: var(--warn);
}
.open {
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: 8px;
  font-size: 12.5px;
}
.open li {
  display: grid;
  gap: 2px;
  min-width: 0;
}
.kind {
  display: inline-block;
  font-size: 11px;
  color: var(--warn);
  margin-right: 4px;
}
.quote,
.basis,
.note {
  overflow-wrap: anywhere;
}
.rounds {
  display: grid;
  gap: 10px;
}
.round {
  display: grid;
  gap: 4px;
}
.finding {
  overflow-wrap: anywhere;
}
</style>
