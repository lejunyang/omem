<script setup lang="ts">
import { computed } from "vue";
import { post } from "../api";
import Icon from "./Icon.vue";
import WorkStageTrack from "./WorkStageTrack.vue";
import WorkTimeline from "./WorkTimeline.vue";
import { itemKindLabel, toast } from "../store";
import { dayLabel, daysAgo, flatChildren, itemStatusLabel, shortDay, waitsForOwner, type ChangeLite, type Line, type NextLite } from "../lib/work";

/**
 * One line on the work page: its name, where it stands as of its last look, its last key changes
 * ending in its open next steps, and its work items with how far each one's flow has come. 更新 asks
 * the look to run now (it writes 现在 and the next steps; the page refreshes when it is done).
 */
/** `readonly`: someone else reading the owner's line (views/Work.vue `shared`): no 更新, no 现在整理. */
const props = defineProps<{ line: Line; readonly?: boolean }>();
const emit = defineEmits<{ change: [c: ChangeLite]; next: [n: NextLite, line: Line] }>();
const l = computed(() => props.line);
const kids = computed(() => flatChildren(l.value.children));
const shown = computed(() => kids.value.slice(0, 8));
const tone = computed(() => (l.value.status === "waiting" ? "warn" : l.value.status === "snoozed" ? "quiet" : "ok"));
const overdue = computed(() => !!l.value.dueAt && daysAgo(l.value.dueAt) > 0);
const stale = computed(() => !!l.value.now && daysAgo(l.value.now.at) >= 2);
async function refresh() {
  try {
    const r = await post<{ runId: string; status: string }>(`/api/work/${l.value.id}/refresh`, {});
    toast(`在整理「${l.value.title}」的现状和下一步，好了这里会更新`, "ok", `#/runs/${r.runId}`);
  } catch (e) {
    toast((e as Error).message, "error");
  }
}
</script>

<template>
  <article class="line card" :aria-labelledby="`line-${l.id}`">
    <header class="head">
      <router-link :id="`line-${l.id}`" :to="`/work/${l.id}`" class="name">{{ l.title }}</router-link>
      <span v-if="l.phase === 'watching'" class="state watch" :title="l.watchUntil ? `观察到 ${dayLabel(l.watchUntil)}，期间没有新问题会自动结束` : undefined"><i />观察中<template v-if="l.watchUntil"> · 到 {{ shortDay(l.watchUntil) }}</template></span>
      <span v-else class="state" :class="tone"><i />{{ itemStatusLabel[l.status] ?? l.status }}</span>
      <span class="facts">
        <span v-if="l.kind !== 'line'">{{ itemKindLabel[l.kind] ?? l.kind }}</span>
        <span>{{ l.counts.changes }} 条{{ l.counts.lastAt ? ` · ${dayLabel(l.counts.lastAt)}` : "" }}</span>
        <span v-if="l.counts.today" class="today">今天 {{ l.counts.today }} 条</span>
        <span v-if="l.dueAt" :class="{ overdue }">截止 {{ dayLabel(l.dueAt) }}</span>
      </span>
      <span class="spacer" />
      <span v-if="!readonly" class="tools">
        <router-link v-if="l.listen" :to="`/listen/${l.listen.id}`" class="lnk small muted" title="这条线的关注：读它的群和文档">关注中</router-link>
        <button type="button" class="btn ghost sm" title="现在整理这条线的现状和下一步" @click="refresh"><Icon name="refresh" :size="14" />更新</button>
      </span>
    </header>
    <p v-if="l.now" class="now">{{ l.now.text }}<span v-if="stale" class="muted small"> · {{ dayLabel(l.now.at) }}整理</span></p>
    <p v-else-if="!readonly" class="now muted">还没整理过这条线的现状。<button type="button" class="lnk" @click="refresh">现在整理</button></p>

    <WorkTimeline :changes="l.timeline" :next="l.next" :line-id="l.id" @change="(c) => emit('change', c)" @next="(n) => emit('next', n, l)" />

    <div v-if="kids.length" class="kids" aria-label="工作项">
      <router-link v-for="k in shown" :key="k.child.id" :to="`/work/${k.child.id}`" class="kid" :class="{ deep: k.depth > 0, mine: !readonly && waitsForOwner(k.child) }" :title="k.child.title">
        <span class="kt">{{ k.child.title }}</span>
        <WorkStageTrack v-if="k.child.flow" :flow="k.child.flow" mini />
        <span v-else class="ks">{{ k.child.waitingOn ? `等 ${k.child.waitingOn}` : itemStatusLabel[k.child.status] ?? k.child.status }}</span>
        <span v-if="!readonly && waitsForOwner(k.child)" class="kw">等你</span>
      </router-link>
      <router-link v-if="kids.length > shown.length" :to="`/work/${l.id}?tab=items`" class="kid more">还有 {{ kids.length - shown.length }} 件</router-link>
    </div>
  </article>
</template>

<style scoped>
.line { padding: 16px 18px 14px; display: grid; gap: 10px; min-width: 0; grid-template-columns: minmax(0, 1fr); }
.head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; min-width: 0; }
.tools { display: inline-flex; align-items: center; gap: 10px; align-self: center; }
.tools .lnk { line-height: 1; }
.name { font-family: var(--serif); font-size: 18px; font-weight: 650; color: var(--ink); line-height: 1.35; overflow-wrap: anywhere; min-width: 0; }
.name:hover { text-decoration: none; color: var(--accent); }
.state { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--muted); white-space: nowrap; }
.state i { width: 7px; height: 7px; border-radius: 50%; background: var(--muted); }
.state.ok i { background: var(--ok); }
.state.warn i { background: var(--warn); }
.state.watch { color: var(--accent); }
.state.watch i { background: transparent; border: 1.5px solid var(--accent); width: 8px; height: 8px; box-sizing: border-box; }
.facts { display: inline-flex; flex-wrap: wrap; gap: 0 10px; font-size: 12px; color: var(--muted); }
.today { color: var(--ink-2); }
.overdue { color: var(--danger); }
.now { margin: 0; font-size: 14.5px; line-height: 1.65; color: var(--ink); overflow-wrap: anywhere; }
.now .lnk { font-size: inherit; }
.kids { display: flex; flex-wrap: wrap; gap: 6px; padding-top: 10px; border-top: 1px dashed var(--line); }
.kid { display: inline-flex; align-items: center; gap: 8px; max-width: 100%; min-width: 0; padding: 4px 10px; border: 1px solid var(--line); border-radius: 999px; font-size: 12.5px; color: var(--ink-2); background: var(--panel); }
.kid:hover { text-decoration: none; border-color: var(--line-strong); color: var(--ink); }
.kid.deep::before { content: "└"; color: var(--muted); margin-right: -4px; }
.kid.mine { border-color: color-mix(in srgb, var(--warn) 50%, var(--line)); background: var(--warn-soft); }
.kt { min-width: 0; max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ks { color: var(--muted); white-space: nowrap; }
.kw { color: var(--warn); font-weight: 600; white-space: nowrap; }
.kid.more { color: var(--muted); border-style: dashed; }
</style>
