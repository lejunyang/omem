<script setup lang="ts">
/** A module frame. Shows the hand-curated module-architect note (职责/边界/流程/
 * 入口出口/风险/unknowns/confidence/seed + clickable symbol & evidence refs),
 * then lists the files in the bucket. When no curated note exists it says so
 * honestly instead of inventing a summary — parser-derived counts are secondary. */
import { computed, ref, watch } from "vue";
import { OmPanel, OmBadge, OmEmpty, OmMarkdown, OmStatusLine } from "@omem/ui";
import KnowledgeDocument from "../knowledge/KnowledgeDocument.vue";
import { knowledgeApi, type ArticleMeta, type KnowledgeFrame } from "../knowledge/api";
import type { AggModule } from "./modules";
import { moduleLabel } from "./modules";
import type { CodeFile, CodeUnderstandingDetail } from "../review-api";

const props = defineProps<{
  mod: AggModule;
  detail: CodeUnderstandingDetail | null;
  loading?: boolean;
  symbolMap?: Map<string, { name: string }>;
}>();

const emit = defineEmits<{
  knowledge: [frame: KnowledgeFrame];
  drill: [
    target:
      | { type: "file"; fileId: string }
      | { type: "symbol"; fileId: string; symbolId: string }
      | { type: "fragment"; fragmentId: string; title?: string },
  ];
}>();

const knowledge = ref<ArticleMeta | null>(null);
watch(() => props.mod.id, async (id) => { knowledge.value = null; try { knowledge.value = await knowledgeApi<ArticleMeta>("/api/review/knowledge", "/articles/" + encodeURIComponent("module:" + id)); } catch {} }, { immediate: true });

const grouped = computed(() => {
  const byLang = new Map<string, CodeFile[]>();
  for (const f of props.mod.files) {
    const arr = byLang.get(f.language) ?? [];
    arr.push(f);
    byLang.set(f.language, arr);
  }
  return [...byLang.entries()].sort((a, b) => b[1].length - a[1].length);
});

const out = computed(() => props.detail?.output ?? null);

/** Node refs are symbol ids (sym_*); evidence refs are fragment ids (ev_*). */
const nodeRefs = computed(() => (props.detail?.refs ?? []).filter((r) => r.kind === "node"));
const evidenceRefs = computed(() => (props.detail?.refs ?? []).filter((r) => r.kind === "evidence"));

/** Never show a raw sym_* id. Prefer the resolved symbol name, then the curated note. */
function nodeLabel(r: { id: string; note?: string }): string {
  const nm = props.symbolMap?.get(r.id)?.name;
  return nm || r.note || "符号";
}

function openNodeRef(ref: { id: string }) {
  // Resolve the symbol's owning file via the graph is the parent's job; we only
  // emit the symbolId and let CodeWiki look it up. Parent maps symbolId->fileId.
  emit("drill", { type: "symbol", fileId: "", symbolId: ref.id });
}

function confLabel(c: number | null | undefined): string {
  if (c == null) return "?";
  return Math.round(c * 100) + "%";
}
</script>

