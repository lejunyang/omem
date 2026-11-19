<script setup lang="ts">
/**
 * An item's metrics (src/data/metrics.ts): the numbers its observation plan watches — tracked events,
 * errors and usage after release, old against new — each with its latest value, the change against its
 * baseline and a small course; one opened shows its chart. Hidden when the item has none.
 */
import { computed, onMounted, ref, watch } from "vue";
import type { ChartSpec, MetricItem } from "@omem-ai/plugin-sdk/charts";
import { get } from "../api";
import MetricRow from "./charts/MetricRow.vue";
import Chart from "./charts/Chart.vue";
import UiSegmented from "./UiSegmented.vue";

type Change = { value: number; base: number | null; rel: number | null; flagged: boolean; good: boolean | null };
type Metric = { id: string; name: string; unit: string; source: string; schedule: string; description: string; direction?: string; status: string; lastAt: string | null; change: Change | null; spark: number[]; points: number };
const props = defineProps<{ itemId: string }>();
const metrics = ref<Metric[]>([]);
const open = ref<string | null>(null);
const chart = ref<ChartSpec | null>(null);
const days = ref(30);

async function load() {
  metrics.value = await get<Metric[]>(`/api/metrics?item=${encodeURIComponent(props.itemId)}`).catch(() => []);
}
onMounted(load);
watch(() => props.itemId, load);

const pct = (r: number) => `${r > 0 ? "+" : ""}${Math.round(r * 1000) / 10}%`;
const items = computed<MetricItem[]>(() =>
  metrics.value.map((m) => ({
    label: m.name,
    value: m.change ? m.change.value : "—",
    unit: m.unit,
    ...(m.change?.rel != null ? { change: pct(m.change.rel), trend: m.change.rel > 0 ? ("up" as const) : m.change.rel < 0 ? ("down" as const) : ("flat" as const) } : {}),
    good: m.direction === "up-good" ? ("up" as const) : m.direction === "down-good" ? ("down" as const) : ("none" as const),
    note: m.points ? `${m.source || "来源没写"} · ${m.schedule === "none" ? "按需取" : { hourly: "每小时", daily: "每天", weekly: "每周" }[m.schedule] ?? m.schedule}` : "还没有数据",
    spark: m.spark,
    hint: m.description || undefined,
  })),
);

async function show(id: string) {
  if (open.value === id) return (open.value = null);
  open.value = id;
  chart.value = null;
  const r = await get<{ chart: ChartSpec }>(`/api/metrics/${id}?days=${days.value}`).catch(() => null);
  chart.value = r?.chart ?? null;
}
watch(days, () => {
  const id = open.value;
  if (!id) return;
  open.value = null;
  void show(id);
});
</script>

<template>
  <section v-if="metrics.length" class="item-metrics">
    <div class="head row">
      <h3>数据</h3>
      <span class="spacer" />
      <UiSegmented v-model="days" size="sm" aria-label="时间范围" :options="[{ value: 7, label: '7 天' }, { value: 30, label: '30 天' }, { value: 90, label: '90 天' }]" />
    </div>
    <MetricRow :items="items" />
    <div class="names row wrap">
      <button v-for="m in metrics" :key="m.id" class="btn ghost sm" :class="{ on: open === m.id }" @click="show(m.id)">{{ m.name }}</button>
    </div>
    <Chart v-if="open && chart" :spec="chart" />
  </section>
</template>

<style scoped>
.item-metrics {
  margin: 12px 0;
}
.head h3 {
  margin: 0;
  font-size: 14px;
}
.spacer {
  flex: 1;
}
.names {
  margin-top: 6px;
  gap: 4px;
}
.names .on {
  background: var(--accent-soft, var(--hover));
}
</style>
