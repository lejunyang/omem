<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { api, authUrl, del, get, onServerEvent, onServerResync, post, type Ask as AskItem, type UiViewItem } from "../api";
import AskCard from "../components/AskCard.vue";
import UiView from "../components/UiView.vue";
import Icon from "../components/Icon.vue";
import Skeleton from "../components/Skeleton.vue";
import { confirmDialog } from "../lib/dialog";
import { openImages } from "../lib/image-preview";
import { pageParam } from "../lib/route";
import Markdown from "../components/Markdown.vue";
import RunActivity from "../components/RunActivity.vue";
import VoiceChat from "../components/VoiceChat.vue";
import { recordSpeech, voiceStatus } from "../lib/voice";
import { currentSpace, relTime, state, toast } from "../store";

type Conversation = { id: string; space_id: string; channel: string; title: string; updated_at: string; status?: string; external_id?: string | null; summary?: string };
/** A file pasted, dropped or picked into the box (src/agents/attachments.ts); the text refers to it as [label]. */
type Attachment = { name: string; filename: string; kind: "image" | "file"; label: string; size: number };
type Message = { id: string; role: "user" | "assistant"; text: string; runId: string | null; createdAt: string; meta?: { attachments?: Attachment[]; runId?: unknown } };

const route = useRoute();
const router = useRouter();
const conversations = ref<Conversation[]>([]);
const messages = ref<Message[]>([]);
const conversationSpace = ref<string | null>(null);
const asks = ref<AskItem[]>([]);
let asksSeq = 0, listSeq = 0, convSeq = 0;
async function loadAsks() {
  const seq = ++asksSeq, target = id.value;
  const result = target ? await get<AskItem[]>(`/api/asks?conversation=${encodeURIComponent(target)}&status=pending`).catch(() => []) : [];
  if (seq === asksSeq && target === id.value) asks.value = result;
}
/** Questions and approvals wait above the composer; suggested next steps sit under their reply. */
// A question with a form sits under the reply that asked it, where there is room for it.
const inThread = (a: AskItem) => !!(a.ui?.fields?.length || a.ui?.view?.some((c) => c.type === "page")) && !!a.runId && messages.value.some((m) => m.runId === a.runId);
const waiting = computed(() => asks.value.filter((a) => a.kind !== "suggestion" && !inThread(a)));
const formsFor = (runId: string | null) => (runId ? asks.value.filter((a) => a.kind === "question" && a.runId === runId && inThread(a)) : []);
const suggestionsFor = (runId: string | null) => (runId ? asks.value.filter((a) => a.kind === "suggestion" && a.runId === runId) : []);
/** Tables and charts the agent showed (`show`) sit under the reply of the turn that made them. */
const views = ref<UiViewItem[]>([]);
let viewsSeq = 0;
async function loadViews() {
  const seq = ++viewsSeq, target = id.value;
  const result = target ? await get<UiViewItem[]>(`/api/ui/views?conversation=${encodeURIComponent(target)}`).catch(() => []) : [];
  if (seq === viewsSeq && target === id.value) views.value = result;
}
const viewsFor = (runId: string | null) => (runId ? views.value.filter((v) => v.runId === runId) : []);
const text = ref("");
const sending = ref(false);
const scroller = ref<HTMLElement>();
const input = ref<HTMLTextAreaElement>();
const showList = ref(false);
const id = pageParam("ask");

