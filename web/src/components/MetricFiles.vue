<script setup lang="ts">
/**
 * The work files behind the metrics (GET /api/metrics/files) as one line of small links — 数据源目录 ·
 * 观测计划 5 · 采集记录 5 · 报表 1 — each opening a drawer that lists them; a report opens in the
 * drawer, its ```chart blocks drawn. `item`: the files of that item and those under it.
 * Esc (or the backdrop) closes the report first, then the drawer; the focus goes back to the link.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { get } from "../api";
import { fmt } from "../lib/time";
import type { DataFile } from "../lib/metrics";
import Icon from "./Icon.vue";
import Markdown from "./Markdown.vue";
import Skeleton from "./Skeleton.vue";

const props = defineProps<{ item?: string }>();
const emit = defineEmits<{ count: [n: number] }>();
const files = ref<DataFile[]>([]);
let seq = 0;
async function load() {
  const n = ++seq;
  const r = await get<DataFile[]>(`/api/metrics/files${props.item ? `?item=${encodeURIComponent(props.item)}` : ""}`).catch(() => [] as DataFile[]);
  if (n !== seq) return;
  files.value = r;
  emit("count", r.length);
}
onMounted(load);
watch(() => props.item, load);

type Kind = "plan" | "note" | "report";
const catalog = computed(() => (props.item ? null : files.value.find((f) => f.kind === "catalog") ?? null));
const of = (k: Kind) => files.value.filter((f) => f.kind === k);
const KIND: Record<Kind, string> = { plan: "观测计划", note: "采集记录", report: "报表" };
const links = computed(() => (["plan", "note", "report"] as Kind[]).filter((k) => of(k).length).map((k) => ({ kind: k, label: KIND[k], n: of(k).length })));
const day = (iso: string) => fmt(iso, { month: "numeric", day: "numeric" });

const open = ref<Kind | null>(null);
const panel = ref<HTMLElement>();
let opener: HTMLElement | null = null;
function show(k: Kind) {
  opener = document.activeElement as HTMLElement | null;
  open.value = k;
  report.value = null;
  if (k === "report" && of("report").length === 1) void openReport(of("report")[0]);
  void nextTick(() => panel.value?.focus());
}
function close() {
  open.value = null;
  report.value = null;
  opener?.focus?.();
}

// ---- a report: a work file whose ```chart blocks the Markdown draws
const report = ref<DataFile | null>(null);
const reportText = ref<string | null>(null);
let reportSeq = 0;
async function openReport(f: DataFile) {
  report.value = f;
  reportText.value = null;
  const n = ++reportSeq;
  const r = await get<{ text: string }>(`/api/sources/${encodeURIComponent(f.id)}`).catch((e) => ({ text: `读不出这份报表：${(e as Error).message}` }));
  if (n === reportSeq && report.value?.id === f.id) reportText.value = r.text;
}
function back() {
  report.value = null;
  if (of("report").length === 1 && open.value === "report") close();
}
function onKey(e: KeyboardEvent) {
  if (e.key !== "Escape" || e.defaultPrevented || !open.value) return;
  e.preventDefault();
  if (report.value && !(open.value === "report" && of("report").length === 1)) report.value = null;
  else close();
}
onMounted(() => window.addEventListener("keydown", onKey));
onBeforeUnmount(() => window.removeEventListener("keydown", onKey));
</script>

<template>
  <nav v-if="catalog || links.length" class="files" aria-label="指标背后的资料">
    <a v-if="catalog" :href="`#/sources/${catalog.id}`" :title="`哪个系统有哪类数据、怎么查 · ${day(catalog.updatedAt)} 更新`">数据源目录</a>
    <button v-for="l in links" :key="l.kind" type="button" class="link" :aria-expanded="open === l.kind" @click="show(l.kind)">{{ l.label }} <span class="n">{{ l.n }}</span></button>
  </nav>
  <Teleport to="body">
    <template v-if="open">
      <div class="scrim" @click="close" />
      <aside ref="panel" class="sheet" :class="{ wide: !!report }" role="dialog" :aria-label="report ? `报表：${report.title}` : KIND[open]" tabindex="-1">
        <header>
          <button v-if="report && !(open === 'report' && of('report').length === 1)" type="button" class="btn ghost sm" @click="back"><Icon name="left" :size="14" />{{ KIND[open] }}</button>
          <strong v-else>{{ report ? report.title : KIND[open] }}</strong>
          <span class="grow" />
          <a v-if="report" class="btn ghost sm" :href="`#/sources/${report.id}`" @click="close">打开原件</a>
          <button type="button" class="btn ghost sm icon" aria-label="关闭" @click="close"><Icon name="x" :size="16" /></button>
        </header>
        <div class="body">
          <template v-if="report">
            <p class="muted small mono" :title="report.path">{{ report.path }} · {{ day(report.updatedAt) }}</p>
            <Skeleton v-if="reportText === null" variant="text" :rows="6" />
            <Markdown v-else class="prose" :source="reportText" :space="report.spaceId" />
          </template>
          <ul v-else class="list">
            <li v-for="f in of(open)" :key="f.id">
              <button v-if="open === 'report'" type="button" class="name link" @click="openReport(f)">{{ f.title }}</button>
              <a v-else class="name" :href="`#/sources/${f.id}`" @click="close">{{ f.title }}</a>
              <span class="muted small path" :title="f.path">{{ f.path }}</span>
              <time class="muted small">{{ day(f.updatedAt) }}</time>
            </li>
          </ul>
        </div>
      </aside>
    </template>
  </Teleport>
</template>

<style scoped>
.files { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 0; font-size: 13px; color: var(--muted); min-width: 0; }
.files > * + *::before { content: "·" / ""; margin: 0 8px; color: var(--muted); }
.files a, .link { color: var(--ink-2); text-decoration: none; }
.link { font: inherit; background: none; border: 0; padding: 0; cursor: pointer; }
.files a:hover, .link:hover { color: var(--ink); text-decoration: underline; text-underline-offset: 3px; }
.files a:focus-visible, .link:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 2px; }
.n { color: var(--muted); font-variant-numeric: tabular-nums; }
.scrim { position: fixed; inset: 0; background: rgba(10, 12, 16, 0.18); z-index: 38; }
.sheet { position: fixed; top: 0; right: 0; bottom: 0; width: min(480px, 100vw); background: var(--panel); border-left: 1px solid var(--line); box-shadow: var(--shadow-lg); z-index: 39; display: flex; flex-direction: column; outline: none; --chart-surface: var(--panel); }
.sheet.wide { width: min(760px, 100vw); }
header { display: flex; align-items: center; gap: 8px; padding: 8px 12px 8px 20px; border-bottom: 1px solid var(--line); min-height: 52px; min-width: 0; }
header strong { font-size: 15px; font-weight: 650; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
header .btn { gap: 4px; }
.grow { flex: 1; }
.body { flex: 1; overflow: auto; padding: 16px 20px 24px; display: grid; gap: 12px; align-content: start; grid-template-columns: minmax(0, 1fr); }
.body > p { margin: 0; }
.mono { font-family: var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.list { list-style: none; margin: 0; padding: 0; display: grid; }
.list li { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 2px 12px; padding: 8px 0; border-bottom: 1px solid var(--line); min-width: 0; }
.list .name { font-size: 14px; color: var(--ink); text-align: left; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.list a.name { text-decoration: none; }
.list .name:hover { text-decoration: underline; text-underline-offset: 3px; }
.list .path { grid-column: 1; font-family: var(--mono); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.list time { grid-column: 2; grid-row: 1; }
</style>
