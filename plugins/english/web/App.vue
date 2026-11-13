<script setup lang="ts">
import DOMPurify from "dompurify";
import { marked } from "marked";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef } from "vue";
import { connect, type Omem, type VoiceStatus } from "@omem-ai/plugin-sdk";
import Skeleton from "../../../web/src/components/Skeleton.vue";
import UiSegmented from "../../../web/src/components/UiSegmented.vue";
import GenericBlock from "./GenericBlock.vue";
import Progress from "./Progress.vue";
import QuizCard from "./QuizCard.vue";
import SpeakingCard from "./SpeakingCard.vue";
import { SPEAKING_PREFIX, type Block, type Message, type Session, type SessionInfo, type Snapshot, type SpeakingBlock } from "./types";

/**
 * 英语练习: a session with the tutor (english-tutor), in one of two ways. Questions: the tutor
 * hands in batches (english_quiz), the owner answers and submits each batch, the tutor reads the
 * graded result and goes on. Speaking: the owner talks a scene through with the voice model
 * (a `speaking` block; the shell holds the microphone), the transcript goes to the tutor, who
 * assesses it. Everything goes through the shell (@omem-ai/plugin-sdk), never straight to /api.
 */
let omem: Omem | null = null;
const api = shallowRef<Omem | null>(null);
const sessions = ref<SessionInfo[]>([]);
const current = ref<Session | null>(null);
const snap = ref<Snapshot | null>(null);
const loading = ref(true);
const error = ref("");
const draft = ref("");
const sending = ref(false);
const history = ref(false);
const timeline = ref<HTMLElement | null>(null);

const SCENES = ["餐厅点餐", "旅行问路", "工作邮件", "开会讨论", "面试", "看病", "日常闲聊"];
const FOCUS = ["混合", "词汇", "语法", "听力", "翻译"];
const scene = ref(SCENES[0]);
const focus = ref(FOCUS[0]);
const MODES: { value: "quiz" | "speaking"; label: string }[] = [
  { value: "quiz", label: "做题" },
  { value: "speaking", label: "口语对话" },
];
const mode = ref<"quiz" | "speaking">("quiz");
const goal = ref("");
const voice0 = ref<VoiceStatus | null>(null);
/** The speaking block the owner just asked for with a click: its card starts the call at once. */
const autostart = ref<string | null>(null);
const refreshVoice = async () => {
  voice0.value = await omem?.voiceStatus().catch(() => voice0.value) ?? null;
};
const isSpeaking = (s: { title: string } | null) => !!s?.title.startsWith(SPEAKING_PREFIX);
const speaking = computed(() => isSpeaking(current.value));
const asSpeaking = (b: Block) => b as unknown as SpeakingBlock;

type Entry = { kind: "message"; at: string; message: Message } | { kind: "block"; at: string; block: Block };
const entries = computed<Entry[]>(() => {
  const s = current.value;
  if (!s) return [];
  // The tutor's words are stored when its turn ends, after the blocks it handed in: put a
  // block right after the reply of the turn that made it.
  const replyAt = new Map(s.messages.filter((m) => m.role === "assistant" && m.runId).map((m) => [m.runId!, m.createdAt]));
  const out: Entry[] = [
    ...s.messages.map((m) => ({ kind: "message" as const, at: m.createdAt, message: m })),
    ...s.blocks.map((b) => ({ kind: "block" as const, at: (b.runId && replyAt.get(b.runId)) ? `${replyAt.get(b.runId)}~` : b.createdAt, block: b })),
  ];
  return out.sort((a, b) => a.at.localeCompare(b.at));
});
const md = (text: string) => DOMPurify.sanitize(marked.parse(text, { async: false }) as string);
const settings = computed(() => snap.value?.settings ?? { source: "bank", quizSize: "8", voice: "en-US", rate: "1", dailyGoal: 30 });
const voice = computed(() => ({ lang: settings.value.voice, rate: Number(settings.value.rate) || 1 }));
/** The scene a session is about: its title is "<scene> · <date>" (speaking: "口语 · <scene> · <date>"). */
const sceneOf = (s: { title: string } | null) => (s?.title.startsWith(SPEAKING_PREFIX) ? s.title.slice(SPEAKING_PREFIX.length) : s?.title ?? "").split(" · ")[0].trim();
/** The note in place of a handed-in message: which kind of block it handed in. */
const submittedNote = (m: Message) => (current.value?.blocks.find((b) => b.id === m.submission)?.kind === "speaking" ? "对话记录已交给陪练" : "已提交这一组");
// The next set is up to the owner when nothing is waiting to be answered and the tutor is idle.
const canDraw = computed(() => !!current.value && !current.value.busy && !current.value.blocks.some((b) => b.status === "open"));
const drawNote = ref("");

