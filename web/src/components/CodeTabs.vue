<script setup lang="ts">
import { computed, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { capAnywhere } from "../lib/caps";
import { state } from "../store";

/**
 * 编码's three kinds of things, one tab each at the top of the list column (like RuleTabs): 交办
 * (delegations and branch reviews, views/Code.vue), 方案 (views/Designs.vue) and 需求 (the space's
 * requirement tree, views/Requirements.vue). Each shows for whoever may read it; landing on one they
 * cannot read moves to the first they can.
 */
export type CodeTab = "work" | "designs" | "reqs";
const TABS: { id: CodeTab; to: string; label: string; cap: string }[] = [
  { id: "work", to: "/code", label: "交办", cap: "code.work.view" },
  { id: "designs", to: "/code/designs", label: "方案", cap: "designs.view" },
  { id: "reqs", to: "/code/reqs", label: "需求", cap: "requirements.view" },
];
const props = defineProps<{ current: CodeTab }>();
const route = useRoute();
const router = useRouter();
const shown = computed(() => (void state.me, TABS.filter((t) => capAnywhere(t.cap, { own: true }))));
watch(shown, (list) => {
  if (list.length && !list.some((t) => t.id === props.current)) void router.replace(list[0].to);
}, { immediate: true });
const on = (t: (typeof TABS)[number]) => t.id === props.current;
</script>

<template>
  <nav class="code-tabs" aria-label="编码">
    <router-link v-for="t in shown" :key="t.id" :to="t.to" class="tab" :class="{ on: on(t) }" :aria-current="on(t) && route.path === t.to ? 'page' : undefined">{{ t.label }}</router-link>
  </nav>
</template>

<style scoped>
.code-tabs {
  display: flex;
  gap: 2px;
  min-width: 0;
}
.tab {
  padding: 4px 8px;
  border-radius: 6px;
  color: var(--ink-2);
  font-size: 13px;
  text-decoration: none;
  white-space: nowrap;
}
.tab:hover {
  color: var(--ink);
}
.tab.on {
  background: var(--hover);
  color: var(--ink);
  font-weight: 600;
}
</style>
