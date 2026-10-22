<script setup lang="ts">
import { computed, ref } from "vue";
import { post, type Ask } from "../api";
import Markdown from "./Markdown.vue";
import { toast } from "../store";

/**
 * One question, set of suggested next steps or approval from an agent. A button answers at once;
 * the text box takes a free answer or a refusal's reason. Suggestions render compactly under the
 * reply they belong to.
 */
const props = defineProps<{ ask: Ask; compact?: boolean }>();
const emit = defineEmits<{ answered: [Ask] }>();
const text = ref("");
const busy = ref(false);
const title = computed(() => ({ question: "需要你回答", approval: "需要你批准", suggestion: "" })[props.ask.kind]);

async function answer(body: { choice?: number; approved?: boolean }) {
  if (busy.value) return;
  if (props.ask.kind === "question" && body.choice === undefined && !text.value.trim()) return toast("写下回答，或点一个选项");
  busy.value = true;
  try {
    const done = await post<Ask>(`/api/asks/${props.ask.id}/answer`, { ...body, text: text.value.trim() || undefined });
    text.value = "";
    emit("answered", done);
  } catch (e) {
    toast((e as Error).message);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="ask" :class="[ask.kind, { compact }]" role="group" :aria-label="title || '下一步'">
    <div v-if="title" class="ask-title small">{{ title }}</div>
    <Markdown v-if="ask.question" class="ask-q" :source="ask.question" />
    <div class="row wrap gap">
      <template v-if="ask.kind === 'approval'">
        <button class="btn primary sm" :disabled="busy" @click="answer({ approved: true })">批准</button>
        <button class="btn danger sm" :disabled="busy" @click="answer({ approved: false })">拒绝</button>
      </template>
      <button v-for="(o, i) in ask.options" v-else :key="i" class="btn sm" :class="i === 0 ? 'primary' : ''" :disabled="busy" :title="o.message || o.label" @click="answer({ choice: i })">{{ o.label }}</button>
    </div>
    <form v-if="ask.allowText" class="row gap ask-text" @submit.prevent="answer(ask.kind === 'approval' ? { approved: false } : {})">
      <input v-model="text" class="input" :placeholder="ask.kind === 'approval' ? '理由或附言（点批准或拒绝时一起发送）' : ask.options.length ? '也可以写别的回答' : '你的回答'" :aria-label="ask.kind === 'approval' ? '理由' : '回答'" />
      <button v-if="ask.kind === 'question'" class="btn sm" :disabled="busy || !text.trim()">回答</button>
    </form>
  </div>
</template>

<style scoped>
.ask {
  border: 1px solid var(--line);
  border-left: 3px solid var(--accent);
  border-radius: 8px;
  padding: 10px 12px;
  background: var(--panel);
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-width: 760px;
}
.ask.approval {
  border-left-color: var(--warn);
}
.ask.compact {
  border: none;
  padding: 4px 0 0;
  background: transparent;
}
.ask-title {
  font-weight: 600;
  color: var(--muted);
}
.ask-q :deep(p) {
  margin: 0;
}
.gap {
  gap: 6px;
}
.ask-text .input {
  flex: 1;
  min-width: 0;
}
</style>
