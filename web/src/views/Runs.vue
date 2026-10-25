<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { aiLabel, get, onServerEvent, post, type Run, type RunEvent } from "../api";
import Icon from "../components/Icon.vue";
import Skeleton from "../components/Skeleton.vue";
import VirtualList from "../components/VirtualList.vue";
import UiCheckbox from "../components/UiCheckbox.vue";
import ChipPicker from "../components/ChipPicker.vue";
import UiSegmented from "../components/UiSegmented.vue";
import UiSelect from "../components/UiSelect.vue";
import { confirmDialog } from "../lib/dialog";
import Markdown from "../components/Markdown.vue";
import AskAboutRun, { type AskContext } from "../components/AskAboutRun.vue";
import DiffFile from "../components/DiffFile.vue";
import ReviewSummary from "../components/ReviewSummary.vue";
import ReviewChecks from "../components/ReviewChecks.vue";
import ChangeView from "../components/ChangeView.vue";
import RunActivity from "../components/RunActivity.vue";
import ReviewProcess from "../components/ReviewProcess.vue";
import { fmtTime, openCitation, relTime, runKindLabel, state, statusLabel, toast } from "../store";
import { refAction } from "../lib/refs";
import { findingWhere, POINT_STATUS, SEV, useReviews, type ChangePoint } from "../lib/reviews";

const route = useRoute();
const router = useRouter();
const runs = ref<Run[]>([]);
const total = ref(0);
// About two screens of rows; scrolling loads more.
const PAGE = 40;
const loadingMore = ref(false);
/** Run kinds to show (any of them); `agent:<name>` is one agent spec's runs, `role:<name>` a built-in role's. Empty: all. */
const kindFilter = ref<string[]>([]);
const specs = ref<{ name: string; description?: string }[]>([]);
const roles = ref<{ name: string; description?: string }[]>([]);
/** Title, id or task text. */
const keyword = ref("");
const showQuiet = ref(false);
/** One status to show; empty: all. */
const statusFilter = ref<"" | "queued" | "running" | "failed">("");
const statusOptions = [{ value: "" as const, label: "全部" }, { value: "queued" as const, label: "排队中" }, { value: "running" as const, label: "进行中" }, { value: "failed" as const, label: "失败" }];
type Brief = { id: string; kind: string; title: string; status: string };
type RunContextInfo = {
  items: { id: string; title: string; status: string }[];
  conversation: { id: string; title: string; channel: string; topic: boolean; work: boolean; parentId: string | null; parentTitle: string | null; turns: { id: string; title: string; status: string; createdAt: string }[] } | null;
  parent: Brief | null;
  source: Brief | null;
  work: { id: string; title: string; rounds: { runId: string; agent: string; kind: string; status: string; title: string }[] } | null;
};
const detail = ref<{ run: Run; events: RunEvent[]; children: Run[]; patches?: { space: string; patch: string }[]; context?: RunContextInfo } | null>(null);
const id = computed(() => route.params.id as string | undefined);

const listLoading = ref(true);
const detailLoading = ref(false);
async function load() {
  listLoading.value = true;
  try {
    const page = await loadPage(0);
    runs.value = page.runs;
    total.value = page.total;
  } finally {
    listLoading.value = false;
  }
}
async function loadPage(offset: number) {
  const q = new URLSearchParams({ space: state.space, limit: String(PAGE), offset: String(offset), brief: "1" });
  if (keyword.value.trim()) q.set("q", keyword.value.trim());
  if (kindFilter.value.length) q.set("kind", kindFilter.value.join(","));
  if (showQuiet.value) q.set("all", "true");
  if (statusFilter.value) q.set("status", statusFilter.value);
  return get<{ runs: Run[]; total: number }>(`/api/runs?${q.toString()}`);
}
async function loadMore() {
  if (loadingMore.value || runs.value.length >= total.value) return;
  loadingMore.value = true;
  try {
    const page = await loadPage(runs.value.length);
    runs.value.push(...page.runs);
    total.value = page.total;
  } finally {
    loadingMore.value = false;
  }
}
async function loadDetail() {
  if (id.value && detail.value?.run.id !== id.value) detailLoading.value = true;
  try {
    detail.value = id.value ? await get(`/api/runs/${id.value}`).catch(() => null) : null;
  } finally {
    detailLoading.value = false;
  }
}
onMounted(() => {
  void get<{ name: string; description?: string }[]>("/api/agents").then((s) => (specs.value = s)).catch(() => {});
  void get<{ name: string; description?: string }[]>("/api/roles").then((r) => (roles.value = r)).catch(() => {});
  void load();
  void loadDetail();
});
watch(kindFilter, load);
watch(showQuiet, load);
watch(statusFilter, load);
let keywordTimer: ReturnType<typeof setTimeout> | undefined;
watch(keyword, () => {
  clearTimeout(keywordTimer);
  keywordTimer = setTimeout(() => void load(), 250);
});
watch(id, loadDetail);
const off = onServerEvent((e) => {
  if (e.type === "run") {
    // Keep the list itself stable: only refresh when a new top-level run might appear
    // (or, filtered by status, when a run enters or leaves that status).
    if (e.status === "queued" || statusFilter.value) reloadSoon();
    if (detail.value && (e.runId === detail.value.run.id || detail.value.children.some((c) => c.id === e.runId))) void loadDetail();
  }
});
let reloadTimer: ReturnType<typeof setTimeout> | undefined;
/** A burst of run events (a long queue draining) reloads the list once. */
function reloadSoon() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => void load(), 400);
}
function onListScroll(ev: Event) {
  const el = ev.target as HTMLElement;
  if (el.scrollHeight - el.scrollTop - el.clientHeight < 400) void loadMore();
}
onBeforeUnmount(() => { off(); clearTimeout(reloadTimer); clearTimeout(keywordTimer); });

