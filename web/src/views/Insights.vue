<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { authUrl, get, type InsightsReport, type InsightMetric, type InsightRecord } from "../api";
import Skeleton from "../components/Skeleton.vue";
import Icon from "../components/Icon.vue";
import UiSegmented from "../components/UiSegmented.vue";
import UiCheckbox from "../components/UiCheckbox.vue";
import UiSelect from "../components/UiSelect.vue";
import UiDateTime from "../components/UiDateTime.vue";
import VirtualList from "../components/VirtualList.vue";
import MetricRow from "../components/charts/MetricRow.vue";
import RankBars from "../components/charts/RankBars.vue";
import BarChart from "../components/charts/BarChart.vue";
import TrendChart from "../components/charts/TrendChart.vue";
import type { ChartSpec, MetricItem } from "@omem-ai/plugin-sdk/charts";
import { dayKey, fmt, fromWallDate, timeZone } from "../lib/time";

type Section = InsightsReport["sections"][number];
type Chart = Section["charts"][number];

const route = useRoute(), router = useRouter();
const data = ref<InsightsReport>();
const loading = ref(true), error = ref("");
const records = ref<InsightRecord[]>([]), recordsTotal = ref(0), recordLoading = ref(false), recordError = ref("");
let seq = 0, detailSeq = 0;

// ---- the filter lives in the URL, so a link reproduces the view
const q = (name: string) => typeof route.query[name] === "string" ? route.query[name] as string : "";
const filterNames = ["from", "to", "space", "by", "scene", "profile", "model", "bot", "chat", "compare", "housekeeping"];
const query = computed(() => new URLSearchParams(filterNames.flatMap(k => q(k) ? [[k, q(k)]] : [])));
const periods = [{ value: "7", label: "7 天" }, { value: "30", label: "30 天" }, { value: "90", label: "90 天" }, { value: "custom", label: "自定义" }];
const period = computed(() => {
  if (q("period") === "custom") return "custom";
  if (!q("from") && !q("to")) return "30";
  const n = Math.round((Date.parse(q("to")) - Date.parse(q("from"))) / 86400_000) + 1;
  return [7, 30, 90].includes(n) ? String(n) : "custom";
});
function setFilter(name: string, value: unknown) {
  const next = { ...route.query }; delete next.detail;
  if (value === "" || value === false || value == null) delete next[name]; else next[name] = String(value);
  void router.replace({ path: "/insights", query: next });
}
function today() { return new Intl.DateTimeFormat("sv-SE", { timeZone: data.value?.timezone ?? timeZone() }).format(new Date()); }
function choosePeriod(value: string) {
  if (value === "custom") { setFilter("period", "custom"); return; }
  const to = today(), from = new Date(Date.parse(to) - (Number(value) - 1) * 86400_000).toISOString().slice(0, 10);
  const next: Record<string, typeof route.query[string]> = { ...route.query, from, to }; delete next.detail; delete next.period;
  void router.replace({ query: next });
}
function dateValue(day: string) { return day ? fromWallDate(new Date(`${day}T12:00:00`)).toISOString() : null; }
function selectDate(key: string, value: string | null) {
  if (!value) return;
  setFilter(key, dayKey(value));
}
const filters = computed(() => {
  const options = data.value?.options;
  return [
    { key: "space", label: "空间", values: options?.spaces ?? [] },
    { key: "by", label: "谁触发的", values: options?.people ?? [] },
    { key: "scene", label: "场景", values: data.value?.scenes ?? [] },
    { key: "profile", label: "Agent", values: options?.profiles ?? [] },
    { key: "model", label: "模型", values: options?.models ?? [] },
    { key: "bot", label: "机器人", values: options?.bots ?? [] },
    { key: "chat", label: "在哪个会话", values: options?.chats ?? [] },
  ].map(f => ({ ...f, options: [{ value: "", label: "全部" }, ...[...new Set([...f.values, ...(q(f.key) ? [q(f.key)] : [])])].map(value => ({ value, label: value === "user:owner" ? "你" : value }))] }));
});
const activeFilters = computed(() => filters.value.filter(f => q(f.key)).length + (q("housekeeping") === "true" ? 1 : 0));
const showFilters = ref(activeFilters.value > 0);
// 导出: a menu next to the filters, closed by a click elsewhere or Esc.
const exportOpen = ref(false);
const exportBox = ref<HTMLElement>();
const closeExport = (e: Event) => { if (exportOpen.value && !exportBox.value?.contains(e.target as Node)) exportOpen.value = false; };
const escExport = (e: KeyboardEvent) => { if (e.key === "Escape") exportOpen.value = false; };
document.addEventListener("pointerdown", closeExport);
document.addEventListener("keydown", escExport);
onBeforeUnmount(() => { document.removeEventListener("pointerdown", closeExport); document.removeEventListener("keydown", escExport); });
function clearFilters() {
  const next = { ...route.query }; delete next.detail; delete next.housekeeping;
  for (const f of filters.value) delete next[f.key];
  void router.replace({ path: "/insights", query: next });
}

