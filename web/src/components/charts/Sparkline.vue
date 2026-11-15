<script setup lang="ts">
import { onMounted, ref, watch, type PropType } from "vue";
import { sparkline } from "@omem-ai/plugin-sdk/charts";

/** A recent course as a hairline with a dot on the last value, beside or under a number. `label` is what a screen reader hears. */
const props = defineProps({ values: { type: Array as PropType<number[]>, required: true }, label: String });
const el = ref<HTMLElement>();
function draw() {
  if (el.value) el.value.replaceChildren(...(props.values.length > 1 ? [sparkline(document, props.values, props.label)] : []));
}
onMounted(draw);
watch(() => [props.values, props.label], draw, { deep: true });
</script>

<template>
  <span ref="el" class="omem-spark" />
</template>

<style scoped>
.omem-spark { display: block; min-width: 0; }
</style>