const out = computed(() => detail.value?.run.output ?? {});
// A review of an existing branch: no coding round, nothing to apply.
const branchReview = computed(() => !!(detail.value?.run.input as { branches?: unknown } | undefined)?.branches);
const ctxInfo = computed(() => detail.value?.context ?? null);
// The full task as given to the agent (delegations, agent rounds, digests); ask turns carry their messages.
const taskText = computed(() => {
  const i = (detail.value?.run.input ?? {}) as { task?: string; text?: string };
  return String(i.task ?? i.text ?? "");
});
const taskLong = computed(() => taskText.value.split("\n").length > 14 || taskText.value.length > 1200);
const taskOpen = ref(false);
watch(id, () => (taskOpen.value = false));
const finalText = computed(() => out.value.answer ?? out.value.summary ?? out.value.coderSummary ?? "");
// One entry per repository (a delegation may change several together).
const diffs = computed(() =>
  (detail.value?.patches ?? []).map((p) => ({
    space: p.space,
    files: p.patch
      .split(/^diff --git /m)
      .filter(Boolean)
      .map((chunk) => {
        const name = /^a\/(\S+)/.exec(chunk)?.[1] ?? "?";
        const lines = chunk.split("\n").slice(1);
        return { name, lines, add: lines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length, rm: lines.filter((l) => l.startsWith("-") && !l.startsWith("---")).length };
      }),
  })),
);
const fileCount = computed(() => diffs.value.reduce((n, d) => n + d.files.length, 0));
const lineCount = computed(() => diffs.value.flatMap((d) => d.files).reduce((n, f) => ({ add: n.add + f.add, rm: n.rm + f.rm }), { add: 0, rm: 0 }));

// ---- a coding run with reviews: 概览 / 变更 / 评审 / 活动 ------------------------------------
const rv = useReviews(computed(() => (detail.value?.run.kind === "code" ? detail.value.run.id : "")), computed(() => detail.value?.run.status));
const hasReview = computed(() => !!rv.data.value && (rv.reviews.value.length > 0 || !!rv.current.value?.plan));
type Tab = "overview" | "change" | "review" | "activity";
const tab = ref<Tab>("overview");
const tabs = computed(() => [
  { id: "overview" as const, label: "概览" },
  { id: "change" as const, label: rv.changePoints.value.length ? `变更 ${rv.changePoints.value.length}` : "变更" },
  { id: "review" as const, label: "评审" },
  { id: "activity" as const, label: "活动" },
]);
watch(id, () => (tab.value = "overview"));
// The check whose process “看过程” asked for; leaving the tab forgets it.
const processFocus = ref<string | null>(null);
watch(tab, (t) => { if (t !== "activity") processFocus.value = null; });
const checkPassed = computed(() => (checks.value.length ? checks.value.every((c) => c.check.code === 0) : null));
// A change point's explanation, with the problems reported on its files, in the ask drawer.
const explaining = ref<ChangePoint | null>(null);
watch(id, () => (explaining.value = null));
const pointFindings = computed(() => {
  const p = explaining.value;
  if (!p) return [];
  const files = p.locations.map((l) => l.file);
  return rv.findings.value.filter((f) => f.file_path && files.some((x) => x === f.file_path || x.endsWith(`/${f.file_path}`) || f.file_path!.endsWith(`/${x}`)));
});
function explain(p: ChangePoint) {
  asking.value = null;
  explaining.value = p;
}
const explainContext = computed(() => {
  const p = explaining.value;
  return p ? { quote: [`${p.id} ${p.title}（${POINT_STATUS[p.status].text}）`, p.requirement && `需求：${p.requirement}`, p.implementation && `实现：${p.implementation}`, p.locations.map((l) => `${l.file}${l.start ? `:${l.start}${l.end && l.end !== l.start ? `-${l.end}` : ""}` : ""}`).join("、")].filter(Boolean).join("\n"), label: `变更点 ${p.id}` } : null;
});
// Diffs start folded (a large change would bury everything below); a file's lines render only once opened.
const openDiffs = ref(new Set<string>());
watch(id, () => (openDiffs.value = new Set()));
function onDiffToggle(key: string, e: Event) {
  const open = (e.target as HTMLDetailsElement).open;
  if (open === openDiffs.value.has(key)) return;
  const next = new Set(openDiffs.value);
  open ? next.add(key) : next.delete(key);
  openDiffs.value = next;
}
function toggleAllDiffs() {
  openDiffs.value = openDiffs.value.size ? new Set() : new Set(diffs.value.flatMap((d) => d.files.map((f) => `${d.space}:${f.name}`)));
}
const spaceName = (id: string) => state.spaces.find((s) => s.id === id)?.name ?? id;

