<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { OmBadge, OmEmpty } from "@omem/ui";
import KnowledgeDocument from "./KnowledgeDocument.vue";
import KnowledgeSource from "./KnowledgeSource.vue";
import { knowledgeApi, type Citation, type KnowledgeFrame } from "./api";
const props = defineProps<{
  prefix: string;
  frame: { kind: string; id: string; title: string };
}>();
const emit = defineEmits<{
  navigate: [frame: KnowledgeFrame];
  loaded: [title: string, frameId: string];
}>();
const parsed = computed(() => {
  try {
    return JSON.parse(props.frame.id) as Record<string, string | number>;
  } catch {
    return {};
  }
});
const citation = ref<Citation | null>(null),
  error = ref("");
let generation = 0;
watch(
  () => props.frame.id,
  async () => {
    const current = ++generation;
    citation.value = null;
    error.value = "";
    if (props.frame.kind !== "citation") return;
    try {
      const c = await knowledgeApi<Citation>(
        props.prefix,
        "/citation?" +
          new URLSearchParams({
            document: String(parsed.value.document),
            revision: String(parsed.value.revision),
            citation: String(parsed.value.citation),
          }),
      );
      if (current === generation) {
        citation.value = c;
        emit("loaded", c.label, props.frame.id);
      }
    } catch (e) {
      if (current === generation) error.value = String(e);
    }
  },
  { immediate: true },
);
const relationLabels: Record<string, string> = {
  supports: "支持论点",
  explains: "进一步解释",
  implements: "实现依据",
  depends_on: "依赖关系",
  calls: "调用关系 · AI 分析",
  contradicts: "相互矛盾",
  background: "背景依据",
  tracks: "进展依据",
};
</script>
<template>
  <KnowledgeDocument
    v-if="frame.kind === 'knowledge'"
    :prefix="prefix"
    :document-key="String(parsed.key)"
    :revision="parsed.revision ? String(parsed.revision) : undefined"
    :section="parsed.section ? String(parsed.section) : undefined"
    @navigate="emit('navigate', $event)"
    @loaded="emit('loaded', $event, frame.id)"
  />
  <KnowledgeSource
    v-else-if="frame.kind === 'source'"
    :prefix="prefix"
    :material-key="String(parsed.key)"
    :digest="parsed.digest ? String(parsed.digest) : undefined"
    :start-line="parsed.startLine ? Number(parsed.startLine) : undefined"
    :end-line="parsed.endLine ? Number(parsed.endLine) : undefined"
    @navigate="emit('navigate', $event)"
    @loaded="emit('loaded', $event, frame.id)"
  />
  <template v-else>
    <OmEmpty v-if="error" title="引用不可用" :description="error" />
    <p v-else-if="!citation">正在解析固定引用…</p>
    <template v-else>
      <aside class="citation-reason">
        <OmBadge>{{ relationLabels[citation.relation] || "引用" }}</OmBadge>
        <p>{{ citation.reason }}</p>
      </aside>
      <OmEmpty
        v-if="!citation.actionable || !citation.resolved"
        title="无法打开引用"
        :description="citation.unavailableReason || '目标不可用'"
      />
      <KnowledgeDocument
        v-else-if="citation.resolved.kind === 'article'"
        :prefix="prefix"
        :document-key="citation.resolved.key"
        :revision="citation.resolved.revision"
        :section="citation.resolved.section"
        @navigate="emit('navigate', $event)"
      />
      <KnowledgeSource
        v-else
        :prefix="prefix"
        :material-key="citation.resolved.key"
        :digest="citation.resolved.digest"
        :start-line="citation.resolved.startLine"
        :end-line="citation.resolved.endLine"
        @navigate="emit('navigate', $event)"
      />
    </template>
  </template>
</template>
<style scoped>
.citation-reason {
  padding: 12px 16px;
  background: var(--om-soft);
  border-radius: 6px;
  margin-bottom: 24px;
}
.citation-reason p {
  margin: 8px 0 0;
  color: var(--om-secondary);
  line-height: 1.8;
}
</style>
