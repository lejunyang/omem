<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { get, onServerEvent, onServerResync } from "../api";
import {
  accessText, BLOCK_LABEL, blockHref, blockTone, decisionText, doneCount, KIND_LABEL, lateText, missingText, orderTasks, outputHref, outputLabel, outputUrl, readProgress,
  pendingNeeds, placeLabel, remoteHref, runIdsOf, shortId, TASK_LABEL, taskHref, taskTone, took, usageText, waitLabel, whoLabel, ownerWait,
  type ProgressTask, type ProgressUsage, type ProgressView,
} from "../lib/progress";
import { plainLine } from "../lib/plain";
import { fmtTime } from "../store";
import Icon from "./Icon.vue";
import TaskBoard from "./TaskBoard.vue";

/**
 * Where a piece of work split across agents stands (src/agents/progress.ts): one summary line a block — a
 * work board, a coding delegation, a review, a flow, a study — and, opened, one compact row a task: who
 * does it, how long, what came back, whether it was accepted. Read only: every row goes to its own page,
 * where its actions are. Not shown at all when there is nothing (or an older server has no such view).
 *
 * `run`: the blocks under this run's root (the run page); `item`: those on a work item (the work page);
 * `focus`: a board task to open on.
 */
const props = defineProps<{ run?: string; item?: string; focus?: string; label?: string }>();
const emit = defineEmits<{ state: [state: "ready" | "empty" | "error"] }>();

const blocks = ref<ProgressView[] | null>(null);
/** The page's total, each run counted once across the blocks (the server's; an older one sends none). */
const total = ref<ProgressUsage | null>(null);
/** The blocks opened (by id), kept across reloads. */
const opened = ref<Set<string>>(new Set());
/** The task whose attempts are listed: `${block}/${task}`. */
const tries = ref<string | null>(null);
/** The board block whose own board (the time track, the reports) is shown below. */
const boardOpen = ref<string | null>(null);
let seq = 0, first = true;

const path = computed(() => (props.run ? `/api/runs/${encodeURIComponent(props.run)}/progress` : props.item ? `/api/items/${encodeURIComponent(props.item)}/progress` : ""));
async function load() {
  const n = ++seq, want = path.value;
  if (!want) return;
  try {
    const page = readProgress(await get<unknown>(`${want}?summary=true`));
    if (n !== seq || want !== path.value) return;
    blocks.value = page.views;
    total.value = page.total;
    if (first) {
      first = false;
      const focusBlock = props.focus ? blocks.value.find((b) => b.kind === "board" && b.tasks.some((t) => t.id === props.focus)) : undefined;
      if (focusBlock) opened.value = new Set([keyOf(focusBlock)]);
      else if (blocks.value.length === 1) opened.value = new Set([keyOf(blocks.value[0])]);
    }
    emit("state", blocks.value.length ? "ready" : "empty");
  } catch {
    // Not what the page is about: an older server without this view, or no access, leaves the block away.
    if (n === seq) { blocks.value = []; emit("state", "error"); }
  }
}
watch(path, () => { ++seq; first = true; blocks.value = null; total.value = null; opened.value = new Set(); tries.value = null; boardOpen.value = null; void load(); }, { immediate: true });

// Refresh on what the page already hears: a run in these blocks, a board's work, the item itself.
let timer: ReturnType<typeof setTimeout> | undefined;
const soon = () => { clearTimeout(timer); timer = setTimeout(() => void load(), 500); };
const known = computed(() => runIdsOf(blocks.value ?? []));
const off = onServerEvent((e) => {
  const x = e as { type: string; runId?: string; workId?: string; entity?: string; id?: string };
  if (x.type === "run" && x.runId && (known.value.has(x.runId) || x.runId === props.run)) soon();
  else if (x.type === "work" && x.workId && (blocks.value ?? []).some((b) => b.id === x.workId || b.runId === x.workId)) soon();
  else if (x.type === "changed" && x.entity === "item" && props.item && x.id === props.item) soon();
});
const resync = onServerResync(() => void load());
onBeforeUnmount(() => { ++seq; off(); resync(); clearTimeout(timer); });


