<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { get, onServerEvent, type Run, type RunEvent } from "../api";
import Icon from "./Icon.vue";
import Markdown from "./Markdown.vue";
import Skeleton from "./Skeleton.vue";
import { fmtTime } from "../store";
import { prettyTool } from "../lib/tools";
import { reviewAi, type Reviews } from "../lib/reviews";

/**
 * The run page's “活动” for a reviewed delegation: what each session of the chosen round did, one
 * section per check (the coder, every check, the requirement split, review-lead). Its events come
 * from the round's coding run and the review runs started for it, told apart by their phase / check tags.
 */
const props = defineProps<{ rv: Reviews; focus?: string | null }>();
const rv = props.rv;

const runIds = computed(() => {
  const c = rv.current.value;
  return c ? [c.runId, ...(c.reviewRuns ?? []).map((r) => r.id)] : [];
});
const runs = ref<Record<string, Run>>({});
const events = ref<Record<string, RunEvent[]>>({});
/** Streaming text not yet stored, per section. */
const live = ref<Record<string, string>>({});
const loading = ref(false);

async function loadRun(id: string) {
  const r = await get<{ run: Run; events: RunEvent[] }>(`/api/runs/${id}?after=0`);
  runs.value = { ...runs.value, [id]: r.run };
  events.value = { ...events.value, [id]: r.events };
}
async function loadAll() {
  loading.value = true;
  runs.value = {};
  events.value = {};
  live.value = {};
  try {
    await Promise.all(runIds.value.map((id) => loadRun(id).catch(() => {})));
  } finally {
    loading.value = false;
  }
}
watch(() => runIds.value.join(","), () => void loadAll(), { immediate: true });

type Key = string;
function keyOf(runId: string, data: any): Key {
  if (data?.phase === "reviewer" && data.check) return `check:${data.check}`;
  if (data?.phase === "lead") return "lead";
  if (data?.phase === "coder") return "coder";
  // Text recorded before the checks' streams were kept apart carries no tag.
  return "other";
}

const off = onServerEvent(async (e) => {
  if (!("runId" in e) || !runIds.value.includes(e.runId)) return;
  if (e.type === "run") {
    if (["done", "failed", "cancelled"].includes(e.status)) await loadRun(e.runId).catch(() => {});
    else if (runs.value[e.runId]) runs.value[e.runId] = { ...runs.value[e.runId], status: e.status as Run["status"] };
  } else if (e.type === "run-event") {
    if (e.event.type === "text-delta") {
      const k = keyOf(e.runId, e.event.data);
      live.value = { ...live.value, [k]: (live.value[k] ?? "") + (e.event.data.text ?? "") };
    } else if (e.seq > 0) {
      const list = events.value[e.runId] ?? [];
      if (list.length && list[list.length - 1].seq >= e.seq) return;
      events.value = { ...events.value, [e.runId]: [...list, { seq: e.seq, at: e.event.at, type: e.event.type, data: e.event.data }] };
      if (e.event.type === "text") live.value = { ...live.value, [keyOf(e.runId, e.event.data)]: "" };
    }
  }
});
onBeforeUnmount(() => off());

type Entry =
  | { kind: "tool"; id: string; title: string; status: string; at: string }
  | { kind: "text"; text: string; at: string }
  | { kind: "thought"; text: string; at: string }
  | { kind: "status"; text: string; at: string };
type Section = { key: Key; label: string; entries: Entry[]; first: string; last: string; steps: number; verdict: string | null; ai: string };

const VERDICT: Record<string, string> = { approved: "通过", changes_requested: "需要修改", failed: "没有完成" };

