<script setup lang="ts">
import { ref, watch, nextTick } from "vue";
import { OmMarkdown, OmBadge, OmEmpty, OmButton } from "@omem/ui";
import KnowledgeQuestions from "./KnowledgeQuestions.vue";
import { knowledgeApi, type Article, type KnowledgeFrame } from "./api";
const props = defineProps<{ prefix: string; documentKey: string; revision?: string; section?: string }>();
const emit = defineEmits<{ navigate: [frame: KnowledgeFrame]; loaded: [title: string] }>();
const article = ref<Article | null>(null), error = ref("");
const root = ref<HTMLElement>();
let generation = 0;
watch(() => [props.documentKey, props.revision], async () => {
  const current = ++generation; error.value = ""; article.value = null;
  try {
    const result = await knowledgeApi<Article>(props.prefix, "/articles/" + encodeURIComponent(props.documentKey) + (props.revision ? "?revision=" + encodeURIComponent(props.revision) : ""));
    if (current !== generation) return;
    article.value = result; emit("loaded", result.title);
    await nextTick(); if (props.section) root.value?.querySelector(`[data-section="${CSS.escape(props.section)}"]`)?.scrollIntoView({ block: "start" });
  } catch (e) { if (current === generation) error.value = String(e); }
}, { immediate: true });
function cite(key: string) {
  const c = article.value?.citations.find(c => c.key === key);
  if (!c?.actionable || !article.value) return;
  emit("navigate", { kind: "citation", id: JSON.stringify({ document: props.documentKey, revision: article.value.revision, citation: key }), title: c.label });
}
</script>
<template>
  <article ref="root" class="knowledge-document">
    <OmEmpty v-if="error" title="知识暂不可用" :description="error" />
    <p v-else-if="!article" class="muted" role="status">正在读取知识正文…</p>
    <template v-else>
      <h2>{{ article.title }}</h2>
      <p class="knowledge-summary">{{ article.summary }}</p>
      <div class="knowledge-provenance"><OmBadge>{{ article.current ? '当前知识' : '历史知识 · 来源已变化' }}</OmBadge><span>AI 分析并独立复核 · {{ article.model }}</span></div>
      <nav v-if="article.document.sections.length > 2" class="article-toc" aria-label="本篇目录">
        <a v-for="s in article.document.sections" :key="s.key" :href="'#' + s.key" @click.prevent="root?.querySelector(`[data-section='${s.key}']`)?.scrollIntoView({ block: 'start' })">{{ s.title }}</a>
      </nav>
      <section v-for="section in article.document.sections" :key="section.key" :data-section="section.key" class="knowledge-section">
        <h3>{{ section.title }}</h3>
        <OmMarkdown :source="section.body" :citations="article.citations" @cite="cite" />
      </section>
      <KnowledgeQuestions :prefix="prefix" :document-key="article.key" />
    </template>
  </article>
</template>
<style scoped>
.knowledge-document { max-width: 900px; min-width: 0; margin: 0 auto; }
.knowledge-document h2 { font-family: var(--om-serif); font-size: 30px; line-height: 1.55; margin: 8px 0 18px; }
.knowledge-summary { color: var(--om-secondary); line-height: 1.9; }
.knowledge-provenance { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; font-size: 12px; color: var(--om-muted); margin: 16px 0 24px; }
.article-toc { display: flex; flex-wrap: wrap; gap: 8px 20px; padding: 12px 0; border-block: 1px solid var(--om-line); }
.article-toc a { min-height: 44px; display: inline-flex; align-items: center; color: var(--om-secondary); }
.knowledge-section { margin: 28px 0; scroll-margin-top: 18px; }
.knowledge-section h3 { font-family: var(--om-serif); font-size: 21px; }
.knowledge-open-questions { border-top: 1px solid var(--om-line); margin-top: 32px; padding: 16px 0; color: var(--om-secondary); }
summary { cursor: pointer; min-height: 44px; }
.knowledge-open-questions div { margin: 20px 0; }
@media(max-width:700px) { .knowledge-document h2 { font-size: 25px; } }
</style>
