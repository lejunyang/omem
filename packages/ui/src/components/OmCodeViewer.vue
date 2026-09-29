<script setup lang="ts">
/** Shared source viewer: full-document highlighting with stable line anchors. */
import { ref, watch, nextTick } from "vue";
import { escapeCode as escapeHtml, highlightCode, highlightedLines } from "../highlight";

export type CodeRangeMark = {
  start: number;
  end: number;
  id: string;
  kind?: string;
  title?: string;
};

const props = defineProps<{
  code: string;
  language?: string;
  anchorLine?: number;
  highlightLines?: number[];
  ranges?: CodeRangeMark[];
}>();

const emit = defineEmits<{
  navigate: [target: { filePath?: string; symbol?: string; line?: number }];
}>();

const hl = ref<Record<number, string>>({});
const loading = ref(false);
const root = ref<HTMLElement>();
const flashed = ref(false);

const lines = () => props.code.split("\n");
let generation = 0;
watch(() => [props.code, props.language] as const, async ([code, language]) => {
  const current = ++generation;
  hl.value = {};
  loading.value = true;
  try {
    const rows = highlightedLines(await highlightCode(code, language || "typescript"));
    if (current === generation) hl.value = Object.fromEntries(rows.map((line, i) => [i + 1, line]));
  } catch {
    if (current === generation) hl.value = {};
  } finally {
    if (current === generation) loading.value = false;
  }
}, { immediate: true });

watch(
  () => props.anchorLine,
  async (line) => {
    if (!line) return;
    await nextTick();
    flashed.value = true;
    setTimeout(() => (flashed.value = false), 3000);
    const el = root.value?.querySelector<HTMLElement>(`[data-line="${line}"]`);
    el?.scrollIntoView({ block: "center", behavior: "auto" });
  },
);


function isHighlighted(n: number): boolean {
  return props.highlightLines?.includes(n) || props.anchorLine === n;
}

function rangeForLine(n: number): CodeRangeMark | undefined {
  return props.ranges?.find((r) => n >= r.start && n <= r.end);
}

function onLineClick(n: number) {
  const r = rangeForLine(n);
  if (r) emit("navigate", { line: n });
}
</script>

<template>
  <div ref="root" class="om-code-view" :class="{ loading }">
    <table class="code-table">
      <tbody>
        <tr
          v-for="(line, i) in lines()"
          :key="i"
          :data-line="i + 1"
          :class="{ hit: isHighlighted(i + 1), flash: flashed && anchorLine === i + 1 }"
        >
          <td class="gutter" :title="rangeForLine(i + 1)?.title || ('行 ' + (i + 1))">
            <span class="ln">{{ i + 1 }}</span>
          </td>
          <td class="code" @click="onLineClick(i + 1)">
            <code
              v-html="hl[i + 1] !== undefined ? hl[i + 1] : escapeHtml(line)"
            ></code>
          </td>
        </tr>
      </tbody>
    </table>
    <small v-if="loading" class="loading-hint">正在加载语法高亮…</small>
  </div>
</template>

<style scoped>
.om-code-view {
  border: 1px solid var(--om-line);
  border-radius: 6px;
  background: var(--om-paper);
  overflow: auto;
  max-height: 70vh;
  font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
  font-size: 12.5px;
  line-height: 1.6;
}
.code-table {
  border-collapse: collapse;
  width: 100%;
}
.gutter {
  user-select: none;
  text-align: right;
  padding: 0 10px 0 12px;
  color: var(--om-muted);
  background: #f2f2f2;
  border-right: 1px solid var(--om-line);
  vertical-align: top;
  white-space: nowrap;
}
.ln {
  font-size: 11px;
}
td.code {
  padding: 0 14px;
  white-space: pre;
  vertical-align: top;
}
tr.hit td.code {
  background: #e9e9e9;
}
tr.flash td.code {
  animation: flash 0.6s ease-out;
}
@keyframes flash {
  from {
    background: #d8d8d8;
  }
}
@media (prefers-reduced-motion: reduce) {
  tr.flash td.code {
    animation: none;
  }
}
.loading-hint {
  display: block;
  padding: 4px 12px;
  color: var(--om-muted);
}
@media (max-width: 700px) {
  .gutter {
    padding: 0 6px 0 8px;
  }
}
</style>
