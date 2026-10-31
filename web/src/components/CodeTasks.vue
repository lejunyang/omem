<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { get, onServerEvent, post } from "../api";
import { promptDialog } from "../lib/dialog";
import { parsePatches } from "../lib/reviews";
import { relTime, toast } from "../store";
import DiffFile from "./DiffFile.vue";
import DiffName from "./DiffName.vue";

/**
 * A delegation driven by tasks (docs/v2/coding-loop.md): where it stands and how much budget is left,
 * the questions waiting for the owner (answering one never holds the rest), every task with where it
 * came from, how its verification went and its own change, and what changed since the owner last
 * looked. The owner can add a task, pause or go on, re-do, drop or revert a task at any time.
 */
type TaskState = "todo" | "coding" | "verify" | "done" | "owner" | "wontdo" | "reverted";
type Note = { at: string; by: string; text: string; kind: string };
type Task = { seq: number; title: string; doneWhen: string; kind: "build" | "fix" | "owner" | "redo"; origin: { findings?: number[]; note?: string; files?: string[] }; state: TaskState; question: string | null; options: string[]; answer: string | null; verifier: string | null; attempts: number; reverts: number; commits: Record<string, string[]>; checkpoint: number | null; notes: Note[] };
type Checkpoint = { seq: number; tasks: number[]; label: string; createdAt: string };
type Work = { budget: number; budgetBy: "owner" | "coder" | null; until: number; round: number; lastRunId: string; paused: string | null; viewed: number; status: string; verdict: string | null; stage: string | null; reverts: number[]; max: number };
type Data = { taskMode: boolean; rootId?: string; tasks?: Task[]; checkpoints?: Checkpoint[]; work?: Work };

const props = defineProps<{ runId: string }>();
const data = ref<Data | null>(null);
async function load() {
  data.value = await get<Data>(`/api/runs/${props.runId}/tasks`).catch(() => null);
}
watch(() => props.runId, load, { immediate: true });
let timer: ReturnType<typeof setTimeout> | null = null;
const off = onServerEvent((e) => {
  if (!data.value?.taskMode) return;
  if ((e.type === "changed" && e.entity === "code-task") || e.type === "run") {
    if (timer) clearTimeout(timer);
    timer = setTimeout(load, 400);
  }
});
onBeforeUnmount(() => { off(); if (timer) clearTimeout(timer); });

const STATE: Record<TaskState, { text: string; cls: string }> = {
  todo: { text: "待做", cls: "" }, coding: { text: "编码中", cls: "accent" }, verify: { text: "待验证", cls: "accent" }, done: { text: "已完成", cls: "ok" },
  owner: { text: "等你决定", cls: "warn" }, wontdo: { text: "不做", cls: "" }, reverted: { text: "已回退", cls: "danger" },
};
const WHO: Record<string, string> = { coder: "编码 Agent", host: "omem", owner: "你", reviewer: "功能评审", "review-business": "业务评审", "review-arch": "架构评审", "review-style": "规范评审", "review-history": "历史评审", "review-lead": "评审负责人" };
const who = (by: string) => WHO[by] ?? (by.startsWith("u") || by === "owner" ? "你" : by);
const PAUSE: Record<string, string> = { budget: "暂停：自动推进的轮数用完了", owner: "你暂停了", "not-converging": "暂停：修改没有收敛", paused: "已暂停" };

const tasks = computed(() => data.value?.tasks ?? []);
const w = computed(() => data.value?.work ?? null);
const owner = computed(() => tasks.value.filter((t) => t.state === "owner"));
const groups = computed(() => [
  { id: "open", label: "进行中", list: tasks.value.filter((t) => ["coding", "verify", "todo"].includes(t.state)) },
  { id: "done", label: "已完成", list: tasks.value.filter((t) => t.state === "done") },
  { id: "other", label: "不做与回退", list: tasks.value.filter((t) => ["wontdo", "reverted"].includes(t.state)) },
].filter((g) => g.list.length));
const busy = computed(() => !!w.value && ["queued", "running"].includes(w.value.status));
const status = computed(() => {
  const x = w.value;
  if (!x) return null;
  if (busy.value) return { text: x.status === "queued" ? "排队中" : x.stage === "verify" ? "逐项验证中" : x.stage === "plan" ? "评审负责人在定这次评审看什么" : x.stage === "checks" || x.stage === "lead" ? "阶段评审中" : "编码中", cls: "accent" };
  if (x.paused) return { text: PAUSE[x.paused] ?? "已暂停", cls: "warn" };
  const open = tasks.value.some((t) => ["todo", "coding", "verify"].includes(t.state));
  if (owner.value.length) return { text: `等你决定 ${owner.value.length} 项${open ? "" : "，其余已做完"}`, cls: "warn" };
  if (x.verdict === "approved") return { text: "完成，等你确认", cls: "ok" };
  return { text: x.status === "failed" ? "这一轮失败了" : "已停下", cls: "warn" };
});
const lastCp = computed(() => data.value?.checkpoints?.at(-1)?.seq ?? 0);
const fixCount = (t: Task) => Object.values(t.commits).reduce((n, l) => n + l.length, 0);
const source = (t: Task) => t.origin.findings?.length ? `评审问题 ${t.origin.findings.map((f) => `#${f}`).join("、")}${t.verifier ? ` · ${who(t.verifier)}验证` : ""}` : t.kind === "owner" ? "你的要求" : t.kind === "redo" ? "回退后重做" : "拆分";

