<script setup lang="ts">
/**
 * Metrics on the data page and on an item (src/data/metrics.ts, GET /api/metrics). `work`: the numbers
 * the owner's work is watched by — grouped by the work line (or matter) they hang on, with the
 * data-source catalog, observation plans, collection notes and reports they come from; `omem`: omem's
 * own daily usage (source `omem`); `item`: one item's metrics and those under it, and its reports.
 *
 * A figure is a button: it opens its details below its row (again, or Esc, closes them), drawn the
 * way the metric's view says (lines, columns, series side by side and their shares, the newest parts,
 * a table, the figures only; a day or two as text; nothing yet as how and when it will be taken), then
 * why it exists, where it comes from, how it is read, and — for one an agent proposed — 保留 / 改 / 不要.
 * The figures are computed once per load and keyed by metric, so opening one never redraws the row.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { compact, full, type ChartSpec, type MetricItem } from "@omem-ai/plugin-sdk/charts";
import { get, put } from "../api";
import { promptDialog } from "../lib/dialog";
import { fmt } from "../lib/time";
import MetricRow from "./charts/MetricRow.vue";
import Chart from "./charts/Chart.vue";
import Markdown from "./Markdown.vue";
import Skeleton from "./Skeleton.vue";
import UiCheckbox from "./UiCheckbox.vue";
import UiSegmented from "./UiSegmented.vue";
import UiSelect from "./UiSelect.vue";

type ViewKind = "line" | "area" | "bar" | "stack" | "compare" | "pie" | "table" | "number";
type View = { kind: ViewKind; compareBy?: string; ratio?: boolean; focus?: string };
type Change = { value: number; base: number | null; rel: number | null; flagged: boolean; good: boolean | null };
type Status = "active" | "paused" | "proposed" | "dropped";
type Metric = {
  id: string; name: string; unit: string; source: string; query: string; schedule: string; description: string; why: string; direction?: string; status: Status;
  baseline?: number; threshold?: number; lastAt: string | null; nextAt: string | null; change: Change | null; spark: number[]; figure: string | null;
  latest: { label: string; values: { name: string; value: number }[] } | null; points: number; view: View | null;
  planRef: string | null; plan: { id: string; title: string } | null; definedBy: "owner" | "agent" | "omem"; definedRun: string | null; confirmedAt: string | null; createdAt: string;
  itemId: string | null; itemTitle: string | null; lineId: string | null; lineTitle: string | null; spaceId: string;
};
type Table = { labels: string[]; series: { name: string; values: (number | null)[] }[] };
type Detail = { kind: ViewKind; charts: ChartSpec[]; table: Table; points: { dims: Record<string, string> }[] };
type DataFile = { id: string; title: string; path: string; kind: "catalog" | "plan" | "note" | "report"; itemId: string | null; spaceId: string; updatedAt: string };

const props = defineProps<{ scope: "work" | "omem"; focus?: string; item?: string }>();
const emit = defineEmits<{ count: [n: number] }>();
const root = ref<HTMLElement>();
const metrics = ref<Metric[]>([]);
const files = ref<DataFile[]>([]);
const loading = ref(true);
const filter = ref<"all" | "proposed">("all");
const open = ref<string | null>(null);
const detail = ref<Detail | null>(null);
const days = ref(30);
let seq = 0;

async function load() {
  const n = ++seq;
  const q = props.item ? `?item=${encodeURIComponent(props.item)}` : "";
  const [all, fs] = await Promise.all([
    get<Metric[]>(`/api/metrics${q}`).catch(() => [] as Metric[]),
    props.scope === "work" ? get<DataFile[]>(`/api/metrics/files${q}`).catch(() => [] as DataFile[]) : Promise.resolve([] as DataFile[]),
  ]);
  if (n !== seq) return;
  metrics.value = all.filter((m) => (props.scope === "omem") === (m.source === "omem"));
  files.value = fs;
  loading.value = false;
  emit("count", metrics.value.length + reports.value.length);
  if (!proposedCount.value) filter.value = "all";
  if (open.value && !metrics.value.some((m) => m.id === open.value)) close();
}
onMounted(async () => {
  await load();
  if (props.focus && metrics.value.some((m) => m.id === props.focus)) void show(props.focus);
});
watch(() => [props.scope, props.item], () => {
  close();
  loading.value = true;
  void load();
});

const SCHEDULE: Record<string, string> = { none: "按需取", hourly: "每小时", daily: "每天", weekly: "每周" };
const SCHEDULES = [{ value: "none", label: "按需取（用到时才取）" }, { value: "hourly", label: "每小时" }, { value: "daily", label: "每天" }, { value: "weekly", label: "每周" }];
const KINDS: { value: ViewKind; label: string }[] = [
  { value: "line", label: "走势线" }, { value: "area", label: "面积（看量）" }, { value: "bar", label: "每天一根柱" }, { value: "stack", label: "叠加的柱（看合计）" },
  { value: "compare", label: "几组并排" }, { value: "pie", label: "最近一次的构成" }, { value: "table", label: "只列数" }, { value: "number", label: "只看最新的数" },
];
const kindLabel = (k: ViewKind) => KINDS.find((x) => x.value === k)?.label ?? k;
const pct = (r: number) => `${r > 0 ? "+" : ""}${Math.round(r * 1000) / 10}%`;
const when = (iso: string) => fmt(iso, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
const shortDay = (iso: string) => fmt(iso, { month: "numeric", day: "numeric" });

/** How and when a metric with no numbers yet gets its first. */
function notYet(m: Metric, long = false) {
  if (m.status === "paused") return "暂停中，不取数";
  const from = m.source && props.scope === "work" ? `从${m.source}` : "";
  if (m.schedule === "none") return long ? `按需取：助手用到它时才${from}取一次。要按时看，点“改”把取数改成每天。` : `按需取 · 用到时才${from}取`;
  const soon = !m.nextAt || Date.parse(m.nextAt) - Date.now() < 15 * 60_000;
  const at = soon ? "几分钟内" : when(m.nextAt!);
  return long ? `${SCHEDULE[m.schedule]}${from}取一次，第一次在${at}（后台按“怎么查”起一轮只读的取数）。` : `${SCHEDULE[m.schedule]}${from}取 · 第一次在${at}`;
}

