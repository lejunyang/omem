<script setup lang="ts" generic="T">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";

/**
 * Renders only the rows near the viewport. Rows may have any height: each rendered row is
 * measured (ResizeObserver) and unmeasured rows use `estimate`. The list scrolls with the
 * nearest scrollable ancestor (or the window), so it can sit inside an existing page layout.
 * Rows that grow above the viewport shift the scroll position by the same amount, so what
 * you are reading does not jump.
 */
const props = withDefaults(defineProps<{ items: T[]; itemKey: (item: T, index: number) => string | number; estimate?: number; overscan?: number }>(), { estimate: 48, overscan: 800 });

const root = ref<HTMLElement | null>(null);
const heights = shallowRef(new Map<string | number, number>());
const range = ref({ start: 0, end: Math.min(props.items.length, 40) });
let scroller: HTMLElement | Window = window;
let observer: ResizeObserver | null = null;
let frame = 0;

const keys = computed(() => props.items.map((it, i) => props.itemKey(it, i)));
const offsets = computed(() => {
  const out = new Float64Array(props.items.length + 1);
  const h = heights.value;
  for (let i = 0; i < props.items.length; i++) out[i + 1] = out[i] + (h.get(keys.value[i]) ?? props.estimate);
  return out;
});
const total = computed(() => offsets.value[props.items.length]);
const visible = computed(() => {
  const out: { item: T; index: number; key: string | number }[] = [];
  for (let i = range.value.start; i < range.value.end && i < props.items.length; i++) out.push({ item: props.items[i], index: i, key: keys.value[i] });
  return out;
});
const padTop = computed(() => offsets.value[Math.min(range.value.start, props.items.length)]);
const padBottom = computed(() => Math.max(0, total.value - offsets.value[Math.min(range.value.end, props.items.length)]));

function findScroller(el: HTMLElement | null): HTMLElement | Window {
  for (let p = el?.parentElement; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY;
    if ((o === "auto" || o === "scroll" || o === "overlay") && p.scrollHeight > p.clientHeight + 1) return p;
  }
  return window;
}
const viewport = () =>
  scroller === window ? { top: window.scrollY, height: window.innerHeight } : { top: (scroller as HTMLElement).scrollTop, height: (scroller as HTMLElement).clientHeight };
/** Where the list starts inside the scroller's content. */
function listTop() {
  if (!root.value) return 0;
  const r = root.value.getBoundingClientRect().top;
  return scroller === window ? r + window.scrollY : r - (scroller as HTMLElement).getBoundingClientRect().top + (scroller as HTMLElement).scrollTop;
}
function lowerBound(y: number) {
  const o = offsets.value;
  let lo = 0;
  let hi = props.items.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (o[mid + 1] <= y) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
function update() {
  frame = 0;
  if (!root.value) return;
  const v = viewport();
  const top = v.top - listTop();
  const start = Math.max(0, lowerBound(top - props.overscan));
  const end = Math.min(props.items.length, lowerBound(top + v.height + props.overscan) + 1);
  if (start !== range.value.start || end !== range.value.end) range.value = { start, end };
}
const schedule = () => {
  if (!frame) frame = requestAnimationFrame(update);
};

function measure(entries: ResizeObserverEntry[]) {
  let changed = false;
  let shift = 0;
  const next = new Map(heights.value);
  const v = viewport();
  const top = v.top - listTop();
  for (const e of entries) {
    const el = e.target as HTMLElement;
    const i = Number(el.dataset.vIndex);
    const key = keys.value[i];
    if (key === undefined) continue;
    const h = el.offsetHeight;
    const old = next.get(key) ?? props.estimate;
    if (Math.abs(old - h) < 0.5) continue;
    next.set(key, h);
    changed = true;
    if (offsets.value[i + 1] <= top) shift += h - old;
  }
  if (!changed) return;
  heights.value = next;
  if (shift) {
    if (scroller === window) window.scrollBy(0, shift);
    else (scroller as HTMLElement).scrollTop += shift;
  }
  schedule();
}

function observeRows() {
  if (!observer || !root.value) return;
  observer.disconnect();
  for (const el of root.value.querySelectorAll<HTMLElement>(":scope > .v-row")) observer.observe(el);
}

/** Bring a row into view (align "start" or "center"). */
async function scrollToIndex(index: number, align: "start" | "center" = "center") {
  if (index < 0 || index >= props.items.length) return;
  const place = () => {
    const v = viewport();
    const y = listTop() + offsets.value[index] - (align === "center" ? Math.max(0, (v.height - (heights.value.get(keys.value[index]) ?? props.estimate)) / 2) : 0);
    if (scroller === window) window.scrollTo({ top: y });
    else (scroller as HTMLElement).scrollTop = y;
    update();
  };
  place();
  // Measured heights around the target can differ from the estimate: settle twice.
  await nextTick();
  await new Promise((r) => requestAnimationFrame(r));
  place();
  await new Promise((r) => requestAnimationFrame(r));
  place();
}
defineExpose({ scrollToIndex });

onMounted(() => {
  scroller = findScroller(root.value);
  scroller.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("resize", schedule);
  observer = new ResizeObserver(measure);
  update();
  void nextTick(observeRows);
});
onBeforeUnmount(() => {
  scroller.removeEventListener("scroll", schedule);
  window.removeEventListener("resize", schedule);
  observer?.disconnect();
  if (frame) cancelAnimationFrame(frame);
});
watch(
  () => props.items,
  () => {
    update();
    void nextTick(observeRows);
  },
);
watch(range, () => void nextTick(observeRows));
</script>

<template>
  <div ref="root" class="v-list" :style="{ paddingTop: `${padTop}px`, paddingBottom: `${padBottom}px` }">
    <div v-for="row in visible" :key="row.key" class="v-row" :data-v-index="row.index">
      <slot :item="row.item" :index="row.index" />
    </div>
  </div>
</template>

<style scoped>
.v-list {
  position: relative;
}
.v-row {
  /* Rows are measured with offsetHeight: margins of the slot content would be lost. */
  display: flow-root;
}
</style>
