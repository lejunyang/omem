<script setup lang="ts">
/**
 * One number of omem's own report taken apart (GET /api/insights/breakdown), in a drawer on the right
 * (full screen when narrow): the number and how it compares with the period before, its records per
 * day, its records split by scene / agent / space / model / who / where / how it ended — a row adds
 * that group as a pick (`pick` in the URL, a small removable pill here) — and then the records
 * themselves, searchable, newest first. The URL keeps `detail` and the picks, so a link reopens it.
 * Esc or the backdrop closes it; the page puts the focus back on the number that opened it.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { get, type InsightBreakdown, type InsightBreakdownRecord } from "../api";
import { fmt } from "../lib/time";
import { state } from "../store";
import BarChart from "./charts/BarChart.vue";
import RankBars from "./charts/RankBars.vue";
import Icon from "./Icon.vue";
import Skeleton from "./Skeleton.vue";
import VirtualList from "./VirtualList.vue";

/** `filters`: the page's own filters (period, space, …) as a query string. */
const props = defineProps<{ metric: string; filters: string }>();
const emit = defineEmits<{ close: [] }>();
const route = useRoute(), router = useRouter();
const panel = ref<HTMLElement>();
const data = ref<InsightBreakdown | null>(null);
const records = ref<InsightBreakdownRecord[]>([]);
const loading = ref(true), more = ref(false), error = ref("");
const search = ref("");
let seq = 0;

const picks = computed(() => [route.query.pick ?? []].flat().filter((x): x is string => typeof x === "string"));
function params(extra: Record<string, string> = {}) {
  const p = new URLSearchParams(props.filters);
  p.set("metric", props.metric);
  for (const x of picks.value) p.append("pick", x);
  if (search.value.trim()) p.set("q", search.value.trim());
  for (const [k, v] of Object.entries(extra)) p.set(k, v);
  return p;
}
async function load(next = false) {
  const n = ++seq;
  if (next) more.value = true;
  else { loading.value = true; error.value = ""; }
  try {
    const r = await get<InsightBreakdown>(`/api/insights/breakdown?${params(next ? { offset: String(records.value.length) } : {})}`);
    if (n !== seq) return;
    data.value = r;
    records.value = next ? [...records.value, ...r.records] : r.records;
  } catch (e) {
    if (n === seq) error.value = (e as Error).message;
  } finally {
    if (n === seq) { loading.value = false; more.value = false; }
  }
}
watch(() => [props.metric, props.filters, picks.value.join("|")], () => void load(), { immediate: true });
let typing: ReturnType<typeof setTimeout> | undefined;
watch(search, () => { clearTimeout(typing); typing = setTimeout(() => void load(), 250); });

// ---- picks: a row of a split adds its group; a pill removes it
function hrefWith(pick: string) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(route.query)) for (const x of [v].flat()) if (typeof x === "string") q.append(k, x);
  if (!picks.value.includes(pick)) q.append("pick", pick);
  return `#/insights?${q}`;
}
function unpick(pick: string) {
  const rest = picks.value.filter((p) => p !== pick);
  void router.replace({ query: { ...route.query, pick: rest.length ? rest : undefined } });
}