const sections = computed<Section[]>(() => {
  const map = new Map<Key, { entries: Entry[]; tools: Map<string, Entry & { kind: "tool" }>; first: string; last: string }>();
  const at = (k: Key) => {
    let s = map.get(k);
    if (!s) map.set(k, (s = { entries: [], tools: new Map(), first: "", last: "" }));
    return s;
  };
  for (const id of runIds.value)
    for (const e of events.value[id] ?? []) {
      if (!["tool", "text", "thought", "status", "check"].includes(e.type)) continue;
      // Host progress lines without a session go on top; a session's own lines stay in its section.
      if ((e.type === "status" || e.type === "check") && !e.data?.phase) continue;
      const s = at(keyOf(id, e.data));
      s.first ||= e.at;
      s.last = e.at;
      if (e.type === "tool") {
        const tid = e.data.id ?? `${id}:${e.seq}`;
        const t = s.tools.get(tid);
        if (t) t.status = e.data.status ?? t.status;
        else {
          const entry = { kind: "tool" as const, id: tid, title: e.data.title ?? "", status: e.data.status ?? "", at: e.at };
          s.tools.set(tid, entry);
          s.entries.push(entry);
        }
      } else if (e.type === "text" || e.type === "thought") {
        const prev = s.entries[s.entries.length - 1];
        if (prev && prev.kind === e.type) prev.text += e.data.text ?? "";
        else s.entries.push({ kind: e.type, text: e.data.text ?? "", at: e.at });
      } else {
        s.entries.push({ kind: "status", text: e.data.text ?? (e.type === "check" ? `检查 ${e.data.command}：退出码 ${e.data.code}` : ""), at: e.at });
      }
    }
  for (const [k, text] of Object.entries(live.value))
    if (text) {
      const s = at(k);
      const prev = s.entries[s.entries.length - 1];
      if (prev && prev.kind === "text") prev.text += text;
      else s.entries.push({ kind: "text", text, at: "" });
    }

  const plan = rv.current.value?.plan?.checks ?? [];
  const order: Key[] = ["coder", ...plan.map((c) => `check:${c}`), "check:split", "lead"];
  const keys = [...map.keys()].sort((a, b) => rank(a) - rank(b));
  function rank(k: Key) {
    const i = order.indexOf(k);
    return i < 0 ? order.length : i;
  }
  return keys.map((k) => {
    const s = map.get(k)!;
    const check = k.startsWith("check:") ? k.slice(6) : null;
    const review = check ? rv.reviews.value.find((r) => r.check_name === check) : undefined;
    const label = k === "coder" ? "编码 Agent" : k === "lead" ? "评审负责人" : check === "split" ? "需求拆分" : check ? rv.label(check) : "没有分开记录的输出";
    return { key: k, label, entries: s.entries, first: s.first, last: s.last, steps: s.tools.size, verdict: review?.verdict ?? null, ai: review ? reviewAi(review) : "" };
  });
});
/** Progress lines of the host (plan, retries, ruling), outside any one session. */
const hostLines = computed(() => {
  const out: { text: string; at: string }[] = [];
  for (const id of runIds.value) for (const e of events.value[id] ?? []) if ((e.type === "status" || e.type === "check") && !e.data?.phase) out.push({ text: e.data.text ?? (e.type === "check" ? `检查 ${e.data.command}：退出码 ${e.data.code}` : ""), at: e.at });
  return out.sort((a, b) => a.at.localeCompare(b.at));
});
const running = computed(() => Object.values(runs.value).some((r) => ["queued", "running"].includes(r.status)));
const failures = computed(() => Object.values(runs.value).filter((r) => r.status === "failed" && r.error));

const open = ref(new Set<Key>());
const toggle = (k: Key) => { const n = new Set(open.value); n.has(k) ? n.delete(k) : n.add(k); open.value = n; };
const root = ref<HTMLElement | null>(null);
// “看过程” on a check opens its section and brings it into view.
watch(
  () => [props.focus, loading.value] as const,
  async ([f, busy]) => {
    if (!f || busy) return;
    const k = f === "lead" || f === "coder" ? f : `check:${f}`;
    open.value = new Set([...open.value, k]);
    await nextTick();
    root.value?.querySelector<HTMLElement>(`[data-section="${CSS.escape(k)}"]`)?.scrollIntoView({ block: "start", behavior: "smooth" });
  },
  { immediate: true },
);

function span(s: Section) {
  if (!s.first || !s.last) return "";
  const ms = new Date(s.last).getTime() - new Date(s.first).getTime();
  const min = Math.round(ms / 60000);
  return `${fmtTime(s.first)} · ${min < 1 ? "不到 1 分钟" : `${min} 分钟`}`;
}
const sectionRunning = (s: Section) => running.value && !s.verdict && s.key !== "coder";
</script>

