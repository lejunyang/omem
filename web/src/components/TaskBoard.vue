<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { get, onServerEvent } from "../api";
import Markdown from "./Markdown.vue";
import RichText from "./RichText.vue";
import Skeleton from "./Skeleton.vue";
import { fmtTime } from "../store";
import { accessText, lateText, placeLabel, remoteHref, type AttemptPlace } from "../lib/progress";

/**
 * A piece of work split into parts done side by side (src/agents/work-board.ts): who has each part,
 * on which model, how long it waited and ran, what came back and whether the one who split the work
 * accepted it. One row a part; a track shows the parts running at the same time. A row opens to its
 * goal, what counts as done, the report and every attempt.
 */
type Attempt = { runId: string; status: string; queuedAt: string; startedAt: string | null; finishedAt: string | null; result: string | null; backend?: string | null; model?: string | null; used?: number | null; queuedMs: number; executionMs: number } & AttemptPlace;
type Verdict = { by: string; at: string; decision: "accept" | "redo" | "block"; note: string };
type Task = { id: string; seq: number; title: string; goal: string; accept: string; agent: string | null; required: boolean; status: string; attempts: Attempt[]; report: string; verdict: Verdict | null; deadlineAt: string };
type Board = { workId: string; title: string; status: "running" | "review" | "summarized"; workConversationId?: string | null; rootConversationId?: string | null; tasks: Task[] };

const props = defineProps<{ workId: string; focus?: string }>();
const board = ref<Board>();
const error = ref("");
const open = ref<string | null>(props.focus ?? null);
let seq = 0;
async function load() {
  const n = ++seq;
  try {
    const b = await get<Board>(`/api/agent-work/${props.workId}/board`);
    if (n === seq) { board.value = b; error.value = ""; }
  } catch (e) {
    if (n === seq) error.value = (e as Error).message;
  }
}
watch(() => props.workId, () => { board.value = undefined; open.value = props.focus ?? null; void load(); }, { immediate: true });
const off = onServerEvent((e) => { if ((e as { type: string; workId?: string }).type === "work" && (e as { workId?: string }).workId === props.workId) void load(); });
// The track of a part still running grows with the clock.
const nowMs = ref(Date.now());
const timer = window.setInterval(() => { if (board.value?.status === "running") nowMs.value = Date.now(); }, 5000);
onBeforeUnmount(() => { seq++; off(); window.clearInterval(timer); });

const STATUS: Record<string, { label: string; tone: "ok" | "accent" | "warn" | "muted" | "danger" }> = {
  pending: { label: "排队", tone: "muted" },
  running: { label: "在做", tone: "accent" },
  done: { label: "交了，等验收", tone: "warn" },
  failed: { label: "没做成", tone: "danger" },
  cancelled: { label: "已取消", tone: "muted" },
  accepted: { label: "已接受", tone: "ok" },
  rejected: { label: "退回重做", tone: "accent" },
  blocked: { label: "阻塞", tone: "warn" },
};
const BOARD = { running: "分头在做", review: "交齐了，等验收", summarized: "已验收" } as const;
const took = (ms: number) => (ms < 1000 ? "" : ms < 90_000 ? `${Math.round(ms / 1000)} 秒` : ms < 5_400_000 ? `${Math.round(ms / 60_000)} 分钟` : `${(ms / 3_600_000).toFixed(1)} 小时`);
const who = (t: Task) => {
  const a = t.attempts.at(-1);
  return [t.agent && t.agent !== "assistant" ? t.agent : "临时助手", a?.model ?? a?.backend ?? "", a ? placeLabel(a) : ""].filter(Boolean).join(" · ");
};

