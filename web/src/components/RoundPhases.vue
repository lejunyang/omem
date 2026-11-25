<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { get, onServerEvent, type RunEvent } from "../api";
import { CHECK_STATE, type CheckRow } from "../lib/reviews";
import { roundSegments, SEGMENT_LABEL, sessionOf, spanText, taskList, type Segment } from "../lib/round-phases";
import { prettyTool } from "../lib/tools";
import { stripAnsi } from "../lib/works";
import Icon from "./Icon.vue";
import Markdown from "./Markdown.vue";
import VirtualList from "./VirtualList.vue";

/**
 * A coding round's 活动 (docs/v2/coding-work.md): what it went through in order — 编码 (with the
 * checks verifying finished tasks beside it), 宿主检查, 阶段评审, and 编码 again when review feedback
 * comes back within the round. The stretch it is in now is open; earlier ones are a line each (what
 * tasks, how long). Opened, a stretch shows the host's lines, the check's result, the stage review's
 * checks, and one row per session whose steps are listed only when it is opened (VirtualList).
 * `events`: the round's events as the page loaded them; new ones are added as they come.
 */
const props = defineProps<{
  runId: string;
  events: RunEvent[];
  busy: boolean;
  /** The checks of this round's stage review (lib/reviews checkRows), and their names. */
  checks?: CheckRow[];
  label: (check: string) => string;
  /** Other runs that ran this round's review (a confirmed plan, a retry): their sessions are part of it. */
  reviewRuns?: string[];
  /** Task-driven: what each task's notes say happened when (coder notes, verifications). */
  taskMode?: boolean;
  /** “看过程” on a check: open its session. */
  focus?: string | null;
}>();

// ---- the events: the page's, what streams in, and those of separate review runs -------------------
const extra = ref<RunEvent[]>([]);
const live = ref<RunEvent[]>([]);
watch(() => props.events, () => (live.value = []));
watch(() => (props.reviewRuns ?? []).join(","), async (ids) => {
  extra.value = [];
  if (!ids) return;
  const lists = await Promise.all(ids.split(",").map((id) => get<{ events: RunEvent[] }>(`/api/runs/${id}?after=0`).then((r) => r.events).catch(() => [])));
  extra.value = lists.flat();
}, { immediate: true });
const off = onServerEvent((e) => {
  if (e.type !== "run-event" || e.event.type === "text-delta" || ![props.runId, ...(props.reviewRuns ?? [])].includes(e.runId)) return;
  const last = live.value.at(-1)?.seq ?? props.events.at(-1)?.seq ?? 0;
  if (e.runId === props.runId && e.seq <= last) return;
  live.value = [...live.value, { seq: e.seq, at: e.event.at, type: e.event.type, data: e.event.data }];
});
onBeforeUnmount(() => off());
const all = computed(() => {
  const own = [...props.events, ...live.value];
  return extra.value.length ? [...own, ...extra.value].sort((a, b) => a.at.localeCompare(b.at)) : own;
});
const segments = computed(() => roundSegments(all.value));

// ---- what the tasks say happened in each stretch -------------------------------------------------
type Note = { at: string; kind: string; by: string };
const taskNotes = ref<{ seq: number; notes: Note[] }[]>([]);
async function loadTasks() {
  if (!props.taskMode) return void (taskNotes.value = []);
  const d = await get<{ tasks?: { seq: number; notes: Note[] }[] }>(`/api/runs/${props.runId}/tasks`).catch(() => null);
  taskNotes.value = d?.tasks ?? [];
}
watch(() => [props.runId, props.taskMode, props.busy] as const, () => void loadTasks(), { immediate: true });
const within = (s: Segment, kind: string) => taskNotes.value.filter((t) => t.notes.some((n) => n.kind === kind && n.at >= s.from && n.at <= s.to)).map((t) => t.seq);

