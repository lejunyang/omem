<script setup lang="ts">
/**
 * One metric opened under its row (components/MetricsBoard): on the left its chart, drawn the way its
 * view says (a count split many ways as its daily total; a day or two as text; nothing yet as how and
 * when it will be taken); on the right what it is — why, where from, how it is read, its baseline, how
 * often, who defined it; under both, the metric split by each of its dimensions. 保留 / 改 / 不要 (or
 * 暂停) sit at the top right. The board owns Esc and the focus; this asks it to close.
 */
import { computed, nextTick, ref, watch } from "vue";
import { full, type ChartSpec, type MetricItem } from "@omem-ai/plugin-sdk/charts";
import { get, put } from "../api";
import { promptDialog } from "../lib/dialog";
import { additive, dimName, dimValue, KINDS, kindLabel, notYetLong, origin, SCHEDULE, SCHEDULES, when, type Metric, type MetricDetail, type MetricView, type ViewKind } from "../lib/metrics";
import Chart from "./charts/Chart.vue";
import MetricRow from "./charts/MetricRow.vue";
import RankBars from "./charts/RankBars.vue";
import Icon from "./Icon.vue";
import Markdown from "./Markdown.vue";
import Skeleton from "./Skeleton.vue";
import UiCheckbox from "./UiCheckbox.vue";
import UiSegmented from "./UiSegmented.vue";
import UiSelect from "./UiSelect.vue";

const props = defineProps<{ metric: Metric; work: boolean; item?: string }>();
const emit = defineEmits<{ close: []; changed: [dropped: boolean]; editing: [on: boolean] }>();
const root = ref<HTMLElement>();
const m = computed(() => props.metric);
const days = ref(30);
const detail = ref<MetricDetail | null>(null);
const failed = ref("");
let seq = 0;

async function load() {
  const n = ++seq;
  detail.value = null;
  failed.value = "";
  try {
    const r = await get<MetricDetail>(`/api/metrics/${encodeURIComponent(m.value.id)}?days=${days.value}`);
    if (n === seq) detail.value = r;
  } catch (e) {
    if (n === seq) failed.value = (e as Error).message;
  }
}
watch(() => [m.value.id, m.value.view, days.value], load, { immediate: true, deep: true });

const unitText = computed(() => (m.value.unit === "%" ? "%" : m.value.unit ? ` ${m.value.unit}` : ""));
const per = computed(() => (m.value.schedule === "hourly" ? "小时" : "天"));
const fewDays = computed(() => (detail.value && detail.value.kind !== "table" && detail.value.table.labels.length <= 2 ? detail.value.table.labels.length : 0));
/** A day or two: the values with their dates, not a near-empty chart. */
const fewLines = computed(() => {
  const t = detail.value?.table;
  if (!t) return [];
  const many = t.series.length > 1 && !m.value.view?.compareBy && additive(m.value);
  return t.labels.map((l, i) => {
    if (many) return { label: l, text: `合计 ${full(t.series.reduce((a, s) => a + (s.values[i] ?? 0), 0))}${unitText.value}` };
    return { label: l, text: t.series.flatMap((s) => (s.values[i] === null ? [] : [`${t.series.length > 1 ? `${seriesName(s.name)} ` : ""}${full(s.values[i]!)}${unitText.value}`])).join(" / ") };
  });
});
const numberItems = computed<MetricItem[]>(() => {
  const t = detail.value?.table;
  if (!t || !t.labels.length) return [];
  const i = t.labels.length - 1;
  return t.series.filter((s) => s.values[i] !== null).slice(0, 8).map((s) => ({ label: t.series.length > 1 ? seriesName(s.name) : m.value.name, value: full(s.values[i]!), unit: m.value.unit, note: t.labels[i] }));
});
const tableRows = computed(() => {
  const t = detail.value?.table;
  if (!t) return [];
  return t.labels.map((l, i) => ({ label: l, cells: t.series.map((s) => (s.values[i] === null ? "—" : full(s.values[i]!))) })).reverse();
});
/** A series named by a combination of dimension values (`a / b / c`) reads with each value's own words. */
function seriesName(name: string) {
  const dims = detail.value?.points.find((p) => Object.values(p.dims).join(" / ") === name)?.dims;
  return dims ? Object.entries(dims).map(([k, v]) => dimValue(m.value, k, v)).join(" · ") : name;
}
/**
 * The charts: a count split many ways without a chosen grouping is drawn as its total per day (the
 * splits are under it); everything else as the server drew it by the view.
 */