function tile(m: Metric): MetricItem {
  const has = m.points > 0;
  const others = m.latest && m.latest.values.length > 1 ? m.latest.values.filter((v) => v.name !== m.figure).slice(0, 2).map((v) => `${v.name} ${compact(v.value)}`) : [];
  const note = has
    ? [...others, props.scope === "work" && !others.length ? m.source || "来源没写" : "", SCHEDULE[m.schedule] ?? m.schedule, m.change?.flagged ? "越过门槛" : ""].filter(Boolean).join(" · ")
    : notYet(m);
  return {
    // Several series: the label says which one the number is, the others follow under it.
    label: m.figure && others.length ? `${m.name} · ${m.figure}` : m.name,
    value: m.change ? full(m.change.value) : "—",
    unit: m.unit,
    ...(m.change?.rel != null ? { change: pct(m.change.rel), trend: m.change.rel > 0 ? ("up" as const) : m.change.rel < 0 ? ("down" as const) : ("flat" as const) } : {}),
    good: m.direction === "up-good" ? ("up" as const) : m.direction === "down-good" ? ("down" as const) : ("none" as const),
    note,
    spark: m.spark,
    hint: m.why || m.description || undefined,
    ...(m.status === "proposed" ? { tag: "待确认" } : m.status === "paused" ? { tag: "暂停" } : {}),
  };
}

// The figures once per load, by metric: opening one or changing the filter does not make new figures.
const tiles = computed(() => new Map(metrics.value.map((m) => [m.id, tile(m)])));
const proposedCount = computed(() => metrics.value.filter((m) => m.status === "proposed").length);
const flagged = computed(() => metrics.value.filter((m) => m.change?.flagged && m.status === "active").length);
const shown = computed(() => (filter.value === "proposed" ? metrics.value.filter((m) => m.status === "proposed") : metrics.value));

