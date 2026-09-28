<script setup lang="ts">
/** A symbol frame: drills one parsed symbol (function/method/class/route/test/
 * component) at its fixed range, even when the symbol has no fragment. It
 * shows the source slice with the symbol range highlighted, the symbol's own
 * edges (calls / called-by / tested-by / decided_by) as clickable, and a jump
 * to the review fragment when one exists.
 *
 * Same-file edges are NOT swallowed: an edge to a symbol in this file opens
 * another symbol frame at its range instead of doing nothing. */
import { ref, computed, watch, onMounted } from "vue";
import {
  OmPanel,
  OmBadge,
  OmButton,
  OmCodeViewer,
  OmEmpty,
  type CodeRangeMark,
} from "@omem/ui";
import {
  codeSourceSlice,
  codeEdgesForFile,
  type CodeFile,
  type CodeSymbol,
  type CodeEdge,
} from "../review-api";
import { edgeDrillTarget, fileLabel, symbolLabel } from "./modules";

const props = defineProps<{
  symbolId: string;
  fileMap: Map<string, CodeFile>;
  symbolMap: Map<string, CodeSymbol>;
}>();

const emit = defineEmits<{
  drill: [
    target:
      | { type: "file"; fileId: string; line?: number }
      | { type: "symbol"; fileId: string; symbolId: string; line?: number }
      | { type: "fragment"; fragmentId: string; title?: string },
  ];
}>();

const symbol = computed<CodeSymbol | undefined>(() => props.symbolMap.get(props.symbolId));
const file = computed<CodeFile | undefined>(() =>
  symbol.value ? props.fileMap.get(symbol.value.fileId) : undefined,
);

const source = ref("");
const totalLines = ref(0);
const edges = ref<CodeEdge[]>([]);
const loading = ref(true);
const loadError = ref("");

async function load() {
  loading.value = true;
  loadError.value = "";
  try {
    if (!symbol.value || !file.value) throw Error("符号不在当前代码图中");
    const s = symbol.value;
    const f = file.value;
    // Fetch a window around the symbol (a few lines of context above/below).
    const start = Math.max(1, (s.rangeStart?.line ?? 1) - 6);
    const end = Math.max((s.rangeEnd?.line ?? s.rangeStart?.line ?? 1) + 6, start + 10);
    const [slice, ed] = await Promise.all([
      codeSourceSlice(f.fileId, start, end),
      codeEdgesForFile(f.fileId).catch(() => [] as CodeEdge[]),
    ]);
    source.value = slice.text;
    totalLines.value = slice.totalLines;
    edges.value = ed;
  } catch (e) {
    loadError.value = String(e);
  } finally {
    loading.value = false;
  }
}

watch(() => props.symbolId, () => void load());
onMounted(() => void load());

const rangeMark = computed<CodeRangeMark[]>(() => {
  if (!symbol.value?.rangeStart) return [];
  return [
    {
      start: symbol.value.rangeStart.line,
      end: symbol.value.rangeEnd?.line ?? symbol.value.rangeStart.line,
      id: symbol.value.symbolId,
      kind: symbol.value.kind,
      title: symbol.value.name,
    },
  ];
});

/** Edges that touch this symbol on either side. */
const myEdges = computed(() =>
  edges.value.filter(
    (e) => e.fromSymbolId === props.symbolId || e.toSymbolId === props.symbolId,
  ),
);

function drillEdge(e: CodeEdge) {
  const self = symbol.value?.fileId ?? "";
  const t = edgeDrillTarget(e, props.fileMap, props.symbolMap, self);
  if (t.kind === "file") emit("drill", { type: "file", fileId: t.fileId, line: t.line });
  else if (t.kind === "symbol") emit("drill", { type: "symbol", fileId: t.fileId, symbolId: t.symbolId, line: t.line });
}

function edgeDir(e: CodeEdge): "out" | "in" {
  return e.fromSymbolId === props.symbolId ? "out" : "in";
}

