<script setup lang="ts">
import { onMounted, ref, watch, type PropType } from "vue";
import { metricsElement, type MetricItem } from "@omem-ai/plugin-sdk/charts";

/**
 * A row of figures divided by hairlines: label, number and unit, the change and its basis, a small
 * course under it. A figure with `link` opens its records. Same drawing as the `metric` block.
 *
 * With `keys` every figure is a button: clicking it emits `select` with its key, and the figure whose
 * key is `selected` is marked open (`aria-expanded`). The row is drawn again only when what it shows
 * changes (a new array with the same figures does not count), so opening a figure never replays the
 * numbers counting up.
 */
const props = defineProps({
  items: { type: Array as PropType<MetricItem[]>, required: true },
  title: String,
  note: String,
  keys: Array as PropType<string[]>,
  selected: { type: String as PropType<string | null>, default: null },
  /** Every figure the same shape (a grid of many): see MetricGroup.even. */
  even: Boolean,
});
const emit = defineEmits<{ select: [key: string] }>();
const el = ref<HTMLElement>();
let drawn = "";
let drawnValues = "";

function mark() {
  if (!el.value || !props.keys) return;
  el.value.querySelectorAll<HTMLElement>("button.oc-metric").forEach((b, i) => {
    b.dataset.key = props.keys![i] ?? "";
    b.setAttribute("aria-expanded", String(!!props.selected && props.keys![i] === props.selected));
  });
}
function draw() {
  if (!el.value) return;
  const sig = JSON.stringify([props.items, props.title, props.note, props.keys, props.even]);
  if (sig === drawn) return;
  drawn = sig;
  // Drawn again for something else than the numbers (a tag, a note): the numbers do not count up again.
  const values = JSON.stringify(props.items.map((i) => [i.value, i.spark]));
  if (drawnValues && values === drawnValues) el.value.setAttribute("data-chart-still", "");
  else el.value.removeAttribute("data-chart-still");
  drawnValues = values;
  const keys = props.keys;
  el.value.replaceChildren(metricsElement(document, { title: props.title, note: props.note, items: props.items, even: props.even }, keys ? { select: (i) => keys[i] !== undefined && emit("select", keys[i]) } : {}));
  mark();
}
onMounted(draw);
watch(() => [props.items, props.title, props.note, props.keys], draw, { deep: true });
watch(() => props.selected, mark);

/** Put the focus back on a figure (after its details close). */
function focusKey(key: string) {
  el.value?.querySelector<HTMLElement>(`button.oc-metric[data-key="${CSS.escape(key)}"]`)?.focus();
}
defineExpose({ focusKey });
</script>

<template>
  <div ref="el" class="omem-metrics" />
</template>
