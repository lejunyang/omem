<script setup lang="ts">
import { computed } from "vue";

/**
 * Plain text with some ranges highlighted (search hits). Rendered as text nodes and <mark>
 * elements, never as HTML, so nothing in a document can inject markup.
 */
const props = defineProps<{ text: string; marks?: [number, number][] }>();
const parts = computed(() => {
  const out: { t: string; m: boolean }[] = [];
  let at = 0;
  for (const [s, e] of [...(props.marks ?? [])].sort((a, b) => a[0] - b[0])) {
    if (s < at || e > props.text.length || e <= s) continue;
    if (s > at) out.push({ t: props.text.slice(at, s), m: false });
    out.push({ t: props.text.slice(s, e), m: true });
    at = e;
  }
  if (at < props.text.length) out.push({ t: props.text.slice(at), m: false });
  return out;
});
</script>

<template>
  <span class="hit-text"><template v-for="(p, i) in parts" :key="i"><mark v-if="p.m">{{ p.t }}</mark><template v-else>{{ p.t }}</template></template></span>
</template>

<style scoped>
mark {
  background: var(--mark);
  color: inherit;
  border-radius: 3px;
  padding: 0 1px;
}
</style>
