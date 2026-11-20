<script setup lang="ts">
/**
 * Metrics on the data page (src/data/metrics.ts, GET /api/metrics). `work`: the numbers the owner's work
 * is watched by — grouped by the work line (or matter) they hang on, with the data-source catalog and the
 * observation plans they come from; `omem`: omem's own daily usage (source `omem`). Each metric shows its
 * latest value, the change against its baseline and a small course; one opened shows its chart, how it is
 * read and where it hangs.
 */
import { computed, onMounted, ref, watch } from "vue";
import type { ChartSpec, MetricItem } from "@omem-ai/plugin-sdk/charts";
import { get } from "../api";
import { fmt } from "../lib/time";
import MetricRow from "./charts/MetricRow.vue";
import Chart from "./charts/Chart.vue";
import Skeleton from "./Skeleton.vue";
import UiSegmented from "./UiSegmented.vue";

type Change = { value: number; base: number | null; rel: number | null; flagged: boolean; good: boolean | null };
type Metric = {
  id: string; name: string; unit: string; source: string; query: string; schedule: string; description: string; direction?: string; status: string;
  baseline?: number; threshold?: number; lastAt: string | null; change: Change | null; spark: number[]; points: number;
  itemId: string | null; itemTitle: string | null; lineId: string | null; lineTitle: string | null;
};
type DataFile = { id: string; title: string; path: string; kind: "catalog" | "plan" | "note"; itemId: string | null; updatedAt: string };

const props = defineProps<{ scope: "work" | "omem"; focus?: string }>();
const metrics = ref<Metric[]>([]);
const files = ref<DataFile[]>([]);
const loading = ref(true);
const open = ref<string | null>(null);
const chart = ref<ChartSpec | null>(null);
const days = ref(30);

async function load() {
  loading.value = true;
  const [all, fs] = await Promise.all([
    get<Metric[]>("/api/metrics").catch(() => [] as Metric[]),
    props.scope === "work" ? get<DataFile[]>("/api/metrics/files").catch(() => [] as DataFile[]) : Promise.resolve([] as DataFile[]),
  ]);
  metrics.value = all.filter((m) => (props.scope === "omem") === (m.source === "omem"));
  files.value = fs;
  loading.value = false;
  if (props.focus && metrics.value.some((m) => m.id === props.focus)) void show(props.focus);
}
onMounted(load);
watch(() => props.scope, load);

const SCHEDULE: Record<string, string> = { none: "按需取", hourly: "每小时", daily: "每天", weekly: "每周" };
const pct = (r: number) => `${r > 0 ? "+" : ""}${Math.round(r * 1000) / 10}%`;
const item = (m: Metric): MetricItem => ({
  label: m.name,
  value: m.change ? m.change.value : "—",
  unit: m.unit,
  ...(m.change?.rel != null ? { change: pct(m.change.rel), trend: m.change.rel > 0 ? ("up" as const) : m.change.rel < 0 ? ("down" as const) : ("flat" as const) } : {}),
  good: m.direction === "up-good" ? ("up" as const) : m.direction === "down-good" ? ("down" as const) : ("none" as const),
  note: m.points ? `${props.scope === "work" ? `${m.source || "来源没写"} · ` : ""}${SCHEDULE[m.schedule] ?? m.schedule}${m.change?.flagged ? " · 越过门槛" : ""}` : "还没有数据",
  spark: m.spark,
  hint: m.description || undefined,
});

// Work metrics by the line they hang on (a matter without a line is its own group); loose ones last.
const groups = computed(() => {
  const by = new Map<string, { key: string; title: string; link: string | null; metrics: Metric[] }>();
  for (const m of metrics.value) {
    const key = props.scope === "omem" ? "omem" : m.lineId ?? m.itemId ?? "";
    const title = props.scope === "omem" ? "" : m.lineTitle ?? m.itemTitle ?? "没挂到事项上的";
    if (!by.has(key)) by.set(key, { key, title, link: props.scope === "work" && key ? `#/work/${key}` : null, metrics: [] });
    by.get(key)!.metrics.push(m);
  }
  return [...by.values()].sort((a, b) => (a.key ? 0 : 1) - (b.key ? 0 : 1) || b.metrics.length - a.metrics.length);
});
const catalog = computed(() => files.value.find((f) => f.kind === "catalog") ?? null);
const plans = computed(() => files.value.filter((f) => f.kind === "plan"));
const notes = computed(() => files.value.filter((f) => f.kind === "note").slice(0, 5));
const opened = computed(() => metrics.value.find((m) => m.id === open.value) ?? null);
const flagged = computed(() => metrics.value.filter((m) => m.change?.flagged).length);

async function show(id: string) {
  if (open.value === id) return (open.value = null);
  open.value = id;
  chart.value = null;
  const r = await get<{ chart: ChartSpec }>(`/api/metrics/${id}?days=${days.value}`).catch(() => null);
  if (open.value === id) chart.value = r?.chart ?? null;
}
watch(days, () => {
  const id = open.value;
  if (!id) return;
  open.value = null;
  void show(id);
});
</script>

