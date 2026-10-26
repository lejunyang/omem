<script setup lang="ts">
import { computed, ref } from "vue";
import { get } from "../api";
import { toast } from "../store";

/**
 * One file of a delegation's diff with old/new line numbers. The unchanged code between hunks
 * (and above the first, below the last) can be unfolded 20 lines at a time or all at once; it is
 * read from the worktree while it exists, from the repository after the change was applied.
 * Rows carry data-line so a selection can say which lines it covers. Change points (the business
 * review's mapping of the requirement to the code) mark their lines; the active one is highlighted.
 */
export type DiffPoint = { id: string; mark: string; color: string; start: number; end: number };
const props = withDefaults(defineProps<{ runId: string; space: string; lines: string[]; points?: DiffPoint[]; active?: string | null; expandable?: boolean }>(), { points: () => [], active: null, expandable: true });
const emit = defineEmits<{ point: [id: string] }>();

type Row = { kind: "add" | "del" | "ctx" | "meta"; old: number | null; new: number | null; text: string };
type Hunk = { oldStart: number; newStart: number; header: string; rows: Row[]; oldEnd: number; newEnd: number };
type Gap = { from: number; to: number | null; delta: number; head: number; tail: number };

const path = computed(() => {
  const plus = props.lines.find((l) => l.startsWith("+++ "));
  const minus = props.lines.find((l) => l.startsWith("--- "));
  const pick = plus && plus !== "+++ /dev/null" ? plus.slice(4) : minus?.slice(4) ?? "";
  return pick.replace(/^[ab]\//, "");
});
const deleted = computed(() => props.lines.some((l) => l === "+++ /dev/null"));

const hunks = computed<Hunk[]>(() => {
  const out: Hunk[] = [];
  let cur: Hunk | null = null;
  let o = 0;
  let n = 0;
  for (const l of props.lines) {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(l);
    if (m) {
      o = Number(m[1]);
      n = Number(m[2]);
      cur = { oldStart: o, newStart: n, header: m[3].trim(), rows: [], oldEnd: o - 1, newEnd: n - 1 };
      out.push(cur);
      continue;
    }
    if (!cur) continue;
    if (l.startsWith("+")) cur.rows.push({ kind: "add", old: null, new: n++, text: l.slice(1) });
    else if (l.startsWith("-")) cur.rows.push({ kind: "del", old: o++, new: null, text: l.slice(1) });
    else if (l.startsWith("\\")) cur.rows.push({ kind: "meta", old: null, new: null, text: l });
    else if (l !== "" || cur.rows.length) cur.rows.push({ kind: "ctx", old: o++, new: n++, text: l.slice(1) });
    cur.oldEnd = o - 1;
    cur.newEnd = n - 1;
  }
  // A trailing empty line of the patch is not part of the file.
  for (const h of out) while (h.rows.length && h.rows.at(-1)!.kind === "ctx" && h.rows.at(-1)!.text === "" && h.rows.at(-1)!.new! > h.newEnd) h.rows.pop();
  return out;
});

// Gaps before each hunk and after the last; `head` lines shown from the top of the gap, `tail` from its bottom.
const gaps = ref<Gap[]>([]);
function buildGaps() {
  const list: Gap[] = [];
  let prevNew = 0;
  let prevDelta = 0;
  for (const h of hunks.value) {
    list.push({ from: prevNew + 1, to: h.newStart - 1, delta: h.oldStart - h.newStart, head: 0, tail: 0 });
    prevNew = h.newEnd;
    prevDelta = h.oldEnd - h.newEnd;
  }
  list.push({ from: prevNew + 1, to: null, delta: prevDelta, head: 0, tail: 0 });
  gaps.value = list;
}
buildGaps();

const file = ref<string[] | null>(null);
const loading = ref(false);
async function ensureFile() {
  if (file.value || loading.value) return !!file.value;
  loading.value = true;
  try {
    const r = await get<{ lines: string[] }>(`/api/runs/${props.runId}/file?space=${encodeURIComponent(props.space)}&path=${encodeURIComponent(path.value)}`);
    file.value = r.lines.at(-1) === "" ? r.lines.slice(0, -1) : r.lines;
    for (const g of gaps.value) if (g.to === null) g.to = file.value.length;
    return true;
  } catch (e) {
    toast(`读不到完整文件：${(e as Error).message}`, "error");
    return false;
  } finally {
    loading.value = false;
  }
}
const size = (g: Gap) => (g.to === null ? Infinity : Math.max(0, g.to - g.from + 1));
const hidden = (g: Gap) => (g.to === null ? Infinity : Math.max(0, size(g) - g.head - g.tail));
async function expand(g: Gap, where: "down" | "up" | "all") {
  if (!(await ensureFile())) return;
  const left = hidden(g);
  if (where === "all") g.head += left;
  else if (where === "down") g.head += Math.min(20, left);
  else g.tail += Math.min(20, left);
}
function gapRows(g: Gap, part: "head" | "tail"): Row[] {
  if (!file.value) return [];
  const start = part === "head" ? g.from : g.from + size(g) - g.tail;
  const count = part === "head" ? g.head : g.tail;
  const rows: Row[] = [];
  for (let n = start; n < start + count && n <= file.value.length; n++) rows.push({ kind: "ctx", old: n + g.delta, new: n, text: file.value[n - 1] ?? "" });
  return rows;
}
const pointsAt = (n: number | null) => (n === null ? [] : props.points.filter((p) => n >= p.start && n <= p.end));
/** A point's mark goes on its first line in each hunk. */
const marksAt = (h: Hunk, j: number) => {
  const r = h.rows[j];
  // Deleted lines have no new line number: look past them.
  let k = j - 1;
  while (k >= 0 && h.rows[k].new === null) k--;
  const prev = k >= 0 ? h.rows[k].new : null;
  return pointsAt(r.new).filter((p) => prev === null || prev < p.start || prev > p.end);
};
const rowClass = (r: Row) => [r.kind, { cp: pointsAt(r.new).length > 0, "cp-on": !!props.active && pointsAt(r.new).some((p) => p.id === props.active) }];
// An index preview must not expand context from the working copy, which may have later edits.
const canExpand = (g: Gap) => props.expandable && !deleted.value && (g.to === null ? !file.value || hidden(g) > 0 : hidden(g) > 0);
const gapLabel = (g: Gap) => (g.to === null && !file.value ? "下方的代码" : `${hidden(g)} 行未改动`);
</script>

<template>
  <div class="dfile" :data-space="space" :data-path="path">
    <table class="dtable">
      <tbody>
        <template v-for="(h, i) in hunks" :key="i">
          <template v-if="canExpand(gaps[i]) || gaps[i].head || gaps[i].tail">
            <tr v-for="r in gapRows(gaps[i], 'head')" :key="`h${i}-${r.new}`" class="ctx" :data-line="r.new"><td class="no">{{ r.old }}</td><td class="no">{{ r.new }}</td><td class="code"><span class="sign"> </span>{{ r.text }}</td></tr>
            <tr v-if="canExpand(gaps[i])" class="gap">
              <td colspan="3">
                <span class="muted">{{ gapLabel(gaps[i]) }}</span>
                <button v-if="i > 0" class="lnk" type="button" :disabled="loading" @click="expand(gaps[i], 'down')">↓ 展开 20 行</button>
                <button class="lnk" type="button" :disabled="loading" @click="expand(gaps[i], 'up')">↑ 展开 20 行</button>
                <button v-if="hidden(gaps[i]) <= 200" class="lnk" type="button" :disabled="loading" @click="expand(gaps[i], 'all')">全部展开</button>
              </td>
            </tr>
            <tr v-for="r in gapRows(gaps[i], 'tail')" :key="`t${i}-${r.new}`" class="ctx" :data-line="r.new"><td class="no">{{ r.old }}</td><td class="no">{{ r.new }}</td><td class="code"><span class="sign"> </span>{{ r.text }}</td></tr>
          </template>
          <tr class="hunk"><td colspan="3">@@ -{{ h.oldStart }} +{{ h.newStart }} @@ {{ h.header }}</td></tr>
          <tr v-for="(r, j) in h.rows" :key="`${i}-${j}`" :class="rowClass(r)" :data-line="r.new ?? r.old"><td class="no">{{ r.old ?? "" }}</td><td class="no"><button v-for="p in marksAt(h, j)" :key="p.id" class="cpm" :style="{ background: p.color }" :title="`变更点 ${p.id}`" @click="emit('point', p.id)">{{ p.mark }}</button>{{ r.new ?? "" }}</td><td class="code"><span class="sign">{{ r.kind === "add" ? "+" : r.kind === "del" ? "-" : " " }}</span>{{ r.text }}</td></tr>
        </template>
        <template v-if="hunks.length">
          <tr v-for="r in gapRows(gaps[hunks.length], 'head')" :key="`end-${r.new}`" class="ctx" :data-line="r.new"><td class="no">{{ r.old }}</td><td class="no">{{ r.new }}</td><td class="code"><span class="sign"> </span>{{ r.text }}</td></tr>
          <tr v-if="canExpand(gaps[hunks.length])" class="gap">
            <td colspan="3">
              <span class="muted">{{ gapLabel(gaps[hunks.length]) }}</span>
              <button class="lnk" type="button" :disabled="loading" @click="expand(gaps[hunks.length], 'down')">↓ 展开 20 行</button>
              <button v-if="file && hidden(gaps[hunks.length]) <= 200" class="lnk" type="button" :disabled="loading" @click="expand(gaps[hunks.length], 'all')">全部展开</button>
            </td>
          </tr>
        </template>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.dfile { overflow-x: auto; }
.dtable { border-collapse: collapse; width: 100%; font-family: var(--mono); font-size: 12px; line-height: 1.6; }
.dtable td { padding: 0; vertical-align: top; }
.no { width: 1%; min-width: 38px; padding: 0 8px !important; text-align: right; color: var(--muted); user-select: none; white-space: nowrap; }
.code { white-space: pre; padding-right: 16px !important; }
.sign { display: inline-block; width: 16px; text-align: center; user-select: none; color: var(--muted); }
.add { background: var(--ok-soft); }
.del { background: var(--danger-soft); }
.add .sign { color: var(--ok); }
.del .sign { color: var(--danger); }
.hunk td { color: var(--muted); background: var(--sunken); padding: 2px 12px !important; }
.meta td { color: var(--muted); }
.gap td { background: var(--accent-soft); padding: 3px 12px !important; font-family: var(--sans); font-size: 12px; }
.gap .muted { margin-right: 10px; }
.lnk { border: 0; background: none; color: var(--accent); cursor: pointer; font: inherit; padding: 0 6px; }
.lnk:hover { text-decoration: underline; }
.lnk:disabled { opacity: 0.5; cursor: default; }
.cp > td:first-child { box-shadow: inset 3px 0 0 var(--line-strong); }
.cp-on > td { background-image: linear-gradient(var(--accent-soft), var(--accent-soft)); }
.cp-on > td:first-child { box-shadow: inset 3px 0 0 var(--accent); }
.cpm { display: inline-flex; align-items: center; justify-content: center; min-width: 16px; height: 16px; margin-right: 4px; padding: 0 3px; border: 0; border-radius: 4px; color: #fff; font: 600 10.5px/1 var(--sans); cursor: pointer; vertical-align: 1px; }
</style>
