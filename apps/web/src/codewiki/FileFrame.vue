<script setup lang="ts">
/** A file detail frame: source viewer with line numbers + on-demand hljs, an
 * outline of parsed symbols, the incoming/outgoing edges (imports/calls/route/
 * test/component), and the deterministic "derived" understanding. It never fakes
 * a model summary: when confidence is null and model is null it says so. */
import { ref, watch, onMounted } from "vue";
import {
  OmPanel,
  OmBadge,
  OmButton,
  OmCodeViewer,
  OmEmpty,
  OmStatusLine,
  type CodeRangeMark,
} from "@omem/ui";
import {
  codeSourceFull,
  codeSymbolsOfFile,
  codeEdgesForFile,
  codeUnderstandingFile,
  type CodeFile,
  type CodeSymbol,
  type CodeEdge,
  type CodeUnderstanding,
} from "../review-api";
import { outlineSymbols } from "./modules";

const props = defineProps<{ file: CodeFile; anchorLine?: number }>();

const emit = defineEmits<{
  drill: [
    target:
      | { type: "file"; fileId: string; line?: number }
      | { type: "fragment"; fragmentId: string; title?: string },
  ];
}>();

const source = ref("");
const totalLines = ref(0);
const symbols = ref<CodeSymbol[]>([]);
const edges = ref<CodeEdge[]>([]);
const understanding = ref<CodeUnderstanding | null>(null);
const loading = ref(true);
const loadError = ref("");
const showEdges = ref(true);

const byId = new Map<string, CodeFile>(); // populated by parent via register? No — we resolve imports locally.

async function load() {
  loading.value = true;
  loadError.value = "";
  try {
    const [src, syms, ed, un] = await Promise.all([
      codeSourceFull(props.file.fileId),
      codeSymbolsOfFile(props.file.fileId).catch(() => []),
      codeEdgesForFile(props.file.fileId).catch(() => []),
      codeUnderstandingFile(props.file.fileId).catch(() => ({ understanding: null })),
    ]);
    source.value = src.text;
    totalLines.value = src.totalLines;
    symbols.value = syms;
    edges.value = ed;
    understanding.value = un.understanding;
  } catch (e) {
    loadError.value = String(e);
  } finally {
    loading.value = false;
  }
}

watch(() => props.file.fileId, () => void load());
onMounted(() => void load());

function langFor(path: string): string {
  if (path.endsWith(".vue")) return "vue";
  if (path.endsWith(".ts")) return "typescript";
  if (path.endsWith(".tsx")) return "tsx";
  if (path.endsWith(".md")) return "markdown";
  if (path.endsWith(".json")) return "json";
  return "typescript";
}

/** Symbols become clickable range marks on the gutter. */
const ranges = ref<CodeRangeMark[]>([]);
watch(symbols, (syms) => {
  ranges.value = outlineSymbols(syms).map((s) => ({
    start: s.rangeStart?.line ?? 0,
    end: s.rangeEnd?.line ?? s.rangeStart?.line ?? 0,
    id: s.symbolId,
    kind: s.kind,
    title: s.name,
  }));
});

function onCodeNavigate(t: { filePath?: string; symbol?: string; line?: number }) {
  if (t.line) {
    // clicking a range mark: jump to the symbol's declared fragment trail
    const sym = symbols.value.find(
      (s) => (s.rangeStart?.line ?? -1) === t.line,
    );
    if (sym?.fragmentId)
      emit("drill", { type: "fragment", fragmentId: sym.fragmentId, title: sym.name });
  }
}

function jumpToSymbol(s: CodeSymbol) {
  // scroll the code viewer to the symbol's declaration line
  anchor.value = s.rangeStart?.line;
  if (s.fragmentId)
    emit("drill", { type: "fragment", fragmentId: s.fragmentId, title: s.name });
}

const anchor = ref<number | undefined>(props.anchorLine);

const OUTGOING_KINDS = new Set(["imports", "defines", "route", "uses_component"]);
const outgoingEdges = () => edges.value.filter((e) => OUTGOING_KINDS.has(e.edgeKind));
const otherEdges = () => edges.value.filter((e) => !OUTGOING_KINDS.has(e.edgeKind));

function statusTone(s: CodeEdge["status"]) {
  if (s === "confirmed") return "success" as const;
  if (s === "candidate") return "warning" as const;
  if (s === "stale") return "neutral" as const;
  return "neutral" as const;
}
function statusLabel(s: CodeEdge["status"]) {
  if (s === "confirmed") return "已解析";
  if (s === "candidate") return "候选";
  if (s === "stale") return "已过期";
  return "外部包";
}

interface ParsedUnderstanding {
  language?: string;
  symbolCount?: number;
  importCount?: number;
}
function parsedUnderstanding(): ParsedUnderstanding {
  try {
    return understanding.value ? (JSON.parse(understanding.value.outputJson) as ParsedUnderstanding) : {};
  } catch {
    return {};
  }
}
</script>

