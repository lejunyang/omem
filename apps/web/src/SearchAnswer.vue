<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { OmButton, OmCitation, OmDisclosure, OmMarkdown, OmPanel } from "@omem/ui";
import { api, type AssistantSearchResult, type AssistantSearchTurn } from "./api";
import { readAssistantAnswer } from "./assistant-reader";
import type { RetrievalPurpose } from "../../server/src/retrieval/port";
import type { KnowledgeFrame } from "./knowledge/api";

const props = defineProps<{ query: string; purpose: RetrievalPurpose }>();
const emit = defineEmits<{ navigate: [frame: KnowledgeFrame]; open: [id: string]; results: [] }>();
const conversationId = ref("");
const turns = ref<AssistantSearchTurn[]>([]);
const busy = ref(false), stopping = ref(false), error = ref("");
const progressError = ref("");
const followUp = ref("");
let generation = 0, disposed = false;
type RunningRequest = {
  generation: number;
  conversationId: string;
  requestId: string;
  turnId?: string;
  cancelRequested: boolean;
  cancelling: boolean;
  finished: boolean;
  responseFinished: boolean;
  timer?: ReturnType<typeof setTimeout>;
  controller: AbortController;
};
let activeRequest: RunningRequest | undefined;
const readableTurns = computed(() => turns.value.map((turn) => ({
  ...turn,
  reading: readAssistantAnswer(turn.result || "", turn.selectedEvidence || []),
})));
const latestTurn = computed(() => turns.value.at(-1));
const completed = computed(() => turns.value.some((turn) => !!turn.result));

function researchActivity(turn?: AssistantSearchTurn): string[] {
  if (!Array.isArray(turn?.toolActions)) return [];
  return turn.toolActions.flatMap((action: unknown) => {
    if (!action || typeof action !== "object") return [];
    const item = action as Record<string, unknown>;
    if (item.tool !== "research" || !Array.isArray(item.activity)) return [];
    return item.activity.flatMap((activity: unknown) => {
      if (typeof activity === "string") return [activity];
      if (!activity || typeof activity !== "object") return [];
      const event = activity as Record<string, unknown>;
      const label = event.label ?? event.description ?? event.title ?? event.text;
      return typeof label === "string" && label.trim() ? [label] : [];
    });
  });
}
const currentActivity = computed(() => latestTurn.value && ["pending", "running"].includes(latestTurn.value.inputMessageRefs.status)
  ? researchActivity(latestTurn.value) : []);
const progressLabel = computed(() => stopping.value
  ? "正在停止本次调查…"
  : currentActivity.value.at(-1) || "正在查找和补读相关材料…");
const isCurrent = (request: RunningRequest) => !disposed && request.generation === generation;

function readCitation(turn: (typeof readableTurns.value)[number], key: string) {
  const index = turn.reading.citations.findIndex((citation) => citation.key === key);
  const evidence = turn.reading.references[index];
  if (!evidence) return;
  if (evidence.sourceTarget) emit("navigate", {
    kind: "source",
    id: JSON.stringify(evidence.sourceTarget),
    title: turn.reading.citations[index]!.label,
  });
  else emit("open", evidence.fragmentId);
}

async function cancelRequest(request: RunningRequest) {
  request.cancelRequested = true;
  if (!request.turnId || request.cancelling) return;
  request.cancelling = true;
  try {
    await api(`/assistant/conversations/${request.conversationId}/turns/${request.turnId}/cancel`, {});
    if (isCurrent(request)) await reload(request);
  } catch (cause) {
    if (isCurrent(request)) {
      error.value = `未能停止调查：${String(cause)}`;
      stopping.value = false;
      request.cancelRequested = false;
    }
  } finally {
    request.cancelling = false;
  }
}

async function reload(request: RunningRequest) {
  const current = await api<AssistantSearchTurn[]>(`/assistant/conversations/${request.conversationId}/turns`);
  const turn = request.turnId
    ? current.find((item) => item.id === request.turnId)
    : current.find((item) => item.inputMessageRefs.transportEventId === `web:${request.requestId}`);
  if (turn) request.turnId = turn.id;
  const waitingForRecovery = turn?.inputMessageRefs.status === "pending" && !!turn.inputMessageRefs.error && request.responseFinished;
  if (turn && (["done", "failed", "cancelled"].includes(turn.inputMessageRefs.status) || waitingForRecovery)) {
    request.finished = true;
    clearTimeout(request.timer);
  }
  if (isCurrent(request)) {
    progressError.value = "";
    turns.value = current;
    if (request.finished) {
      busy.value = false;
      stopping.value = false;
    }
  }
  if (request.cancelRequested && turn && ["pending", "running"].includes(turn.inputMessageRefs.status))
    await cancelRequest(request);
}

