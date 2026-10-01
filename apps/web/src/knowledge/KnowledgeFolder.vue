<script setup lang="ts">
import type { TopicNode } from "./topics";
import KnowledgeTree from "./KnowledgeTree.vue";
defineProps<{ node: TopicNode; selected: string; activePath: string[] }>();
const emit = defineEmits<{ select: [key: string]; topic: [path: string[]] }>();
</script>
<template>
  <li class="topic-folder">
    <details :open="node.path.every((part, i) => activePath[i] === part)">
      <summary>{{ node.title }} <small>{{ node.count }}</small></summary>
      <button class="topic-overview" @click="emit('topic', node.path)">浏览此分类</button>
      <ul>
        <KnowledgeFolder v-for="child in node.children" :key="child.title" :node="child" :selected="selected" :active-path="activePath" @select="emit('select', $event)" @topic="emit('topic', $event)" />
        <KnowledgeTree v-for="a in node.articles" :key="a.key" :article="a" :articles="[]" :selected="selected" @select="emit('select', $event)" />
      </ul>
    </details>
  </li>
</template>
<style scoped>
.topic-folder{list-style:none;min-width:0;}summary{padding:12px 8px;min-height:44px;cursor:pointer;overflow-wrap:anywhere;font-weight:600;}small{font-weight:400;color:var(--om-muted);margin-left:6px;}ul{padding:0 0 0 10px;margin:0;border-left:1px solid var(--om-line);}.topic-overview{min-height:44px;background:none;border:0;color:var(--om-secondary);font:13px var(--om-sans);padding:8px 16px;cursor:pointer;text-decoration:underline;}
</style>