const open = ref(new Set<number>());
const toggle = (seq: number) => { const n = new Set(open.value); n.has(seq) ? n.delete(seq) : n.add(seq); open.value = n; };

const working = ref(false);
async function act(path: string, body: unknown, done: string) {
  if (working.value) return;
  working.value = true;
  try {
    const r = await post<{ next?: string | null }>(path, body);
    toast(r.next ? `${done}，下一轮已经开始` : done, "ok");
    await load();
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    working.value = false;
  }
}
const taskAct = (t: Task, action: string, extra: Record<string, unknown>, done: string) => act(`/api/runs/${props.runId}/tasks/${t.seq}`, { action, ...extra }, done);

// ---- questions --------------------------------------------------------------------------------
const answers = ref<Record<number, string>>({});
const answer = (t: Task, choice: string | null) => taskAct(t, "answer", { choice, text: answers.value[t.seq]?.trim() || undefined }, `已回答 T${t.seq}`);
const skip = (t: Task) => taskAct(t, "skip", { text: answers.value[t.seq]?.trim() || undefined }, `T${t.seq} 不做了`);

// ---- per task -----------------------------------------------------------------------------------
async function withReason(title: string, message: string, run: (text: string) => Promise<void>, required = false) {
  const text = await promptDialog(title, { message, placeholder: required ? "必填" : "可以不写" });
  if (text === null || (required && !text.trim())) return;
  await run(text.trim());
}
const reopen = (t: Task) => withReason(`重做 T${t.seq}`, "写一句要怎么改（编码 Agent 会看到）", (text) => taskAct(t, "reopen", { text }, `T${t.seq} 重新排进待做`));
const drop = (t: Task) => withReason(`T${t.seq} 不做了`, "写一句理由（之后的评审会看到，不再提）", (text) => taskAct(t, "wontdo", { text }, `T${t.seq} 不做了`), true);
const revert = (t: Task, redo: boolean) => withReason(`${redo ? "回退并重做" : "回退"} T${t.seq}`, `下一轮开始前把它的提交回退掉${redo ? "，再按原来的完成标准和这句原因重做" : ""}。原因：`, (text) => taskAct(t, "revert", { text: text || undefined, redo }, `T${t.seq} 会在下一轮开始前回退`));
async function addTask() {
  const text = await promptDialog("加一个修改项", { message: "第一行作标题，后面写清楚要怎样算做完。下一轮就做（现在没在跑就马上开始）。", placeholder: "要改什么" });
  if (!text?.trim()) return;
  const [title, ...rest] = text.trim().split("\n");
  await act(`/api/runs/${props.runId}/tasks`, { title: title.slice(0, 200), detail: rest.join("\n").trim() || undefined }, "加上了");
}
const pause = (paused: boolean) => act(`/api/runs/${props.runId}/work`, { paused }, paused ? "已暂停：手上这一项做完就停" : "继续推进");

