<script setup lang="ts">
/**
 * Metrics on the data page and on an item (src/data/metrics.ts, GET /api/metrics). `work`: the numbers
 * the owner's work is watched by; `omem`: omem's own daily usage (source `omem`); with `item`: that
 * item's metrics and those under it, and the files behind them (components/MetricFiles).
 *
 * Proposals an agent made come first as one list to get through (等你确认): a row per metric — its
 * name, why, where from and how often, its newest number — kept or dropped one by one, a line's group
 * at once, or all of them. Kept ones follow, by work line: a grid of figures of one shape, one per
 * metric however many ways it is split (a count shows its total). A figure, or a proposal's name,
 * opens its details below its row (components/MetricDetail); again, or Esc, closes them and puts the
 * focus back. The figures are computed once per load and keyed by metric, so opening one never
 * redraws the row.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { compact, full, type MetricItem } from "@omem-ai/plugin-sdk/charts";
import { get, post } from "../api";
import { confirmDialog, promptDialog } from "../lib/dialog";
import { notYet, pct, SCHEDULE, shortDay, takenText, type Metric } from "../lib/metrics";
import { toast } from "../store";
import MetricRow from "./charts/MetricRow.vue";
import MetricDetail from "./MetricDetail.vue";
import MetricFiles from "./MetricFiles.vue";
import Skeleton from "./Skeleton.vue";

const props = defineProps<{ scope: "work" | "omem"; focus?: string; item?: string }>();
const emit = defineEmits<{ count: [n: number] }>();
const root = ref<HTMLElement>();
const metrics = ref<Metric[]>([]);
const fileCount = ref(0);
const loading = ref(true);
const loadError = ref("");
const open = ref<string | null>(null);
const detailRef = ref<InstanceType<typeof MetricDetail> | null>(null);
/** The open details sit inside a v-for: a function ref keeps the one instance, not an array. */
const setDetail = (el: unknown) => (detailRef.value = (el as InstanceType<typeof MetricDetail> | null) ?? null);
let seq = 0;

async function load() {
  const n = ++seq;
  loadError.value = "";
  try {
    const all = await get<Metric[]>(`/api/metrics${props.item ? `?item=${encodeURIComponent(props.item)}` : ""}`);
    if (n !== seq) return;
    metrics.value = all.filter((m) => (props.scope === "omem") === (m.source === "omem"));
  } catch (e) {
    if (n === seq) loadError.value = (e as Error).message;
  } finally {
    if (n === seq) loading.value = false;
  }
  emit("count", metrics.value.length + fileCount.value);
  if (open.value && !metrics.value.some((m) => m.id === open.value)) open.value = null;
}
onMounted(async () => {
  await load();
  if (props.focus && metrics.value.some((m) => m.id === props.focus)) show(props.focus);
});
watch(() => [props.scope, props.item], () => {
  open.value = null;
  loading.value = true;
  void load();
});
function filesCounted(n: number) {
  fileCount.value = n;
  emit("count", metrics.value.length + n);
}

const work = computed(() => props.scope === "work");
const unitOf = (m: Metric) => (m.unit === "%" ? "%" : m.unit ? m.unit : "");
const latestText = (m: Metric) => (m.change ? `${compact(m.change.value)}${unitOf(m)}` : "");

/** A kept metric as a figure: its name only (the dimensions are in its details), the number, and one short line. */
function tile(m: Metric): MetricItem {
  const has = m.points > 0 && !!m.change;
  const many = m.groups > 1 && m.figure ? `共 ${m.groups} 组，点开比较` : "";
  const taken = m.source === "omem" ? `每天${m.lastAt ? ` · 上次 ${shortDay(m.lastAt)}` : ""}` : takenText(m);
  const note = [m.change?.flagged && m.status === "active" && m.source !== "omem" ? "越过门槛" : "", many || taken].filter(Boolean).join(" · ");
  return {
    label: m.name,
    value: has ? full(m.change!.value) : "",
    unit: m.unit,
    ...(has && m.change!.rel != null ? { change: pct(m.change!.rel), trend: m.change!.rel > 0 ? ("up" as const) : m.change!.rel < 0 ? ("down" as const) : ("flat" as const) } : {}),
    good: m.direction === "up-good" ? ("up" as const) : m.direction === "down-good" ? ("down" as const) : ("none" as const),
    ...(has ? { note } : { pending: notYet(m) }),
    spark: m.spark,
    hint: m.why || m.description || undefined,
    ...(m.status === "paused" ? { tag: "暂停" } : {}),
  };
}