/** The span every track is drawn on: from the first part queued to the last one finished (or now). */
const span = computed(() => {
  const all = (board.value?.tasks ?? []).flatMap((t) => t.attempts);
  if (!all.length) return null;
  const start = Math.min(...all.map((a) => Date.parse(a.queuedAt)));
  const end = Math.max(...all.map((a) => (a.finishedAt ? Date.parse(a.finishedAt) : nowMs.value)));
  return { start, length: Math.max(1000, end - start) };
});
function segments(t: Task) {
  const s = span.value;
  if (!s) return [];
  const pct = (ms: number) => `${Math.max(0, Math.min(100, ((ms - s.start) / s.length) * 100)).toFixed(2)}%`;
  const wide = (from: number, to: number) => `${Math.max(0.6, ((to - from) / s.length) * 100).toFixed(2)}%`;
  return t.attempts.flatMap((a, i) => {
    const queued = Date.parse(a.queuedAt), started = a.startedAt ? Date.parse(a.startedAt) : null, ended = a.finishedAt ? Date.parse(a.finishedAt) : nowMs.value;
    const tone = a.status === "done" ? "ok" : a.status === "failed" ? "danger" : a.status === "cancelled" ? "muted" : "accent";
    return [
      { key: `${i}-q`, cls: "wait", left: pct(queued), width: wide(queued, started ?? ended), title: `第 ${i + 1} 次 · 排队 ${took((started ?? ended) - queued) || "不到 1 秒"}` },
      ...(started ? [{ key: `${i}-r`, cls: `run ${tone}`, left: pct(started), width: wide(started, ended), title: `第 ${i + 1} 次 · 执行 ${took(ended - started) || "不到 1 秒"}` }] : []),
    ];
  });
}
const counts = computed(() => {
  const ts = board.value?.tasks ?? [];
  const n = (...s: string[]) => ts.filter((t) => s.includes(t.status)).length;
  return [`${ts.length} 块`, n("pending", "running", "rejected") ? `${n("pending", "running", "rejected")} 块在做` : "", n("done", "failed") ? `${n("done", "failed")} 块等验收` : "", n("accepted") ? `${n("accepted")} 块已接受` : "", n("blocked") ? `${n("blocked")} 块阻塞` : ""].filter(Boolean).join(" · ");
});
const ATTEMPT: Record<string, string> = { queued: "排队", running: "在做", done: "交了", failed: "没做成", cancelled: "已取消" };
const DECISION = { accept: "接受", redo: "退回重做", block: "标为阻塞" } as const;
</script>

<template>
  <section class="tb" aria-label="协同任务板">
    <header>
      <strong>分头在做的几块</strong>
      <span v-if="board" class="badge" :class="{ accent: board.status === 'running', warn: board.status === 'review', ok: board.status === 'summarized' }">{{ BOARD[board.status] }}</span>
      <span v-if="board" class="muted small">{{ counts }}</span>
      <span class="grow" />
      <router-link v-if="board?.workConversationId" :to="`/ask/${board.workConversationId}`" class="small">在对话里看</router-link>
    </header>
    <p v-if="error" class="small" role="alert">{{ error }} <button type="button" class="btn sm" @click="load">重试</button></p>
    <Skeleton v-else-if="!board" :rows="3" />
    <ul v-else class="rows">
      <li v-for="t in board.tasks" :key="t.id" :class="{ open: open === t.id }">
        <button type="button" class="row" :aria-expanded="open === t.id" @click="open = open === t.id ? null : t.id">
          <span class="n">{{ t.seq }}</span>
          <span class="main">
            <span class="title">{{ t.title }}<span v-if="!t.required" class="opt">可选</span></span>
            <span class="who">{{ who(t) }}<template v-if="t.attempts.length > 1"> · 第 {{ t.attempts.length }} 次</template></span>
          </span>
          <span class="track" aria-hidden="true"><span v-for="s in segments(t)" :key="s.key" class="seg" :class="s.cls" :style="{ left: s.left, width: s.width }" :title="s.title" /></span>
          <span class="state" :class="STATUS[t.status]?.tone">{{ STATUS[t.status]?.label ?? t.status }}</span>
          <span class="time">{{ took(t.attempts.at(-1)?.executionMs ?? 0) }}</span>
        </button>
        <div v-if="open === t.id" class="more">
          <dl>
            <dt>要做什么</dt><dd><RichText :text="t.goal" breaks /></dd>
            <dt>怎样算完</dt><dd><RichText :text="t.accept" breaks /></dd>
            <template v-if="t.verdict">
              <dt>验收</dt><dd>{{ DECISION[t.verdict.decision] }}<template v-if="t.verdict.note">：<RichText :text="t.verdict.note" /></template> <span class="muted small">{{ fmtTime(t.verdict.at) }}</span></dd>
            </template>
          </dl>
          <div v-if="t.report" class="report"><Markdown :source="t.report" compact /></div>
          <ol class="tries">
            <li v-for="(a, i) in t.attempts" :key="a.runId">
              <router-link :to="`/runs/${a.runId}`">第 {{ i + 1 }} 次</router-link>
              <span class="muted small">{{ [a.model ?? a.backend, placeLabel(a), accessText(a), took(a.queuedMs) && `排队 ${took(a.queuedMs)}`, took(a.executionMs) && `执行 ${took(a.executionMs)}`, a.used ? `上下文 ${Math.round(a.used / 1000)}k` : "", a.mode && a.deadline && `期限 ${fmtTime(a.deadline)}`, ATTEMPT[a.status] ?? a.status].filter(Boolean).join(" · ") }}</span>
              <span v-if="lateText(a)" class="late small">{{ lateText(a) }}</span>
              <a v-if="remoteHref(a)" :href="remoteHref(a)!" target="_blank" rel="noopener" class="small">对方的运行</a>
            </li>
          </ol>
        </div>
      </li>
    </ul>
    <p v-if="board && span" class="legend muted small"><span class="seg wait key" />排队<span class="seg run accent key" />在做<span class="seg run ok key" />交了<span class="seg run danger key" />没做成 · 横向是时间，几条重叠就是同时在做</p>
  </section>
