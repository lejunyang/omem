<script setup lang="ts">
import { useRoute } from "vue-router";

/** The two kinds of rules share one page header: what to do on events, and where materials go. */
const route = useRoute();
</script>

<template>
  <nav class="rule-tabs" aria-label="规则类型">
    <router-link to="/rules" class="tab" :class="{ on: route.path !== '/rules/archive' }">任务规则</router-link>
    <router-link to="/rules/archive" class="tab" :class="{ on: route.path === '/rules/archive' }">归档规则</router-link>
  </nav>
</template>

<style scoped>
.rule-tabs {
  display: flex;
  gap: 2px;
}
.tab {
  padding: 4px 8px;
  border-radius: 6px;
  color: var(--ink-2);
  font-size: 13px;
  text-decoration: none;
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
