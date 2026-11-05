<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { get, onServerEvent, post, type Ask as AskItem } from "../api";
import AskCard from "./AskCard.vue";
import Icon from "./Icon.vue";
import Markdown from "./Markdown.vue";
import RunActivity from "./RunActivity.vue";
import { state, toast } from "../store";

/** A conversation with the assistant beside the remote screen (views/Remote.vue): the same thread as on 问答. */
type Message = { id: string; role: "user" | "assistant"; text: string; runId: string | null; createdAt: string };

const props = defineProps<{ conversationId: string | null }>();
const emit = defineEmits<{ "update:conversationId": [id: string] }>();

const messages = ref<Message[]>([]);
const asks = ref<AskItem[]>([]);
const text = ref("");
const sending = ref(false);
const scroller = ref<HTMLElement>();
let seq = 0;

async function load() {
  const mine = ++seq, id = props.conversationId;
  if (!id) return void (messages.value = [], asks.value = []);
  const [r, pending] = await Promise.all([
    get<{ messages: Message[] }>(`/api/conversations/${id}`).catch(() => ({ messages: [] })),
    get<AskItem[]>(`/api/asks?conversation=${encodeURIComponent(id)}&status=pending`).catch(() => []),
  ]);
  if (mine !== seq || id !== props.conversationId) return;
  messages.value = r.messages;
  asks.value = pending;
  await scrollDown();
}
async function scrollDown() {
  await nextTick();
  scroller.value?.scrollTo({ top: scroller.value.scrollHeight });
}
onMounted(load);
watch(() => props.conversationId, load);
const off = onServerEvent((e) => {
  if (e.type === "ask" && e.conversationId === props.conversationId) void load();
  if (e.type === "run" && (e.status === "done" || e.status === "failed") && messages.value.some((m) => m.runId === e.runId)) void load();
});
onBeforeUnmount(() => off());

const pending = computed(() => {
  const answered = new Set(messages.value.filter((m) => m.role === "assistant").map((m) => m.runId));
  return [...new Set(messages.value.filter((m) => m.role === "user" && m.runId && !answered.has(m.runId)).map((m) => m.runId!))];
});
const waiting = computed(() => asks.value.filter((a) => a.kind !== "suggestion"));
const suggestionsFor = (runId: string | null) => (runId ? asks.value.filter((a) => a.kind === "suggestion" && a.runId === runId) : []);

async function send() {
  const t = text.value.trim();
  if (!t || sending.value) return;
  sending.value = true;
  try {
    const r = await post<{ conversationId: string; messageId: string | null; runId: string | null; reply: string | null }>("/api/ask", { text: t, space: state.space, conversationId: props.conversationId ?? undefined });
    text.value = "";
    if (r.conversationId !== props.conversationId) emit("update:conversationId", r.conversationId);
    else if (r.reply !== null) await load();
    else messages.value.push({ id: r.messageId!, role: "user", text: t, runId: r.runId, createdAt: new Date().toISOString() });
    await scrollDown();
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    sending.value = false;
  }
}
async function cancel(runId: string) {
  await post(`/api/runs/${runId}/cancel`);
}
defineExpose({ load });
</script>

<template>
  <section class="rchat">
    <div ref="scroller" class="scroll">
      <div v-if="!messages.length" class="intro muted small">
        先在这里说要教助手做什么，再点“开始录制”，在左边做一遍。停下后录制会交给助手整理成技能。
      </div>
      <template v-for="m in messages" :key="m.id">
        <div v-if="m.role === 'user'" class="msg user"><div class="bubble">{{ m.text }}</div></div>
        <div v-else class="msg bot">
          <RunActivity v-if="m.runId" :run-id="m.runId" :show-text="false" />
          <Markdown :source="m.text" />
          <AskCard v-for="a in suggestionsFor(m.runId)" :key="a.id" :ask="a" compact @answered="load" />
        </div>
      </template>
      <div v-for="r in pending" :key="r" class="msg bot">
        <RunActivity :run-id="r" open @text="scrollDown">
          <template #default="{ text: live, running }">
            <Markdown v-if="live" :source="live" />
            <div v-if="running" class="row"><button class="btn ghost sm" @click="cancel(r)"><Icon name="stop" :size="13" />停止</button></div>
          </template>
        </RunActivity>
      </div>
    </div>
    <div v-if="waiting.length" class="asks">
      <AskCard v-for="a in waiting" :key="a.id" :ask="a" @answered="load" />
    </div>
    <form class="composer" @submit.prevent="send">
      <textarea v-model="text" rows="2" placeholder="和助手说要教的事，或回答它的问题（Shift+Enter 换行）" @keydown.enter.exact.prevent="send" />
      <button class="btn primary icon" :disabled="sending || !text.trim()" aria-label="发送"><Icon name="send" :size="16" /></button>
    </form>
  </section>
</template>

<style scoped>
.rchat {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
}
.scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: grid;
  align-content: start;
  gap: 16px;
  padding: 4px 2px 14px;
}
.scroll > *,
.msg.bot > * {
  min-width: 0;
}
.msg.user {
  display: flex;
  justify-content: flex-end;
}
.bubble {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 14px 14px 4px 14px;
  padding: 8px 12px;
  max-width: 88%;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.msg.bot {
  display: grid;
  gap: 8px;
}
.asks {
  display: grid;
  gap: 8px;
  padding-bottom: 8px;
}
.composer {
  display: flex;
  gap: 8px;
  align-items: flex-end;
  background: var(--panel);
  border: 1px solid var(--line-strong);
  border-radius: 14px;
  padding: 6px 6px 6px 12px;
}
.composer textarea {
  flex: 1;
  min-width: 0;
  border: 0;
  outline: 0;
  background: none;
  resize: none;
  line-height: 1.6;
  padding: 4px 0;
  max-height: 180px;
}
</style>
