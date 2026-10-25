<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { get, type Memory } from "../api";
import { fmtTime, memoryKindLabel, openCitation, state, statusLabel, type CitationTarget } from "../store";
import CodeView from "./CodeView.vue";
import Icon from "./Icon.vue";
import Markdown from "./Markdown.vue";
import { readsAsDocument } from "../lib/sources";

const router = useRouter();
const top = computed<CitationTarget | undefined>(() => state.trail[state.trail.length - 1]);
const loading = ref(false);
const error = ref("");
const source = ref<any>(null);
const memory = ref<{ memory: Memory; history: Memory[] } | null>(null);
const message = ref<any>(null);
const page = ref<any>(null);
const file = ref<{ lines: string[]; from: string; space: string; path: string; sourceId?: string } | null>(null);
const panel = ref<HTMLElement>();
// A document (a Feishu doc, Markdown) reads laid out, the cited lines set off; code keeps line numbers.
const raw = ref(false);
const asDocument = computed(() => !!source.value && !raw.value && readsAsDocument(source.value.source));
const docParts = computed(() => {
  const s = source.value;
  const t = top.value as { from?: number; to?: number } | undefined;
  if (!s) return null;
  const lines = String(s.text).split("\n");
  const at = (n: number) => Math.min(lines.length, Math.max(0, n - s.lineStart));
  if (!t?.from) return { before: s.text as string, cited: "", after: "" };
  const a = at(t.from);
  const b = at((t.to ?? t.from) + 1);
  return { before: lines.slice(0, a).join("\n"), cited: lines.slice(a, b).join("\n"), after: lines.slice(b).join("\n") };
});
const citedEl = ref<HTMLElement>();
watch(citedEl, (el) => el?.scrollIntoView({ block: "center" }));
let opener: Element | null = null;

