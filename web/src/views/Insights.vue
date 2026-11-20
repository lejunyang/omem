<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { authUrl, get, type InsightsReport, type InsightMetric } from "../api";
import Skeleton from "../components/Skeleton.vue";
import Icon from "../components/Icon.vue";
import HelpText from "../components/HelpText.vue";
import UiSegmented from "../components/UiSegmented.vue";
import UiCheckbox from "../components/UiCheckbox.vue";
import UiSelect from "../components/UiSelect.vue";
import UiDateTime from "../components/UiDateTime.vue";
import MetricRow from "../components/charts/MetricRow.vue";
import RankBars from "../components/charts/RankBars.vue";
import BarChart from "../components/charts/BarChart.vue";
import TrendChart from "../components/charts/TrendChart.vue";
import MetricsBoard from "../components/MetricsBoard.vue";
import MetricFiles from "../components/MetricFiles.vue";
import InsightDrawer from "../components/InsightDrawer.vue";
import type { ChartSpec, MetricItem } from "@omem-ai/plugin-sdk/charts";
import { dayKey, fmt, fromWallDate, timeZone } from "../lib/time";
import { state } from "../store";

/**
 * The data page (#/insights), two kinds of data never mixed: 工作数据, the numbers the owner's work is
 * watched by (components/MetricsBoard, the files behind them in the header), and omem 自己, what omem
 * and its bot did (GET /api/insights): a few key numbers, a row of chapters to jump between, each
 * chapter's sections showing their main chart or two (the rest one click away), and omem's own daily
 * numbers kept over the long run. Any number or bar opens its drawer (components/InsightDrawer):
 * by day, split, and its records. Filters, period and export sit at the right of the tab row; the
 * filters and the open number live in the URL.
 */
type Section = InsightsReport["sections"][number];
type Chart = Section["charts"][number];

const route = useRoute(), router = useRouter();
const data = ref<InsightsReport>();
const loading = ref(true), error = ref("");
let seq = 0;

// ---- the filter lives in the URL, so a link reproduces the view
const q = (name: string) => typeof route.query[name] === "string" ? route.query[name] as string : "";
const filterNames = ["from", "to", "space", "by", "scene", "profile", "model", "bot", "chat", "compare", "housekeeping"];
const query = computed(() => new URLSearchParams(filterNames.flatMap(k => q(k) ? [[k, q(k)]] : [])));
// A link that carries the report's filters (or a number) means omem's; otherwise work comes first.
const tab = computed<"work" | "omem">(() => q("tab") === "omem" || q("tab") === "work" ? q("tab") as "work" | "omem" : filterNames.some(k => q(k)) || q("detail") ? "omem" : "work");
const tabs = [{ value: "work", label: "工作数据" }, { value: "omem", label: "omem 自己" }];
function setTab(value: string) { void router.replace({ path: "/insights", query: value === "omem" ? { ...route.query, tab: value } : { tab: value } }); }
const periods = [{ value: "7", label: "7 天" }, { value: "30", label: "30 天" }, { value: "90", label: "90 天" }, { value: "custom", label: "自定义" }];
const period = computed(() => {
  if (q("period") === "custom") return "custom";
  if (!q("from") && !q("to")) return "30";
  const n = Math.round((Date.parse(q("to")) - Date.parse(q("from"))) / 86400_000) + 1;
  return [7, 30, 90].includes(n) ? String(n) : "custom";
});
function setFilter(name: string, value: unknown) {
  const next = { ...route.query }; delete next.detail; delete next.pick;
  if (value === "" || value === false || value == null) delete next[name]; else next[name] = String(value);
  void router.replace({ path: "/insights", query: next });
}
function today() { return new Intl.DateTimeFormat("sv-SE", { timeZone: data.value?.timezone ?? timeZone() }).format(new Date()); }
function choosePeriod(value: string) {
  if (value === "custom") { setFilter("period", "custom"); return; }
  const to = today(), from = new Date(Date.parse(to) - (Number(value) - 1) * 86400_000).toISOString().slice(0, 10);
  const next: Record<string, typeof route.query[string]> = { ...route.query, from, to }; delete next.detail; delete next.pick; delete next.period;
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
  ].map(f => ({ ...f, options: [{ value: "", label: "全部" }, ...[...new Set([...f.values, ...(q(f.key) ? [q(f.key)] : [])])].map(value => ({ value, label: value === "user:owner" ? "你" : f.key === "space" ? spaceName(value) : value }))] }));
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
  const next = { ...route.query }; delete next.detail; delete next.pick; delete next.housekeeping;
  for (const f of filters.value) delete next[f.key];
  void router.replace({ path: "/insights", query: next });
}
function exportUrl(format: string) { const params = new URLSearchParams(query.value); params.set("format", format); return authUrl(`/api/insights/export?${params}`); }