const charts = computed<ChartSpec[]>(() => {
  const d = detail.value;
  if (!d) return [];
  const t = d.table;
  if (t.series.length > 1 && !m.value.view?.compareBy && additive(m.value)) {
    const kind = m.value.view?.kind;
    const col = m.value.source === "omem" || kind === "bar" || kind === "stack" || !kind;
    return [{ kind: col ? "bar" : kind === "area" ? "area" : "line", title: `每${per.value}合计`, unit: m.value.unit, caption: col ? `一根一${per.value}` : `一个点一${per.value}`, labels: t.labels, series: [{ name: "合计", values: t.labels.map((_, i) => t.series.reduce((a, s) => a + (s.values[i] ?? 0), 0)) }] }];
  }
  return d.charts.map((c) => ({ ...c, title: c.title === m.value.name ? undefined : c.title, series: c.series.map((s) => ({ ...s, name: seriesName(s.name) })), labels: c.kind === "pie" ? c.labels.map(seriesName) : c.labels }));
});
/** Each dimension on its own: its groups added up (or averaged, for rates) over the days shown. */
const splits = computed(() => {
  const d = detail.value;
  if (!d) return [];
  const keys = [...new Set(d.points.flatMap((p) => Object.keys(p.dims)))];
  const add = additive(m.value);
  return keys.flatMap((k) => {
    const by = new Map<string, { sum: number; n: number }>();
    for (const p of d.points) {
      const v = p.dims[k] ? dimValue(m.value, k, p.dims[k]) : "（没分）";
      const g = by.get(v) ?? { sum: 0, n: 0 };
      g.sum += p.value;
      g.n++;
      by.set(v, g);
    }
    if (by.size < 2) return [];
    const rows = [...by].map(([label, g]) => ({ label, value: Math.round((add ? g.sum : g.sum / g.n) * 10) / 10 })).sort((a, b) => b.value - a.value);
    return [{ key: k, title: `按${dimName(m.value, k)}`, caption: `${days.value} 天${add ? "合计" : "平均"}`, rows: rows.slice(0, 10), more: rows.length - 10 }];
  });
});

function viewText(v: MetricView | null) {
  if (!v) return "走势线";
  return `${kindLabel(v.kind)}${v.compareBy ? `，按 ${v.compareBy} 分组` : ""}${v.focus ? `，格子上显示“${v.focus}”` : ""}${v.ratio ? "，另画占比" : ""}`;
}
const planLink = computed(() => (m.value.planRef ? `[${(m.value.plan?.title ?? "观测计划").replace(/[[\]]/g, "")}](${m.value.planRef})` : ""));
const longQuery = computed(() => m.value.query.length > 180 || m.value.query.split("\n").length > 3);
const queryOpen = ref(false);

// ---- 保留 / 改 / 不要
const saving = ref(false);
const error = ref("");
async function save(body: Record<string, unknown>, dropped = false) {
  saving.value = true;
  error.value = "";
  try {
    await put(`/api/metrics/${encodeURIComponent(m.value.id)}`, body);
    setEditing(null);
    emit("changed", dropped);
    return true;
  } catch (e) {
    error.value = (e as Error).message;
    return false;
  } finally {
    saving.value = false;
  }
}
async function drop() {
  const note = await promptDialog(`不要「${m.value.name}」？`, { message: "不再取数，也不在这里显示。为什么不要？（可以不填，助手以后提指标时会参考）", placeholder: "例如：曝光说明不了问题，看完成率就够了", okText: "不要了", danger: true });
  if (note === null) return;
  await save({ status: "dropped", ...(note.trim() ? { note: note.trim() } : {}) }, true);
}