// ---- changes ------------------------------------------------------------------------------------
type Shown = { title: string; files: ReturnType<typeof parsePatches>; loading: boolean };
const shown = ref<Shown | null>(null);
const openFiles = ref(new Set<string>());
async function showChanges(title: string, query: string, after?: () => void) {
  shown.value = { title, files: [], loading: true };
  openFiles.value = new Set();
  try {
    const r = await get<{ patches: { space: string; patch: string }[] }>(`/api/runs/${props.runId}/task-diff?${query}`);
    shown.value = { title, files: parsePatches(r.patches), loading: false };
    after?.();
  } catch (e) {
    shown.value = null;
    toast((e as Error).message, "error");
  }
}
const showTask = (t: Task) => showChanges(`T${t.seq} ${t.title} 的改动`, `tasks=${t.seq}`);
const showSince = () => {
  const from = w.value?.viewed ?? 0;
  void showChanges(from ? `检查点 ${from} 以后的改动` : "从开始到现在的改动", "since=viewed", () => void post(`/api/runs/${props.runId}/work`, { viewed: lastCp.value }).then(load).catch(() => {}));
};
const showAll = () => showChanges("从开始到现在的全部改动", "from=0");
const fileKey = (space: string, name: string) => `${space}:${name}`;
const toggleFile = (k: string) => { const n = new Set(openFiles.value); n.has(k) ? n.delete(k) : n.add(k); openFiles.value = n; };
</script>

<template>
  <section v-if="data?.taskMode && w" class="tasks card pad block" aria-label="修改项">
    <div class="head row wrap">
      <span class="badge" :class="status?.cls">{{ status?.text }}</span>
      <span class="muted small">第 {{ w.round }} 轮 · 最多自动推进到第 {{ w.until }} 轮（每次 {{ w.budget }} 轮，{{ w.budgetBy === "owner" ? "你给的" : "按任务估的" }}，上限 {{ w.max }}）</span>
      <span class="spacer" />
      <button class="btn sm" :disabled="working" @click="addTask">加修改项</button>
      <button v-if="w.paused" class="btn primary sm" :disabled="working" @click="pause(false)">继续推进</button>
      <button v-else-if="busy || tasks.some((t) => ['todo', 'coding', 'verify'].includes(t.state))" class="btn ghost sm" :disabled="working" @click="pause(true)">暂停</button>
    </div>

    <div v-if="owner.length" class="ask block">
      <div class="section-title">等你决定</div>
      <div v-for="t in owner" :key="t.seq" class="q">
        <p class="small"><strong>T{{ t.seq }} {{ t.title }}</strong></p>
        <p class="pre small">{{ t.question ?? t.doneWhen }}</p>
        <div class="row wrap">
          <button v-for="o in t.options" :key="o" class="btn sm" :disabled="working" @click="answer(t, o)">{{ o }}</button>
          <input v-model="answers[t.seq]" class="input sm grow" :aria-label="`T${t.seq} 你的做法`" placeholder="或者写你的做法" @keydown.enter="answers[t.seq]?.trim() && answer(t, null)" />
          <button class="btn primary sm" :disabled="working || !answers[t.seq]?.trim()" @click="answer(t, null)">按我说的做</button>
          <button class="btn ghost sm" :disabled="working" @click="skip(t)">不做这一项</button>
        </div>
      </div>
    </div>

    <div class="row wrap changes-bar small">
      <span class="muted">看改动：</span>
      <button class="lnk" @click="showSince">{{ w.viewed ? `我上次看过之后（检查点 ${w.viewed} → ${lastCp}）` : "从开始到现在" }}</button>
      <button v-if="w.viewed" class="lnk" @click="showAll">全部</button>
      <span class="muted">· 共 {{ data.checkpoints?.length ?? 0 }} 个检查点</span>
    </div>

    <div v-for="g in groups" :key="g.id" class="group">
      <div class="section-title">{{ g.label }} · {{ g.list.length }}</div>
      <div v-for="t in g.list" :key="t.seq" class="task" :class="{ on: open.has(t.seq) }">
        <button class="trow" :aria-expanded="open.has(t.seq)" @click="toggle(t.seq)">
          <span class="seq mono">T{{ t.seq }}</span>
          <span class="title">{{ t.title }}</span>
          <span class="badge" :class="STATE[t.state].cls">{{ STATE[t.state].text }}</span>
          <span class="muted small meta">{{ source(t) }}{{ t.attempts ? ` · 第 ${t.attempts + 1} 次` : "" }}{{ t.reverts ? ` · 回退过 ${t.reverts} 次` : "" }}{{ data.work?.reverts.includes(t.seq) ? " · 下一轮先回退" : "" }}</span>
        </button>
        <div v-if="open.has(t.seq)" class="more small">
          <p v-if="t.doneWhen"><span class="muted">完成标准：</span>{{ t.doneWhen }}</p>
          <p v-if="t.answer"><span class="muted">你的决定：</span>{{ t.answer }}</p>
          <ol v-if="t.notes.length" class="notes">
            <li v-for="(n, i) in t.notes" :key="i"><span class="muted">{{ relTime(n.at) }} · {{ who(n.by) }}：</span>{{ n.text }}</li>
          </ol>
          <div class="row wrap">
            <button v-if="fixCount(t)" class="btn ghost sm" @click="showTask(t)">看改动（{{ fixCount(t) }} 个提交）</button>
            <button v-if="['done', 'wontdo', 'reverted'].includes(t.state)" class="btn ghost sm" :disabled="working" @click="reopen(t)">重做</button>
            <button v-if="['todo', 'owner'].includes(t.state)" class="btn ghost sm" :disabled="working" @click="drop(t)">不做了</button>
            <template v-if="fixCount(t) && ['done', 'verify'].includes(t.state) && !data.work?.reverts.includes(t.seq)">
              <button class="btn ghost sm" :disabled="working" @click="revert(t, true)">回退并重做</button>
              <button class="btn ghost sm danger" :disabled="working" @click="revert(t, false)">回退</button>
            </template>
          </div>
        </div>
      </div>
    </div>

    <div v-if="shown" class="shown block">
      <div class="row wrap"><strong class="small">{{ shown.title }}</strong><span class="spacer" /><button class="btn ghost sm" @click="shown = null">收起</button></div>
      <p v-if="shown.loading" class="muted small">正在取改动…</p>
      <p v-else-if="!shown.files.some((d) => d.files.length)" class="muted small">没有改动。</p>
      <template v-for="d in shown.files" :key="d.space">
        <div v-for="f in d.files" :key="fileKey(d.space, f.name)" class="file">
          <button class="fhead mono small" :aria-expanded="openFiles.has(fileKey(d.space, f.name))" @click="toggleFile(fileKey(d.space, f.name))"><DiffName :file="f" /><span class="add">+{{ f.add }}</span><span class="rm">-{{ f.rm }}</span></button>
          <DiffFile v-if="openFiles.has(fileKey(d.space, f.name))" :run-id="runId" :space="d.space" :lines="f.lines" :expandable="false" />
        </div>
      </template>
    </div>
  </section>
