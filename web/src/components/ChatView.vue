<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { get } from "../api";
import { larkToMarkdown, parseChatLines, senderHue, type ChatMsg } from "../lib/chat";
import { fmtTime, openCitation } from "../store";
import Icon from "./Icon.vue";
import Markdown from "./Markdown.vue";
import Skeleton from "./Skeleton.vue";
import VirtualList from "./VirtualList.vue";

/**
 * A chat source shown as a chat: sender, time, the replied-to message, Markdown, images,
 * files, cards and topics. Uses the structured messages kept for Feishu captures; older
 * captures and other channels are parsed from their lines. Long chats render only what is
 * on screen. `from`/`to` (source lines from a citation) highlight and scroll to the message.
 */
/** `start`: the line number of `text`'s first line when only part of a long chat is loaded. */
const props = withDefaults(defineProps<{ sourceId: string; text: string; start?: number; space?: string; from?: number; to?: number }>(), { start: 1 });

type Row = { kind: "day"; key: string; label: string } | { kind: "msg"; key: string; m: ChatMsg; grouped: boolean };

const loading = ref(true);
const messages = ref<ChatMsg[]>([]);
const quoted = ref<Record<string, ChatMsg & { sourceId: string | null }>>({});
const thread = ref<string | null>(null);
const list = ref<{ scrollToIndex: (i: number, align?: "start" | "center") => Promise<void> } | null>(null);

async function load() {
  loading.value = true;
  try {
    const r = await get<{ messages: ChatMsg[]; quoted: Record<string, ChatMsg & { sourceId: string | null }> }>(`/api/sources/${props.sourceId}/messages?from=${props.start}&to=${props.start + props.text.split("\n").length - 1}`).catch(() => ({ messages: [], quoted: {} }));
    // Rows exist only for messages captured since they were kept: older lines are parsed.
    const parsed = parseChatLines(props.text, props.start);
    const byLine = new Map(r.messages.filter((m) => m.line).map((m) => [m.line!, m]));
    messages.value = parsed.map((p) => byLine.get(p.line!) ?? p).filter((m) => m.content.trim() || Object.keys(m.resources).length);
    quoted.value = r.quoted;
  } finally {
    loading.value = false;
  }
  await nextTick();
  scrollToHighlight();
}
onMounted(load);
watch(() => [props.sourceId, props.text], load);
watch(() => props.from, () => void nextTick(scrollToHighlight));

const byId = computed(() => new Map(messages.value.map((m) => [m.id, m])));
const threads = computed(() => {
  const counts = new Map<string, number>();
  for (const m of messages.value) if (m.threadId) counts.set(m.threadId, (counts.get(m.threadId) ?? 0) + 1);
  return counts;
});
const rows = computed<Row[]>(() => {
  const out: Row[] = [];
  let day = "";
  let prev: ChatMsg | null = null;
  for (const m of messages.value) {
    if (thread.value && m.threadId !== thread.value) continue;
    const d = m.time ? new Date(m.time).toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric", weekday: "short" }) : "";
    if (d && d !== day) {
      out.push({ kind: "day", key: `d-${d}`, label: d });
      day = d;
      prev = null;
    }
    const grouped = !!prev && prev.sender === m.sender && prev.threadId === m.threadId && !m.parentId && !m.quote && Date.parse(m.time) - Date.parse(prev.time) < 5 * 60_000;
    out.push({ kind: "msg", key: m.id, m, grouped });
    prev = m;
  }
  return out;
});
const hl = (m: ChatMsg) => props.from !== undefined && m.line !== null && m.line >= props.from && m.line <= (props.to ?? props.from);
function scrollToHighlight() {
  if (props.from === undefined) return;
  const i = rows.value.findIndex((r) => r.kind === "msg" && hl(r.m));
  if (i >= 0) void list.value?.scrollToIndex(i, "center");
}