function poll(request: RunningRequest) {
  if (request.finished || (!isCurrent(request) && !request.cancelRequested)) return;
  clearTimeout(request.timer);
  request.timer = setTimeout(async () => {
    try { await reload(request); }
    catch (cause) {
      if (isCurrent(request)) progressError.value = `暂时无法读取调查进度：${String(cause)}`;
    }
    poll(request);
  }, 1500);
}

async function send(text: string, retryTurnId?: string) {
  if (busy.value || !text.trim()) return;
  const currentGeneration = generation;
  busy.value = true;
  stopping.value = false;
  error.value = "";
  progressError.value = "";
  try {
    if (!conversationId.value) {
      const conversation = await api<{ id: string }>("/assistant/conversations", {
        chatId: `web-search-${crypto.randomUUID()}`,
      });
      if (disposed || generation !== currentGeneration) return;
      conversationId.value = conversation.id;
    }
    const request: RunningRequest = {
      generation: currentGeneration,
      conversationId: conversationId.value,
      requestId: crypto.randomUUID(),
      ...(retryTurnId ? { turnId: retryTurnId } : {}),
      cancelRequested: stopping.value,
      cancelling: false,
      finished: false,
      responseFinished: false,
      controller: new AbortController(),
    };
    activeRequest = request;
    poll(request);
    const response = retryTurnId
      ? await api<AssistantSearchResult>(`/assistant/conversations/${request.conversationId}/turns/${retryTurnId}/retry`, {}, "POST", request.controller.signal)
      : await api<AssistantSearchResult>(`/assistant/conversations/${request.conversationId}/turns`, {
        text: text.trim(), mode: "research", purpose: props.purpose, requestId: request.requestId,
      }, "POST", request.controller.signal);
    request.responseFinished = true;
    if (response.turn) request.turnId = response.turn.id;
    await reload(request);
    if (isCurrent(request) && !busy.value) followUp.value = "";
  } catch (cause) {
    if (disposed || generation !== currentGeneration) return;
    error.value = `回答未完成：${String(cause)}`;
    if (activeRequest) await reload(activeRequest).catch(() => {});
    // A failed HTTP connection may leave a real server turn running. Keep
    // polling that turn rather than starting a second investigation.
    if (!turns.value.some((turn) => ["running", "pending"].includes(turn.inputMessageRefs.status))) {
      busy.value = false;
      stopping.value = false;
      if (activeRequest) {
        activeRequest.finished = true;
        clearTimeout(activeRequest.timer);
      }
    }
  }
}

function stop() {
  stopping.value = true;
  if (activeRequest) void cancelRequest(activeRequest);
}
function reset() {
  generation++;
  if (activeRequest) {
    // Keep observing the request until the server's persisted turn is known.
    // Aborting just the HTTP connection would not stop the model process.
    const previous = activeRequest;
    previous.cancelRequested = true;
    void reload(previous).catch(() => {});
    poll(previous);
  }
  activeRequest = undefined;
  conversationId.value = "";
  turns.value = [];
  busy.value = false;
  stopping.value = false;
  error.value = "";
  progressError.value = "";
  followUp.value = "";
}
watch(() => [props.query.trim(), props.purpose], reset, { flush: "sync" });
onBeforeUnmount(() => { disposed = true; reset(); });
</script>

