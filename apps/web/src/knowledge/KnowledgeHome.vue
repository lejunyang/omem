<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from "vue";
import { OmEmpty } from "@omem/ui";
import KnowledgeDocument from "./KnowledgeDocument.vue";
import KnowledgeTree from "./KnowledgeTree.vue";
import { knowledgeApi, type ArticleMeta, type KnowledgeFrame } from "./api";
const props = defineProps<{ prefix: string; compact?: boolean }>();
const emit = defineEmits<{ navigate: [frame: KnowledgeFrame] }>();
const loading = ref(true);
const articles = ref<ArticleMeta[]>([]), query = ref(""), selected = ref(sessionStorage.getItem("omem-knowledge-page") || "topic:overview"), error = ref("");
let timer: ReturnType<typeof setInterval> | undefined;
const topics = computed(() => articles.value.filter(a => a.key.startsWith("topic:")).sort((a,b) => a.key === 'topic:overview' ? -1 : b.key === 'topic:overview' ? 1 : 0));
const modules = computed(() => articles.value.filter(a => a.key.startsWith("module:") && !a.key.includes(":part-")));
const matches = computed(() => articles.value.filter(a => (a.title + a.summary + a.key).toLowerCase().includes(query.value.toLowerCase())));
const current = computed(() => articles.value.find(a => a.key === selected.value));
function select(key: string) { selected.value = key; sessionStorage.setItem("omem-knowledge-page", key); }
async function load() {
  try {
    const result = await knowledgeApi<{ articles: ArticleMeta[] }>(props.prefix, "/articles");
    articles.value = result.articles;
    if (!current.value && articles.value.length) select(topics.value[0]?.key ?? articles.value[0]!.key);
    error.value = "";
  } catch (e) { error.value = String(e); } finally { loading.value = false; }
}
onMounted(() => { void load(); timer = setInterval(() => void load(), 15000); });
onBeforeUnmount(() => clearInterval(timer));
</script>
<template>
  <section class="knowledge-library">
    <aside class="book-navigation">
      <h1>知识库</h1>
      <p class="muted">按主题阅读，沿引用深入</p>
      <label for="knowledge-filter">查找章节</label><input id="knowledge-filter" v-model="query" placeholder="主题、功能、材料名称" />
      <nav aria-label="知识目录">
        <ul v-if="query"><KnowledgeTree v-for="a in matches" :key="a.key" :article="a" :articles="[]" :selected="selected" @select="select" /></ul>
        <template v-else>
          <h2 v-if="topics.length">总览与主题</h2><ul><KnowledgeTree v-for="a in topics" :key="a.key" :article="a" :articles="articles" :selected="selected" @select="select" /></ul>
          <details v-if="modules.length"><summary>功能与实现</summary><ul><KnowledgeTree v-for="a in modules" :key="a.key" :article="a" :articles="articles" :selected="selected" @select="select" /></ul></details>
          <details><summary>全部文章 · {{ articles.length }}</summary><ul><KnowledgeTree v-for="a in articles.filter(a => !a.key.startsWith('topic:') && !a.key.startsWith('module:'))" :key="a.key" :article="a" :articles="[]" :selected="selected" @select="select" /></ul></details>
        </template>
      </nav>
    </aside>
    <div class="book-content">
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <KnowledgeDocument v-if="current" :key="current.key" :prefix="prefix" :document-key="current.key" :revision="current.revision" @navigate="emit('navigate', $event)" />
      <p v-else-if="loading" role="status">正在打开知识库…</p>
      <OmEmpty v-else title="知识从你的材料开始" description="导入材料并完成分析后，这里会形成可阅读的主题文章。" />
    </div>
  </section>
</template>
<style scoped>
.knowledge-library{display:grid;grid-template-columns:240px minmax(0,1fr);min-height:calc(100dvh - 125px);background:var(--om-panel);}.book-navigation{padding:24px 14px;background:var(--om-paper);border-right:1px solid var(--om-line);min-width:0;}.book-navigation h1{font:24px/1.5 var(--om-serif);margin:0;}.book-navigation p{font-size:12px;margin:8px 0 20px;}label{display:block;font-size:12px;margin-bottom:6px;}input{width:100%;min-height:44px;border:1px solid var(--om-line);background:var(--om-panel);border-radius:6px;padding:8px;font:inherit;}nav ul{padding:0;margin:8px 0;}nav h2,summary{font:13px/1.7 var(--om-sans);color:var(--om-secondary);padding:12px 0;margin:8px 0 0;}summary{min-height:44px;cursor:pointer;}.book-content{min-width:0;padding:32px;}.error{color:var(--om-danger);}@media(max-width:1100px){.knowledge-library{grid-template-columns:200px minmax(0,1fr);}.book-content{padding:24px;}}@media(max-width:700px){.knowledge-library{display:block;}.book-navigation{border-right:0;border-bottom:1px solid var(--om-line);padding:16px;}.book-navigation nav{max-height:220px;overflow:auto;}.book-navigation h1{font-size:22px;}.book-content{padding:20px 16px;}}
</style>