function quoteOf(m: ChatMsg) {
  if (m.quote) return { sender: m.quote.sender, text: m.quote.text, target: null as ChatMsg | null };
  if (!m.parentId) return null;
  const local = byId.value.get(m.parentId);
  const q = local ?? quoted.value[m.parentId];
  return q ? { sender: q.sender, text: q.content.replace(/\s+/g, " ").slice(0, 120), target: local ?? null, sourceId: (q as { sourceId?: string | null }).sourceId, line: q.line } : { sender: "", text: "（引用的消息未读取到）", target: null };
}
function jumpTo(q: ReturnType<typeof quoteOf>) {
  if (!q) return;
  if (q.target) {
    thread.value = null;
    const i = rows.value.findIndex((r) => r.kind === "msg" && r.m.id === q.target!.id);
    if (i >= 0) void list.value?.scrollToIndex(i, "center");
  } else if ((q as { sourceId?: string }).sourceId) openCitation({ kind: "source", id: (q as { sourceId: string }).sourceId, from: (q as { line?: number }).line ?? undefined, to: (q as { line?: number }).line ?? undefined });
}
const initial = (name: string) => (name || "?").replace(/^[^\p{L}\p{N}]+/u, "").slice(0, 1).toUpperCase() || "?";
const timeOf = (iso: string) => (iso ? new Date(iso).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) : "");
const md = (m: ChatMsg) => larkToMarkdown(m.content, m.resources, m.mentions, m.id);
const files = (m: ChatMsg) => Object.values(m.resources).filter((r) => r.sourceId && !r.url);
const reactionList = (m: ChatMsg) => (m.reactions as { emoji_type?: string; emoji?: string; count?: number }[]).filter((r) => r && (r.emoji_type || r.emoji));
</script>

<template>
  <div class="chat">
    <div v-if="threads.size" class="toolbar row wrap small">
      <span class="muted">{{ messages.length }} 条消息 · {{ threads.size }} 个话题</span>
      <span class="spacer" />
      <button v-if="thread" class="btn ghost sm" @click="thread = null"><Icon name="x" :size="13" />显示全部</button>
    </div>
    <Skeleton v-if="loading" :rows="6" variant="chat" />
    <div v-else-if="!messages.length" class="muted small empty">没有消息。</div>
    <VirtualList v-else ref="list" :items="rows" :item-key="(r) => r.key" :estimate="72">
      <template #default="{ item: r }">
        <div v-if="r.kind === 'day'" class="day"><span>{{ r.label }}</span></div>
        <div v-else class="msg" :class="[r.m.senderKind, { grouped: r.grouped, hl: hl(r.m), sys: r.m.senderKind === 'system' }]" :id="r.m.line ? `L${r.m.line}` : undefined">
          <template v-if="r.m.senderKind === 'system' && !r.m.sender">
            <div class="sysline">{{ r.m.content }}</div>
          </template>
          <template v-else>
            <div class="avatar" :style="{ background: `hsl(${senderHue(r.m.sender)} 55% 52%)` }" :aria-hidden="true">{{ r.grouped ? "" : initial(r.m.sender) }}</div>
            <div class="body">
              <div v-if="!r.grouped" class="head row">
                <strong class="name">{{ r.m.sender || "未知" }}</strong>
                <span v-if="r.m.senderKind === 'owner'" class="badge accent">本人</span>
                <span v-else-if="r.m.senderKind === 'app'" class="badge">机器人</span>
                <span class="muted small" :title="fmtTime(r.m.time)">{{ timeOf(r.m.time) }}</span>
                <button v-if="r.m.threadId" class="topic small" :title="`只看这个话题（${threads.get(r.m.threadId)} 条）`" @click="thread = thread === r.m.threadId ? null : r.m.threadId">
                  <Icon name="chat" :size="12" />话题{{ threads.get(r.m.threadId)! > 1 ? ` · ${threads.get(r.m.threadId)}` : "" }}
                </button>
                <span v-if="r.m.line" class="muted small line">L{{ r.m.line }}</span>
              </div>
              <button v-if="quoteOf(r.m)" class="quote" @click="jumpTo(quoteOf(r.m))">
                <span class="qs">{{ quoteOf(r.m)!.sender }}</span><span class="qt">{{ quoteOf(r.m)!.text }}</span>
              </button>
              <div class="bubble"><Markdown :source="md(r.m)" :space="space" :linkify="false" breaks /></div>
              <div v-if="files(r.m).length" class="row wrap files">
                <button v-for="f in files(r.m)" :key="f.sourceId" class="res-chip" @click="openCitation({ kind: 'source', id: f.sourceId! })"><Icon name="file" :size="13" />{{ f.name ?? "附件" }}</button>
              </div>
              <div v-if="reactionList(r.m).length" class="row wrap reactions">
                <span v-for="(x, i) in reactionList(r.m)" :key="i" class="badge">{{ x.emoji ?? x.emoji_type }}{{ x.count && x.count > 1 ? ` ${x.count}` : "" }}</span>
              </div>
            </div>
          </template>
        </div>
      </template>
    </VirtualList>
  </div>