const listLoading = ref(true);
const convLoading = ref(false);
async function loadList() {
  const seq = ++listSeq, space = state.space;
  try {
    const result = await get<Conversation[]>(`/api/conversations?space=${encodeURIComponent(space)}`);
    if (seq === listSeq && space === state.space) conversations.value = result;
  } finally {
    if (seq === listSeq) listLoading.value = false;
  }
}
async function loadConversation() {
  const seq = ++convSeq;
  if (!id.value) { conversationSpace.value = null; messages.value = []; return; }
  const want = id.value;
  // Only the first load of a conversation shows a placeholder; refreshes keep what is on screen.
  if (!messages.value.length) convLoading.value = true;
  try {
    const r = await get<{ messages: Message[]; conversation?: Conversation }>(`/api/conversations/${want}`).catch(() => ({ messages: [] }));
    if (seq !== convSeq || want !== id.value) return;
    // A reply posted later (after an authorization or a delegated result) carries its run only in meta:
    // without it that run would look unanswered and its output would show a second time below.
    messages.value = r.messages.map((m) => (m.runId || typeof m.meta?.runId !== "string" ? m : { ...m, runId: m.meta.runId }));
    conversationSpace.value = "conversation" in r ? r.conversation?.space_id ?? null : null;
  } finally {
    if (seq === convSeq) convLoading.value = false;
  }
  await scrollDown();
}
async function scrollDown() {
  await nextTick();
  scroller.value?.scrollTo({ top: scroller.value.scrollHeight });
}
// Voice (settings → AI → 语音): speak into the box, or talk with the assistant live.
const voiceReady = ref(false);
const recording = ref<null | { stop(): Promise<string>; cancel(): void }>(null);
const transcribing = ref(false);
const talking = ref(false);
async function toggleRecord() {
  if (recording.value) {
    const r = recording.value;
    recording.value = null;
    transcribing.value = true;
    try {
      const said = await r.stop();
      if (said) text.value = text.value ? `${text.value} ${said}` : said;
      else toast("没有听清，再说一次", "info");
      await nextTick();
      input.value?.focus();
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      transcribing.value = false;
    }
    return;
  }
  try {
    recording.value = await recordSpeech();
  } catch (e) {
    toast(`打不开麦克风：${(e as Error).message}`, "error");
  }
}
function voiceEnded(saved: { id: string } | null) {
  talking.value = false;
  if (saved) toast("语音对话已保存", "ok");
}
onBeforeUnmount(() => recording.value?.cancel());

onMounted(() => {
  void voiceStatus().then((s) => (voiceReady.value = s.ready)).catch(() => {});
  void loadList();
  void loadConversation();
  void loadAsks();
  void loadViews();
  // Brought here from somewhere else with what to talk about (an item's flow page): start from it.
  const draft = route.query.draft;
  if (typeof draft === "string" && draft && !id.value) {
    text.value = draft;
    if (typeof route.query.space === "string" && state.spaces.some((s) => s.id === route.query.space)) state.space = route.query.space;
    void router.replace({ query: {} });
  }
  input.value?.focus();
});
watch(id, () => {
  conversationSpace.value = null;
  messages.value = [];
  views.value = [];
  void loadConversation();
  void loadAsks();
  void loadViews();
  showList.value = false;
});
const off = onServerEvent((e) => {
  if (e.type === "ask" && e.conversationId === id.value) void loadAsks();
  if (e.type === "ui" && e.conversationId === id.value) void loadViews();
  if (e.type === "run" && (e.status === "done" || e.status === "failed") && messages.value.some((m) => m.runId === e.runId)) {
    void loadConversation();
    void loadAsks();
    void loadList();
  }
});
// Back from a hidden tab: questions, views and the list may have moved; the thread is reloaded
// only while a reply was still on its way (reloading scrolls to the bottom).
const offResync = onServerResync(() => {
  void loadAsks();
  void loadViews();
  void loadList();
  if (pending.value.length) void loadConversation();
});
onBeforeUnmount(() => {
  off();
  offResync();
});

/** Runs that belong to a user message but have no assistant reply yet. */
const pending = computed(() => {
  const answered = new Set(messages.value.filter((m) => m.role === "assistant").map((m) => m.runId));
  return [...new Set(messages.value.filter((m) => m.role === "user" && m.runId && !answered.has(m.runId)).map((m) => m.runId!))];
});

