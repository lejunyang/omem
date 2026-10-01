<script setup lang="ts">
import { computed, ref } from "vue";
import type { ArticleMeta } from "./api";
const props = defineProps<{
  article: ArticleMeta;
  articles: ArticleMeta[];
  selected: string;
  ancestors?: string[];
}>();
const emit = defineEmits<{ select: [key: string] }>();
const expanded = ref(false);
const children = computed(() =>
  (props.article.children ?? [])
    .filter(
      (key) => !props.ancestors?.includes(key) && key !== props.article.key,
    )
    .flatMap((key) => props.articles.find((a) => a.key === key) ?? []),
);
</script>
<template>
  <li>
    <div class="tree-row">
      <button
        v-if="children.length"
        class="tree-toggle"
        :aria-label="(expanded ? '收起' : '展开') + article.title"
        :aria-expanded="expanded"
        @click="expanded = !expanded"
      >
        {{ expanded ? "−" : "+" }}</button
      ><span v-else class="tree-spacer" />
      <button
        class="tree-title"
        :class="{ selected: selected === article.key }"
        :aria-current="selected === article.key ? 'page' : undefined"
        @click="emit('select', article.key)"
      >
        {{ article.title }}<small v-if="!article.current">待更新</small>
      </button>
    </div>
    <ul v-if="expanded">
      <KnowledgeTree
        v-for="child in children"
        :key="child.key"
        :article="child"
        :articles="articles"
        :selected="selected"
        :ancestors="[...(ancestors ?? []), article.key]"
        @select="emit('select', $event)"
      />
    </ul>
  </li>
</template>
<style scoped>
li {
  list-style: none;
  min-width: 0;
}
ul {
  padding-left: 12px;
  margin: 0;
  border-left: 1px solid var(--om-line);
}
.tree-row {
  display: flex;
  align-items: start;
}
.tree-toggle {
  flex: 0 0 32px;
  min-height: 44px;
  border: 0;
  background: none;
  color: var(--om-secondary);
  cursor: pointer;
}
.tree-spacer {
  width: 4px;
  flex-shrink: 0;
}
.tree-title {
  flex: 1;
  min-width: 0;
  border: 0;
  background: none;
  color: var(--om-secondary);
  font: 13px/1.65 var(--om-sans);
  text-align: left;
  min-height: 44px;
  padding: 9px 10px;
  cursor: pointer;
  border-radius: 4px;
  overflow-wrap: anywhere;
}
.tree-title.selected {
  background: var(--om-soft);
  color: var(--om-ink);
  font-weight: 600;
}
small {
  display: block;
  font-size: 12px;
  color: var(--om-muted);
}
</style>
