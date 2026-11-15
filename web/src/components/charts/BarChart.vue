<script setup lang="ts">
import { computed } from "vue";
import Chart from "./Chart.vue";
import { chartProps, specOf } from "./props";

/** Columns: a few things compared, or a count per day; `stack` adds several up. */
const props = defineProps(chartProps);
const spec = computed(() => specOf("bar", props));
</script>

<template>
  <Chart :spec="spec" />
</template>
