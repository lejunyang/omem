<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { get, onServerEvent, onServerResync } from "../api";
import { boardLine, type BoardRow, type FlowFile } from "../lib/flow";
import Skeleton from "./Skeleton.vue";
import UiSegmented from "./UiSegmented.vue";
import { fmtTime, state } from "../store";

/**
 * Every item whose flow is running, by the stage it is at (docs/v2/flows.md §7): one section per
 * flow, one lane per stage in the flow's own order. The lanes are the flow strip laid out sideways.
 * The work page's 按阶段 view (views/Work.vue); `/board` opens it there.
 */
type Only = "all" | "mine" | "blocked";
const rows = ref<BoardRow[] | null>(null), flows = ref<FlowFile[]>([]), error = ref(""), only = ref<Only>("all");
const now = ref(Date.now());
const clock = setInterval(() => { now.value = Date.now(); }, 60000);
let seq = 0;
async function load() {
  const request = ++seq;
  try {
    const [board, defs] = await Promise.all([get<BoardRow[] | { items: BoardRow[] }>("/api/flows/board"), get<{ flows: FlowFile[] }>("/api/flows").catch(() => ({ flows: [] }))]);
    if (request !== seq) return;
    rows.value = Array.isArray(board) ? board : board.items; flows.value = defs.flows; error.value = "";
  } catch (e) { if (request === seq) error.value = (e as Error).message; }
}
onMounted(load);
const off = onServerEvent((e) => { if (e.type === "changed" && e.entity === "item") void load(); });
const resync = onServerResync(() => void load());
onBeforeUnmount(() => { ++seq; off(); resync(); clearInterval(clock); });

const mine = computed(() => (rows.value ?? []).filter((r) => r.waiting === "owner"));
const blocked = computed(() => (rows.value ?? []).filter((r) => r.stage.state === "blocked"));
const shown = computed(() => only.value === "mine" ? mine.value : only.value === "blocked" ? blocked.value : rows.value ?? []);
const filters = computed(() => [
  { value: "all" as Only, label: `全部 ${rows.value?.length ?? 0}` },
  { value: "mine" as Only, label: `等我的 ${mine.value.length}` },
  { value: "blocked" as Only, label: `卡住的 ${blocked.value.length}` },
]);
/** A flow's lanes follow its definition; a stage only an item's own copy still has goes last. */
const sections = computed(() => {
  const byFlow = new Map<string, BoardRow[]>();
  for (const r of shown.value) byFlow.set(r.flowId, [...(byFlow.get(r.flowId) ?? []), r]);
  return [...byFlow].map(([id, list]) => {
    const defined = flows.value.find((f) => f.id === id)?.definition?.stages.map((s) => ({ id: s.id, name: s.name })) ?? [];
    const extra = list.filter((r) => !defined.some((s) => s.id === r.stage.id)).map((r) => ({ id: r.stage.id, name: r.stage.name }));
    const stages = [...defined, ...extra.filter((s, i) => extra.findIndex((x) => x.id === s.id) === i)];
    return { id, name: list[0].flowName, count: list.length, lanes: stages.map((s) => {
      const here = list.filter((r) => r.stage.id === s.id).sort((a, b) => Number(!!b.waiting) - Number(!!a.waiting) || (a.since ?? "").localeCompare(b.since ?? ""));
      return { ...s, rows: here, tone: here.some((r) => r.waiting) ? "warn" : here.some((r) => r.stage.state === "doing") ? "accent" : "quiet" };
    }) };
  }).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
});
</script>

<template>
  <div class="board">
    <div class="toolbar row wrap">
      <UiSegmented v-model="only" size="sm" aria-label="看哪些" :options="filters" />
      <span class="spacer" />
      <router-link v-if="!state.me || state.me.role === 'owner'" to="/flows" class="small">流程定义</router-link>
    </div>
    <p v-if="error" class="error small" role="alert">{{ error }} <button class="btn ghost sm" @click="load">重试</button></p>
    <Skeleton v-if="!rows && !error" variant="cards" :rows="3" />
    <p v-else-if="rows && !rows.length" class="muted">现在没有在走流程的事项。打开一件工作项点“用流程推进”，它就会出现在这里。</p>
    <p v-else-if="rows && !shown.length" class="muted">{{ only === "mine" ? "没有等你的。" : "没有卡住的。" }}</p>
    <section v-for="f in sections" :key="f.id" class="flow">
      <h2 class="section-title">{{ f.name }} <span class="count">{{ f.count }}</span></h2>
      <div class="lanes">
        <div v-for="l in f.lanes" :key="l.id" class="lane" :class="[l.tone, { bare: !l.rows.length }]">
          <div class="lane-head"><span class="lane-bar" /><span class="lane-name">{{ l.name }}</span><span v-if="l.rows.length" class="count">{{ l.rows.length }}</span></div>
          <router-link v-for="r in l.rows" :key="r.itemId" :to="!state.me || state.me.role === 'owner' ? `/work/${r.itemId}` : `/items/${r.itemId}/flow`" class="entry" :class="{ waiting: !!r.waiting }">
            <span class="entry-title">{{ r.title }}</span>
            <span class="entry-meta">
              <span :class="{ warn: !!r.waiting }">{{ boardLine(r, now) }}</span>
              <span v-if="r.round && r.round > 1">第 {{ r.round }} 轮</span>
              <span v-if="r.dueAt">截止 {{ fmtTime(r.dueAt) }}</span>
              <span v-if="r.stale" class="warn">停了很久</span>
            </span>
          </router-link>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.board { min-width: 0; }
.toolbar { margin-bottom: 18px; gap: 10px; }
.error { color: var(--danger); }
.flow { margin-bottom: 28px; min-width: 0; }
.count { margin-left: 4px; color: var(--muted); font-weight: 400; font-size: 12px; }

/* One lane per stage, in the flow's order; a lane with nothing in it keeps its place but only its name. */
.lanes { display: flex; gap: 12px; align-items: flex-start; overflow-x: auto; padding-bottom: 6px; }
.lane { flex: 1 1 190px; min-width: 160px; display: grid; gap: 8px; }
.lane.bare { flex: 0 1 88px; min-width: 64px; }
.lane-head { display: grid; grid-template-columns: 1fr auto; gap: 4px 6px; align-items: baseline; font-size: 13px; color: var(--muted); }
.lane-bar { grid-column: 1 / -1; height: 3px; border-radius: 2px; background: var(--line-strong); }
.lane.accent .lane-bar { background: var(--accent); }
.lane.warn .lane-bar { background: var(--warn); }
.lane.bare .lane-bar { background: var(--line); }
.lane:not(.bare) .lane-name { color: var(--ink); }
.lane.warn .lane-name { color: var(--warn); font-weight: 600; }
.lane-name { overflow-wrap: anywhere; }
.entry { display: grid; gap: 4px; padding: 9px 11px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel); color: inherit; text-decoration: none; }
.entry:hover { border-color: var(--line-strong); }
.entry.waiting { border-color: color-mix(in srgb, var(--warn) 45%, var(--line)); }
.entry-title { font-size: 13.5px; line-height: 1.45; overflow-wrap: anywhere; }
.entry-meta { display: flex; flex-wrap: wrap; gap: 2px 10px; font-size: 12px; color: var(--muted); }
.entry-meta .warn { color: var(--warn); }
@media (max-width: 700px) {
  .lanes { flex-direction: column; overflow: visible; }
  .lane, .lane.bare { flex: none; width: 100%; min-width: 0; }
  .lane.bare { display: none; }
}
</style>