/** A block's own key: a delegation and its review share the run's id. */
function keyOf(b: Pick<ProgressView, "kind" | "id">) { return `${b.kind}:${b.id}`; }
function toggle(b: ProgressView) {
  const next = new Set(opened.value);
  if (next.has(keyOf(b))) next.delete(keyOf(b));
  else next.add(keyOf(b));
  opened.value = next;
}
const bodyId = (b: ProgressView) => `pg-${b.kind}-${b.id.replace(/[^\w-]/g, "_")}`;
const triesKey = (b: ProgressView, t: ProgressTask) => `${keyOf(b)}/${t.id}`;
const toneClass = (tone: string) => `tone-${tone}`;
function summaryOf(b: ProgressView) {
  const c = doneCount(b);
  return {
    tone: blockTone(b),
    count: c.total ? `${c.done} / ${c.total} 完成` : "",
    wait: waitLabel(b),
    usage: usageText(b.usage),
    missing: missingText(b.usage),
    rounds: (b.rounds?.length ?? 0) > 1 ? `${b.rounds!.length} 轮` : "",
  };
}
/** The total of the page, when there is more than one block to add up. */
const totalText = computed(() => {
  if (!total.value || (blocks.value?.length ?? 0) < 2) return "";
  return [usageText(total.value) && `合计 ${usageText(total.value)}`, missingText(total.value)].filter(Boolean).join(" · ");
});
const summaries = computed(() => new Map((blocks.value ?? []).map((b) => [keyOf(b), summaryOf(b)])));
const resultText = (t: ProgressTask) => decisionText(t) || TASK_LABEL[t.state] || t.state;
const ATTEMPT: Record<string, string> = { queued: "排队", running: "在做", done: "做完", failed: "没做成", cancelled: "已取消" };
const blockLink: Record<ProgressView["kind"], string> = { board: "看任务板", code: "打开交办", review: "看评审", flow: "看流程", study: "看课题" };
</script>

