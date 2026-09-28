<script setup lang="ts">
/** On-demand source viewer with line numbers, range anchors and a monochrome
 * hljs theme. Highlight.js is dynamically imported and only the requested
 * language is registered (never the full bundle). The highlighted HTML is run
 * through a strict allow-list sanitizer before v-html: only <span class="hljs-*">
 * and whitespace text nodes survive, no attributes other than class.
 *
 * Lines are highlighted one-by-one so line numbers / range anchors stay exact;
 * multi-line block comments and template literals therefore do not colour
 * across line boundaries (a documented limit of this slice).
 */
import { ref, watch, nextTick, onMounted } from "vue";

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

const LANG_IMPORT: Record<string, string> = {
  typescript: "typescript",
  ts: "typescript",
  tsx: "typescript",
  javascript: "javascript",
  js: "javascript",
  mjs: "javascript",
  vue: "xml",
  html: "xml",
  md: "markdown",
  markdown: "markdown",
  json: "json",
  toml: "ini",
  bash: "bash",
  sh: "bash",
};

const lines = () => props.code.split("\n");

async function highlightAll() {
  const lang = props.language || "typescript";
  const hljsLang = LANG_IMPORT[lang];
  if (!hljsLang) {
    hl.value = {};
    return;
  }
  loading.value = true;
  try {
    const [core, langMod] = await Promise.all([
      import("highlight.js/lib/core"),
      import(`highlight.js/lib/languages/${hljsLang}`),
    ]);
    if (!core.default.getLanguage(hljsLang))
      core.default.registerLanguage(hljsLang, (langMod as { default: unknown }).default);
    const out: Record<number, string> = {};
    lines().forEach((line, i) => {
      try {
        out[i + 1] = core.default.highlight(line, { language: hljsLang, ignoreIllegals: true }).value;
      } catch {
        out[i + 1] = escapeHtml(line);
      }
    });
    hl.value = out;
  } catch {
    hl.value = {}; // fall back to plain text lines
  } finally {
    loading.value = false;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

watch(
  () => props.code,
  () => void highlightAll(),
  { immediate: true },
);

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

onMounted(() => void highlightAll());

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