async function load() {
  const t = top.value;
  error.value = "";
  source.value = memory.value = message.value = page.value = file.value = null;
  raw.value = false;
  if (!t) return;
  loading.value = true;
  try {
    if (t.kind === "source") {
      const id = t.id ?? (await get<{ id: string }>(`/api/sources/resolve?uri=${encodeURIComponent(t.uri!)}${t.space ? `&space=${t.space}` : ""}`)).id;
      const from = t.from ? Math.max(1, t.from - 30) : 1;
      const to = t.to ? t.to + 30 : 200;
      source.value = { ...(await get(`/api/sources/${id}?from=${from}&to=${to}`)), id };
    } else if (t.kind === "memory") memory.value = await get(`/api/memories/${t.id}`);
    else if (t.kind === "message") message.value = await get(`/api/messages/${t.id}`);
    else if (t.kind === "page") page.value = await get(`/api/wiki/${t.space}/page/${t.slug}`);
    else if (t.kind === "file") file.value = await get(`/api/runs/${t.runId}/file?path=${encodeURIComponent(t.path)}${t.space ? `&space=${encodeURIComponent(t.space)}` : ""}`);
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}
watch(top, load, { immediate: true });
watch(
  () => state.trail.length > 0,
  (open) => {
    if (open) {
      opener = document.activeElement;
      setTimeout(() => panel.value?.focus(), 0);
    } else if (opener instanceof HTMLElement) opener.focus();
  },
);

function back() {
  state.trail.pop();
}
function close() {
  state.trail = [];
}
function onKey(e: KeyboardEvent) {
  if (e.key === "Escape" && state.trail.length && !state.palette) {
    e.preventDefault();
    back();
  }
}
onMounted(() => window.addEventListener("keydown", onKey));
onBeforeUnmount(() => window.removeEventListener("keydown", onKey));

async function more(dir: "up" | "down") {
  const s = source.value;
  if (!s) return;
  const from = dir === "up" ? Math.max(1, s.lineStart - 120) : s.lineStart;
  const to = dir === "down" ? s.lineEnd + 120 : s.lineEnd;
  const next = await get(`/api/sources/${s.id}?from=${from}&to=${to}`);
  source.value = { ...next, id: s.id };
}
function openFull() {
  const t = top.value as Extract<CitationTarget, { kind: "source" }>;
  router.push({ path: `/sources/${source.value.id}`, query: t.from ? { from: String(t.from), to: String(t.to ?? t.from) } : {} });
  close();
}
function parseRef(ref: string): CitationTarget | null {
  let m = /^src:([^#\s]+)(?:#L(\d+)(?:-L?(\d+))?)?/.exec(ref);
  if (m) return { kind: "source", id: m[1], from: m[2] ? +m[2] : undefined, to: m[3] ? +m[3] : m[2] ? +m[2] : undefined };
  if ((m = /^mem:(\S+)/.exec(ref))) return { kind: "memory", id: m[1] };
  if ((m = /^msg:(\S+)/.exec(ref))) return { kind: "message", id: m[1] };
  return null;
}
const title = computed(() => {
  const t = top.value;
  if (!t) return "";
  if (t.kind === "source") return source.value?.source.uri ?? t.uri ?? "原件";
  if (t.kind === "memory") return "记忆";
  if (t.kind === "message") return "对话消息";
  if (t.kind === "file") return t.path;
  return page.value?.meta.title ?? t.slug;
});
</script>

<template>
  <Transition name="drawer">
    <aside v-if="top" ref="panel" class="drawer" tabindex="-1" role="dialog" aria-modal="false" :aria-label="title">
      <header>
        <button v-if="state.trail.length > 1" class="btn ghost sm icon" title="返回上一层（Esc）" @click="back"><Icon name="left" /></button>
        <div class="t ellipsis" :title="title">{{ title }}</div>
        <span v-if="state.trail.length > 1" class="muted small">{{ state.trail.length }} 层</span>
        <button class="btn ghost sm icon" title="关闭" @click="close"><Icon name="x" /></button>
      </header>
      <div class="body">
        <div v-if="loading" class="muted">读取中…</div>
        <div v-else-if="error" class="err"><Icon name="alert" /> {{ error }}</div>

        <template v-else-if="source">
          <div class="meta row wrap">
            <span class="badge">{{ source.source.kind }}</span>
            <span class="badge">{{ source.source.spaceId }}</span>
            <span class="muted small">更新于 {{ fmtTime(source.source.updatedAt) }} · 共 {{ source.source.lines }} 行</span>
            <span class="spacer" />
            <button v-if="readsAsDocument(source.source)" class="btn ghost sm" @click="raw = !raw">{{ raw ? "排版视图" : "原文行号" }}</button>
          </div>
          <div v-if="source.source.deletedAt" class="err">这份原件已在 {{ fmtTime(source.source.deletedAt) }} 移除，引用的内容不再可用。</div>
          <template v-else>
            <button v-if="source.lineStart > 1" class="btn ghost sm more" @click="more('up')">向上展开</button>
            <div v-if="asDocument && docParts" class="doc">
              <Markdown v-if="docParts.before.trim()" :source="docParts.before" :space="source.source.spaceId" />
              <div v-if="docParts.cited.trim()" ref="citedEl" class="cited-lines"><Markdown :source="docParts.cited" :space="source.source.spaceId" /></div>
              <Markdown v-if="docParts.after.trim()" :source="docParts.after" :space="source.source.spaceId" />
            </div>
            <CodeView v-else :text="source.text" :start="source.lineStart" :path="source.source.uri" :from="(top as any).from" :to="(top as any).to" wrap />
            <button v-if="source.lineEnd < source.source.lines" class="btn ghost sm more" @click="more('down')">向下展开</button>
            <div class="row actions">
              <button class="btn sm" @click="openFull"><Icon name="external" :size="15" />打开完整原件</button>
            </div>
            <div v-if="source.citedBy?.length" class="cited">
              <div class="section-title">引用这份原件的页面</div>
              <a v-for="p in source.citedBy" :key="p.page_id" href="#" class="li" @click.prevent="openCitation({ kind: 'page', space: p.page_id.split('/')[0], slug: p.page_id.split('/').slice(1).join('/') })">{{ p.title }}</a>
            </div>
          </template>
        </template>

        <template v-else-if="file">
          <div class="meta row wrap">
            <span class="badge">{{ file.space }}</span>
            <span class="muted small">{{ { worktree: "评审 / 交办的工作区", branch: "分支上的版本", repo: "仓库当前检出", source: "已索引的原件" }[file.from] ?? file.from }} · 共 {{ file.lines.length }} 行</span>
          </div>
          <CodeView :text="file.lines.join('\n')" :start="1" :path="file.path" :from="(top as any).from" :to="(top as any).to ?? (top as any).from" />
        </template>

        <template v-else-if="memory">
          <div class="memcard" :class="memory.memory.status">
            <div class="row small">
              <span class="badge accent">{{ memoryKindLabel[memory.memory.kind] ?? memory.memory.kind }}</span>
              <span v-if="memory.memory.status !== 'active'" class="badge warn">{{ statusLabel[memory.memory.status] }}</span>
              <span class="muted">{{ memory.memory.subject }}</span>
            </div>
            <p>{{ memory.memory.content }}</p>
            <div class="muted small">有效期：{{ fmtTime(memory.memory.validFrom, false) || "?" }} → {{ memory.memory.validTo ? fmtTime(memory.memory.validTo, false) : "至今" }} · {{ memory.memory.createdBy === "user" ? "本人" : "助理" }}记录</div>
          </div>
          <div v-if="memory.memory.sourceRefs.length" class="refs">
            <div class="section-title">来源</div>
            <template v-for="r in memory.memory.sourceRefs" :key="r">
              <a v-if="parseRef(r)" href="#" class="ref mono small" @click.prevent="openCitation(parseRef(r)!)">{{ r }}</a>
              <span v-else class="mono small muted">{{ r }}</span>
            </template>
          </div>
          <div v-if="memory.history.length > 1" class="chain">
            <div class="section-title">演变</div>
            <ol>
              <li v-for="h in memory.history" :key="h.id" :class="{ cur: h.id === memory.memory.id }">
                <div class="small muted">{{ fmtTime(h.validFrom) }} · {{ statusLabel[h.status] }}</div>
                <div>{{ h.content }}</div>
              </li>
            </ol>
          </div>
        </template>

        <template v-else-if="message">
          <div class="muted small">{{ message.role === "user" ? "本人" : "助理" }} · {{ fmtTime(message.createdAt) }}</div>
          <Markdown :source="message.text" />
          <router-link :to="`/ask/${message.conversationId}`" class="btn sm" @click="close">打开对话</router-link>
        </template>

        <template v-else-if="page">
          <p v-if="page.meta.summary" class="muted">{{ page.meta.summary }}</p>
          <Markdown :source="page.body" :space="page.spaceId" />
          <router-link :to="`/wiki/${page.spaceId}/${page.slug}`" class="btn sm" @click="close">在 Wiki 中打开</router-link>
        </template>
      </div>
    </aside>
  </Transition>
</template>

<style scoped>
.drawer {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  width: min(560px, 100vw);
  background: var(--panel);
  border-left: 1px solid var(--line);
  box-shadow: var(--shadow-lg);
  z-index: 40;
  display: flex;
  flex-direction: column;
  outline: none;
}
header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px 10px 16px;
  border-bottom: 1px solid var(--line);
  min-height: 52px;
}
.t {
  flex: 1;
  font-weight: 600;
  font-family: var(--mono);
  font-size: 13px;
}
.body {
  padding: 16px;
  overflow: auto;
  display: grid;
  gap: 12px;
  align-content: start;
}
.meta {
  gap: 6px;
}
.more {
  justify-self: center;
}
.doc {
  min-width: 0;
  overflow-wrap: anywhere;
}
.cited-lines {
  background: var(--warn-soft);
  border-left: 3px solid var(--warn);
  border-radius: 0 8px 8px 0;
  padding: 2px 12px;
  margin: 6px 0;
}
.actions {
  margin-top: 4px;
}
.err {
  display: flex;
  gap: 8px;
  align-items: center;
  color: var(--danger);
  background: var(--danger-soft);
  padding: 10px 12px;
  border-radius: 8px;
}
.cited {
  display: grid;
  gap: 2px;
  margin-top: 8px;
}
.cited .li {
  padding: 4px 0;
}
.memcard {
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 14px;
}
.memcard p {
  font-size: 15px;
  margin: 8px 0;
}
.memcard.superseded p,
.memcard.retracted p {
  text-decoration: line-through;
  color: var(--muted);
}
.refs {
  display: grid;
  gap: 4px;
}
.chain ol {
  margin: 0;
  padding-left: 20px;
  display: grid;
  gap: 10px;
}
.chain li.cur {
  font-weight: 600;
}
.drawer-enter-active,
.drawer-leave-active {
  transition: transform 0.18s ease, opacity 0.18s;
}
.drawer-enter-from,
.drawer-leave-to {
  transform: translateX(24px);
  opacity: 0;
}
</style>
