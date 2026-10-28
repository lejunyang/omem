<script setup lang="ts">
import UiCheckbox from "./UiCheckbox.vue";
import { computed, nextTick, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { get, post, type Hit } from "../api";
import { openCitation, state } from "../store";
import Icon from "./Icon.vue";

const router = useRouter();
const q = ref("");
const hits = ref<Hit[]>([]);
const active = ref(0);
const input = ref<HTMLInputElement>();
const scopeAll = ref(true);
const searching = ref(false);
let timer: ReturnType<typeof setTimeout> | undefined;
let seq = 0;

watch(
  () => state.palette,
  async (open) => {
    if (open) {
      q.value = "";
      hits.value = [];
      active.value = 0;
      await nextTick();
      input.value?.focus();
    }
  },
);
watch([q, scopeAll], () => {
  clearTimeout(timer);
  const my = ++seq;
  if (!q.value.trim()) return void ((hits.value = []), (searching.value = false));
  searching.value = true;
  timer = setTimeout(async () => {
    const r = await get<{ hits: Hit[] }>(`/api/search?q=${encodeURIComponent(q.value)}&limit=14${scopeAll.value ? "" : `&space=${state.space}`}`).catch(() => ({ hits: [] }));
    if (my === seq) {
      hits.value = r.hits;
      active.value = 0;
      searching.value = false;
    }
  }, 180);
});

const navs = [
  { label: "首页", to: "/", icon: "home" },
  { label: "问答", to: "/ask", icon: "chat" },
  { label: "Wiki", to: "/wiki", icon: "book" },
  { label: "事项", to: "/items", icon: "checkbox" },
  { label: "记忆", to: "/memory", icon: "brain" },
  { label: "原件", to: "/sources", icon: "file" },
  { label: "运行记录", to: "/runs", icon: "activity" },
  { label: "学习", to: "/learn", icon: "cap" },
  { label: "设置", to: "/settings", icon: "settings" },
];
const actions = computed(() => {
  const t = q.value.trim();
  const list: { label: string; icon: string; run: () => void }[] = [];
  if (t) list.push({ label: `问助理：${t}`, icon: "sparkles", run: () => askAssistant(t) });
  for (const n of navs) if (!t || n.label.includes(t)) list.push({ label: `前往 ${n.label}`, icon: n.icon, run: () => router.push(n.to) });
  return list;
});
const rows = computed(() => [...actions.value.slice(0, 1), ...hits.value.map((h) => ({ hit: h })), ...actions.value.slice(1)] as ({ hit: Hit } | (typeof actions.value)[number])[]);

async function askAssistant(text: string) {
  const r = await post<{ conversationId: string }>("/api/ask", { text, space: state.space });
  router.push(`/ask/${r.conversationId}`);
}
function choose(i: number) {
  const row = rows.value[i];
  if (!row) return;
  state.palette = false;
  if ("hit" in row) {
    const h = row.hit;
    if (h.type === "page") router.push(`/wiki/${h.spaceId}/${h.path}`);
    else if (h.type === "memory") openCitation({ kind: "memory", id: h.id }, true);
    else openCitation({ kind: "source", id: h.sourceId, from: h.lineStart, to: h.lineEnd }, true);
  } else row.run();
}
function onKey(e: KeyboardEvent) {
  if (e.key === "ArrowDown") (active.value = Math.min(rows.value.length - 1, active.value + 1)), e.preventDefault();
  else if (e.key === "ArrowUp") (active.value = Math.max(0, active.value - 1)), e.preventDefault();
  else if (e.key === "Enter") choose(active.value), e.preventDefault();
  else if (e.key === "Escape") state.palette = false;
}
const typeLabel: Record<string, string> = { page: "页面", memory: "记忆", chunk: "原件", symbol: "代码" };
</script>

<template>
  <div v-if="state.palette" class="overlay" @mousedown.self="state.palette = false">
    <div class="palette" role="dialog" aria-label="搜索与命令">
      <div class="bar">
        <Icon name="search" />
        <input ref="input" v-model="q" placeholder="搜索原件、页面、记忆，或直接提问…" @keydown="onKey" />
        <span v-if="searching" class="spinner" aria-label="搜索中" />
        <UiCheckbox v-model="scopeAll" size="sm" class="scope small">全部空间</UiCheckbox>
      </div>
      <div class="rows">
        <template v-for="(row, i) in rows" :key="i">
          <button v-if="'hit' in row" class="row-item" :class="{ on: i === active, stale: searching }" @mouseenter="active = i" @click="choose(i)">
            <span class="badge">{{ typeLabel[row.hit.type] }}</span>
            <span class="main">
              <span class="ttl ellipsis">{{ row.hit.type === "page" ? row.hit.title : row.hit.type === "memory" ? row.hit.title || "记忆" : row.hit.uri }}<span v-if="row.hit.lineStart" class="muted">:{{ row.hit.lineStart }}</span></span>
              <span class="snip ellipsis muted">{{ row.hit.snippet.replace(/\s+/g, " ") }}</span>
            </span>
            <span class="muted small">{{ row.hit.spaceId }}</span>
          </button>
          <button v-else class="row-item" :class="{ on: i === active }" @mouseenter="active = i" @click="choose(i)">
            <Icon :name="row.icon" :size="16" />
            <span class="main"><span class="ttl ellipsis">{{ row.label }}</span></span>
          </button>
        </template>
        <div v-if="searching" class="muted small pad row searching"><span class="spinner" />搜索中…</div>
        <div v-else-if="q && !hits.length" class="muted small pad">没有直接命中。按回车让助理调查。</div>
      </div>
      <div class="foot muted small"><kbd>↑</kbd><kbd>↓</kbd> 选择 · <kbd>Enter</kbd> 打开 · <kbd>Esc</kbd> 关闭</div>
    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  background: rgba(10, 12, 16, 0.35);
  z-index: 60;
  display: flex;
  justify-content: center;
  padding-top: 12vh;
}
.palette {
  width: min(680px, calc(100vw - 24px));
  max-height: 70vh;
  background: var(--panel);
  border-radius: 14px;
  box-shadow: var(--shadow-lg);
  border: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--line);
  color: var(--muted);
}
.bar input {
  flex: 1;
  border: 0;
  outline: 0;
  background: none;
  font-size: 16px;
  color: var(--ink);
}
.scope {
  display: flex;
  gap: 4px;
  align-items: center;
  white-space: nowrap;
}
.rows {
  overflow: auto;
  padding: 6px;
}
.row-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  border: 0;
  background: none;
  text-align: left;
  padding: 8px 10px;
  border-radius: 8px;
  cursor: pointer;
}
.row-item.on {
  background: var(--accent-soft);
}
.main {
  flex: 1;
  min-width: 0;
  display: grid;
}
.ttl {
  font-weight: 500;
}
.snip {
  font-size: 12px;
}
.row-item.stale {
  opacity: 0.55;
}
.searching {
  gap: 8px;
}
.pad {
  padding: 10px;
}
.foot {
  padding: 8px 14px;
  border-top: 1px solid var(--line);
  display: flex;
  gap: 6px;
  align-items: center;
}
</style>