<template>
  <section v-if="blocks && blocks.length" class="pg" :aria-label="label ?? '进度'">
    <div v-if="label || totalText" class="pg-head">
      <h2 v-if="label" class="pg-label">{{ label }}</h2>
      <span v-if="totalText" class="pg-total" title="这一页所有运行报上来的 token，同一个运行只算一次">{{ totalText }}</span>
    </div>
    <div v-for="b in blocks" :key="keyOf(b)" class="pg-block" :class="[toneClass(summaries.get(keyOf(b))!.tone), { open: opened.has(keyOf(b)) }]">
      <button type="button" class="pg-sum" :aria-expanded="opened.has(keyOf(b))" :aria-controls="bodyId(b)" @click="toggle(b)">
        <Icon :name="opened.has(keyOf(b)) ? 'down' : 'right'" :size="14" class="pg-chev" />
        <span class="pg-kind">{{ KIND_LABEL[b.kind] }}</span>
        <span class="pg-title" :title="plainLine(b.title, 400)">{{ plainLine(b.title, 120) }}</span>
        <span class="pg-facts">
          <span class="pg-state">{{ BLOCK_LABEL[b.state] }}</span>
          <span v-if="summaries.get(keyOf(b))!.count" class="pg-n">{{ summaries.get(keyOf(b))!.count }}</span>
          <span v-if="summaries.get(keyOf(b))!.rounds" class="pg-n">{{ summaries.get(keyOf(b))!.rounds }}</span>
          <span v-if="summaries.get(keyOf(b))!.wait" class="pg-wait" :class="{ owner: ownerWait(summaries.get(keyOf(b))!.wait) }">{{ summaries.get(keyOf(b))!.wait }}</span>
          <span v-if="summaries.get(keyOf(b))!.usage" class="pg-use" title="这一块所有运行报上来的 token">{{ summaries.get(keyOf(b))!.usage }}</span>
          <span v-if="summaries.get(keyOf(b))!.missing" class="pg-miss">{{ summaries.get(keyOf(b))!.missing }}</span>
        </span>
      </button>
      <div v-if="opened.has(keyOf(b))" :id="bodyId(b)" class="pg-body">
        <p v-if="!b.tasks.length" class="pg-none">{{ b.kind === "code" ? "这次交办没有拆成修改项。" : "还没有分出来的任务。" }}</p>
        <ul v-else class="pg-tasks" :aria-label="`${KIND_LABEL[b.kind]}的任务`">
          <li v-for="{ task: t, depth } in orderTasks(b.tasks)" :key="t.id" class="pg-task" :class="[toneClass(taskTone(t)), { deep: depth > 0 }]">
            <span class="pg-dot" :title="TASK_LABEL[t.state]" aria-hidden="true" />
            <div class="pg-main">
              <router-link v-if="taskHref(b, t)" :to="taskHref(b, t)!" class="pg-tt" :title="plainLine(t.title, 400)">{{ plainLine(t.title, 100) }}</router-link>
              <span v-else class="pg-tt" :title="plainLine(t.title, 400)">{{ plainLine(t.title, 100) }}</span>
              <span class="pg-meta">
                <span v-if="whoLabel(t)">{{ whoLabel(t) }}</span>
                <span v-if="took(t.attempts.at(-1)?.runMs)">{{ took(t.attempts.at(-1)?.runMs) }}</span>
                <button v-if="t.attempts.length > 1" type="button" class="pg-try" :aria-expanded="tries === triesKey(b, t)" @click="tries = tries === triesKey(b, t) ? null : triesKey(b, t)">第 {{ t.attempts.length }} 次</button>
                <a v-if="t.attempts.length === 1 && remoteHref(t.attempts[0])" :href="remoteHref(t.attempts[0])!" target="_blank" rel="noopener">对方的运行</a>
                <span v-if="t.attempts.length && lateText(t.attempts.at(-1)!)" class="pg-late">{{ lateText(t.attempts.at(-1)!) }}</span>
                <span v-if="pendingNeeds(t, b.tasks).length" class="pg-need">等 {{ pendingNeeds(t, b.tasks).map((n) => shortId(n, b.tasks)).join("、") }}</span>
                <span v-if="t.waitingOn && !['accepted', 'cancelled'].includes(t.state)" class="pg-tw" :class="{ owner: ownerWait(t.waitingOn) }">{{ t.waitingOn }}</span>
              </span>
            </div>
            <span v-if="t.outputs?.length" class="pg-outs">
              <template v-for="o in t.outputs.slice(0, 2)" :key="o.kind + o.ref">
                <a v-if="outputUrl(o)" :href="outputUrl(o)!" target="_blank" rel="noopener noreferrer" class="pg-out" :title="o.ref">{{ outputLabel(o) }}</a>
                <router-link v-else-if="outputHref(b, o)" :to="outputHref(b, o)!" class="pg-out" :title="outputLabel(o)">{{ outputLabel(o) }}</router-link>
                <span v-else class="pg-out mono" :title="o.label">{{ outputLabel(o) }}</span>
              </template>
              <span v-if="t.outputs.length > 2" class="pg-more">另 {{ t.outputs.length - 2 }} 项</span>
            </span>
            <span class="pg-res">{{ resultText(t) }}</span>
            <ol v-if="tries === triesKey(b, t)" class="pg-tries" :aria-label="`${plainLine(t.title, 40)}的历次尝试`">
              <li v-for="(a, i) in t.attempts" :key="a.runId">
                <router-link :to="`/runs/${a.runId}`">第 {{ i + 1 }} 次</router-link>
                <span>{{ [placeLabel(a), accessText(a), ATTEMPT[a.status] ?? a.status, took(a.queuedMs) && `排队 ${took(a.queuedMs)}`, took(a.runMs) && `执行 ${took(a.runMs)}`, a.mode && a.deadline && `期限 ${fmtTime(a.deadline)}`, usageText(a.usage), missingText(a.usage)].filter(Boolean).join(" · ") }}</span>
                <span v-if="lateText(a)" class="pg-late">{{ lateText(a) }}</span>
                <a v-if="remoteHref(a)" :href="remoteHref(a)!" target="_blank" rel="noopener">对方的运行</a>
              </li>
            </ol>
          </li>
        </ul>
        <div class="pg-foot">
          <span v-if="b.previousRounds?.length" class="pg-prev">之前 {{ b.previousRounds.length }} 轮：{{ b.previousRounds.map((r) => `第 ${r.round} 轮 ${r.directions} 个方向、${r.trials} 次试验`).join("；") }}</span>
          <span class="pg-grow" />
          <button v-if="b.kind === 'board'" type="button" class="btn ghost sm" :aria-expanded="boardOpen === keyOf(b)" @click="boardOpen = boardOpen === keyOf(b) ? null : keyOf(b)">{{ boardOpen === keyOf(b) ? "收起任务板" : "看时间轴和报告" }}</button>
          <router-link v-else-if="blockHref(b)" :to="blockHref(b)!" class="small">{{ blockLink[b.kind] }}</router-link>
        </div>
        <TaskBoard v-if="b.kind === 'board' && boardOpen === keyOf(b)" :work-id="b.id" :focus="focus" />
      </div>
    </div>
  </section>
</template>
