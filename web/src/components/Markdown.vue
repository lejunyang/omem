<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { linkifyPaths, renderMarkdown, renderMermaid } from "../lib/markdown";
import { openCitation, state } from "../store";

const props = withDefaults(defineProps<{ source: string; space?: string; linkify?: boolean; existingPages?: string[]; breaks?: boolean }>(), { linkify: true });
const root = ref<HTMLElement>();
const router = useRouter();
const emit = defineEmits<{ rendered: [el: HTMLElement] }>();
const html = computed(() => renderMarkdown(props.source, { breaks: props.breaks }));

async function enhance() {
  await nextTick();
  if (!root.value) return;
  if (props.linkify) linkifyPaths(root.value);
  if (props.existingPages) {
    const set = new Set(props.existingPages);
    for (const a of root.value.querySelectorAll<HTMLAnchorElement>("a.wikilink")) {
      const t = a.dataset.wiki!;
      const slug = t.includes(":") ? t.split(":")[1] : t;
      if (!set.has(slug)) a.classList.add("missing"), (a.title = "页面尚不存在");
    }
  }
  root.value.querySelectorAll<HTMLElement>("h2, h3").forEach((h, i) => (h.id ||= `s-${i + 1}`));
  emit("rendered", root.value);
  void renderMermaid(root.value);
}
onMounted(enhance);
watch(html, enhance);

function onClick(e: MouseEvent) {
  const a = (e.target as HTMLElement).closest("a") as HTMLAnchorElement | null;
  if (!a) return;
  const cite = a.dataset.cite;
  if (cite) {
    e.preventDefault();
    const from = a.dataset.from ? Number(a.dataset.from) : undefined;
    const to = a.dataset.to ? Number(a.dataset.to) : undefined;
    const replace = !(e.target as HTMLElement).closest(".drawer");
    if (cite === "source") openCitation(a.dataset.uri ? { kind: "source", uri: a.dataset.uri, space: props.space ?? state.space, from, to, label: a.textContent ?? "" } : { kind: "source", id: a.dataset.ref, from, to, label: a.textContent ?? "" }, replace);
    else if (cite === "memory") openCitation({ kind: "memory", id: a.dataset.ref! }, replace);
    else if (cite === "message") openCitation({ kind: "message", id: a.dataset.ref! }, replace);
    return;
  }
  if (a.dataset.wiki) {
    e.preventDefault();
    const target = a.dataset.wiki;
    const [space, slug] = target.includes(":") ? target.split(":") : [props.space ?? state.space, target];
    if ((e.target as HTMLElement).closest(".drawer")) openCitation({ kind: "page", space, slug });
    else router.push(`/wiki/${space}/${slug}`);
  }
}
</script>

<template>
  <div ref="root" class="prose" v-html="html" @click="onClick" />
</template>