// ---- loading
async function load() {
  const n = ++seq; loading.value = true; error.value = ""; data.value = undefined;
  try { const result = await get<InsightsReport>(`/api/insights?${query.value}`); if (n === seq) data.value = result; }
  catch (e) { if (n === seq) error.value = (e as Error).message; }
  finally { if (n === seq) loading.value = false; }
}
async function loadRecords(more = false) {
  const n = ++detailSeq;
  if (!more) { records.value = []; recordsTotal.value = 0; }
  recordError.value = ""; recordLoading.value = false;
  if (!q("detail")) return;
  recordLoading.value = true;
  try {
    const params = new URLSearchParams(query.value); params.set("metric", q("detail")); params.set("offset", String(more ? records.value.length : 0));
    const result = await get<{ records: InsightRecord[]; total: number }>(`/api/insights/records?${params}`);
    if (n === detailSeq) { records.value = more ? [...records.value, ...result.records] : result.records; recordsTotal.value = result.total; }
  } catch (e) { if (n === detailSeq) recordError.value = (e as Error).message; }
  finally { if (n === detailSeq) recordLoading.value = false; }
}
watch(() => query.value.toString(), () => void load(), { immediate: true });
watch(() => `${query.value}&${q("detail")}`, () => void loadRecords(), { immediate: true });
onBeforeUnmount(() => { seq++; detailSeq++; });
const allMetrics = computed(() => (data.value?.sections ?? []).flatMap(s => [...s.metrics, ...s.charts.flatMap(c => c.points ?? [])]));
const detailMetric = computed(() => allMetrics.value.find(m => m.key === q("detail")));