type Form = { name: string; unit: string; why: string; schedule: string; threshold: number; direction: string; kind: ViewKind; compareBy: string; focus: string; ratio: boolean };
const editing = ref<Form | null>(null);
function setEditing(f: Form | null) {
  editing.value = f;
  emit("editing", !!f);
}
const THRESHOLDS = [0.1, 0.2, 0.3, 0.5, 1];
const thresholdOptions = computed(() => {
  const cur = editing.value?.threshold;
  const xs = [...new Set([...THRESHOLDS, ...(cur !== undefined ? [cur] : [])])].sort((a, b) => a - b);
  return xs.map((x) => ({ value: x, label: `${Math.round(x * 100)}%` }));
});
const dimNames = computed(() => [...new Set((detail.value?.points ?? []).flatMap((p) => Object.keys(p.dims)))]);
const dimValues = (dim: string) => [...new Set((detail.value?.points ?? []).map((p) => p.dims[dim]).filter((v): v is string => !!v))];
function startEdit() {
  const x = m.value;
  setEditing({ name: x.name, unit: x.unit, why: x.why, schedule: x.schedule, threshold: x.threshold ?? 0.3, direction: x.direction ?? "neutral", kind: x.view?.kind ?? "line", compareBy: x.view?.compareBy ?? "", focus: x.view?.focus ?? "", ratio: !!x.view?.ratio });
  void nextTick(() => root.value?.querySelector<HTMLInputElement>(".edit input")?.focus());
}
function submitEdit(andKeep: boolean) {
  const f = editing.value;
  if (!f) return;
  const view: MetricView = { kind: f.kind, ...(f.compareBy ? { compareBy: f.compareBy } : {}), ...(f.compareBy && f.focus ? { focus: f.focus } : {}), ...(f.ratio ? { ratio: true } : {}) };
  void save({ name: f.name.trim(), unit: f.unit.trim(), why: f.why.trim(), schedule: f.schedule, threshold: f.threshold, direction: f.direction, view, ...(andKeep ? { status: "active" } : {}) });
}
/** Esc from the board: the form first. */
function escape() {
  if (!editing.value) return false;
  setEditing(null);
  return true;
}
defineExpose({ escape });
</script>

