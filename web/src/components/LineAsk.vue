<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { get, post } from "../api";
import Icon from "./Icon.vue";
import Markdown from "./Markdown.vue";
import { toast } from "../store";

/**
 * Asking about one line or work item beside its page (views/WorkDetail.vue): the conversation is the
 * line's 关注 conversation when it has one (where its looks and next steps already report), else one
 * kept for the item in this browser. A few questions to start from; the answer reads the item, the
 * items under it and its timeline. It is an ordinary conversation, also under 问答.
 */
type Message = { id: string; role: "user" | "assistant"; text: string; createdAt: string };
const props = defineProps<{ itemId: string; title: string; spaceId: string; listenId?: string | null; line?: boolean }>();
const emit = defineEmits<{ close: [] }>();

const KEY = "omem.lineAsk";
const stored = (): Record<string, string> => { try { return JSON.parse(localStorage.getItem(KEY) ?? "{}"); } catch { return {}; } };
const conversationId = ref<string | null>(null);
const messages = ref<Message[]>([]);
const text = ref("");
const sending = ref(false), waiting = ref(false), loading = ref(true);
const scroller = ref<HTMLElement>();
const input = ref<HTMLTextAreaElement>();
let timer: ReturnType<typeof setTimeout> | undefined;
let seq = 0;

const what = computed(() => (props.line ? "工作线" : "工作项"));
const prompts = computed(() => (props.line ? ["现在卡在哪？", "按这条线写一份周报", "下周要做什么？"] : ["现在卡在哪？", "还差什么才能做完？", "下一步该谁做？"]));
const NOTE = "（关于";
const note = () => `${NOTE}${what.value}「${props.title}」（${props.itemId}）：先用 read_item 读它、下面的工作项和最近的关键变化，需要时读它的材料；只回答，不改事项的状态。）`;
/** What the owner typed, without the line the panel adds. */
const shown = (m: Message) => {
  if (m.role !== "user") return m.text;
  const at = m.text.lastIndexOf(`\n\n${NOTE}`);
  return at >= 0 ? m.text.slice(0, at) : m.text;
};

async function where() {
  const n = ++seq;
  loading.value = true;
  messages.value = [];
  let id: string | null = null;
  if (props.listenId) id = (await get<{ context: { conversationId: string | null } }>(`/api/listen/${encodeURIComponent(props.listenId)}`).catch(() => null))?.context.conversationId ?? null;
  id ??= stored()[props.itemId] ?? null;
  if (n !== seq) return;
  conversationId.value = id;
  await load();
  if (n === seq) loading.value = false;
}
async function load() {
  if (!conversationId.value) return;
  try {
    const r = await get<{ messages: Message[] }>(`/api/conversations/${conversationId.value}`);
    messages.value = r.messages.slice(-30);
    waiting.value = r.messages.at(-1)?.role === "user";
    await nextTick();
    scroller.value?.scrollTo({ top: scroller.value.scrollHeight });
  } catch (e) {
    if (/不存在|404/.test((e as Error).message)) { conversationId.value = null; messages.value = []; waiting.value = false; }
  }
}
function poll() {
  clearTimeout(timer);
  timer = setTimeout(async () => { await load(); if (waiting.value) poll(); }, 1500);
}
watch(() => [props.itemId, props.listenId], () => void where().then(() => waiting.value && poll()), { immediate: true });
onBeforeUnmount(() => { ++seq; clearTimeout(timer); });

async function send(q = text.value) {
  q = q.trim();
  if (!q || sending.value) return;
  sending.value = true;
  try {
    const r = await post<{ conversationId: string }>("/api/ask", { text: `${q}\n\n${note()}`, space: props.spaceId, conversationId: conversationId.value ?? undefined });
    if (r.conversationId !== conversationId.value) {
      conversationId.value = r.conversationId;
      if (!props.listenId) try { localStorage.setItem(KEY, JSON.stringify({ ...stored(), [props.itemId]: r.conversationId })); } catch { /* private mode */ }
    }
    text.value = "";
    await load();
    poll();
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    sending.value = false;
  }
}
function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") emit("close");
  else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send();
}
</script>

<template>
  <aside class="line-ask" role="complementary" :aria-label="`问这条${what}`" @keydown="onKey">
    <header>
      <span class="t">问这条{{ what }}</span>
      <router-link v-if="conversationId" class="btn ghost sm" :to="`/ask/${conversationId}`">在问答里打开</router-link>
      <button class="btn ghost sm icon" aria-label="收起" title="收起（Esc）" @click="emit('close')"><Icon name="x" :size="16" /></button>
    </header>
    <div ref="scroller" class="body">
      <p v-if="loading" class="muted small">正在打开会话…</p>
      <template v-else-if="!messages.length">
        <p class="muted small">问的问题会带上这条{{ what }}，助手读它下面的工作项、最近的关键变化和材料再回答。{{ listenId ? "对话接在这条线关注的会话里，每天的整理和下一步也在那里。" : "" }}</p>
      </template>
      <div v-for="m in messages" :key="m.id" class="msg" :class="m.role">
        <Markdown :source="shown(m)" :space="spaceId" />
      </div>
      <p v-if="waiting" class="muted small">正在回答…</p>
    </div>
    <div class="compose">
      <div class="prompts">
        <button v-for="p in prompts" :key="p" type="button" class="chip" :disabled="sending" @click="send(p)">{{ p }}</button>
      </div>
      <textarea ref="input" v-model="text" class="input" rows="3" placeholder="想问什么？Ctrl Enter 发送" aria-label="问题" />
      <div class="row"><span class="spacer" /><button class="btn primary sm" :disabled="sending || !text.trim()" @click="send()"><Icon name="send" :size="13" />提问</button></div>
    </div>
  </aside>
</template>

<style scoped>
.line-ask { display: flex; flex-direction: column; min-height: 0; background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden; }
header { display: flex; align-items: center; gap: 6px; padding: 8px 8px 8px 14px; border-bottom: 1px solid var(--line); min-height: 46px; }
.t { flex: 1; font-family: var(--serif); font-weight: 650; font-size: 15px; }
.body { flex: 1; min-height: 120px; overflow: auto; padding: 12px 14px; display: grid; grid-template-columns: minmax(0, 1fr); gap: 10px; align-content: start; }
.msg { min-width: 0; font-size: 14px; }
.msg :deep(pre), .msg :deep(table) { max-width: 100%; overflow-x: auto; }
.msg :deep(table) { display: block; }
.msg.user { background: var(--sunken); border-radius: 10px; padding: 6px 10px; }
.compose { border-top: 1px solid var(--line); padding: 10px 12px; display: grid; gap: 8px; }
.prompts { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { border: 1px solid var(--line); background: var(--panel); border-radius: 999px; padding: 3px 10px; font: inherit; font-size: 12.5px; color: var(--ink-2); cursor: pointer; }
.chip:hover { border-color: var(--line-strong); }
.chip:disabled { opacity: 0.6; cursor: default; }
</style>
