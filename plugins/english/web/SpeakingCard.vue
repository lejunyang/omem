<script setup lang="ts">
import DOMPurify from "dompurify";
import { marked } from "marked";
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import type { Omem, OmemVoice, VoiceStatus, VoiceTurn } from "@omem-ai/plugin-sdk";
import Icon from "../../../web/src/components/Icon.vue";
import { SCORE_LABEL, type SpeakingBlock } from "./types";

/**
 * One speaking practice: talk the scene through with the voice model, then it is handed in and the
 * tutor's assessment shows up under it. The shell holds the microphone and the connection
 * (omem.voice); this card only sees the transcript.
 */
const props = defineProps<{
  block: SpeakingBlock;
  omem: Omem;
  status: VoiceStatus | null;
  /** Start right away (the owner just clicked “开始对话” on the welcome card). */
  autostart?: boolean;
  submit: (answers: Record<string, unknown>) => Promise<void>;
}>();

type Phase = "idle" | "connecting" | "live" | "saving";
const phase = ref<Phase>("idle");
const turns = ref<VoiceTurn[]>([]);
const muted = ref(false);
const error = ref("");
const box = ref<HTMLElement | null>(null);
let call: OmemVoice | null = null;

const open = computed(() => props.block.status === "open");
const result = computed(() => props.block.result);
const said = computed(() => result.value?.transcript.filter((t) => t.role === "user").length ?? 0);
const ready = computed(() => !!props.status?.ready);
const md = (text: string) => DOMPurify.sanitize(marked.parse(text, { async: false }) as string);
const scroll = () => void nextTick(() => box.value?.scrollTo({ top: box.value.scrollHeight }));

async function start() {
  if (phase.value !== "idle" || !ready.value) return;
  error.value = "";
  phase.value = "connecting";
  turns.value = [];
  muted.value = false;
  try {
    const brief = JSON.parse((await props.omem.post<{ text: string }>("call/english_speaking_brief", { block_id: props.block.id })).text) as { instructions: string };
    call = await props.omem.voice({
      instructions: brief.instructions,
      onTurns: (t) => {
        turns.value = t;
        scroll();
      },
      onState: (s, detail) => {
        if (s === "live") phase.value = "live";
        if (s === "failed" && detail) error.value = detail;
      },
    });
    phase.value = "live";
    void call.ended.then(hand);
  } catch (e) {
    call = null;
    phase.value = "idle";
    // Not started from a click (the shell refuses that): the button below does it.
    if ((e as { code?: string }).code !== "gesture") error.value = (e as Error).message;
  }
}

async function hand(record: Awaited<OmemVoice["ended"]>) {
  call = null;
  if (!record.transcript.some((t) => t.role === "user" && t.text.trim())) {
    phase.value = "idle";
    if (!error.value) error.value = "这次还没有说话，没有交给陪练。可以再开始一次。";
    return;
  }
  phase.value = "saving";
  try {
    await props.submit({ transcript: record.transcript, startedAt: record.startedAt, endedAt: record.endedAt, model: record.model });
  } catch (e) {
    error.value = `没有交上：${(e as Error).message}`;
  } finally {
    phase.value = "idle";
  }
}

const end = () => void call?.stop();
function toggleMute() {
  muted.value = !muted.value;
  call?.mute(muted.value);
}
const settings = () => props.omem.navigate("/settings?tab=agents&section=voice");

onMounted(() => {
  if (props.autostart && open.value) void start();
});
onBeforeUnmount(() => void call?.stop());
</script>

