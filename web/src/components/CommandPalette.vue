<script setup lang="ts">
import UiCheckbox from "./UiCheckbox.vue";
import { computed, nextTick, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { get, post, type Hit, type IdHit } from "../api";
import { openCitation, sourceKindLabel, state } from "../store";
import HitText from "./HitText.vue";
import Icon from "./Icon.vue";

const router = useRouter();
const q = ref("");
const hits = ref<Hit[]>([]);
const idHits = ref<IdHit[]>([]);
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
  if (!q.value.trim()) return void ((hits.value = []), (idHits.value = []), (searching.value = false));
  searching.value = true;
  timer = setTimeout(async () => {
    // Something that looks like an id (one word with letters and digits) is also looked up as one.
    // "运行 r…" is how the id reads under a Feishu answer.
    const t = q.value.trim().replace(/^(运行|run)\s+/i, "");
    const asId = /^\S{6,}$/.test(t) && /\d/.test(t) && /[a-z]/i.test(t);
    const [r, ids] = await Promise.all([
      get<{ hits: Hit[] }>(`/api/search?q=${encodeURIComponent(q.value)}&limit=14${scopeAll.value ? "" : `&space=${state.space}`}`).catch(() => ({ hits: [] })),
      asId ? get<{ hits: IdHit[] }>(`/api/lookup?id=${encodeURIComponent(t)}`).catch(() => ({ hits: [] })) : { hits: [] as IdHit[] },
    ]);
    if (my === seq) {
      idHits.value = ids.hits;
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
// An exact id goes first: that is what was asked for.
/** Hits whose identical copies (“另有 N 份相同内容”) are unfolded. */
const unfolded = ref(new Set<string>());
const hitRows = computed(() =>
  hits.value.flatMap((h) => {
    const out: ({ hit: Hit; twin?: boolean } | { twins: Hit })[] = [{ hit: h }];
    if (!h.sameAs?.length) return out;
    out.push({ twins: h });
    if (unfolded.value.has(h.id)) for (const s of h.sameAs) out.push({ hit: { ...h, ...s, id: `${h.id}:${s.sourceId}`, sameAs: undefined }, twin: true });
    return out;
  }),
);
const rows = computed(() => [...idHits.value.map((h) => ({ idHit: h })), ...actions.value.slice(0, 1), ...hitRows.value, ...actions.value.slice(1)] as ({ idHit: IdHit } | { hit: Hit; twin?: boolean } | { twins: Hit } | (typeof actions.value)[number])[]);
const idLabel: Record<IdHit["type"], string> = { run: "运行", memory: "记忆", source: "原件", item: "事项", message: "消息", conversation: "对话", rule: "规则", page: "页面", notification: "通知" };
function openId(h: IdHit) {
  if (h.type === "run") router.push(`/runs/${h.id}`);
  else if (h.type === "item") router.push(`/items/${h.id}`);
  else if (h.type === "conversation") router.push(`/ask/${h.id}`);
  else if (h.type === "rule") router.push({ path: "/rules", query: { id: h.id } });
  else if (h.type === "notification") router.push("/notifications");
  else if (h.type === "page") openCitation({ kind: "page", space: h.spaceId!, slug: h.slug! }, true);
  else if (h.type === "memory") openCitation({ kind: "memory", id: h.id }, true);
  else if (h.type === "message") openCitation({ kind: "message", id: h.id }, true);
  else openCitation({ kind: "source", id: h.id }, true);
}

async function askAssistant(text: string) {
  const r = await post<{ conversationId: string }>("/api/ask", { text, space: state.space });
  router.push(`/ask/${r.conversationId}`);
}
function choose(i: number) {
  const row = rows.value[i];
  if (!row) return;
  if ("twins" in row) {
    const next = new Set(unfolded.value);
    next.has(row.twins.id) ? next.delete(row.twins.id) : next.add(row.twins.id);
    unfolded.value = next;
    return;
  }
  state.palette = false;
  if ("idHit" in row) openId(row.idHit);
  else if ("hit" in row) {
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
const hitLabel = (h: Hit) => (h.type === "chunk" ? (h.sourceKind && sourceKindLabel[h.sourceKind]) || typeLabel.chunk : typeLabel[h.type]);
const spaceName = (id: string) => state.spaces.find((s) => s.id === id)?.name ?? id;
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
          <button v-if="'idHit' in row" class="row-item id-hit" :class="{ on: i === active }" @mouseenter="active = i" @click="choose(i)">
            <span class="badge accent">{{ idLabel[row.idHit.type] }}</span>
            <span class="main">
              <span class="ttl ellipsis">{{ row.idHit.title }}</span>
              <span class="snip ellipsis muted">{{ row.idHit.snippet }}</span>
            </span>
            <span class="muted small mono">{{ row.idHit.id.length > 24 ? row.idHit.id.slice(0, 24) + "…" : row.idHit.id }}</span>
          </button>
          <button v-else-if="'twins' in row" class="row-item twins muted small" :class="{ on: i === active }" :aria-expanded="unfolded.has(row.twins.id)" @mouseenter="active = i" @click="choose(i)">
            <Icon :name="unfolded.has(row.twins.id) ? 'down' : 'right'" :size="12" />另有 {{ row.twins.sameAs!.length }} 份相同内容
          </button>
          <button v-else-if="'hit' in row" class="row-item" :class="{ on: i === active, stale: searching, twin: row.twin }" @mouseenter="active = i" @click="choose(i)">
            <span class="badge">{{ hitLabel(row.hit) }}</span>
            <span class="main">
              <span class="ttl"><HitText :text="row.hit.display?.title ?? row.hit.title" :marks="row.hit.display?.titleMarks" /><span v-if="row.hit.lineStart" class="muted">:{{ row.hit.lineStart }}</span></span>
              <span v-if="row.hit.display?.place || row.hit.display?.link" class="where muted small ellipsis">{{ [row.hit.display.place, row.hit.display.link].filter(Boolean).join(" · ") }}</span>
              <span class="snip muted"><HitText :text="row.hit.display?.text ?? row.hit.snippet.replace(/\s+/g, ' ')" :marks="row.hit.display?.marks" /></span>
            </span>
            <span class="muted small space">{{ spaceName(row.hit.spaceId) }}</span>
          </button>
          <button v-else class="row-item" :class="{ on: i === active }" @mouseenter="active = i" @click="choose(i)">
            <Icon :name="row.icon" :size="16" />
            <span class="main"><span class="ttl ellipsis">{{ row.label }}</span></span>
          </button>
        </template>
        <div v-if="searching" class="muted small pad row searching"><span class="spinner" />搜索中…</div>
        <div v-else-if="q && !hits.length && !idHits.length" class="muted small pad">没有直接命中。按回车让助理调查。</div>
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
.row-item.twins {
  gap: 4px;
  padding-left: 52px;
}
.row-item.twin {
  padding-left: 28px;
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
  overflow-wrap: anywhere;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.snip {
  font-size: 12px;
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  overflow-wrap: anywhere;
}
.where {
  font-size: 11.5px;
}
.space {
  flex: none;
  max-width: 96px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.badge {
  flex: none;
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
