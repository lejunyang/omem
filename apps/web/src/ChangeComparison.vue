<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { structuredPatch } from "diff";
import { api } from "./api";
const props = defineProps<{ changeId: string }>();
type Snapshot = { title: string; version: string; text: string };
const content = ref<{ before: Snapshot | null; after: Snapshot | null; hasBefore: boolean }>();
const error = ref("");
watch(() => props.changeId, async id => {
  content.value = undefined; error.value = "";
  try { content.value = await api(`/changes/${encodeURIComponent(id)}/content`); }
  catch (e) { error.value = String(e); }
}, { immediate: true });
const patch = computed(() => content.value?.after ? structuredPatch("之前", "之后", content.value.before?.text ?? "", content.value.after.text, "", "", { context: 3 }) : null);
</script>
<template>
  <section class="change-comparison" aria-label="内容差异">
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-else-if="!content" role="status">正在读取固定版本…</p>
    <p v-else-if="!content.after || (content.hasBefore && !content.before)" class="muted">这条历史记录没有保存可比较的完整版本关联，无法还原差异。</p>
    <template v-else>
      <p>{{ content.before?.version ?? '首次保存' }} → {{ content.after.version }} · − 删除 / ＋ 新增（保留上下文）</p>
      <p v-if="!patch?.hunks.length" class="muted">正文与引用没有文字差异；本次更新的是复核或来源记录。</p>
      <div v-for="(hunk, i) in patch?.hunks ?? []" :key="i" class="diff-hunk">
        <header>原 {{ hunk.oldStart }} 行 → 新 {{ hunk.newStart }} 行</header>
        <pre v-for="(line, j) in hunk.lines" :key="j" :class="{ added: line.startsWith('+'), removed: line.startsWith('-') }">{{ line }}</pre>
      </div>
    </template>
  </section>
</template>
<style scoped>
.change-comparison{min-width:0;margin:16px 0;}.diff-hunk{border:1px solid var(--om-line);border-radius:6px;overflow:auto;margin:12px 0;max-height:600px;}.diff-hunk header{font-size:12px;padding:8px 12px;background:var(--om-soft);position:sticky;top:0;}.diff-hunk pre{margin:0;padding:2px 12px;font:12px/1.7 ui-monospace,monospace;white-space:pre-wrap;overflow-wrap:anywhere;}.added{background:#eef4ef;}.removed{background:#faeeee;}
</style>