// ---- how it reads
const spaceName = (id: string) => state.spaces.find((s) => s.id === id)?.name ?? id;
/** A record's title without how it ended when that is said at the row's end anyway. */
const titleOf = (r: InsightBreakdownRecord) => (r.result && r.label.endsWith(` · ${r.result}`) ? r.label.slice(0, -(r.result.length + 3)) : r.label);
const num = (v: number | null | undefined) => (v == null ? "—" : Number.isInteger(v) ? v.toLocaleString("zh-CN") : String(v));
function shown(value: number | null | undefined, unit?: string) {
  if (value == null) return { value: "—", unit: "" };
  if (unit === "秒" && value >= 7200) return { value: String(Math.round(value / 360) / 10), unit: "小时" };
  if (unit === "秒" && value >= 120) return { value: String(Math.round(value / 6) / 10), unit: "分钟" };
  return { value: num(value), unit: unit ?? "" };
}
const head = computed(() => shown(data.value?.value, data.value?.unit));
/** Against the period before: the difference in points for a rate, in percent otherwise. */
const versus = computed(() => {
  const d = data.value;
  if (!d || d.previous === undefined) return null;
  const before = shown(d.previous, d.unit);
  if (d.previous === null || d.value === null) return { text: `上一段 ${before.value}${before.unit}`, tone: "" };
  const diff = d.value - d.previous;
  const change = d.unit === "%" ? `${diff > 0 ? "+" : ""}${Math.round(diff * 10) / 10} 个百分点` : d.previous ? `${diff > 0 ? "+" : ""}${Math.round((diff / Math.abs(d.previous)) * 1000) / 10}%` : diff ? "上一段是 0" : "持平";
  return { text: `比上一段 ${change}（上一段 ${before.value}${before.unit}）`, tone: diff > 0 ? "up" : diff < 0 ? "down" : "" };
});
const dayLabels = computed(() => data.value?.daily?.labels.map((l) => l.slice(5)) ?? []);
const when = (at: string) => (Number.isFinite(Date.parse(at)) ? fmt(at, { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "");
function took(s?: number) {
  if (s === undefined) return "";
  if (s < 90) return `${s} 秒`;
  if (s < 5400) return `${Math.round(s / 60)} 分钟`;
  return `${Math.round(s / 360) / 10} 小时`;
}

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape" && !e.defaultPrevented) {
    e.preventDefault();
    emit("close");
  }
}
onMounted(() => {
  window.addEventListener("keydown", onKey);
  void nextTick(() => panel.value?.focus());
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKey);
  clearTimeout(typing);
  seq++;
});
</script>

<template>
  <Teleport to="body">
    <div class="scrim" @click="emit('close')" />
    <aside ref="panel" class="sheet" role="dialog" :aria-label="data?.label ?? '明细'" tabindex="-1">
      <header>
        <strong class="title">{{ data?.label ?? "明细" }}</strong>
        <span v-if="data" class="muted small range">{{ data.from.slice(5) }} 至 {{ data.to.slice(5) }}</span>
        <button type="button" class="btn ghost sm icon" aria-label="关闭" title="关闭（Esc）" @click="emit('close')"><Icon name="x" :size="16" /></button>
      </header>

      <div class="body">
        <Skeleton v-if="loading && !data" :rows="6" />
        <p v-else-if="error && !data" class="err" role="alert">{{ error }} <button type="button" class="btn sm" @click="load()">重试</button></p>
        <template v-else-if="data">
          <section class="hero" aria-label="这个数">
            <p class="figure"><b>{{ head.value }}</b><span v-if="head.unit">{{ head.unit }}</span></p>
            <p v-if="versus" class="versus" :data-tone="versus.tone">{{ versus.text }}</p>
            <p v-if="data.note" class="note">{{ data.note }}</p>
          </section>

          <div v-if="data.picks.length" class="picks" aria-label="抽屉里的筛选">
            <span class="muted small">只看</span>
            <button v-for="p in data.picks" :key="`${p.dim}:${p.value}`" type="button" class="pill" :aria-label="`去掉筛选 ${p.label}`" @click="unpick(`${p.dim}:${p.value}`)">{{ p.label }}<Icon name="x" :size="12" /></button>
            <span class="muted small">{{ data.total }} / {{ data.all }} 条</span>
          </div>

          <section v-if="data.daily" class="block" aria-label="按天">
            <BarChart :title="'每天的记录'" :labels="dayLabels" :series="[{ name: '记录', values: data.daily.values }]" caption="一根一天" :table="false" />
          </section>

          <section v-if="data.dims.length" class="splits" aria-label="拆开看">
            <h3>拆开看 <span class="muted small">点一行只看这一组</span></h3>
            <div v-for="d in data.dims" :key="d.key" class="split">
              <RankBars :title="d.label" :items="d.rows.map((r) => ({ label: d.key === 'space' ? spaceName(r.value) : r.label, value: r.count, link: hrefWith(`${d.key}:${r.value}`) }))" name="记录" :table="false" />
              <p v-if="d.more" class="muted small">另有 {{ d.more }} 组</p>
            </div>
          </section>

          <section class="records" aria-label="记录">
            <div class="records-head">
              <h3>记录 <span class="muted small">{{ data.total }} 条</span></h3>
              <input v-model="search" class="input sm" type="search" placeholder="搜索标题" aria-label="搜索记录" />
            </div>
            <p v-if="!records.length" class="muted small">{{ search ? "没有对得上的记录。" : "没有对应的记录。" }}</p>
            <VirtualList v-else :items="records" :item-key="(r: InsightBreakdownRecord) => `${r.id}:${r.at}`" :estimate="52">
              <template #default="{ item: r }">
                <div class="rec" :title="r.id">
                  <a class="rec-title" :href="r.link" @click="emit('close')">{{ titleOf(r) }}</a>
                  <span class="rec-meta">
                    <time v-if="when(r.at)">{{ when(r.at) }}</time>
                    <span v-if="r.by">{{ r.by }}</span>
                    <span v-if="r.seconds !== undefined">{{ took(r.seconds) }}</span>
                    <span v-if="r.value !== undefined && r.value !== ''">{{ r.value }}</span>
                  </span>
                  <span v-if="r.result" class="rec-result" :data-tone="r.result === '失败' ? 'bad' : ''">{{ r.result }}</span>
                </div>
              </template>
            </VirtualList>
            <button v-if="records.length < data.total" type="button" class="btn sm" :disabled="more" @click="load(true)">{{ more ? "正在读取…" : "再看 100 条" }}</button>
          </section>
          <p class="foot muted small">别人问机器人的内容只计数，不显示。</p>
        </template>
      </div>
    </aside>
  </Teleport>
