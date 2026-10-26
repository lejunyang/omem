<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { highlight, languageOf } from "../lib/markdown";
import VirtualList from "./VirtualList.vue";

/** Source text with line numbers; long texts render only the lines near the viewport. */
const props = defineProps<{ text: string; start: number; path: string; from?: number; to?: number; wrap?: boolean }>();
const root = ref<HTMLElement>();
const list = ref<{ scrollToIndex: (i: number, align?: "start" | "center") => Promise<void> } | null>(null);
const lang = computed(() => languageOf(props.path));
const raw = computed(() => props.text.split("\n"));
const virtual = computed(() => raw.value.length > 400);
const lineHtml = (line: string) => (lang.value ? highlight(line, lang.value) : line.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!));
// Highlighting every line of a long file up front is the slow part: do it per rendered row.
const lines = computed(() => raw.value.map((line, i) => ({ n: props.start + i, line })));
const inRange = (n: number) => props.from !== undefined && n >= props.from && n <= (props.to ?? props.from);

async function scroll() {
  await nextTick();
  if (props.from === undefined) return;
  if (virtual.value) return void list.value?.scrollToIndex(props.from - props.start, "center");
  root.value?.querySelector<HTMLElement>(".hl")?.scrollIntoView({ block: "center" });
}
onMounted(scroll);
watch(() => [props.from, props.text], scroll);
</script>

<template>
  <div ref="root" class="code" :class="{ wrap }">
    <VirtualList v-if="virtual" ref="list" :items="lines" :item-key="(l) => l.n" :estimate="20">
      <template #default="{ item: l }">
        <div class="ln" :class="{ hl: inRange(l.n) }" :id="`L${l.n}`" :data-line="l.n"><span class="no">{{ l.n }}</span><code v-html="lineHtml(l.line) || ' '" /></div>
      </template>
    </VirtualList>
    <template v-else>
      <div v-for="l in lines" :key="l.n" class="ln" :class="{ hl: inRange(l.n) }" :id="`L${l.n}`" :data-line="l.n">
        <span class="no">{{ l.n }}</span><code v-html="lineHtml(l.line) || ' '" />
      </div>
    </template>
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
  overflow-x: auto;
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
