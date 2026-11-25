<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { get, onServerEvent } from "../api";
import { SITUATION_VERSUS, SITUATION_WHAT, type ListenView, type SituationInstance } from "../lib/listen";
import { plainLine } from "../lib/plain";
import HelpText from "./HelpText.vue";
import Icon from "./Icon.vue";
import Skeleton from "./Skeleton.vue";

/**
 * The owner's 持续跟进 rules on the work page's rail, beside 在跟的问题 (the place 关注): what goes on now.
 * A row each — the name, whether it is on and how many follow-ups go on now, the first sentence of what
 * the owner wrote — opening the rule on the rules page (its 各次). The rules are made and changed there;
 * empty, one line on what they are and a way to make one.
 */
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
const ruleLink = (v: ListenView, tab?: string) => ({ path: "/rules", query: { id: `situation:${v.id}`, ...(tab ? { tab } : {}) } });
const NEW = { path: "/rules", query: { new: "1", follow: "1" } };
</script>

<template>
  <section class="situations" aria-labelledby="sit-title">
    <h2 id="sit-title" class="section-title row">
      <span class="grow">持续跟进</span>
      <router-link v-if="list?.length" :to="NEW" class="btn ghost sm icon" title="新建持续跟进的规则" aria-label="新建持续跟进的规则"><Icon name="plus" :size="14" /></router-link>
    </h2>
    <Skeleton v-if="!list" variant="list" :rows="2" />
    <template v-else-if="!list.length">
      <HelpText>持续跟进是一种规则：{{ SITUATION_WHAT }} {{ SITUATION_VERSUS }}</HelpText>
      <router-link :to="NEW" class="btn sm new"><Icon name="plus" :size="14" />新建持续跟进的规则</router-link>
    </template>
    <template v-else>
      <router-link v-for="v in sorted" :key="v.id" :to="ruleLink(v, going[v.id] ? 'rounds' : undefined)" class="sit" :class="{ off: v.status !== 'active' }">
        <span class="top">
          <span class="name">{{ v.name }}</span>
          <span v-if="v.status !== 'active'" class="state muted">停用</span>
          <span v-else-if="going[v.id]" class="state on">进行中 {{ going[v.id] }} 次</span>
          <span v-else class="state muted">在等</span>
        </span>
        <span v-if="v.note" class="note">{{ plainLine(v.note, 80) }}</span>
      </router-link>
      <router-link to="/rules" class="manage small">在规则页管理</router-link>
    </template>
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
  padding: 7px 0;
  border-radius: 8px;
  color: inherit;
  text-decoration: none;
  min-width: 0;
}
/* The hover background reaches past the text with a shadow, not a negative margin (that widens the rail). */
.sit:hover {
  background: var(--hover);
  box-shadow: -8px 0 0 var(--hover), 8px 0 0 var(--hover);
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
.note {
  font-size: 12.5px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.note {
  color: var(--ink-2);
}
.manage {
  justify-self: start;
  margin-top: 4px;
  color: var(--muted);
}
</style>