const clock = (iso: string) => new Date(iso).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
const isLast = (i: number) => i === segments.value.length - 1;
const running = (i: number) => props.busy && isLast(i);
function summary(s: Segment) {
  const parts: string[] = [];
  if (s.kind === "coding") {
    const done = within(s, "coder");
    const checked = within(s, "verify");
    if (done.length) parts.push(`做了 ${taskList(done)}`);
    if (checked.length) parts.push(`验证了 ${taskList(checked)}`);
    else if (s.sessions.some((x) => x.startsWith("verify:"))) parts.push("期间有逐项验证");
  } else if (s.kind === "verify") {
    const checked = within(s, "verify");
    if (checked.length) parts.push(`验证了 ${taskList(checked)}`);
  } else if (s.kind === "checking") {
    if (s.checks.length) parts.push(s.checks.every((c) => c.code === 0) ? "检查通过" : `检查没通过（退出码 ${s.checks.find((c) => c.code !== 0)!.code}）`);
    if (s.tasks.length) parts.push(`检查点包含 ${taskList(s.tasks)}`);
  } else if (s.kind === "review") {
    const reviewSessions = s.sessions.filter((x) => x.startsWith("check:")).length;
    if (reviewSessions) parts.push(`${reviewSessions} 个评审项`);
    if (s.sessions.includes("lead")) parts.push("评审负责人");
  }
  if (s.steps) parts.push(`${s.steps} 步`);
  return parts.join(" · ");
}

// ---- which stretches and sessions are open ------------------------------------------------------
const openSegs = ref(new Set<number>());
const openSessions = ref(new Set<string>());
const sessionKey = (i: number, s: string) => `${i}|${s}`;
let seeded = "";
watch(() => [segments.value.length, props.busy, props.runId] as const, ([n, busy, id]) => {
  const key = `${id}:${n}:${busy}`;
  if (seeded === key) return;
  // The stretch it is in now opens by itself; what the owner opened stays open.
  if (busy && n) openSegs.value = new Set([...openSegs.value, n - 1]);
  seeded = key;
}, { immediate: true });
const toggleSeg = (i: number) => { const n = new Set(openSegs.value); n.has(i) ? n.delete(i) : n.add(i); openSegs.value = n; };
const toggleSession = (k: string) => { const n = new Set(openSessions.value); n.has(k) ? n.delete(k) : n.add(k); openSessions.value = n; };
const root = ref<HTMLElement | null>(null);
watch(() => [props.focus, segments.value.length] as const, async ([f]) => {
  if (!f) return;
  const want = f === "lead" ? "lead" : `check:${f}`;
  const i = segments.value.map((s, k) => (s.sessions.includes(want) ? k : -1)).filter((k) => k >= 0).at(-1);
  if (i === undefined) return;
  openSegs.value = new Set([...openSegs.value, i]);
  openSessions.value = new Set([...openSessions.value, sessionKey(i, want)]);
  await nextTick();
  root.value?.querySelector(`[data-session="${CSS.escape(sessionKey(i, want))}"]`)?.scrollIntoView({ block: "start", behavior: "smooth" });
}, { immediate: true });