// Work metrics by the line they hang on (a matter without a line is its own group); loose ones last.
const groups = computed(() => {
  const by = new Map<string, { key: string; title: string; link: string | null; metrics: Metric[] }>();
  for (const m of shown.value) {
    const key = props.scope === "omem" || props.item ? "one" : m.lineId ?? m.itemId ?? "";
    const title = props.scope === "omem" || props.item ? "" : m.lineTitle ?? m.itemTitle ?? "没挂到事项上的";
    if (!by.has(key)) by.set(key, { key, title, link: props.scope === "work" && !props.item && key ? `#/work/${key}` : null, metrics: [] });
    by.get(key)!.metrics.push(m);
  }
  return [...by.values()]
    .sort((a, b) => (a.key ? 0 : 1) - (b.key ? 0 : 1) || b.metrics.length - a.metrics.length)
    .map((g) => ({ ...g, keys: g.metrics.map((m) => m.id), items: g.metrics.map((m) => tiles.value.get(m.id)!), proposed: g.metrics.filter((m) => m.status === "proposed").length }));
});
const catalog = computed(() => (props.item ? null : files.value.find((f) => f.kind === "catalog") ?? null));
const plans = computed(() => files.value.filter((f) => f.kind === "plan"));
const notes = computed(() => (props.item ? [] : files.value.filter((f) => f.kind === "note").slice(0, 5)));
const reports = computed(() => files.value.filter((f) => f.kind === "report"));
const opened = computed(() => metrics.value.find((m) => m.id === open.value) ?? null);

// ---- a report: a work file whose ```chart blocks the Markdown draws
const report = ref<DataFile | null>(null);
const reportText = ref<string | null>(null);
let reportSeq = 0;
async function toggleReport(f: DataFile) {
  if (report.value?.id === f.id) return (report.value = null);
  report.value = f;
  reportText.value = null;
  const n = ++reportSeq;
  const r = await get<{ text: string }>(`/api/sources/${encodeURIComponent(f.id)}`).catch((e) => ({ text: `读不出这份报表：${(e as Error).message}` }));
  if (n === reportSeq && report.value?.id === f.id) reportText.value = r.text;
}

// ---- one metric opened
async function show(id: string) {
  if (open.value === id) return close(true);
  open.value = id;
  editing.value = null;
  detail.value = null;
  const n = ++detailSeq;
  // On a narrow page the details open below every row of the group: bring their start into view.
  void nextTick(() => {
    const panel = root.value?.querySelector<HTMLElement>(".opened");
    if (panel && panel.getBoundingClientRect().top > window.innerHeight - 120) panel.scrollIntoView({ block: "nearest", behavior: "smooth" });
  });
  const r = await get<Detail>(`/api/metrics/${encodeURIComponent(id)}?days=${days.value}`).catch(() => null);
  if (n === detailSeq && open.value === id) detail.value = r ?? { kind: "line", charts: [], table: { labels: [], series: [] }, points: [] };
}
let detailSeq = 0;
function close(refocus = false) {
  const id = open.value;
  open.value = null;
  detail.value = null;
  editing.value = null;
  detailSeq++;
  if (refocus && id) focusTile(id);
}
async function refresh() {
  const id = open.value;
  await load();
  if (id && metrics.value.some((m) => m.id === id)) {
    open.value = null;
    await show(id);
  }
}
watch(days, () => {
  const id = open.value;
  if (!id) return;
  open.value = null;
  void show(id);
});
const focusTile = (id: string) => void nextTick(() => root.value?.querySelector<HTMLElement>(`button.oc-metric[data-key="${CSS.escape(id)}"]`)?.focus());
/** Esc inside the board (or with the focus nowhere, after the form closed): the form first, then the details. Dialogs and lists in layers of their own handle theirs. */
function onKey(e: KeyboardEvent) {
  if (e.key !== "Escape" || e.defaultPrevented || !open.value) return;
  const t = e.target as Node | null;
  if (t && t !== document.body && !root.value?.contains(t)) return;
  e.preventDefault();
  if (editing.value) {
    editing.value = null;
    focusTile(open.value);
  } else close(true);
}
onMounted(() => window.addEventListener("keydown", onKey));
onBeforeUnmount(() => window.removeEventListener("keydown", onKey));

