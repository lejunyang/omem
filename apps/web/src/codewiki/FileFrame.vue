<script setup lang="ts">
/** A file detail frame: source viewer with line numbers + on-demand hljs, an
 * outline of parsed symbols, every navigable edge (imports/calls/route/test/
 * component), and the deterministic "derived" understanding. It never fakes a
 * model summary: when confidence is null and model is null it says so.
 *
 * Edge navigation: any edge that resolves to an in-repo file/symbol is a
 * button that pushes a new trail frame. External packages / unresolved targets
 * stay non-interactive and are labeled honestly. */
import { ref, computed, watch, onMounted } from "vue";
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
import { outlineSymbols, edgeDrillTarget, fileLabel, filePathLabel, symbolLabel, edgeReason, edgeDisabled } from "./modules";

const props = defineProps<{
  file: CodeFile;
  anchorLine?: number;
  fileMap?: Map<string, CodeFile>;
  symbolMap?: Map<string, CodeSymbol>;
}>();

const emit = defineEmits<{
  drill: [
    target:
      | { type: "file"; fileId: string; line?: number }
      | { type: "symbol"; fileId: string; symbolId: string; line?: number }
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

const anchor = ref<number | undefined>(props.anchorLine);

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
  if (!t.line) return;
  const sym = symbols.value.find((s) => (s.rangeStart?.line ?? -1) === t.line);
  if (sym) openSymbol(sym);
}

/** Always opens a symbol/range frame (fixed range), even when the symbol has no
 * fragment — never silently no-ops on a same-file self target. */
function openSymbol(s: CodeSymbol) {
  anchor.value = s.rangeStart?.line;
  emit("drill", { type: "symbol", fileId: props.file.fileId, symbolId: s.symbolId, line: s.rangeStart?.line });
}

// ---- edge resolution ----
interface ResolvedEdge {
  edge: CodeEdge;
  drill: ReturnType<typeof edgeDrillTarget>;
  targetFile?: CodeFile;
  targetSymbolName?: string;
  resolvable: boolean;
  direction: "out" | "in";
}

const resolvedEdges = computed<ResolvedEdge[]>(() =>
  edges.value.map((e) => {
    const drill = edgeDrillTarget(e, props.fileMap ?? new Map(), props.symbolMap ?? new Map(), props.file.fileId);
    const direction = e.fromFileId === props.file.fileId || e.fromSymbolId == null ? "out" : "in";
    let targetFile: CodeFile | undefined;
    let targetSymbolName: string | undefined;
    if (drill.kind === "file") targetFile = props.fileMap?.get(drill.fileId);
    else if (drill.kind === "symbol") {
      targetFile = props.fileMap?.get(drill.fileId);
      targetSymbolName = props.symbolMap?.get(drill.symbolId)?.name;
    }
    return { edge: e, drill, targetFile, targetSymbolName, resolvable: drill.kind !== "none", direction };
  }),
);

function openEdge(re: ResolvedEdge) {
  if (re.drill.kind === "file") emit("drill", { type: "file", fileId: re.drill.fileId, line: re.drill.line });
  else if (re.drill.kind === "symbol") emit("drill", { type: "symbol", fileId: re.drill.fileId, symbolId: re.drill.symbolId, line: re.drill.line });
}

function targetLabel(re: ResolvedEdge): string {
  if (re.edge.displayTitle) return re.edge.displayTitle;
  if (re.targetSymbolName) {
    const line = re.drill.kind === "symbol" ? re.drill.line : re.drill.kind === "file" ? re.drill.line : undefined;
    return line ? `${re.targetSymbolName}:${line}` : re.targetSymbolName;
  }
  if (re.targetFile) return fileLabel(re.targetFile);
  return re.edge.summary || re.edge.evidence || "未解析";
}

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
  if (s === "missing") return "仓库内未解析";
  return "外部包";
}

/** Human label for an edge kind; never exposes the raw enum to the user. */
const EDGE_WORD: Record<string, string> = {
  imports: "导入", calls: "调用", called_by: "被调用", route: "路由",
  test_of: "测试", tested_by: "测试覆盖", uses_component: "组件",
  implements: "实现", requires: "依赖", decided_by: "决策依据",
  researched_by: "调研依据", defines: "定义",
};
function edgeWord(kind: string) {
  return EDGE_WORD[kind] || "关联";
}

