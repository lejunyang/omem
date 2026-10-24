<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from "vue";
import { get, post } from "../api";
import Icon from "./Icon.vue";
import Markdown from "./Markdown.vue";
import { toast } from "../store";

/**
 * Asking about a run without leaving it: a quoted selection (diff lines, the task, a review
 * finding) and a question go to the assistant in one conversation per run, answered here.
 * The conversation is an ordinary one, also listed under 问答.
 */
type Message = { id: string; role: "user" | "assistant"; text: string; runId: string | null; createdAt: string };
export type AskContext = { quote: string; label: string };
const props = defineProps<{ runId: string; runTitle: string; spaceId: string | null; context: AskContext | null }>();
const emit = defineEmits<{ close: [] }>();

const KEY = "omem.runAsk";
const stored = (): Record<string, string> => { try { return JSON.parse(localStorage.getItem(KEY) ?? "{}"); } catch { return {}; } };
const conversationId = ref<string | null>(stored()[props.runId] ?? null);
const messages = ref<Message[]>([]);
const text = ref("");
const sending = ref(false);
const waiting = ref(false);
const quote = ref<AskContext | null>(props.context);
const input = ref<HTMLTextAreaElement | null>(null);
const scroller = ref<HTMLElement | null>(null);
const returnTo = document.activeElement as HTMLElement | null;
let timer: ReturnType<typeof setTimeout> | undefined;

watch(() => props.context, (c) => { if (c) quote.value = c; void nextTick(() => input.value?.focus()); }, { immediate: true });
async function load() {
  if (!conversationId.value) return;
  try {
    const r = await get<{ messages: Message[] }>(`/api/conversations/${conversationId.value}`);
    messages.value = r.messages;
    waiting.value = r.messages.at(-1)?.role === "user";
    await nextTick();
    scroller.value?.scrollTo({ top: scroller.value.scrollHeight });
  } catch (e) {
    // Only a deleted conversation starts over; a passing error keeps polling.
    if (/不存在|404/.test((e as Error).message)) {
      conversationId.value = null;
      messages.value = [];
      waiting.value = false;
    }
  }
}
function poll() {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    await load();
    if (waiting.value) poll();
  }, 1500);
}
void load().then(() => waiting.value && poll());
onBeforeUnmount(() => { clearTimeout(timer); returnTo?.focus?.(); });

async function send() {
  const q = text.value.trim();
  if (!q || sending.value) return;
  sending.value = true;
  // The question first (it names the conversation), then what it is about.
  const body = [
    q,
    // Fenced, so code keeps its lines and indentation.
    quote.value ? `${quote.value.label}：\n\n${"```"}\n${quote.value.quote.replace(/```/g, "ˋˋˋ")}\n${"```"}` : "",
    `${NOTE} ${props.runId}「${props.runTitle}」。需要时用 read_run 看这次交办的任务、改动和评审，用 read_source 或工作目录里的文件看代码；只回答，不要修改代码或续轮。）`,
  ].filter(Boolean).join("\n\n");
  try {
    const r = await post<{ conversationId: string }>("/api/ask", { text: body, space: props.spaceId ?? undefined, conversationId: conversationId.value ?? undefined });
    if (r.conversationId !== conversationId.value) {
      conversationId.value = r.conversationId;
      try { localStorage.setItem(KEY, JSON.stringify({ ...stored(), [props.runId]: r.conversationId })); } catch { /* private mode */ }
    }
    text.value = "";
    quote.value = null;
    await load();
    poll();
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    sending.value = false;
  }
}
// What the owner typed is shown without the instruction line the drawer adds.
const NOTE = "（关于交办运行";
const shownText = (m: Message) => (m.role === "user" ? m.text.slice(0, m.text.lastIndexOf(`\n\n${NOTE}`) >= 0 ? m.text.lastIndexOf(`\n\n${NOTE}`) : undefined) : m.text);
function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") emit("close");
  else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send();
}
</script>

<template>
  <div class="scrim" @click="emit('close')" />
  <aside class="drawer" role="dialog" aria-label="就这次交办提问" tabindex="-1" @keydown="onKey">
    <header>
      <span class="t">就这次交办提问</span>
      <router-link v-if="conversationId" class="btn ghost sm" :to="`/ask/${conversationId}`" title="在问答里打开">在问答里打开</router-link>
      <button class="btn ghost sm icon" aria-label="关闭" @click="emit('close')"><Icon name="x" :size="16" /></button>
    </header>
    <div ref="scroller" class="body">
      <p v-if="!messages.length" class="muted small">选中改动、任务或评审里的一段文字，再点“就选中内容提问”，问题会带上这段内容。回答只读这次交办的材料，不会改代码。</p>
      <div v-for="m in messages" :key="m.id" class="msg" :class="m.role">
        <Markdown :source="shownText(m)" :space="spaceId ?? undefined" />
      </div>
      <p v-if="waiting" class="muted small">正在回答…</p>
    </div>
    <div class="compose">
      <div v-if="quote" class="quote">
        <div class="row small muted"><span class="grow">{{ quote.label }}</span><button class="btn ghost sm icon" aria-label="去掉引用" @click="quote = null"><Icon name="x" :size="13" /></button></div>
        <pre>{{ quote.quote }}</pre>
      </div>
      <textarea ref="input" v-model="text" class="input" rows="3" placeholder="想问什么？Ctrl Enter 发送" aria-label="问题" />
      <div class="row"><span class="spacer" /><button class="btn primary sm" :disabled="sending || !text.trim()" @click="send"><Icon name="send" :size="13" />提问</button></div>
    </div>
  </aside>
</template>

<style scoped>
.scrim { position: fixed; inset: 0; background: rgba(10, 12, 16, 0.2); z-index: 39; }
.drawer { position: fixed; top: 0; right: 0; bottom: 0; width: min(520px, 100vw); background: var(--panel); border-left: 1px solid var(--line); box-shadow: var(--shadow-lg); z-index: 40; display: flex; flex-direction: column; outline: none; }
header { display: flex; align-items: center; gap: 8px; padding: 10px 12px 10px 16px; border-bottom: 1px solid var(--line); min-height: 52px; }
.t { flex: 1; font-weight: 600; }
.body { flex: 1; padding: 16px; overflow: auto; display: grid; gap: 12px; align-content: start; }
.msg.user { background: var(--sunken); border-radius: 10px; padding: 8px 12px; }
.compose { border-top: 1px solid var(--line); padding: 12px 16px; display: grid; gap: 8px; }
.quote { border-left: 3px solid var(--accent); background: var(--accent-soft); border-radius: 0 8px 8px 0; padding: 4px 8px 6px 10px; }
.quote pre { margin: 0; max-height: 140px; overflow: auto; font-family: var(--mono); font-size: 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
.grow { flex: 1; min-width: 0; }
</style>