</template>

<style scoped>
.tb { border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel); min-width: 0; }
header { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 12px 16px; border-bottom: 1px solid var(--line); font-size: 15px; }
.grow { flex: 1; }
.rows { list-style: none; margin: 0; padding: 0; }
.rows > li + li { border-top: 1px solid var(--line); }
.row { all: unset; box-sizing: border-box; display: grid; grid-template-columns: 22px minmax(0, 1.1fr) minmax(80px, 1fr) auto 64px; align-items: center; gap: 12px; width: 100%; padding: 10px 16px; cursor: pointer; }
.row:hover { background: var(--hover); }
.row:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.n { font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; text-align: right; }
.main { display: grid; gap: 1px; min-width: 0; }
.title { font-size: 13.5px; line-height: 1.45; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.opt { margin-left: 6px; font-size: 11px; color: var(--muted); border: 1px solid var(--line-strong); border-radius: 999px; padding: 0 5px; }
.who { font-size: 12px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.track { position: relative; height: 8px; border-radius: 4px; background: var(--sunken); min-width: 0; }
.seg { position: absolute; top: 0; bottom: 0; border-radius: 4px; }
.seg.wait { background: repeating-linear-gradient(90deg, var(--line-strong) 0 2px, transparent 2px 5px); }
.seg.run.accent { background: var(--accent); }
.seg.run.ok { background: var(--ok); }
.seg.run.danger { background: var(--danger); }
.seg.run.muted { background: var(--line-strong); }
.state { font-size: 12px; font-weight: 600; white-space: nowrap; }
.state.ok { color: var(--ok); }
.state.accent { color: var(--accent); }
.state.warn { color: var(--warn); }
.state.danger { color: var(--danger); }
.state.muted { color: var(--muted); }
.time { font-size: 12px; color: var(--muted); text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.more { padding: 4px 16px 14px 50px; display: grid; gap: 10px; min-width: 0; }
dl { display: grid; grid-template-columns: 5.5em minmax(0, 1fr); gap: 4px 12px; margin: 0; font-size: 13px; }
dt { color: var(--muted); }
dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.report { border-left: 2px solid var(--line-strong); padding-left: 12px; max-height: 360px; overflow-y: auto; min-width: 0; }
.tries { margin: 0; padding-left: 1.4em; font-size: 13px; display: grid; gap: 2px; }
.tries li > * + * { margin-left: 8px; }
.late { color: var(--warn); }
.legend { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin: 0; padding: 8px 16px 12px; border-top: 1px solid var(--line); }
.key { position: static; display: inline-block; width: 18px; height: 6px; margin-left: 8px; }
.key:first-child { margin-left: 0; }
@media (max-width: 760px) {
  .row { grid-template-columns: 18px minmax(0, 1fr) auto; row-gap: 6px; }
  .track { grid-column: 2 / -1; grid-row: 2; }
  .time { display: none; }
  .more { padding-left: 16px; }
}
</style>