</template>

<style scoped>
.chat {
  max-width: 860px;
}
.toolbar {
  margin-bottom: 8px;
  position: sticky;
  top: 0;
  z-index: 2;
  background: var(--bg);
  padding: 4px 0;
}
.day {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 18px 0 8px;
  color: var(--muted);
  font-size: 12px;
}
.day::before,
.day::after {
  content: "";
  flex: 1;
  border-top: 1px solid var(--line);
}
.msg {
  display: flex;
  gap: 10px;
  padding: 6px 8px;
  border-radius: 10px;
}
.msg.grouped {
  padding-top: 1px;
}
.msg.hl {
  background: var(--mark);
}
.avatar {
  flex: none;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  color: #fff;
  font-size: 14px;
  font-weight: 600;
  display: grid;
  place-items: center;
}
.grouped .avatar {
  height: 0;
  background: none !important;
}
.body {
  flex: 1;
  min-width: 0;
}
.head {
  gap: 6px;
  margin-bottom: 2px;
  flex-wrap: wrap;
}
.name {
  font-size: 13.5px;
}
.line {
  margin-left: auto;
  font-family: var(--mono);
  opacity: 0;
}
.msg:hover .line {
  opacity: 1;
}
.topic {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  border: 1px solid var(--line);
  background: var(--panel);
  color: var(--ink-2);
  border-radius: 999px;
  padding: 0 7px;
  cursor: pointer;
}
.topic:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.quote {
  display: flex;
  gap: 6px;
  max-width: 100%;
  margin: 2px 0 4px;
  padding: 3px 8px;
  border: 0;
  border-left: 3px solid var(--line-strong);
  background: var(--sunken);
  border-radius: 4px;
  color: var(--ink-2);
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;
}
.quote:hover {
  border-left-color: var(--accent);
}
.qs {
  font-weight: 600;
  flex: none;
}
.qt {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.bubble :deep(.prose) {
  font-size: 14px;
  line-height: 1.65;
}
.bubble :deep(.prose p) {
  margin: 0 0 0.4em;
}
.bubble :deep(.prose > :last-child) {
  margin-bottom: 0;
}
.bubble :deep(.prose h1),
.bubble :deep(.prose h2),
.bubble :deep(.prose h3),
.bubble :deep(.prose h4) {
  font-family: var(--sans);
  font-size: 14.5px;
  font-weight: 650;
  margin: 0.6em 0 0.3em;
  padding: 0;
  border: 0;
}
.bubble :deep(.prose pre) {
  font-size: 12px;
  padding: 8px 10px;
  max-height: 320px;
}
.bubble :deep(.prose hr) {
  margin: 0.6em 0;
}
.bubble :deep(.prose img) {
  max-width: min(360px, 100%);
  max-height: 320px;
  border-radius: 8px;
  border: 1px solid var(--line);
  display: block;
  margin: 4px 0;
}
.bubble :deep(.at) {
  color: var(--accent);
  font-weight: 500;
}
.bubble :deep(.at-email) {
  margin-left: 4px;
  font-size: 0.8em;
  font-weight: 400;
  color: var(--muted);
  font-family: var(--mono);
  overflow-wrap: anywhere;
}
.bubble :deep(.res) {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 0 6px;
  border-radius: 5px;
  background: var(--sunken);
  color: var(--ink-2);
  font-size: 12.5px;
}
.bubble :deep(.lark-card) {
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--panel);
  padding: 8px 12px;
  margin: 2px 0;
  max-width: 640px;
}
.bubble :deep(.lark-card-title) {
  font-weight: 600;
  padding-bottom: 6px;
  margin-bottom: 6px;
  border-bottom: 1px solid var(--line);
}
.owner .bubble :deep(.prose) {
  color: var(--ink);
}
.sysline {
  width: 100%;
  text-align: center;
  color: var(--muted);
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-word;
}
.files,
.reactions {
  gap: 4px;
  margin-top: 4px;
}
.res-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: 1px solid var(--line);
  background: var(--panel);
  border-radius: 7px;
  padding: 2px 8px;
  font-size: 12.5px;
  cursor: pointer;
  color: var(--ink-2);
}
.empty {
  padding: 24px 0;
}
</style>
