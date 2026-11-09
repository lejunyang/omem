<script setup lang="ts">
import { computed, ref } from "vue";
import { formatJsonPrimitive, type JsonTreeNode } from "../../shared/json-viewer";

const props = defineProps<{
  node: JsonTreeNode;
  depth?: number;
  defaultExpandedDepth?: number;
}>();

const depth = computed(() => props.depth ?? 0);
const defaultExpandedDepth = computed(() => props.defaultExpandedDepth ?? 1);
const expanded = ref(depth.value <= defaultExpandedDepth.value);
const isContainer = computed(() => props.node.type === "object" || props.node.type === "array");

// 子节点按需折叠，避免大型 JSON 在详情面板里一次性渲染成过长列表。
function toggleExpanded(): void {
  if (!isContainer.value) {
    return;
  }
  expanded.value = !expanded.value;
}

function containerSummary(node: JsonTreeNode): string {
  return node.type === "array" ? `Array(${node.size})` : `Object(${node.size})`;
}
</script>

<template>
  <div class="json-tree-node" :style="{ '--json-depth': depth }" data-testid="json-tree-node">
    <div class="json-tree-row">
      <button
        v-if="isContainer"
        class="json-tree-toggle"
        type="button"
        :aria-expanded="expanded"
        :data-testid="`json-toggle-${node.path}`"
        @click="toggleExpanded"
      >
        {{ expanded ? "▾" : "▸" }}
      </button>
      <span v-else class="json-tree-toggle-placeholder"></span>
      <span class="json-tree-key" :title="node.path">{{ node.key }}</span>
      <span class="json-tree-colon">:</span>
      <span v-if="isContainer" class="json-tree-summary">{{ containerSummary(node) }}</span>
      <span v-else class="json-tree-value" :class="`is-${node.type}`">{{ formatJsonPrimitive(node.value) }}</span>
    </div>
    <div v-if="isContainer && expanded" class="json-tree-children">
      <JsonTreeView
        v-for="child in node.children"
        :key="child.path"
        :node="child"
        :depth="depth + 1"
        :default-expanded-depth="defaultExpandedDepth"
      />
    </div>
  </div>
</template>
