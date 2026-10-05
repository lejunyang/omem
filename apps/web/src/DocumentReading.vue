<script setup lang="ts">
import { ref, watch } from "vue";
import { OmButton, OmMarkdown } from "@omem/ui";
import { api, headers, type Revision } from "./api";
import AssetImage from "./AssetImage.vue";
const props = defineProps<{ revisionId: string; document: NonNullable<Revision["context"]["document"]>; fallback: string }>();
type Block = { ref: string; label: string; level: number; headingLevel?: number; text: string; imageAssetId?: string; provenance: { page_no: number }[] };
const blocks = ref<Block[]>([]), error = ref(""), loading = ref(false);
let generation = 0;
watch(() => props.revisionId, async () => {
  const current = ++generation; blocks.value = []; error.value = "";
  if (props.document.parser !== "docling") return;
  loading.value = true;
  try {
    const result = await api<{ blocks: Block[]; document?: { texts?: { self_ref: string; level?: number }[] } }>(`/revisions/${props.revisionId}/document/structure`);
    if (current === generation) blocks.value = result.blocks.map(block => ({ ...block,
      headingLevel: block.headingLevel ?? result.document?.texts?.find(item => item.self_ref === block.ref)?.level,
    }));
  } catch (e) { if (current === generation) error.value = String(e); }
  finally { if (current === generation) loading.value = false; }
}, { immediate: true });
async function original() {
  try {
    const response = await fetch(`/api/revisions/${props.revisionId}/document/original`, { headers: headers() });
    if (!response.ok) throw Error("原件读取失败");
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement("a"); link.href = url; link.download = props.document.originalName; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  } catch (e) { error.value = String(e); }
}
function text(block: Block) {
  if (block.label === "title") return "# " + block.text;
  if (block.label === "section_header") return "#".repeat(Math.min(6, Math.max(2, (block.headingLevel ?? 1) + 1))) + " " + block.text;
  if (block.label === "list_item") return "- " + block.text;
  return block.text;
}
</script>
<template>
  <section class="document-reading" :aria-busy="loading">
    <div class="document-actions"><span class="muted">{{ document.pageCount ? `${document.pageCount} 页 · ` : '' }}已保留原件与文档结构</span><OmButton variant="secondary" @click="original">{{ document.parser === 'lark-cli' ? '下载飞书原始数据' : '下载原件' }}</OmButton></div>
    <p v-for="warning in document.warnings" :key="warning" class="muted">{{ warning }}</p>
    <p v-if="error" role="status">{{ error }} · 以下仍可阅读已保存正文。</p>
    <p v-if="loading" role="status">正在读取文档结构…</p>
    <template v-if="blocks.length">
      <section v-for="block in blocks" :key="block.ref" class="document-block">
        <small v-if="block.provenance[0]" class="page-marker">第 {{ block.provenance[0].page_no }} 页</small>
        <OmMarkdown v-if="block.text" :source="text(block)" />
        <AssetImage v-if="block.imageAssetId" :id="block.imageAssetId" label="原文插图" :path="`/api/revisions/${revisionId}/document/${block.imageAssetId}`" />
      </section>
    </template>
    <OmMarkdown v-else :source="fallback" />
  </section>
</template>
<style scoped>
.document-reading{max-width:820px;min-width:0}.document-actions{display:flex;align-items:center;gap:16px;flex-wrap:wrap;margin:16px 0 24px}.document-block{margin:20px 0}.page-marker{display:block;color:var(--om-muted);font-size:12px;margin-bottom:8px}
</style>
