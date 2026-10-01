<script setup lang="ts">
import { ref, watch } from "vue";
import { OmDisclosure } from "@omem/ui";
import type { TopicNode } from "./topics";
import KnowledgeTree from "./KnowledgeTree.vue";
const props = defineProps<{
  node: TopicNode;
  selected: string;
  activePath: string[];
}>();
const emit = defineEmits<{ select: [key: string]; topic: [path: string[]] }>();
const isActive = () =>
  props.node.path.every((part, i) => props.activePath[i] === part);
const expanded = ref(isActive() || props.node.path.length === 1);
watch(
  () => props.activePath,
  () => {
    if (isActive()) expanded.value = true;
  },
);
</script>
<template>
  <li class="topic-folder">
    <OmDisclosure
      v-model:open="expanded"
      :title="node.title"
      title-action
      :class="{
        active:
          node.path.length === activePath.length && isActive() && !selected,
      }"
      @select="emit('topic', node.path)"
    >
      <template #meta>{{ node.count }}</template>
      <ul>
        <KnowledgeFolder
          v-for="child in node.children"
          :key="child.title"
          :node="child"
          :selected="selected"
          :active-path="activePath"
          @select="emit('select', $event)"
          @topic="emit('topic', $event)"
        />
        <KnowledgeTree
          v-for="a in node.articles"
          :key="a.key"
          :article="a"
          :articles="[]"
          :selected="selected"
          @select="emit('select', $event)"
        />
      </ul>
    </OmDisclosure>
  </li>
</template>
<style scoped>
.topic-folder {
  list-style: none;
  min-width: 0;
}
.active:deep(> .disclosure-heading) {
  background: var(--om-soft);
}
ul {
  padding: 0 0 0 8px;
  margin: 0 0 4px 8px;
  border-left: 1px solid var(--om-line);
}
</style>