function edgeLabel(e: CodeEdge): string {
  const self = symbol.value?.fileId ?? "";
  const t = edgeDrillTarget(e, props.fileMap, props.symbolMap, self);
  if (t.kind === "file") {
    const f = props.fileMap.get(t.fileId);
    return (t.line ? `:${t.line} ` : "") + (f ? fileLabel(f) : "未命名文件");
  }
  if (t.kind === "symbol") {
    const s = props.symbolMap.get(t.symbolId);
    return `${s ? symbolLabel(s) : "未命名符号"}:${t.line}`;
  }
  return e.evidence || "外部包 / 未解析";
}

function edgeResolvable(e: CodeEdge): boolean {
  const self = symbol.value?.fileId ?? "";
  return edgeDrillTarget(e, props.fileMap, props.symbolMap, self).kind !== "none";
}

function openFragment() {
  if (symbol.value?.fragmentId)
    emit("drill", { type: "fragment", fragmentId: symbol.value.fragmentId, title: symbol.value.name });
}
</script>

<template>
  <div class="symbol-frame">
    <div v-if="loadError" class="error-banner" role="alert">
      符号加载失败：{{ loadError }}
      <OmButton variant="ghost" @click="load">重试</OmButton>
    </div>
    <div v-if="loading" class="muted">正在读取符号范围…</div>
    <template v-else-if="symbol && file">
      <small class="muted">{{ file.path }}</small>
      <div class="head">
        <h3>{{ symbol.name }}</h3>
        <div class="row">
          <OmBadge>{{ symbol.kind }}</OmBadge>
          <OmBadge>L{{ symbol.rangeStart?.line }}-{{ symbol.rangeEnd?.line }}</OmBadge>
          <OmBadge v-if="symbol.exported" tone="success">exported</OmBadge>
        </div>
      </div>
      <p v-if="symbol.signature" class="sig">{{ symbol.signature }}</p>

      <OmButton v-if="symbol.fragmentId" variant="ghost" class="frag-btn" @click="openFragment">
        查看对应决策/规则片段 →
      </OmButton>

      <OmCodeViewer :code="source" language="typescript" :ranges="rangeMark" />

      <h4>符号边 <small>{{ myEdges.length }}</small></h4>
      <p class="muted small">调用 / 被调用 / 测试 / 规则双向可走；同文件符号也打开范围帧。</p>
      <button
        v-for="e in myEdges.slice(0, 60)"
        :key="e.edgeId"
        class="edge-row"
        :class="{ disabled: !edgeResolvable(e) }"
        :disabled="!edgeResolvable(e)"
        @click="drillEdge(e)"
      >
        <OmBadge tone="neutral">{{ e.edgeKind }}</OmBadge>
        <span class="dir">{{ edgeDir(e) === "out" ? "→" : "←" }}</span>
        <span class="lbl">{{ edgeLabel(e) }}</span>
      </button>
      <OmEmpty v-if="!myEdges.length" title="该符号暂无登记边" />
    </template>
  </div>
</template>

<style scoped>
.symbol-frame { display: flex; flex-direction: column; gap: 10px; }
.muted { color: var(--om-secondary); }
.small { font-size: 12px; }
.head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.head h3 { margin: 0; font-family: ui-monospace, Consolas, monospace; }
.row { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.sig { font-family: ui-monospace, Consolas, monospace; font-size: 12px; color: var(--om-secondary); background: var(--om-soft); padding: 6px 8px; border-radius: 6px; }
.frag-btn { margin: 4px 0; align-self: flex-start; }
.error-banner { border: 1px solid #eccaca; background: #fff0f0; color: var(--om-danger); padding: 10px 12px; border-radius: 6px; }
h4 { margin: 12px 0 4px; }
.edge-row { display: flex; align-items: center; gap: 8px; padding: 5px 6px; border-bottom: 1px solid var(--om-line); width: 100%; text-align: left; background: transparent; border-left: 0; border-right: 0; border-top: 0; border-radius: 4px; }
.edge-row:hover:not(.disabled) { background: var(--om-soft); }
.edge-row.disabled { opacity: 0.5; cursor: default; }
.dir { color: var(--om-muted); }
.lbl { font-family: ui-monospace, Consolas, monospace; font-size: 12px; flex: 1; word-break: break-all; }
</style>