<template>
  <div class="file-frame">
    <div class="head">
      <small class="path">{{ file.path }}</small>
      <div class="row">
        <OmBadge>{{ file.language }}</OmBadge>
        <OmBadge>{{ totalLines }} 行</OmBadge>
        <OmBadge v-if="file.removed" tone="danger">已删除</OmBadge>
      </div>
    </div>

    <div v-if="loadError" class="error-banner" role="alert">
      加载失败：{{ loadError }}
      <OmButton variant="ghost" @click="load">重试</OmButton>
    </div>
    <div v-if="loading" class="muted">正在读取源码与符号…</div>

    <template v-else-if="!loadError">
      <!-- derived understanding -->
      <OmPanel v-if="understanding" title="派生说明（确定性解析）" class="stack">
        <OmStatusLine kind="derived" sourceNote="来自解析器，非模型摘要" />
        <p class="muted">
          语言 {{ parsedUnderstanding().language ?? "?" }} · {{ parsedUnderstanding().symbolCount ?? symbols.length }} 个符号 ·
          {{ parsedUnderstanding().importCount ?? 0 }} 条 import。
        </p>
        <p v-if="understanding.unknowns?.length" class="muted">
          <b>未决问题：</b>
          <li v-for="(u, i) in understanding.unknowns" :key="i">{{ u }}</li>
        </p>
        <p class="muted">
          <template v-if="understanding.model">模型 {{ understanding.model }} · 置信度 {{ understanding.confidence }}</template>
          <template v-else><OmBadge tone="neutral">未配置模型 · 无 AI 摘要</OmBadge></template>
        </p>
      </OmPanel>

      <!-- source -->
      <OmStatusLine kind="raw" sourceNote="仓库当前快照原文，不可变" />
      <OmCodeViewer
        :code="source"
        :language="langFor(file.path)"
        :anchor-line="anchor"
        :ranges="ranges"
        @navigate="onCodeNavigate"
      />

      <!-- symbol outline -->
      <h4>符号大纲 <small>{{ outlineSymbols(symbols).length }}</small></h4>
      <div class="sym-outline">
        <button
          v-for="s in outlineSymbols(symbols)"
          :key="s.symbolId"
          class="sym-row"
          @click="jumpToSymbol(s)"
        >
          <span class="sym-kind">{{ s.kind }}</span>
          <span class="sym-name">{{ s.name }}</span>
          <small>:{{ s.rangeStart?.line }}</small>
        </button>
      </div>

      <!-- edges -->
      <h4>边（import / route / test / 组件） <small>{{ edges.length }}</small></h4>
      <p class="muted small">
        calls 为同文件按名称匹配（候选，非精确调用点）；imports 指向本仓库文件可下探，外部包不可下探。
      </p>
      <div v-for="e in outgoingEdges().slice(0, 40)" :key="e.edgeId" class="edge-row">
        <OmBadge :tone="statusTone(e.status)">{{ e.edgeKind }}</OmBadge>
        <span class="edge-evidence">{{ e.evidence || "—" }}</span>
        <OmBadge v-if="e.status !== 'confirmed'" tone="neutral">{{ statusLabel(e.status) }}</OmBadge>
      </div>
      <div v-if="!edges.length" class="muted">暂无解析出的边。</div>
    </template>
  </div>
</template>

<style scoped>
.file-frame {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.head {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.path {
  font-family: ui-monospace, Consolas, monospace;
  font-size: 12px;
  color: var(--om-muted);
  word-break: break-all;
}
.row {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.error-banner {
  border: 1px solid #eccaca;
  background: #fff0f0;
  color: var(--om-danger);
  padding: 10px 12px;
  border-radius: 6px;
  display: flex;
  align-items: center;
  gap: 10px;
}
.muted {
  color: var(--om-secondary);
}
.small {
  font-size: 12px;
}
.stack {
  margin-bottom: 10px;
}
h4 {
  margin: 12px 0 4px;
}
.sym-outline {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.sym-row {
  display: flex;
  gap: 8px;
  align-items: center;
  border: 1px solid transparent;
  background: transparent;
  text-align: left;
  padding: 3px 6px;
  border-radius: 4px;
  font-family: ui-monospace, Consolas, monospace;
  font-size: 12.5px;
}
.sym-row:hover {
  background: var(--om-soft);
  border-color: var(--om-line);
}
.sym-kind {
  font-size: 10px;
  color: var(--om-muted);
  width: 60px;
}
.sym-name {
  flex: 1;
}
.edge-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 0;
  border-bottom: 1px solid var(--om-line);
}
.edge-evidence {
  font-family: ui-monospace, Consolas, monospace;
  font-size: 12px;
  word-break: break-all;
}
</style>