// ---- attachments: paste, drop or pick files; each shows above the box and is referenced in the text as [图片1] / [文件1]
const attachments = ref<Attachment[]>([]);
const uploading = ref(0);
const picker = ref<HTMLInputElement>();
const dragging = ref(false);
const fileUrl = (name: string) => authUrl(`/api/files/${name}`);
/** A sent picture opens in the page's preview with the message's other pictures. */
function showSent(list: Attachment[], a: Attachment) {
  const imgs = list.filter((x) => x.kind === "image");
  openImages(imgs.map((x) => ({ url: fileUrl(x.name), caption: `[${x.label}] ${x.filename}` })), imgs.indexOf(a));
}
/** Put text where the cursor is (or was, before a chip was clicked), and keep the cursor after it. */
function insertAtCursor(snippet: string) {
  const el = input.value;
  const at = el ? el.selectionStart : text.value.length;
  const end = el ? el.selectionEnd : at;
  const before = text.value.slice(0, at), after = text.value.slice(end);
  const pad = before && !/\s$/.test(before) ? " " : "";
  text.value = `${before}${pad}${snippet}${after && !/^\s/.test(after) ? " " : ""}${after}`;
  void nextTick(() => {
    const pos = before.length + pad.length + snippet.length + 1;
    el?.focus();
    el?.setSelectionRange(pos, pos);
  });
}
function nextLabel(kind: Attachment["kind"]) {
  const word = kind === "image" ? "图片" : "文件";
  const used = attachments.value.filter((a) => a.kind === kind).map((a) => Number(a.label.slice(word.length)) || 0);
  return `${word}${Math.max(0, ...used) + 1}`;
}
async function addFiles(files: File[]) {
  if (!files.length) return;
  uploading.value += files.length;
  try {
    const form = new FormData();
    for (const f of files) form.append("file", f, f.name || (f.type.startsWith("image/") ? `粘贴的图片.${f.type.slice(6).replace("jpeg", "jpg")}` : "粘贴的文件"));
    const r = await api<{ files: Omit<Attachment, "label">[] }>("/api/ask/attachments", { method: "POST", body: form });
    const labels: string[] = [];
    for (const f of r.files) {
      const a = { ...f, label: nextLabel(f.kind) };
      attachments.value.push(a);
      labels.push(`[${a.label}]`);
    }
    insertAtCursor(labels.join(" "));
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    uploading.value -= files.length;
  }
}
function onPaste(e: ClipboardEvent) {
  const files = Array.from(e.clipboardData?.files ?? []);
  if (!files.length) return;
  e.preventDefault();
  void addFiles(files);
}
function onDrop(e: DragEvent) {
  dragging.value = false;
  const files = Array.from(e.dataTransfer?.files ?? []);
  if (files.length) void addFiles(files);
}
function onPick(e: Event) {
  const el = e.target as HTMLInputElement;
  void addFiles(Array.from(el.files ?? []));
  el.value = "";
}
function removeAttachment(a: Attachment) {
  attachments.value = attachments.value.filter((x) => x !== a);
  text.value = text.value.split(`[${a.label}]`).join("").replace(/ {2,}/g, " ");
}
const sizeText = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