</template>

<style scoped>
.scrim { position: fixed; inset: 0; background: rgba(10, 12, 16, 0.18); z-index: 38; }
.sheet { position: fixed; top: 0; right: 0; bottom: 0; width: min(540px, 100vw); background: var(--panel); border-left: 1px solid var(--line); box-shadow: var(--shadow-lg); z-index: 39; display: flex; flex-direction: column; outline: none; --chart-surface: var(--panel); }
header { display: flex; align-items: center; gap: 8px; padding: 8px 12px 8px 24px; border-bottom: 1px solid var(--line); min-height: 52px; min-width: 0; }
.title { font-size: 15px; font-weight: 650; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.range { flex: 1; white-space: nowrap; }
.body { flex: 1; overflow: auto; padding: 16px 24px 24px; display: grid; gap: 24px; align-content: start; grid-template-columns: minmax(0, 1fr); }
.body p { margin: 0; }
.err { color: var(--danger); font-size: 13px; }
.hero { display: grid; gap: 4px; }
.figure { display: flex; align-items: baseline; gap: 4px; }
.figure b { font: 650 36px/1.1 var(--sans); letter-spacing: -0.02em; font-variant-numeric: tabular-nums; color: var(--ink); }
.figure span { color: var(--muted); font-size: 13px; letter-spacing: .06em; }
.versus { font-size: 13px; color: var(--ink-2); font-variant-numeric: tabular-nums; }
.note { font-size: 12px; color: var(--muted); line-height: 1.6; max-width: 40em; }
.picks { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: -12px; }
.pill { display: inline-flex; align-items: center; gap: 4px; height: 24px; padding: 0 8px 0 10px; border: 1px solid var(--line-strong); border-radius: 999px; background: var(--sunken); color: var(--ink-2); font: inherit; font-size: 12px; cursor: pointer; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pill:hover { color: var(--ink); border-color: var(--muted); }
.pill:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
h3 { margin: 0; font-size: 14px; font-weight: 650; display: flex; align-items: baseline; gap: 8px; }
h3 .small { font-weight: 400; }
.splits { display: grid; gap: 16px; padding-top: 16px; border-top: 1px solid var(--line); }
.split { display: grid; gap: 4px; min-width: 0; }
.records { display: grid; gap: 8px; padding-top: 16px; border-top: 1px solid var(--line); min-width: 0; }
.records-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; }
.records-head .input { width: 12em; max-width: 100%; }
.rec { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 2px 12px; padding: 8px 0; border-bottom: 1px solid var(--line); min-width: 0; }
.rec-title { font-size: 13px; color: var(--ink); text-decoration: none; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rec-title:hover { text-decoration: underline; text-underline-offset: 3px; }
.rec-meta { grid-column: 1; display: flex; flex-wrap: wrap; gap: 0 12px; font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; min-width: 0; }
.rec-meta span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 16em; }
.rec-result { grid-column: 2; grid-row: 1 / span 2; align-self: center; font-size: 12px; color: var(--ink-2); }
.rec-result[data-tone="bad"] { color: var(--danger); }
.foot { padding-top: 8px; }
@media (max-width: 600px) {
  .body { padding: 16px; }
  header { padding-left: 16px; }
}
</style>