async function loadSnapshot() {
  try {
    const r = await omem!.post<{ text: string }>("call/english_snapshot", { format: "json" });
    snap.value = JSON.parse(r.text) as Snapshot;
  } catch {
    // The panel just stays as it was; the practice itself does not depend on it.
  }
}

let lastBusy: string | null = null;
async function loadSession(id: string, scroll = false) {
  const s = await omem!.get<Session>(`sessions/${id}`);
  current.value = s;
  if (lastBusy && !s.busy) void loadSnapshot();
  lastBusy = s.busy;
  if (scroll) {
    await nextTick();
    timeline.value?.lastElementChild?.scrollIntoView({ block: "end" });
  }
}

let timer: ReturnType<typeof setTimeout> | null = null;
const refresh = (scroll = true) => {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => current.value && void loadSession(current.value.id, scroll).catch(() => {}), 250);
};

/** From the bank, at once; false when the bank cannot make a set for this scene. */
async function drawFromBank(id: string, sceneName: string) {
  const r = JSON.parse((await omem!.post<{ text: string }>("call/english_next", { session_id: id, scene: sceneName || undefined })).text) as { drawn: boolean; bank: number };
  if (snap.value) snap.value = { ...snap.value, bank: { ...snap.value.bank, total: r.bank } };
  return r.drawn;
}

async function start() {
  const text = `来一组「${scene.value}」场景的练习${focus.value === "混合" ? "" : `，侧重${focus.value}`}。`;
  sending.value = true;
  error.value = "";
  let id: string | null = null;
  try {
    id = (await omem!.post<{ id: string }>("sessions", { title: `${scene.value} · ${new Date().toLocaleDateString()}` })).id;
    // A focus asks for a particular mix the bank does not know about: that set is the tutor's.
    const fromBank = settings.value.source === "bank" && focus.value === "混合" && (await drawFromBank(id, scene.value.trim()));
    if (!fromBank) await omem!.post(`sessions/${id}/messages`, { text: settings.value.source === "bank" ? `${text}（题库里这个场景的题不够，请先出这一组，再补题库。）` : text });
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    // Open the session even if the first message failed: it can be sent again from there.
    sessions.value = await omem!.get<SessionInfo[]>("sessions").catch(() => sessions.value);
    if (id) await loadSession(id, true).catch(() => {});
    sending.value = false;
  }
}

/** A speaking practice in `id` (a new session, or once more in this one); its card starts the call. */
async function practise(id: string, sceneName: string, goalText?: string) {
  const r = JSON.parse((await omem!.post<{ text: string }>("call/english_speaking_start", { session_id: id, scene: sceneName, goal: goalText || undefined })).text) as { blockId: string };
  autostart.value = r.blockId;
}

async function startSpeaking() {
  sending.value = true;
  error.value = "";
  let id: string | null = null;
  try {
    const name = scene.value.trim();
    id = (await omem!.post<{ id: string }>("sessions", { title: `${SPEAKING_PREFIX}${name} · ${new Date().toLocaleDateString()}` })).id;
    await practise(id, name, goal.value.trim());
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    sessions.value = await omem!.get<SessionInfo[]>("sessions").catch(() => sessions.value);
    if (id) await loadSession(id, true).catch(() => {});
    sending.value = false;
  }
}

