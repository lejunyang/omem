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
      <div class="article-body"><h2>{{ article.title }}</h2>
      <p class="knowledge-summary">{{ article.summary }}</p>
      <div class="knowledge-provenance"><OmBadge>{{ article.current ? '当前知识' : '待更新 · 原文已变化或部分证据缺失' }}</OmBadge><span>AI 分析并独立复核 · {{ article.model }}</span></div>
      <section v-for="section in article.document.sections" :key="section.key" :data-section="section.key" class="knowledge-section">
        <h3>{{ section.title }}</h3>
        <OmMarkdown :source="section.body" :citations="article.citations" @cite="cite" />
      </section>
      <details><summary>有待确认的问题</summary><KnowledgeQuestions :prefix="prefix" :document-key="article.key" /></details>
      </div>
      <nav v-if="article.document.sections.length > 2" class="article-toc" aria-label="本篇目录">
        <a v-for="s in article.document.sections" :key="s.key" :href="'#' + s.key" @click.prevent="root?.querySelector(`[data-section='${s.key}']`)?.scrollIntoView({ block: 'start' })">{{ s.title }}</a>
      </nav>

    </template>
  </article>
</template>
<style scoped>
.knowledge-document { display:grid;grid-template-columns:minmax(0,760px) 170px;gap:32px;min-width:0;margin:0 auto;max-width:1000px; }.article-body{min-width:0;}
.knowledge-document h2 { font-family: var(--om-serif); font-size: 30px; line-height: 1.55; margin: 8px 0 18px; }
.knowledge-summary { color: var(--om-secondary); line-height: 1.9; }
.knowledge-provenance { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; font-size: 12px; color: var(--om-muted); margin: 16px 0 24px; }
.article-toc{align-self:start;position:sticky;top:24px;border-left:1px solid var(--om-line);padding-left:16px;display:flex;flex-direction:column;gap:8px;}.article-toc::before{content:"本页内容";font-weight:600;margin-bottom:8px;}.article-toc a{font-size:12px;line-height:1.6;color:var(--om-secondary);text-decoration:none;padding:6px 0;}
.knowledge-section { margin: 28px 0; scroll-margin-top: 18px; }
.knowledge-section h3 { font-family: var(--om-serif); font-size: 21px; }
.knowledge-open-questions { border-top: 1px solid var(--om-line); margin-top: 32px; padding: 16px 0; color: var(--om-secondary); }
summary { cursor: pointer; min-height: 44px; }
.knowledge-open-questions div { margin: 20px 0; }
@media(max-width:700px) { .knowledge-document h2 { font-size: 25px; } }
</style>

<style scoped>@media(max-width:1250px){.knowledge-document{display:flex;flex-direction:column;gap:16px;}.article-toc{order:-1;position:static;flex-direction:row;flex-wrap:wrap;border:0;border-bottom:1px solid var(--om-line);padding:0 0 12px;}.article-toc a{padding:6px;}.article-toc::before{width:100%;}}:global(.om-trail .knowledge-document){display:block;}:global(.om-trail .article-toc){display:none;}</style>