// The figures once per load, by metric: opening one does not make new figures.
const tiles = computed(() => new Map(metrics.value.map((m) => [m.id, tile(m)])));
const proposed = computed(() => (work.value ? metrics.value.filter((m) => m.status === "proposed") : []));
const kept = computed(() => metrics.value.filter((m) => !work.value || m.status !== "proposed"));
const flagged = computed(() => (work.value ? kept.value.filter((m) => m.change?.flagged && m.status === "active").length : 0));

type Group = { key: string; title: string; link: string | null; metrics: Metric[] };
/** By the work line a metric hangs on (a matter without a line is its own group); loose ones last. One group on an item and for omem. */
function byLine(ms: Metric[]): Group[] {
  const by = new Map<string, Group>();
  const one = props.scope === "omem" || !!props.item;
  for (const m of ms) {
    const key = one ? "one" : m.lineId ?? m.itemId ?? "";
    if (!by.has(key)) by.set(key, { key, title: one ? "" : m.lineTitle ?? m.itemTitle ?? "没挂到事项上的", link: !one && key ? `#/work/${key}` : null, metrics: [] });
    by.get(key)!.metrics.push(m);
  }
  return [...by.values()].sort((a, b) => (a.key ? 0 : 1) - (b.key ? 0 : 1) || b.metrics.length - a.metrics.length);
}
const proposedGroups = computed(() => byLine(proposed.value));
const keptGroups = computed(() => byLine(kept.value).map((g) => ({ ...g, keys: g.metrics.map((m) => m.id), items: g.metrics.map((m) => tiles.value.get(m.id)!) })));
const opened = computed(() => metrics.value.find((m) => m.id === open.value) ?? null);

// ---- opening and closing one
function show(id: string) {
  if (open.value === id) return close(true);
  open.value = id;
  // On a narrow page the details open below every row of the group: bring their start into view.
  void nextTick(() => {
    const panel = root.value?.querySelector<HTMLElement>(".md");
    if (panel && panel.getBoundingClientRect().top > window.innerHeight - 120) panel.scrollIntoView({ block: "nearest", behavior: "smooth" });
  });
}
function close(refocus = false) {
  const id = open.value;
  open.value = null;
  if (refocus && id) focusOn(id);
}
const focusOn = (id: string) =>
  void nextTick(() => root.value?.querySelector<HTMLElement>(`button.oc-metric[data-key="${CSS.escape(id)}"], button.c-name[data-key="${CSS.escape(id)}"]`)?.focus());
/** Esc inside the board (or with the focus nowhere): the form first, then the details. Dialogs and lists in layers of their own handle theirs. */
function onKey(e: KeyboardEvent) {
  if (e.key !== "Escape" || e.defaultPrevented || !open.value) return;
  const t = e.target as Node | null;
  if (t && t !== document.body && !root.value?.contains(t)) return;
  e.preventDefault();
  if (detailRef.value?.escape()) focusOn(open.value);
  else close(true);
}
onMounted(() => window.addEventListener("keydown", onKey));
onBeforeUnmount(() => window.removeEventListener("keydown", onKey));
async function changed(dropped: boolean) {
  const id = open.value;
  await load();
  if (dropped || !metrics.value.some((m) => m.id === id)) open.value = null;
}

// ---- 保留 / 不要, one, a group, or all
const busy = ref(false);
async function decide(ms: Metric[], status: "active" | "dropped", note?: string) {
  busy.value = true;
  try {
    await post("/api/metrics/decide", { ids: ms.map((m) => m.id), status, ...(note ? { note } : {}) });
    toast(status === "active" ? `留下了 ${ms.length} 个指标，变化超过门槛会告诉你` : `不要了 ${ms.length} 个指标`, "ok");
    if (ms.some((m) => m.id === open.value)) open.value = null;
    await load();
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    busy.value = false;
  }
}
async function dropOne(m: Metric) {
  const note = await promptDialog(`不要「${m.name}」？`, { message: "不再取数，也不在这里显示。为什么不要？（可以不填，助手以后提指标时会参考）", placeholder: "例如：曝光说明不了问题，看完成率就够了", okText: "不要了", danger: true });
  if (note !== null) await decide([m], "dropped", note.trim());
}
async function dropGroup(g: Group) {
  const note = await promptDialog(`不要「${g.title}」下这 ${g.metrics.length} 个？`, { message: "都不再取数，也不在这里显示。可以写一句为什么（不填也行）。", placeholder: "例如：这条线已经不看这些了", okText: "都不要", danger: true });
  if (note !== null) await decide(g.metrics, "dropped", note.trim());
}
async function keepAll() {
  if (await confirmDialog(`保留全部 ${proposed.value.length} 个指标？`, { message: "保留以后照常取数，变化超过门槛会告诉你。以后不想要了，点开它选“不要”。", okText: "全部保留" })) await decide(proposed.value, "active");
}
</script>

