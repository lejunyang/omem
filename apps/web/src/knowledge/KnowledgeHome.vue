<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from "vue";
import { OmEmpty, OmButton, OmIcon, OmDisclosure } from "@omem/ui";
import KnowledgeDocument from "./KnowledgeDocument.vue";
import KnowledgeTree from "./KnowledgeTree.vue";
import KnowledgeFolder from "./KnowledgeFolder.vue";
import ArticleComposer, { type MaterialOption } from "./ArticleComposer.vue";
import { topicTree, inTopic, articleOrder } from "./topics";
import {
  knowledgeApi,
  type ArticleMeta,
  type KnowledgeFrame,
  type PlannedPage,
} from "./api";
const props = defineProps<{
  prefix: string;
  compact?: boolean;
  selectedKey?: string;
}>();
const emit = defineEmits<{
  navigate: [frame: KnowledgeFrame];
  select: [key: string];
}>();
const loading = ref(true),
  mobileNavigation = ref(false),
  composerOpen = ref(false);
const allArticles = ref<ArticleMeta[]>([]),
  materials = ref<MaterialOption[]>([]),
  query = ref(""),
  selected = ref(
    props.selectedKey || sessionStorage.getItem("omem-knowledge-page") || "",
  ),
  error = ref("");
const pageSize = ref(20);
const view = ref<"article" | "reference">("article");
const pages = ref<PlannedPage[]>([]);
const articles = computed(() =>
  allArticles.value.filter((a) => (a.role ?? "article") === view.value),
);
const pendingPages = computed(() =>
  pages.value.filter(
    (p) =>
      p.role === view.value &&
      p.plan &&
      topic.value.every((part, i) => p.plan!.topicPath?.[i] === part) &&
      !allArticles.value.some((a) => a.key === p.key),
  ),
);
function changeView(value: "article" | "reference") {
  view.value = value;
  query.value = "";
  selectTopic([]);
}
watch(
  [selected, allArticles],
  () => {
    const role = allArticles.value.find((a) => a.key === selected.value)?.role;
    if (role === "article" || role === "reference") view.value = role;
  },
  { flush: "sync" },
);
const topic = ref<string[]>([]),
  running = ref(false),
  lastRun = ref<{
    state?: string;
    title?: string;
    key?: string;
    error?: string;
  } | null>(null);
let timer: ReturnType<typeof setInterval> | undefined;
const tree = computed(() => topicTree(articles.value));
const current = computed(() =>
  allArticles.value.find((a) => a.key === selected.value),
);
const activePath = computed(() => current.value?.topicPath ?? topic.value);
const scopedArticles = computed(() =>
  articles.value.filter((a) => inTopic(a, topic.value)).sort(articleOrder),
);
const siblings = computed(() =>
  current.value
    ? articles.value
        .filter(
          (a) =>
            JSON.stringify(a.topicPath ?? []) ===
            JSON.stringify(current.value!.topicPath ?? []),
        )
        .sort(articleOrder)
    : [],
);
const nextArticle = computed(
  () =>
    siblings.value[
      siblings.value.findIndex((a) => a.key === selected.value) + 1
    ],
);
const remoteMatches = ref<ArticleMeta[]>([]),
  searching = ref(false),
  searchError = ref("");
let searchTimer: ReturnType<typeof setTimeout> | undefined,
  searchController: AbortController | undefined,
  searchVersion = 0;
