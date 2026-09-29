<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from "vue";
import { OmButton, OmEmpty, OmBadge } from "@omem/ui";
import KnowledgeDocument from "./KnowledgeDocument.vue";
import KnowledgeQuestions from "./KnowledgeQuestions.vue";
import { knowledgeApi, knowledgeFrame, type ArticleMeta, type KnowledgeFrame } from "./api";
const props = defineProps<{ prefix: string; compact?: boolean }>();
const emit = defineEmits<{ navigate: [frame: KnowledgeFrame] }>();
const articles = ref<ArticleMeta[]>([]), materials = ref<{ key: string; title: string; path: string | null; revisionId: string }[]>([]);
const query = ref(""), selected = ref(""), error = ref(""), running = ref(false), limit = ref(40);
const selectedByUser = ref(false);
let timer: ReturnType<typeof setInterval> | undefined;
const topics = computed(() => articles.value.filter(a => a.key.startsWith("topic:") && a.current));
const current = computed(() => articles.value.find(a => a.key === selected.value));
const matches = computed(() => {
  const term = query.value.toLowerCase();
  return articles.value.filter(a => !a.key.startsWith("topic:") && (a.title + a.key + a.summary).toLowerCase().includes(term));
});
const reviewed = computed(() => materials.value.filter(m => articles.value.some(a => a.key === m.key && a.current)).length);
async function load() {
  try { const result = await knowledgeApi<{ articles: ArticleMeta[]; materials: typeof materials.value; running: boolean }>(props.prefix, "/articles"); articles.value = result.articles; materials.value = result.materials; running.value = result.running;
    if (!selectedByUser.value && topics.value.some(t => t.key === "topic:overview")) selected.value = "topic:overview";
    error.value = "";
  } catch (e) { error.value = String(e); }
}
async function analyze() {
  try { await knowledgeApi(props.prefix, "/analyze", { method: "POST", body: JSON.stringify({ revisionIds: materials.value.filter(m => !articles.value.some(a => a.key === m.key && a.current)).map(m => m.revisionId) }) }); running.value = true; } catch (e) { error.value = String(e); }
}
onMounted(() => { void load(); timer = setInterval(() => void load(), 15000); });
onBeforeUnmount(() => clearInterval(timer));
</script>
<template>
  <section class="knowledge-home">
    <header><span class="eyebrow">材料 · 理解 · 证据</span><h1>可追溯的知识</h1><p class="muted">从正文里的引用进入背景、需求、实现与原文；每一层都保留来路。</p></header>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <div class="coverage"><OmBadge>{{ reviewed }} / {{ materials.length }} 份材料已有当前解读</OmBadge><OmBadge v-if="running">正在分析与复核</OmBadge><OmButton v-if="reviewed < materials.length" variant="ghost" :disabled="running" @click="analyze">整理待处理材料</OmButton></div>
    <nav v-if="topics.length" aria-label="知识主题" class="topics"><button v-for="topic in topics" :key="topic.key" :class="{ active: selected === topic.key }" @click="selected = topic.key; selectedByUser = true">{{ topic.title }}</button></nav>
    <KnowledgeDocument v-if="current" :prefix="prefix" :document-key="current.key" :revision="current.revision" @navigate="emit('navigate', $event)" />
    <OmEmpty v-else title="从材料解读开始阅读" description="主题章节会在材料分析和复核完成后形成；已完成的材料可从下方直接打开。" />
    <section class="knowledge-index">
      <h2>模块与材料</h2><label for="knowledge-filter">查找知识或文件</label><input id="knowledge-filter" v-model="query" placeholder="按标题、路径或摘要查找" @input="limit = 40" />
      <div class="article-grid"><button v-for="a in matches.slice(0, limit)" :key="a.key" class="knowledge-card" @click="emit('navigate', knowledgeFrame(a.key, a.title))"><strong>{{ a.title }}</strong><span>{{ a.summary }}</span><small>{{ a.key.startsWith('omem:') ? a.key.slice(5) : a.key.startsWith('module:') ? '模块知识' : '主题知识' }} · {{ a.current ? '已复核' : '来源变化，待更新' }}</small></button></div>
      <OmButton v-if="matches.length > limit" variant="secondary" @click="limit += 40">继续显示（还有 {{ matches.length - limit }} 篇）</OmButton>
    </section>
    <KnowledgeQuestions :prefix="prefix" />
  </section>
</template>
<style scoped>
.knowledge-home {padding:24px 0;max-width:1000px;min-width:0;margin:0 auto;}h1{font:32px/1.5 var(--om-serif);margin:10px 0 14px;}header p{line-height:1.8;}.coverage{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:20px 0;}.topics{display:flex;gap:8px;flex-wrap:wrap;padding:16px 0;border-block:1px solid var(--om-line);margin-bottom:24px;}.topics button{min-height:44px;border:0;background:transparent;color:var(--om-secondary);padding:8px 12px;cursor:pointer;border-radius:6px;}.topics button.active{background:var(--om-ink);color:var(--om-panel);}.knowledge-index{margin:40px 0;}.knowledge-index h2{font:25px/1.5 var(--om-serif);}label{display:block;font-size:14px;margin:12px 0 6px;}input{width:100%;min-height:44px;padding:10px 12px;border:1px solid var(--om-line);border-radius:6px;background:var(--om-panel);color:var(--om-ink);}.article-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin:20px 0;}.knowledge-card{display:flex;flex-direction:column;gap:10px;text-align:left;padding:18px;background:var(--om-panel);border:1px solid var(--om-line);border-radius:8px;color:var(--om-ink);cursor:pointer;overflow-wrap:anywhere;}.knowledge-card strong{font-size:16px;}.knowledge-card span{color:var(--om-secondary);font-size:14px;line-height:1.8;}.knowledge-card small{color:var(--om-muted);font-size:12px;}.error{color:var(--om-danger);}@media(max-width:700px){.article-grid{grid-template-columns:1fr;}.knowledge-home{padding:12px 0;}h1{font-size:28px;}}
</style>