<template>
  <OmPanel class="search-answer" title="综合回答">
    <template #heading><OmButton variant="ghost" @click="emit('results')">查看实际命中</OmButton></template>
    <p v-if="!turns.length && !busy" class="answer-intro">
      围绕当前问题查找、补读材料，整理成带引用的回答。下方保留实际搜索命中，方便对照。
    </p>
    <div v-if="!turns.length && !busy" class="answer-actions">
      <OmButton variant="primary" @click="send(query)">{{ error ? '重试综合回答' : '综合回答' }}</OmButton>
    </div>
    <div v-if="busy" class="research-progress" role="status" aria-live="polite">
      <p><span class="progress-spinner" aria-hidden="true" />{{ progressLabel }}</p>
      <OmButton variant="secondary" :disabled="stopping" @click="stop">{{ stopping ? '正在停止' : '停止调查' }}</OmButton>
    </div>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="busy && progressError" role="status">{{ progressError }}，正在继续等待回答。</p>
    <div v-for="(turn, index) in readableTurns" :key="turn.id" class="answer-turn">
      <p v-if="index > 0" class="follow-up-question"><b>继续追问：</b>{{ turn.inputText }}</p>
      <OmMarkdown v-if="turn.result" class="answer-body" :source="turn.reading.source" :citations="turn.reading.citations" @cite="readCitation(turn, $event)" />
      <p v-else-if="turn.inputMessageRefs.status === 'failed'">本次调查没有完成，可以重试；原始搜索结果仍可继续阅读。</p>
      <p v-else-if="turn.inputMessageRefs.status === 'pending' && turn.inputMessageRefs.error && !busy">调查暂时无法完成，问题已保留，可以重试；原始搜索结果仍可继续阅读。</p>
      <p v-else-if="turn.inputMessageRefs.status === 'cancelled'">已停止本次调查。</p>
      <OmDisclosure v-if="turn.inputMessageRefs.error && ['pending', 'failed'].includes(turn.inputMessageRefs.status) && !busy" class="research-history" title="查看失败原因"><p class="error">{{ turn.inputMessageRefs.error }}</p></OmDisclosure>
      <div v-if="turn.reading.additional.length" class="additional-sources">
        <span>相关材料</span>
        <OmCitation v-for="citation in turn.reading.additional" :key="citation.key" :label="citation.label" @open="readCitation(turn, citation.key)" />
      </div>
      <OmDisclosure v-if="researchActivity(turn).length" class="research-history" title="查看调查过程">
        <ol><li v-for="(activity, activityIndex) in researchActivity(turn)" :key="activityIndex">{{ activity }}</li></ol>
      </OmDisclosure>
      <OmButton v-if="['failed', 'cancelled', 'pending'].includes(turn.inputMessageRefs.status) && !busy" @click="send(turn.inputText, turn.inputMessageRefs.status === 'pending' ? turn.id : undefined)">{{ turn.inputMessageRefs.status === 'pending' ? '重试这次调查' : '重新调查' }}</OmButton>
    </div>
    <form v-if="completed" class="answer-follow-up" @submit.prevent="send(followUp)">
      <label for="search-answer-follow-up">继续追问这个问题</label>
      <textarea id="search-answer-follow-up" v-model="followUp" rows="2" maxlength="2000" placeholder="哪些材料支持这个结论？还有什么背景需要补查？" :disabled="busy" />
      <p v-if="busy" class="follow-up-progress" role="status" aria-live="polite">{{ progressLabel }}</p>
      <div class="follow-up-actions">
        <OmButton type="submit" variant="secondary" :disabled="busy || !followUp.trim()">{{ busy ? '正在继续调查' : '继续查找并回答' }}</OmButton>
        <OmButton v-if="busy" variant="secondary" :disabled="stopping" @click="stop">{{ stopping ? '正在停止' : '停止继续调查' }}</OmButton>
      </div>
    </form>
  </OmPanel>
</template>

<style scoped>
.search-answer { margin: 28px 0 36px; }
.search-answer :deep(> header) { justify-content: space-between; flex-wrap: wrap; }
.answer-intro { color: var(--om-secondary); max-width: 76ch; }
.answer-actions, .additional-sources { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.research-progress { display: flex; align-items: center; gap: 16px; justify-content: space-between; }
.research-progress p { display: flex; align-items: center; gap: 12px; min-width: 0; overflow-wrap: anywhere; }
.research-progress .om-button { flex-shrink: 0; }
.progress-spinner { flex: 0 0 18px; width: 18px; height: 18px; border: 2px solid var(--om-line); border-top-color: var(--om-ink); border-radius: 50%; animation: progress-turn 0.8s linear infinite; }
.answer-turn + .answer-turn { border-top: 1px solid var(--om-line); margin-top: 28px; padding-top: 24px; }
.answer-body, .follow-up-question { max-width: 76ch; overflow-wrap: anywhere; }
.additional-sources { margin-top: 24px; font-size: 13px; color: var(--om-muted); }
.research-history { margin-top: 20px; }
.research-history ol { padding-left: 24px; max-width: 76ch; color: var(--om-secondary); font-size: 13px; }
.research-history li { margin: 8px 0; overflow-wrap: anywhere; }
.answer-follow-up { display: grid; gap: 12px; margin-top: 28px; max-width: 76ch; }
.answer-follow-up label { font-size: 14px; font-weight: 600; }
.answer-follow-up textarea { width: 100%; padding: 12px; border: 1px solid var(--om-line); border-radius: 6px; background: var(--om-panel); color: var(--om-ink); font: inherit; line-height: 1.8; resize: vertical; }
.answer-follow-up .om-button { justify-self: start; }
.follow-up-progress { margin: 0; font-size: 14px; color: var(--om-secondary); overflow-wrap: anywhere; }
.follow-up-actions { display: flex; gap: 12px; flex-wrap: wrap; }
.error { color: var(--om-danger); overflow-wrap: anywhere; }
@keyframes progress-turn { to { transform: rotate(360deg); } }
@media (max-width: 700px) { .research-progress { align-items: flex-start; flex-direction: column; gap: 8px; } .research-progress p { margin-top: 0; } }
@media (prefers-reduced-motion: reduce) { .progress-spinner { animation: none; } }
</style>
