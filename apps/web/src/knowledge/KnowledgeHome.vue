<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from "vue";
import { OmEmpty, OmButton } from "@omem/ui";
import KnowledgeDocument from "./KnowledgeDocument.vue";
import KnowledgeTree from "./KnowledgeTree.vue";
import KnowledgeFolder from "./KnowledgeFolder.vue";
import ArticleComposer, { type MaterialOption } from "./ArticleComposer.vue";
import { topicTree, inTopic, articleOrder } from "./topics";
import { knowledgeApi, type ArticleMeta, type KnowledgeFrame } from "./api";
const props = defineProps<{ prefix: string; compact?: boolean; selectedKey?: string }>();
const emit = defineEmits<{ navigate: [frame: KnowledgeFrame]; select: [key: string] }>();
const loading = ref(true), mobileNavigation = ref(false);
const articles = ref<ArticleMeta[]>([]), materials = ref<MaterialOption[]>([]), query = ref(""), selected = ref(props.selectedKey || sessionStorage.getItem("omem-knowledge-page") || ""), error = ref("");
const pageSize = ref(20);
const topic = ref<string[]>([]), running = ref(false), lastRun = ref<{ state?: string; title?: string; key?: string; error?: string } | null>(null);
let timer: ReturnType<typeof setInterval> | undefined;
const tree = computed(() => topicTree(articles.value));
const current = computed(() => articles.value.find(a => a.key === selected.value));
const activePath = computed(() => current.value?.topicPath ?? topic.value);
const scopedArticles = computed(() => articles.value.filter(a => inTopic(a, topic.value)).sort(articleOrder));
const siblings = computed(() => current.value ? articles.value.filter(a => JSON.stringify(a.topicPath ?? []) === JSON.stringify(current.value!.topicPath ?? [])).sort(articleOrder) : []);
const nextArticle = computed(() => siblings.value[siblings.value.findIndex(a => a.key === selected.value) + 1]);
const remoteMatches = ref<ArticleMeta[]>([]), searching = ref(false), searchError = ref("");
let searchTimer: ReturnType<typeof setTimeout> | undefined, searchController: AbortController | undefined, searchVersion = 0;
watch([query, topic], ([value]) => {
  clearTimeout(searchTimer); searchController?.abort(); const version = ++searchVersion; remoteMatches.value = []; searchError.value = "";
  if (!value.trim()) { searching.value = false; return; }
  searching.value = true;
  searchTimer = setTimeout(async () => {
    const controller = new AbortController(); searchController = controller;
    try {
      const params = new URLSearchParams({ q: value, topic: JSON.stringify(topic.value) });
      const result = await knowledgeApi<ArticleMeta[]>(props.prefix, "/search?" + params, { signal: controller.signal });
      if (version === searchVersion) remoteMatches.value = result;
    } catch (e) { if (version === searchVersion && !controller.signal.aborted) searchError.value = String(e); }
    finally { if (version === searchVersion) searching.value = false; }
  }, 250);
}, { flush: "sync" });
const matches = computed(() => [...new Map([...remoteMatches.value, ...scopedArticles.value.filter(a => (a.title + a.summary).toLowerCase().includes(query.value.toLowerCase()))].map(a => [a.key, a])).values()]);
function select(key: string) { selected.value = key; mobileNavigation.value = false; sessionStorage.setItem("omem-knowledge-page", key); emit("select", key); }
function selectTopic(path: string[]) { topic.value = path; pageSize.value = 20; select(""); }
watch(() => props.selectedKey, key => { selected.value = key ?? ""; });
async function load() {
  try {
    const result = await knowledgeApi<{ articles: ArticleMeta[]; materials: MaterialOption[]; running: boolean; lastRun: typeof lastRun.value }>(props.prefix, "/articles");
    articles.value = result.articles; materials.value = result.materials; running.value = result.running; lastRun.value = result.lastRun;
    error.value = "";
  } catch (e) { error.value = String(e); } finally { loading.value = false; }
}
onMounted(() => { void load(); timer = setInterval(() => void load(), 5000); });
onBeforeUnmount(() => { clearInterval(timer); clearTimeout(searchTimer); searchController?.abort(); searchVersion++; });
</script>
<template>
  <section class="knowledge-library">
    <aside class="book-navigation">
      <h1>知识库</h1>
      <p class="muted">按主题阅读，沿引用了解背景</p>
      <button class="mobile-navigation-toggle" :aria-expanded="mobileNavigation" @click="mobileNavigation = !mobileNavigation">{{ mobileNavigation ? '收起章节目录' : '展开章节目录' }}</button>
      <div class="navigation-content" :class="{ 'mobile-open': mobileNavigation }">
        <OmButton variant="ghost" @click="selectTopic([])">全部分类</OmButton>
        <label for="knowledge-filter">查找章节</label><input id="knowledge-filter" v-model="query" :placeholder="topic.length ? '在此分类中查找' : '搜索全部知识'" />
        <p v-if="topic.length" class="scope-label">{{ topic.join(' / ') }} <button @click="topic = []">取消范围</button></p>
        <nav aria-label="知识目录" :aria-busy="searching">
          <p v-if="searching" class="search-status" role="status">正在查找相关章节…</p>
          <p v-if="searchError" role="alert">搜索失败：{{ searchError }}</p>
          <ul v-if="query.trim()"><KnowledgeTree v-for="a in matches" :key="a.key" :article="a" :articles="[]" :selected="selected" @select="select" /><li v-if="!searching && !searchError && !matches.length">没有匹配的文章</li></ul>
          <template v-else>
            <ul><KnowledgeFolder v-for="node in tree.children" :key="node.title" :node="node" :selected="selected" :active-path="activePath" @select="select" @topic="selectTopic" /></ul>
            <details v-if="tree.articles.length" :open="!tree.children.length"><summary>未分类 · {{ tree.articles.length }}</summary><ul><KnowledgeTree v-for="a in tree.articles" :key="a.key" :article="a" :articles="[]" :selected="selected" @select="select" /></ul></details>
          </template>
        </nav>
      </div>
    </aside>
    <div class="book-content">
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <p v-if="running" class="generation-status" role="status">正在整理“{{ lastRun?.title || '所选材料' }}”：调查、撰写并复核。完成后文章会出现在分类目录中。</p>
      <p v-else-if="lastRun?.state === 'failed'" class="error" role="alert">“{{ lastRun.title }}”未完成：{{ lastRun.error }}</p>
      <p v-else-if="lastRun?.state === 'published'" class="generation-status" role="status">“{{ lastRun.title }}”已完成 <OmButton variant="ghost" @click="select(lastRun!.key!)">阅读文章</OmButton></p>
      <KnowledgeDocument v-if="current" :key="current.key" :prefix="prefix" :document-key="current.key" :revision="current.revision" @navigate="emit('navigate', $event)" />
      <p v-else-if="loading" role="status">正在打开知识库…</p>
      <section v-else class="library-overview">
        <h2>{{ topic.length ? topic.join(' / ') : '你的知识' }}</h2>
        <p class="muted">{{ scopedArticles.length }} 篇文章。选择主题阅读，或把相关材料整理成一篇新文章。</p>
        <ArticleComposer :prefix="prefix" :materials="materials" :topic-path="topic" :running="running" @submitted="load" />
        <div v-if="!topic.length" class="topic-cards"><button v-for="node in tree.children" :key="node.title" @click="selectTopic(node.path)"><strong>{{ node.title }}</strong><span>{{ node.count }} 篇文章</span></button></div>
        <ul class="article-list"><li v-for="a in scopedArticles.slice(0, pageSize)" :key="a.key"><button @click="select(a.key)"><span><strong>{{ a.title }}</strong><small>{{ a.summary }}</small><small v-if="!a.current">内容待更新</small></span></button></li></ul>
        <OmButton v-if="scopedArticles.length > pageSize" variant="secondary" @click="pageSize += 20">继续浏览（还有 {{ scopedArticles.length - pageSize }} 篇）</OmButton>
        <OmEmpty v-if="!articles.length" title="知识从你的材料开始" description="选择原始材料和想弄懂的问题，整理成适合阅读的文章。" />
      </section>
      <footer v-if="current" class="next-guide"><OmButton variant="ghost" @click="selectTopic(current.topicPath ?? [])">返回分类</OmButton><OmButton v-if="nextArticle" variant="secondary" @click="select(nextArticle.key)">下一篇：{{ nextArticle.title }}</OmButton></footer>
    </div>
  </section>
