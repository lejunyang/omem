<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { get, onServerEvent } from "../api";
import CodeWorkRow from "./CodeWorkRow.vue";
import Skeleton from "./Skeleton.vue";
import { GROUPS, type CodeWork } from "../lib/works";

/**
 * Every delegation and branch review, one row each, grouped by who it waits on (the run page's
 * “编码”; src/agents/code-works.ts). `space` null: all spaces. Ended ones come last, the latest few
 * unless asked for more.
 */
const props = defineProps<{ space: string | null; q: string; active: string | null }>();
const emit = defineEmits<{ pick: [work: CodeWork] }>();
const works = ref<CodeWork[]>([]);
const loading = ref(true);
const allEnded = ref(false);
let seq = 0;
async function load() {
  const request = ++seq;
  const query = new URLSearchParams();
  if (props.space) query.set("space", props.space);
  if (props.q.trim()) query.set("q", props.q.trim());
  if (allEnded.value) query.set("ended", "1");
  try {
    const list = await get<CodeWork[]>(`/api/code-works?${query}`);
    if (request === seq) works.value = list;
  } catch {
    if (request === seq) works.value = [];
  } finally {
    if (request === seq) loading.value = false;
  }
}
let typing: ReturnType<typeof setTimeout> | undefined;
watch(() => [props.space, allEnded.value], () => { loading.value = true; void load(); }, { immediate: true });
watch(() => props.q, () => { clearTimeout(typing); typing = setTimeout(() => void load(), 250); });
let timer: ReturnType<typeof setTimeout> | undefined;
const off = onServerEvent((e) => {
  if ((e.type === "run" && (e.status !== "running" || !works.value.some((w) => w.latestId === e.runId && w.stage.key === "running"))) || (e.type === "changed" && (e as { entity?: string }).entity === "code-task")) {
    clearTimeout(timer);
    timer = setTimeout(() => void load(), 800);
  }
});
onBeforeUnmount(() => { ++seq; off(); clearTimeout(timer); clearTimeout(typing); });
const groups = computed(() => GROUPS.map((g) => ({ ...g, list: works.value.filter((w) => w.stage.group === g.id) })).filter((g) => g.list.length));
const ended = computed(() => works.value.filter((w) => w.stage.group === "ended").length);
</script>

<template>
  <div class="code-works">
    <Skeleton v-if="loading && !works.length" :rows="8" />
    <template v-else>
      <section v-for="g in groups" :key="g.id" class="group" :aria-label="g.label">
        <div class="gh"><b>{{ g.label }}</b><span>{{ g.list.length }}</span></div>
        <CodeWorkRow v-for="w in g.list" :key="w.rootId" :work="w" :active="w.rootId === active" @pick="emit('pick', w)" />
      </section>
      <button v-if="ended >= 10 && !allEnded" type="button" class="lnk small more" @click="allEnded = true">看更早结束的</button>
      <p v-if="!works.length" class="muted small empty">{{ q.trim() ? "没有符合条件的交办。" : "这里还没有交办。让助手改代码、评审分支，或点右上角的“交办”。" }}</p>
    </template>
  </div>
</template>

<style scoped>
.code-works { display: grid; gap: 4px; }
.gh { display: flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--muted); padding: 10px 10px 4px; }
.gh b { color: var(--ink-2); font-weight: 600; }
.lnk { border: 0; background: none; color: var(--accent); cursor: pointer; padding: 6px 10px; justify-self: start; }
.empty { padding: 10px; margin: 0; }
</style>
