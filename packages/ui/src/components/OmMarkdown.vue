<script setup lang="ts">
/** Markdown is compiled, highlighted with the shared code renderer, then
 * sanitized with DOMPurify. Relative links remain in the evidence reader. */
import { ref, watch } from "vue";
import { highlightCode } from "../highlight";

const props = defineProps<{ source: string; citations?: { key: string; label: string; reason: string; actionable: boolean; unavailableReason?: string | null }[] }>();
const emit = defineEmits<{
  "navigate-internal": [path: string];
  cite: [key: string];
}>();

const html = ref("");
const loading = ref(false);
const failed = ref(false);
let generation = 0;
const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const ALLOWED_TAGS = new Set([
  "p", "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6",
  "code", "pre", "a", "strong", "em", "blockquote", "table", "thead",
  "tbody", "tr", "th", "td", "hr", "br", "del", "span",
]);

async function render() {
  const current = ++generation;
  failed.value = false;
  if (!props.source) {
    html.value = "";
    return;
  }
  loading.value = true;
  try {
    const [{ marked }, DOMPurify] = await Promise.all([
      import("marked"),
      import("dompurify"),
    ]);
    const source = props.source.replace(/\[\[([a-zA-Z][a-zA-Z0-9_-]*)\]\]/g, (_token, key: string) => {
      const c = props.citations?.find(c => c.key === key);
      if (!c) return '<span class="om-inline-citation unavailable">引用不可用</span>';
      const label = escape(c.label), description = escape(c.reason);
      return c.actionable ? `<a class="om-inline-citation" href="/__omem/citation/${encodeURIComponent(key)}" title="${description}">${label} ↗</a>` : `<span class="om-inline-citation unavailable" title="${escape(c.unavailableReason || c.reason)}">${label}（不可用）</span>`;
    });
    const raw = await marked.parse(source, {
      async: true,
      walkTokens: async (token) => {
        if (token.type !== "code") return;
        const value = await highlightCode(token.text, (token.lang || "").split(/\s/)[0] || "");
        Object.assign(token, { type: "html", text: `<pre><code>${value}</code></pre>` });
      },
    });
    const purify = DOMPurify.default;
    const clean = purify.sanitize(raw, {
      ALLOWED_TAGS: [...ALLOWED_TAGS],
      ALLOWED_ATTR: ["href", "class", "title"],
      ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|tel:|\/|\.\/|\.\.\/)/i,
      ALLOW_DATA_ATTR: false,
    });
    if (current === generation) html.value = clean;
  } catch {
    if (current === generation) { failed.value = true; html.value = ""; }
  } finally {
    if (current === generation) loading.value = false;
  }
}

watch(() => [props.source, props.citations], () => void render(), { immediate: true, deep: true });

function onClick(ev: MouseEvent) {
  const a = (ev.target as HTMLElement).closest("a");
  if (!a) return;
  const href = a.getAttribute("href") || "";
  if (href.startsWith("/__omem/citation/")) { ev.preventDefault(); emit("cite", decodeURIComponent(href.slice("/__omem/citation/".length))); return; }
  if (/^(https?:|mailto:|tel:)/i.test(href)) {
    a.setAttribute("target", "_blank");
    a.setAttribute("rel", "noopener noreferrer");
    return;
  }
  ev.preventDefault();
  emit("navigate-internal", href);
}
</script>

<template>
  <div class="om-markdown">
    <small v-if="loading">正在渲染 Markdown…</small>
    <div v-else-if="failed" class="md-failed">
      Markdown 渲染失败，以下为原文：
      <pre>{{ source }}</pre>
    </div>
    <div v-else class="md-body" v-html="html" @click="onClick"></div>
  </div>
</template>

<style scoped>
.om-markdown {
  font: 14px/1.8 var(--om-sans);
}
.md-body :deep(code) {
  font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
  background: var(--om-soft);
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 12.5px;
}
.md-body :deep(pre) {
  background: var(--om-paper);
  border: 1px solid var(--om-line);
  border-radius: 6px;
  padding: 12px 14px;
  overflow: auto;
}
.md-body :deep(pre code) {
  background: transparent;
  padding: 0;
}
.md-body :deep(a) {
  text-decoration: underline;
}
.md-body :deep(.om-inline-citation) {
  display: inline; padding: 1px 4px; margin: 0 2px; border-bottom: 1px solid var(--om-muted); border-radius: 3px; background: var(--om-soft); color: var(--om-ink); text-decoration: none; cursor: pointer;
}
.md-body :deep(.om-inline-citation.unavailable) { color: var(--om-muted); cursor: default; }
.md-body :deep(blockquote) {
  border-left: 3px solid var(--om-line);
  margin: 8px 0;
  padding: 2px 14px;
  color: var(--om-secondary);
}
.md-body :deep(table) {
  border-collapse: collapse;
  margin: 8px 0;
}
.md-body :deep(th),
.md-body :deep(td) {
  border: 1px solid var(--om-line);
  padding: 4px 10px;
}
.md-failed pre {
  white-space: pre-wrap;
}
</style>