// ---- loading: the report is counted on demand, only when its tab is open
async function load() {
  const n = ++seq; loading.value = true; error.value = ""; data.value = undefined;
  try { const result = await get<InsightsReport>(`/api/insights?${query.value}`); if (n === seq) data.value = result; }
  catch (e) { if (n === seq) error.value = (e as Error).message; }
  finally { if (n === seq) loading.value = false; }
}
watch(() => tab.value === "omem" ? query.value.toString() : null, (v) => { if (v !== null) void load(); }, { immediate: true });
onBeforeUnmount(() => { seq++; });
const allMetrics = computed(() => (data.value?.sections ?? []).flatMap(s => [...s.metrics, ...s.charts.flatMap(c => c.points ?? [])]));

// ---- the drawer: opened by any number's link (`detail`), closed back to the number that opened it
let opener: HTMLElement | null = null;
watch(() => q("detail"), (now, before) => {
  if (now && !before) opener = document.activeElement as HTMLElement | null;
  if (!now && before && opener?.isConnected) { const el = opener; void nextTick(() => el.focus()); }
}, { immediate: true });
/**
 * A number's link from the report carries the filters as the server read them (defaults written out);
 * opened from here it keeps the page's own query and adds the number, so the report is not counted
 * again and the number that opened the drawer stays where it is.
 */
