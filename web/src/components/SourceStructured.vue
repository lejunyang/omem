<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import Markdown from "./Markdown.vue";
import RichText from "./RichText.vue";
import VirtualList from "./VirtualList.vue";
import Icon from "./Icon.vue";
import { citeRef, firstOverlap, linesLabel, overlaps, recordBody, tableRows, type Lines, type SourceDisplay } from "../lib/source-display";
import { toast } from "../store";

/**
 * A source a plugin's parser read as a table or as records (lib/source-display.ts), shown that way.
 * Every row and record is a range of the text: picking one puts its lines in the address (`from` /
 * `to`, like a citation does), a citation that lands here marks and scrolls to the rows it covers,
 * and “看原文” opens the same lines with line numbers.
 */
const props = defineProps<{ sourceId: string; text: string; start: number; display: SourceDisplay; space?: string; from?: number; to?: number }>();
const emit = defineEmits<{ pick: [lines: Lines]; raw: [lines: Lines] }>();

/** Past this many rows only the ones near the screen are drawn. */
const VIRTUAL_AT = 300;
const rows = computed(() => (props.display.kind === "table" ? tableRows(props.text, props.start, props.display) : []));
const records = computed(() => (props.display.kind === "records" ? props.display.items.map((r, key) => ({ key, ...r })) : []));
const ranges = computed<Lines[]>(() => (props.display.kind === "table" ? props.display.rowLines : props.display.items.map((i) => i.lines)));
const marked = (l: Lines) => props.from !== undefined && overlaps(l, props.from, props.to ?? props.from);
const picked = computed<Lines | null>(() => (props.from !== undefined ? [props.from, props.to ?? props.from] : null));
const cols = computed(() => (props.display.kind === "table" ? props.display.columns.length : 0));

const open = ref(new Set<number>());
function toggle(key: number) {
  const next = new Set(open.value);
  next.has(key) ? next.delete(key) : next.add(key);
  open.value = next;
}
function pick(lines: Lines) {
  emit("pick", lines);
}
function onRowKey(e: KeyboardEvent, lines: Lines) {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    pick(lines);
  }
}
async function copy(lines: Lines) {
  try {
    await navigator.clipboard.writeText(citeRef(props.sourceId, lines));
    toast("已复制引用", "ok");
  } catch {
    toast("复制不了：浏览器没有给剪贴板权限", "error");
  }
}

const root = ref<HTMLElement>();
const vlist = ref<{ scrollToIndex: (i: number, align?: "start" | "center") => Promise<void> } | null>(null);
/** A citation (or the address) names lines: open the record and bring the first row there into view. */
async function reveal() {
  if (props.from === undefined) return;
  const i = firstOverlap(ranges.value, props.from, props.to ?? props.from);
  if (i < 0) return;
  if (props.display.kind === "records" && !open.value.has(i)) toggle(i);
  await nextTick();
  if (vlist.value) return void vlist.value.scrollToIndex(i);
  root.value?.querySelector(`[data-index="${i}"]`)?.scrollIntoView({ block: "center" });
}
watch(() => [props.sourceId, props.from, props.to], () => void reveal(), { immediate: true });
watch(() => props.sourceId, () => (open.value = new Set()));
</script>

