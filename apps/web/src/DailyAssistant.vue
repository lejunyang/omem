<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from "vue";
import {
  OmButton,
  OmPanel,
  OmCitation,
  OmEmpty,
  OmBadge,
  OmDisclosure,
  OmMarkdown,
} from "@omem/ui";
import { api } from "./api";
import { readAssistantAnswer, type AnswerEvidence } from "./assistant-reader";
import type { KnowledgeFrame } from "./knowledge/api";
type Turn = {
  id: string;
  inputText: string;
  result: string;
  inputMessageRefs: { status: string };
  selectedEvidence: AnswerEvidence[];
};
const emit = defineEmits<{
  open: [id: string];
  navigate: [frame: KnowledgeFrame];
  refresh: [];
}>();
const conversationId = ref(""),
  draft = ref(""),
  error = ref("");
const turns = ref<Turn[]>([]),
  sending = ref(false);
const readableTurns = computed(() =>
  turns.value.map((t) => ({
    ...t,
    reading: readAssistantAnswer(t.result || "", t.selectedEvidence || []),
  })),
);
function readCitation(turn: (typeof readableTurns.value)[number], key: string) {
  const index = turn.reading.citations.findIndex((c) => c.key === key);
  const e = turn.reading.references[index];
  if (!e) return;
  if (e.sourceTarget)
    emit("navigate", {
      kind: "source",
      id: JSON.stringify(e.sourceTarget),
      title: turn.reading.citations[index]!.label,
    });
  else emit("open", e.fragmentId);
}
let pendingRequest: { id: string; text: string } | null = null;
const workflows = ref<
  { id: string; title: string; trigger: string; output: string }[]
>([]);
const statuses: Record<string, string> = {
  done: "已处理",
  running: "处理中",
  pending: "等待重试",
  failed: "处理失败",
  cancelled: "已停止",
};
const busy = computed(
  () =>
    sending.value ||
    turns.value.some((t) => t.inputMessageRefs.status === "running"),
);
let timer: ReturnType<typeof setInterval> | undefined;
let disposed = false;
async function reload() {
  if (!conversationId.value) return;
  const result = await api<Turn[]>(
    `/assistant/conversations/${conversationId.value}/turns`,
  );
  if (!disposed) turns.value = result;
}
async function send() {
  if (busy.value || !draft.value.trim() || !conversationId.value) return;
  sending.value = true;
  error.value = "";
  try {
    const text = draft.value.trim();
    if (pendingRequest?.text !== text)
      pendingRequest = { id: crypto.randomUUID(), text };
    await api(`/assistant/conversations/${conversationId.value}/turns`, {
      text,
      requestId: pendingRequest.id,
    });
    pendingRequest = null;
    draft.value = "";
    await reload();
    emit("refresh");
  } catch (e) {
    error.value = String(e);
    await reload().catch(() => {});
  } finally {
    sending.value = false;
  }
}
async function retry(turn: Turn) {
  if (busy.value) return;
  sending.value = true;
  error.value = "";
  try {
    await api(
      `/assistant/conversations/${conversationId.value}/turns/${turn.id}/retry`,
      {},
    );
    await reload();
    emit("refresh");
  } catch (e) {
    error.value = String(e);
  } finally {
    sending.value = false;
  }
}
onMounted(async () => {
  try {
    const [conversation, templates] = await Promise.all([
      api<{ id: string }>("/assistant/conversations", { chatId: "web-daily" }),
      api<typeof workflows.value>("/assistant/workflows"),
    ]);
    if (disposed) return;
    conversationId.value = conversation.id;
    workflows.value = templates;
    await reload();
    timer = setInterval(() => void reload().catch(() => {}), 2000);
  } catch (e) {
    error.value = String(e);
  }
});
onBeforeUnmount(() => {
  disposed = true;
  clearInterval(timer);
});
</script>
<template>
  <section class="page daily-assistant">
    <span class="eyebrow">记下、找回、持续跟进</span>
    <h1>日常助理</h1>
    <p class="muted">
      直接交办、回顾事项或查找记忆。等待与跟进时间会保存，完成和取消以实际操作结果为准。
    </p>
    <OmDisclosure title="可以怎样使用">
      <p v-for="item in workflows" :key="item.id">
        <b>{{ item.title }}</b
        >：{{ item.trigger }}，整理为{{ item.output }}。
      </p>
    </OmDisclosure>
    <form class="form" @submit.prevent="send">
      <label
        >发给日常助理<textarea
          v-model="draft"
          rows="3"
          maxlength="2000"
          required
          placeholder="帮我跟进张三的评审回复，明天上午9点提醒我检查。"
        />
      </label>
      <OmButton
        type="submit"
        variant="primary"
        :disabled="busy || !conversationId || !draft.trim()"
        >{{ busy ? "正在处理" : "发送消息" }}</OmButton
      >
    </form>
    <p v-if="error" role="alert" class="error">{{ error }}</p>
    <OmEmpty
      v-if="!turns.length"
      title="还没有日常消息"
      description="可以先记一件要跟进的事，或问今天有哪些待办。"
    />
    <div aria-live="polite">
      <OmPanel
        v-for="turn in readableTurns"
        :key="turn.id"
        class="stack"
        title="日常消息"
      >
        <p class="message-text">{{ turn.inputText }}</p>
        <OmBadge>{{
          statuses[turn.inputMessageRefs.status] ?? "待处理"
        }}</OmBadge>
        <OmMarkdown
          v-if="turn.result"
          class="assistant-answer"
          :source="turn.reading.source"
          :citations="turn.reading.citations"
          @cite="(key) => readCitation(turn, key)"
        />
        <p
          v-else-if="
            ['pending', 'failed'].includes(turn.inputMessageRefs.status)
          "
        >
          本次处理未完成，消息已保留。
        </p>
        <template #actions>
          <OmButton
            v-if="['pending', 'failed'].includes(turn.inputMessageRefs.status)"
            :disabled="busy"
            @click="retry(turn)"
            >重试这条消息</OmButton
          >
          <OmCitation
            v-for="source in turn.reading.additional"
            :key="source.key"
            :label="source.label"
            @open="readCitation(turn, source.key)"
          />
        </template>
      </OmPanel>
    </div>
  </section>
</template>
<style scoped>
.message-text {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.assistant-answer {
  margin-top: 24px;
  max-width: 76ch;
}
</style>