const NAV_KINDS = new Set(["imports", "calls", "route", "test_of", "uses_component", "implements", "requires", "decided_by", "researched_by", "tested_by"]);
const navEdges = computed(() => resolvedEdges.value.filter((r) => NAV_KINDS.has(r.edge.edgeKind)));
const otherEdges = computed(() => resolvedEdges.value.filter((r) => !NAV_KINDS.has(r.edge.edgeKind)));

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
      <small class="path">{{ filePathLabel(file) }}</small>
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

      <OmStatusLine kind="raw" sourceNote="仓库当前快照原文，不可变" />
      <OmCodeViewer
        :code="source"
        :language="langFor(file.path)"
        :anchor-line="anchor"
        :ranges="ranges"
        @navigate="onCodeNavigate"
      />

      <h4>符号大纲 <small>{{ outlineSymbols(symbols).length }}</small></h4>
      <div class="sym-outline">
        <button
          v-for="s in outlineSymbols(symbols)"
          :key="s.symbolId"
          class="sym-row"
          @click="openSymbol(s)"
        >
          <span class="sym-kind">{{ s.kind }}</span>
          <span class="sym-name">{{ symbolLabel(s) }}</span>
          <small>:{{ s.rangeStart?.line }}</small>
        </button>
      </div>

      <h4>可下探的边 <small>{{ navEdges.length }}</small></h4>
      <p class="muted small">
        点行内任意边下跳到目标文件/符号；外部包或未解析目标标灰不可点。
      </p>
      <button
        v-for="re in navEdges.slice(0, 60)"
        :key="re.edge.edgeId"
        class="edge-row"
        :class="{ disabled: !re.resolvable || edgeDisabled(re.edge) }"
        :disabled="!re.resolvable || edgeDisabled(re.edge)"
        :title="edgeReason(re.edge) ?? undefined"
        @click="openEdge(re)"
      >
        <OmBadge :tone="statusTone(re.edge.status)">{{ edgeWord(re.edge.edgeKind) }}</OmBadge>
        <span class="dir">{{ re.direction === "out" ? "→" : "←" }}</span>
        <span class="edge-evidence">{{ targetLabel(re) }}</span>
        <small v-if="!re.resolvable || edgeDisabled(re.edge)" class="why">{{ edgeReason(re.edge) ?? "不可下探" }}</small>
        <OmBadge v-else-if="re.edge.status !== 'confirmed'" tone="neutral">{{ statusLabel(re.edge.status) }}</OmBadge>
      </button>
      <div v-if="!navEdges.length" class="muted">无可下探边。</div>

      <h4>其他边（定义等） <small>{{ otherEdges.length }}</small></h4>
      <div v-for="re in otherEdges.slice(0, 20)" :key="re.edge.edgeId" class="edge-row static">
        <OmBadge tone="neutral">{{ re.edge.edgeKind }}</OmBadge>
        <span class="edge-evidence">{{ re.edge.evidence || "—" }}</span>
      </div>
    </template>
  </div>
</template>

<style scoped>
.file-frame { display: flex; flex-direction: column; gap: 10px; }
.head { display: flex; flex-direction: column; gap: 6px; }
.path { font-family: ui-monospace, Consolas, monospace; font-size: 12px; color: var(--om-muted); word-break: break-all; }
.row { display: flex; gap: 6px; flex-wrap: wrap; }
.error-banner { border: 1px solid #eccaca; background: #fff0f0; color: var(--om-danger); padding: 10px 12px; border-radius: 6px; display: flex; align-items: center; gap: 10px; }
.muted { color: var(--om-secondary); }
.small { font-size: 12px; }
.stack { margin-bottom: 10px; }
h4 { margin: 12px 0 4px; }
.sym-outline { display: flex; flex-direction: column; gap: 2px; }
.sym-row { display: flex; gap: 8px; align-items: center; border: 1px solid transparent; background: transparent; text-align: left; padding: 3px 6px; border-radius: 4px; font-family: ui-monospace, Consolas, monospace; font-size: 12.5px; }
.sym-row:hover { background: var(--om-soft); border-color: var(--om-line); }
.sym-kind { font-size: 10px; color: var(--om-muted); width: 60px; }
.sym-name { flex: 1; }
.edge-row { display: flex; align-items: center; gap: 8px; padding: 5px 6px; border-bottom: 1px solid var(--om-line); width: 100%; text-align: left; background: transparent; border-left: 0; border-right: 0; border-top: 0; border-radius: 4px; }
.edge-row:hover:not(.disabled) { background: var(--om-soft); }
.edge-row.disabled { opacity: 0.55; cursor: default; }
.edge-row.static { cursor: default; }
.dir { color: var(--om-muted); font-size: 12px; }
.edge-evidence { font-family: ui-monospace, Consolas, monospace; font-size: 12px; word-break: break-all; flex: 1; }
.why { color: var(--om-muted); font-size: 11px; font-family: inherit; }
</style>
