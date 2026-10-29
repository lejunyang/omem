<script setup lang="ts">
/**
 * What a run sent its agents and how much context they carried, per agent (the coder, each review
 * check, the lead…): from the `prompt` events (how the standing instructions went, their parts) and
 * the backend's `usage` reports (context held at each model call).
 */
import { computed } from "vue";
import type { RunEvent } from "../api";

const props = defineProps<{ events: RunEvent[] }>();

type Parts = { common: number; role: number; environment: number; lessons: number; lessonCount: number; skills: number };
type Row = { key: string; turns: number; via: string[]; instructions: number; parts?: Parts; message: number; calls: number; start: number; peak: number; total: number; size: number };

const LABEL: Record<string, string> = { coder: "编码", lead: "评审负责人", reviewer: "独立评审", "review-business": "业务评审", "review-arch": "架构评审", "review-history": "历史评审", "review-style": "规范评审", split: "需求拆分", agent: "Agent" };
const VIA: Record<string, string> = { system: "作为系统提示", message: "放在第一条消息", resumed: "接上会话，没再发", none: "没有说明" };

const rows = computed(() => {
  const map = new Map<string, Row & { last: number }>();
  const at = (d: { check?: string; phase?: string }) => {
    const key = d.check ?? d.phase ?? "agent";
    let r = map.get(key);
    if (!r) map.set(key, (r = { key, turns: 0, via: [], instructions: 0, message: 0, calls: 0, start: 0, peak: 0, total: 0, size: 0, last: -1 }));
    return r;
  };
  for (const e of props.events) {
    if (e.type === "prompt") {
      const r = at(e.data);
      r.turns++;
      r.message += e.data.message ?? 0;
      if (!r.via.includes(e.data.via)) r.via.push(e.data.via);
      if (e.data.via !== "resumed" && e.data.instructions) { r.instructions = e.data.instructions; r.parts = e.data.parts ?? r.parts; }
    } else if (e.type === "usage" && Number.isFinite(e.data.used)) {
      const r = at(e.data);
      // Some backends repeat the same report; one model call is one new figure.
      if (e.data.used === r.last) continue;
      r.last = e.data.used;
      if (!r.calls) r.start = e.data.used;
      r.calls++;
      r.peak = Math.max(r.peak, e.data.used);
      r.total += e.data.used;
      r.size = e.data.size ?? r.size;
    }
  }
  return [...map.values()];
});

const total = computed(() => rows.value.reduce((a, r) => ({ calls: a.calls + r.calls, tokens: a.tokens + r.total }), { calls: 0, tokens: 0 }));

const tok = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : String(n));
const chars = (n: number) => (n >= 10000 ? `${(n / 1000).toFixed(1)}K 字` : `${n} 字`);
const partsText = (p: Parts) =>
  [`共同约定 ${chars(p.common)}`, `角色 ${chars(p.role)}`, `环境 ${chars(p.environment)}`, p.lessonCount ? `偏好与经验 ${p.lessonCount} 条 ${chars(p.lessons)}` : "", p.skills ? `技能目录 ${chars(p.skills)}` : ""].filter(Boolean).join(" · ");
</script>

<template>
  <details v-if="rows.length" class="card pad block usage">
    <summary class="section-title">
      上下文<span class="muted small">{{ total.calls ? ` · 模型调用 ${total.calls} 次，累计读入约 ${tok(total.tokens)} token` : "" }}</span>
    </summary>
    <p class="muted small">每次模型调用都要读一遍当时的整个上下文，累计读入约等于各次调用的上下文之和（大部分命中缓存）。</p>
    <div v-for="r in rows" :key="r.key" class="row-block">
      <div class="head">
        <b>{{ LABEL[r.key] ?? r.key }}</b>
        <span v-if="r.calls" class="muted small">调用 {{ r.calls }} 次 · 上下文 {{ tok(r.start) }} → 峰值 {{ tok(r.peak) }}{{ r.size ? ` / ${tok(r.size)}` : "" }} · 累计 {{ tok(r.total) }}</span>
      </div>
      <div v-if="r.turns" class="muted small">
        说明：{{ r.via.map((v) => VIA[v] ?? v).join("、") }}<template v-if="r.instructions">，{{ chars(r.instructions) }}</template>；发出的消息 {{ r.turns }} 条共 {{ chars(r.message) }}
      </div>
      <div v-if="r.parts" class="muted small parts">{{ partsText(r.parts) }}</div>
    </div>
  </details>
</template>

<style scoped>
.usage summary {
  cursor: pointer;
  list-style: none;
  display: flex;
  gap: 6px;
  align-items: baseline;
  flex-wrap: wrap;
}
.usage summary::-webkit-details-marker {
  display: none;
}
.usage[open] summary {
  margin-bottom: 8px;
}
.row-block {
  display: grid;
  gap: 2px;
  padding: 8px 0;
  border-top: 1px solid var(--line);
  min-width: 0;
}
.head {
  display: flex;
  gap: 8px;
  align-items: baseline;
  flex-wrap: wrap;
}
.parts {
  overflow-wrap: anywhere;
}
</style>
