<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { get, onServerEvent } from "../api";
import { SITUATION_VERSUS, SITUATION_WHAT, type ListenView, type SituationInstance } from "../lib/listen";
import { plainLine } from "../lib/plain";
import HelpText from "./HelpText.vue";
import Icon from "./Icon.vue";
import SituationDialog from "./SituationDialog.vue";
import Skeleton from "./Skeleton.vue";

/**
 * The owner's 情境 on the work page's rail, beside 在跟的问题 (the place 关注) — a matter's 关注 lives on its
 * line. A row each: the name, the first sentence of what the owner wrote, how it is recognized, whether it
 * is on and how many rounds go on now; it opens the situation's page. Empty: what a situation is, against a
 * rule and a flow, and a way to make one.
 */
const router = useRouter();
const list = ref<ListenView[] | null>(null);
const going = ref<Record<string, number>>({});
let seq = 0;
async function load() {
  const my = ++seq;
  const [l, i] = await Promise.all([
    get<ListenView[]>("/api/listen?kind=situation").catch(() => [] as ListenView[]),
    get<SituationInstance[]>("/api/situation-instances?status=active&limit=100").catch(() => [] as SituationInstance[]),
  ]);
  if (my !== seq) return;
  list.value = l;
  const counts: Record<string, number> = {};
  for (const x of i) counts[x.contextId] = (counts[x.contextId] ?? 0) + 1;
  going.value = counts;
}
onMounted(load);
const off = onServerEvent((e) => {
  if (e.type === "changed" && (e.entity === "listen" || e.entity === "rule")) void load();
});
onBeforeUnmount(off);
const sorted = computed(() => (list.value ?? []).slice().sort((a, b) => (going.value[b.id] ?? 0) - (going.value[a.id] ?? 0) || (a.status === b.status ? 0 : a.status === "active" ? -1 : 1)));

const creating = ref(false);
function created(v: ListenView) {
  creating.value = false;
  void router.push(`/listen/${encodeURIComponent(v.id)}`);
}
</script>

<template>
  <section class="situations" aria-labelledby="sit-title">
    <h2 id="sit-title" class="section-title row">
      <span class="grow">情境</span>
      <button v-if="list?.length" type="button" class="btn ghost sm icon" title="新建情境" aria-label="新建情境" @click="creating = true"><Icon name="plus" :size="14" /></button>
    </h2>
    <Skeleton v-if="!list" variant="list" :rows="2" />
    <template v-else-if="!list.length">
      <HelpText>{{ SITUATION_WHAT }} {{ SITUATION_VERSUS }}</HelpText>
      <button type="button" class="btn sm new" @click="creating = true"><Icon name="plus" :size="14" />新建情境</button>
    </template>
    <router-link v-for="v in sorted" v-else :key="v.id" :to="`/listen/${encodeURIComponent(v.id)}`" class="sit" :class="{ off: v.status !== 'active' }">
      <span class="top">
        <span class="name">{{ v.name }}</span>
        <span v-if="v.status !== 'active'" class="state muted">停用</span>
        <span v-else-if="going[v.id]" class="state on">进行中 {{ going[v.id] }} 回</span>
        <span v-else class="state muted">在等</span>
      </span>
      <span v-if="v.note" class="note">{{ plainLine(v.note, 80) }}</span>
      <span v-if="v.recognize" class="rec" :title="v.recognize">认出：{{ v.recognize }}</span>
    </router-link>
    <SituationDialog v-if="creating" @close="creating = false" @created="created" />
  </section>
</template>

<style scoped>
.situations {
  display: grid;
  gap: 2px;
  min-width: 0;
}
.section-title {
  gap: 6px;
}
.grow {
  flex: 1;
  min-width: 0;
}
.new {
  justify-self: start;
  margin-top: 6px;
}
.sit {
  display: grid;
  gap: 1px;
  padding: 7px 8px;
  margin: 0 -8px;
  border-radius: 8px;
  color: inherit;
  text-decoration: none;
  min-width: 0;
}
.sit:hover {
  background: var(--hover);
  text-decoration: none;
}
.sit:focus-visible {
  outline: 2px solid var(--accent);
}
.top {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}
.name {
  flex: 1;
  min-width: 0;
  font-size: 13.5px;
  font-weight: 600;
  color: var(--ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sit.off .name {
  color: var(--muted);
}
.state {
  flex: none;
  font-size: 12px;
}
.state.on {
  color: var(--accent);
  font-weight: 600;
}
.note,
.rec {
  font-size: 12.5px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.note {
  color: var(--ink-2);
}
.rec {
  color: var(--muted);
}
</style>
