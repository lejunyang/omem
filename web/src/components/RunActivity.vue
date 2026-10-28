<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { get, onServerEvent, type Run, type RunEvent } from "../api";
import Icon from "./Icon.vue";
import { prettyTool } from "../lib/tools";
import { openCitation, state } from "../store";

/** `link`: offer the run's full record (off on the run page itself). */
const props = withDefaults(defineProps<{ runId: string; showText?: boolean; open?: boolean; link?: boolean }>(), { showText: true, open: false, link: true });
const emit = defineEmits<{ done: [run: Run]; text: [text: string] }>();
const run = ref<Run | null>(null);
const events = ref<RunEvent[]>([]);
const live = ref("");
const expanded = ref(props.open);
let lastSeq = 0;
type WriteTarget = { kind: "source" | "memory" | "item" | "rule"; id: string } | { kind: "page"; space: string; slug: string };
type RunWrite = { tool: string; label: string; action?: "新建" | "更新" | "更正"; space?: string | null; target?: WriteTarget; n?: number };
const writes = ref<RunWrite[]>([]);

async function load() {
  const r = await get<{ run: Run; events: RunEvent[]; writes?: RunWrite[] }>(`/api/runs/${props.runId}?after=0`);
  run.value = r.run;
  events.value = r.events;
  writes.value = r.writes ?? [];
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

// What the run wrote, each opening where it lives (the citation drawer, the item, the rule).
const writeKind: Record<string, string> = { write_file: "工作文件", remember: "记忆", supersede: "记忆", write_page: "页面", upsert_item: "事项", save_rule: "规则" };
/** "新建工作文件：…", "更正记忆：…". */
const writeTitle = (w: RunWrite) => `${writeKind[w.tool] ? `${w.action ?? ""}${writeKind[w.tool]}：` : ""}${w.label}`;
const spaceName = (id: string) => state.spaces.find((s) => s.id === id)?.name ?? id;
function writeLink(w: RunWrite) {
  const t = w.target;
  if (!t) return undefined;
  if (t.kind === "item") return `/items/${t.id}`;
  if (t.kind === "rule") return `/rules?id=${encodeURIComponent(t.id)}`;
  return undefined;
}
function openWrite(w: RunWrite) {
  const t = w.target;
  if (!t || t.kind === "item" || t.kind === "rule") return;
  openCitation(t.kind === "page" ? { kind: "page", space: t.space, slug: t.slug } : t.kind === "source" ? { kind: "source", id: t.id } : { kind: "memory", id: t.id }, true);
}
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
    <div v-if="!running && (writes.length || (link && steps.length))" class="wrote small">
      <template v-if="writes.length">
        <span class="muted">这次写下</span>
        <template v-for="(w, i) in writes" :key="i">
          <router-link v-if="writeLink(w)" :to="writeLink(w)!" class="w">{{ writeTitle(w) }}</router-link>
          <a v-else-if="w.target" href="#" class="w" @click.prevent="openWrite(w)">{{ writeTitle(w) }}</a>
          <span v-else class="w plain" :title="w.tool">{{ prettyTool(w.tool) }}{{ w.label ? `：${w.label}` : "" }}{{ w.n ? ` ×${w.n}` : "" }}</span>
          <span v-if="w.space && w.space !== run?.spaceId" class="muted">（{{ spaceName(w.space) }}）</span>
        </template>
      </template>
      <router-link v-if="link" :to="`/runs/${runId}`" class="muted rec">运行记录</router-link>
    </div>
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
.wrote {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 8px;
  min-width: 0;
}
.wrote .w {
  min-width: 0;
  max-width: 100%;
  overflow-wrap: anywhere;
}
.wrote .plain {
  color: var(--ink-2);
}
.wrote .rec {
  margin-left: auto;
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