async function again() {
  if (!current.value) return;
  const id = current.value.id;
  sending.value = true;
  error.value = "";
  try {
    const last = [...current.value.blocks].reverse().find((b) => b.kind === "speaking") as unknown as SpeakingBlock | undefined;
    await practise(id, last?.data.scene ?? sceneOf(current.value), last?.data.goal);
    await loadSession(id, true);
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    sending.value = false;
  }
}

async function say() {
  const text = draft.value.trim();
  if (!text || !current.value) return;
  sending.value = true;
  error.value = "";
  try {
    await omem!.post(`sessions/${current.value.id}/messages`, { text });
    draft.value = "";
    await loadSession(current.value.id, true);
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    sending.value = false;
  }
}

async function next() {
  if (!current.value) return;
  const id = current.value.id;
  sending.value = true;
  drawNote.value = "";
  error.value = "";
  try {
    if (settings.value.source === "bank" && (await drawFromBank(id, sceneOf(current.value)))) await loadSession(id, true);
    else {
      if (settings.value.source === "bank") drawNote.value = "题库里的题不够，这一组请陪练现出。";
      await omem!.post(`sessions/${id}/messages`, { text: settings.value.source === "bank" ? "题库不够了，请出下一组，再补一下题库。" : "出下一组。" });
      await loadSession(id, true);
    }
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    sending.value = false;
  }
}

async function submit(block: Block, answers: Record<string, unknown>) {
  await omem!.post(`blocks/${block.id}/submit`, { answers });
  await loadSession(current.value!.id, true);
  void loadSnapshot();
}

const openSettings = () => omem?.openSettings();

function fresh() {
  current.value = null;
  history.value = false;
}
async function open(id: string) {
  history.value = false;
  await loadSession(id, true);
}
const onKey = (e: KeyboardEvent) => {
  if (e.key === "Escape") history.value = false;
};

let poll: ReturnType<typeof setInterval> | null = null;
onMounted(async () => {
  window.addEventListener("keydown", onKey);
  try {
    omem = await connect();
    api.value = omem;
    void refreshVoice();
    omem.on((e) => {
      if (e.type === "plugin" && e.settings) return void loadSnapshot();
      if (!current.value) return;
      if (e.type === "plugin" && e.conversationId === current.value.id) refresh();
      else if (e.type === "run" && current.value.busy) refresh();
    });
    sessions.value = await omem.get<SessionInfo[]>("sessions");
    // A link (a Feishu message) may name the session to open.
    const wanted = omem.params.session && sessions.value.some((s) => s.id === omem!.params.session) ? omem.params.session : sessions.value[0]?.id;
    if (wanted) await loadSession(wanted, true);
    void loadSnapshot();
    // Events can be missed (a reconnect); while the tutor is working, look again now and then.
    poll = setInterval(() => current.value?.busy && refresh(false), 4000);
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
});
// Back from setting up the voice model in another tab or the shell's settings.
const onFocus = () => void refreshVoice();
window.addEventListener("focus", onFocus);
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKey);
  window.removeEventListener("focus", onFocus);
  if (poll) clearInterval(poll);
});
</script>

