<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { get, onServerEvent, type Run, type RunEvent } from "../api";
import Icon from "./Icon.vue";
import { prettyTool } from "../lib/tools";

const props = withDefaults(defineProps<{ runId: string; showText?: boolean; open?: boolean }>(), { showText: true, open: false });
const emit = defineEmits<{ done: [run: Run]; text: [text: string] }>();
const run = ref<Run | null>(null);
const events = ref<RunEvent[]>([]);
const live = ref("");
const expanded = ref(props.open);
let lastSeq = 0;

async function load() {
  const r = await get<{ run: Run; events: RunEvent[] }>(`/api/runs/${props.runId}?after=0`);
  run.value = r.run;
  events.value = r.events;
  lastSeq = r.events.at(-1)?.seq ?? 0;
  live.value = "";
  if (["done", "failed", "cancelled"].includes(r.run.status)) emit("done", r.run);
}
watch(() => props.runId, load, { immediate: true });

const off = onServerEvent(async (e) => {
  if (!("runId" in e) || e.runId !== props.runId) return;
  if (e.type === "run") {
    if (["done", "failed", "cancelled"].includes(e.status)) await load();
    else if (run.value) run.value.status = e.status;
  } else if (e.type === "run-event") {
    if (e.event.type === "text-delta") {
      live.value += e.event.data.text;
      emit("text", text.value);
    } else if (e.seq > lastSeq) {
      lastSeq = e.seq;
      events.value.push({ seq: e.seq, at: e.event.at, type: e.event.type, data: e.event.data });
      if (e.event.type === "text") live.value = "";
    }
  }
});
onBeforeUnmount(() => off());

/** Tool calls with their latest status, one row per call id. */
const steps = computed(() => {
  const map = new Map<string, { title: string; status: string; phase?: string }>();
  for (const e of events.value)
    if (e.type === "tool") map.set(e.data.id ?? String(e.seq), { title: e.data.title, status: e.data.status ?? "", phase: e.data.phase });
  return [...map.values()];
});
const statusLines = computed(() => events.value.filter((e) => e.type === "status" || e.type === "check").slice(-3));
const text = computed(() => events.value.filter((e) => e.type === "text").map((e) => e.data.text).join("") + live.value);
const running = computed(() => run.value && ["queued", "running"].includes(run.value.status));
defineExpose({ text });
</script>

<template>
  <div class="activity">
    <button v-if="steps.length || running" class="summary" :aria-expanded="expanded" @click="expanded = !expanded">
      <span v-if="running" class="spin" aria-hidden="true" />
      <Icon v-else name="check" :size="14" />
      <span>{{ running ? (run?.status === "queued" ? "排队中" : "进行中") : "过程" }} · {{ steps.length }} 步</span>
      <span v-if="running && steps.length" class="muted ellipsis last">{{ prettyTool(steps[steps.length - 1].title) }}</span>
      <Icon :name="expanded ? 'down' : 'right'" :size="14" />
    </button>
    <ol v-if="expanded && steps.length" class="steps">
      <li v-for="(s, i) in steps" :key="i" :class="s.status">
        <span class="dot" />
        <span class="ellipsis">{{ prettyTool(s.title) }}</span>
        <span v-if="s.phase" class="badge">{{ s.phase === "reviewer" ? "评审" : "编码" }}</span>
      </li>
    </ol>
    <div v-if="expanded && statusLines.length" class="status muted small">
      <div v-for="s in statusLines" :key="s.seq">{{ s.data.text ?? (s.type === "check" ? `检查 ${s.data.command}：退出码 ${s.data.code}` : "") }}</div>
    </div>
    <slot :text="text" :run="run" :running="running" />
    <div v-if="run?.status === 'failed'" class="failed"><Icon name="alert" :size="16" /> {{ run.error }}</div>
  </div>
</template>

<style scoped>
.activity {
  display: grid;
  gap: 8px;
}
.summary {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  border: 1px solid var(--line);
  background: var(--panel);
  border-radius: 999px;
  padding: 3px 12px;
  font-size: 12.5px;
  color: var(--ink-2);
  cursor: pointer;
  justify-self: start;
  max-width: 100%;
}
.summary:hover {
  background: var(--hover);
}
.last {
  max-width: 260px;
}
.spin {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 2px solid var(--line-strong);
  border-top-color: var(--accent);
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
.steps {
  list-style: none;
  margin: 0;
  padding: 4px 0 4px 6px;
  display: grid;
  gap: 3px;
  font-size: 12.5px;
  color: var(--ink-2);
  border-left: 2px solid var(--line);
  margin-left: 10px;
}
.steps li {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-left: 8px;
  min-width: 0;
}
.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--line-strong);
  flex: none;
}
.steps li.completed .dot {
  background: var(--ok);
}
.steps li.failed .dot {
  background: var(--danger);
}
.steps li.in_progress .dot,
.steps li.pending .dot {
  background: var(--accent);
}
.status {
  padding-left: 18px;
}
.failed {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  color: var(--danger);
  background: var(--danger-soft);
  border-radius: 8px;
  padding: 10px 12px;
  white-space: pre-wrap;
  font-size: 13px;
}
</style>
