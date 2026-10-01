<script setup lang="ts">
/** Markdown is compiled, highlighted with the shared code renderer, then
 * sanitized with DOMPurify. Relative links remain in the evidence reader. */
import { ref, watch } from "vue";
import { highlightCode } from "../highlight";

const props = defineProps<{ source: string; citations?: { key: string; label: string; reason: string; relation?: string; actionable: boolean; unavailableReason?: string | null }[] }>();
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
      return c.actionable ? `<a class="om-inline-citation" href="/__omem/citation/${encodeURIComponent(key)}" title="${description}">${label}</a>` : `<span class="om-inline-citation unavailable" title="${escape(c.unavailableReason || c.reason)}">${label}（不可用）</span>`;
    });
    const diagrams: string[] = [];
    const raw = await marked.parse(source, {
      async: true,
      walkTokens: async (token) => {
        if (token.type !== "code") return;
        if (token.lang === "mermaid") {
          const index = diagrams.push(token.text) - 1;
          Object.assign(token, { type: "html", text: `<pre class="om-diagram-${index}">${escape(token.text)}</pre>` });
          return;
        }
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
    const doc = new DOMParser().parseFromString(clean, "text/html");
    // Old artifacts contain independent citation labels in mid-paragraph.
    // Keep authored “参考 [[c]]” inline; move other evidence links to that
    // paragraph's end without rewriting the claim or its fixed target.
    const groups = new Map<Element, Element[]>();
    for (const link of doc.querySelectorAll(".om-inline-citation")) {
      if (/(?:参考|参见|详见|延伸阅读)[：:\s]*$/.test(link.previousSibling?.textContent ?? "")) continue;
      const parent = link.closest("p,li,td,blockquote");
      if (parent) groups.set(parent, [...(groups.get(parent) ?? []), link]);
    }
    for (const [parent, links] of groups) {
      const references = doc.createElement("span"); references.className = "om-paragraph-references";
      references.append("参考：");
      links.forEach((link, i) => { if (i) references.append(" · "); references.append(link); });
      parent.append(references);
    }
    if (diagrams.length) {
      const { default: mermaid } = await import("mermaid");
      mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "neutral", flowchart: { htmlLabels: false }, suppressErrorRendering: true });
      for (const [i, diagram] of diagrams.entries()) {
        const block = doc.querySelector(`.om-diagram-${i}`);
        try {
          const { svg } = await mermaid.render(`om-diagram-${crypto.randomUUID()}`, diagram);
          if (block) { block.innerHTML = purify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true }, FORBID_TAGS: ["foreignObject", "a", "image", "style"], FORBID_ATTR: ["href", "xlink:href"] }); block.className = "om-diagram"; }
        } catch { if (block) block.prepend("流程图暂无法渲染，保留原始描述：\n"); }
      }
    }
    if (current === generation) html.value = doc.body.innerHTML;
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
  font: 16px/1.9 var(--om-sans);
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
  display:inline; color:var(--om-secondary); text-decoration:underline; text-decoration-color:var(--om-line); text-underline-offset:3px; cursor:pointer;
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

<style scoped>
.md-body :deep(.om-paragraph-references){display:block;margin-top:4px;color:var(--om-muted);font:12px/1.8 var(--om-sans);}
.md-body :deep(.om-diagram){background:var(--om-panel);white-space:normal;text-align:center;}
.md-body :deep(.om-diagram svg){max-width:100%;height:auto;}
.md-body :deep(table){display:block;max-width:100%;overflow:auto;font-size:14px;}
.md-body :deep(h2),.md-body :deep(h3){margin-top:1.7em;line-height:1.5;}
</style>

<style scoped>
.md-body :deep(.om-diagram rect),.md-body :deep(.om-diagram polygon){fill:var(--om-paper);stroke:var(--om-secondary);}
.md-body :deep(.om-diagram text){fill:var(--om-ink);font-family:var(--om-sans);}
.md-body :deep(.om-diagram path){stroke:var(--om-secondary);}
</style>
