<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import Skeleton from "../components/Skeleton.vue";
import { escapeHtml, highlight, languageOf, renderMarkdown } from "../lib/markdown";

/**
 * A read-only share (src/core/shares.ts): the parts of omem that one message sent outside cited,
 * copied when it was sent. Opened by anyone with the link, without a token: no navigation, no
 * citations to follow, no images from omem (they would need a token).
 */
type Item = { i: number; mark?: number; label: string } & (
  | { kind: "source"; title: string; sourceKind: string; path: string; from: number | null; to: number | null; start: number; lines: string[]; total: number; format: "code" | "markdown" | "text" }
  | { kind: "memory"; title: string; text: string; status: string; createdAt: string }
  | { kind: "message"; title: string; text: string; at: string }
  | { kind: "page"; title: string; section: string | null; markdown: string }
);
type Share = { title: string; createdAt: string; expiresAt: string | null; items: Item[] };

const route = useRoute();
const share = ref<Share | null>(null);
const error = ref("");
const current = computed(() => (route.params.item !== undefined && route.params.item !== "" ? Number(route.params.item) : null));

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "");
const circled = (n: number) => (n <= 20 ? String.fromCodePoint(0x245f + n) : `(${n})`);
const KIND: Record<string, string> = { code: "代码", work: "工作文件", doc: "文档", note: "笔记", web: "网页", chat: "聊天", conversation: "对话", image: "图片" };

