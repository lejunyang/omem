<script setup lang="ts">
import { ref, watch, nextTick } from "vue";
import { OmMarkdown, OmBadge, OmEmpty, OmButton, OmDisclosure } from "@omem/ui";
import KnowledgeQuestions from "./KnowledgeQuestions.vue";
import ReprocessControls from "../ReprocessControls.vue";
import { knowledgeApi, type Article, type KnowledgeFrame } from "./api";
const props = defineProps<{
  prefix: string;
  documentKey: string;
  revision?: string;
  section?: string;
}>();
const emit = defineEmits<{
  navigate: [frame: KnowledgeFrame];
  loaded: [title: string];
  answered: [];
}>();
const article = ref<Article | null>(null),
  error = ref("");
const root = ref<HTMLElement>();
const mobileOutline = ref(false);
const reload = ref(0);
let generation = 0;
watch(
  () => [props.documentKey, props.revision, reload.value],
  async () => {
    const current = ++generation;
    error.value = "";
    article.value = null;
    try {
      const result = await knowledgeApi<Article>(
        props.prefix,
        "/articles/" +
          encodeURIComponent(props.documentKey) +
          (props.revision
            ? "?revision=" + encodeURIComponent(props.revision)
            : ""),
      );
      if (current !== generation) return;
      article.value = result;
      emit("loaded", result.title);
      await nextTick();
      if (props.section)
        root.value
          ?.querySelector(`[data-section="${CSS.escape(props.section)}"]`)
          ?.scrollIntoView({ block: "start" });
    } catch (e) {
      if (current === generation) error.value = String(e);
    }
  },
  { immediate: true },
);
function cite(key: string) {
  const c = article.value?.citations.find((c) => c.key === key);
  if (!c?.actionable || !article.value) return;
  emit("navigate", {
    kind: "citation",
    id: JSON.stringify({
      document: props.documentKey,
      revision: article.value.revision,
      citation: key,
    }),
    title: c.label,
  });
}
async function answered() {
  emit("answered");
  const key = props.documentKey;
  try {
    const result = await knowledgeApi<Article>(
      props.prefix,
      "/articles/" +
        encodeURIComponent(key) +
        (props.revision
          ? "?revision=" + encodeURIComponent(props.revision)
          : ""),
    );
    if (key === props.documentKey) article.value = result;
  } catch (e) {
    error.value = String(e);
  }
}
</script>
<template>
  <article ref="root" class="knowledge-document">
    <OmEmpty v-if="error" title="知识暂不可用" :description="error" />
    <p v-else-if="!article" class="muted" role="status">正在读取知识正文…</p>
    <template v-else>
      <div class="article-body">
        <h2>{{ article.title }}</h2>
        <ReprocessControls
          v-if="!revision"
          target="article"
          :target-id="documentKey"
          :title="article.title"
          :actions="['write', 'delete']"
          @updated="reload++"
        />
        <p class="knowledge-summary">{{ article.summary }}</p>
        <div v-if="article.reading" class="reading-goal">
          <strong>读完这一篇</strong>
          <p>{{ article.reading.goal }}</p>
        </div>
        <p v-if="!article.current" class="update-note" role="status">
          部分内容需要核对，已在对应章节标出；其他章节仍可阅读，引用保留写作时的原文。
        </p>
        <section
          v-for="section in article.document.sections"
          :key="section.key"
          :data-section="section.key"
          class="knowledge-section"
        >
          <h3>{{ section.title }}</h3>
          <p
            v-if="
              article.sectionStatus?.[section.key] &&
              article.sectionStatus[section.key]?.state !== 'current'
            "
            class="section-update"
            role="status"
          >
            {{ article.sectionStatus[section.key]?.reason }}。下方保留原有解释。
          </p>
          <OmMarkdown
            :source="section.body"
            :citations="article.citations"
            @cite="cite"
          />
        </section>
        <KnowledgeQuestions
          v-if="article.questionCount"
          :prefix="prefix"
          :document-key="article.key"
          @answered="answered"
        />
        <OmDisclosure
          class="article-details provenance-details"
          title="来源与生成记录"
          ><p>
            基于固定原始材料，由 {{ article.model }} 生成、{{
              article.reviewedBy
            }}
            独立复核。生成于
            {{
              new Date(article.generatedAt).toLocaleString()
            }}。正文引用可查看对应原文。
          </p></OmDisclosure
        >
      </div>
      <nav
        v-if="article.document.sections.length > 2"
        class="article-toc"
        :class="{ 'mobile-open': mobileOutline }"
        aria-label="本篇目录"
      >
        <button
          class="outline-toggle"
          :aria-expanded="mobileOutline"
          @click="mobileOutline = !mobileOutline"
        >
          {{ mobileOutline ? "收起本篇目录" : "展开本篇目录" }}
        </button>
        <a
          v-for="s in article.document.sections"
          :key="s.key"
          :href="'#' + s.key"
          @click.prevent="
            root
              ?.querySelector(`[data-section='${s.key}']`)
              ?.scrollIntoView({ block: 'start' })
          "
          >{{ s.title }}</a
        >
      </nav>
    </template>
  </article>