<template>
  <section class="speaking card" :aria-label="`口语练习：${block.data.scene}`">
    <header class="head">
      <span class="badge">口语</span>
      <h2>{{ block.data.scene }}</h2>
      <span class="spacer" />
      <span v-if="!open && result" class="small muted">约 {{ result.minutes }} 分钟 · 你说了 {{ said }} 段</span>
    </header>
    <p v-if="block.data.goal" class="small muted">这次练：{{ block.data.goal }}</p>

    <template v-if="open">
      <div v-if="status && !ready" class="note">
        <p><strong>语音模型还没配好</strong></p>
        <p class="small muted">{{ status.detail }}。口语练习要用 OpenAI 的语音模型：到 设置 → AI → 语音 选好提供方（先在 API key 里添加 OpenAI 的 key），回来就能开始。</p>
        <div class="row"><button class="btn sm" type="button" @click="settings">打开语音设置</button></div>
      </div>

      <template v-else-if="phase === 'idle'">
        <p class="small muted">语音模型扮演场景里的另一个人，它会先开口。卡住时直接用中文问“这个怎么说”。中途不纠错，结束后陪练给出水平评价和改法。戴耳机效果更好。</p>
        <div class="row foot">
          <span v-if="error" class="small err">{{ error }}</span>
          <span class="spacer" />
          <span v-if="status?.model" class="small muted">{{ status.api === "live" ? "GPT-Live" : "Realtime" }} · {{ status.model }}</span>
          <button class="btn primary" type="button" :disabled="!status" @click="start"><Icon name="mic" :size="15" />开始对话</button>
        </div>
      </template>

      <template v-else>
        <div class="live row">
          <span class="dot" :class="phase" aria-hidden="true" />
          <span class="small">{{ phase === "connecting" ? "正在连接…" : phase === "saving" ? "正在交给陪练…" : muted ? "已静音" : "正在听" }}</span>
          <span class="spacer" />
          <button v-if="phase === 'live'" class="btn ghost sm" type="button" :aria-pressed="muted" @click="toggleMute"><Icon name="mic" :size="14" />{{ muted ? "取消静音" : "静音" }}</button>
          <button v-if="phase !== 'saving'" class="btn primary sm" type="button" @click="end"><Icon name="stop" :size="13" />结束</button>
        </div>
        <div ref="box" class="turns" aria-live="polite">
          <p v-if="!turns.length && phase === 'live'" class="small muted">开口说吧。对方会先打招呼；不会说时可以直接用中文问。</p>
          <div v-for="(t, i) in turns" :key="i" class="turn" :class="t.role">
            <span class="who small muted">{{ t.role === "user" ? "你" : "对方" }}</span>
            <span class="said" :class="{ partial: !t.final }">{{ t.text }}</span>
          </div>
        </div>
        <p v-if="error" class="small err">{{ error }}</p>
      </template>
    </template>

    <template v-else-if="result">
      <div v-if="result.assessment" class="assessment">
        <div class="level"><span class="small muted">这次的口语水平</span><strong>{{ result.assessment.level }}</strong></div>
        <div class="scores">
          <div v-for="(v, k) in result.assessment.scores" :key="k" class="score" :title="v === null ? '这次看不出' : `${v} / 5`">
            <span class="small muted">{{ SCORE_LABEL[k] ?? k }}</span>
            <span class="bar" role="meter" :aria-label="SCORE_LABEL[k] ?? String(k)" aria-valuemin="0" aria-valuemax="5" :aria-valuenow="v ?? 0"><i :style="{ width: `${((v ?? 0) / 5) * 100}%` }" /></span>
            <span class="small">{{ v ?? "—" }}</span>
          </div>
        </div>
        <div class="md review" v-html="md(result.assessment.review)" />
      </div>
      <p v-else class="small muted" aria-live="polite">陪练在写评价，通常一两分钟。</p>
      <details>
        <summary class="small muted">对话记录（{{ result.transcript.length }} 段）</summary>
        <div class="turns done">
          <div v-for="(t, i) in result.transcript" :key="i" class="turn" :class="t.role">
            <span class="who small muted">{{ t.role === "user" ? "你" : "对方" }}</span>
            <span class="said">{{ t.text }}</span>
          </div>
        </div>
      </details>
    </template>
  </section>
</template>

<style scoped>
.speaking {
  padding: 16px 18px;
  display: grid;
  gap: 12px;
}
.head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.head h2 {
  font-size: 17px;
  overflow-wrap: anywhere;
  min-width: 0;
}
.note {
  display: grid;
  gap: 6px;
  padding: 12px;
  border-radius: var(--radius-sm);
  background: var(--warn-soft);
}
.foot {
  flex-wrap: wrap;
}
.live {
  flex-wrap: wrap;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--line);
}
.dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--muted);
  flex: none;
}
.dot.live {
  background: var(--ok);
  box-shadow: 0 0 0 4px var(--ok-soft);
}
.dot.connecting,
.dot.saving {
  background: var(--warn);
}
.turns {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 46vh;
  overflow-y: auto;
}
.turns.done {
  margin-top: 8px;
  max-height: none;
}
.turn {
  display: grid;
  grid-template-columns: 34px 1fr;
  gap: 8px;
  line-height: 1.6;
}
.turn.assistant .said {
  color: var(--ink-2);
}
.said {
  overflow-wrap: anywhere;
}
.said.partial::after {
  content: "…";
  color: var(--muted);
}
.assessment {
  display: grid;
  gap: 12px;
}
.scores {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 140px), 1fr));
  gap: 8px 16px;
  align-items: center;
}
.level {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.level strong {
  font-family: var(--serif);
  font-size: 20px;
}
.score {
  display: grid;
  grid-template-columns: 3.5em 1fr 1.5em;
  gap: 8px;
  align-items: center;
}
.bar {
  height: 6px;
  border-radius: 3px;
  background: var(--sunken);
  overflow: hidden;
}
.bar i {
  display: block;
  height: 100%;
  background: var(--accent);
  border-radius: 3px;
}
.review {
  font-size: 14.5px;
  overflow-wrap: anywhere;
}
.review :deep(table) {
  border-collapse: collapse;
  max-width: 100%;
  display: block;
  overflow-x: auto;
}
.review :deep(th),
.review :deep(td) {
  border: 1px solid var(--line);
  padding: 4px 8px;
  text-align: left;
}
summary {
  cursor: pointer;
}
.err {
  color: var(--danger);
}
</style>
