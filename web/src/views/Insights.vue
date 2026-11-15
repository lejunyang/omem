<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { authUrl, get, type InsightsReport, type InsightRecord, type ViewComponent } from "../api";
import Skeleton from "../components/Skeleton.vue";
import UiSegmented from "../components/UiSegmented.vue";
import UiCheckbox from "../components/UiCheckbox.vue";
import UiSelect from "../components/UiSelect.vue";
import UiDateTime from "../components/UiDateTime.vue";
import UiView from "../components/UiView.vue";
import VirtualList from "../components/VirtualList.vue";

const route = useRoute(), router = useRouter();
const data = ref<InsightsReport>();
const loading = ref(true), error = ref("");
const records = ref<InsightRecord[]>([]), recordsTotal = ref(0), recordLoading = ref(false), recordError = ref("");
let seq = 0, detailSeq = 0;
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
    { key: "by", label: "人", values: options?.people ?? [] },
    { key: "scene", label: "场景", values: data.value?.scenes ?? [] },
    { key: "profile", label: "Agent 档案 / 角色", values: options?.profiles ?? [] },
    { key: "model", label: "模型", values: options?.models ?? [] },
    { key: "bot", label: "机器人", values: options?.bots ?? [] },
    { key: "chat", label: "触发会话", values: options?.chats ?? [] },
  ].map(f => ({ ...f, options: [{ value: "", label: "全部" }, ...[...new Set([...f.values, ...(q(f.key) ? [q(f.key)] : [])])].map(value => ({ value, label: value === "user:owner" ? "本人" : value }))] }));
});
const chartComponents = computed(() => Object.fromEntries((data.value?.sections ?? []).map(s => [s.id, s.charts.map(({ points, ...c }) => ({ type: "chart", ...c } as ViewComponent))])));
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
const detailMetric = computed(() => data.value?.sections.flatMap(s => s.metrics).find(m => m.key === q("detail")));
const estimate = ref("");
try { estimate.value = localStorage.getItem("omem.insights.minutes") ?? ""; } catch { /* 浏览器可禁用存储 */ }
watch(estimate, v => { try { if (v) localStorage.setItem("omem.insights.minutes", v); else localStorage.removeItem("omem.insights.minutes"); } catch { /* 浏览器可禁用存储 */ } });
const assumedMinutes = computed(() => Number(estimate.value) > 0 && Number.isFinite(Number(estimate.value)) ? Number(estimate.value) : null);
const answered = computed(() => data.value?.sections.flatMap(s => s.metrics).find(m => m.key === "shield:answered")?.value);
function exportUrl(format: string) { const params = new URLSearchParams(query.value); params.set("format", format); return authUrl(`/api/insights/export?${params}`); }
</script>

