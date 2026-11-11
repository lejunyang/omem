<script setup lang="ts">
import { computed } from "vue";
import { useRoute } from "vue-router";
import DesignView from "../components/DesignView.vue";
import Icon from "../components/Icon.vue";

/** #/design/:id — one design on its own page (docs/v2/coding-plan.md §5). */
const route = useRoute();
const id = computed(() => String(route.params.id ?? ""));
</script>

<template>
  <div class="design-page">
    <nav class="row small crumbs"><router-link to="/designs" class="link"><Icon name="left" :size="13" />方案</router-link></nav>
    <DesignView v-if="id" :key="id" :design-id="id" />
  </div>
</template>

<style scoped>
.design-page { max-width: 1120px; margin: 0 auto; padding: 20px 24px 40px; display: grid; gap: 10px; min-width: 0; }
.crumbs .link { display: inline-flex; align-items: center; gap: 4px; color: var(--muted); }
@media (max-width: 760px) { .design-page { padding: 14px 12px 32px; } }
</style>