<template>
  <div ref="root" class="md" role="region" :aria-label="`${metric.name}的详情`">
    <header class="md-head">
      <div class="md-title">
        <strong>{{ metric.name }}</strong>
        <span class="muted small">{{ origin(metric) }}</span>
      </div>
      <UiSegmented v-model="days" size="sm" aria-label="看多少天" :options="[{ value: 7, label: '7 天' }, { value: 30, label: '30 天' }, { value: 90, label: '90 天' }]" />
      <div v-if="work && !editing" class="md-acts">
        <template v-if="metric.status === 'proposed'">
          <button type="button" class="btn primary sm" :disabled="saving" @click="save({ status: 'active' })">保留</button>
          <button type="button" class="btn ghost sm" :disabled="saving" @click="startEdit">改</button>
          <button type="button" class="btn danger sm" :disabled="saving" @click="drop">不要</button>
        </template>
        <template v-else>
          <button type="button" class="btn ghost sm" @click="startEdit">改</button>
          <button v-if="metric.status === 'active'" type="button" class="btn ghost sm" :disabled="saving" @click="save({ status: 'paused' })">暂停取数</button>
          <button v-else-if="metric.status === 'paused'" type="button" class="btn ghost sm" :disabled="saving" @click="save({ status: 'active' })">接着取数</button>
          <button v-if="metric.definedBy !== 'omem'" type="button" class="btn danger sm" :disabled="saving" @click="drop">不要</button>
        </template>
      </div>
      <button type="button" class="btn ghost sm icon md-close" aria-label="收起" title="收起（Esc）" @click="emit('close')"><Icon name="x" :size="15" /></button>
    </header>
    <p v-if="error && !editing" class="err small" role="alert">{{ error }}</p>

    <form v-if="editing" class="edit" @submit.prevent="submitEdit(metric.status === 'proposed')">
      <div class="edit-grid">
        <label class="field"><span>名字</span><input v-model="editing.name" class="input" maxlength="120" required /></label>
        <label class="field narrow"><span>单位</span><input v-model="editing.unit" class="input" maxlength="20" placeholder="次、%、单" /></label>
        <label class="field wide"><span>它回答什么问题</span><textarea v-model="editing.why" class="textarea" rows="2" maxlength="300" placeholder="例如：部分发货改造上线后，退款接口有没有更容易出错" /></label>
        <div class="field"><span>取数</span><UiSelect v-model="editing.schedule" :options="SCHEDULES" aria-label="取数频率" /></div>
        <div class="field"><span>变化超过多少告诉你</span><UiSelect v-model="editing.threshold" :options="thresholdOptions" aria-label="门槛" /></div>
        <div class="field wide"><span>哪个方向是好的</span><UiSegmented v-model="editing.direction" size="sm" aria-label="哪个方向是好的" :options="[{ value: 'up-good', label: '变多是好' }, { value: 'down-good', label: '变少是好' }, { value: 'neutral', label: '不分好坏' }]" /></div>
        <div class="field"><span>画法</span><UiSelect v-model="editing.kind" :options="KINDS" aria-label="画法" /></div>
        <div v-if="dimNames.length" class="field"><span>按哪个维度分组</span><UiSelect v-model="editing.compareBy" :options="[{ value: '', label: '每种维度组合一条' }, ...dimNames.map((d) => ({ value: d, label: d }))]" aria-label="按哪个维度分组" /></div>
        <div v-if="editing.compareBy" class="field"><span>格子上显示哪一组</span><UiSelect v-model="editing.focus" :options="[{ value: '', label: '第一组' }, ...dimValues(editing.compareBy).map((v) => ({ value: v, label: v }))]" aria-label="格子上显示哪一组" /></div>
        <div v-if="editing.compareBy || dimNames.length" class="field check"><UiCheckbox v-model="editing.ratio" switch>另画一张各组的占比</UiCheckbox></div>
      </div>
      <p v-if="error" class="err small">{{ error }}</p>
      <div class="row wrap acts">
        <button v-if="metric.status === 'proposed'" type="submit" class="btn primary sm" :disabled="saving">保存并保留</button>
        <button type="button" :class="['btn', 'sm', metric.status === 'proposed' ? 'ghost' : 'primary']" :disabled="saving" @click="submitEdit(false)">{{ metric.status === "proposed" ? "只保存，先不定" : "保存" }}</button>
        <button type="button" class="btn ghost sm" @click="setEditing(null)">取消</button>
      </div>
    </form>

    <div class="md-body">
      <div class="md-chart">
        <Skeleton v-if="!detail && !failed" variant="lines" :rows="4" />
        <p v-else-if="failed" class="err small" role="alert">{{ failed }} <button type="button" class="btn sm" @click="load">重试</button></p>
        <template v-else-if="detail">
          <p v-if="!detail.table.labels.length" class="nodata">还没有数。{{ notYetLong(metric, work) }}</p>
          <div v-else-if="fewDays" class="few">
            <span class="few-head">只有 {{ fewDays }} {{ metric.schedule === "hourly" ? "个小时" : "天" }}的数</span>
            <span v-for="l in fewLines" :key="l.label" class="few-line"><span class="few-day">{{ l.label }}</span>{{ l.text }}</span>
            <span class="muted small">数多了以后画成{{ kindLabel(detail.kind) }}。</span>
          </div>
          <MetricRow v-else-if="detail.kind === 'number'" :items="numberItems" />
          <div v-else-if="detail.kind === 'table'" class="tbl">
            <table>
              <thead><tr><th>{{ metric.schedule === "hourly" ? "时间" : "日期" }}</th><th v-for="s in detail.table.series" :key="s.name" class="num">{{ seriesName(s.name) }}{{ metric.unit ? `（${metric.unit}）` : "" }}</th></tr></thead>
              <tbody><tr v-for="r in tableRows" :key="r.label"><th>{{ r.label }}</th><td v-for="(c, i) in r.cells" :key="i" class="num">{{ c }}</td></tr></tbody>
            </table>
          </div>
          <div v-else class="charts">
            <Chart v-for="(c, i) in charts" :key="`${metric.id}:${days}:${i}`" :spec="c" />
          </div>
        </template>
      </div>

      <dl class="facts">
        <template v-if="metric.why"><dt>为什么看</dt><dd>{{ metric.why }}</dd></template>
        <template v-if="metric.description && metric.description !== metric.why"><dt>说明</dt><dd>{{ metric.description }}</dd></template>
        <template v-if="metric.source && work"><dt>从哪来</dt><dd>{{ metric.source }}</dd></template>
        <template v-if="metric.query && work">
          <dt>怎么查</dt>
          <dd>
            <span class="query" :class="{ clamp: longQuery && !queryOpen }">{{ metric.query }}</span>
            <button v-if="longQuery" type="button" class="linkish small" :aria-expanded="queryOpen" @click="queryOpen = !queryOpen">{{ queryOpen ? "收起" : "看全部" }}</button>
          </dd>
        </template>
        <template v-if="work"><dt>基线</dt><dd>{{ metric.baseline != null ? `${metric.baseline}${unitText}` : "前 7 个点的中位数" }}，变化超过 {{ Math.round((metric.threshold ?? 0.3) * 100) }}%{{ metric.status === "active" ? "告诉你" : "算越过（确认后才告诉你）" }}</dd></template>
        <dt>多久取一次</dt>
        <dd>{{ metric.source === "omem" ? "每天统计一次" : SCHEDULE[metric.schedule] ?? metric.schedule }}{{ metric.status === "paused" ? "（暂停中）" : "" }}<span class="muted">{{ metric.lastAt ? ` · 上次 ${when(metric.lastAt)}` : " · 还没取过" }}{{ metric.nextAt && metric.lastAt ? ` · 下次约 ${when(metric.nextAt)}` : "" }}</span></dd>
        <template v-if="metric.itemId && metric.itemId !== item"><dt>挂在</dt><dd><a :href="`#/work/${metric.itemId}`">{{ metric.itemTitle ?? "事项" }}</a></dd></template>
        <template v-if="planLink"><dt>观测计划</dt><dd><Markdown class="plan-ref" :source="planLink" :linkify="false" /></dd></template>
        <dt>谁定的</dt><dd>{{ origin(metric) }}<template v-if="metric.definedRun"> · <a :href="`#/runs/${metric.definedRun}`">那次运行</a></template></dd>
        <template v-if="work"><dt>画法</dt><dd>{{ viewText(metric.view) }}</dd></template>
      </dl>
    </div>

    <div v-if="splits.length" class="splits">
      <div v-for="s in splits" :key="s.key" class="split">
        <RankBars :title="s.title" :caption="s.caption" :unit="metric.unit" :items="s.rows" :name="metric.name" :table="false" />
        <p v-if="s.more > 0" class="muted small">另有 {{ s.more }} 组没列出</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.md { display: grid; gap: 16px; padding: 16px 0 8px; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); min-width: 0; }
