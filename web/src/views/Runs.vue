<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
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
import AskAboutRun from "../components/AskAboutRun.vue";
import FixBasket from "../components/FixBasket.vue";
import QuoteDock from "../components/QuoteDock.vue";
import DiffFile from "../components/DiffFile.vue";
import DiffTree from "../components/DiffTree.vue";
import { diffLayout, diffLayoutOptions } from "../lib/diffLayout";
import ReviewSummary from "../components/ReviewSummary.vue";
import CodeSteer from "../components/CodeSteer.vue";
import OpenInIde from "../components/OpenInIde.vue";
import ReviewChecks from "../components/ReviewChecks.vue";
import ChangeView from "../components/ChangeView.vue";
import RunActivity from "../components/RunActivity.vue";
import CodeGitPanel from "../components/CodeGitPanel.vue";
import ReviewProcess from "../components/ReviewProcess.vue";
import { fmtTime, openCitation, relTime, runKindLabel, state, statusLabel, toast } from "../store";
import { refAction } from "../lib/refs";
import { addQuote, quotesOf, type QuoteKind } from "../lib/quotes";
import { findingWhere, pointCount, POINT_STATUS, SEV, useReviews, type ChangePoint } from "../lib/reviews";

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
type ApplyTarget = { space: string; path: string; branch: string | null };
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
  const q = new URLSearchParams({ limit: String(PAGE), offset: String(offset), brief: "1" });
  // A guest's question runs in the group's space, a rule in the chat's: "所有空间" finds them from anywhere.
  if (scope.value === "space") q.set("space", state.space);
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
const scope = ref<"space" | "all">("space");
watch(scope, load);
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
// Titles are cut to a short label when the run is made; the hover shows the task's own text.
function hintOf(r: { title: string; input?: Record<string, unknown> }) {
  const task = String(r.input?.task ?? r.input?.text ?? "").trim();
  return task.length > r.title.length ? `${r.title}\n\n${task.length >= 600 ? `${task.slice(0, 600)}…` : task}` : r.title;
}
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
  { id: "change" as const, label: rv.changePoints.value.length ? `变更 ${pointCount(rv.changePoints.value)}` : "变更" },
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
  if (asking.value === "open") asking.value = "min";
  explaining.value = p;
}
// A group (a page or module) is explained with the points under it.
const under = (p: ChangePoint) => {
  const list = rv.changePoints.value.filter((x) => x.parent === p.id);
  return list.length ? `下面的变更点：${list.map((x) => `${x.id} ${x.title}（${POINT_STATUS[x.status].text}）`).join("；")}` : "";
};
const explainContext = computed(() => {
  const p = explaining.value;
  return p ? { quote: [`${p.id} ${p.title}（${POINT_STATUS[p.status].text}）`, p.requirement && `需求：${p.requirement}`, p.implementation && `实现：${p.implementation}`, p.locations.map((l) => `${l.file}${l.start ? `:${l.start}${l.end && l.end !== l.start ? `-${l.end}` : ""}` : ""}`).join("、"), under(p)].filter(Boolean).join("\n"), label: `变更点 ${p.id}` } : null;
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
const treeFiles = computed(() => diffs.value.flatMap((d) => d.files.map((f) => ({ key: `${d.space}:${f.name}`, path: diffs.value.length > 1 ? `${spaceName(d.space)}/${f.name}` : f.name, add: f.add, rm: f.rm }))));
const pickedDiff = ref<string | null>(null);
async function pickDiff(key: string) {
  pickedDiff.value = key;
  openDiffs.value = new Set([...openDiffs.value, key]);
  await nextTick();
  document.querySelector(`.diff-list [data-key="${CSS.escape(key)}"]`)?.scrollIntoView({ block: "start", behavior: "smooth" });
}
function toggleAllDiffs() {
  openDiffs.value = openDiffs.value.size ? new Set() : new Set(diffs.value.flatMap((d) => d.files.map((f) => `${d.space}:${f.name}`)));
}
const spaceName = (id: string) => state.spaces.find((s) => s.id === id)?.name ?? id;

// ---- quoting a selection (diff lines, the task, a review, an open citation) -------------------
// Into a question (the ask drawer, which can shrink to the dock while more is quoted) or into the
// next round of changes (the fix basket). Both keep numbered quotes per run (lib/quotes).
const asking = ref<"open" | "min" | null>(null);
const fixOpen = ref(false);
const selection = ref<{ top: number; left: number; quote: string; label: string } | null>(null);
watch(id, () => { asking.value = null; fixOpen.value = false; selection.value = null; });
const runId = computed(() => detail.value?.run.id ?? "");
const askQuotes = computed(() => quotesOf(runId.value, "ask"));
const fixQuotes = computed(() => quotesOf(runId.value, "fix"));
const canFix = computed(() => !!detail.value && detail.value.run.kind === "code" && detail.value.run.status === "done" && !out.value.appliedAt && (branchReview.value || !out.value.discardedAt));
// The button is placed against the viewport: any scroll moves the text away from it.
const dropSelection = () => (selection.value = null);
onMounted(() => {
  window.addEventListener("scroll", dropSelection, { capture: true, passive: true });
  document.addEventListener("mouseup", onSelect);
  document.addEventListener("keyup", onSelectKey);
});
onBeforeUnmount(() => {
  window.removeEventListener("scroll", dropSelection, { capture: true });
  document.removeEventListener("mouseup", onSelect);
  document.removeEventListener("keyup", onSelectKey);
});
function lineOf(node: Node | null) {
  const el = node instanceof Element ? node : node?.parentElement;
  return Number(el?.closest("[data-line]")?.getAttribute("data-line")) || null;
}
const onSelectKey = (e: KeyboardEvent) => { if (e.shiftKey) onSelect(); };
/** What can be quoted: the run page, and the citation drawer opened from it (both carry data-quotable). */
function onSelect() {
  // Wait for the browser to settle the selection after the click.
  setTimeout(() => {
    const sel = window.getSelection();
    const text = sel?.toString().trim() ?? "";
    if (!sel || !text || sel.rangeCount === 0 || detail.value?.run.kind !== "code") return void (selection.value = null);
    const range = sel.getRangeAt(0);
    const host = (range.commonAncestorContainer instanceof Element ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement)!;
    if (!host.closest("[data-quotable]") || host.closest("input, textarea")) return void (selection.value = null);
    const file = host.closest<HTMLElement>(".dfile");
    let label = host.closest<HTMLElement>("[data-ask-label]")?.dataset.askLabel ?? "运行详情里的一段";
    const lines = [lineOf(range.startContainer), lineOf(range.endContainer)].filter((n): n is number => !!n);
    const at = lines.length ? `:${Math.min(...lines)}${Math.max(...lines) !== Math.min(...lines) ? `-${Math.max(...lines)}` : ""}` : "";
    if (file) label = `${spaceName(file.dataset.space ?? "")} · ${file.dataset.path}${at}`;
    else if (host.closest("[data-lines]")) label += at;
    const rect = range.getBoundingClientRect();
    selection.value = { top: Math.max(8, rect.top - 40), left: Math.min(window.innerWidth - 260, Math.max(8, rect.left)), quote: text.slice(0, 4000), label };
  }, 0);
}
function quote(kind: QuoteKind, q?: { quote: string; label: string }) {
  const from = q ?? selection.value;
  if (!from || !runId.value) return;
  const n = addQuote(runId.value, kind, { quote: from.quote, label: from.label });
  selection.value = null;
  window.getSelection()?.removeAllRanges();
  if (kind === "fix") return toast(`已加入修改点 [${n}]，在右下角的图标里查看和开始修改`, "ok");
  explaining.value = null;
  if (asking.value === "min") toast(`已加入提问 [${n}]`, "ok");
  else asking.value = "open";
}
type Check = { command: string; code: number; output: string };
const checks = computed<{ space: string; check: Check }[]>(() => {
  const repos = (out.value.repos ?? []) as { space: string; check: Check | null }[];
  if (repos.length) return repos.filter((r) => r.check).map((r) => ({ space: repos.length > 1 ? r.space : "", check: r.check! }));
  return out.value.check ? [{ space: "", check: out.value.check }] : [];
});
async function act(action: "cancel" | "retry" | "apply" | "discard") {
  if (!detail.value) return;
  const runId = detail.value.run.id;
  try {
    if (action === "apply") {
      const targets = await get<ApplyTarget[]>(`/api/runs/${runId}/apply-targets`);
      const message = targets.map(t => `${t.space} · ${t.branch ?? "指定版本"}\n${t.path}`).join("\n\n");
      if (!(await confirmDialog("应用到原目标分支？", { message: `${message}\n\n将写入未提交的修改；需要时自动建立目标分支工作区，仓库主目录保持原分支。`, okText: "应用" }))) return;
    }
    const r = await post<{ id?: string; continued?: boolean }>(`/api/runs/${runId}/${action}`);
    if (action === "retry" && r?.id) {
      // A coding run continues in its worktree; an agent run is told what the failed attempt did.
      toast(r.continued ? "已接着上次的进度重新开始" : "已重新排队", "ok");
      router.push(`/runs/${r.id}`);
      return;
    }
    toast({ cancel: "已停止", retry: "已重新排队", apply: "已应用到目标分支，可在下方检查并提交", discard: "已清理工作区" }[action], "ok");
    void loadDetail();
  } catch (e) {
    toast((e as Error).message, "error");
  }
}
/** Commits a sync added (a merge, a pull), applied by fast-forward even without a patch. */
const syncCommits = computed(() => ((out.value.worktrees ?? []) as { syncHead?: string }[]).some((w) => w.syncHead));
async function moveToTarget() {
  if (!detail.value) return;
  if (!(await confirmDialog("移到目标分支的最新提交？", { message: "会开新的一轮：把这次的改动（和同步的提交）变基到目标分支现在的最新提交上，冲突先交给编码 Agent，解决不了会问你。改动没变就沿用这一轮的评审。", okText: "开始" }))) return;
  try {
    const r = await post<{ id: string }>(`/api/runs/${detail.value.run.id}/move-to-target`);
    toast("已安排，完成后再应用", "ok");
    router.push(`/runs/${r.id}`);
  } catch (e) {
    toast((e as Error).message, "error");
  }
}
// A sync that stopped on conflicts: the same decision as the Feishu card, here.
const syncAsk = ref<{ id: string; status: string; question: string } | null>(null);
watch(() => [detail.value?.run.id, out.value.verdict, out.value.reviewAskId] as const, async ([, verdict, askId]) => {
  syncAsk.value = null;
  if (verdict !== "sync-conflict" || typeof askId !== "string") return;
  try {
    const a = await get<{ id: string; status: string; question: string }>(`/api/asks/${askId}`);
    syncAsk.value = a.status === "pending" ? a : null;
  } catch { /* gone */ }
}, { immediate: true });
async function answerSync(choice: number) {
  if (!syncAsk.value) return;
  try {
    await post(`/api/asks/${syncAsk.value.id}/answer`, { choice });
    toast(choice === 0 ? "已安排继续同步" : "已放弃这次同步", "ok");
    syncAsk.value = null;
    void loadDetail();
  } catch (e) {
    toast((e as Error).message, "error");
  }
}
async function copyApplyPath(path: string) {
  try { await navigator.clipboard.writeText(path); toast("已复制接收目录", "ok"); }
  catch { toast("复制失败，请选中目录文字复制", "error"); }
}
const delegateOpen = ref(false);
type DelegateMode = "code" | "review";
const mode = ref<DelegateMode>("code");
const modeOptions = [
  { value: "code" as const, label: "实现" },
  { value: "review" as const, label: "评审分支" },
];
const emptyTask = () => ({ repos: [] as string[], task: "", check: "", branch: "", base: "", fromBranch: "", pull: false, onto: "", syncMode: "merge" as "merge" | "rebase", syncOnly: false });
const syncModeOptions = [{ value: "merge" as const, label: "合并" }, { value: "rebase" as const, label: "变基" }];
const ontoOptions = computed(() => [{ value: "", label: "不合并别的分支" }, ...branchOptions.value]);
const wantsSync = computed(() => task.value.pull || !!task.value.onto);
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
      : await post<Run>("/api/delegate", {
          space, repos: t.repos, checkCommand: t.check || undefined, fromBranch: t.fromBranch || undefined,
          task: t.task.trim() || (t.syncOnly ? `同步${t.pull ? "：拉取最新代码" : ""}${t.onto ? `，${t.syncMode === "merge" ? "合并" : "变基到"} ${t.onto}` : ""}` : t.task),
          ...(wantsSync.value ? { sync: { pull: t.pull || undefined, onto: t.onto || undefined, mode: t.syncMode }, syncOnly: t.syncOnly } : {}),
        });
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
        <UiSegmented v-model="scope" class="scope-filter" size="sm" aria-label="范围" :options="[{ value: 'space', label: '当前空间' }, { value: 'all', label: '所有空间' }]" />
        <UiCheckbox v-model="showQuiet" size="sm" class="small muted" title="后台任务（巡检、检查页面、筛选群、复盘…）没发现要处理的事时以 QUIET 结束，这些运行默认不显示；勾选后一起显示">含无事可报</UiCheckbox>
      </div>
      <div class="items" @scroll.passive="onListScroll">
        <Skeleton v-if="listLoading && !runs.length" :rows="8" />
        <VirtualList v-else :items="runs" :item-key="(r) => r.id" :estimate="54">
          <template #default="{ item: r }">
            <router-link :to="`/runs/${r.id}`" class="run" :class="{ on: r.id === id }" :title="hintOf(r)">
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
    <main class="detail" data-quotable>
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
          <h1 :title="hintOf(detail.run)">{{ detail.run.title }}</h1>
          <div v-if="detail.run.kind === 'code' && fileCount" class="row wrap small muted sub">
            <span>{{ diffs.length > 1 ? `${diffs.length} 个仓库 · ` : "" }}{{ fileCount }} 个文件 · <span class="add">+{{ lineCount.add }}</span> <span class="rm">−{{ lineCount.rm }}</span><template v-if="checkPassed !== null"> · 检查{{ checkPassed ? "通过" : "没通过" }}</template></span>
            <span class="spacer" />
            <UiSegmented v-if="rv.roundOptions.value.length > 1" v-model="rv.round.value" size="sm" :options="rv.roundOptions.value" aria-label="轮次" />
          </div>
          <p v-if="detail.run.waiting" class="muted small waiting" title="omem 自己的排队：开始运行时才选定后端和模型">排队中：{{ detail.run.waiting }}。开始运行时才选定后端和模型；后端自己的排队会在开始后的过程里显示。</p>
          <div class="row">
            <button v-if="['queued', 'running'].includes(detail.run.status)" class="btn sm" @click="act('cancel')"><Icon name="stop" :size="13" />停止</button>
            <button v-if="['failed', 'cancelled'].includes(detail.run.status)" class="btn sm" @click="act('retry')"><Icon name="refresh" :size="13" />重试</button>
            <template v-if="detail.run.kind === 'code' && detail.run.status === 'done' && (detail.patches?.length || syncCommits) && !out.appliedAt && !out.discardedAt && out.verdict !== 'sync-conflict'">
              <button v-if="!branchReview" class="btn primary sm" @click="act('apply')"><Icon name="check" :size="14" />应用到原分支</button>
              <button v-if="!branchReview" class="btn sm" title="目标分支在交办后有了新提交、应用不上时：把改动移到它的最新提交上（冲突交给编码 Agent）" @click="moveToTarget">移到目标分支最新提交</button>
              <button class="btn sm danger" :title="branchReview ? '删除评审用的工作区和它的索引' : undefined" @click="act('discard')">{{ branchReview ? "清理工作区" : "丢弃" }}</button>
            </template>
            <span v-if="out.appliedAt" class="badge ok">已应用 {{ fmtTime(out.appliedAt) }}</span>
            <OpenInIde v-if="detail.run.kind === 'code'" :key="`${detail.run.id}:${out.appliedAt ?? ''}:${out.discardedAt ?? ''}:${detail.run.status}`" :run-id="detail.run.id" :space-name="spaceName" />
            <button v-if="detail.run.kind === 'code'" class="btn ghost sm" @click="explaining = null; asking = 'open'"><Icon name="chat" :size="14" />提问</button>
          </div>
        </header>
        <!-- A delegation's round in progress: the owner's words for the coding Agent, and the review from now on. -->
        <CodeSteer v-if="detail.run.kind === 'code' && !branchReview && ['queued', 'running'].includes(detail.run.status)" :run-id="detail.run.id" :coding="typeof out.coderSummary !== 'string'" :notes="(out.notes ?? []) as { id: string; text: string; at: string; deliveredAt?: string }[]" :review="(detail.run.input as { roundReview?: { tier?: string; split?: boolean } }).roundReview" @changed="loadDetail" />
        <section v-if="syncAsk" class="card pad block sync-stop" role="alert">
          <div class="section-title">Git 同步停在冲突上</div>
          <p class="pre small">{{ syncAsk.question }}</p>
          <div class="row wrap"><button class="btn primary sm" @click="answerSync(0)">已解决，继续</button><button class="btn sm" @click="answerSync(1)">放弃这次同步</button></div>
        </section>
        <!-- After apply: where the change landed, and committing / pushing it there. -->
        <section v-if="out.appliedTo?.length" class="card pad block apply-targets">
          <div class="section-title">接收位置与提交</div>
          <div v-for="t in (out.appliedTo as ApplyTarget[])" :key="t.space" class="target">
            <div class="row wrap small">
              <strong>{{ spaceName(t.space) }}</strong>
              <span class="badge">{{ t.branch ?? "指定版本" }}</span>
              <code class="grow">{{ t.path }}</code>
              <button class="btn ghost sm" @click="copyApplyPath(t.path)">复制目录</button>
            </div>
            <CodeGitPanel :key="`${detail.run.id}:${t.space}`" :run-id="detail.run.id" :space="t.space" />
          </div>
        </section>

        <nav v-if="hasReview" class="tabs" role="tablist" aria-label="运行详情">
          <button v-for="t in tabs" :key="t.id" role="tab" class="tab" :class="{ on: tab === t.id }" :aria-selected="tab === t.id" @click="tab = t.id">{{ t.label }}</button>
        </nav>
        <ReviewSummary v-if="hasReview && tab === 'overview'" :rv="rv" :run-id="detail.run.id" :review-text="out.review" :branch-review="branchReview" :can-fix="detail.run.status === 'done' && !out.appliedAt && (branchReview || !out.discardedAt)" data-ask-label="评审" @ask="(c) => quote('ask', c)" @go="(t) => (tab = t)" />
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
          <RunActivity :run-id="detail.run.id" :link="false" :open="['queued', 'running'].includes(detail.run.status)">
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
          <div class="section-title row">改动 · {{ diffs.length > 1 ? `${diffs.length} 个仓库，` : "" }}{{ fileCount }} 个文件<span class="spacer" /><span class="muted small hint-sel">选中代码可以加入提问或修改点</span><UiSegmented v-model="diffLayout" size="sm" :options="diffLayoutOptions" aria-label="差异的排列" /><button class="btn ghost sm" @click="toggleAllDiffs">{{ openDiffs.size ? "全部收起" : "全部展开" }}</button></div>
          <p v-if="out.indexedSpaces?.length && !out.appliedAt && !out.discardedAt" class="muted small">{{ branchReview ? "清理工作区之前" : "应用或丢弃之前" }}，改过的文件可以检索（空间 {{ out.indexedSpaces.join("、") }}）；之后连同 worktree 一起删除。</p>
          <div class="diff-cols">
          <DiffTree v-if="fileCount > 1" class="diff-tree" :files="treeFiles" :active="pickedDiff" @pick="pickDiff" />
          <div class="diff-list">
          <template v-for="d in diffs" :key="d.space">
          <div v-if="diffs.length > 1" class="repo-title">{{ spaceName(d.space) }}</div>
          <details v-for="f in d.files" :key="f.name" class="file" :class="{ picked: pickedDiff === `${d.space}:${f.name}` }" :data-key="`${d.space}:${f.name}`" :open="openDiffs.has(`${d.space}:${f.name}`)" @toggle="onDiffToggle(`${d.space}:${f.name}`, $event)">
            <summary class="mono small"><span>{{ f.name }}</span><span class="add">+{{ f.add }}</span><span class="rm">-{{ f.rm }}</span></summary>
            <DiffFile v-if="openDiffs.has(`${d.space}:${f.name}`)" :run-id="detail.run.id" :space="d.space" :lines="f.lines" />
          </details>
          </template>
          </div>
          </div>
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

    <div v-if="selection" class="sel-ask" :style="{ top: `${selection.top}px`, left: `${selection.left}px` }" @mousedown.prevent>
      <button class="btn sm primary" @click="quote('ask')"><Icon name="chat" :size="13" />加入提问{{ askQuotes.length ? `（${askQuotes.length + 1}）` : "" }}</button>
      <button v-if="canFix" class="btn sm" title="作为下一轮修改的要求，攒够了一起开始修改" @click="quote('fix')"><Icon name="edit" :size="13" />加入修改点{{ fixQuotes.length ? `（${fixQuotes.length + 1}）` : "" }}</button>
    </div>
    <AskAboutRun v-if="asking && detail" :key="detail.run.id" basket :minimized="asking === 'min'" :run-id="detail.run.id" :run-title="detail.run.title" :space-id="detail.run.spaceId" @close="asking = null" @minimize="asking = 'min'" />
    <FixBasket v-if="fixOpen && detail" :key="`fix:${detail.run.id}`" :run-id="detail.run.id" :rv="rv" :can-fix="canFix" :branch-review="branchReview" @close="fixOpen = false" />
    <QuoteDock v-if="detail && !explaining && !fixOpen && (asking === 'min' || (!asking && askQuotes.length) || fixQuotes.length)" :ask="askQuotes.length" :fix="fixQuotes.length" :asking="!!asking" @ask="asking = 'open'" @fix="fixOpen = true" />
    <AskAboutRun v-if="explaining && detail" :key="`${detail.run.id}:${explaining.id}`" :run-id="detail.run.id" :run-title="detail.run.title" :space-id="detail.run.spaceId" :context="explainContext" :heading="`${explaining.id} ${explaining.title}`" @close="explaining = null">
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
          <!-- Git work before coding (src/agents/code-sync.ts): conflicts go to the coding Agent, then to the owner. -->
          <div v-if="mode === 'code' && task.repos.length" class="field sync">
            <span>编码前先同步（可选）</span>
            <div class="row wrap">
              <UiCheckbox v-model="task.pull" size="sm">拉取目标分支在 origin 上的新提交</UiCheckbox>
            </div>
            <div class="row wrap">
              <UiSelect v-model="task.onto" :options="ontoOptions" :search-at="1" width="220px" size="sm" aria-label="再合并或变基到的分支" />
              <UiSegmented v-if="task.onto" v-model="task.syncMode" size="sm" :options="syncModeOptions" aria-label="合并还是变基" />
              <UiCheckbox v-if="wantsSync" v-model="task.syncOnly" size="sm">只同步，不再编码</UiCheckbox>
            </div>
            <span v-if="wantsSync" class="hint">冲突先交给编码 Agent 解决，拿不准的会问你，解决不了的停下来给你；同步的提交在应用时快进到目标分支，之后可以在“接收位置与提交”里推送（变基过的要强制推送）。</span>
          </div>
          <label class="field"><span>{{ mode === "review" ? "需求说明和评审要求（可选）" : "任务" }}</span><textarea v-model="task.task" class="textarea" rows="6" :placeholder="mode === 'review' ? '需求要解决什么、验收标准、相关文档或讨论、特别关心的点' : '目标、背景、验收标准、相关讨论'" /></label>
          <label v-if="mode === 'code'" class="field"><span>检查命令（可选，默认用空间设置）</span><input v-model="task.check" class="input mono" placeholder="pnpm test" /></label>
          <div class="row"><span class="spacer" /><button class="btn primary" :disabled="!task.repos.length || (mode === 'review' ? !task.branch : !task.task.trim() && !(wantsSync && task.syncOnly))" @click="delegate">{{ mode === "review" ? "开始评审" : "交办" }}</button></div>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.apply-targets { display: grid; gap: 12px; }
.sync-stop { border-color: var(--warn); display: grid; gap: 8px; }
.sync-stop p { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.sync .row { gap: 10px; align-items: center; }
.apply-targets .section-title { margin: 0; }
.apply-targets .target { display: grid; gap: 10px; min-width: 0; }
.apply-targets code { overflow-wrap: anywhere; white-space: normal; min-width: 0; }
.apply-targets .grow { flex: 1; }
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
    "status scope scope"
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
.head .scope-filter { grid-area: scope; justify-self: end; }
.head .small.muted { grid-area: quiet; justify-self: end; white-space: nowrap; }
@media (max-width: 480px) {
  .head {
    grid-template-columns: 1fr auto;
    grid-template-areas:
      "title delegate"
      "search search"
      "status status"
      "scope scope"
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
/* Above the citation drawer, whose text can be quoted too. */
.sel-ask {
  position: fixed;
  z-index: 45;
  display: flex;
  gap: 6px;
}
.sel-ask .btn {
  box-shadow: var(--shadow-lg);
}
/* It floats over text: the hover tint goes on top of an opaque panel, not over the text below. */
.sel-ask .btn:not(.primary):hover:not(:disabled) {
  background: linear-gradient(var(--hover), var(--hover)), var(--panel);
}
.sel-ask .btn.primary:hover:not(:disabled) {
  opacity: 1;
  filter: brightness(0.9);
}
.diff-cols { display: grid; grid-template-columns: minmax(180px, 240px) minmax(0, 1fr); gap: 14px; align-items: start; }
.diff-cols:not(:has(.diff-tree)) { grid-template-columns: minmax(0, 1fr); }
.diff-tree { position: sticky; top: 0; max-height: calc(100vh - 120px); overflow: auto; }
.diff-list { min-width: 0; }
.file.picked { border-color: var(--accent); }
@media (max-width: 760px) {
  .diff-cols { grid-template-columns: minmax(0, 1fr); }
  .diff-tree { position: static; max-height: 240px; }
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