<template>
  <div class="metrics-board">
    <div class="board-head">
      <p class="muted small">
        <template v-if="scope === 'work'">{{ metrics.length }} 个指标<template v-if="flagged"> · <strong class="warn">{{ flagged }} 个越过门槛</strong></template>。按工作线分组；点指标名看曲线和怎么查。</template>
        <template v-else>omem 每天存一份自己的用量，原始记录过期以后这些曲线还在。</template>
      </p>
      <UiSegmented v-model="days" size="sm" aria-label="时间范围" :options="[{ value: 7, label: '7 天' }, { value: 30, label: '30 天' }, { value: 90, label: '90 天' }]" />
    </div>

    <div v-if="scope === 'work' && (catalog || plans.length)" class="files">
      <a v-if="catalog" class="file" :href="`#/sources/${catalog.id}`"><strong>数据源目录</strong><span class="muted small">哪个系统有哪类数据、怎么查 · {{ fmt(catalog.updatedAt, { dateStyle: "short" }) }}</span></a>
      <div v-if="plans.length" class="file">
        <strong>观测计划 {{ plans.length }} 份</strong>
        <span class="links"><a v-for="f in plans" :key="f.id" :href="`#/sources/${f.id}`">{{ f.title }}</a></span>
      </div>
      <div v-if="notes.length" class="file">
        <strong>采集记录</strong>
        <span class="links"><a v-for="f in notes" :key="f.id" :href="`#/sources/${f.id}`">{{ f.title }}</a></span>
      </div>
    </div>

    <Skeleton v-if="loading" :rows="4" />
    <p v-else-if="!metrics.length" class="muted">
      <template v-if="scope === 'work'">还没有工作指标。让助手按技能 observation-plan 给一个需求写观测计划，计划里的指标会定义到事项上，按时取数。</template>
      <template v-else>还没有存下 omem 自己的用量（每天一次，第一次在心跳时补上）。</template>
    </p>
    <template v-else>
      <section v-for="g in groups" :key="g.key" class="group">
        <h3 v-if="g.title" class="group-title"><a v-if="g.link" :href="g.link">{{ g.title }}</a><span v-else>{{ g.title }}</span><span class="muted small"> · {{ g.metrics.length }}</span></h3>
        <MetricRow :items="g.metrics.map(item)" />
        <div class="names">
          <button v-for="m in g.metrics" :key="m.id" type="button" class="btn ghost sm" :class="{ on: open === m.id }" :aria-expanded="open === m.id" @click="show(m.id)">{{ m.name }}</button>
        </div>
        <div v-if="opened && g.metrics.includes(opened)" class="opened">
          <Chart v-if="chart" :spec="chart" />
          <Skeleton v-else :rows="3" />
          <dl class="facts">
            <template v-if="opened.description"><dt>说明</dt><dd>{{ opened.description }}</dd></template>
            <template v-if="opened.source && scope === 'work'"><dt>来源</dt><dd>{{ opened.source }}</dd></template>
            <template v-if="opened.query"><dt>怎么查</dt><dd class="query">{{ opened.query }}</dd></template>
            <dt>取数</dt><dd>{{ SCHEDULE[opened.schedule] ?? opened.schedule }}{{ opened.lastAt ? `，最近一次 ${fmt(opened.lastAt, { hour12: false })}` : "，还没取过" }}</dd>
            <template v-if="scope === 'work'"><dt>门槛</dt><dd>和{{ opened.baseline != null ? `基线 ${opened.baseline}` : "前 7 个点的中位数" }}比，变化超过 {{ Math.round((opened.threshold ?? 0.3) * 100) }}% 告诉你</dd></template>
            <template v-if="opened.itemId"><dt>挂在</dt><dd><a :href="`#/work/${opened.itemId}`">{{ opened.itemTitle ?? opened.itemId }}</a></dd></template>
          </dl>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.metrics-board { display: flex; flex-direction: column; gap: 18px; min-width: 0; }
.board-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 16px; }
.board-head p { margin: 0; }
.warn { color: var(--warn, #b45309); font-weight: 600; }
.files { display: grid; gap: 8px; padding: 12px 14px; border: 1px solid var(--line); border-radius: 10px; background: var(--panel); }
.file { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; font-size: 13px; color: inherit; text-decoration: none; min-width: 0; }
a.file:hover strong { text-decoration: underline; }
.links { display: flex; flex-wrap: wrap; gap: 4px 12px; min-width: 0; }
.links a { overflow-wrap: anywhere; }
.group { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.group-title { margin: 6px 0 0; font-size: 14.5px; font-weight: 600; }
.group-title a { color: inherit; }
.names { display: flex; flex-wrap: wrap; gap: 4px; }
.names .on { background: var(--accent-soft, var(--hover)); }
.opened { display: flex; flex-direction: column; gap: 10px; padding: 10px 0 4px; border-top: 1px dashed var(--line); min-width: 0; }
.facts { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 4px 14px; margin: 0; font-size: 13px; }
.facts dt { color: var(--muted); }
.facts dd { margin: 0; overflow-wrap: anywhere; }
.query { white-space: pre-wrap; font-size: 12.5px; color: var(--ink-2); }
</style>
