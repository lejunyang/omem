<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { authUrl, get, type InsightsReport, type InsightMetric, type InsightRecord } from "../api";
import Skeleton from "../components/Skeleton.vue";
import UiSegmented from "../components/UiSegmented.vue";
import UiCheckbox from "../components/UiCheckbox.vue";
import UiSelect from "../components/UiSelect.vue";
import UiDateTime from "../components/UiDateTime.vue";
import VirtualList from "../components/VirtualList.vue";

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
function today() { return new Intl.DateTimeFormat("sv-SE", { timeZone: data.value?.timezone }).format(new Date()); }
function choosePeriod(value: string) {
  if (value === "custom") { setFilter("period", "custom"); return; }
  const to = today(), from = new Date(Date.parse(to) - (Number(value) - 1) * 86400_000).toISOString().slice(0, 10);
  const next: Record<string, typeof route.query[string]> = { ...route.query, from, to }; delete next.detail; delete next.period;
  void router.replace({ query: next });
}
function dateValue(day: string) { return day ? `${day}T12:00:00` : null; }
function selectDate(key: string, value: string | null) {
  if (!value) return;
  const d = new Date(value);
  setFilter(key, `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
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
// Plain numbers are figures. Numbers the server marked as cells of a table become that table: one
// column of counts is drawn as bars, several columns as a small table. A chart whose every point is
// already shown as a figure or a cell is not drawn a second time.
type Row = { label: string; cells: (InsightMetric | undefined)[] };
type Table = { title: string; cols: string[]; rows: Row[]; max: number };
const figures = (s: Section) => s.metrics.filter(m => !m.cell);
function tables(s: Section): Table[] {
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
    const rows = [...t.rows].map(([label, cells]) => ({ label, cells: t.cols.map(c => cells.get(c)) }));
    return { title, cols: t.cols, rows, max: Math.max(1, ...rows.map(r => r.cells[0]?.value ?? 0)) };
  });
}
function charts(s: Section): Chart[] {
  const shown = new Set(s.metrics.map(m => m.key));
  return s.charts.filter(c => !(c.points?.length && c.points.every(p => shown.has(p.key))));
}
type Bar = { label: string; value: number; link?: string };
const barsOf = (c: Chart): Bar[] => c.labels.map((label, i) => ({ label, value: c.series[0]?.values[i] ?? 0, link: c.points?.[i]?.link }));
type Spark = { name: string; values: number[]; total: number; isTotal?: boolean };
function sparksOf(c: Chart): { rows: Spark[]; max: number } {
  const rows: Spark[] = c.series.map(x => ({ name: x.name, values: x.values, total: x.values.reduce((a, b) => a + b, 0) })).filter(x => x.total > 0);
  if (rows.length > 1) {
    const sum = c.labels.map((_, i) => rows.reduce((a, r) => a + (r.values[i] ?? 0), 0));
    rows.unshift({ name: "合计", values: sum, total: sum.reduce((a, b) => a + b, 0), isTotal: true });
  }
  return { rows, max: Math.max(1, ...rows.flatMap(r => r.values)) };
}
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
  return Number.isFinite(t) ? new Date(t).toLocaleString("zh-CN", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : at;
}
const width = (v: number | null | undefined, max: number) => `${Math.max(0, Math.min(100, ((v ?? 0) / max) * 100))}%`;

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
      <div class="head-actions">
        <span class="muted small">导出</span>
        <a class="btn ghost sm" :href="exportUrl('md')">Markdown</a>
        <a class="btn ghost sm" :href="exportUrl('csv')">CSV</a>
      </div>
    </div>

    <div class="toolbar">
      <UiSegmented :model-value="period" :options="periods" size="sm" aria-label="看哪一段时间" @update:model-value="choosePeriod" />
      <UiCheckbox :model-value="q('compare') === 'true'" switch @update:model-value="setFilter('compare', $event)">和上一段比较</UiCheckbox>
      <button type="button" class="btn ghost sm" :aria-expanded="showFilters" @click="showFilters = !showFilters">筛选{{ activeFilters ? `（${activeFilters}）` : "" }}</button>
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
          <div v-if="figures(s).length" class="figures">
            <a v-for="m in figures(s)" :key="m.key" class="figure" :href="m.link" :title="m.note ?? '看是哪些记录'">
              <span class="figure-label">{{ m.label }}</span>
              <span class="figure-value">{{ shown(m).value }}<small v-if="shown(m).unit">{{ shown(m).unit }}</small></span>
              <span v-if="m.previous !== undefined" class="figure-sub">上一段 {{ shown({ value: m.previous ?? null, unit: m.unit }).value }}{{ shown({ value: m.previous ?? null, unit: m.unit }).unit }}</span>
              <span v-else-if="m.samples !== undefined" class="figure-sub">{{ m.samples }} 个样本</span>
            </a>
          </div>

          <div v-if="tables(s).length || charts(s).length" class="blocks">
            <div v-for="t in tables(s)" :key="t.title" class="block" :class="{ wide: t.cols.length > 3 }">
              <h3>{{ t.title }}</h3>
              <div v-if="t.cols.length === 1" class="bars">
                <a v-for="r in t.rows" :key="r.label" class="bar-row" :href="r.cells[0]?.link">
                  <span class="bar-label" :title="r.label">{{ r.label }}</span>
                  <span class="bar-track"><span class="bar-fill" :style="{ width: width(r.cells[0]?.value, t.max) }"></span></span>
                  <span class="bar-value">{{ num(r.cells[0]?.value) }}</span>
                </a>
              </div>
              <div v-else class="grid-wrap">
                <table class="grid">
                  <thead><tr><th></th><th v-for="c in t.cols" :key="c">{{ c }}</th></tr></thead>
                  <tbody>
                    <tr v-for="r in t.rows" :key="r.label">
                      <th scope="row">{{ r.label }}</th>
                      <td v-for="(m, i) in r.cells" :key="t.cols[i]"><a v-if="m" :href="m.link" :title="m.note">{{ shown(m).value }}<small v-if="shown(m).unit">{{ shown(m).unit }}</small></a><span v-else class="muted">—</span></td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            <div v-for="c in charts(s)" :key="c.title" class="block" :class="{ wide: c.kind !== 'hbar' }">
              <h3>{{ c.title }}</h3>
              <div v-if="c.kind === 'hbar'" class="bars">
                <component :is="b.link ? 'a' : 'div'" v-for="b in barsOf(c)" :key="b.label" class="bar-row" :href="b.link">
                  <span class="bar-label" :title="b.label">{{ b.label }}</span>
                  <span class="bar-track"><span class="bar-fill" :style="{ width: width(b.value, Math.max(1, ...barsOf(c).map(x => x.value))) }"></span></span>
                  <span class="bar-value">{{ num(b.value) }}</span>
                </component>
              </div>
              <div v-else class="spark" role="img" :aria-label="`${c.title}：${sparksOf(c).rows.map(r => `${r.name} 共 ${r.total}`).join('，')}`">
                <div v-for="r in sparksOf(c).rows" :key="r.name" class="spark-row" :class="{ total: r.isTotal }">
                  <span class="spark-name">{{ r.name }}</span>
                  <span class="spark-bars"><i v-for="(v, i) in r.values" :key="i" :style="{ height: width(v, sparksOf(c).max) }" :title="`${c.labels[i]}：${v}`"></i></span>
                  <span class="spark-total">{{ num(r.total) }}</span>
                </div>
                <div v-if="c.labels.length" class="spark-axis"><span>{{ c.labels[0] }}</span><span>{{ c.labels[c.labels.length - 1] }}</span></div>
                <p v-if="!sparksOf(c).rows.length" class="muted small">这段时间都是 0。</p>
              </div>
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
        <p class="muted small">统计于 {{ new Date(data.generatedAt).toLocaleString("zh-CN", { hour12: false }) }}，日期按 {{ data.timezone }} 算。别人问机器人的内容只计数，不显示。</p>
      </section>
    </template>
  </div>
</template>

<style scoped>
.data { min-width: 0; }
.head-actions { display: flex; align-items: center; gap: 6px; flex: none; }
.toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 16px; margin-bottom: 10px; }
.filters { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 12px; padding: 14px 0 6px; border-top: 1px solid var(--line); }
.filters-foot { grid-column: 1 / -1; display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }

.sec { border-top: 1px solid var(--line); margin-top: 26px; padding-top: 22px; display: flex; flex-direction: column; gap: 18px; min-width: 0; }
.sec-head h2 { font-size: 18px; font-weight: 650; }
.sec-head p { margin: 4px 0 0; color: var(--muted); font-size: 13px; max-width: 48em; }
.sec > p { margin: 0; }

.figures { display: grid; grid-template-columns: repeat(auto-fill, minmax(148px, 1fr)); gap: 16px 24px; }
.figure { display: flex; flex-direction: column; gap: 1px; min-width: 0; padding: 6px 8px; margin: -6px -8px; border-radius: var(--radius-sm); color: inherit; text-decoration: none; }
.figure:hover { background: var(--hover); }
.figure-label { font-size: 12.5px; color: var(--muted); overflow-wrap: anywhere; }
.figure-value { font-size: 24px; font-weight: 650; line-height: 1.3; font-variant-numeric: tabular-nums; }
.figure-value small { margin-left: 3px; font-size: 12px; font-weight: 400; color: var(--muted); }
.figure-sub { font-size: 12px; color: var(--muted); }

.blocks { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 22px 40px; }
.block { min-width: 0; }
.block.wide { grid-column: 1 / -1; }
.block h3 { margin-bottom: 8px; font-size: 13px; font-weight: 600; color: var(--ink-2); }

.bar-row { display: grid; grid-template-columns: minmax(0, 9.5em) minmax(32px, 1fr) minmax(2.5em, auto); align-items: center; gap: 10px; padding: 3px 0; font-size: 13px; color: inherit; text-decoration: none; }
a.bar-row:hover .bar-label { text-decoration: underline; }
.bar-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bar-track { height: 6px; border-radius: 3px; background: var(--sunken); overflow: hidden; }
.bar-fill { display: block; height: 100%; min-width: 2px; border-radius: 3px; background: color-mix(in srgb, var(--accent) 60%, var(--panel)); }
.bar-value { text-align: right; font-variant-numeric: tabular-nums; }

.grid-wrap { overflow-x: auto; }
.grid { width: 100%; border-collapse: collapse; font-size: 13px; }
.grid th, .grid td { padding: 5px 0 5px 14px; border-bottom: 1px solid var(--line); text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.grid th:first-child { padding-left: 0; text-align: left; font-weight: 400; white-space: normal; overflow-wrap: anywhere; }
.grid thead th { font-size: 12px; font-weight: 500; color: var(--muted); }
.grid a { color: inherit; text-decoration: none; }
.grid a:hover { text-decoration: underline; }
.grid small { margin-left: 2px; font-size: 11.5px; color: var(--muted); }

.spark-row { display: grid; grid-template-columns: 6.5em minmax(0, 1fr) 3.2em; align-items: end; gap: 10px; padding: 3px 0; font-size: 13px; }
.spark-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ink-2); }
.spark-bars { display: flex; align-items: flex-end; gap: 1px; height: 28px; border-bottom: 1px solid var(--line); }
.spark-bars i { flex: 1 1 0; min-width: 1px; border-radius: 1px 1px 0 0; background: color-mix(in srgb, var(--accent) 60%, var(--panel)); }
.spark-row.total .spark-bars { height: 44px; }
.spark-row.total .spark-bars i { background: var(--ink-2); }
.spark-row.total .spark-name { color: var(--ink); font-weight: 600; }
.spark-total { text-align: right; font-variant-numeric: tabular-nums; }
.spark-axis { display: flex; justify-content: space-between; margin: 3px calc(3.2em + 10px) 0 calc(6.5em + 10px); font-size: 11.5px; color: var(--muted); }

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
  .blocks { grid-template-columns: minmax(0, 1fr); gap: 20px; }
  .bar-row { grid-template-columns: minmax(0, 7em) minmax(24px, 1fr) minmax(2.5em, auto); }
  .spark-row { grid-template-columns: 5em minmax(0, 1fr) 3em; }
  .spark-axis { margin: 3px calc(3em + 10px) 0 calc(5em + 10px); }
}
</style>