<template>
  <div class="page">
    <header class="top row">
      <h1>英语练习</h1>
      <span class="spacer" />
      <div class="history">
        <button class="btn sm" type="button" :aria-expanded="history" :disabled="!sessions.length" @click="history = !history">历史</button>
        <ul v-if="history" class="history-list card" role="menu">
          <li v-for="s in sessions" :key="s.id">
            <button type="button" role="menuitem" :class="{ on: current?.id === s.id }" @click="open(s.id)">
              <span>{{ s.title || "练习" }}</span><span class="small muted">{{ s.updatedAt.slice(5, 16).replace("T", " ") }}</span>
            </button>
          </li>
        </ul>
      </div>
      <button class="btn sm ghost" type="button" @click="openSettings">设置</button>
      <button class="btn sm primary" type="button" @click="fresh">新练习</button>
    </header>

    <div class="layout">
      <main class="main">
        <p v-if="error" class="card err">{{ error }}</p>
        <Skeleton v-if="loading" variant="cards" :rows="2" />

        <section v-else-if="!current" class="welcome card">
          <div class="row wrap">
            <h2>练什么场景？</h2>
            <span class="spacer" />
            <UiSegmented v-model="mode" :options="MODES" size="sm" aria-label="练习方式" @change="(m) => m === 'speaking' && refreshVoice()" />
          </div>
          <p v-if="mode === 'quiz'" class="muted">陪练会按你现在的水平出一组题，做完一起提交，它看结果点评，再针对薄弱的地方出下一组。</p>
          <p v-else class="muted">用英语和语音模型把场景演一遍：它扮演场景里的另一个人，卡住时直接用中文问“这个怎么说”。说完陪练给出口语水平、四项分数和具体改法，说错的地方会进薄弱点，之后的题也会练到。</p>
          <div class="chips" role="group" aria-label="场景">
            <button v-for="s in mode === 'speaking' ? [...SCENES, '自由对话'] : SCENES" :key="s" type="button" class="chip" :class="{ on: scene === s }" :aria-pressed="scene === s" @click="scene = s">{{ s }}</button>
          </div>
          <input v-model="scene" class="input" aria-label="或者自己写一个场景" placeholder="或者自己写一个场景" />
          <div v-if="mode === 'quiz'" class="row wrap">
            <span class="small muted">侧重</span>
            <UiSegmented v-model="focus" :options="FOCUS.map((f) => ({ value: f, label: f }))" size="sm" aria-label="侧重" />
          </div>
          <template v-else>
            <input v-model="goal" class="input" maxlength="300" aria-label="这次想刻意练的说法（可选）" placeholder="这次想刻意练的说法（可选），例如：用 Could I… / I'd like… 点餐" />
            <div v-if="voice0 && !voice0.ready" class="voice-note">
              <p><strong>语音模型还没配好</strong></p>
              <p class="small muted">{{ voice0.detail }}。口语对话要用 OpenAI 的语音模型：到 设置 → AI → 语音 选好提供方（先在 API key 里添加 OpenAI 的 key），回来就能开始。</p>
              <div class="row"><button class="btn sm" type="button" @click="api?.navigate('/settings?tab=agents&section=voice')">打开语音设置</button></div>
            </div>
          </template>
          <div class="row wrap">
            <button v-if="mode === 'quiz'" class="btn primary" type="button" :disabled="sending || !scene.trim()" @click="start">{{ sending ? "开始中…" : "开始" }}</button>
            <template v-else>
              <button class="btn primary" type="button" :disabled="sending || !scene.trim() || !voice0?.ready" @click="startSpeaking">{{ sending ? "开始中…" : "开始对话" }}</button>
              <span v-if="voice0?.ready" class="small muted">需要麦克风权限，戴耳机效果更好</span>
            </template>
          </div>
        </section>

        <template v-else>
          <div ref="timeline" class="timeline">
            <template v-for="e in entries" :key="e.kind === 'block' ? e.block.id : e.message.id">
              <QuizCard v-if="e.kind === 'block' && e.block.kind === 'quiz'" :block="e.block" :voice="voice" :submit="(a) => submit(e.block, a)" />
              <SpeakingCard v-else-if="e.kind === 'block' && e.block.kind === 'speaking' && api" :block="asSpeaking(e.block)" :omem="api" :status="voice0" :autostart="autostart === e.block.id" :submit="(a) => submit(e.block, a)" />
              <GenericBlock v-else-if="e.kind === 'block'" :block="e.block" :submit="(a) => submit(e.block, a)" />
              <p v-else-if="e.message.submission" class="note small muted">{{ submittedNote(e.message) }}</p>
              <div v-else-if="e.message.role === 'assistant'" class="bot md" v-html="md(e.message.text)" />
              <p v-else class="me">{{ e.message.text }}</p>
            </template>
            <p v-if="current.busy" class="note small muted" aria-live="polite">{{ speaking ? "陪练在听这次的对话…" : "陪练在准备…" }}</p>
          </div>
          <div v-if="canDraw && speaking" class="next row">
            <button class="btn primary" type="button" :disabled="sending || !voice0?.ready" @click="again">{{ sending ? "准备中…" : "再练一次" }}</button>
            <span class="small muted">同一个场景再说一遍，试试评价里的改法</span>
          </div>
          <div v-else-if="canDraw" class="next row">
            <button class="btn primary" type="button" :disabled="sending" @click="next">{{ sending ? "准备中…" : "下一组" }}</button>
            <span class="small muted">{{ drawNote || (settings.source === "bank" ? `从题库里按你的情况挑，题库还有 ${snap?.bank.total ?? 0} 题` : "陪练按刚才的结果现出，要等一两分钟") }}</span>
          </div>
          <form class="composer" @submit.prevent="say">
            <textarea v-model="draft" class="textarea" rows="2" :placeholder="speaking ? '和陪练说：这句怎么说更自然 / 换个难一点的场景（Ctrl+Enter 发送）' : '和陪练说：太难了 / 多来点听力 / 这个词怎么用（Ctrl+Enter 发送）'" aria-label="和陪练说" @keydown.enter.ctrl.prevent="say" @keydown.enter.meta.prevent="say" />
            <button class="btn" type="submit" :disabled="sending || !draft.trim()">发送</button>
          </form>
        </template>
      </main>
      <Progress class="side" :snap="snap" :goal="Number(settings.dailyGoal) || 0" />
    </div>
  </div>
