<script setup lang="ts">
import { STATUS_LABEL, type DiffMeta } from "../lib/patch";

/** A changed file's name in a diff header: what happened to it (新增 / 删除 / 移动 / 复制, 二进制), and where a moved file came from (after the name, so a long path cuts off the old one). */
defineProps<{ file: Pick<DiffMeta, "name" | "oldName" | "status" | "binary">; prefix?: string }>();
</script>

<template>
  <span class="dname" :title="file.oldName ? `${file.oldName} → ${file.name}` : file.name">
    <span v-if="STATUS_LABEL[file.status]" class="st" :class="file.status">{{ STATUS_LABEL[file.status] }}</span>
    <span v-if="file.binary" class="st bin">二进制</span>
    <span class="path">{{ prefix }}{{ file.name }}<span v-if="file.oldName" class="old"> ← {{ file.oldName }}</span></span>
  </span>
</template>

<style scoped>
.dname { display: inline-flex; align-items: center; gap: 6px; min-width: 0; flex: 1; }
.path { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.old { color: var(--muted); }
.st { flex: none; font: 600 11px/1 var(--sans); padding: 3px 6px; border-radius: 5px; background: var(--hover); color: var(--ink-2); }
.st.added { background: var(--ok-soft); color: var(--ok); }
.st.deleted { background: var(--danger-soft); color: var(--danger); }
.st.renamed, .st.copied { background: var(--accent-soft); color: var(--accent); }
</style>