// ---- asking about a selection (diff lines, the task, a review) -------------------------------
const asking = ref<AskContext | null>(null);
const selection = ref<{ top: number; left: number; context: AskContext } | null>(null);
watch(id, () => { asking.value = null; selection.value = null; });
// The button is placed against the viewport: any scroll moves the text away from it.
const dropSelection = () => (selection.value = null);
onMounted(() => window.addEventListener("scroll", dropSelection, { capture: true, passive: true }));
onBeforeUnmount(() => window.removeEventListener("scroll", dropSelection, { capture: true }));
function lineOf(node: Node | null) {
  const el = node instanceof Element ? node : node?.parentElement;
  return Number(el?.closest("tr[data-line]")?.getAttribute("data-line")) || null;
}
function onSelect() {
  // Wait for the browser to settle the selection after the click.
  setTimeout(() => {
    const sel = window.getSelection();
    const text = sel?.toString().trim() ?? "";
    if (!sel || !text || sel.rangeCount === 0 || detail.value?.run.kind !== "code") return void (selection.value = null);
    const range = sel.getRangeAt(0);
    const host = (range.commonAncestorContainer instanceof Element ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement)!;
    const file = host.closest<HTMLElement>(".dfile");
    let label = host.closest<HTMLElement>("[data-ask-label]")?.dataset.askLabel ?? "运行详情里的一段";
    if (file) {
      const lines = [lineOf(range.startContainer), lineOf(range.endContainer)].filter((n): n is number => !!n);
      const at = lines.length ? `:${Math.min(...lines)}${Math.max(...lines) !== Math.min(...lines) ? `-${Math.max(...lines)}` : ""}` : "";
      label = `${spaceName(file.dataset.space ?? "")} · ${file.dataset.path}${at}`;
    }
    const rect = range.getBoundingClientRect();
    selection.value = { top: Math.max(8, rect.top - 40), left: Math.min(window.innerWidth - 180, Math.max(8, rect.left)), context: { quote: text.slice(0, 4000), label } };
  }, 0);
}
function askSelection() {
  if (!selection.value) return;
  explaining.value = null;
  asking.value = selection.value.context;
  selection.value = null;
  window.getSelection()?.removeAllRanges();
}
type Check = { command: string; code: number; output: string };
const checks = computed<{ space: string; check: Check }[]>(() => {
  const repos = (out.value.repos ?? []) as { space: string; check: Check | null }[];
  if (repos.length) return repos.filter((r) => r.check).map((r) => ({ space: repos.length > 1 ? r.space : "", check: r.check! }));
  return out.value.check ? [{ space: "", check: out.value.check }] : [];
});
async function act(action: "cancel" | "retry" | "apply" | "discard") {
  if (!detail.value) return;
  if (action === "apply" && !(await confirmDialog("把这些改动应用到仓库工作区？", { message: "只会成为工作区里未提交的修改。", okText: "应用" }))) return;
  try {
    await post(`/api/runs/${detail.value.run.id}/${action}`);
    toast({ cancel: "已停止", retry: "已重新排队", apply: "已应用到工作区，请在仓库中检查并提交", discard: "已清理工作区" }[action], "ok");
    void loadDetail();
  } catch (e) {
    toast((e as Error).message, "error");
  }
}
const delegateOpen = ref(false);
type DelegateMode = "code" | "review";
const mode = ref<DelegateMode>("code");
const modeOptions = [
  { value: "code" as const, label: "实现" },
  { value: "review" as const, label: "评审分支" },
];
const emptyTask = () => ({ repos: [] as string[], task: "", check: "", branch: "", base: "", fromBranch: "" });
const task = ref(emptyTask());
type BranchList = { current: string; base: string | null; branches: { name: string; commit: string; at: string; subject: string; remote: boolean }[] };
const branchList = ref<BranchList | null>(null);
const branchLoading = ref(false);
// Branches of the first chosen repository (repositories of one requirement usually share the branch name).
async function loadBranches(fetch = false) {
  const repo = task.value.repos[0];
  if (!repo) return void (branchList.value = null);
  branchLoading.value = true;
  try {
    branchList.value = await get<BranchList>(`/api/spaces/${encodeURIComponent(repo)}/branches${fetch ? "?fetch=1" : ""}`);
  } catch (e) {
    branchList.value = null;
    toast((e as Error).message, "error");
  } finally {
    branchLoading.value = false;
  }
}
const branchOptions = computed(() => (branchList.value?.branches ?? []).map((b) => ({ value: b.name, label: b.name, hint: `${b.at.slice(0, 10)} · ${b.subject}` })));
const baseOptions = computed(() => [{ value: "", label: `默认（${branchList.value?.base ?? "main"}）` }, ...branchOptions.value]);
const fromOptions = computed(() => [{ value: "", label: `当前检出（${branchList.value?.current ?? "HEAD"}）` }, ...branchOptions.value]);
watch([delegateOpen, () => task.value.repos[0]], ([open]) => {
  if (open) void loadBranches();
});
const repos = computed(() => state.spaces.filter((s) => s.rootPath));
const current = computed(() => state.spaces.find((s) => s.id === state.space));
// Start from the current repository, or the repositories related to the current project.
watch(delegateOpen, (open) => {
  if (!open || task.value.repos.length) return;
  const here = current.value;
  const ids = repos.value.map((r) => r.id);
  task.value.repos = here?.rootPath ? [here.id] : (here?.related ?? []).map((r) => r.space).filter((id) => ids.includes(id));
});
async function delegate() {
  try {
    // A task started from a project belongs to the project; otherwise to its first repository.
    const space = current.value?.kind === "project" ? current.value.id : task.value.repos[0];
    const t = task.value;
    const r = mode.value === "review"
      ? await post<Run>("/api/review-branch", { space, repos: t.repos, branch: t.branch, base: t.base || undefined, task: t.task.trim() || undefined })
      : await post<Run>("/api/delegate", { space, repos: t.repos, task: t.task, checkCommand: t.check || undefined, fromBranch: t.fromBranch || undefined });
    delegateOpen.value = false;
    task.value = emptyTask();
    router.push(`/runs/${r.id}`);
  } catch (e) {
    toast((e as Error).message, "error");
  }
}
// The hint carries the other language, so the filter box finds a kind or role by either name.
const kindOptions = computed(() => [
  ...Object.entries(runKindLabel).map(([k, label]) => ({ value: k, label, hint: k })),
  ...roles.value.map((r) => ({ value: `role:${r.name}`, label: `内置 · ${r.name}`, hint: r.description ?? "" })),
  ...specs.value.map((s) => ({ value: `agent:${s.name}`, label: `Agent · ${s.name}`, hint: s.description ?? "这个 Agent 档案的运行" })),
]);
</script>

