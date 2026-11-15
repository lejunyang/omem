<script setup lang="ts">
import { computed, type PropType } from "vue";
import Chart from "./Chart.vue";
import { chartProps, specOf } from "./props";

/**
 * Rows of horizontal bars in the given order: a ranking, long names, or several measures of the same
 * unit side by side (each in its own colour, its value right after its bar). `items` is the short
 * form for one measure with a link per row; otherwise give `labels` and `series`.
 */
const props = defineProps({ ...chartProps, items: Array as PropType<{ label: string; value: number; link?: string }[]>, name: { type: String, default: "数量" } });
const spec = computed(() => {
  const { items, name, ...rest } = props;
  if (!items) return specOf("hbar", rest);
  return specOf("hbar", { ...rest, labels: items.map((i) => i.label), series: [{ name, values: items.map((i) => i.value) }], links: items.map((i) => i.link) });
});
</script>

<template>
  <Chart :spec="spec" />
</template>