const fewDays = computed(() => (detail.value && detail.value.kind !== "table" && detail.value.table.labels.length <= 2 ? detail.value.table.labels.length : 0));
/** A day or two: the values with their dates, not a near-empty chart. */
const fewLines = computed(() => {
  const t = detail.value?.table;
  if (!t || !opened.value) return [];
  const unit = opened.value.unit === "%" ? "%" : opened.value.unit ? ` ${opened.value.unit}` : "";
  return t.labels.map((l, i) => ({ label: l, text: t.series.flatMap((s) => (s.values[i] === null ? [] : [`${t.series.length > 1 || s.name !== opened.value!.name ? `${s.name} ` : ""}${full(s.values[i]!)}${unit}`])).join(" / ") }));
});
const numberItems = computed<MetricItem[]>(() => {
  const m = opened.value, t = detail.value?.table;
  if (!m || !t || !t.labels.length) return [];
  const i = t.labels.length - 1;
  return t.series.filter((s) => s.values[i] !== null).slice(0, 8).map((s) => ({ label: t.series.length > 1 ? s.name : m.name, value: full(s.values[i]!), unit: m.unit, note: t.labels[i] }));
});
const tableRows = computed(() => {
  const t = detail.value?.table;
  if (!t) return [];
  return t.labels.map((l, i) => ({ label: l, cells: t.series.map((s) => (s.values[i] === null ? "—" : full(s.values[i]!))) })).reverse();
});
const dimNames = computed(() => [...new Set((detail.value?.points ?? []).flatMap((p) => Object.keys(p.dims)))]);
const dimValues = (dim: string) => [...new Set((detail.value?.points ?? []).map((p) => p.dims[dim]).filter((v): v is string => !!v))];

function origin(m: Metric) {
  if (m.definedBy === "omem") return "omem 自己每天统计";
  if (m.definedBy === "owner") return `你定的 · ${shortDay(m.createdAt)}`;
  return m.status === "proposed" ? `AI 提议 · ${shortDay(m.createdAt)}，等你确认` : m.confirmedAt ? `AI 提议 · ${shortDay(m.createdAt)}，你 ${shortDay(m.confirmedAt)} 留下` : `AI 提议 · ${shortDay(m.createdAt)}`;
}
function viewText(m: Metric) {
  const v = m.view;
  if (!v) return "走势线（没指定画法）";
  return `${kindLabel(v.kind)}${v.compareBy ? `，按 ${v.compareBy} 分组` : ""}${v.focus ? `，卡片显示“${v.focus}”` : ""}${v.ratio ? "，另画占比" : ""}`;
}
const planLink = (m: Metric) => `[${(m.plan?.title ?? "观测计划").replace(/[[\]]/g, "")}](${m.planRef})`;

// ---- 保留 / 改 / 不要
const saving = ref(false);
const error = ref("");
async function save(m: Metric, body: Record<string, unknown>) {
  saving.value = true;
  error.value = "";
  try {
    await put(`/api/metrics/${encodeURIComponent(m.id)}`, body);
    editing.value = null;
    await refresh();
    return true;
  } catch (e) {
    error.value = (e as Error).message;
    return false;
  } finally {
    saving.value = false;
  }
}
const keep = (m: Metric) => save(m, { status: "active" });
async function drop(m: Metric) {
  const note = await promptDialog(`不要「${m.name}」？`, { message: "不再取数，也不在这里显示。为什么不要？（可以不填，助手以后提指标时会参考）", placeholder: "例如：曝光说明不了问题，看完成率就够了", okText: "不要了", danger: true });
  if (note === null) return;
  if (await save(m, { status: "dropped", ...(note.trim() ? { note: note.trim() } : {}) })) close();
}

type Form = { name: string; unit: string; why: string; schedule: string; threshold: number; direction: string; kind: ViewKind; compareBy: string; focus: string; ratio: boolean };
const editing = ref<Form | null>(null);
const THRESHOLDS = [0.1, 0.2, 0.3, 0.5, 1];
const thresholdOptions = computed(() => {
  const cur = editing.value?.threshold;
  const xs = [...new Set([...THRESHOLDS, ...(cur !== undefined ? [cur] : [])])].sort((a, b) => a - b);
  return xs.map((x) => ({ value: x, label: `${Math.round(x * 100)}%` }));
});
function startEdit(m: Metric) {
  editing.value = { name: m.name, unit: m.unit, why: m.why, schedule: m.schedule, threshold: m.threshold ?? 0.3, direction: m.direction ?? "neutral", kind: m.view?.kind ?? "line", compareBy: m.view?.compareBy ?? "", focus: m.view?.focus ?? "", ratio: !!m.view?.ratio };
  void nextTick(() => root.value?.querySelector<HTMLInputElement>(".edit input")?.focus());
}
function submitEdit(m: Metric, andKeep: boolean) {
  const f = editing.value;
  if (!f) return;
  const view: View = { kind: f.kind, ...(f.compareBy ? { compareBy: f.compareBy } : {}), ...(f.compareBy && f.focus ? { focus: f.focus } : {}), ...(f.ratio ? { ratio: true } : {}) };
  void save(m, { name: f.name.trim(), unit: f.unit.trim(), why: f.why.trim(), schedule: f.schedule, threshold: f.threshold, direction: f.direction, view, ...(andKeep ? { status: "active" } : {}) });
}
</script>

