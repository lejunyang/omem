<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { highlight, languageOf } from "../lib/markdown";

const props = defineProps<{ text: string; start: number; path: string; from?: number; to?: number; wrap?: boolean }>();
const root = ref<HTMLElement>();
const lang = computed(() => languageOf(props.path));
const lines = computed(() =>
  props.text.split("\n").map((line, i) => ({ n: props.start + i, html: lang.value ? highlight(line, lang.value) : line.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!) })),
);
const inRange = (n: number) => props.from !== undefined && n >= props.from && n <= (props.to ?? props.from);

async function scroll() {
  await nextTick();
  const el = root.value?.querySelector<HTMLElement>(".hl");
  if (el) el.scrollIntoView({ block: "center" });
}
onMounted(scroll);
watch(() => [props.from, props.text], scroll);
</script>

<template>
  <div ref="root" class="code" :class="{ wrap }">
    <div v-for="l in lines" :key="l.n" class="ln" :class="{ hl: inRange(l.n) }" :id="`L${l.n}`">
      <span class="no">{{ l.n }}</span><code v-html="l.html || ' '" />
    </div>
  </div>
</template>

<style scoped>
.code {
  font-family: var(--mono);
  font-size: 12.5px;
  line-height: 1.6;
  background: var(--sunken);
  border: 1px solid var(--line);
  border-radius: 8px;
  overflow: auto;
  padding: 6px 0;
}
.ln {
  display: flex;
  white-space: pre;
  min-width: max-content;
}
.wrap .ln {
  white-space: pre-wrap;
  min-width: 0;
}
.wrap code {
  word-break: break-word;
}
.ln.hl {
  background: var(--mark);
}
.no {
  flex: none;
  width: 52px;
  padding-right: 12px;
  text-align: right;
  color: var(--muted);
  user-select: none;
  opacity: 0.7;
}
code {
  padding-right: 16px;
  font-family: inherit;
}
</style>
