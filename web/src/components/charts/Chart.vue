<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch, type PropType } from "vue";
import { mountChart, type ChartSpec } from "@omem-ai/plugin-sdk/charts";

/**
 * Any chart, drawn by the one drawing omem has (packages/plugin-sdk/charts.ts; component blocks use
 * it too). The other components in this folder are this with the kind and the props named.
 */
const props = defineProps({ spec: { type: Object as PropType<ChartSpec>, required: true } });
const el = ref<HTMLElement>();
let stop = () => {};
function draw() {
  stop();
  if (el.value) stop = mountChart(el.value, props.spec);
}
onMounted(draw);
watch(() => props.spec, draw, { deep: true });
onBeforeUnmount(() => stop());
</script>

<template>
  <div ref="el" class="omem-chart" />
</template>