watch(
  [query, topic],
  ([value]) => {
    clearTimeout(searchTimer);
    searchController?.abort();
    const version = ++searchVersion;
    remoteMatches.value = [];
    searchError.value = "";
    if (!value.trim()) {
      searching.value = false;
      return;
    }
    searching.value = true;
    searchTimer = setTimeout(async () => {
      const controller = new AbortController();
      searchController = controller;
      try {
        const params = new URLSearchParams({
          q: value,
          topic: JSON.stringify(topic.value),
        });
        const result = await knowledgeApi<ArticleMeta[]>(
          props.prefix,
          "/search?" + params,
          { signal: controller.signal },
        );
        if (version === searchVersion) remoteMatches.value = result;
      } catch (e) {
        if (version === searchVersion && !controller.signal.aborted)
          searchError.value = String(e);
      } finally {
        if (version === searchVersion) searching.value = false;
      }
    }, 250);
  },
  { flush: "sync" },
);
const matches = computed(() => [
  ...new Map(
    [
      ...remoteMatches.value.filter(
        (a) => (a.role ?? "article") === view.value,
      ),
      ...scopedArticles.value.filter((a) =>
        (a.title + a.summary).toLowerCase().includes(query.value.toLowerCase()),
      ),
    ].map((a) => [a.key, a]),
  ).values(),
]);
function select(key: string) {
  selected.value = key;
  mobileNavigation.value = false;
  sessionStorage.setItem("omem-knowledge-page", key);
  emit("select", key);
}
function selectTopic(path: string[]) {
  topic.value = path;
  pageSize.value = 20;
  select("");
}
watch(
  () => props.selectedKey,
  (key) => {
    selected.value = key ?? "";
  },
);
async function refreshPage(key: string) {
  try {
    await knowledgeApi(
      props.prefix,
      "/pages/" + encodeURIComponent(key) + "/refresh",
      { method: "POST" },
    );
    await load();
  } catch (e) {
    error.value = String(e);
  }
}
async function load() {
  try {
    const result = await knowledgeApi<{
      articles: ArticleMeta[];
      pages?: PlannedPage[];
      materials: MaterialOption[];
      running: boolean;
      lastRun: typeof lastRun.value;
    }>(props.prefix, "/articles");
    allArticles.value = result.articles;
    pages.value = result.pages ?? [];
    materials.value = result.materials;
    running.value = result.running;
    lastRun.value = result.lastRun;
    error.value = "";
  } catch (e) {
    error.value = String(e);
  } finally {
    loading.value = false;
  }
}
onMounted(() => {
  void load();
  timer = setInterval(() => void load(), 5000);
});
onBeforeUnmount(() => {
  clearInterval(timer);
  clearTimeout(searchTimer);
  searchController?.abort();
  searchVersion++;
});
</script>
<template>
  <section class="knowledge-library">
    <aside class="book-navigation">
      <div class="directory-heading">
        <span>知识目录</span
        ><button
          class="mobile-navigation-toggle"
          :aria-expanded="mobileNavigation"
          @click="mobileNavigation = !mobileNavigation"
        >
          <OmIcon name="menu" />{{
            mobileNavigation ? "收起目录" : "展开章节目录"
          }}
        </button>
      </div>
      <div
        class="navigation-content"
        :class="{ 'mobile-open': mobileNavigation }"
      >
        <label for="knowledge-filter">查找章节</label
        ><input
          id="knowledge-filter"
          v-model="query"
          placeholder="搜索文章与内容"
        />
        <button
          class="all-articles"
          :class="{ active: !topic.length && !current }"
          @click="selectTopic([])"
        >
          <OmIcon name="book" /><span>全部文章</span
          ><small>{{ articles.length }}</small>
        </button>
        <p v-if="query.trim() && topic.length" class="scope-label">
          搜索范围：{{ topic.join(" / ") }}
          <button @click="topic = []">搜索全部</button>
        </p>
        <nav aria-label="知识目录" :aria-busy="searching">
          <p v-if="searching" class="search-status" role="status">
            正在查找相关章节…
          </p>
          <p v-if="searchError" role="alert">搜索失败：{{ searchError }}</p>
          <ul v-if="query.trim()">
            <KnowledgeTree
              v-for="a in matches"
              :key="a.key"
              :article="a"
              :articles="[]"
              :selected="selected"
              @select="select"
            />
            <li
              v-if="!searching && !searchError && !matches.length"
              class="no-matches"
            >
              没有匹配的文章
            </li>
          </ul>
          <template v-else>
            <ul>
              <KnowledgeFolder
                v-for="node in tree.children"
                :key="node.title"
                :node="node"
                :selected="selected"
                :active-path="activePath"
                @select="select"
                @topic="selectTopic"
              />
            </ul>
            <OmDisclosure
              v-if="tree.articles.length"
              :default-open="!tree.children.length"
              title="未分类"
              ><template #meta>{{ tree.articles.length }}</template>
              <ul>
                <KnowledgeTree
                  v-for="a in tree.articles"
                  :key="a.key"
                  :article="a"
                  :articles="[]"
                  :selected="selected"
                  @select="select"
                />
              </ul>
            </OmDisclosure>
          </template>
        </nav>
      </div>
    </aside>
    <div class="book-content">
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <p v-if="running" class="generation-status" role="status">
        正在整理“{{
          lastRun?.title || "所选材料"
        }}”。完成调查、撰写与复核后，文章会出现在目录中。
      </p>
      <p v-else-if="lastRun?.state === 'failed'" class="error" role="alert">
        “{{ lastRun.title }}”未完成：{{ lastRun.error }}
      </p>
      <p
        v-else-if="lastRun?.state === 'published'"
        class="generation-status"
        role="status"
      >
        “{{ lastRun.title }}”已完成
        <OmButton variant="ghost" @click="select(lastRun!.key!)"
          >阅读文章</OmButton
        >
      </p>
      <KnowledgeDocument
        v-if="current"
        :key="current.key"
        :prefix="prefix"
        :document-key="current.key"
        :revision="current.revision"
        @navigate="emit('navigate', $event)"
      />
      <p v-else-if="loading" role="status">正在打开知识库…</p>
      <section v-else class="library-overview">
        <nav v-if="topic.length" class="topic-breadcrumb" aria-label="分类路径">
          <button @click="selectTopic([])">知识库</button
          ><template v-for="(part, index) in topic" :key="index"
            ><span>/</span
            ><button
              v-if="index < topic.length - 1"
              @click="selectTopic(topic.slice(0, index + 1))"
            >
              {{ part }}</button
            ><span v-else>{{ part }}</span></template
          >
        </nav>
        <div class="library-views" aria-label="阅读内容">
          <OmButton
            :variant="view === 'article' ? 'primary' : 'ghost'"
            :aria-pressed="view === 'article'"
            @click="changeView('article')"
            >主题文章</OmButton
          ><OmButton
            :variant="view === 'reference' ? 'primary' : 'ghost'"
            :aria-pressed="view === 'reference'"
            @click="changeView('reference')"
            >参考资料</OmButton
          >
        </div>
        <header class="overview-heading">
          <div>
            <h1>{{ topic.at(-1) || "知识库" }}</h1>
            <p>
              {{
                topic.length
                  ? "在这里阅读这个主题的文章，沿引用了解背景。"
                  : "把材料连成知识，读懂之后再沿引用深入。"
              }}
            </p>
          </div>
          <OmButton
            variant="primary"
            :disabled="running"
            @click="composerOpen = true"
            ><OmIcon name="plus" />整理文章</OmButton
          >
        </header>
        <div v-if="!topic.length && tree.children.length" class="topic-cards">
          <button
            v-for="node in tree.children"
            :key="node.title"
            @click="selectTopic(node.path)"
          >
            <OmIcon name="layers" /><span
              ><strong>{{ node.title }}</strong
              ><small>{{ node.count }} 篇文章</small></span
            ><OmIcon name="arrow" />
          </button>
        </div>
        <div class="list-heading">
          <h2>{{ topic.length ? "本分类文章" : "全部文章" }}</h2>
          <span>{{ scopedArticles.length }} 篇</span>
        </div>
        <ul class="article-list">
          <li v-for="a in scopedArticles.slice(0, pageSize)" :key="a.key">
            <button @click="select(a.key)">
              <span class="article-copy"
                ><span class="article-meta"
                  >{{ (a.topicPath ?? []).join(" / ") || "未分类"
                  }}<span v-if="!a.current" class="stale-label"
                    >待更新</span
                  ></span
                ><strong>{{ a.title }}</strong
                ><span class="article-summary">{{ a.summary }}</span></span
              ><OmIcon name="arrow" />
            </button>
          </li>
        </ul>
        <OmButton
          v-if="scopedArticles.length > pageSize"
          variant="secondary"
          @click="pageSize += 20"
          >继续浏览（还有 {{ scopedArticles.length - pageSize }} 篇）</OmButton
        >
        <section v-if="pendingPages.length" class="planned-pages">
          <h2>准备整理</h2>
          <p v-for="page in pendingPages" :key="page.key">
            <strong>{{ page.plan?.title }}</strong
            ><span>{{
              page.state === "writing"
                ? "正在调查与写作"
                : page.state === "failed"
                  ? "上次整理未完成，阅读目标已保留"
                  : "阅读目标已保存，等待整理"
            }}</span
            ><OmButton
              variant="secondary"
              :disabled="running"
              @click="refreshPage(page.key)"
              >{{ page.state === "failed" ? "重试整理" : "开始整理" }}</OmButton
            >
          </p>
        </section>
        <OmEmpty
          v-if="!scopedArticles.length && !pendingPages.length"
          title="知识从你的材料开始"
          description="点击「整理文章」，选择材料和想弄懂的问题。"
        />
      </section>
      <footer v-if="current" class="next-guide">
        <OmButton
          v-if="current.reading"
          variant="secondary"
          :disabled="running"
          @click="refreshPage(current.key)"
          >重新整理这篇</OmButton
        >
        <OmButton variant="ghost" @click="selectTopic(current.topicPath ?? [])"
          >返回分类</OmButton
        ><OmButton
          v-if="nextArticle"
          variant="secondary"
          @click="select(nextArticle.key)"
          >下一篇：{{ nextArticle.title }}</OmButton
        >
      </footer>
    </div>
    <ArticleComposer
      :open="composerOpen"
      :prefix="prefix"
      :materials="materials"
      :topic-path="topic"
      :running="running"
      @close="composerOpen = false"
      @submitted="load"
    />
  </section>