</template>
<style scoped>
.knowledge-library{display:grid;grid-template-columns:240px minmax(0,1fr);min-height:calc(100dvh - 125px);background:var(--om-panel);}.book-navigation{padding:24px 14px;background:var(--om-paper);border-right:1px solid var(--om-line);min-width:0;}.book-navigation h1{font:24px/1.5 var(--om-serif);margin:0;}.book-navigation p{font-size:12px;margin:8px 0 20px;}label{display:block;font-size:12px;margin-bottom:6px;}input{width:100%;min-height:44px;border:1px solid var(--om-line);background:var(--om-panel);border-radius:6px;padding:8px;font:inherit;}nav ul{padding:0;margin:8px 0;}nav h2,summary{font:13px/1.7 var(--om-sans);color:var(--om-secondary);padding:12px 0;margin:8px 0 0;}summary{min-height:44px;cursor:pointer;}.book-content{min-width:0;padding:32px;}.error{color:var(--om-danger);}@media(max-width:1100px){.knowledge-library{grid-template-columns:200px minmax(0,1fr);}.book-content{padding:24px;}}@media(max-width:700px){.knowledge-library{display:block;}.book-navigation{border-right:0;border-bottom:1px solid var(--om-line);padding:16px;}.book-navigation nav{max-height:220px;overflow:auto;}.book-navigation h1{font-size:22px;}.book-content{padding:20px 16px;}}
</style>