// ---- how a section's numbers are laid out
// Plain numbers are figures. Numbers the server marked as cells of a table become rows of bars: the
// columns in the first column's unit are bars side by side (each in its own colour, its value at the
// bar's end), the others (a rate, hours) text at the row's end. A chart whose every point is already
// shown as a figure or a cell is not drawn a second time. Every bar, figure and cell opens its records.
const figures = (s: Section): MetricItem[] => s.metrics.filter(m => !m.cell).map(m => {
  const v = shown(m);
  const prev = m.previous !== undefined ? shown({ value: m.previous ?? null, unit: m.unit }) : null;
  return { label: m.label, value: v.value, unit: v.unit, link: m.link, hint: m.note ?? "看是哪些记录", note: prev ? `上一段 ${prev.value}${prev.unit}` : m.samples !== undefined ? `${m.samples} 个样本` : undefined };
});
type Block = { key: string; kind: "rows" | "bars" | "trend"; wide: boolean; spec: Omit<ChartSpec, "kind">; empty?: boolean };
function tableBlocks(s: Section): Block[] {
  const out = new Map<string, { cols: string[]; rows: Map<string, Map<string, InsightMetric>> }>();
  for (const m of s.metrics) {
    if (!m.cell) continue;
    let t = out.get(m.cell.table);
    if (!t) out.set(m.cell.table, t = { cols: [], rows: new Map() });
    if (!t.cols.includes(m.cell.col)) t.cols.push(m.cell.col);
    let r = t.rows.get(m.cell.row);
    if (!r) t.rows.set(m.cell.row, r = new Map());
    r.set(m.cell.col, m);
  }
  return [...out].map(([title, t]) => {
    const rows = [...t.rows];
    const unitOf = (col: string) => rows.map(([, cells]) => cells.get(col)?.unit).find(u => u !== undefined);
    const unit = unitOf(t.cols[0]);
    const bars = t.cols.filter(c => unitOf(c) === unit), extras = t.cols.filter(c => unitOf(c) !== unit);
    const series = bars.map((col, slot) => ({ name: col, slot, values: rows.map(([, cells]) => cells.get(col)?.value ?? 0), links: bars.length > 1 ? rows.map(([, cells]) => cells.get(col)?.link) : undefined }));
    // Rows that are weeks or days read as a course: one line per column, each point opening its records.
    if (bars.length > 1 && !extras.length && rows.length >= 3 && rows.every(([label]) => /^\d{4}-\d{2}-\d{2}/.test(label)))
      return { key: `t:${title}`, kind: "trend" as const, wide: true, spec: { title, unit, labels: rows.map(([label]) => label), series: series.map(x => ({ ...x, links: rows.map(([, cells]) => cells.get(x.name)?.link) })) } };
    return { key: `t:${title}`, kind: "rows" as const, wide: bars.length > 1 || extras.length > 1, spec: {
      title, unit, labels: rows.map(([label]) => label), series,
      links: bars.length === 1 ? rows.map(([, cells]) => cells.get(t.cols[0])?.link) : undefined,
      extras: extras.map(col => ({ name: col, values: rows.map(([, cells]) => { const v = shown(cells.get(col)); return v.value === "—" ? "" : `${v.value}${v.unit}`; }), links: rows.map(([, cells]) => cells.get(col)?.link) })),
    } };
  });
}
function chartBlocks(s: Section, scenes: readonly string[]): Block[] {
  const shownKeys = new Set(s.metrics.map(m => m.key));
  return s.charts.filter(c => !(c.points?.length && c.points.every(p => shownKeys.has(p.key)))).map((c: Chart): Block => {
    const n = c.labels.length, m = c.series.length;
    // Points come label by label, a series after another within a label (or one per label for a single series).
    const at = (i: number, si: number) => c.points?.length === n * m ? c.points[i * m + si]?.link : undefined;
    if (c.kind === "hbar") return { key: `c:${c.title}`, kind: "rows", wide: false, spec: { title: c.title, unit: c.unit, labels: c.labels, series: c.series, links: c.points?.length === n ? c.points.map(p => p.link) : undefined } };
    // A series keeps its colour by its place among the scenes (or in the chart), whichever of them are drawn.
    const series = c.series.map((x, si) => ({ ...x, slot: scenes.includes(x.name) ? scenes.indexOf(x.name) : si, links: c.labels.map((_, i) => at(i, si)) })).filter(x => x.values.some(v => v));
    const empty = !series.length;
    // A count per day added up over kinds reads best as stacked columns, one a day.
    if (c.stack) return { key: `c:${c.title}`, kind: "bars", wide: true, empty, spec: { title: c.title, unit: c.unit, labels: c.labels, series, stack: true, caption: dayLabels(c.labels) ? "一根一天" : undefined } };
    return { key: `c:${c.title}`, kind: "trend", wide: true, empty, spec: { title: c.title, unit: c.unit, labels: c.labels, series, caption: dayLabels(c.labels) ? "一点一天" : undefined } };
  });
}
const dayLabels = (labels: string[]) => labels.length > 1 && labels.every(l => /^\d{4}-\d{2}-\d{2}$/.test(l));
const blocks = (s: Section) => [...tableBlocks(s), ...chartBlocks(s, data.value?.scenes ?? [])];
function notes(s: Section): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of s.metrics) {
    if (!m.note || seen.has(m.note)) continue;
    seen.add(m.note);
    out.push(`${m.cell ? m.cell.col : m.label}：${m.note}`);
  }
  return [...out, ...s.notes];
}