// ---- inside a stretch ---------------------------------------------------------------------------
/** The host's own lines (no session): the latest few, the rest folded. */
const HOST_SHOWN = 6;
const hostOpen = ref(new Set<number>());
function hostLines(s: Segment) {
  return s.events.map((i) => all.value[i]).filter((e) => e.type === "status" && !e.data?.phase && e.data?.text).map((e) => ({ at: e.at, text: checkNames(String(e.data.text)) }));
}
/** The host writes check names as they are configured (“阶段评审：review-arch、reviewer”); shown by their labels. */
const checkNames = (text: string) => text.replace(/\breview(?:er|-[a-z][\w-]*)\b/g, (name) => props.label(name));
function sessionLabel(key: string) {
  if (key === "coder") return "编码 Agent";
  if (key === "lead") return "评审负责人";
  if (key === "pre-check") return "编码前检查";
  if (key === "design") return "写方案";
  const [kind, check] = key.split(":");
  return kind === "verify" ? `逐项验证 · ${props.label(check)}` : props.label(check);
}
type Entry = { id: string; kind: "tool" | "text" | "thought" | "status"; text: string; status?: string; at: string };
function entriesOf(s: Segment, key: string): Entry[] {
  const out: Entry[] = [];
  const tools = new Map<string, Entry>();
  for (const i of s.events) {
    const e = all.value[i];
    if (sessionOf(e) !== key || !["tool", "text", "thought", "status"].includes(e.type)) continue;
    if (e.type === "tool") {
      const id = String(e.data?.id ?? e.seq);
      const t = tools.get(id);
      if (t) t.status = e.data?.status ?? t.status;
      else {
        const entry: Entry = { id: `t${id}`, kind: "tool", text: e.data?.title ?? "", status: e.data?.status ?? "", at: e.at };
        tools.set(id, entry);
        out.push(entry);
      }
    } else if (e.type === "text" || e.type === "thought") {
      const prev = out.at(-1);
      if (prev && prev.kind === e.type) prev.text += e.data?.text ?? "";
      else out.push({ id: `e${e.seq}:${i}`, kind: e.type, text: e.data?.text ?? "", at: e.at });
    } else out.push({ id: `e${e.seq}:${i}`, kind: "status", text: String(e.data?.text ?? ""), at: e.at });
  }
  return out;
}
function sessionStat(s: Segment, key: string) {
  let first = "", last = "";
  const tools = new Set<string>();
  for (const i of s.events) {
    const e = all.value[i];
    if (sessionOf(e) !== key) continue;
    first ||= e.at;
    last = e.at;
    if (e.type === "tool") tools.add(String(e.data?.id ?? e.seq));
  }
  return { steps: tools.size, span: first ? spanText(first, last, clock) : "" };
}
/** A session's result: a check of the stage review by its row, a verification by nothing more. */
const rowOf = (key: string) => (key.startsWith("check:") ? props.checks?.find((c) => c.name === key.slice(6)) ?? null : null);
const shownChecks = (s: Segment) => (s.kind === "review" && props.checks?.length && s === segments.value.filter((x) => x.kind === "review").at(-1) ? props.checks : []);
const thoughtOpen = ref(new Set<string>());
const toggleThought = (id: string) => { const n = new Set(thoughtOpen.value); n.has(id) ? n.delete(id) : n.add(id); thoughtOpen.value = n; };
const MAX_LOG = 20000;
</script>