<template>
  <div class="runs">
    <aside class="list-col">
      <div class="head row">
        <strong>运行记录</strong>
        <label class="search"><Icon name="search" :size="14" /><input v-model="keyword" placeholder="标题、id 或任务里的字" aria-label="搜索运行记录" /></label>
        <span class="spacer" />
        <button class="btn sm" title="交办编码任务" @click="delegateOpen = true"><Icon name="code" :size="14" />交办</button>
        <ChipPicker v-model="kindFilter" class="kind-filter" :options="kindOptions" labels :add-label="kindFilter.length ? '＋ 类型' : '全部类型 ＋'" />
        <UiSegmented v-model="statusFilter" class="status-filter" size="sm" aria-label="状态" :options="statusOptions" />
        <UiCheckbox v-model="showQuiet" size="sm" class="small muted" title="后台任务（巡检、检查页面、筛选群、复盘…）没发现要处理的事时以 QUIET 结束，这些运行默认不显示；勾选后一起显示">含无事可报</UiCheckbox>
      </div>
      <div class="items" @scroll.passive="onListScroll">
        <Skeleton v-if="listLoading && !runs.length" :rows="8" />
        <VirtualList v-else :items="runs" :item-key="(r) => r.id" :estimate="54">
          <template #default="{ item: r }">
            <router-link :to="`/runs/${r.id}`" class="run" :class="{ on: r.id === id }" :title="r.title">
              <span class="st" :class="r.status" />
              <div class="grow">
                <div class="ellipsis">{{ r.title }}</div>
                <div class="muted small ellipsis">{{ runKindLabel[r.kind] ?? r.kind }} · {{ statusLabel[r.status] }} · {{ relTime(r.createdAt) }}<template v-if="r.parentId"> · 后续</template><template v-if="aiLabel(r)"> · <span class="mono">{{ aiLabel(r) }}</span></template></div>
                <div v-if="r.waiting" class="muted small ellipsis" :title="r.waiting">{{ r.waiting }}</div>
              </div>
            </router-link>
          </template>
        </VirtualList>
        <div v-if="!runs.length && !listLoading" class="muted small pad">{{ keyword.trim() || kindFilter.length ? "没有符合条件的运行。" : statusFilter ? `没有${statusOptions.find((o) => o.value === statusFilter)?.label}的运行。` : "还没有运行记录。" }}</div>
        <div v-else-if="loadingMore" class="list-foot">加载中…</div>
        <div v-else-if="runs.length >= total" class="list-foot">共 {{ total }} 条</div>
      </div>
    </aside>
    <main class="detail" @mouseup="onSelect" @keyup.shift="onSelect">
      <div v-if="detailLoading" class="pad-loading"><Skeleton variant="text" :rows="8" /></div>
      <div v-else-if="!detail" class="empty">
        <Icon name="activity" :size="34" />
        <h3>后台运行</h3>
        <p>问答、整理、Wiki 写作、交办编码和巡检都会在这里留下记录：Agent 做了哪些调查、改了什么、结果如何。</p>
      </div>
      <template v-else>
        <header class="dh">
          <div class="row wrap small">
            <span class="badge accent">{{ runKindLabel[detail.run.kind] ?? detail.run.kind }}</span>
            <span class="badge" :class="{ ok: detail.run.status === 'done', danger: detail.run.status === 'failed', warn: detail.run.status === 'running' }">{{ statusLabel[detail.run.status] }}</span>
            <span class="muted">{{ fmtTime(detail.run.createdAt) }}<template v-if="detail.run.finishedAt"> → {{ fmtTime(detail.run.finishedAt) }}</template></span>
            <span v-if="aiLabel(detail.run)" class="muted" title="这次运行用的后端、模型和思考强度">· <span class="mono">{{ aiLabel(detail.run) }}</span></span>
            <span v-if="detail.run.spaceId" class="muted">· {{ detail.run.spaceId }}</span>
            <span v-if="rv.current.value?.plan" class="badge">「{{ rv.current.value.plan.tierName }}」档</span>
            <router-link v-for="it in ctxInfo?.items ?? []" :key="it.id" :to="`/items/${it.id}`" class="item-link" :title="it.title">事项：{{ it.title }}</router-link>
          </div>
          <h1 :title="detail.run.title">{{ detail.run.title }}</h1>
          <div v-if="detail.run.kind === 'code' && fileCount" class="row wrap small muted sub">
            <span>{{ diffs.length > 1 ? `${diffs.length} 个仓库 · ` : "" }}{{ fileCount }} 个文件 · <span class="add">+{{ lineCount.add }}</span> <span class="rm">−{{ lineCount.rm }}</span><template v-if="checkPassed !== null"> · 检查{{ checkPassed ? "通过" : "没通过" }}</template></span>
            <span class="spacer" />
            <UiSegmented v-if="rv.roundOptions.value.length > 1" v-model="rv.round.value" size="sm" :options="rv.roundOptions.value" aria-label="轮次" />
          </div>
          <p v-if="detail.run.waiting" class="muted small waiting" title="omem 自己的排队：开始运行时才选定后端和模型">排队中：{{ detail.run.waiting }}。开始运行时才选定后端和模型；后端自己的排队会在开始后的过程里显示。</p>
          <div class="row">
            <button v-if="['queued', 'running'].includes(detail.run.status)" class="btn sm" @click="act('cancel')"><Icon name="stop" :size="13" />停止</button>
            <button v-if="['failed', 'cancelled'].includes(detail.run.status)" class="btn sm" @click="act('retry')"><Icon name="refresh" :size="13" />重试</button>
            <template v-if="detail.run.kind === 'code' && detail.run.status === 'done' && detail.patches?.length && !out.appliedAt && !out.discardedAt">
              <button v-if="!branchReview" class="btn primary sm" @click="act('apply')"><Icon name="check" :size="14" />应用到仓库</button>
              <button class="btn sm danger" :title="branchReview ? '删除评审用的工作区和它的索引' : undefined" @click="act('discard')">{{ branchReview ? "清理工作区" : "丢弃" }}</button>
            </template>
            <span v-if="out.appliedAt" class="badge ok">已应用 {{ fmtTime(out.appliedAt) }}</span>
            <button v-if="detail.run.kind === 'code'" class="btn ghost sm" @click="explaining = null; asking = { quote: '', label: '' }"><Icon name="chat" :size="14" />提问</button>
          </div>
        </header>

        <nav v-if="hasReview" class="tabs" role="tablist" aria-label="运行详情">
          <button v-for="t in tabs" :key="t.id" role="tab" class="tab" :class="{ on: tab === t.id }" :aria-selected="tab === t.id" @click="tab = t.id">{{ t.label }}</button>
        </nav>
        <ReviewSummary v-if="hasReview && tab === 'overview'" :rv="rv" :run-id="detail.run.id" :review-text="out.review" :branch-review="branchReview" :can-fix="detail.run.status === 'done' && !out.appliedAt && (branchReview || !out.discardedAt)" data-ask-label="评审" @ask="(c) => { explaining = null; asking = c; }" @go="(t) => (tab = t)" />
        <ChangeView v-if="hasReview && tab === 'change'" :rv="rv" :run-id="detail.run.id" :diffs="diffs" @explain="explain" />
        <ReviewChecks v-if="hasReview && tab === 'review'" :rv="rv" :run-id="detail.run.id" data-ask-label="评审" @process="(c) => { processFocus = c; tab = 'activity'; }" />

        <template v-if="!hasReview || tab === 'activity'">
        <section v-if="ctxInfo && (ctxInfo.conversation || ctxInfo.parent || ctxInfo.work)" class="card pad block ctx">
          <div class="section-title">所在会话与关联</div>
          <div v-if="ctxInfo.conversation" class="ctx-row">
            <span class="muted small">会话</span>
            <span class="grow">
              <router-link :to="`/ask/${ctxInfo.conversation.id}`">{{ ctxInfo.conversation.title || ctxInfo.conversation.id }}</router-link>
              <span class="badge">{{ ctxInfo.conversation.work ? "多 Agent 工作会话" : ctxInfo.conversation.topic ? "飞书话题" : ctxInfo.conversation.channel === "lark" ? "飞书会话" : ctxInfo.conversation.channel }}</span>
              <span v-if="ctxInfo.conversation.parentTitle" class="muted small">（从「{{ ctxInfo.conversation.parentTitle }}」开出）</span>
            </span>
          </div>
          <div v-if="ctxInfo.parent" class="ctx-row">
            <span class="muted small">由</span>
            <router-link class="grow ellipsis" :to="`/runs/${ctxInfo.parent.id}`" :title="ctxInfo.parent.title">{{ runKindLabel[ctxInfo.parent.kind] ?? ctxInfo.parent.kind }} · {{ ctxInfo.parent.title }}</router-link>
          </div>
          <div v-if="ctxInfo.source" class="ctx-row">
            <span class="muted small">消化</span>
            <router-link class="grow ellipsis" :to="`/runs/${ctxInfo.source.id}`" :title="ctxInfo.source.title">{{ ctxInfo.source.title }}</router-link>
          </div>
          <div v-if="ctxInfo.work" class="ctx-steps">
            <div class="muted small">这项工作的各轮（{{ ctxInfo.work.rounds.length }}）</div>
            <router-link v-for="(w, i) in ctxInfo.work.rounds" :key="w.runId" :to="`/runs/${w.runId}`" class="li" :class="{ on: w.runId === detail.run.id }" :title="w.title">
              <span class="st" :class="w.status" /><span class="muted small">{{ i + 1 }}</span>
              <span class="grow ellipsis">{{ w.kind === "agent-followup" ? "消化结论" : w.agent }} · {{ w.title }}</span>
              <span class="muted small">{{ statusLabel[w.status] }}</span>
            </router-link>
          </div>
          <div v-if="ctxInfo.conversation && ctxInfo.conversation.turns.length > 1" class="ctx-steps">
            <div class="muted small">同一会话里的对话轮次（{{ ctxInfo.conversation.turns.length }}）</div>
            <router-link v-for="t in ctxInfo.conversation.turns" :key="t.id" :to="`/runs/${t.id}`" class="li" :class="{ on: t.id === detail.run.id }" :title="t.title">
              <span class="st" :class="t.status" /><span class="grow ellipsis">{{ t.title }}</span><span class="muted small">{{ fmtTime(t.createdAt) }}</span>
            </router-link>
          </div>
        </section>

        <section v-if="taskText" class="card pad block" data-ask-label="任务原文">
          <div class="section-title row">任务<span class="spacer" /><button v-if="taskLong" class="btn ghost sm" @click="taskOpen = !taskOpen">{{ taskOpen ? "收起" : "展开全部" }}</button></div>
          <div class="pre task" :class="{ clipped: taskLong && !taskOpen }">{{ taskText }}</div>
        </section>

        <ReviewProcess v-if="hasReview" :rv="rv" :focus="processFocus" />
        <section v-else class="block">
          <RunActivity :run-id="detail.run.id" :open="['queued', 'running'].includes(detail.run.status)">
            <template #default="{ text, running }">
              <Markdown v-if="running && text" :source="text" />
            </template>
          </RunActivity>
        </section>

        <section v-if="finalText" class="block">
          <div class="section-title">{{ detail.run.kind === "code" ? (branchReview ? "要评审的分支" : "编码 Agent 的说明") : "结果" }}</div>
          <div class="card pad"><Markdown :source="String(finalText)" :space="detail.run.spaceId ?? undefined" /></div>
        </section>

        <section v-for="c in checks" :key="c.space" class="block">
          <div class="section-title">检查<template v-if="c.space"> · {{ spaceName(c.space) }}</template>：<span class="mono">{{ c.check.command }}</span> <span class="badge" :class="c.check.code === 0 ? 'ok' : 'danger'">退出码 {{ c.check.code }}</span></div>
          <pre class="log">{{ c.check.output }}</pre>
        </section>

        <section v-if="fileCount" class="block">
          <div class="section-title row">改动 · {{ diffs.length > 1 ? `${diffs.length} 个仓库，` : "" }}{{ fileCount }} 个文件<span class="spacer" /><span class="muted small hint-sel">选中代码可以就它提问</span><button class="btn ghost sm" @click="toggleAllDiffs">{{ openDiffs.size ? "全部收起" : "全部展开" }}</button></div>
          <p v-if="out.indexedSpaces?.length && !out.appliedAt && !out.discardedAt" class="muted small">{{ branchReview ? "清理工作区之前" : "应用或丢弃之前" }}，改过的文件可以检索（空间 {{ out.indexedSpaces.join("、") }}）；之后连同 worktree 一起删除。</p>
          <template v-for="d in diffs" :key="d.space">
          <div v-if="diffs.length > 1" class="repo-title">{{ spaceName(d.space) }}</div>
          <details v-for="f in d.files" :key="f.name" class="file" :open="openDiffs.has(`${d.space}:${f.name}`)" @toggle="onDiffToggle(`${d.space}:${f.name}`, $event)">
            <summary class="mono small"><span>{{ f.name }}</span><span class="add">+{{ f.add }}</span><span class="rm">-{{ f.rm }}</span></summary>
            <DiffFile v-if="openDiffs.has(`${d.space}:${f.name}`)" :run-id="detail.run.id" :space="d.space" :lines="f.lines" />
          </details>
          </template>
        </section>

        <section v-if="detail.children.length" class="block">
          <div class="section-title">后续任务</div>
          <div class="list">
            <router-link v-for="c in detail.children" :key="c.id" :to="`/runs/${c.id}`" class="li"><span class="st" :class="c.status" /><span class="grow ellipsis">{{ c.title }}</span><span class="muted small">{{ statusLabel[c.status] }}</span></router-link>
          </div>
        </section>
        </template>
      </template>
    </main>

    <button v-if="selection" class="sel-ask btn sm primary" :style="{ top: `${selection.top}px`, left: `${selection.left}px` }" @mousedown.prevent @click="askSelection"><Icon name="chat" :size="13" />就选中内容提问</button>
    <AskAboutRun v-if="asking && detail" :key="detail.run.id" :run-id="detail.run.id" :run-title="detail.run.title" :space-id="detail.run.spaceId" :context="asking.quote ? asking : null" @close="asking = null" />
    <AskAboutRun v-else-if="explaining && detail" :key="`${detail.run.id}:${explaining.id}`" :run-id="detail.run.id" :run-title="detail.run.title" :space-id="detail.run.spaceId" :context="explainContext" :heading="`${explaining.id} ${explaining.title}`" @close="explaining = null">
      <div class="explain">
        <div class="row"><span class="badge" :class="POINT_STATUS[explaining.status].cls">{{ POINT_STATUS[explaining.status].text }}</span></div>
        <template v-if="explaining.requirement"><div class="ex-h">需求怎么说</div><Markdown :source="explaining.requirement" :space="detail.run.spaceId ?? undefined" /></template>
        <template v-if="explaining.implementation"><div class="ex-h">代码怎么做</div><Markdown :source="explaining.implementation" :space="detail.run.spaceId ?? undefined" /></template>
        <template v-if="explaining.locations.length"><div class="ex-h">位置</div><div class="mono small locs"><a v-for="(l, i) in explaining.locations" :key="i" href="#" @click.prevent="openCitation({ kind: 'file', runId: detail.run.id, path: l.file, from: l.start, to: l.end ?? l.start }, true)">{{ l.file }}{{ l.start ? `:${l.start}${l.end && l.end !== l.start ? `-${l.end}` : ""}` : "" }}</a></div></template>
        <template v-if="explaining.refs.length"><div class="ex-h">依据</div><div class="small"><template v-for="(r, i) in explaining.refs" :key="i"><a v-if="refAction(r, detail.run.id)" href="#" class="mono" @click.prevent="refAction(r, detail.run.id)!()">{{ r }}</a><span v-else class="mono">{{ r }}</span>{{ i < explaining.refs.length - 1 ? "、" : "" }}</template></div></template>
        <template v-if="pointFindings.length"><div class="ex-h">这些文件上的问题</div><div v-for="f in pointFindings" :key="f.id" class="small ex-f"><span class="badge" :class="SEV[f.severity].cls">{{ SEV[f.severity].text }}</span> {{ f.title }} <span class="mono muted">{{ findingWhere(f) }}</span></div></template>
      </div>
    </AskAboutRun>

    <div v-if="delegateOpen" class="modal-overlay" @mousedown.self="delegateOpen = false">
      <div class="modal stack">
        <div class="row"><strong>交办编码任务</strong><span class="spacer" /><UiSegmented v-model="mode" size="sm" aria-label="交办方式" :options="modeOptions" /><button class="btn ghost sm icon" @click="delegateOpen = false"><Icon name="x" /></button></div>
        <p v-if="mode === 'code'" class="muted small">每个仓库各开一个独立的 Git worktree，由编码 Agent 一起实现，分别运行检查命令，再由评审 Agent 审查。确认后所有仓库一起应用。</p>
        <p v-else class="muted small">把已有的分支检出到独立工作区，取它从基线分叉以来的全部改动，按评审档位交给各评审项审查。只出评审意见，不改代码。</p>
        <div v-if="!repos.length" class="muted">还没有关联代码目录的空间，请先在设置里新建代码仓库空间。</div>
        <template v-else>
          <div class="field">
            <span>{{ mode === "review" ? "分支所在的仓库（可多选，分支名相同）" : "仓库（可多选，一起改）" }}</span>
            <div class="repo-picks">
              <UiCheckbox v-for="r in repos" :key="r.id" v-model="task.repos" :value="r.id" size="sm">{{ r.name }}</UiCheckbox>
            </div>
          </div>
          <div v-if="task.repos.length" class="branch-row">
            <template v-if="mode === 'review'">
              <div class="field grow"><span>要评审的分支</span><UiSelect v-model="task.branch" :options="branchOptions" :placeholder="branchLoading ? '读取分支…' : '选择分支'" :search-at="1" aria-label="要评审的分支" /></div>
              <div class="field grow"><span>对照的基线</span><UiSelect v-model="task.base" :options="baseOptions" :search-at="1" aria-label="基线分支" /></div>
            </template>
            <div v-else class="field grow"><span>从哪里开始改</span><UiSelect v-model="task.fromBranch" :options="fromOptions" :search-at="1" aria-label="起点分支" /></div>
            <button class="btn ghost sm" :disabled="branchLoading" title="从 origin 拉取全部分支" @click="loadBranches(true)"><Icon name="refresh" :size="13" />拉取</button>
          </div>
          <label class="field"><span>{{ mode === "review" ? "需求说明和评审要求（可选）" : "任务" }}</span><textarea v-model="task.task" class="textarea" rows="6" :placeholder="mode === 'review' ? '需求要解决什么、验收标准、相关文档或讨论、特别关心的点' : '目标、背景、验收标准、相关讨论'" /></label>
          <label v-if="mode === 'code'" class="field"><span>检查命令（可选，默认用空间设置）</span><input v-model="task.check" class="input mono" placeholder="pnpm test" /></label>
          <div class="row"><span class="spacer" /><button class="btn primary" :disabled="!task.repos.length || (mode === 'review' ? !task.branch : !task.task.trim())" @click="delegate">{{ mode === "review" ? "开始评审" : "交办" }}</button></div>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.branch-row {
  display: flex;
  gap: 12px;
  align-items: flex-end;
  flex-wrap: wrap;
}
.branch-row .grow {
  flex: 1 1 200px;
  min-width: 0;
}
.repo-picks {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 14px;
  max-height: 160px;
  overflow: auto;
}
.repo-title {
  margin: 12px 0 6px;
  font-weight: 600;
}
.pad-loading {
  max-width: 760px;
  padding: 8px 0;
}
.runs {
  display: flex;
  height: 100%;
}
.list-col {
  width: 320px;
  flex: none;
  border-right: 1px solid var(--line);
  display: flex;
  flex-direction: column;
}
.head {
  padding: 14px 12px 10px;
  border-bottom: 1px solid var(--line);
  display: grid;
  grid-template-columns: auto 1fr auto;
  grid-template-areas:
    "title . delegate"
    "search search search"
    "status status status"
    "kind kind quiet";
  row-gap: 8px;
  align-items: center;
}
.head > strong { grid-area: title; }
.head .search { grid-area: search; display: flex; align-items: center; gap: 6px; height: 30px; padding: 0 8px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); color: var(--muted); }
.head .search:focus-within { border-color: var(--accent); }
.head .search input { flex: 1; min-width: 0; border: 0; outline: 0; background: none; font: inherit; font-size: 13px; color: var(--ink); }
.head .btn[title="交办编码任务"] { grid-area: delegate; }
.head .kind-filter { grid-area: kind; justify-self: start; }
.head .status-filter { grid-area: status; justify-self: start; }
.head .small.muted { grid-area: quiet; justify-self: end; white-space: nowrap; }
@media (max-width: 480px) {
  .head {
    grid-template-columns: 1fr auto;
    grid-template-areas:
      "title delegate"
      "search search"
      "status status"
      "kind quiet";
  }
}
.sm-select {
  width: auto;
  height: 28px;
  padding: 0 8px;
  font-size: 12.5px;
}
.items {
  overflow-y: auto;
  padding: 6px;
}
.run {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 8px 10px;
  border-radius: 8px;
  color: inherit;
}
.run:hover {
  background: var(--hover);
  text-decoration: none;
}
.run.on {
  background: var(--accent-soft);
}
.st {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--line-strong);
  flex: none;
  margin-top: 7px;
}
.st.running,
.st.queued {
  background: var(--accent);
}
.st.done {
  background: var(--ok);
}
.st.failed {
  background: var(--danger);
}
.grow {
  flex: 1;
  min-width: 0;
}
.pad {
  padding: 10px;
}
.detail {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding: 22px 28px 60px;
}
.dh {
  display: grid;
  gap: 8px;
  margin-bottom: 18px;
}
.dh h1 {
  font-size: 21px;
}
.dh .waiting {
  margin: 0;
}
.dh .sub {
  gap: 8px;
}
.dh .add {
  color: var(--ok);
}
.dh .rm {
  color: var(--danger);
}
.item-link {
  color: var(--accent);
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tabs {
  display: flex;
  gap: 4px;
  border-bottom: 1px solid var(--line);
  margin: -6px 0 16px;
  overflow-x: auto;
  overflow-y: hidden;
}
.tab {
  border: 0;
  background: none;
  font: inherit;
  color: var(--ink-2);
  padding: 8px 12px;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  cursor: pointer;
  white-space: nowrap;
}
.tab:hover {
  color: var(--ink);
}
.tab.on {
  color: var(--ink);
  font-weight: 600;
  border-bottom-color: var(--ink);
}
.explain {
  display: grid;
  gap: 6px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--line);
}
.ex-h {
  margin-top: 8px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--muted);
}
.locs {
  display: grid;
  gap: 2px;
  overflow-wrap: anywhere;
}
.ex-f {
  overflow-wrap: anywhere;
}
.block {
  margin-bottom: 20px;
}
.pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.pre.task.clipped {
  max-height: 16.5em;
  overflow: hidden;
  -webkit-mask-image: linear-gradient(#000 75%, transparent);
  mask-image: linear-gradient(#000 75%, transparent);
}
.ctx {
  display: grid;
  gap: 8px;
}
.ctx-row {
  display: flex;
  gap: 10px;
  align-items: baseline;
  min-width: 0;
}
.ctx-row > .muted {
  flex: none;
  width: 2.5em;
}
.ctx-row .badge {
  margin-left: 6px;
}
.ctx-steps {
  display: grid;
  gap: 2px;
  margin-top: 4px;
}
.ctx-steps .li {
  display: flex;
  gap: 8px;
  align-items: center;
  min-width: 0;
  padding: 5px 8px;
  border-radius: 6px;
  color: inherit;
}
.ctx-steps .li:hover {
  background: var(--hover);
  text-decoration: none;
}
.ctx-steps .li.on {
  background: var(--accent-soft);
}
.log {
  background: var(--sunken);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 10px 12px;
  max-height: 320px;
  overflow: auto;
  font-size: 12px;
  margin: 0;
  white-space: pre-wrap;
}
.file {
  border: 1px solid var(--line);
  border-radius: 8px;
  margin-bottom: 10px;
  overflow: hidden;
}
.file summary {
  display: flex;
  gap: 10px;
  padding: 7px 12px;
  background: var(--sunken);
  cursor: pointer;
}
.file .add {
  color: var(--ok);
}
.file .rm {
  color: var(--danger);
}
.sel-ask {
  position: fixed;
  z-index: 38;
  box-shadow: var(--shadow-lg);
}
.hint-sel {
  font-weight: 400;
  letter-spacing: 0;
}
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(10, 12, 16, 0.35);
  z-index: 55;
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding-top: 10vh;
}
.modal {
  width: min(620px, calc(100vw - 24px));
  background: var(--panel);
  border-radius: 14px;
  border: 1px solid var(--line);
  box-shadow: var(--shadow-lg);
  padding: 18px;
}
@media (max-width: 760px) {
  .runs {
    flex-direction: column;
  }
  .list-col {
    width: 100%;
    max-height: 35vh;
  }
  .detail {
    padding: 16px;
  }
}
</style>