<template>
  <section ref="root" class="block process">
    <Skeleton v-if="loading" :rows="5" />
    <template v-else>
      <div v-if="hostLines.length" class="card pad host small">
        <div class="section-title">进度</div>
        <div v-for="(l, i) in hostLines" :key="i" class="hl"><span class="muted mono t">{{ fmtTime(l.at) }}</span><span>{{ l.text }}</span></div>
      </div>
      <div v-for="f in failures" :key="f.id" class="failed"><Icon name="alert" :size="16" /> {{ f.title }}：{{ f.error }}</div>
      <p v-if="!sections.length" class="muted">这一轮还没有记录到过程。</p>
      <div v-for="s in sections" :key="s.key" class="card sec" :data-section="s.key">
        <button class="sec-head" :aria-expanded="open.has(s.key)" @click="toggle(s.key)">
          <span v-if="sectionRunning(s)" class="spin" aria-hidden="true" />
          <span v-else class="st" :class="s.verdict ?? 'plain'" />
          <strong>{{ s.label }}</strong>
          <span v-if="s.verdict" class="muted small">{{ VERDICT[s.verdict] ?? s.verdict }}</span>
          <span class="muted small">{{ s.steps }} 步</span>
          <span class="spacer" />
          <span v-if="s.ai" class="muted small mono ai">{{ s.ai }}</span>
          <span class="muted small nowrap">{{ span(s) }}</span>
          <Icon :name="open.has(s.key) ? 'down' : 'right'" :size="14" />
        </button>
        <div v-if="open.has(s.key)" class="sec-body">
          <template v-for="(e, i) in s.entries" :key="i">
            <div v-if="e.kind === 'tool'" class="tool small" :class="e.status"><span class="dot" /><span class="ellipsis">{{ prettyTool(e.title) }}</span></div>
            <div v-else-if="e.kind === 'status'" class="muted small stat">{{ e.text }}</div>
            <details v-else-if="e.kind === 'thought'" class="thought small"><summary class="muted">思考</summary><div class="pre">{{ e.text }}</div></details>
            <div v-else class="text"><Markdown :source="e.text" /></div>
          </template>
        </div>
      </div>
    </template>
  </section>
</template>

<style scoped>
.process { display: grid; gap: 10px; }
.process > * { min-width: 0; }
.host { display: grid; gap: 4px; }
.hl { display: flex; gap: 10px; }
.hl .t { flex: none; }
.sec { overflow: hidden; }
.sec-head { display: flex; align-items: center; gap: 10px; width: 100%; padding: 11px 14px; border: 0; background: none; font: inherit; color: inherit; cursor: pointer; text-align: left; flex-wrap: wrap; }
.sec-head:hover { background: var(--hover); }
.sec-body { border-top: 1px solid var(--line); padding: 10px 14px 12px; display: grid; gap: 4px; min-width: 0; }
.st { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); flex: none; }
.st.approved { background: var(--ok); }
.st.changes_requested { background: var(--warn); }
.st.failed { background: var(--danger); }
.spin { width: 10px; height: 10px; border-radius: 50%; border: 2px solid var(--line-strong); border-top-color: var(--accent); animation: spin 0.8s linear infinite; flex: none; }
@keyframes spin { to { transform: rotate(360deg); } }
.tool { display: flex; align-items: center; gap: 8px; color: var(--ink-2); min-width: 0; padding-left: 4px; }
.dot { width: 6px; height: 6px; border-radius: 50%; background: var(--line-strong); flex: none; }
.tool.completed .dot { background: var(--ok); }
.tool.failed .dot { background: var(--danger); }
.tool.in_progress .dot, .tool.pending .dot { background: var(--accent); }
.stat { padding-left: 4px; }
.text { margin: 6px 0; padding-left: 10px; border-left: 2px solid var(--line); min-width: 0; overflow-wrap: anywhere; }
.thought summary { cursor: pointer; }
.thought .pre { white-space: pre-wrap; color: var(--ink-2); padding: 6px 10px; overflow-wrap: anywhere; }
.ai, .nowrap { white-space: nowrap; }
.failed { display: flex; gap: 8px; align-items: flex-start; color: var(--danger); background: var(--danger-soft); border-radius: 8px; padding: 10px 12px; white-space: pre-wrap; font-size: 13px; }
@media (max-width: 760px) { .ai { display: none; } }
</style>
