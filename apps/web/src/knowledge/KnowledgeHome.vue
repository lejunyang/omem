<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from "vue";
import { OmEmpty, OmButton } from "@omem/ui";
import KnowledgeDocument from "./KnowledgeDocument.vue";
import KnowledgeTree from "./KnowledgeTree.vue";
import { knowledgeApi, type ArticleMeta, type KnowledgeFrame } from "./api";
const props = defineProps<{ prefix: string; compact?: boolean; selectedKey?: string }>();
const emit = defineEmits<{ navigate: [frame: KnowledgeFrame]; select: [key: string] }>();
const loading = ref(true);
const articles = ref<ArticleMeta[]>([]), query = ref(""), selected = ref(props.selectedKey || sessionStorage.getItem("omem-knowledge-page") || "guide:overview"), error = ref("");
let timer: ReturnType<typeof setInterval> | undefined;
const guides = computed(() => articles.value.filter(a => a.reading).sort((a, b) => a.reading!.order - b.reading!.order));
const remoteMatches = ref<ArticleMeta[]>([]), searching = ref(false);
let searchTimer: ReturnType<typeof setTimeout> | undefined;
let searchVersion = 0;
watch(query, value => {
  clearTimeout(searchTimer); const version = ++searchVersion; remoteMatches.value = [];
  if (!value.trim()) { searching.value = false; return; }
  searching.value = true;
  searchTimer = setTimeout(async () => {
    try {
      const result = await knowledgeApi<ArticleMeta[]>(props.prefix, "/search?q=" + encodeURIComponent(value));
      if (version === searchVersion) remoteMatches.value = [...new Map(result.map(a => [a.key, a])).values()];
    } catch { /* Keep local title matches available when the request fails. */ }
    finally { if (version === searchVersion) searching.value = false; }
  }, 250);
});
const topics = computed(() => articles.value.filter(a => a.key.startsWith("topic:")).sort((a,b) => a.key === 'topic:overview' ? -1 : b.key === 'topic:overview' ? 1 : 0));
const modules = computed(() => articles.value.filter(a => a.key.startsWith("module:") && !a.key.includes(":part-")));
const matches = computed(() => [...new Map([...remoteMatches.value, ...articles.value.filter(a => (a.title + a.summary + a.key).toLowerCase().includes(query.value.toLowerCase()))].map(a => [a.key, a])).values()]);
const nextGuide = computed(() => { const index = guides.value.findIndex(a => a.key === selected.value); return index >= 0 ? guides.value[index + 1] : undefined; });
const current = computed(() => articles.value.find(a => a.key === selected.value));
function select(key: string) { selected.value = key; sessionStorage.setItem("omem-knowledge-page", key); emit("select", key); }
watch(() => props.selectedKey, key => { if (key) selected.value = key; });
async function load() {
  try {
    const result = await knowledgeApi<{ articles: ArticleMeta[] }>(props.prefix, "/articles");
    articles.value = result.articles;
    if (!current.value && articles.value.length) select(guides.value[0]?.key ?? topics.value[0]?.key ?? articles.value[0]!.key);
    error.value = "";
  } catch (e) { error.value = String(e); } finally { loading.value = false; }
}
onMounted(() => { void load(); timer = setInterval(() => void load(), 15000); });
onBeforeUnmount(() => { clearInterval(timer); clearTimeout(searchTimer); searchVersion++; });
</script>
<template>
  <section class="knowledge-library">
    <aside class="book-navigation">
      <h1>知识库</h1>
      <p class="muted">先读懂一条流程，再沿引用深入</p>
      <label for="knowledge-filter">查找章节</label><input id="knowledge-filter" v-model="query" placeholder="主题、功能、材料名称" />
      <nav aria-label="知识目录">
        <p v-if="searching" class="search-status" role="status">正在查找相关章节…</p>
        <ul v-if="query"><KnowledgeTree v-for="a in matches" :key="a.key" :article="a" :articles="[]" :selected="selected" @select="select" /></ul>
        <template v-else>
          <h2 v-if="guides.length">从这里开始</h2><ol class="guide-list"><li v-for="(a, index) in guides" :key="a.key"><button :class="{ selected: selected === a.key }" :aria-current="selected === a.key ? 'page' : undefined" @click="select(a.key)"><span class="guide-number">{{ index + 1 }}</span><span>{{ a.title }}<small v-if="!a.current">内容待更新</small></span></button></li></ol>
          <details v-if="topics.length" :open="!guides.length"><summary>{{ guides.length ? '其他主题与旧版综述' : '总览与主题' }}</summary><ul><KnowledgeTree v-for="a in topics" :key="a.key" :article="a" :articles="articles" :selected="selected" @select="select" /></ul></details>
          <details v-if="modules.length"><summary>功能与实现</summary><ul><KnowledgeTree v-for="a in modules" :key="a.key" :article="a" :articles="articles" :selected="selected" @select="select" /></ul></details>
          <details><summary>全部文章 · {{ articles.length }}</summary><ul><KnowledgeTree v-for="a in articles.filter(a => !a.reading && !a.key.startsWith('topic:') && !a.key.startsWith('module:'))" :key="a.key" :article="a" :articles="[]" :selected="selected" @select="select" /></ul></details>
        </template>
      </nav>
    </aside>
    <div class="book-content">
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <KnowledgeDocument v-if="current" :key="current.key" :prefix="prefix" :document-key="current.key" :revision="current.revision" @navigate="emit('navigate', $event)" />
      <p v-else-if="loading" role="status">正在打开知识库…</p>
      <OmEmpty v-else title="知识从你的材料开始" description="导入材料并完成分析后，这里会形成可阅读的主题文章。" />
      <footer v-if="nextGuide" class="next-guide"><span>继续了解</span><OmButton variant="secondary" @click="select(nextGuide.key)">{{ nextGuide.title }} →</OmButton></footer>
    </div>
  </section>
