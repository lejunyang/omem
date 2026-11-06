<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { get } from "../api";
import Icon from "../components/Icon.vue";
import Markdown from "../components/Markdown.vue";
import Skeleton from "../components/Skeleton.vue";
import VoiceChat from "../components/VoiceChat.vue";
import { voiceStatus, type VoiceStatus } from "../lib/voice";
import { fmtTime, state } from "../store";

/**
 * English speaking practice: pick a scene, talk it through with the voice model (it plays the other
 * person; ask in Chinese whenever you are stuck), and get an honest assessment afterwards from the
 * speaking-coach role. Past practices with their reviews below.
 */
type Session = { id: string; scenario: string; api: string; model: string; transcript: { role: "user" | "assistant"; text: string }[]; startedAt: string; endedAt: string; reviewRunId: string | null; review: string | null; reviewStatus: string | null };

const SCENES = [
  "求职面试：介绍自己和最近做过的项目",
  "在餐厅点餐，问推荐菜，说明忌口",
  "机场值机：托运行李、换座位、航班延误",
  "和外国同事讨论项目进度和风险",
  "酒店入住，房间有问题要换房",
  "看病：向医生描述症状",
  "电话里和客服沟通退款",
  "闲聊：周末做了什么、最近在看的剧",
];

const status = ref<VoiceStatus | null>(null);
const scenario = ref("");
const talking = ref(false);
const sessions = ref<Session[] | null>(null);
const open = ref<string | null>(null);
let timer: ReturnType<typeof setTimeout> | undefined;

async function load() {
  sessions.value = (await get<{ sessions: Session[] }>("/api/voice/sessions?purpose=practice")).sessions;
  clearTimeout(timer);
  // A review being written: look again shortly.
  if (sessions.value.some((s) => s.reviewRunId && !s.review && s.reviewStatus !== "failed" && s.reviewStatus !== "cancelled")) timer = setTimeout(load, 4000);
}
onMounted(async () => {
  status.value = await voiceStatus().catch(() => null);
  await load().catch(() => (sessions.value = []));
});
onBeforeUnmount(() => clearTimeout(timer));

function start() {
  talking.value = true;
}
async function ended(saved: { id: string; reviewRunId: string | null } | null) {
  talking.value = false;
  await load();
  if (saved) open.value = saved.id;
}
const minutes = (s: Session) => Math.max(1, Math.round((Date.parse(s.endedAt) - Date.parse(s.startedAt)) / 60_000));
const userTurns = (s: Session) => s.transcript.filter((t) => t.role === "user").length;
const empty = computed(() => sessions.value !== null && !sessions.value.length);
</script>

<template>
  <div class="page speaking">
    <div class="page-head"><div><h1>口语练习</h1><p class="muted">选一个场景，用英语和语音模型对话；它扮演场景里的另一个人。卡住时直接用中文问“这个怎么说”。结束后会给出真实的水平评价和改法。</p></div></div>

    <div v-if="status && !status.ready" class="card pad stack">
      <strong>语音模型还没配好</strong>
      <p class="muted small">{{ status.detail }}。到 <RouterLink to="/settings?tab=agents&section=voice">设置 → AI → 语音</RouterLink> 选好提供方（要先在 API key 里添加 OpenAI 的 key）。</p>
    </div>

    <template v-else-if="status">
      <VoiceChat v-if="talking" purpose="practice" :scenario="scenario.trim()" :space="state.space" @ended="ended" />
      <form v-else class="card pad stack" @submit.prevent="start">
        <label class="field"><span>场景（可以写中文，也可以留空自由聊）</span><input v-model="scenario" class="input" maxlength="300" placeholder="例如：在咖啡店点单，想要燕麦奶、少冰" /></label>
        <div class="row wrap scenes">
          <button v-for="s in SCENES" :key="s" type="button" class="chip" :class="{ on: scenario === s }" @click="scenario = s">{{ s }}</button>
        </div>
        <div class="row"><span class="muted small">用 {{ status.api === "live" ? "GPT-Live" : "Realtime" }}（{{ status.model }}）；需要麦克风权限，戴耳机效果更好。</span><span class="spacer" /><button class="btn primary"><Icon name="mic" :size="15" />开始练习</button></div>
      </form>
    </template>

    <h2 class="hist">练习记录</h2>
    <Skeleton v-if="sessions === null" :rows="3" />
    <p v-else-if="empty" class="muted">还没有练习记录。</p>
    <div v-else class="stack">
      <div v-for="s in sessions" :key="s.id" class="card">
        <button class="srow" :aria-expanded="open === s.id" @click="open = open === s.id ? null : s.id">
          <div class="grow">
            <div class="ellipsis"><strong>{{ s.scenario || "自由对话" }}</strong></div>
            <div class="small muted">{{ fmtTime(s.startedAt) }} · {{ minutes(s) }} 分钟 · 你说了 {{ userTurns(s) }} 次</div>
          </div>
          <span v-if="s.review" class="badge ok">已评价</span>
          <span v-else-if="s.reviewStatus === 'failed'" class="badge">评价失败</span>
          <span v-else-if="s.reviewRunId" class="badge">评价中…</span>
          <Icon :name="open === s.id ? 'down' : 'right'" :size="14" />
        </button>
        <div v-if="open === s.id" class="sbody stack">
          <Markdown v-if="s.review" :source="s.review" />
          <p v-else-if="s.reviewRunId && s.reviewStatus !== 'failed'" class="muted small">正在写评价，通常一两分钟。</p>
          <p v-else-if="s.reviewRunId" class="muted small">评价没写出来，可以在 <RouterLink :to="`/runs/${s.reviewRunId}`">运行页</RouterLink> 看原因。</p>
          <details>
            <summary class="small muted">对话记录（{{ s.transcript.length }} 段）</summary>
            <div class="turns">
              <div v-for="(t, i) in s.transcript" :key="i" class="turn"><span class="small muted">{{ t.role === "user" ? "你" : "对方" }}</span><span>{{ t.text }}</span></div>
            </div>
          </details>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.speaking {
  max-width: 820px;
}
.scenes {
  gap: 6px;
}
.hist {
  margin: 28px 0 12px;
  font-size: 18px;
}
.srow {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 12px 14px;
  border: 0;
  background: none;
  text-align: left;
  cursor: pointer;
  color: inherit;
  min-width: 0;
}
.srow .grow {
  min-width: 0;
}
.sbody {
  padding: 0 14px 14px;
}
.turns {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 8px;
}
.turn {
  display: grid;
  grid-template-columns: 34px 1fr;
  gap: 8px;
  overflow-wrap: anywhere;
}
</style>
