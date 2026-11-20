<script setup lang="ts">
import { computed } from "vue";
import { useRouter } from "vue-router";
import { renderInline } from "../lib/markdown";
import { citeClick } from "../lib/cite-click";

/**
 * A short text an agent wrote (a reason, a summary, a row's subtitle), shown in a line or a few:
 * emphasis, code, links and references are rendered, references open in the citation drawer.
 * For text with headings, lists or tables use `Markdown` (with `compact` in a card).
 * `lines` clamps it; `breaks` keeps its line breaks.
 */
const props = withDefaults(defineProps<{ text: string; space?: string; runId?: string; lines?: number; breaks?: boolean; tag?: string }>(), { tag: "span" });
const router = useRouter();
const html = computed(() => renderInline(props.text, { breaks: props.breaks }));
function onClick(e: MouseEvent) {
  if (citeClick(e, { space: props.space, runId: props.runId, go: (path) => void router.push(path) })) e.stopPropagation();
}
</script>

<template>
  <component :is="tag" class="rich" :class="{ clamp: !!lines }" :style="lines ? { '--rich-lines': lines } : undefined" v-html="html" @click="onClick" />
</template>
