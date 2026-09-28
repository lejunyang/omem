<script setup lang="ts">
/** A module frame: lists the files in a module bucket and drills into one. */
import { computed } from "vue";
import { OmPanel, OmBadge, OmEmpty } from "@omem/ui";
import type { AggModule } from "./modules";
import { moduleLabel } from "./modules";
import type { CodeFile } from "../review-api";

const props = defineProps<{ mod: AggModule }>();
const emit = defineEmits<{ drill: [target: { type: "file"; fileId: string }] }>();

const grouped = computed(() => {
  const byLang = new Map<string, CodeFile[]>();
  for (const f of props.mod.files) {
    const arr = byLang.get(f.language) ?? [];
    arr.push(f);
    byLang.set(f.language, arr);
  }
  return [...byLang.entries()].sort((a, b) => b[1].length - a[1].length);
});
</script>

<template>
  <div class="module-frame">
    <h2>{{ moduleLabel(mod.id) }}</h2>
    <p class="muted">{{ mod.fileCount }} 个文件 · {{ mod.symbolCount }} 个解析出的符号</p>
    <OmEmpty v-if="!mod.files.length" title="该模块暂无文件" />
    <OmPanel v-for="[lang, files] in grouped" :key="lang" :title="lang" class="stack">
      <button
        v-for="f in files"
        :key="f.fileId"
        class="file-row"
        @click="emit('drill', { type: 'file', fileId: f.fileId })"
      >
        <span class="path">{{ f.path.split("/").pop() }}</span>
        <small>{{ f.path }}</small>
        <OmBadge v-if="f.removed" tone="danger">已删除</OmBadge>
      </button>
    </OmPanel>
  </div>
</template>

<style scoped>
.module-frame {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.muted {
  color: var(--om-secondary);
}
.stack {
  margin-bottom: 8px;
}
.file-row {
  display: flex;
  align-items: baseline;
  gap: 10px;
  width: 100%;
  text-align: left;
  background: transparent;
  border: 0;
  border-bottom: 1px solid var(--om-line);
  padding: 6px 2px;
}
.file-row:hover {
  background: var(--om-soft);
}
.path {
  font-weight: 600;
  font-size: 13px;
  flex-shrink: 0;
}
small {
  font-family: ui-monospace, Consolas, monospace;
  font-size: 11px;
  color: var(--om-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