</template>

<style scoped>
.tasks { display: grid; gap: 12px; min-width: 0; }
.head { gap: 8px; align-items: center; }
.ask { display: grid; gap: 10px; padding: 10px 12px; border-radius: 10px; background: var(--warn-soft, var(--sunken)); }
.ask .section-title { margin: 0; }
.q { display: grid; gap: 6px; }
.q p { margin: 0; }
.pre { white-space: pre-wrap; overflow-wrap: anywhere; }
.grow { flex: 1; min-width: 160px; }
.changes-bar { gap: 6px; align-items: center; }
.lnk { border: 0; background: none; color: var(--accent); cursor: pointer; font: inherit; padding: 0 2px; }
.lnk:hover { text-decoration: underline; }
.group { display: grid; gap: 4px; }
.group .section-title { margin: 4px 0 2px; }
.task { border: 1px solid var(--line); border-radius: 8px; min-width: 0; }
.task.on { border-color: var(--line-strong); }
.trow { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; width: 100%; padding: 7px 10px; border: 0; background: none; color: var(--ink); font: inherit; text-align: left; cursor: pointer; min-width: 0; }
.trow:hover { background: var(--hover); }
.seq { color: var(--muted); flex: none; }
.title { flex: 1 1 240px; min-width: 0; overflow-wrap: anywhere; }
.meta { flex: 1 1 100%; padding-left: 34px; }
.more { display: grid; gap: 6px; padding: 4px 12px 10px 44px; overflow-wrap: anywhere; }
.more p { margin: 0; }
.notes { margin: 0; padding-left: 18px; display: grid; gap: 2px; }
.danger { color: var(--danger); }
.shown { display: grid; gap: 8px; min-width: 0; }
.file { border: 1px solid var(--line); border-radius: 8px; overflow: hidden; min-width: 0; }
.fhead { display: flex; gap: 10px; width: 100%; padding: 7px 12px; background: var(--sunken); border: 0; color: var(--ink); cursor: pointer; text-align: left; min-width: 0; }
.add { color: var(--ok); }
.rm { color: var(--danger); }
@media (max-width: 760px) {
  .meta { padding-left: 0; }
  .more { padding-left: 12px; }
}
</style>
