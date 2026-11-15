<script setup lang="ts">
import { onMounted, ref, watch, type PropType } from "vue";
import { metricsElement, type MetricItem } from "@omem-ai/plugin-sdk/charts";

/**
 * A row of figures divided by hairlines: label, number and unit, the change and its basis, a small
 * course under it. A figure with `link` opens its records. Same drawing as the `metric` block.
 */
const props = defineProps({ items: { type: Array as PropType<MetricItem[]>, required: true }, title: String, note: String });
const el = ref<HTMLElement>();
function draw() {
  if (el.value) el.value.replaceChildren(metricsElement(document, { title: props.title, note: props.note, items: props.items }));
}
onMounted(draw);
watch(() => [props.items, props.title, props.note], draw, { deep: true });
</script>

<template>
  <div ref="el" class="omem-metrics" />
</template>