<style scoped>
.article-list { list-style:none; padding:0; margin:8px 0 24px; display:grid; gap:8px; }
.article-list button { display:flex; gap:12px; width:100%; min-height:56px; padding:12px; border:1px solid transparent; border-radius:8px; background:transparent; text-align:left; color:var(--om-secondary); line-height:1.65; }
.article-list button:hover { background:var(--om-soft); }
.article-list button.selected { background:var(--om-panel); border-color:var(--om-line); color:var(--om-ink); font-weight:600; }
.guide-number { font:12px/26px var(--om-sans); color:var(--om-muted); flex:0 0 20px; }
.article-list small { display:block; font-weight:400; }
.next-guide { max-width:1000px; margin:40px auto 0; border-top:1px solid var(--om-line); padding-top:24px; display:flex; align-items:center; flex-wrap:wrap; gap:12px 20px; }
.next-guide > span { color:var(--om-muted); font-size:13px; }
.search-status { margin:12px 0; }
.mobile-navigation-toggle { display:none; }
@media(max-width:700px) { .mobile-navigation-toggle { display:block; min-height:44px; padding:8px 12px; border:1px solid var(--om-line); border-radius:6px; background:var(--om-panel); font:inherit; } .navigation-content { display:none; } .navigation-content.mobile-open { display:block; margin-top:16px; } }
@media(min-width:701px) { .book-navigation { position:sticky; top:0; align-self:start; max-height:calc(100dvh - 125px); overflow:auto; } }
@media(max-width:1000px) and (min-width:701px) { .knowledge-library { display:block; } .book-navigation { position:static; border-right:0; border-bottom:1px solid var(--om-line); max-height:280px; } }
</style>

<style scoped>
.library-overview{max-width:900px;margin:0 auto;}.library-overview h2{font:30px/1.5 var(--om-serif);margin:0 0 16px;}.topic-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;margin:24px 0;}.topic-cards button{display:grid;gap:12px;text-align:left;border:1px solid var(--om-line);border-radius:8px;padding:20px;background:var(--om-panel);cursor:pointer;font:inherit;}.topic-cards span,.muted{color:var(--om-muted);}.generation-status{padding:16px 20px;border:1px solid var(--om-line);border-radius:8px;margin:0 0 24px;}.scope-label{overflow-wrap:anywhere;}.scope-label button{min-height:44px;border:0;background:none;text-decoration:underline;cursor:pointer;}.article-list button{border-color:var(--om-line);padding:20px;}.article-list small{margin-top:8px;font-size:13px;color:var(--om-muted);}
</style>