<template>
  <div ref="root" class="metrics-board">
    <div class="board-head">
      <p class="muted small">
        <template v-if="scope === 'work'">
          {{ metrics.length }} 个指标<template v-if="flagged"> · <strong class="warn">{{ flagged }} 个越过门槛</strong></template>。{{ item ? "" : "按工作线分组；" }}点一个数看它的图、为什么看、怎么查。
        </template>
        <template v-else>omem 每天存一份自己的用量，原始记录过期以后这些曲线还在。点一个数看曲线。</template>
      </p>
      <UiSegmented v-model="days" size="sm" aria-label="时间范围" :options="[{ value: 7, label: '7 天' }, { value: 30, label: '30 天' }, { value: 90, label: '90 天' }]" />
    </div>

    <div v-if="scope === 'work' && proposedCount" class="pending">
      <button type="button" class="badge warn pill" :aria-pressed="filter === 'proposed'" @click="filter = filter === 'proposed' ? 'all' : 'proposed'">
        共 {{ proposedCount }} 个指标是 AI 提议的，等你确认
      </button>
      <span class="muted small">{{ filter === "proposed" ? "只看待确认的；再点一下看全部。" : "照样取数，但变化不会通知你。点开一个，选保留、改或不要。" }}</span>
    </div>

    <div v-if="scope === 'work' && (catalog || plans.length || notes.length || reports.length)" class="files">
      <a v-if="catalog" class="file" :href="`#/sources/${catalog.id}`"><strong>数据源目录</strong><span class="muted small">哪个系统有哪类数据、怎么查 · {{ fmt(catalog.updatedAt, { dateStyle: "short" }) }}</span></a>
      <div v-if="plans.length" class="file">
        <strong>观测计划 {{ plans.length }} 份</strong>
        <span class="links"><a v-for="f in plans" :key="f.id" :href="`#/sources/${f.id}`">{{ f.title }}</a></span>
      </div>
      <div v-if="notes.length" class="file">
        <strong>采集记录</strong>
        <span class="links"><a v-for="f in notes" :key="f.id" :href="`#/sources/${f.id}`">{{ f.title }}</a></span>
      </div>
      <div v-if="reports.length" class="file">
        <strong>报表 {{ reports.length }} 份</strong>
        <span class="links">
          <button v-for="f in reports" :key="f.id" type="button" class="linkish" :class="{ on: report?.id === f.id }" :aria-expanded="report?.id === f.id" @click="toggleReport(f)">{{ f.title }}</button>
        </span>
      </div>
    </div>
    <section v-if="report" class="report" :aria-label="`报表：${report.title}`">
      <div class="report-head">
        <strong>{{ report.title }}</strong>
        <span class="muted small">{{ report.path }} · {{ fmt(report.updatedAt, { dateStyle: "short" }) }}</span>
        <span class="grow" />
        <a class="btn ghost sm" :href="`#/sources/${report.id}`">打开原件</a>
        <button type="button" class="btn ghost sm" @click="report = null">收起</button>
      </div>
      <Skeleton v-if="reportText === null" variant="text" :rows="4" />
      <Markdown v-else class="prose report-body" :source="reportText" :space="report.spaceId" />
    </section>

    <Skeleton v-if="loading" :rows="4" />
    <p v-else-if="!metrics.length && !item" class="muted">
      <template v-if="scope === 'work'">还没有工作指标。让助手按技能 observation-plan 给一个需求写观测计划，计划里的指标会作为提议挂到事项上，你确认后就按时取数、有变化告诉你。</template>
      <template v-else>还没有存下 omem 自己的用量（每天一次，第一次在心跳时补上）。</template>
    </p>
    <template v-else>
      <section v-for="g in groups" :key="g.key" class="group">
        <h3 v-if="g.title" class="group-title">
          <a v-if="g.link" :href="g.link">{{ g.title }}</a><span v-else>{{ g.title }}</span>
          <span class="muted small"> · {{ g.metrics.length }}</span>
          <span v-if="g.proposed" class="badge warn">{{ g.proposed }} 个待确认</span>
        </h3>
        <MetricRow :items="g.items" :keys="g.keys" :selected="open" @select="show" />

        <div v-if="opened && g.keys.includes(opened.id)" class="opened" role="region" :aria-label="`${opened.name}的详情`">
          <div v-if="opened.status === 'proposed'" class="proposal">
            <div class="p-text">
              <strong>AI 提议，待你确认</strong>
              <span class="small">它照样在取数，但变化不会通知你。{{ opened.why ? `它想回答：${opened.why}` : "提议时没写它回答什么问题。" }}</span>
            </div>
            <div class="row wrap acts">
              <button type="button" class="btn primary sm" :disabled="saving" @click="keep(opened)">保留</button>
              <button type="button" class="btn ghost sm" :disabled="saving" :aria-expanded="!!editing" @click="editing ? (editing = null) : startEdit(opened)">改</button>
              <button type="button" class="btn danger sm" :disabled="saving" @click="drop(opened)">不要</button>
            </div>
          </div>

          <Skeleton v-if="!detail" variant="lines" :rows="3" />
          <template v-else>
            <p v-if="!detail.table.labels.length" class="nodata">还没有数。{{ notYet(opened, true) }}</p>
            <div v-else-if="fewDays" class="few">
              <span class="few-head">只有 {{ fewDays }} {{ opened.schedule === "hourly" ? "个小时" : "天" }}的数</span>
              <span v-for="l in fewLines" :key="l.label" class="few-line"><span class="few-day">{{ l.label }}</span>{{ l.text }}</span>
              <span class="muted small">数多了以后画成{{ kindLabel(detail.kind) }}。</span>
            </div>
            <MetricRow v-else-if="detail.kind === 'number'" :items="numberItems" />
            <div v-else-if="detail.kind === 'table'" class="tbl">
              <table>
                <thead><tr><th>{{ opened.schedule === "hourly" ? "时间" : "日期" }}</th><th v-for="s in detail.table.series" :key="s.name" class="num">{{ s.name }}{{ opened.unit ? `（${opened.unit}）` : "" }}</th></tr></thead>
                <tbody><tr v-for="r in tableRows" :key="r.label"><th>{{ r.label }}</th><td v-for="(c, i) in r.cells" :key="i" class="num">{{ c }}</td></tr></tbody>
              </table>
            </div>
            <div v-else class="charts" :class="{ two: detail.charts.length > 1 }">
              <Chart v-for="(c, i) in detail.charts" :key="`${opened.id}:${i}`" :spec="c" />
            </div>
          </template>

          <form v-if="editing" class="edit" @submit.prevent="submitEdit(opened, opened.status === 'proposed')">
            <div class="edit-grid">
              <label class="field"><span>名字</span><input v-model="editing.name" class="input" maxlength="120" required /></label>
              <label class="field narrow"><span>单位</span><input v-model="editing.unit" class="input" maxlength="20" placeholder="次、%、单" /></label>
              <label class="field wide"><span>它回答什么问题</span><textarea v-model="editing.why" class="textarea" rows="2" maxlength="300" placeholder="例如：部分发货改造上线后，退款接口有没有更容易出错" /></label>
              <div class="field"><span>取数</span><UiSelect v-model="editing.schedule" :options="SCHEDULES" aria-label="取数频率" /></div>
              <div class="field"><span>变化超过多少告诉你</span><UiSelect v-model="editing.threshold" :options="thresholdOptions" aria-label="门槛" /></div>
              <div class="field wide"><span>哪个方向是好的</span><UiSegmented v-model="editing.direction" size="sm" aria-label="哪个方向是好的" :options="[{ value: 'up-good', label: '变多是好' }, { value: 'down-good', label: '变少是好' }, { value: 'neutral', label: '不分好坏' }]" /></div>
              <div class="field"><span>画法</span><UiSelect v-model="editing.kind" :options="KINDS" aria-label="画法" /></div>
              <div v-if="dimNames.length" class="field"><span>按哪个维度分组</span><UiSelect v-model="editing.compareBy" :options="[{ value: '', label: '每种维度组合一条' }, ...dimNames.map((d) => ({ value: d, label: d }))]" aria-label="按哪个维度分组" /></div>
              <div v-if="editing.compareBy" class="field"><span>卡片上显示哪一组</span><UiSelect v-model="editing.focus" :options="[{ value: '', label: '第一组' }, ...dimValues(editing.compareBy).map((v) => ({ value: v, label: v }))]" aria-label="卡片上显示哪一组" /></div>
              <div v-if="editing.compareBy || dimNames.length" class="field check"><UiCheckbox v-model="editing.ratio" switch>另画一张各组的占比</UiCheckbox></div>
            </div>
            <p v-if="error" class="err small">{{ error }}</p>
            <div class="row wrap acts">
              <button v-if="opened.status === 'proposed'" type="submit" class="btn primary sm" :disabled="saving">保存并保留</button>
              <button type="button" :class="['btn', 'sm', opened.status === 'proposed' ? 'ghost' : 'primary']" :disabled="saving" @click="submitEdit(opened, false)">{{ opened.status === "proposed" ? "只保存，先不定" : "保存" }}</button>
              <button type="button" class="btn ghost sm" @click="editing = null">取消</button>
            </div>
          </form>

          <dl class="facts">
            <template v-if="opened.why && opened.status !== 'proposed'"><dt>为什么看</dt><dd>{{ opened.why }}</dd></template>
            <template v-if="opened.description"><dt>说明</dt><dd>{{ opened.description }}</dd></template>
            <template v-if="opened.source && scope === 'work'"><dt>来源</dt><dd>{{ opened.source }}</dd></template>
            <template v-if="opened.query"><dt>怎么查</dt><dd class="query">{{ opened.query }}</dd></template>
            <dt>取数</dt><dd>{{ SCHEDULE[opened.schedule] ?? opened.schedule }}{{ opened.status === "paused" ? "（暂停中）" : "" }}{{ opened.lastAt ? `，最近一次 ${when(opened.lastAt)}` : "，还没取过" }}{{ opened.nextAt && opened.lastAt ? `，下一次约 ${when(opened.nextAt)}` : "" }}</dd>
            <template v-if="scope === 'work'"><dt>门槛</dt><dd>和{{ opened.baseline != null ? `基线 ${opened.baseline}` : "前 7 个点的中位数" }}比，变化超过 {{ Math.round((opened.threshold ?? 0.3) * 100) }}% {{ opened.status === "active" ? "告诉你" : "才算越过（确认以后才会告诉你）" }}</dd></template>
            <template v-if="opened.itemId && opened.itemId !== item"><dt>挂在</dt><dd><a :href="`#/work/${opened.itemId}`">{{ opened.itemTitle ?? opened.itemId }}</a></dd></template>
            <template v-if="opened.planRef"><dt>观测计划</dt><dd><Markdown class="plan-ref" :source="planLink(opened)" :linkify="false" /></dd></template>
            <dt>谁定的</dt><dd>{{ origin(opened) }}<template v-if="opened.definedRun"> · <a :href="`#/runs/${opened.definedRun}`">那次运行</a></template></dd>
            <template v-if="scope === 'work'"><dt>画法</dt><dd>{{ viewText(opened) }}</dd></template>
          </dl>

          <p v-if="error && !editing" class="err small">{{ error }}</p>
          <div v-if="scope === 'work' && opened.status !== 'proposed' && !editing" class="row wrap acts">
            <button type="button" class="btn ghost sm" @click="startEdit(opened)">改</button>
            <button v-if="opened.status === 'active'" type="button" class="btn ghost sm" :disabled="saving" @click="save(opened, { status: 'paused' })">暂停取数</button>
            <button v-else-if="opened.status === 'paused'" type="button" class="btn ghost sm" :disabled="saving" @click="save(opened, { status: 'active' })">接着取数</button>
            <button v-if="opened.definedBy !== 'omem'" type="button" class="btn danger sm" :disabled="saving" @click="drop(opened)">不要</button>
          </div>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.metrics-board { display: flex; flex-direction: column; gap: 18px; min-width: 0; }