/** Rendered Markdown with everything that would lead back into omem made inert. */
function safe(md: string) {
  const box = document.createElement("template");
  box.innerHTML = renderMarkdown(md);
  for (const a of box.content.querySelectorAll<HTMLAnchorElement>("a")) {
    const href = a.getAttribute("href") ?? "";
    if (a.dataset.cite || a.dataset.wiki || !/^https?:/i.test(href)) {
      const span = document.createElement("span");
      span.textContent = a.textContent;
      a.replaceWith(span);
    } else a.setAttribute("rel", "noopener noreferrer");
  }
  for (const img of box.content.querySelectorAll<HTMLImageElement | HTMLVideoElement>("img, video")) {
    if (/^https?:/i.test(img.getAttribute("src") ?? "") && !/\/api\//.test(img.getAttribute("src") ?? "")) continue;
    const span = document.createElement("span");
    span.className = "muted";
    span.textContent = `（图片${img.getAttribute("alt") ? `：${img.getAttribute("alt")}` : ""}）`;
    img.replaceWith(span);
  }
  return box.innerHTML;
}

function codeLines(it: Extract<Item, { kind: "source" }>) {
  const lang = languageOf(it.path || it.title);
  return it.lines.map((l, k) => ({ n: it.start + k, html: highlight(l, lang) || "&nbsp;", hit: it.from !== null && it.start + k >= it.from && it.start + k <= (it.to ?? it.from) }));
}
const textLines = (it: Extract<Item, { kind: "source" }>) =>
  it.lines.map((l, k) => ({ n: it.start + k, html: escapeHtml(l) || "&nbsp;", hit: it.from !== null && it.start + k >= it.from && it.start + k <= (it.to ?? it.from) }));

function where(it: Item) {
  if (it.kind === "source") {
    const range = it.from ? `第 ${it.from}${it.to && it.to !== it.from ? `–${it.to}` : ""} 行` : "全文";
    return [KIND[it.sourceKind] ?? "原件", it.path && it.path !== it.title ? it.path : "", range].filter(Boolean).join(" · ");
  }
  if (it.kind === "memory") return `记忆 · ${when(it.createdAt)}${it.status !== "active" ? ` · ${it.status === "superseded" ? "已被更正" : "已撤回"}` : ""}`;
  if (it.kind === "message") return `对话 · ${when(it.at)}`;
  return `Wiki${it.section ? ` · ${it.section}` : ""}`;
}

onMounted(async () => {
  try {
    const r = await fetch(`/api/share/${encodeURIComponent(String(route.params.token))}`, { headers: { accept: "application/json" } });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(r.status === 404 ? "链接无效、已撤销或已过期，请向发链接的人要一个新的。" : `打开失败（${body.error ?? r.status}），稍后再试。`);
    share.value = body as Share;
    document.title = `${share.value.title || "分享"} · omem`;
    await nextTick();
    if (current.value !== null) document.getElementById(`item-${current.value}`)?.scrollIntoView({ block: "start" });
  } catch (e) {
    error.value = (e as Error).message;
  }
});
</script>

<template>
  <div class="share-page">
    <header class="share-head">
      <span class="brand"><svg viewBox="0 0 32 32" width="18" height="18" aria-hidden="true"><rect width="32" height="32" rx="8" fill="currentColor" /><circle cx="16" cy="16" r="7" fill="none" stroke="var(--bg)" stroke-width="3" /></svg>omem</span>
      <span class="muted small">只读分享</span>
    </header>
    <main class="share-body">
      <div v-if="error" class="card pad empty-share">
        <strong>打不开这个分享</strong>
        <p class="muted">{{ error }}</p>
      </div>
      <Skeleton v-else-if="!share" variant="text" :rows="10" />
      <template v-else>
        <h1>{{ share.title || "引用的内容" }}</h1>
        <p class="muted small meta">一条消息引用的 {{ share.items.length }} 处内容 · {{ when(share.createdAt) }} 复制 · {{ share.expiresAt ? `${when(share.expiresAt)} 失效` : "长期有效" }}</p>
        <article v-for="it in share.items" :id="`item-${it.i}`" :key="it.i" class="card item" :class="{ on: current === it.i }">
          <div class="item-head">
            <span v-if="it.mark" class="mark" aria-hidden="true">{{ circled(it.mark) }}</span>
            <div class="item-title">
              <strong>{{ it.label || it.title }}</strong>
              <span class="muted small">{{ it.label && it.label !== it.title ? `${it.title} · ` : "" }}{{ where(it) }}</span>
            </div>
          </div>
          <template v-if="it.kind === 'source'">
            <div v-if="!it.lines.length" class="muted small">这个原件没有可分享的文字。</div>
            <div v-else-if="it.format === 'markdown'" class="prose" v-html="safe(it.lines.join('\n'))" />
            <div v-else class="lines" :class="it.format" role="table">
              <div v-for="l in it.format === 'code' ? codeLines(it) : textLines(it)" :key="l.n" class="line" :class="{ hit: l.hit }" role="row">
                <span class="ln" role="cell">{{ l.n }}</span><code role="cell" v-html="l.html" />
              </div>
            </div>
            <p v-if="it.lines.length && it.start + it.lines.length - 1 < it.total && !it.from" class="muted small">只分享了前 {{ it.lines.length }} 行（共 {{ it.total }} 行）。</p>
          </template>
          <div v-else-if="it.kind === 'page'" class="prose" v-html="safe(it.markdown)" />
          <div v-else class="prose" v-html="safe(it.text)" />
        </article>
        <p class="muted small foot">这里只有那条消息引用的部分，是发送时的副本；里面提到的其他内容不能从这里打开。</p>
      </template>
    </main>
  </div>
</template>

<style scoped>
.share-page {
  min-height: 100%;
  background: var(--bg);
  overflow-y: auto;
  height: 100%;
}
.share-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 20px;
  border-bottom: 1px solid var(--line);
  background: var(--sunken);
}
.brand {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-weight: 650;
}
.share-body {
  max-width: 820px;
  margin: 0 auto;
  padding: 28px 20px 64px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
h1 {
  font-family: var(--serif);
  font-size: 24px;
  font-weight: 650;
  line-height: 1.4;
  margin: 0;
  overflow-wrap: anywhere;
}
.meta {
  margin: -8px 0 4px;
}
.item {
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
  scroll-margin-top: 16px;
}
.item.on {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
.item-head {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  min-width: 0;
}
.mark {
  font-size: 18px;
  line-height: 1.3;
  color: var(--accent);
}
.item-title {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  overflow-wrap: anywhere;
}
.lines {
  font-family: var(--mono);
  font-size: 12.5px;
  line-height: 1.6;
  background: var(--sunken);
  border-radius: var(--radius-sm);
  padding: 8px 0;
  overflow-x: auto;
}
.line {
  display: flex;
  min-width: max-content;
}
.lines.text .line {
  min-width: 0;
}
.line.hit {
  background: var(--mark);
}
.ln {
  flex: none;
  width: 3.5em;
  padding-right: 10px;
  text-align: right;
  color: var(--muted);
  user-select: none;
}
.line code {
  white-space: pre;
  padding-right: 12px;
  background: none;
  font: inherit;
}
.lines.text .line code {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  min-width: 0;
}
.empty-share {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.foot {
  text-align: center;
}
@media (max-width: 760px) {
  .share-body {
    padding: 20px 16px 48px;
  }
  h1 {
    font-size: 20px;
  }
}
</style>