.md-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; min-width: 0; }
.md-title { flex: 1 1 240px; display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; min-width: 0; }
.md-title strong { font-size: 15px; font-weight: 650; overflow-wrap: anywhere; }
.md-acts { display: flex; gap: 8px; }
.md-body { display: grid; grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); gap: 24px 32px; align-items: start; min-width: 0; }
.md-chart { min-width: 0; }
.charts { display: grid; gap: 24px; min-width: 0; }
.nodata { margin: 0; color: var(--ink-2); font-size: 14px; line-height: 1.6; }
.few { display: grid; gap: 4px; font-size: 14px; }
.few-head { color: var(--muted); font-size: 12px; letter-spacing: .1em; }
.few-line { font-variant-numeric: tabular-nums; color: var(--ink); overflow-wrap: anywhere; }
.few-day { display: inline-block; min-width: 4.2em; color: var(--muted); }
.tbl { overflow-x: auto; max-width: 100%; }
.tbl table { border-collapse: collapse; font-size: 13px; }
.tbl th, .tbl td { border-bottom: 1px solid var(--line); padding: 4px 16px 4px 0; text-align: left; font-weight: 400; white-space: nowrap; }
.tbl thead th { color: var(--muted); font-weight: 550; }
.tbl .num { text-align: right; font-variant-numeric: tabular-nums; }
.facts { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 8px 16px; margin: 0; font-size: 13px; line-height: 1.6; }
.facts dt { color: var(--muted); }
.facts dd { margin: 0; overflow-wrap: anywhere; min-width: 0; color: var(--ink-2); }
.query { display: block; white-space: pre-wrap; font-family: var(--mono); font-size: 12px; color: var(--ink-2); }
.query.clamp { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow: hidden; }
.linkish { font: inherit; color: var(--accent); background: none; border: 0; padding: 0; cursor: pointer; }
.linkish:hover { text-decoration: underline; }
.plan-ref :deep(p) { margin: 0; }
.splits { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 24px 32px; padding-top: 16px; border-top: 1px dashed var(--line); min-width: 0; }
.split { min-width: 0; display: grid; gap: 4px; align-content: start; }
.split p { margin: 0; }
.edit { display: grid; gap: 12px; padding: 12px 16px; border: 1px solid var(--line); border-radius: 10px; background: var(--panel); min-width: 0; }
.edit-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px 16px; }
.edit-grid .wide { grid-column: 1 / -1; }
.edit-grid .check { align-self: end; padding-bottom: 4px; }
.edit-grid .ui-seg { justify-self: start; max-width: 100%; }
.acts { gap: 8px; }
.err { color: var(--danger); margin: 0; }
@media (max-width: 760px) {
  .md-body { grid-template-columns: minmax(0, 1fr); }
  .md-title { flex: 1 1 calc(100% - 48px); }
  .md-close { order: 1; }
  .md-head > :not(.md-title):not(.md-close) { order: 2; }
}
</style>