.board-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 16px; }
.board-head p { margin: 0; }
.warn { color: var(--warn); font-weight: 600; }
.pending { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; }
.pill { border: 0; cursor: pointer; height: 26px; padding: 0 12px; font-size: 12.5px; font-weight: 600; }
.pill[aria-pressed="true"] { box-shadow: inset 0 0 0 1.5px var(--warn); }
.pill:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.files { display: grid; gap: 8px; padding: 12px 14px; border: 1px solid var(--line); border-radius: 10px; background: var(--panel); }
.file { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; font-size: 13px; color: inherit; text-decoration: none; min-width: 0; }
a.file:hover strong { text-decoration: underline; }
.links { display: flex; flex-wrap: wrap; gap: 4px 12px; min-width: 0; }
.links a { overflow-wrap: anywhere; }
.linkish { font: inherit; color: var(--accent); background: none; border: 0; padding: 0; cursor: pointer; text-align: left; overflow-wrap: anywhere; }
.linkish:hover { text-decoration: underline; }
.linkish.on { color: var(--ink); font-weight: 600; text-decoration: underline; text-underline-offset: 3px; }
.linkish:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 2px; }
.report { display: grid; gap: 10px; padding: 12px 0 4px; border-top: 1px dashed var(--line); border-bottom: 1px dashed var(--line); min-width: 0; }
.report-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; min-width: 0; }
.report-head .grow { flex: 1; }
.report-body { max-width: 860px; min-width: 0; }
.group { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.group-title { margin: 6px 0 0; font-size: 14.5px; font-weight: 600; display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 8px; }
.group-title a { color: inherit; }
.group-title .badge { align-self: center; }
.opened { display: flex; flex-direction: column; gap: 12px; padding: 12px 0 4px; border-top: 1px dashed var(--line); min-width: 0; }
.proposal { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 16px; padding: 10px 14px; border-radius: 10px; background: var(--warn-soft); min-width: 0; }
.p-text { display: grid; gap: 2px; min-width: 0; flex: 1 1 280px; }
.p-text strong { color: var(--warn); font-size: 13.5px; }
.p-text span { color: var(--ink-2); overflow-wrap: anywhere; }
.acts { gap: 6px; }
.nodata { margin: 0; color: var(--ink-2); font-size: 13.5px; }
.few { display: grid; gap: 4px; font-size: 13.5px; }
.few-head { color: var(--muted); font-size: 11.5px; letter-spacing: .1em; }
.few-line { font-variant-numeric: tabular-nums; color: var(--ink); overflow-wrap: anywhere; }
.few-day { display: inline-block; min-width: 4.2em; color: var(--muted); }
.charts { display: grid; gap: 18px; min-width: 0; }
.charts.two { grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); }
@media (max-width: 760px) { .charts.two { grid-template-columns: minmax(0, 1fr); } }
.tbl { overflow-x: auto; max-width: 100%; }
.tbl table { border-collapse: collapse; font-size: 13px; }
.tbl th, .tbl td { border-bottom: 1px solid var(--line); padding: 5px 14px 5px 0; text-align: left; font-weight: 400; white-space: nowrap; }
.tbl thead th { color: var(--muted); font-weight: 550; }
.tbl .num { text-align: right; font-variant-numeric: tabular-nums; }
.edit { display: grid; gap: 10px; padding: 12px 14px; border: 1px solid var(--line); border-radius: 10px; background: var(--panel); min-width: 0; }
.edit-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 10px 14px; }
.edit-grid .wide { grid-column: 1 / -1; }
.edit-grid .check { align-self: end; padding-bottom: 6px; }
.edit-grid .ui-seg { justify-self: start; max-width: 100%; }
.err { color: var(--danger); margin: 0; }
.facts { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 4px 14px; margin: 0; font-size: 13px; }
.facts dt { color: var(--muted); }
.facts dd { margin: 0; overflow-wrap: anywhere; min-width: 0; }
.query { white-space: pre-wrap; font-size: 12.5px; color: var(--ink-2); }
.plan-ref :deep(p) { margin: 0; }
</style>