const baseQuery = computed(() => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(route.query)) if (k !== "detail" && k !== "pick") for (const x of [v].flat()) if (typeof x === "string") p.append(k, x);
  if (!p.has("tab")) p.set("tab", "omem");
  return p.toString();
});
function here(link?: string) {
  const key = link?.startsWith("#/insights?") ? new URLSearchParams(link.slice("#/insights?".length)).get("detail") : null;
  return key ? `#/insights?${baseQuery.value}&detail=${encodeURIComponent(key)}` : link;
}
function localize(b: Block): Block {
  const s = b.spec;
  return { ...b, spec: { ...s, ...(s.links ? { links: s.links.map(here) } : {}), series: s.series.map(x => (x.links ? { ...x, links: x.links.map(here) } : x)), ...(s.extras ? { extras: s.extras.map(e => (e.links ? { ...e, links: e.links.map(here) } : e)) } : {}) } };
}
function closeDetail() {
  const next = { ...route.query }; delete next.detail; delete next.pick;
  void router.replace({ path: "/insights", query: next });
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
function figure(m: InsightMetric, label = m.label): MetricItem {
  const v = shown(m);
  const prev = m.previous !== undefined ? shown({ value: m.previous ?? null, unit: m.unit }) : null;
  return { label, value: v.value, unit: v.unit, link: here(m.link), hint: m.note ?? "看是哪些记录", note: prev ? `上一段 ${prev.value}${prev.unit}` : m.samples !== undefined ? `${m.samples} 个样本` : undefined };
}

// ---- the key numbers at the top: the few that say most, whichever this period has
const KEY: [string, string?][] = [["usage:total"], ["usage:success"], ["usage:people"], ["shield:delivered", "提醒或替你答了"], ["quality:reply:rate", "回复有用的占比"], ["flows:owner", "流程里等你"], ["delivery:applied", "编码用上了"]];
const keyMetrics = computed(() => KEY.flatMap(([key, label]) => { const m = allMetrics.value.find(x => x.key === key); return m && m.value !== null ? [{ m, label }] : []; }).slice(0, 4));
const keyFigures = computed(() => keyMetrics.value.map(({ m, label }) => figure(m, label)));
const keyKeys = computed(() => new Set(keyMetrics.value.map(({ m }) => m.key)));

// ---- chapters: the report's sections under a few names, with a row to jump between them
const CHAPTERS: { id: string; title: string; sections: string[] }[] = [
  { id: "use", title: "用量", sections: ["usage", "coverage"] },
  { id: "notify", title: "提醒", sections: ["shield"] },
  { id: "answers", title: "回答", sections: ["others", "quality"] },
  { id: "code", title: "编码与流程", sections: ["delivery", "flows", "study"] },
  { id: "knowledge", title: "知识", sections: ["knowledge"] },
  { id: "time", title: "运行时长", sections: ["cost"] },
];
const chapters = computed(() => {
  const ss = data.value?.sections ?? [];
  const known = new Set(CHAPTERS.flatMap(c => c.sections));
  const out = CHAPTERS.map(c => ({ ...c, list: c.sections.flatMap(id => ss.filter(s => s.id === id)) })).filter(c => c.list.length);
  const other = ss.filter(s => !known.has(s.id));
  if (other.length) out.push({ id: "other", title: "其他", sections: other.map(s => s.id), list: other });
  return [...out, { id: "long", title: "长期走势", sections: [], list: [] }];
});
const active = ref("use");
const pageRoot = ref<HTMLElement>();
function jump(id: string) {
  active.value = id;
  pageRoot.value?.querySelector<HTMLElement>(`#chapter-${id}`)?.scrollIntoView({ block: "start", behavior: "smooth" });
}
// The chapter at the top of the view is the one marked in the row.
let observer: IntersectionObserver | null = null;
watch(() => [data.value, tab.value], () => void nextTick(() => {
  observer?.disconnect();
  const els = pageRoot.value?.querySelectorAll<HTMLElement>(".chapter") ?? [];
  if (!els.length) return;
  observer = new IntersectionObserver((entries) => {
    const seen = entries.filter(e => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
    if (seen) active.value = seen.target.id.replace(/^chapter-/, "");
  }, { rootMargin: "-64px 0px -65% 0px" });
  els.forEach(el => observer!.observe(el));
}));
onBeforeUnmount(() => observer?.disconnect());

// ---- how a section's numbers are laid out
// Plain numbers are figures. Numbers the server marked as cells of a table become rows of bars: the
// columns in the first column's unit are bars side by side (each in its own colour, its value at the
// bar's end), the others (a rate, hours) text at the row's end. A chart whose every point is already
// shown as a figure or a cell is not drawn a second time. Every bar, figure and cell opens its drawer.
const figures = (s: Section): MetricItem[] => s.metrics.filter(m => !m.cell).map(m => figure(m));
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
/** Charts first (a course, a comparison), tables after; computed once per report. */
const laid = computed(() => new Map((data.value?.sections ?? []).map(s => {
  const blocks = [...chartBlocks(s, data.value?.scenes ?? []), ...tableBlocks(s)].filter(b => !b.empty).map(b => localize(named(b)));
  // What a section shows before it is opened: its main chart or two (a wide one counts as two), a
  // ranking's first rows, and up to six figures (not those already at the top of the page).
  let room = 2, lead = 0;
  for (const b of blocks) { const w = b.wide ? 2 : 1; if (lead && w > room) break; room -= w; lead++; if (room <= 0) break; }
  const figs = figures(s).filter((_, i) => !keyKeys.value.has(s.metrics.filter(m => !m.cell)[i].key));
  const short = blocks.map(b => b.kind === "rows" && b.spec.labels.length > ROWS ? { ...b, spec: firstRows(b.spec, ROWS) } : b);
  const cut = short.slice(0, lead).reduce((n, b, i) => n + (b === blocks[i] ? 0 : 1), 0);
  return [s.id, { figs, leadFigs: figs.slice(0, 6), blocks, leadBlocks: short.slice(0, lead), hidden: blocks.length - lead + Math.max(0, figs.length - 6) + cut }];
})));
/** A ranking shows this many rows until its section is opened. */
const ROWS = 8;
function firstRows(spec: Block["spec"], n: number): Block["spec"] {
  return { ...spec, labels: spec.labels.slice(0, n), series: spec.series.map(x => ({ ...x, values: x.values.slice(0, n), ...(x.links ? { links: x.links.slice(0, n) } : {}) })),
    ...(spec.links ? { links: spec.links.slice(0, n) } : {}), ...(spec.extras ? { extras: spec.extras.map(e => ({ ...e, values: e.values.slice(0, n), ...(e.links ? { links: e.links.slice(0, n) } : {}) })) } : {}) };
}
/** Spaces read by their names. */
const spaceName = (id: string) => state.spaces.find(s => s.id === id)?.name ?? id;
const named = (b: Block): Block => b.spec.title === "空间" ? { ...b, spec: { ...b.spec, labels: b.spec.labels.map(spaceName) } } : b;
const opened = reactive(new Set<string>());
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

// ---- the owner's own assumption, kept in this browser only
const estimate = ref("");
try { estimate.value = localStorage.getItem("omem.insights.minutes") ?? ""; } catch { /* storage may be turned off */ }
watch(estimate, v => { try { if (v) localStorage.setItem("omem.insights.minutes", v); else localStorage.removeItem("omem.insights.minutes"); } catch { /* storage may be turned off */ } });
const assumedMinutes = computed(() => Number(estimate.value) > 0 && Number.isFinite(Number(estimate.value)) ? Number(estimate.value) : null);
const answered = computed(() => allMetrics.value.find(m => m.key === "shield:answered")?.value);
</script>

<template>
  <div ref="pageRoot" class="page data">
    <div class="page-head">
      <div class="grow">
        <h1>数据</h1>
        <p v-if="tab === 'work'">你工作上的数：助手按观测计划定义，按时去各系统取。</p>
        <p v-else>omem 和机器人这段时间做了什么。点任何一个数，看它是怎么来的。</p>
      </div>
    </div>

    <div class="bar">
      <UiSegmented :model-value="tab" :options="tabs" aria-label="看哪类数据" @update:model-value="setTab" />
      <span class="grow" />
      <MetricFiles v-if="tab === 'work'" />
      <template v-else>
        <UiSegmented :model-value="period" :options="periods" size="sm" aria-label="看哪一段时间" @update:model-value="choosePeriod" />
        <UiCheckbox :model-value="q('compare') === 'true'" switch @update:model-value="setFilter('compare', $event)">和上一段比</UiCheckbox>
        <button type="button" class="btn ghost sm" :aria-expanded="showFilters" @click="showFilters = !showFilters">筛选{{ activeFilters ? `（${activeFilters}）` : "" }}</button>
        <div ref="exportBox" class="export">
          <button type="button" class="btn ghost sm" aria-haspopup="menu" :aria-expanded="exportOpen" @click="exportOpen = !exportOpen">导出<Icon name="down" :size="13" /></button>
          <div v-if="exportOpen" class="export-menu" role="menu" @keydown.esc="exportOpen = false">
            <a role="menuitem" :href="exportUrl('md')" @click="exportOpen = false">Markdown<span class="muted small">报告</span></a>
            <a role="menuitem" :href="exportUrl('csv')" @click="exportOpen = false">CSV<span class="muted small">表格</span></a>
          </div>
        </div>
      </template>
    </div>

    <MetricsBoard v-if="tab === 'work'" scope="work" :focus="q('metric') || undefined" />
    <template v-else>
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

      <p v-if="error" class="err" role="alert">{{ error }} <button type="button" class="btn sm" @click="load">重试</button></p>
      <template v-if="loading">
        <Skeleton :rows="2" />
        <section v-for="n in 3" :key="n" class="chapter"><Skeleton :rows="4" /></section>
      </template>

      <template v-else-if="data">
        <section class="keys" aria-label="关键的数">
          <p class="range muted small">{{ data.from }} 至 {{ data.to }}<template v-if="data.owner === false"> · 只有你自己触发的、和你有权看的部分</template></p>
          <MetricRow v-if="keyFigures.length" :items="keyFigures" />
        </section>

        <nav class="chapters" aria-label="跳到">
          <button v-for="c in chapters" :key="c.id" type="button" class="chip" :aria-current="active === c.id ? 'true' : undefined" @click="jump(c.id)">{{ c.title }}</button>
        </nav>

        <section v-for="c in chapters.filter(x => x.id !== 'long')" :id="`chapter-${c.id}`" :key="c.id" class="chapter" :aria-labelledby="`h-${c.id}`">
          <h2 :id="`h-${c.id}`" class="eyebrow">{{ c.title }}</h2>
          <div v-for="s in c.list" :key="s.id" class="sec">
            <div class="sec-head">
              <h3>{{ s.title }}</h3>
              <HelpText>{{ s.description }}</HelpText>
            </div>
            <p v-if="s.error" role="alert" class="err">这一块没算出来。<button type="button" class="btn sm" @click="load">重试</button></p>
            <p v-else-if="s.empty" class="muted small">{{ s.empty }}</p>
            <template v-else-if="laid.get(s.id)">
              <MetricRow v-if="laid.get(s.id)!.figs.length" :items="opened.has(s.id) ? laid.get(s.id)!.figs : laid.get(s.id)!.leadFigs" even />
              <div v-if="laid.get(s.id)!.blocks.length" class="blocks">
                <div v-for="b in opened.has(s.id) ? laid.get(s.id)!.blocks : laid.get(s.id)!.leadBlocks" :key="b.key" class="block" :class="{ wide: b.wide }">
                  <RankBars v-if="b.kind === 'rows'" v-bind="b.spec" :table="false" />
                  <BarChart v-else-if="b.kind === 'bars'" v-bind="b.spec" />
                  <TrendChart v-else v-bind="b.spec" />
                </div>
              </div>
              <div class="sec-foot">
                <button v-if="laid.get(s.id)!.hidden > 0 || opened.has(s.id)" type="button" class="linkish" :aria-expanded="opened.has(s.id)" @click="opened.has(s.id) ? opened.delete(s.id) : opened.add(s.id)">
                  {{ opened.has(s.id) ? "收起" : `展开这一节 · 还有 ${laid.get(s.id)!.hidden} 项` }}
                </button>
                <details v-if="notes(s).length" class="how">
                  <summary>怎么数的</summary>
                  <ul><li v-for="n in notes(s)" :key="n">{{ n }}</li></ul>
                </details>
              </div>
            </template>
          </div>
          <div v-if="c.id === 'notify'" class="sec notify-effect">
            <!-- NotifyEffect 接在这里（提醒一节的最后，和上面的“替你挡了多少”同一层） -->
          </div>
        </section>

        <section id="chapter-long" class="chapter" aria-labelledby="h-long">
          <h2 id="h-long" class="eyebrow">长期走势</h2>
          <div class="sec">
            <div class="sec-head">
              <h3>每天存下的用量</h3>
              <HelpText>omem 每天存一份自己的用量，原始记录过期以后这些走势还在。点一个数，看它按天的走势和拆开的各部分。</HelpText>
            </div>
            <MetricsBoard scope="omem" :focus="q('metric') || undefined" />
          </div>
        </section>

        <footer class="foot">
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
        </footer>
      </template>

      <InsightDrawer v-if="q('detail')" :metric="q('detail')" :filters="query.toString()" @close="closeDetail" />
    </template>
  </div>
</template>

<style scoped>
/* The page is on --bg, not on a panel: the ring around a chart's dots takes its colour. */
.data { min-width: 0; --chart-surface: var(--bg); }
.bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; margin: -4px 0 24px; min-width: 0; }
.grow { flex: 1; }
.export { position: relative; }
.export > .btn { gap: 4px; }
.export-menu { position: absolute; top: calc(100% + 4px); right: 0; z-index: 20; min-width: 168px; display: grid; padding: 4px; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12); }
.export-menu a { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; padding: 6px 10px; border-radius: 6px; color: inherit; text-decoration: none; font-size: 13px; }
.export-menu a:hover, .export-menu a:focus-visible { background: var(--hover); }
.toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; margin-bottom: 16px; }
.filters { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 12px; padding: 16px 0; margin-bottom: 16px; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); }
.filters-foot { grid-column: 1 / -1; display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
.err { color: var(--danger); font-size: 13px; }

.keys { display: grid; gap: 12px; margin-bottom: 8px; }
.keys .range { margin: 0; }
.chapters { position: sticky; top: 0; z-index: 5; display: flex; gap: 4px; margin: 16px 0 0; padding: 8px 0; background: var(--bg); border-bottom: 1px solid var(--line); overflow-x: auto; scrollbar-width: none; }
.chip { flex: none; height: 28px; padding: 0 12px; border: 0; border-radius: 999px; background: none; color: var(--ink-2); font: inherit; font-size: 13px; cursor: pointer; }
.chip:hover { background: var(--hover); color: var(--ink); }
.chip[aria-current="true"] { background: var(--sunken); color: var(--ink); font-weight: 600; }
.chip:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }

