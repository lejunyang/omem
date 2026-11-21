<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { get } from "../api";
import SetCard from "./SetCard.vue";
import MonoLine from "./MonoLine.vue";

/**
 * 设置 → 采集 → 其他平台 → 能读的格式（插件）: the source parsers plugins registered
 * (`GET /api/sources/parsers`, src/plugins/formats.ts), one line each. None: the card is not there.
 */
type Parser = { id: string; label: string; plugin: string; version: string | null; match: { extensions?: string[]; mimeTypes?: string[]; urlPatterns?: string[] }; lastError: string | null };
const list = ref<Parser[] | null>(null);
onMounted(async () => {
  try {
    list.value = await get<Parser[]>("/api/sources/parsers");
  } catch {
    list.value = [];
  }
});
/** What a parser takes, shortest first: extensions, then types, then addresses. */
function takes(p: Parser) {
  return [...(p.match.extensions ?? []).map((e) => "." + e.replace(/^\./, "")), ...(p.match.mimeTypes ?? []), ...(p.match.urlPatterns ?? [])].join("  ");
}
const shown = computed(() => list.value ?? []);
</script>

<template>
  <SetCard v-if="shown.length" id="set-source-parsers" title="能读的格式（插件）">
    <template #help>保存或导入这些格式的文件和地址时，由插件读成正文；插件停用后已有的原件照常能读。</template>
    <div v-for="p in shown" :key="p.id" class="sp-row">
      <div class="sp-main">
        <div class="sp-name"><span>{{ p.label }}</span><span class="sp-from">来自 {{ p.plugin }}<template v-if="p.version"> · {{ p.version }}</template></span></div>
        <MonoLine class="sp-takes" :text="takes(p)" />
        <div v-if="p.lastError" class="sp-err" :title="p.lastError">上一次读失败：{{ p.lastError }}</div>
      </div>
    </div>
  </SetCard>
</template>

<style scoped>
.sp-row { padding: 8px 18px; border-top: 1px solid var(--line); min-width: 0; }
.sp-main { display: grid; gap: 4px; min-width: 0; }
.sp-name { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; font-size: 14px; min-width: 0; }
.sp-from { font-size: 12px; color: var(--muted); }
.sp-takes { font-size: 12px; color: var(--ink-2); min-width: 0; }
.sp-err { font-size: 13px; color: var(--danger); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
@media (max-width: 640px) {
  .sp-row { padding: 8px 14px; }
}
</style>