<template>
  <div ref="root" class="st">
    <div v-if="picked" class="st-pick small" role="status">
      <span class="muted">选中{{ linesLabel(picked) }}</span>
      <button type="button" class="btn ghost sm" :title="citeRef(sourceId, picked)" @click="copy(picked)"><Icon name="link" :size="13" />复制引用</button>
      <button type="button" class="btn ghost sm" @click="emit('raw', picked)">看原文</button>
    </div>

    <div v-if="display.kind === 'table'" class="st-scroll" tabindex="0" role="region" :aria-label="`表格，${rows.length} 行`">
      <div class="st-table" role="table" :aria-rowcount="rows.length + 1" :style="{ '--st-cols': cols }">
        <div class="st-row st-head" role="row">
          <span class="st-no" role="columnheader">行</span>
          <span v-for="c in display.columns" :key="c" class="st-cell" role="columnheader" :title="c">{{ c }}</span>
        </div>
        <VirtualList v-if="rows.length > VIRTUAL_AT" ref="vlist" :items="rows" :item-key="(r) => r.key" :estimate="37">
          <template #default="{ item: r }">
            <div class="st-row" role="row" tabindex="0" :data-index="r.key" :data-line="r.lines[0]" :class="{ on: marked(r.lines) }" :aria-label="`${linesLabel(r.lines)}：${r.cells.join('，')}`" @click="pick(r.lines)" @keydown="onRowKey($event, r.lines)">
              <span class="st-no" role="cell" :title="linesLabel(r.lines)">{{ r.lines[0] }}</span>
              <RichText v-for="(c, i) in r.cells" :key="i" class="st-cell" role="cell" :text="c" :space="space" :lines="3" />
            </div>
          </template>
        </VirtualList>
        <template v-else>
          <div v-for="r in rows" :key="r.key" class="st-row" role="row" tabindex="0" :data-index="r.key" :data-line="r.lines[0]" :class="{ on: marked(r.lines) }" :aria-label="`${linesLabel(r.lines)}：${r.cells.join('，')}`" @click="pick(r.lines)" @keydown="onRowKey($event, r.lines)">
            <span class="st-no" role="cell" :title="linesLabel(r.lines)">{{ r.lines[0] }}</span>
            <RichText v-for="(c, i) in r.cells" :key="i" class="st-cell" role="cell" :text="c" :space="space" :lines="3" />
          </div>
        </template>
      </div>
    </div>

    <div v-else class="st-records">
      <VirtualList v-if="records.length > VIRTUAL_AT" ref="vlist" :items="records" :item-key="(r) => r.key" :estimate="41">
        <template #default="{ item: r }">
          <div class="st-rec" :data-index="r.key" :data-line="r.lines[0]" :class="{ on: marked(r.lines), open: open.has(r.key) }">
            <button type="button" class="st-rec-head" :aria-expanded="open.has(r.key)" @click="toggle(r.key)">
              <Icon :name="open.has(r.key) ? 'down' : 'right'" :size="13" class="st-chev" />
              <span class="st-rec-title ellipsis">{{ r.title || "（没有标题）" }}</span>
              <span class="st-rec-lines">{{ linesLabel(r.lines) }}</span>
            </button>
            <div v-if="open.has(r.key)" class="st-rec-body">
              <Markdown :source="recordBody(text, start, r)" :space="space" compact />
              <div class="st-rec-foot"><button type="button" class="btn ghost sm" @click="pick(r.lines)">选中这一条</button></div>
            </div>
          </div>
        </template>
      </VirtualList>
      <template v-else>
          <div v-for="r in records" :key="r.key" class="st-rec" :data-index="r.key" :data-line="r.lines[0]" :class="{ on: marked(r.lines), open: open.has(r.key) }">
            <button type="button" class="st-rec-head" :aria-expanded="open.has(r.key)" @click="toggle(r.key)">
              <Icon :name="open.has(r.key) ? 'down' : 'right'" :size="13" class="st-chev" />
              <span class="st-rec-title ellipsis">{{ r.title || "（没有标题）" }}</span>
              <span class="st-rec-lines">{{ linesLabel(r.lines) }}</span>
            </button>
            <div v-if="open.has(r.key)" class="st-rec-body">
              <Markdown :source="recordBody(text, start, r)" :space="space" compact />
              <div class="st-rec-foot"><button type="button" class="btn ghost sm" @click="pick(r.lines)">选中这一条</button></div>
            </div>
          </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.st { display: grid; gap: 8px; min-width: 0; }
.st-pick { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-width: 0; }
.st-scroll { overflow-x: auto; border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--panel); min-width: 0; }
.st-scroll:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.st-table { min-width: calc(56px + var(--st-cols) * 140px); font-size: 14px; line-height: 1.6; }
.st-row { display: grid; grid-template-columns: 56px repeat(var(--st-cols), minmax(140px, 1fr)); border-top: 1px solid var(--line); cursor: pointer; }
.st-head { border-top: 0; cursor: default; background: var(--sunken); font-size: 13px; font-weight: 650; color: var(--ink-2); position: sticky; top: 0; }
.st-row:not(.st-head):hover { background-image: linear-gradient(var(--hover), var(--hover)); }
.st-row:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.st-row.on { background: var(--accent-soft); }
.st-no, .st-cell { padding: 8px 12px; min-width: 0; overflow-wrap: anywhere; }
.st-head .st-cell { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.st-no { font-family: var(--mono); font-size: 12px; color: var(--muted); text-align: right; }
.st-head .st-no { font-family: inherit; font-size: 12px; }
.st-records { border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--panel); min-width: 0; }
.st-rec + .st-rec, .v-row + .v-row .st-rec { border-top: 1px solid var(--line); }
.st-rec.on { background: var(--accent-soft); }
.st-rec-head { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 8px; width: 100%; padding: 8px 12px; border: 0; background: none; font: inherit; font-size: 14px; color: var(--ink); text-align: left; cursor: pointer; }
.st-rec-head:hover { background-image: linear-gradient(var(--hover), var(--hover)); }
.st-chev { color: var(--muted); }
.st-rec-lines { font-size: 12px; color: var(--muted); white-space: nowrap; }
.st-rec-body { padding: 0 12px 12px 33px; display: grid; gap: 8px; min-width: 0; }
.st-rec-foot { display: flex; justify-content: flex-end; }
@media (max-width: 760px) {
  .st-rec-body { padding-left: 12px; }
}
</style>
