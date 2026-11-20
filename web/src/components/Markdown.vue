<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { linkifyPaths, renderCharts, renderMarkdown, renderMermaid } from "../lib/markdown";
import { layoutCallouts, sizeTables } from "../lib/doc-layout";
import { citeClick } from "../lib/cite-click";
import { previewFromClick } from "../lib/image-preview";

/**
 * `runId`: the text is about a coding run (a review finding); `路径:行` opens that run's file instead of an indexed original.
 * `compact`: the text sits in a card, a rail or a drawer, not on a reading page (styles.css `.prose.compact`).
 */
const props = withDefaults(defineProps<{ source: string; space?: string; linkify?: boolean; existingPages?: string[]; breaks?: boolean; runId?: string; compact?: boolean }>(), { linkify: true });
const root = ref<HTMLElement>();
const router = useRouter();
const emit = defineEmits<{ rendered: [el: HTMLElement] }>();
const html = computed(() => renderMarkdown(props.source, { breaks: props.breaks }));

async function enhance() {
  await nextTick();
  if (!root.value) return;
  if (props.linkify) linkifyPaths(root.value);
  layoutCallouts(root.value);
  sizeTables(root.value);
  if (props.existingPages) {
    const set = new Set(props.existingPages);
    for (const a of root.value.querySelectorAll<HTMLAnchorElement>("a.wikilink")) {
      const t = a.dataset.wiki!;
      const [space, slug] = t.includes(":") ? t.split(":") : [props.space, t];
      // existingPages are this space's pages; a link into another space is not checked here.
      if (space === props.space && !set.has(slug)) a.classList.add("missing"), (a.title = "页面尚不存在");
    }
  }
  root.value.querySelectorAll<HTMLElement>("h2, h3").forEach((h, i) => (h.id ||= `s-${i + 1}`));
  emit("rendered", root.value);
  void renderMermaid(root.value);
  void renderCharts(root.value);
}
onMounted(enhance);
watch(html, enhance);

function onClick(e: MouseEvent) {
  // A picture opens in the page's preview with the text's other pictures, not in a new tab.
  if (previewFromClick(e, root.value)) return;
  citeClick(e, { space: props.space, runId: props.runId, go: (path) => void router.push(path) });
}
</script>

<template>
  <div ref="root" class="prose" :class="{ compact }" v-html="html" @click="onClick" />
</template>