</template>

<style scoped>
.page {
  max-width: 1120px;
  margin: 0 auto;
  padding: 20px 24px 28px;
  display: grid;
  gap: 16px;
}
.top h1 {
  font-size: 22px;
}
.history {
  position: relative;
}
.history-list {
  position: absolute;
  right: 0;
  top: calc(100% + 4px);
  z-index: 5;
  list-style: none;
  margin: 0;
  padding: 4px;
  width: min(300px, calc(100vw - 32px));
  max-height: 360px;
  overflow-y: auto;
  box-shadow: var(--shadow);
}
.history-list button {
  width: 100%;
  display: flex;
  justify-content: space-between;
  gap: 8px;
  border: 0;
  background: none;
  text-align: left;
  padding: 6px 8px;
  border-radius: 6px;
  cursor: pointer;
}
.history-list button:hover,
.history-list button.on {
  background: var(--hover);
}
.layout {
  display: grid;
  grid-template-columns: minmax(0, 760px) 280px;
  gap: 20px;
  justify-content: center;
  align-items: start;
}
.side {
  position: sticky;
  top: 16px;
}
.main {
  display: grid;
  gap: 14px;
  min-width: 0;
}
.welcome {
  padding: 20px;
  display: grid;
  gap: 12px;
}
.welcome h2 {
  font-size: 18px;
}
.voice-note {
  display: grid;
  gap: 6px;
  padding: 12px;
  border-radius: var(--radius-sm);
  background: var(--warn-soft);
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}
.timeline {
  display: grid;
  gap: 14px;
}
.bot {
  font-size: 14.5px;
  overflow-wrap: anywhere;
}
.me {
  justify-self: end;
  max-width: 85%;
  background: var(--accent-soft);
  border-radius: 12px 12px 4px 12px;
  padding: 7px 12px;
  overflow-wrap: anywhere;
}
.note {
  text-align: center;
}
.next {
  flex-wrap: wrap;
}
.composer .textarea {
  min-height: 0;
}
.composer {
  display: flex;
  gap: 8px;
  align-items: flex-end;
  position: sticky;
  bottom: 0;
  padding: 10px 0 4px;
  background: var(--bg);
}
.err {
  padding: 10px 14px;
  color: var(--danger);
  background: var(--danger-soft);
  border-color: transparent;
}
@media (max-width: 960px) {
  .layout {
    grid-template-columns: minmax(0, 1fr);
  }
  .side {
    position: static;
    order: -1;
  }
}
@media (max-width: 600px) {
  .page {
    padding: 14px 16px 20px;
  }
}
</style>
