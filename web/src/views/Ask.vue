<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { del, get, onServerEvent, post } from "../api";
import Icon from "../components/Icon.vue";
import Skeleton from "../components/Skeleton.vue";
import { confirmDialog } from "../lib/dialog";
import Markdown from "../components/Markdown.vue";
import RunActivity from "../components/RunActivity.vue";
import { currentSpace, relTime, state, toast } from "../store";

type Conversation = { id: string; space_id: string; channel: string; title: string; updated_at: string; status?: string; external_id?: string | null; summary?: string };
type Message = { id: string; role: "user" | "assistant"; text: string; runId: string | null; createdAt: string };

const route = useRoute();
const router = useRouter();
const conversations = ref<Conversation[]>([]);
const messages = ref<Message[]>([]);
const text = ref("");
const sending = ref(false);
const scroller = ref<HTMLElement>();
const input = ref<HTMLTextAreaElement>();
const showList = ref(false);
const id = computed(() => route.params.id as string | undefined);

const listLoading = ref(true);
const convLoading = ref(false);
async function loadList() {
  try {
    conversations.value = await get<Conversation[]>("/api/conversations");
  } finally {
    listLoading.value = false;
  }
}
async function loadConversation() {
  if (!id.value) return void (messages.value = []);
  const want = id.value;
  // Only the first load of a conversation shows a placeholder; refreshes keep what is on screen.
  if (!messages.value.length) convLoading.value = true;
  try {
    const r = await get<{ messages: Message[] }>(`/api/conversations/${want}`).catch(() => ({ messages: [] }));
    if (want !== id.value) return;
    messages.value = r.messages;
  } finally {
    convLoading.value = false;
  }
  await scrollDown();
}
async function scrollDown() {
  await nextTick();
  scroller.value?.scrollTo({ top: scroller.value.scrollHeight });
}
onMounted(() => {
  void loadList();
  void loadConversation();
  input.value?.focus();
});
watch(id, () => {
  messages.value = [];
  void loadConversation();
  showList.value = false;
});
const off = onServerEvent((e) => {
  if (e.type === "run" && (e.status === "done" || e.status === "failed") && messages.value.some((m) => m.runId === e.runId)) {
    void loadConversation();
    void loadList();
  }
});
onBeforeUnmount(() => off());

/** Runs that belong to a user message but have no assistant reply yet. */
const pending = computed(() => {
  const answered = new Set(messages.value.filter((m) => m.role === "assistant").map((m) => m.runId));
  return [...new Set(messages.value.filter((m) => m.role === "user" && m.runId && !answered.has(m.runId)).map((m) => m.runId!))];
});

async function send() {
  const t = text.value.trim();
  if (!t || sending.value) return;
  sending.value = true;
  try {
    const r = await post<{ conversationId: string; messageId: string | null; runId: string | null; reply: string | null }>("/api/ask", { text: t, space: state.space, conversationId: id.value });
    text.value = "";
    if (r.conversationId !== id.value) await router.push(`/ask/${r.conversationId}`);
    else if (r.reply !== null) await loadConversation();
    else messages.value.push({ id: r.messageId!, role: "user", text: t, runId: r.runId, createdAt: new Date().toISOString() });
    void loadList();
    await scrollDown();
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    sending.value = false;
  }
}
function channelLabel(c: Conversation) {
  const name = ({ lark: "飞书", telegram: "Telegram", onebot: "QQ/微信", cli: "命令行" } as Record<string, string>)[c.channel] ?? c.channel;
  const key = c.external_id ?? "";
  return `${name}${key.includes("#") ? " · 话题" : /group|^oc_|^-/.test(key) ? " · 群" : ""}`;
}
async function cancel(runId: string) {
  await post(`/api/runs/${runId}/cancel`);
}
async function remove(c: Conversation) {
  if (!(await confirmDialog(`删除对话「${c.title || "未命名"}」？`, { message: "已保存的记忆和事项不受影响。", okText: "删除", danger: true }))) return;
  await del(`/api/conversations/${c.id}`);
  if (c.id === id.value) router.push("/ask");
  void loadList();
}
function autosize(e: Event) {
  const el = e.target as HTMLTextAreaElement;
  el.style.height = "auto";
  el.style.height = Math.min(220, el.scrollHeight) + "px";
}
</script>

