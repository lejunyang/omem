<script setup lang="ts">
import { useRoute } from "vue-router";
import { state } from "../store";

/** The 流程 page's two parts: items moving through flows, and the flows themselves (the owner's). */
const route = useRoute();
</script>

<template>
  <nav class="flow-tabs" aria-label="流程">
    <router-link to="/board" class="tab" :class="{ on: route.path === '/board' }">进行中</router-link>
    <router-link v-if="!state.me || state.me.role === 'owner'" to="/flows" class="tab" :class="{ on: route.path === '/flows' }">流程定义</router-link>
  </nav>
</template>

<style scoped>
.flow-tabs {
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
