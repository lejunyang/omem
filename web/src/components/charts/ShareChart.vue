<script setup lang="ts">
import { computed, type PropType } from "vue";
import Chart from "./Chart.vue";

/** Shares of a whole: a thin ring with the total inside, the parts listed with value and share (at most eight). */
const props = defineProps({
  title: String,
  labels: { type: Array as PropType<string[]>, required: true },
  values: { type: Array as PropType<number[]>, required: true },
  unit: String,
  note: String,
  links: Array as PropType<(string | undefined)[]>,
});
const spec = computed(() => ({ kind: "pie" as const, title: props.title, labels: props.labels, series: [{ name: props.title ?? "构成", values: props.values }], unit: props.unit, note: props.note, links: props.links }));
</script>

<template>
  <Chart :spec="spec" />
</template>