</template>
<style scoped>
.knowledge-library{display:grid;grid-template-columns:240px minmax(0,1fr);min-height:calc(100dvh - 125px);background:var(--om-panel);}.book-navigation{padding:24px 14px;background:var(--om-paper);border-right:1px solid var(--om-line);min-width:0;}.book-navigation h1{font:24px/1.5 var(--om-serif);margin:0;}.book-navigation p{font-size:12px;margin:8px 0 20px;}label{display:block;font-size:12px;margin-bottom:6px;}input{width:100%;min-height:44px;border:1px solid var(--om-line);background:var(--om-panel);border-radius:6px;padding:8px;font:inherit;}nav ul{padding:0;margin:8px 0;}nav h2,summary{font:13px/1.7 var(--om-sans);color:var(--om-secondary);padding:12px 0;margin:8px 0 0;}summary{min-height:44px;cursor:pointer;}.book-content{min-width:0;padding:32px;}.error{color:var(--om-danger);}@media(max-width:1100px){.knowledge-library{grid-template-columns:200px minmax(0,1fr);}.book-content{padding:24px;}}@media(max-width:700px){.knowledge-library{display:block;}.book-navigation{border-right:0;border-bottom:1px solid var(--om-line);padding:16px;}.book-navigation nav{max-height:220px;overflow:auto;}.book-navigation h1{font-size:22px;}.book-content{padding:20px 16px;}}
</style>

<style scoped>
.guide-list { list-style:none; padding:0; margin:8px 0 24px; display:grid; gap:8px; }
.guide-list button { display:flex; gap:12px; width:100%; min-height:56px; padding:12px; border:1px solid transparent; border-radius:8px; background:transparent; text-align:left; color:var(--om-secondary); line-height:1.65; }
.guide-list button:hover { background:var(--om-soft); }
.guide-list button.selected { background:var(--om-panel); border-color:var(--om-line); color:var(--om-ink); font-weight:600; }
.guide-number { font:12px/26px var(--om-sans); color:var(--om-muted); flex:0 0 20px; }
.guide-list small { display:block; font-weight:400; }
.next-guide { max-width:1000px; margin:40px auto 0; border-top:1px solid var(--om-line); padding-top:24px; display:flex; align-items:center; flex-wrap:wrap; gap:12px 20px; }
.next-guide > span { color:var(--om-muted); font-size:13px; }
.search-status { margin:12px 0; }
@media(min-width:701px) { .book-navigation { position:sticky; top:0; align-self:start; max-height:calc(100dvh - 125px); overflow:auto; } }
@media(max-width:1000px) and (min-width:701px) { .knowledge-library { display:block; } .book-navigation { position:static; border-right:0; border-bottom:1px solid var(--om-line); max-height:280px; } }
</style>