<template>
  <div class="ask" :class="{ 'list-open': showList }">
    <aside class="convs">
      <div class="row head">
        <strong>对话</strong>
        <span class="spacer" />
        <router-link to="/ask" class="btn sm"><Icon name="plus" :size="15" />新对话</router-link>
      </div>
      <div class="list">
        <router-link v-for="c in conversations" :key="c.id" :to="`/ask/${c.id}`" class="li conv" :class="{ active: c.id === id }">
          <div class="grow">
            <div class="ellipsis">{{ c.title || "新对话" }}</div>
            <div class="muted small" :title="c.summary || ''">{{ relTime(c.updated_at) }}<span v-if="c.channel !== 'web'"> · {{ channelLabel(c) }}</span><span v-if="c.status === 'archived'"> · 已归档</span></div>
          </div>
          <button class="btn ghost sm icon del" title="删除" @click.prevent="remove(c)"><Icon name="trash" :size="14" /></button>
        </router-link>
        <Skeleton v-if="listLoading" :rows="6" />
        <div v-else-if="!conversations.length" class="muted small pad">还没有对话。</div>
      </div>
    </aside>

    <section class="chat">
      <div class="chat-head row">
        <button class="btn ghost sm icon only-narrow" aria-label="对话列表" @click="showList = !showList"><Icon name="menu" /></button>
        <span class="muted small">空间：{{ currentSpace()?.name }}（助理可按需查阅其他空间）</span>
      </div>
      <div ref="scroller" class="scroll">
        <div class="thread">
          <Skeleton v-if="convLoading" variant="chat" :rows="4" />
          <div v-else-if="!messages.length" class="intro">
            <h1>问点什么</h1>
            <p class="muted">助理会在知识库里调查后回答，并给出原文依据。你也可以直接交代事情：记住一个约定、纠正之前的说法、设一个提醒、关注一个项目，或者交办一个编码任务。</p>
          </div>
          <template v-for="m in messages" :key="m.id">
            <div v-if="m.role === 'user'" class="msg user">
              <div class="bubble">{{ m.text }}</div>
            </div>
            <div v-else class="msg bot">
              <RunActivity v-if="m.runId" :run-id="m.runId" :show-text="false" />
              <Markdown :source="m.text" />
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
      </div>
      <form class="composer" @submit.prevent="send">
        <textarea ref="input" v-model="text" rows="1" placeholder="提问或交代事情；/help 查看命令（Shift+Enter 换行）" @input="autosize" @keydown.enter.exact.prevent="send" />
        <button class="btn primary icon" :disabled="sending || !text.trim()" aria-label="发送"><Icon name="send" :size="16" /></button>
      </form>
    </section>
  </div>
</template>

<style scoped>
.ask {
  display: flex;
  height: 100%;
}
.convs {
  width: 260px;
  flex: none;
  border-right: 1px solid var(--line);
  padding: 14px 10px;
  overflow-y: auto;
  background: var(--bg);
}
.head {
  padding: 0 4px 10px;
}
.conv {
  align-items: center;
}
.conv .del {
  opacity: 0;
}
.conv:hover .del {
  opacity: 1;
}
.grow {
  flex: 1;
  min-width: 0;
}
.pad {
  padding: 10px;
}
.chat {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.chat-head {
  padding: 8px 20px;
  border-bottom: 1px solid var(--line);
  min-height: 41px;
}
.scroll {
  flex: 1;
  overflow-y: auto;
}
.thread {
  max-width: 780px;
  margin: 0 auto;
  padding: 24px 24px 40px;
  display: grid;
  gap: 22px;
}
.intro {
  margin-top: 8vh;
}
.intro h1 {
  font-family: var(--serif);
  font-size: 28px;
  margin-bottom: 10px;
}
.msg.user {
  display: flex;
  justify-content: flex-end;
}
.bubble {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 14px 14px 4px 14px;
  padding: 9px 14px;
  max-width: 85%;
  white-space: pre-wrap;
  font-size: 15px;
}
.msg.bot {
  display: grid;
  gap: 10px;
}
.composer {
  display: flex;
  gap: 8px;
  align-items: flex-end;
  max-width: 780px;
  width: calc(100% - 48px);
  margin: 0 auto 18px;
  background: var(--panel);
  border: 1px solid var(--line-strong);
  border-radius: 14px;
  padding: 8px 8px 8px 14px;
  box-shadow: var(--shadow);
}
.composer textarea {
  flex: 1;
  border: 0;
  outline: 0;
  background: none;
  resize: none;
  font-size: 15px;
  line-height: 1.6;
  padding: 5px 0;
  max-height: 220px;
}
.only-narrow {
  display: none;
}
@media (max-width: 960px) {
  .convs {
    display: none;
  }
  .list-open .convs {
    display: block;
    position: absolute;
    z-index: 20;
    height: 100%;
    box-shadow: var(--shadow-lg);
  }
  .only-narrow {
    display: inline-flex;
  }
  .thread {
    padding: 16px;
  }
  .composer {
    width: calc(100% - 24px);
    margin-bottom: 10px;
  }
}
</style>