<template>
  <section ref="root" class="phases" aria-label="这一轮的过程">
    <p v-if="!segments.length" class="muted small">这一轮还没有记录到过程。</p>
    <div v-for="(s, i) in segments" :key="`${i}:${s.kind}`" class="seg" :class="{ current: running(i), open: openSegs.has(i) }">
      <button class="seg-head" :aria-expanded="openSegs.has(i)" @click="toggleSeg(i)">
        <span v-if="running(i)" class="spin" aria-hidden="true" />
        <span v-else class="st" :class="s.kind === 'checking' && s.checks.some((c) => c.code !== 0) ? 'bad' : 'done'" />
        <strong>{{ SEGMENT_LABEL[s.kind] }}</strong>
        <span v-if="running(i)" class="badge accent">进行中</span>
        <span class="muted small nowrap">{{ spanText(s.from, s.to, clock) }}</span>
        <span class="muted small sum">{{ summary(s) }}</span>
        <Icon :name="openSegs.has(i) ? 'down' : 'right'" :size="14" class="chev" />
      </button>
      <div v-if="openSegs.has(i)" class="seg-body">
        <!-- the host's lines -->
        <ol v-if="hostLines(s).length" class="host small">
          <li v-if="hostLines(s).length > HOST_SHOWN && !hostOpen.has(i)" class="more"><button class="lnk" @click="hostOpen = new Set([...hostOpen, i])">更早的 {{ hostLines(s).length - HOST_SHOWN }} 条</button></li>
          <li v-for="(l, k) in hostOpen.has(i) ? hostLines(s) : hostLines(s).slice(-HOST_SHOWN)" :key="k"><span class="muted mono t">{{ clock(l.at) }}</span><span class="ht">{{ l.text }}</span></li>
        </ol>
        <!-- the host's check -->
        <div v-for="(c, k) in s.checks" :key="`c${k}`" class="check small">
          <div class="row wrap"><span class="badge" :class="c.code === 0 ? 'ok' : 'danger'">退出码 {{ c.code }}</span><span v-if="c.space" class="muted">{{ c.space }}</span><span class="mono cmd">{{ c.command }}</span><span v-if="c.ms" class="muted">{{ Math.round(c.ms / 1000) }} 秒</span></div>
          <details v-if="c.output" class="out"><summary class="muted">输出（{{ c.output.length > MAX_LOG ? `最后 ${MAX_LOG} 字，共 ${c.output.length} 字` : `${c.output.length} 字` }}）</summary><pre class="log">{{ stripAnsi(c.output.slice(-MAX_LOG)) }}</pre></details>
        </div>
        <!-- the stage review's checks -->
        <ul v-if="shownChecks(s).length" class="checks small">
          <li v-for="c in shownChecks(s)" :key="c.name"><span class="cdot" :class="c.state" /><strong>{{ label(c.name) }}</strong><span class="badge" :class="CHECK_STATE[c.state].cls">{{ CHECK_STATE[c.state].text }}</span><span v-if="c.findings" class="muted">{{ c.findings }} 个问题</span><span class="spacer" /><span v-if="c.ai" class="muted mono ai">{{ c.ai }}</span></li>
        </ul>
        <!-- sessions -->
        <div v-for="k in s.sessions" :key="k" class="sess" :data-session="sessionKey(i, k)">
          <button class="sess-head small" :aria-expanded="openSessions.has(sessionKey(i, k))" @click="toggleSession(sessionKey(i, k))">
            <Icon :name="openSessions.has(sessionKey(i, k)) ? 'down' : 'right'" :size="13" />
            <span class="sl">{{ sessionLabel(k) }}</span>
            <span v-if="rowOf(k)" class="badge" :class="CHECK_STATE[rowOf(k)!.state].cls">{{ CHECK_STATE[rowOf(k)!.state].text }}</span>
            <span class="muted">{{ sessionStat(s, k).steps }} 步</span>
            <span class="spacer" />
            <span class="muted nowrap">{{ sessionStat(s, k).span }}</span>
          </button>
          <div v-if="openSessions.has(sessionKey(i, k))" class="entries">
            <VirtualList :items="entriesOf(s, k)" :item-key="(x) => x.id" :estimate="24">
              <template #default="{ item: e }">
                <div v-if="e.kind === 'tool'" class="tool small" :class="e.status"><span class="dot" /><span class="ellipsis" :title="e.text">{{ prettyTool(e.text) }}</span></div>
                <div v-else-if="e.kind === 'status'" class="muted small stat">{{ e.text }}</div>
                <div v-else-if="e.kind === 'thought'" class="thought small">
                  <button class="lnk muted" :aria-expanded="thoughtOpen.has(e.id)" @click="toggleThought(e.id)">思考{{ thoughtOpen.has(e.id) ? "" : `（${e.text.length} 字）` }}</button>
                  <div v-if="thoughtOpen.has(e.id)" class="pre">{{ e.text }}</div>
                </div>
                <div v-else class="text"><Markdown compact :source="e.text" /></div>
              </template>
            </VirtualList>
          </div>
        </div>
        <p v-if="!hostLines(s).length && !s.checks.length && !s.sessions.length" class="muted small">没有记录。</p>
      </div>
    </div>
  </section>