<template>
  <div class="module-frame">
    <h2>{{ moduleLabel(mod.id) }}</h2>
    <p class="muted">{{ mod.fileCount }} 个文件 · {{ mod.symbolCount }} 个解析符号</p>

    <KnowledgeDocument v-if="knowledge" prefix="/api/review/knowledge" :document-key="knowledge.key" :revision="knowledge.revision" @navigate="emit('knowledge', $event)" />
    <div v-else-if="loading" class="muted">正在读取模块说明…</div>

    <OmEmpty
      v-else-if="!detail || !out"
      title="该模块暂无已保存的说明"
      description="可先浏览文件和原始证据；生成或整理说明后会显示在这里。"
    />

    <template v-else>
      <p class="muted">说明范围：{{ detail.targetId }}</p>
      <OmStatusLine
        :kind="detail.seed ? 'seed' : 'derived'"
        :source-note="detail.seed ? '人工整理的模块说明' : '模型派生说明 · 未经独立语义复核'"
      />
      <div class="row badges">
        <OmBadge :tone="detail.seed ? 'neutral' : 'success'">
          {{ detail.seed ? "人工整理" : "模型生成" }}
        </OmBadge>
        <OmBadge tone="warning" v-if="detail.stale">已过期</OmBadge>
        <OmBadge v-if="!detail.seed && detail.model">{{ detail.model }}</OmBadge>
        <OmBadge v-if="detail.curatedBy">by {{ detail.curatedBy }}</OmBadge>
      </div>

      <OmPanel title="职责" class="stack">
        <li v-for="(r, i) in out!.module_responsibilities" :key="i">{{ r }}</li>
        <OmEmpty v-if="!out!.module_responsibilities.length" title="未登记职责" />
      </OmPanel>

      <OmPanel title="边界" class="stack">
        <li v-for="(r, i) in out!.boundaries" :key="i">{{ r }}</li>
      </OmPanel>

      <OmPanel title="关键流程" class="stack">
        <div v-for="(fl, i) in out!.key_flows" :key="i" class="flow">
          <b>{{ fl.name }}</b>
          <p class="muted">{{ fl.description }}</p>
        </div>
        <OmEmpty v-if="!out!.key_flows.length" title="未登记关键流程" />
      </OmPanel>

      <div class="two-col">
        <OmPanel title="入口" class="stack">
          <li v-for="(e, i) in out!.entry_points" :key="i" class="mono">{{ e }}</li>
        </OmPanel>
        <OmPanel title="出口" class="stack">
          <li v-for="(e, i) in out!.exit_points" :key="i" class="mono">{{ e }}</li>
        </OmPanel>
      </div>

      <OmPanel title="风险与限制" class="stack">
        <li v-for="(r, i) in out!.risks_and_limits" :key="i">{{ r }}</li>
      </OmPanel>

      <OmPanel title="未决问题" class="stack">
        <li v-for="(u, i) in detail.unknowns" :key="i">{{ u }}</li>
      </OmPanel>

      <OmPanel title="证据引用（可下探）" class="stack">
        <div v-if="nodeRefs.length || evidenceRefs.length">
          <button
            v-for="r in nodeRefs"
            :key="'n' + r.id"
            class="ref-row"
            @click="openNodeRef(r)"
          >
            <OmBadge tone="neutral">符号</OmBadge>
            <span class="sym-name">{{ nodeLabel(r) }}</span>
          </button>
          <div
            v-for="r in evidenceRefs"
            :key="'e' + r.id"
            class="ref-row static"
          >
            <OmBadge tone="warning">证据</OmBadge>
            <small class="ev-note">{{ r.note || "证据引用" }}</small>
          </div>
        </div>
        <OmEmpty v-else title="无登记引用" />
      </OmPanel>
    </template>

    <h4 style="margin-top:14px">文件</h4>
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
.module-frame { display: flex; flex-direction: column; gap: 8px; }
.muted { color: var(--om-secondary); }
.stack { margin-bottom: 8px; }
.badges { margin: 4px 0; }
.flow { margin-bottom: 6px; }
.two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.mono { font-family: ui-monospace, Consolas, monospace; font-size: 12px; }
.file-row { display: flex; align-items: baseline; gap: 10px; width: 100%; text-align: left; background: transparent; border: 0; border-bottom: 1px solid var(--om-line); padding: 6px 2px; }
.file-row:hover { background: var(--om-soft); }
.path { font-weight: 600; font-size: 13px; }
small { font-family: ui-monospace, Consolas, monospace; font-size: 11px; color: var(--om-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ref-row { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; background: transparent; border: 0; border-bottom: 1px solid var(--om-line); padding: 4px 2px; }
.ref-row:hover { background: var(--om-soft); }
.ref-row .mono { flex: 1; }
.sym-name { flex: 1; font-weight: 500; font-family: ui-monospace, Consolas, monospace; font-size:13px; }
.ref-row.static { cursor: default; }
.ev-note { font-size: 11px; color: var(--om-muted); }
@media (max-width: 700px) { .two-col { grid-template-columns: 1fr; } }
</style>
