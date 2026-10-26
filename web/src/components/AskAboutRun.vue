<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { get, post } from "../api";
import Icon from "./Icon.vue";
import Markdown from "./Markdown.vue";
import { toast } from "../store";
import { clearQuotes, quotesOf, quotesText, removeQuote } from "../lib/quotes";

/**
 * Asking about a run without leaving it: quoted selections (diff lines, the task, a review
 * finding, a cited document), numbered, and a question go to the assistant in one conversation per
 * run, answered here. The conversation is an ordinary one, also listed under 问答. With `basket` the
 * quotes are the run's ask basket (lib/quotes): the drawer can shrink to the dock while more is
 * quoted. The default slot shows what is asked about above the conversation (a change point's
 * explanation), titled by `heading`.
 */
type Message = { id: string; role: "user" | "assistant"; text: string; runId: string | null; createdAt: string };
export type AskContext = { quote: string; label: string };
const props = defineProps<{ runId: string; runTitle: string; spaceId: string | null; context?: AskContext | null; heading?: string; basket?: boolean; minimized?: boolean }>();
const emit = defineEmits<{ close: []; minimize: [] }>();

const KEY = "omem.runAsk";
const stored = (): Record<string, string> => { try { return JSON.parse(localStorage.getItem(KEY) ?? "{}"); } catch { return {}; } };
const conversationId = ref<string | null>(stored()[props.runId] ?? null);
const messages = ref<Message[]>([]);
const text = ref("");
const sending = ref(false);
const waiting = ref(false);
const quote = ref<AskContext | null>(props.context ?? null);
const quotes = computed(() => (props.basket ? quotesOf(props.runId, "ask") : []));
const input = ref<HTMLTextAreaElement | null>(null);
const scroller = ref<HTMLElement | null>(null);
const returnTo = document.activeElement as HTMLElement | null;
let timer: ReturnType<typeof setTimeout> | undefined;

watch(() => props.context, (c) => { if (c) quote.value = c; void nextTick(() => input.value?.focus()); }, { immediate: true });
watch(() => [quotes.value.length, props.minimized], () => { if (!props.minimized) void nextTick(() => input.value?.focus()); });
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
    quotesText(quotes.value, "引用的内容（问题里的 [1]、[2] 指这些）："),
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
    if (props.basket) clearQuotes(props.runId, "ask");
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
/** With a basket the drawer shrinks (what was quoted stays); without, it closes. */
function dismiss() {
  if (props.basket) emit("minimize");
  else emit("close");
}
function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") dismiss();
  else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send();
}
</script>

<template>
  <div v-show="!minimized" class="scrim" @click="dismiss" />
  <aside v-show="!minimized" class="drawer" role="dialog" :aria-label="heading ?? '就这次交办提问'" tabindex="-1" @keydown="onKey">
    <header>
      <span class="t">{{ heading ?? "就这次交办提问" }}</span>
      <router-link v-if="conversationId" class="btn ghost sm" :to="`/ask/${conversationId}`" title="在问答里打开">在问答里打开</router-link>
      <button v-if="basket" class="btn ghost sm" title="缩小到图标，继续选中别处的内容加入引用（Esc）" @click="emit('minimize')">缩小</button>
      <button class="btn ghost sm icon" aria-label="关闭" @click="emit('close')"><Icon name="x" :size="16" /></button>
    </header>
    <div ref="scroller" class="body">
      <slot />
      <p v-if="!messages.length && !$slots.default" class="muted small">选中改动、任务、评审或打开的原件里的一段文字，点“加入提问”，问题会带上这些内容（按 [1]、[2] 编号）。要引用多处：点“缩小”，选好下一段再加入。回答只读这次交办的材料，不会改代码。</p>
      <div v-for="m in messages" :key="m.id" class="msg" :class="m.role">
        <Markdown :source="shownText(m)" :space="spaceId ?? undefined" />
      </div>
      <p v-if="waiting" class="muted small">正在回答…</p>
    </div>
    <div class="compose">
      <div v-for="(q, i) in quotes" :key="q.id" class="quote">
        <div class="row small muted"><span class="num">[{{ i + 1 }}]</span><span class="grow ellipsis" :title="q.label">{{ q.label }}</span><button class="btn ghost sm icon" :aria-label="`去掉引用 ${i + 1}`" @click="removeQuote(runId, 'ask', q.id)"><Icon name="x" :size="13" /></button></div>
        <pre>{{ q.quote }}</pre>
      </div>
      <div v-if="quote" class="quote">
        <div class="row small muted"><span class="grow">{{ quote.label }}</span><button class="btn ghost sm icon" aria-label="去掉引用" @click="quote = null"><Icon name="x" :size="13" /></button></div>
        <pre>{{ quote.quote }}</pre>
      </div>
      <textarea ref="input" v-model="text" class="input" rows="3" :placeholder="quotes.length > 1 ? '想问什么？可以用 [1]、[2] 指上面的引用。Ctrl Enter 发送' : '想问什么？Ctrl Enter 发送'" aria-label="问题" />
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
.compose { max-height: 70vh; overflow: auto; }
.num { font-weight: 600; color: var(--accent); }
.quote pre { margin: 0; max-height: 140px; overflow: auto; font-family: var(--mono); font-size: 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
.grow { flex: 1; min-width: 0; }
</style>