</template>

<style scoped>
.phases { display: grid; gap: 8px; min-width: 0; }
.seg { border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel); min-width: 0; }
.seg.current { border-color: var(--accent); }
.seg-head { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; width: 100%; padding: 9px 12px; border: 0; background: none; font: inherit; color: var(--ink); text-align: left; cursor: pointer; min-width: 0; }
.seg-head:hover { background: var(--hover); }
.seg-head .sum { flex: 1 1 12em; min-width: 0; overflow-wrap: anywhere; }
.seg-head .chev { margin-left: auto; flex: none; }
.seg-body { border-top: 1px solid var(--line); padding: 10px 12px 12px; display: grid; gap: 10px; min-width: 0; }
.st { width: 8px; height: 8px; border-radius: 50%; background: var(--ok); flex: none; }
.st.bad { background: var(--danger); }
.spin { width: 10px; height: 10px; border-radius: 50%; border: 2px solid var(--line-strong); border-top-color: var(--accent); animation: spin 0.8s linear infinite; flex: none; }
@keyframes spin { to { transform: rotate(360deg); } }
.nowrap { white-space: nowrap; }
.host { list-style: none; margin: 0; padding: 0; display: grid; gap: 3px; min-width: 0; }
.host li { display: flex; gap: 10px; min-width: 0; }
.host .t { flex: none; }
.host .ht { min-width: 0; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.host .more { padding-left: 0; }
.lnk { border: 0; background: none; color: var(--accent); cursor: pointer; font: inherit; padding: 0; }
.lnk.small { font-size: 12px; }
.lnk:hover { text-decoration: underline; }
.lnk.muted { color: var(--muted); }
.check { display: grid; gap: 4px; min-width: 0; }
.check .row { gap: 4px 8px; align-items: center; }
.cmd { min-width: 0; overflow-wrap: anywhere; }
.out summary { cursor: pointer; }
.log { max-height: 320px; overflow: auto; background: var(--sunken); border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; font-size: 12px; white-space: pre-wrap; overflow-wrap: anywhere; margin: 4px 0 0; }
.checks { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
.checks li { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; padding: 4px 0; border-bottom: 1px solid var(--line); min-width: 0; }
.cdot { width: 7px; height: 7px; border-radius: 50%; background: var(--line-strong); flex: none; }
.cdot.running { background: var(--accent); }
.cdot.approved { background: var(--ok); }
.cdot.changes_requested { background: var(--warn); }
.cdot.failed { background: var(--danger); }
.ai { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 260px; }
.sess { min-width: 0; }
.sess-head { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; width: 100%; padding: 5px 4px; border: 0; border-radius: 6px; background: none; font: inherit; color: var(--ink); text-align: left; cursor: pointer; min-width: 0; }
.sess-head:hover { background: var(--hover); }
.sl { font-weight: 550; }
.entries { padding: 2px 0 6px 18px; min-width: 0; }
.tool { display: flex; align-items: center; gap: 8px; color: var(--ink-2); min-width: 0; padding: 2px 0; }
.dot { width: 6px; height: 6px; border-radius: 50%; background: var(--line-strong); flex: none; }
.tool.completed .dot { background: var(--ok); }
.tool.failed .dot { background: var(--danger); }
.tool.in_progress .dot, .tool.pending .dot { background: var(--accent); }
.stat { padding: 2px 0; overflow-wrap: anywhere; }
.text { margin: 4px 0; padding-left: 10px; border-left: 2px solid var(--line); min-width: 0; overflow-wrap: anywhere; }
.thought { padding: 2px 0; }
.thought .pre { white-space: pre-wrap; color: var(--ink-2); padding: 4px 10px; overflow-wrap: anywhere; max-height: 320px; overflow: auto; }
@media (max-width: 760px) { .ai { display: none; } }
</style>