<template>
  <div ref="root" class="metrics-board">
    <div v-if="item" class="item-files"><MetricFiles :item="item" @count="filesCounted" /></div>

    <Skeleton v-if="loading" :rows="4" />
    <p v-else-if="loadError" class="err" role="alert">读不出指标：{{ loadError }} <button type="button" class="btn sm" @click="load">重试</button></p>
    <p v-else-if="!metrics.length && !item" class="empty">
      <template v-if="work">还没有工作指标。让助手按技能 observation-plan 给一个需求写观测计划，计划里的指标会作为提议出现在这里，你确认后按时取数、有变化告诉你。</template>
      <template v-else>还没有存下 omem 自己的用量。每天存一次，第一次在下一次定时巡检时补上。</template>
    </p>
    <template v-else>
      <!-- Proposals: one list to get through -->
      <section v-if="proposed.length" class="confirm" aria-labelledby="metrics-confirm">
        <div class="confirm-head">
          <h2 id="metrics-confirm">等你确认 <span class="count">{{ proposed.length }}</span></h2>
          <p class="hint">AI 提议的指标。照样在取数，你定之前变化不会告诉你。</p>
          <button type="button" class="btn sm" :disabled="busy" @click="keepAll">全部保留</button>
        </div>
        <div v-for="g in proposedGroups" :key="g.key" class="c-group">
          <div v-if="g.title" class="c-group-head">
            <a v-if="g.link" :href="g.link" class="c-line">{{ g.title }}</a><span v-else class="c-line">{{ g.title }}</span>
            <span class="muted small">{{ g.metrics.length }} 个</span>
            <span class="grow" />
            <button type="button" class="btn ghost sm" :disabled="busy" @click="decide(g.metrics, 'active')">这一组都保留</button>
            <button type="button" class="btn ghost sm" :disabled="busy" @click="dropGroup(g)">都不要</button>
          </div>
          <ul class="c-rows">
            <li v-for="m in g.metrics" :key="m.id" class="c-row" :class="{ on: open === m.id }">
              <div class="c-main">
                <p class="c-top">
                  <button type="button" class="c-name" :data-key="m.id" :aria-expanded="open === m.id" :title="m.name" @click="show(m.id)">{{ m.name }}</button>
                  <span class="c-meta" :title="m.source">{{ [m.source, SCHEDULE[m.schedule] ?? m.schedule].filter(Boolean).join(" · ") }}</span>
                </p>
                <p v-if="m.why || m.description" class="c-why" :title="m.why || m.description">{{ m.why || m.description }}</p>
              </div>
              <span class="c-value" :class="{ none: !latestText(m) }">{{ latestText(m) || "还没取到" }}</span>
              <span class="c-acts">
                <button type="button" class="btn ghost sm" :disabled="busy" @click="decide([m], 'active')">保留</button>
                <button type="button" class="btn ghost sm" :disabled="busy" @click="dropOne(m)">不要</button>
              </span>
              <MetricDetail v-if="opened && opened.id === m.id" :ref="setDetail" class="c-detail" :metric="opened" :work="work" :item="item" @close="close(true)" @changed="changed" />
            </li>
          </ul>
        </div>
      </section>

      <!-- Kept metrics, by work line -->
      <p v-if="work && proposed.length && kept.length" class="kept-head">
        <span>在看的 {{ kept.length }} 个</span><template v-if="flagged"> · <span class="flag">{{ flagged }} 个越过门槛</span></template>
      </p>
      <p v-else-if="work && flagged" class="kept-head"><span class="flag">{{ flagged }} 个越过门槛</span></p>
      <section v-for="g in keptGroups" :key="g.key" class="group">
        <h3 v-if="g.title" class="group-title">
          <a v-if="g.link" :href="g.link">{{ g.title }}</a><span v-else>{{ g.title }}</span>
          <span class="muted small">{{ g.metrics.length }} 个</span>
        </h3>
        <MetricRow :items="g.items" :keys="g.keys" :selected="open" even @select="show" />
        <MetricDetail v-if="opened && g.keys.includes(opened.id)" :ref="setDetail" :metric="opened" :work="work" :item="item" @close="close(true)" @changed="changed" />
      </section>
    </template>
  </div>