async function send() {
  const t = text.value.trim();
  const files = attachments.value;
  if ((!t && !files.length) || sending.value || uploading.value) return;
  sending.value = true;
  try {
    const r = await post<{ conversationId: string; messageId: string | null; runId: string | null; reply: string | null }>("/api/ask", { text: t, space: state.space, conversationId: id.value, ...(files.length ? { attachments: files } : {}) });
    text.value = "";
    attachments.value = [];
    if (r.conversationId !== id.value) await router.push(`/ask/${r.conversationId}`);
    else if (r.reply !== null) await loadConversation();
    else messages.value.push({ id: r.messageId!, role: "user", text: t || files.map((a) => `[${a.label}]`).join(" "), runId: r.runId, createdAt: new Date().toISOString(), meta: files.length ? { attachments: files } : undefined });
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
/** The box grows with its text, whoever put it there: typing, a draft brought from another page, voice. */
function autosize() {
  const el = input.value;
  if (!el) return;
  el.style.height = "auto";
  el.style.height = Math.min(220, el.scrollHeight) + "px";
}
watch(text, () => void nextTick(autosize), { flush: "post" });
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
            <div class="clamp2" :title="c.title || ''">{{ c.title || "新对话" }}</div>
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
        <span class="muted small">空间：{{ (state.spaces.find(s => s.id === conversationSpace)?.name ?? currentSpace()?.name) }}（助理可按需查阅其他空间）</span>
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
              <div class="bubble">
                {{ m.text }}
                <div v-if="m.meta?.attachments?.length" class="sent-files">
                  <a v-for="a in m.meta.attachments" :key="a.label" :href="fileUrl(a.name)" target="_blank" rel="noopener" class="sent-file" :title="a.filename" @click="a.kind === 'image' && ($event.preventDefault(), showSent(m.meta.attachments, a))">
                    <img v-if="a.kind === 'image'" :src="fileUrl(a.name)" :alt="a.filename" loading="lazy" />
                    <span v-else class="file-ico"><Icon name="file" :size="15" /></span>
                    <span class="small">[{{ a.label }}] {{ a.kind === "image" ? "" : a.filename }}</span>
                  </a>
                </div>
              </div>
            </div>
            <div v-else class="msg bot">
              <RunActivity v-if="m.runId" :run-id="m.runId" :show-text="false" />
              <Markdown :source="m.text" />
              <UiView v-for="v in viewsFor(m.runId)" :key="v.id" :components="v.components" :title="v.title" :space="conversationSpace ?? undefined" />
              <AskCard v-for="a in formsFor(m.runId)" :key="a.id" :ask="a" @answered="loadAsks" />
              <AskCard v-for="a in suggestionsFor(m.runId)" :key="a.id" :ask="a" compact @answered="loadAsks" />
            </div>
          </template>
          <div v-for="r in pending" :key="r" class="msg bot">
            <RunActivity :run-id="r" open @text="scrollDown">
              <template #default="{ text: live, running }">
                <Markdown v-if="live" :source="live" />
                <UiView v-for="v in viewsFor(r)" :key="v.id" :components="v.components" :title="v.title" />
                <div v-if="running" class="row"><button class="btn ghost sm" @click="cancel(r)"><Icon name="stop" :size="13" />停止</button></div>
              </template>
            </RunActivity>
          </div>
        </div>
      </div>
      <div v-if="waiting.length" class="asks">
        <AskCard v-for="a in waiting" :key="a.id" :ask="a" @answered="loadAsks" />
      </div>
      <VoiceChat v-if="talking" class="voice-panel" :space="state.space" @ended="voiceEnded" />
      <form class="composer" :class="{ dragging }" @submit.prevent="send" @dragover.prevent="dragging = true" @dragleave.self="dragging = false" @drop.prevent="onDrop">
        <div v-if="attachments.length || uploading" class="attachments" aria-label="附件">
          <div v-for="a in attachments" :key="a.label" class="chip" :title="`点一下在光标处引用 [${a.label}]`">
            <button type="button" class="chip-main" @mousedown.prevent @click="insertAtCursor(`[${a.label}]`)">
              <img v-if="a.kind === 'image'" :src="fileUrl(a.name)" :alt="a.filename" />
              <span v-else class="file-ico"><Icon name="file" :size="16" /></span>
              <span class="chip-text"><strong>{{ a.label }}</strong><span class="muted ellipsis">{{ a.kind === "image" ? sizeText(a.size) : a.filename }}</span></span>
            </button>
            <button type="button" class="chip-x" :aria-label="`移除 ${a.label}`" @click="removeAttachment(a)"><Icon name="x" :size="12" /></button>
          </div>
          <div v-if="uploading" class="chip muted small"><span class="spin" />正在上传 {{ uploading }} 个</div>
        </div>
        <input ref="picker" type="file" multiple hidden @change="onPick" />
        <button type="button" class="btn ghost icon" aria-label="添加图片或文件" title="添加图片或文件（也可以直接粘贴或拖进来）" @click="picker?.click()"><Icon name="upload" :size="16" /></button>
        <textarea ref="input" v-model="text" rows="1" :placeholder="recording ? '正在听，说完再点一下麦克风…' : transcribing ? '正在转成文字…' : '提问或交代事情；可以粘贴图片和文件；/help 查看命令（Shift+Enter 换行）'" @keydown.enter.exact.prevent="send" @paste="onPaste" />
        <template v-if="voiceReady">
          <button type="button" class="btn ghost icon" :class="{ rec: recording }" :disabled="transcribing || talking" :aria-pressed="!!recording" :aria-label="recording ? '停止并转成文字' : '语音输入'" :title="recording ? '停止并转成文字' : '语音输入'" @click="toggleRecord"><Icon name="mic" :size="16" /></button>
          <button type="button" class="btn ghost icon" :disabled="talking || !!recording" aria-label="语音对话" title="和助理实时语音对话" @click="talking = true"><Icon name="waves" :size="16" /></button>
        </template>
        <button class="btn primary icon" :disabled="sending || !!uploading || (!text.trim() && !attachments.length)" aria-label="发送"><Icon name="send" :size="16" /></button>
      </form>
    </section>
  </div>
</template>

<style scoped>
.ask {
  display: flex;
  height: 100%;
}
.asks {
  padding: 8px 16px 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 40vh;
  overflow-y: auto;
}
/* Cards keep their full height and the strip scrolls; a shrunk card lets its code and buttons spill out of the frame. */
.asks > * {
  flex: none;
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
/* Grid items keep their content width unless told otherwise: a long path or a wide code block would push past the column. */
.thread > *,
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
  padding: 9px 14px;
  max-width: 85%;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 15px;
}
.msg.bot {
  display: grid;
  gap: 10px;
}
.composer {
  display: flex;
  flex-wrap: wrap;
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
.composer.dragging {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
.attachments {
  flex-basis: 100%;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  min-width: 0;
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 240px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--bg);
  padding: 3px 4px 3px 3px;
}
.chip-main {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  border: 0;
  background: none;
  padding: 0;
  font: inherit;
  color: inherit;
  cursor: pointer;
  text-align: left;
}
.chip img,
.chip .file-ico {
  width: 38px;
  height: 38px;
  border-radius: 7px;
  object-fit: cover;
  flex: none;
}
.file-ico {
  display: inline-grid;
  place-items: center;
  background: var(--hover);
  color: var(--muted);
}
.chip-text {
  display: grid;
  min-width: 0;
  font-size: 12.5px;
  line-height: 1.35;
}
.chip-x {
  border: 0;
  background: none;
  color: var(--muted);
  padding: 4px;
  border-radius: 6px;
  cursor: pointer;
  display: inline-flex;
}
.chip-x:hover {
  background: var(--hover);
  color: var(--ink);
}
.spin {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  border: 2px solid var(--line-strong);
  border-top-color: var(--accent);
  animation: spin 0.8s linear infinite;
  margin-right: 6px;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
.sent-files {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
  white-space: normal;
}
.sent-file {
  display: inline-flex;
  flex-direction: column;
  gap: 2px;
  color: inherit;
  max-width: 160px;
  text-decoration: none;
}
.sent-file img {
  max-width: 160px;
  max-height: 120px;
  border-radius: 8px;
  border: 1px solid var(--line);
  object-fit: cover;
}
.sent-file .file-ico {
  width: 32px;
  height: 32px;
  border-radius: 6px;
}
.voice-panel {
  max-width: 780px;
  width: calc(100% - 48px);
  margin: 0 auto 10px;
}
.composer .rec {
  color: var(--danger);
  background: var(--danger-soft);
}
.composer textarea {
  flex: 1;
  min-width: 0;
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
  .composer,
  .voice-panel {
    width: calc(100% - 24px);
    margin-bottom: 10px;
  }
}
</style>
