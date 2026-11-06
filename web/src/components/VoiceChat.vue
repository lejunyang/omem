<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { saveVoice, startVoice, type VoiceHandle, type VoiceState, type VoiceTurn } from "../lib/voice";
import { toast } from "../store";
import Icon from "./Icon.vue";

/**
 * A live voice conversation (lib/voice.ts): starts when shown, shows both sides as they speak, and
 * is saved when it ends (a practice then gets its review). The page decides what comes next.
 */
const props = defineProps<{ purpose: "chat" | "practice"; scenario?: string; space?: string }>();
const emit = defineEmits<{ ended: [saved: { id: string; reviewRunId: string | null } | null, turns: VoiceTurn[]] }>();

const turns = ref<VoiceTurn[]>([]);
const state = ref<VoiceState>("connecting");
const detail = ref("");
const muted = ref(false);
const tool = ref("");
const box = ref<HTMLElement>();
let handle: VoiceHandle | null = null;
let finished = false;

const TOOL_LABEL: Record<string, string> = { search: "检索原件", read_source: "读原件", recall: "查记忆", list_items: "查事项", read_page: "读 Wiki", list_spaces: "看空间" };

onMounted(async () => {
  try {
    handle = await startVoice({
      purpose: props.purpose,
      scenario: props.scenario,
      space: props.space,
      onTurns: (t) => {
        turns.value = t;
        void nextTick(() => box.value?.scrollTo({ top: box.value.scrollHeight }));
      },
      onState: (s, d) => {
        state.value = s;
        if (d) detail.value = d;
      },
      onTool: (name, phase) => (tool.value = phase === "start" ? TOOL_LABEL[name] ?? name : ""),
    });
  } catch (e) {
    state.value = "failed";
    detail.value = (e as Error).message;
  }
});

async function end() {
  if (finished) return;
  finished = true;
  handle?.stop();
  const said = turns.value.filter((t) => t.text.trim());
  let saved: { id: string; reviewRunId: string | null } | null = null;
  if (handle && said.length) {
    try {
      saved = await saveVoice(handle, { purpose: props.purpose, scenario: props.scenario, space: props.space });
    } catch (e) {
      toast(`对话没有保存：${(e as Error).message}`, "error");
    }
  }
  emit("ended", saved, said);
}
function toggleMute() {
  muted.value = !muted.value;
  handle?.mute(muted.value);
}
onBeforeUnmount(() => void end());
defineExpose({ end });
</script>

<template>
  <div class="voice card">
    <div class="vhead">
      <span class="dot" :class="state" aria-hidden="true" />
      <span class="small">{{ state === "connecting" ? "正在连接…" : state === "live" ? (muted ? "已静音" : "正在听") : state === "ended" ? "已结束" : "连接失败" }}</span>
      <span v-if="tool" class="small muted">· {{ tool }}…</span>
      <span v-if="detail && state !== 'live'" class="small err" :title="detail">{{ detail }}</span>
      <span class="spacer" />
      <button v-if="state === 'live'" class="btn ghost sm" :aria-pressed="muted" @click="toggleMute"><Icon name="mic" :size="14" />{{ muted ? "取消静音" : "静音" }}</button>
      <button class="btn sm" :class="state === 'failed' ? 'ghost' : 'primary'" @click="end"><Icon name="stop" :size="13" />{{ state === "failed" ? "关闭" : "结束" }}</button>
    </div>
    <div ref="box" class="vturns" aria-live="polite">
      <p v-if="!turns.length && state === 'live'" class="muted small">{{ purpose === "practice" ? "开口说吧。对方会先打招呼；不会说时可以直接用中文问。" : "直接说话就行，说完停一下等它回答。" }}</p>
      <div v-for="(t, i) in turns" :key="i" class="vturn" :class="t.role">
        <span class="who small muted">{{ t.role === "user" ? "你" : purpose === "practice" ? "对方" : "助理" }}</span>
        <span class="said" :class="{ partial: !t.final }">{{ t.text }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.voice {
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.vhead {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--line);
  flex-wrap: wrap;
}
.dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--muted);
}
.dot.live {
  background: var(--ok);
  box-shadow: 0 0 0 4px var(--ok-soft);
}
.dot.connecting {
  background: var(--warn);
}
.dot.failed {
  background: var(--danger);
}
.err {
  color: var(--danger);
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.vturns {
  padding: 12px;
  overflow-y: auto;
  max-height: 46vh;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.vturn {
  display: grid;
  grid-template-columns: 34px 1fr;
  gap: 8px;
  line-height: 1.6;
}
.vturn.user .said {
  color: var(--ink);
}
.vturn.assistant .said {
  color: var(--ink-2);
}
.said {
  overflow-wrap: anywhere;
}
.said.partial::after {
  content: "…";
  color: var(--muted);
}
</style>
