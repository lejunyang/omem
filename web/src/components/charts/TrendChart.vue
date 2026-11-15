<script setup lang="ts">
import { computed } from "vue";
import Chart from "./Chart.vue";
import { chartProps, specOf } from "./props";

/** A course over time: a line, or with `area` the amount under it. Several lines are named at their ends. */
const props = defineProps({ ...chartProps, area: Boolean });
const spec = computed(() => {
  const { area, ...rest } = props;
  return specOf(area ? "area" : "line", rest);
});
</script>

<template>
  <Chart :spec="spec" />
</template>