</template>
<style scoped>
.knowledge-document {
  display: grid;
  grid-template-columns: minmax(0, 760px) 170px;
  gap: 32px;
  min-width: 0;
  margin: 0 auto;
  max-width: 1000px;
}
.article-body {
  min-width: 0;
}
.knowledge-document h2 {
  font-family: var(--om-serif);
  font-size: 30px;
  line-height: 1.55;
  margin: 8px 0 18px;
}
.knowledge-provenance {
  display: flex;
  gap: 12px;
  align-items: center;
  flex-wrap: wrap;
  font-size: 12px;
  color: var(--om-muted);
  margin: 16px 0 24px;
}
.article-toc {
  align-self: start;
  position: sticky;
  top: 24px;
  border-left: 1px solid var(--om-line);
  padding-left: 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.article-toc::before {
  content: "本页内容";
  font-weight: 600;
  margin-bottom: 8px;
}
.article-toc a {
  font-size: 12px;
  line-height: 1.6;
  color: var(--om-secondary);
  text-decoration: none;
  padding: 6px 0;
}
.knowledge-section {
  margin: 28px 0;
  scroll-margin-top: 18px;
}
.knowledge-section h3 {
  font-family: var(--om-serif);
  font-size: 21px;
}
.knowledge-open-questions {
  border-top: 1px solid var(--om-line);
  margin-top: 32px;
  padding: 16px 0;
  color: var(--om-secondary);
}

.knowledge-open-questions div {
  margin: 20px 0;
}
@media (max-width: 700px) {
  .knowledge-document h2 {
    font-size: 25px;
  }
}
</style>

<style scoped>
@media (max-width: 1250px) {
  .knowledge-document {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .article-toc {
    order: -1;
    position: static;
    flex-direction: row;
    flex-wrap: wrap;
    border: 0;
    border-bottom: 1px solid var(--om-line);
    padding: 0 0 12px;
  }
  .article-toc a {
    padding: 6px;
  }
  .article-toc::before {
    width: 100%;
  }
}
:global(.om-trail .knowledge-document) {
  display: block;
}
:global(.om-trail .article-toc) {
  display: none;
}
</style>

<style scoped>
.reading-goal {
  margin: 24px 0 36px;
  padding: 20px 24px;
  border-left: 3px solid var(--om-ink);
  background: var(--om-paper);
}
.reading-goal strong {
  font-size: 13px;
}
.reading-goal p {
  margin: 8px 0 0;
  font-size: 14px;
  color: var(--om-secondary);
}
.update-note {
  margin: 24px 0;
  padding: 16px;
  background: var(--om-soft);
  color: var(--om-secondary);
}
.section-update {
  margin: 0 0 20px;
  padding: 12px 16px;
  border-left: 2px solid var(--om-warning);
  background: var(--om-paper);
  color: var(--om-secondary);
  font-size: 13px;
}
.knowledge-section {
  margin: 36px 0;
}
.knowledge-section h3 {
  margin: 0 0 18px;
  line-height: 1.6;
}
.article-details {
  border-top: 1px solid var(--om-line);
  margin-top: 28px;
  padding-top: 12px;
}
.provenance-details {
  color: var(--om-muted);
  font-size: 12px;
}
.outline-toggle {
  display: none;
}
@media (max-width: 700px) {
  .article-toc::before {
    display: none;
  }
  .article-toc a {
    display: none;
  }
  .article-toc.mobile-open a {
    display: block;
  }
  .outline-toggle {
    display: block;
    width: 100%;
    min-height: 44px;
    text-align: left;
    border: 0;
    background: none;
    font: inherit;
    color: var(--om-secondary);
  }
}
@media (max-width: 700px) {
  .reading-goal {
    padding: 16px;
    margin: 20px 0 28px;
  }
  .knowledge-section {
    margin: 28px 0;
  }
}
</style>