</template>

<style scoped>
.metrics-board { display: flex; flex-direction: column; gap: 24px; min-width: 0; }
.item-files { display: flex; justify-content: flex-end; }
.item-files:empty { display: none; }
.empty { margin: 0; color: var(--ink-2); font-size: 14px; line-height: 1.6; max-width: 48em; }
.err { margin: 0; color: var(--danger); font-size: 13px; }

/* 等你确认 */
.confirm { display: grid; gap: 16px; padding: 16px 20px 8px; border-radius: 12px; background: var(--panel); border: 1px solid var(--line); min-width: 0; }
.confirm-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; }
.confirm-head h2 { margin: 0; font-size: 15px; font-weight: 650; display: inline-flex; align-items: baseline; gap: 8px; }
.confirm-head .count { display: inline-block; padding: 0 8px; border-radius: 999px; background: var(--warn-soft); color: var(--warn); font-size: 12px; font-weight: 650; line-height: 20px; font-variant-numeric: tabular-nums; }
.confirm-head .hint { flex: 1 1 260px; margin: 0; color: var(--muted); font-size: 13px; }
.c-group { display: grid; min-width: 0; }
.c-group + .c-group { margin-top: 8px; }
.c-group-head { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; padding: 4px 0 8px; border-bottom: 1px solid var(--line-strong); min-width: 0; }
.c-line { font-size: 14px; font-weight: 650; color: var(--ink); text-decoration: none; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
a.c-line:hover { text-decoration: underline; text-underline-offset: 3px; }
.grow { flex: 1; }
.c-rows { list-style: none; margin: 0; padding: 0; }
.c-row { display: grid; grid-template-columns: minmax(0, 1fr) 6.5em auto; align-items: center; column-gap: 16px; padding: 8px 0; border-bottom: 1px solid var(--line); min-width: 0; }
.c-row:last-child { border-bottom: 0; }
.c-main { display: grid; gap: 2px; min-width: 0; }
.c-main p { margin: 0; }
.c-top { display: flex; align-items: baseline; gap: 12px; min-width: 0; }
.c-name { flex: 0 1 auto; font: inherit; font-size: 14px; color: var(--ink); background: none; border: 0; padding: 0; text-align: left; cursor: pointer; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.c-name:hover { text-decoration: underline; text-underline-offset: 3px; }
.c-name[aria-expanded="true"] { color: var(--accent); }
.c-name:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 2px; }
.c-meta { flex: 0 10 auto; min-width: 4em; color: var(--muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.c-why { font-size: 13px; color: var(--ink-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.c-value { text-align: right; font-size: 14px; font-weight: 500; font-variant-numeric: tabular-nums; color: var(--ink); white-space: nowrap; }
.c-value.none { font-size: 12px; font-weight: 400; color: var(--muted); }
.c-acts { display: flex; gap: 4px; }
.c-detail { grid-column: 1 / -1; margin-top: 8px; }

/* kept */
.kept-head { margin: 0; font-size: 13px; color: var(--muted); }
.flag { color: var(--warn); font-weight: 600; }
.group { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.group-title { margin: 0; font-size: 15px; font-weight: 650; display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 8px; min-width: 0; }
.group-title a { color: inherit; text-decoration: none; overflow-wrap: anywhere; }
.group-title a:hover { text-decoration: underline; text-underline-offset: 3px; }
.group-title .small { font-weight: 400; }

@media (max-width: 760px) {
  .confirm { padding: 12px 12px 4px; }
  .c-row { grid-template-columns: minmax(0, 1fr) auto; row-gap: 4px; }
  .c-acts { grid-column: 1 / -1; }
  .c-group-head .grow { flex-basis: 100%; height: 0; }
  .c-group-head .btn:first-of-type { margin-left: -8px; }


}
</style>