<template>
  <div class="page insights stack">
    <div class="page-head row wrap"><h1 class="grow">成效</h1><a class="btn" :href="exportUrl('md')">导出 Markdown</a><a class="btn" :href="exportUrl('csv')">导出 CSV</a></div>
    <p>omem 和机器人做了什么：次数、用时和结果都从记录里数，每项可看明细。{{ data?.owner === false ? '这里只显示你触发或拥有、且有权阅读的运行。' : '' }}</p>
    <div class="card pad stack">
      <div class="row wrap"><UiSegmented :model-value="period" :options="periods" aria-label="统计期间" @update:model-value="choosePeriod" /><UiCheckbox :model-value="q('compare') === 'true'" switch @update:model-value="setFilter('compare', $event)">和上一段比较</UiCheckbox></div>
      <div v-if="period === 'custom'" class="row wrap"><label class="field"><span>开始日期</span><UiDateTime :model-value="dateValue(q('from') || data?.from || '')" :clearable="false" aria-label="开始日期（只取日）" @update:model-value="selectDate('from', $event)" /></label><label class="field"><span>结束日期</span><UiDateTime :model-value="dateValue(q('to') || data?.to || '')" :clearable="false" aria-label="结束日期（只取日）" @update:model-value="selectDate('to', $event)" /></label></div>
      <div class="filters"><label v-for="f in filters" :key="f.key" class="field"><span>{{ f.label }}</span><UiSelect :model-value="q(f.key)" :options="f.options" :aria-label="f.label" @update:model-value="setFilter(f.key, $event)" /></label></div>
      <UiCheckbox :model-value="q('housekeeping') === 'true'" switch @update:model-value="setFilter('housekeeping', $event)">包含后台整理</UiCheckbox>
      <p class="muted small">{{ data ? `${data.from} 至 ${data.to} · ${data.timezone}` : '按设置中的时区统计，最多 180 天' }} · 缓存约三分钟；比较同样天数的上一段。</p>
    </div>
    <p v-if="error" role="alert">{{ error }} <button class="btn sm" @click="load">重试</button></p>
    <template v-if="loading"><section v-for="title in ['用量与覆盖', '用在哪', '替本人挡了多少', '给别人带来什么', '质量', '交付', '知识', '成本']" :key="title" class="card pad stack"><h2>{{ title }}</h2><Skeleton :rows="4" /></section></template>
    <template v-else-if="data">
      <section v-if="q('detail')" class="card pad stack detail" aria-label="统计明细">
        <div class="row wrap"><h2 class="grow">{{ detailMetric?.label ?? '统计' }} · 明细</h2><button class="btn sm" @click="setFilter('detail', '')">关闭</button></div>
        <p class="muted small">{{ detailMetric?.note ?? '只列记录标识、状态和时间；比例的明细列出分母样本。' }} 共 {{ recordsTotal }} 条记录。</p>
        <Skeleton v-if="recordLoading && !records.length" :rows="4" />
        <p v-else-if="recordError" role="alert">{{ recordError }} <button class="btn sm" @click="loadRecords()">重试</button></p>
        <p v-else-if="!records.length" class="muted">没有符合这项口径的记录。</p>
        <VirtualList :items="records" :item-key="r => r.id" :estimate="56"><template #default="{ item: r }"><div class="record row wrap"><a :href="r.link">{{ r.label }} · {{ r.id }}</a><time class="muted small">{{ r.at }}</time><span v-if="r.value !== undefined">{{ r.value }}</span></div></template></VirtualList>
        <button v-if="records.length < recordsTotal" class="btn" :disabled="recordLoading" @click="loadRecords(true)">{{ recordLoading ? '正在读取…' : '再看 100 条' }}</button>
      </section>
      <section v-for="s in data.sections" :key="s.id" class="card pad stack" :aria-labelledby="`insights-${s.id}`">
        <h2 :id="`insights-${s.id}`">{{ s.title }}</h2><p class="muted small">{{ s.description }}</p>
        <p v-if="s.error" role="alert">{{ s.error }} <button class="btn sm" @click="load">重试</button></p>
        <p v-else-if="s.empty" class="muted">{{ s.empty }}</p>
        <template v-else>
          <div class="tiles"><article v-for="m in s.metrics.slice(0, 4)" :key="m.key" class="tile stack"><span class="muted small">{{ m.label }}</span><strong>{{ m.value === null ? '—' : m.value }}<small>{{ m.unit }}</small></strong><span v-if="m.previous !== undefined" class="muted small">上一段 {{ m.previous ?? '—' }}{{ m.unit }}</span><span v-if="m.samples !== undefined" class="muted small">样本 {{ m.samples }} 个</span><a :href="m.link" class="small">看明细</a><span v-if="m.note" class="small muted">{{ m.note }}</span></article></div>
          <div v-for="(chart, ci) in s.charts" :key="chart.title" class="stack">
            <UiView :components="[chartComponents[s.id][ci]]" />
            <details v-if="chart.points?.length"><summary>{{ chart.title }} · 各数明细</summary><VirtualList :items="chart.points" :item-key="m => m.key" :estimate="48"><template #default="{ item: m }"><div class="metric-row"><span>{{ m.label }}</span><span>{{ m.value ?? '—' }}{{ m.unit }}</span><a :href="m.link">看明细</a></div></template></VirtualList></details>
          </div>
          <details v-if="s.metrics.length > 4"><summary>全部指标与明细</summary><VirtualList class="metrics-list" :items="s.metrics.slice(4)" :item-key="m => m.key" :estimate="64"><template #default="{ item: m }"><div class="metric-row"><span>{{ m.label }}<small v-if="m.note" class="muted">{{ m.note }}</small></span><span>{{ m.value ?? '—' }}{{ m.unit }}<small v-if="m.samples !== undefined" class="muted">样本 {{ m.samples }} 个</small><small v-if="m.previous !== undefined" class="muted">上一段 {{ m.previous ?? '—' }}{{ m.unit }}</small></span><a :href="m.link">看明细</a></div></template></VirtualList></details>
        </template>
        <p v-for="note in s.notes" :key="note" class="muted small">{{ note }}</p>
      </section>
      <details class="card pad"><summary>场景口径</summary><p class="muted small">固定按类型、档案或角色、触发方式归类，不读工具调用记录。已知角色细分通用 Agent，其余默认排查。</p><dl><template v-for="scene in data.scenes" :key="scene"><dt>{{ scene }}</dt><dd>{{ Object.entries(data.sceneTable).filter(([, value]) => value === scene).map(([kind]) => kind).join('、') || '由对应 Agent 角色识别' }}</dd></template></dl></details>
      <section v-if="data.owner" class="card pad stack"><h2>估算</h2><p class="muted small">自行填写换算假设，只保存在这个浏览器；留空不换算。</p><label class="field"><span>每次已代答按多少分钟算</span><input v-model="estimate" class="input" inputmode="decimal" placeholder="留空" aria-label="估算每次代答的分钟数" /></label><p v-if="assumedMinutes && answered !== undefined && answered !== null">估算：{{ Math.round(answered * assumedMinutes * 10) / 10 }} 分钟（{{ answered }} 个已代答样本 × 每次 {{ assumedMinutes }} 分钟）。这是自行假设的换算。</p></section>
      <p class="small muted">生成于 {{ data.generatedAt }}。访客和机器人的提问仅计数，成效接口与明细均不返回其正文。</p>
    </template>
  </div>
</template>

<style scoped>
.insights { max-width: 1100px; margin: 0 auto; min-width: 0; }
.insights :is(section, article, label, a, details, .row) { min-width: 0; overflow-wrap: anywhere; }
.filters { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.tiles { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
.tile { border: 1px solid var(--line); border-radius: 8px; padding: 12px; }
.tile strong { font-size: 26px; font-variant-numeric: tabular-nums; }
.tile small { font-size: 12px; margin-left: 3px; font-weight: 400; }
.insights :deep(.ui-view) { max-width: 100%; }
.metric-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(65px, auto) auto; gap: 12px; border-bottom: 1px solid var(--line); padding: 8px 0; font-size: 13px; }
.metric-row small { display: block; font-size: 12px; }
.metrics-list { margin-top: 10px; }
.record { border-bottom: 1px solid var(--line); padding: 8px 0; font-size: 13px; }
dd { margin: 4px 0 14px; font-size: 12px; color: var(--muted); overflow-wrap: anywhere; }
summary { cursor: pointer; }
@media (max-width: 760px) { .filters, .tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 430px) { .tile { padding: 10px; } }
</style>