// ---- how a number reads
const num = (v: number | null | undefined) => v == null ? "—" : Number.isInteger(v) ? v.toLocaleString("zh-CN") : String(v);
/** Seconds read as seconds only when they are few. */
function shown(m: { value: number | null; unit?: string } | undefined): { value: string; unit: string } {
  if (!m || m.value == null) return { value: "—", unit: "" };
  if (m.unit === "秒" && m.value >= 7200) return { value: String(Math.round(m.value / 360) / 10), unit: "小时" };
  if (m.unit === "秒" && m.value >= 120) return { value: String(Math.round(m.value / 6) / 10), unit: "分钟" };
  return { value: num(m.value), unit: m.unit ?? "" };
}
/** A record's time in the reader's own clock; whatever is not a date is shown as it is. */
function when(at: string) {
  const t = Date.parse(at);
  return Number.isFinite(t) ? fmt(t, { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : at;
}

// ---- the owner's own assumption, kept in this browser only
const estimate = ref("");
try { estimate.value = localStorage.getItem("omem.insights.minutes") ?? ""; } catch { /* storage may be turned off */ }
watch(estimate, v => { try { if (v) localStorage.setItem("omem.insights.minutes", v); else localStorage.removeItem("omem.insights.minutes"); } catch { /* storage may be turned off */ } });
const assumedMinutes = computed(() => Number(estimate.value) > 0 && Number.isFinite(Number(estimate.value)) ? Number(estimate.value) : null);
const answered = computed(() => allMetrics.value.find(m => m.key === "shield:answered")?.value);
function exportUrl(format: string) { const params = new URLSearchParams(query.value); params.set("format", format); return authUrl(`/api/insights/export?${params}`); }
</script>

<template>
  <div class="page data">
    <div class="page-head">
      <div class="grow">
        <h1>数据</h1>
        <p>omem 和机器人这段时间做了什么。每个数都是从记录里数出来的，点一下能看到是哪些。</p>
      </div>
    </div>

    <div class="toolbar">
      <UiSegmented :model-value="period" :options="periods" size="sm" aria-label="看哪一段时间" @update:model-value="choosePeriod" />
      <UiCheckbox :model-value="q('compare') === 'true'" switch @update:model-value="setFilter('compare', $event)">和上一段比较</UiCheckbox>
      <button type="button" class="btn ghost sm" :aria-expanded="showFilters" @click="showFilters = !showFilters">筛选{{ activeFilters ? `（${activeFilters}）` : "" }}</button>
      <div ref="exportBox" class="export">
        <button type="button" class="btn ghost sm" aria-haspopup="menu" :aria-expanded="exportOpen" @click="exportOpen = !exportOpen">导出<Icon name="down" :size="13" /></button>
        <div v-if="exportOpen" class="export-menu" role="menu" @keydown.esc="exportOpen = false">
          <a role="menuitem" :href="exportUrl('md')" @click="exportOpen = false">Markdown<span class="muted small">报告</span></a>
          <a role="menuitem" :href="exportUrl('csv')" @click="exportOpen = false">CSV<span class="muted small">表格</span></a>
        </div>
      </div>
      <span class="grow"></span>
      <span v-if="data" class="muted small">{{ data.from }} 至 {{ data.to }}</span>
    </div>
    <div v-if="period === 'custom'" class="toolbar">
      <label class="field"><span>从</span><UiDateTime :model-value="dateValue(q('from') || data?.from || '')" :clearable="false" aria-label="开始日期" @update:model-value="selectDate('from', $event)" /></label>
      <label class="field"><span>到</span><UiDateTime :model-value="dateValue(q('to') || data?.to || '')" :clearable="false" aria-label="结束日期" @update:model-value="selectDate('to', $event)" /></label>
      <span class="muted small">最多 180 天</span>
    </div>
    <div v-if="showFilters" class="filters">
      <label v-for="f in filters" :key="f.key" class="field"><span>{{ f.label }}</span><UiSelect :model-value="q(f.key)" :options="f.options" :aria-label="f.label" @update:model-value="setFilter(f.key, $event)" /></label>
      <div class="filters-foot">
        <UiCheckbox :model-value="q('housekeeping') === 'true'" switch @update:model-value="setFilter('housekeeping', $event)">把系统自己的整理也算进来</UiCheckbox>
        <button v-if="activeFilters" type="button" class="btn ghost sm" @click="clearFilters">清除筛选</button>
      </div>
    </div>
    <p v-if="data && data.owner === false" class="muted small">这里只有你自己触发的、和你有权看的部分。</p>

    <p v-if="error" role="alert">{{ error }} <button type="button" class="btn sm" @click="load">重试</button></p>
    <template v-if="loading">
      <section v-for="n in 3" :key="n" class="sec"><Skeleton :rows="4" /></section>
    </template>

    <template v-else-if="data">
      <section v-if="q('detail')" class="detail card pad" aria-label="明细">
        <div class="row wrap">
          <strong class="grow">{{ detailMetric?.label ?? "明细" }}<span class="muted"> · {{ recordsTotal }} 条</span></strong>
          <button type="button" class="btn ghost sm" @click="setFilter('detail', '')">关闭</button>
        </div>
        <p v-if="detailMetric?.note" class="muted small">{{ detailMetric.note }}</p>
        <Skeleton v-if="recordLoading && !records.length" :rows="4" />
        <p v-else-if="recordError" role="alert">{{ recordError }} <button type="button" class="btn sm" @click="loadRecords()">重试</button></p>
        <p v-else-if="!records.length" class="muted">没有对应的记录。</p>
        <VirtualList :items="records" :item-key="r => r.id" :estimate="40">
          <template #default="{ item: r }">
            <div class="record"><a :href="r.link">{{ r.label }}</a><span class="muted small mono">{{ r.id }}</span><span class="grow"></span><span v-if="r.value !== undefined" class="small">{{ r.value }}</span><time class="muted small">{{ when(r.at) }}</time></div>
          </template>
        </VirtualList>
        <button v-if="records.length < recordsTotal" type="button" class="btn sm" :disabled="recordLoading" @click="loadRecords(true)">{{ recordLoading ? "正在读取…" : "再看 100 条" }}</button>
      </section>

      <section v-for="s in data.sections" :key="s.id" class="sec" :aria-labelledby="`data-${s.id}`">
        <div class="sec-head">
          <h2 :id="`data-${s.id}`">{{ s.title }}</h2>
          <p>{{ s.description }}</p>
        </div>
        <p v-if="s.error" role="alert">这一块没算出来：{{ s.error }} <button type="button" class="btn sm" @click="load">重试</button></p>
        <p v-else-if="s.empty" class="muted">{{ s.empty }}</p>
        <template v-else>
          <MetricRow v-if="figures(s).length" :items="figures(s)" />

          <div v-if="blocks(s).length" class="blocks">
            <div v-for="b in blocks(s)" :key="b.key" class="block" :class="{ wide: b.wide }">
              <template v-if="b.empty">
                <p class="block-title">{{ b.spec.title }}</p>
                <p class="muted small">这段时间都是 0。</p>
              </template>
              <RankBars v-else-if="b.kind === 'rows'" v-bind="b.spec" :table="false" />
              <BarChart v-else-if="b.kind === 'bars'" v-bind="b.spec" />
              <TrendChart v-else v-bind="b.spec" />
            </div>
          </div>

          <details v-if="notes(s).length" class="how">
            <summary>这些数是怎么数的</summary>
            <ul><li v-for="n in notes(s)" :key="n">{{ n }}</li></ul>
          </details>
        </template>
      </section>

      <section class="sec foot">
        <details class="how">
          <summary>场景是怎么分的</summary>
          <p>按任务的类型分，不看任务里调用了什么工具。定时的巡检和唤醒，没有新动静、安静结束的，算在系统自己的整理里。</p>
          <dl>
            <template v-for="scene in data.scenes" :key="scene">
              <dt>{{ scene }}</dt>
              <dd>{{ Object.entries(data.sceneTable).filter(([, value]) => value === scene).map(([kind]) => kind).join("、") || "按 Agent 的角色认出来的" }}</dd>
            </template>
          </dl>
        </details>
        <details v-if="data.owner" class="how">
          <summary>按你自己的假设换算</summary>
          <p>页面不替你估“省了多少时间”。你可以自己填一个假设，它只存在这个浏览器里。</p>
          <label class="field estimate"><span>替你答一次，按省多少分钟算</span><input v-model="estimate" class="input" inputmode="decimal" placeholder="不填就不换算" aria-label="替你答一次按省多少分钟算" /></label>
          <p v-if="assumedMinutes && answered != null">估算：{{ Math.round(answered * assumedMinutes * 10) / 10 }} 分钟（替你答了 {{ answered }} 次 × 每次 {{ assumedMinutes }} 分钟）。这是按你填的假设算的，不是量出来的。</p>
        </details>
        <p class="muted small">统计于 {{ fmt(data.generatedAt, { hour12: false }) }}，日期按 {{ data.timezone }} 算。别人问机器人的内容只计数，不显示。</p>
      </section>
    </template>
  </div>
</template>

<style scoped>
/* The page is on --bg, not on a panel: the ring around a chart's dots takes its colour. */
.data { min-width: 0; --chart-surface: var(--bg); }
.export { position: relative; }
.export > .btn { gap: 4px; }
.export-menu { position: absolute; top: calc(100% + 4px); left: 0; z-index: 20; min-width: 168px; display: grid; padding: 4px; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12); }
.export-menu a { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; padding: 6px 10px; border-radius: 6px; color: inherit; text-decoration: none; font-size: 13px; }
.export-menu a:hover, .export-menu a:focus-visible { background: var(--hover); }
.toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 16px; margin-bottom: 10px; }
.filters { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 12px; padding: 14px 0 6px; border-top: 1px solid var(--line); }
.filters-foot { grid-column: 1 / -1; display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }

.sec { border-top: 1px solid var(--line); margin-top: 26px; padding-top: 22px; display: flex; flex-direction: column; gap: 18px; min-width: 0; }
.sec-head h2 { font-size: 18px; font-weight: 650; }
.sec-head p { margin: 4px 0 0; color: var(--muted); font-size: 13px; max-width: 48em; }
.sec > p { margin: 0; }

.blocks { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 28px 44px; }
.block { min-width: 0; }
.block.wide { grid-column: 1 / -1; }
.block-title { margin: 0 0 4px; font-size: 13.5px; font-weight: 600; }

.how { font-size: 12.5px; color: var(--muted); }
.how summary { cursor: pointer; width: fit-content; }
.how ul { margin: 6px 0 0; padding-left: 1.3em; }
.how li { margin: 2px 0; max-width: 56em; }
.how p { margin: 6px 0; max-width: 56em; }
.how dl { margin: 6px 0 0; }
.how dt { color: var(--ink-2); }
.how dd { margin: 0 0 8px; overflow-wrap: anywhere; }
.estimate { max-width: 280px; margin: 8px 0; }
.foot { gap: 10px; }

.detail { margin-top: 14px; display: flex; flex-direction: column; gap: 8px; }
.record { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; padding: 6px 0; border-bottom: 1px solid var(--line); font-size: 13px; min-width: 0; }
.mono { font-family: var(--mono); }

@media (max-width: 760px) {
  .blocks { grid-template-columns: minmax(0, 1fr); gap: 24px; }
}
</style>