</template>
<style scoped>
.library-views {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 24px;
}
.planned-pages {
  border-top: 1px solid var(--om-line);
  margin-top: 32px;
  padding-top: 20px;
}
.planned-pages h2 {
  font-size: 15px;
}
.planned-pages p {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 20px 0;
  font-size: 14px;
}
.planned-pages span {
  color: var(--om-muted);
  font-size: 13px;
}
.knowledge-library {
  display: grid;
  grid-template-columns: 256px minmax(0, 1fr);
  min-height: calc(100dvh - 125px);
  background: var(--om-panel);
}
.book-navigation {
  position: sticky;
  top: 0;
  align-self: start;
  max-height: calc(100dvh - 125px);
  overflow: auto;
  padding: 24px 16px;
  background: var(--om-paper);
  border-right: 1px solid var(--om-line);
  min-width: 0;
}
.directory-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 0 4px 20px;
  font-size: 13px;
  font-weight: 600;
}
.navigation-content > label {
  font-size: 12px;
  color: var(--om-muted);
  margin: 0 4px 6px;
}
.navigation-content > input {
  width: 100%;
  min-height: 44px;
  font-size: 13px;
  margin-bottom: 16px;
}
.all-articles {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 44px;
  border: 0;
  border-radius: 6px;
  background: none;
  text-align: left;
  padding: 10px;
  color: var(--om-secondary);
}
.all-articles.active,
.all-articles:hover {
  background: var(--om-soft);
  color: var(--om-ink);
}
.all-articles > span {
  flex: 1;
}
.all-articles svg {
  width: 16px;
}
.all-articles small {
  font-size: 12px;
}
nav ul {
  list-style: none;
  padding: 0;
  margin: 8px 0;
}

