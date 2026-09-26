<script setup lang="ts">
import { ref, onBeforeUnmount, watch, nextTick } from "vue";
import { OmButton, OmIcon, OmCitation, OmBadge } from "@omem/ui";
import { api, type Run, type Fragment } from "./api";
const props = defineProps<{
  focus: Fragment | null;
  profileId: string;
  model: string;
  effort: string;
  pathIds?: string[];
}>();
const emit = defineEmits<{ open: [id: string]; saved: [] }>();
const draft = ref("");
const scope = ref("focus");
const run = ref<Run | null>(null);
const error = ref("");
const busy = ref(false);
const scroll = ref<HTMLElement>();
watch(
  () => run.value?.events.length,
  async () => {
    await nextTick();
    scroll.value?.scrollTo({ top: scroll.value.scrollHeight });
  },
);
let timer: ReturnType<typeof setTimeout> | undefined;
let disposed = false;
const answer = () =>
  run.value?.events
    .filter((e) => e.type === "text")
    .map((e) => e.text)
    .join("") || "";
async function poll(id: string) {
  try {
    const result = await api<Run>("/runs/" + id);
    if (disposed) return;
    run.value = result;
    if (run.value.state === "running")
      timer = setTimeout(() => void poll(id), 450);
    else {
      busy.value = false;
      if (run.value.state === "done") emit("saved");
    }
  } catch (e) {
    error.value = String(e);
    busy.value = false;
  }
}
async function ask() {
  if (!draft.value.trim() || !props.focus || busy.value) return;
  error.value = "";
  busy.value = true;
  try {
    const started = await api<{ id: string; state: "running" }>("/runs", {
      question: draft.value,
      profileId: props.profileId,
      focusId: props.focus.id,
      ...(props.model ? { model: props.model } : {}),
      ...(props.effort ? { effort: props.effort } : {}),
      contextIds: scope.value === "path" ? props.pathIds || [] : [],
    });
    run.value = { ...started, events: [] };
    void poll(started.id);
  } catch (e) {
    error.value = String(e);
    busy.value = false;
  }
}
async function cancel() {
  try {
    if (run.value) await api("/runs/" + run.value.id + "/cancel", {});
  } catch (e) {
    error.value = String(e);
  }
}
onBeforeUnmount(() => {
  disposed = true;
  clearTimeout(timer);
});
</script>
<template>
  <section class="chat">
    <header>
      <OmIcon name="spark" />
      <div><b>和记忆一起思考</b><small>Agent CLI / ACP · 真实接入</small></div>
    </header>
    <div ref="scroll" class="chat-content">
      <div v-if="focus" class="focus-box">
        <small>本次固定证据</small>
        <p>{{ focus.text }}</p>
        <OmBadge>片段 {{ focus.ordinal + 1 }}</OmBadge>
      </div>
      <p v-else class="muted">先打开材料，选择一个片段作为问答依据。</p>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <div v-if="run" class="answer">
        <small>{{
          run.state === "running"
            ? "正在生成"
            : run.state === "done"
              ? "回答已保存"
              : run.state === "cancelled"
                ? "已停止"
                : "生成失败"
        }}</small>
        <p class="pre-wrap">{{ answer() }}</p>
        <p
          v-for="(e, i) in run.events.filter(
            (e) => e.type === 'error' || e.type === 'permission',
          )"
          :key="i"
          class="error"
        >
          {{ e.text }}
        </p>
        <OmCitation
          v-if="run.state === 'done' && focus"
          label="查看本次提供的依据"
          @open="emit('open', focus.id)"
        /><small v-if="run.state === 'done'"
          >材料可回查；系统尚未自动核验回答中每个主张的支持度。</small
        >
      </div>
    </div>
    <form @submit.prevent="ask">
      <label
        >回答范围<select v-model="scope">
          <option value="focus">当前片段</option>
          <option value="path">当前引用路径</option>
        </select></label
      ><label
        >问题<textarea
          v-model="draft"
          rows="3"
          placeholder="从当前片段继续问…"
          :disabled="!focus"
        /></label
      ><OmButton v-if="busy" @click="cancel">停止回答</OmButton
      ><OmButton
        v-else
        type="submit"
        variant="primary"
        :disabled="!focus || !draft.trim()"
        >发送问题</OmButton
      ><small>模型、effort 和上下文配置可在“能力与连接”中设置。</small>
    </form>
  </section>
</template>
<style scoped>
.chat {
  display: flex;
  flex-direction: column;
  min-height: 500px;
  height: 100%;
}
.chat header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 22px;
  border-bottom: 1px solid var(--om-line);
}
header small {
  display: block;
  font-size: 11px;
}
.chat-content {
  padding: 20px;
  flex: 1;
  overflow: auto;
}
.focus-box {
  background: var(--om-soft);
  padding: 16px;
  border-radius: 7px;
}
.focus-box p {
  font-size: 13px;
  max-height: 170px;
  overflow: auto;
  white-space: pre-wrap;
}
.answer {
  margin: 24px 0;
}
.answer p {
  font-size: 14px;
  overflow-wrap: anywhere;
}
.answer small {
  display: block;
  margin: 14px 0;
}
form {
  padding: 20px;
  border-top: 1px solid var(--om-line);
  display: flex;
  flex-direction: column;
  gap: 12px;
}
form small {
  font-size: 11px;
}
.error {
  color: var(--om-danger);
}
.pre-wrap {
  white-space: pre-wrap;
}
.muted {
  color: var(--om-muted);
}
</style>
