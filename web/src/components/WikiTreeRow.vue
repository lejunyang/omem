<script setup lang="ts">
import type { NavRow } from "../lib/wikiTree";
import Icon from "./Icon.vue";

defineProps<{ row: NavRow; space: string; current: string }>();
const emit = defineEmits<{ toggle: [folder: string]; navigate: [] }>();
</script>

<template>
  <div class="row" :style="{ paddingLeft: `${6 + row.depth * 14}px` }" role="treeitem" :aria-expanded="row.isFolder ? row.open : undefined">
    <template v-if="row.isFolder">
      <button type="button" class="chev" :aria-label="row.open ? '折叠' : '展开'" @click="emit('toggle', row.node.folder!)"><Icon :name="row.open ? 'down' : 'right'" :size="13" /></button>
      <router-link v-if="row.node.slug" :to="`/wiki/${space}/${row.node.slug}`" class="node folder" :class="{ on: row.node.slug === current }" @click="emit('navigate')">{{ row.node.title }}</router-link>
      <button v-else type="button" class="node folder" @click="emit('toggle', row.node.folder!)">{{ row.node.title }}</button>
      <span v-if="row.node.stale" class="dot" :title="`${row.node.stale} 页引用的原件已变化`" />
      <span class="count">{{ row.node.count }}</span>
    </template>
    <template v-else>
      <span class="chev" />
      <router-link :to="`/wiki/${space}/${row.node.slug}`" class="node" :class="{ on: row.node.slug === current }" @click="emit('navigate')">{{ row.node.title }}</router-link>
      <span v-if="row.node.stale" class="dot" title="引用的原件已变化" />
    </template>
  </div>
</template>

<style scoped>
.row {
  display: flex;
  align-items: flex-start;
  gap: 2px;
  min-width: 0;
  border-radius: 6px;
}
.row:hover {
  background: var(--hover);
}
.chev {
  flex: none;
  width: 20px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  background: none;
  color: var(--muted);
  cursor: pointer;
  padding: 0;
}
.node {
  flex: 1;
  min-width: 0;
  display: block;
  text-align: left;
  border: 0;
  background: none;
  padding: 5px 4px;
  color: var(--ink-2);
  font: inherit;
  font-size: 13.5px;
  line-height: 1.45;
  cursor: pointer;
  overflow-wrap: anywhere;
  border-radius: 6px;
}
.node:hover {
  text-decoration: none;
}
.node.folder {
  font-weight: 600;
  color: var(--ink);
}
.node.on {
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 600;
}
.count {
  flex: none;
  align-self: center;
  font-size: 11.5px;
  color: var(--muted);
  padding: 0 6px;
  font-variant-numeric: tabular-nums;
}
.dot {
  flex: none;
  align-self: center;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  margin-right: 2px;
  background: var(--warn);
}
</style>