.chapter { display: flex; flex-direction: column; gap: 24px; padding: 32px 0 8px; scroll-margin-top: 52px; min-width: 0; }
.chapter + .chapter { border-top: 1px solid var(--line); }
.chapter > h2.eyebrow { margin: 0; font-size: 12px; font-weight: 500; letter-spacing: .14em; color: var(--muted); }
.chapter > h2 + .sec, .chapter > h2 + .help-text { margin-top: -16px; }
.sec { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
.sec + .sec { padding-top: 24px; border-top: 1px dashed var(--line); }
.notify-effect:empty { display: none; }
.sec-head { display: grid; gap: 4px; max-width: 56em; min-width: 0; }
.sec-head h3 { margin: 0; font-size: 15px; font-weight: 650; }
.sec > p { margin: 0; }

.blocks { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 32px; align-items: stretch; }
.block { min-width: 0; }
.block.wide { grid-column: 1 / -1; }
.sec-foot { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 24px; }
.sec-foot:empty { display: none; }
.linkish { font: inherit; font-size: 13px; color: var(--accent); background: none; border: 0; padding: 0; cursor: pointer; }
.linkish:hover { text-decoration: underline; text-underline-offset: 3px; }
.linkish:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 2px; }

.how { font-size: 12px; color: var(--muted); }
.how summary { cursor: pointer; width: fit-content; }
.how ul { margin: 8px 0 0; padding-left: 1.3em; }
.how li { margin: 4px 0; max-width: 56em; line-height: 1.6; overflow-wrap: anywhere; }
.how p { margin: 8px 0; max-width: 56em; line-height: 1.6; }
.how dl { margin: 8px 0 0; }
.how dt { color: var(--ink-2); }
.how dd { margin: 0 0 8px; overflow-wrap: anywhere; }
.estimate { max-width: 280px; margin: 8px 0; }
.foot { display: grid; gap: 8px; margin-top: 32px; padding-top: 16px; border-top: 1px solid var(--line); }
.foot > p { margin: 0; }

@media (max-width: 760px) {
  .blocks { grid-template-columns: minmax(0, 1fr); gap: 24px; }
  .bar { margin-bottom: 16px; }
}
</style>
