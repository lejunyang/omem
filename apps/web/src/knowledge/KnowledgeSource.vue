<script setup lang="ts">
import { computed, ref, watch } from "vue";
import DocumentReading from "../DocumentReading.vue";
import ReprocessControls from "../ReprocessControls.vue";
import type { Revision } from "../api";
import MaterialDescription from "../MaterialDescription.vue";
import { OmCodeViewer, OmMarkdown, OmButton, OmBadge, OmEmpty } from "@omem/ui";
import {
  knowledgeApi,
  knowledgeFrame,
  type ArticleMeta,
  type KnowledgeFrame,
} from "./api";
const props = defineProps<{
  prefix: string;
  materialKey: string;
  digest?: string;
  startLine?: number;
  endLine?: number;
}>();
const emit = defineEmits<{
  navigate: [frame: KnowledgeFrame];
  loaded: [title: string];
}>();
type Material = {
  document?: Revision["context"]["document"];
  key: string;
  revisionId: string;
  title: string;
  text: string;
  path: string | null;
  codeLanguage?: string | null;
  current: boolean;
  knowledge: ArticleMeta | null;
  images: { url: string; label: string }[];
  links: { line: number; label: string; reason: string; target: string }[];
  documentLinks?: { href: string; target: string }[];
};
const material = ref<Material | null>(null),
  error = ref("");
const linkError = ref("");
const from = ref(1),
  to = ref(1);
const reload = ref(0);
const lines = computed(() => material.value?.text.split("\n") ?? []);
const excerpt = computed(() =>
  lines.value.slice(from.value - 1, to.value).join("\n"),
);
watch(
  () => [material.value, props.startLine, props.endLine],
  () => {
    from.value = Math.max(
      1,
      Math.min(props.startLine ?? 1, lines.value.length),
    );
    to.value = Math.min(
      lines.value.length,
      props.endLine ?? (props.startLine ? from.value : 80),
    );
  },
);
let generation = 0;
watch(
  () => [props.materialKey, props.digest, reload.value],
  async () => {
    const current = ++generation;
    material.value = null;
    error.value = "";
    try {
      const m = await knowledgeApi<Material>(
        props.prefix,
        "/materials/" +
          encodeURIComponent(props.materialKey) +
          (props.digest ? "?digest=" + encodeURIComponent(props.digest) : ""),
      );
      if (current === generation) {
        material.value = m;
        emit("loaded", m.title);
      }
    } catch (e) {
      if (current === generation) error.value = String(e);
    }
  },
  { immediate: true },
);
async function reference(key: string) {
  emit("navigate", {
    kind: "source",
    id: JSON.stringify({ key }),
    title: "关联原始材料",
  });
}
function internal(path: string) {
  const target = material.value?.documentLinks?.find(
    (link) => link.href === path,
  )?.target;
  linkError.value = target
    ? ""
    : "关联材料尚未导入，或存在多个同名来源，暂时无法定位。";
  if (target) void reference(target);
}
</script>
<template>
  <section class="knowledge-source">
    <OmEmpty v-if="error" title="原始材料不可用" :description="error" />
    <p v-else-if="!material">正在读取固定原文…</p>
    <template v-else>
      <h2>{{ material.title }}</h2>
      <ReprocessControls
        v-if="material.current"
        target="source"
        :target-id="material.revisionId"
        :title="material.title"
        :actions="
          material.document?.parser === 'docling'
            ? ['parse', 'describe', 'understand', 'delete']
            : ['describe', 'understand', 'refresh', 'delete']
        "
        @updated="reload++"
      />
      <p v-if="linkError" role="status">{{ linkError }}</p>
      <div class="source-actions">
        <OmBadge
          >原始材料 · {{ material.current ? "当前版本" : "历史版本" }}</OmBadge
        ><OmButton
          v-if="material.knowledge"
          variant="secondary"
          @click="
            emit(
              'navigate',
              knowledgeFrame(material.key, material.knowledge.title),
            )
          "
          >阅读这份材料的知识解读 ↗</OmButton
        >
      </div>
      <p v-if="startLine" class="muted">
        引用位置：第 {{ startLine
        }}{{ endLine && endLine !== startLine ? `–${endLine}` : "" }} 行
      </p>
      <DocumentReading
        v-if="material.document"
        :revision-id="material.revisionId"
        :document="material.document"
        :fallback="material.text"
      />
      <div
        class="code-excerpt"
        v-else-if="
          material.codeLanguage ||
          (material.path && !/\.(?:md|markdown)$/.test(material.path))
        "
      >
        <OmButton
          v-if="from > 1"
          variant="ghost"
          @click="from = Math.max(1, from - 20)"
          >向上展开 20 行</OmButton
        >
        <OmCodeViewer
          :code="excerpt"
          :start-line="from"
          :language="material.codeLanguage || material.path?.split('.').pop()"
          :anchor-line="startLine"
          :links="material.links"
          @open-reference="reference"
        />
        <OmButton
          v-if="to < lines.length"
          variant="ghost"
          @click="to = Math.min(lines.length, to + 20)"
          >向下展开 20 行</OmButton
        >
        <small class="muted"
          >显示 {{ from }}–{{ to }} 行，共 {{ lines.length }} 行</small
        >
      </div>
      <template v-else>
        <blockquote v-if="startLine && endLine">
          {{
            material.text
              .split("\n")
              .slice(startLine - 1, endLine)
              .join("\n")
          }}
        </blockquote>
        <OmMarkdown
          v-if="material.text"
          :source="material.text"
          @navigate-internal="internal"
        />
      </template>
      <img
        v-for="image in material.images"
        :key="image.url"
        :src="image.url"
        :alt="image.label"
      />
      <MaterialDescription
        v-if="material.revisionId"
        :revision-id="material.revisionId"
        :current="material.current"
        :prefix="prefix"
      />
    </template>
  </section>
</template>
<style scoped>
.code-excerpt {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 12px;
  margin: 16px 0;
}
h2 {
  font: 24px/1.6 var(--om-serif);
  overflow-wrap: anywhere;
}
.source-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
  margin: 16px 0;
}
img {
  max-width: 100%;
  height: auto;
  border: 1px solid var(--om-line);
  margin: 16px 0;
}
blockquote {
  white-space: pre-wrap;
  border-left: 3px solid var(--om-line);
  padding: 12px;
  color: var(--om-secondary);
  margin: 16px 0;
}
</style>
