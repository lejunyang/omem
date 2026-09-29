<script setup lang="ts">
import { ref, watch } from "vue";
import { OmCodeViewer, OmMarkdown, OmButton, OmBadge, OmEmpty } from "@omem/ui";
import { knowledgeApi, knowledgeFrame, type ArticleMeta, type KnowledgeFrame } from "./api";
const props = defineProps<{ prefix: string; materialKey: string; digest?: string; startLine?: number; endLine?: number }>();
const emit = defineEmits<{ navigate: [frame: KnowledgeFrame]; loaded: [title: string] }>();
type Material = { key: string; title: string; text: string; path: string | null; current: boolean; knowledge: ArticleMeta | null; images: { url: string; label: string }[]; links: { line: number; label: string; reason: string; target: string }[] };
const material = ref<Material | null>(null), error = ref("");
let generation = 0;
watch(() => [props.materialKey, props.digest], async () => {
  const current = ++generation; material.value = null; error.value = "";
  try { const m = await knowledgeApi<Material>(props.prefix, "/materials/" + encodeURIComponent(props.materialKey) + (props.digest ? "?digest=" + encodeURIComponent(props.digest) : "")); if (current === generation) { material.value = m; emit("loaded", m.title); } }
  catch (e) { if (current === generation) error.value = String(e); }
}, { immediate: true });
async function reference(key: string) {
  try { const a = await knowledgeApi<ArticleMeta>(props.prefix, "/articles/" + encodeURIComponent(key)); emit("navigate", knowledgeFrame(key, a.title)); }
  catch { emit("navigate", { kind: "source", id: JSON.stringify({ key }), title: "关联原始材料" }); }
}
function internal(path: string) {
  if (!material.value?.path) return;
  const base = material.value.path.split("/").slice(0, -1);
  for (const p of path.split("#")[0]!.split("/")) { if (p === "..") base.pop(); else if (p && p !== ".") base.push(p); }
  void reference("omem:" + base.join("/"));
}
</script>
<template>
  <section class="knowledge-source">
    <OmEmpty v-if="error" title="原始材料不可用" :description="error" />
    <p v-else-if="!material">正在读取固定原文…</p>
    <template v-else>
      <h2>{{ material.title }}</h2>
      <div class="source-actions"><OmBadge>原始材料 · {{ material.current ? '当前版本' : '历史版本' }}</OmBadge><OmButton v-if="material.knowledge" variant="secondary" @click="emit('navigate', knowledgeFrame(material.key, material.knowledge.title))">阅读这份材料的知识解读 ↗</OmButton></div>
      <p v-if="startLine" class="muted">引用位置：第 {{ startLine }}{{ endLine && endLine !== startLine ? `–${endLine}` : '' }} 行</p>
      <OmCodeViewer v-if="material.path && !/\.(?:md|markdown)$/.test(material.path)" :code="material.text" :language="material.path.split('.').pop()" :anchor-line="startLine" :links="material.links" @open-reference="reference" />
      <template v-else>
        <blockquote v-if="startLine && endLine">{{ material.text.split('\n').slice(startLine - 1, endLine).join('\n') }}</blockquote>
        <OmMarkdown v-if="material.text" :source="material.text" @navigate-internal="internal" />
      </template>
      <img v-for="image in material.images" :key="image.url" :src="image.url" :alt="image.label" />
    </template>
  </section>
</template>
<style scoped>
h2 { font: 24px/1.6 var(--om-serif); overflow-wrap: anywhere; }.source-actions { display:flex; flex-wrap:wrap; gap:12px; align-items:center; margin:16px 0; }img {max-width:100%;height:auto;border:1px solid var(--om-line);margin:16px 0;}blockquote{white-space:pre-wrap;border-left:3px solid var(--om-line);padding:12px;color:var(--om-secondary);margin:16px 0;}
</style>
