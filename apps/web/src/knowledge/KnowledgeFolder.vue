<script setup lang="ts">
import { ref, watch } from "vue";
import { OmIcon } from "@omem/ui";
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
    <div
      class="folder-row"
      :class="{
        active:
          node.path.length === activePath.length && isActive() && !selected,
      }"
    >
      <button
        class="folder-toggle"
        :aria-label="(expanded ? '收起' : '展开') + node.title"
        :aria-expanded="expanded"
        @click="expanded = !expanded"
      >
        <OmIcon name="arrow" :class="{ expanded }" />
      </button>
      <button class="folder-title" @click="emit('topic', node.path)">
        <span>{{ node.title }}</span
        ><small>{{ node.count }}</small>
      </button>
    </div>
    <ul v-if="expanded">
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
  </li>
</template>
<style scoped>
.topic-folder {
  list-style: none;
  min-width: 0;
}
.folder-row {
  display: flex;
  align-items: center;
  border-radius: 6px;
}
.folder-row:hover,
.folder-row.active {
  background: var(--om-soft);
}
.folder-toggle {
  display: grid;
  place-items: center;
  flex: 0 0 44px;
  align-self: stretch;
  min-height: 44px;
  border: 0;
  background: none;
  color: var(--om-muted);
  border-radius: 6px;
}
.folder-toggle svg {
  width: 14px;
  transition: transform 0.15s;
}
.folder-toggle svg.expanded {
  transform: rotate(90deg);
}
.folder-title {
  display: flex;
  align-items: center;
  gap: 12px;
  flex: 1;
  min-width: 0;
  min-height: 44px;
  padding: 8px 10px 8px 0;
  border: 0;
  background: none;
  text-align: left;
  color: var(--om-ink);
  font-size: 13px;
  font-weight: 600;
}
.folder-title span {
  flex: 1;
  overflow-wrap: anywhere;
}
.folder-title small {
  font-size: 12px;
  font-weight: 400;
  color: var(--om-muted);
}
.topic-folder > ul {
  padding: 0 0 0 8px;
  margin: 0 0 4px 8px;
  border-left: 1px solid var(--om-line);
}
</style>