.scope-label,
.search-status,
.no-matches {
  font-size: 12px;
  color: var(--om-muted);
  margin: 12px 4px;
}
.scope-label button {
  min-height: 44px;
  border: 0;
  background: none;
  text-decoration: underline;
}
.book-content {
  min-width: 0;
  padding: 40px clamp(24px, 4vw, 64px) 64px;
}
.library-overview {
  max-width: 900px;
  margin: 0 auto;
}
.topic-breadcrumb {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 12px;
  color: var(--om-muted);
  margin: -12px 0 16px;
}
.topic-breadcrumb button {
  border: 0;
  background: none;
  min-height: 44px;
  padding: 4px 0;
  color: var(--om-secondary);
}
.overview-heading {
  display: flex;
  align-items: start;
  justify-content: space-between;
  gap: 24px;
  margin-bottom: 32px;
}
.overview-heading h1 {
  font: 32px/1.35 var(--om-serif);
  margin: 0 0 12px;
}
.overview-heading p {
  font-size: 13px;
  color: var(--om-muted);
  margin: 0;
}
.overview-heading > button {
  flex-shrink: 0;
}
.topic-cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
  gap: 12px;
  margin-bottom: 36px;
}
.topic-cards button {
  display: flex;
  align-items: center;
  gap: 12px;
  text-align: left;
  border: 1px solid var(--om-line);
  border-radius: 8px;
  padding: 16px;
  background: var(--om-panel);
  min-height: 80px;
}
.topic-cards button:hover {
  background: var(--om-paper);
}
.topic-cards button > span {
  flex: 1;
  min-width: 0;
}
.topic-cards strong {
  display: block;
  font-size: 14px;
  overflow-wrap: anywhere;
}
.topic-cards small {
  display: block;
  margin-top: 4px;
  font-size: 12px;
}
.topic-cards svg {
  color: var(--om-muted);
  width: 18px;
  flex-shrink: 0;
}
.list-heading {
  display: flex;
  align-items: center;
  gap: 12px;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--om-line);
}
.list-heading h2 {
  font: 600 14px/1.5 var(--om-sans);
  margin: 0;
}
.list-heading > span {
  font-size: 12px;
  color: var(--om-muted);
}
.article-list {
  list-style: none;
  padding: 0;
  margin: 0 0 24px;
}
.article-list li {
  border-bottom: 1px solid var(--om-line);
}
.article-list button {
  display: flex;
  align-items: center;
  gap: 24px;
  width: 100%;
  padding: 24px 8px;
  border: 0;
  background: none;
  text-align: left;
  border-radius: 6px;
}
.article-list button:hover {
  background: var(--om-paper);
}
.article-copy {
  flex: 1;
  min-width: 0;
}
.article-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
  font-size: 12px;
  color: var(--om-muted);
  margin-bottom: 8px;
}
.article-copy > strong {
  display: block;
  font: 600 18px/1.6 var(--om-sans);
  color: var(--om-ink);
  overflow-wrap: anywhere;
}
.article- .article-list svg {
  width: 16px;
  flex-shrink: 0;
  color: var(--om-muted);
}
.stale-label {
  border: 1px solid var(--om-line);
  border-radius: 4px;
  padding: 0 5px;
}
.error {
  color: var(--om-danger);
}
.generation-status {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
  padding: 14px 16px;
  background: var(--om-paper);
  border-radius: 8px;
  margin: 0 0 24px;
  font-size: 13px;
}
.next-guide {
  max-width: 1000px;
  margin: 40px auto 0;
  border-top: 1px solid var(--om-line);
  padding-top: 24px;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px 20px;
}
.mobile-navigation-toggle {
  display: none;
}
@media (max-width: 1100px) {
  .knowledge-library {
    grid-template-columns: 220px minmax(0, 1fr);
  }
  .book-content {
    padding: 32px 24px;
  }
}
@media (max-width: 900px) {
  .knowledge-library {
    display: block;
  }
  .book-navigation {
    position: static;
    border-right: 0;
    border-bottom: 1px solid var(--om-line);
    padding: 12px 20px;
    max-height: none;
  }
  .directory-heading {
    margin: 0;
  }
  .mobile-navigation-toggle {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 44px;
    padding: 8px;
    border: 0;
    background: none;
    color: var(--om-secondary);
    font-size: 12px;
  }
  .navigation-content {
    display: none;
  }
  .navigation-content.mobile-open {
    display: block;
    margin-top: 16px;
    max-height: 320px;
    overflow: auto;
  }
}
@media (max-width: 700px) {
  .book-navigation {
    padding: 8px 16px;
  }
  .book-content {
    padding: 24px 20px 40px;
  }
  .overview-heading {
    gap: 16px;
    flex-wrap: wrap;
    margin-bottom: 28px;
  }
  .overview-heading h1 {
    font-size: 28px;
  }
  .overview-heading p {
    font-size: 12px;
  }
  .topic-cards {
    grid-template-columns: 1fr;
    margin-bottom: 28px;
  }
  .article-list button {
    gap: 12px;
    padding: 20px 0;
  }
  .article-copy > strong {
    font-size: 16px;
  }
  .article- .topic-breadcrumb {
    margin-top: -8px;
  }
}
</style>
