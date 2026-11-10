<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { aiLabel, get, onServerEvent, onServerResync, post, type Run, type RunEvent } from "../api";
import Icon from "./Icon.vue";
import Markdown from "./Markdown.vue";
import Skeleton from "./Skeleton.vue";
import UiSelect from "./UiSelect.vue";
import AskAboutRun from "./AskAboutRun.vue";
import ChangeView from "./ChangeView.vue";
import CodeDiffList from "./CodeDiffList.vue";
import CodeLanding, { type ApplyTarget } from "./CodeLanding.vue";
import CodeSteer from "./CodeSteer.vue";
import CodeTasks from "./CodeTasks.vue";
import ContextUsage from "./ContextUsage.vue";
import FixBasket from "./FixBasket.vue";
import OpenInIde from "./OpenInIde.vue";
import WorkPreview from "./WorkPreview.vue";
import QuoteDock from "./QuoteDock.vue";
import ReviewChecks from "./ReviewChecks.vue";
import ReviewProcess from "./ReviewProcess.vue";
import ReviewSummary from "./ReviewSummary.vue";
import RunActivity from "./RunActivity.vue";
import RunArtifacts from "./RunArtifacts.vue";
import PreCheckCard from "./PreCheckCard.vue";
import { confirmDialog } from "../lib/dialog";
import { addQuote, quotesOf, type QuoteKind } from "../lib/quotes";
import { refAction } from "../lib/refs";
import { findingWhere, parsePatches, pointCount, pointQuote, POINT_STATUS, SEV, useReviews, type ChangePoint } from "../lib/reviews";
import { progressText, stripAnsi, type CodeWorkDetail, type WorkAction } from "../lib/works";
import { fmtTime, openCitation, relTime, state, statusLabel, toast } from "../store";

/**
 * One delegation or branch review, the same on the run page and the requirements page
 * (docs/v2/coding-work.md): what it is for, where it stands, what comes next and its branches at the
 * top; then 概览 (tasks, the owner's questions, the review), 需求点, 变更, 评审, 活动 (every round and
 * what happened in it) and 分支, all available while it still codes. `runId` is any of its rounds: the
 * one opened (活动 shows it; the rest follows the latest). On the requirements page `focus` is the node
 * chosen in the tree: “需求点” shows that node's part of the change, and the change points go up
 * (`points`) so the tree can mark each node with this round's status.
 */
export type ReqFocus = { id: string; title: string; ids: string[]; body: string; acceptance: string };
export type WorkTab = "overview" | "req" | "change" | "review" | "artifacts" | "activity" | "branch";
const props = defineProps<{ runId: string; focus?: ReqFocus | null; tab?: WorkTab; from?: "runs" | "reqs" }>();
const emit = defineEmits<{ close: []; open: [runId: string]; points: [points: ChangePoint[], from: string | null]; "update:tab": [tab: WorkTab] }>();
const spaceName = (id: string) => state.spaces.find((s) => s.id === id)?.name ?? id;

// ---- data: the work (summary of all rounds) and the opened round -------------------------------
type RunContextInfo = {
  items: { id: string; title: string; status: string }[];
  conversation: { id: string; title: string; channel: string; topic: boolean; work: boolean; parentId: string | null; parentTitle: string | null; turns: { id: string; title: string; status: string; createdAt: string }[] } | null;
  parent: { id: string; kind: string; title: string; status: string } | null;
};
type Detail = { run: Run; events: RunEvent[]; children: Run[]; patches?: { space: string; patch: string }[]; context?: RunContextInfo };
const work = ref<CodeWorkDetail | null>(null);
const detail = ref<Detail | null>(null);
const loading = ref(true);
let seq = 0;
async function load() {
  const request = ++seq, id = props.runId;
  try {
    const [w, d] = await Promise.all([get<CodeWorkDetail>(`/api/code-works/${id}`), get<Detail>(`/api/runs/${id}`)]);
    if (request !== seq) return;
    work.value = w;
    detail.value = d;
  } catch (e) {
    if (request !== seq) return;
    work.value = null;
    detail.value = null;
    toast((e as Error).message, "error");
  } finally {
    if (request === seq) loading.value = false;
  }
}
watch(() => props.runId, () => {
  // Another round of the same work keeps the page on screen while it loads.
  if (!work.value?.roundList.some((r) => r.id === props.runId)) loading.value = true;
  void load();
}, { immediate: true });
let timer: ReturnType<typeof setTimeout> | undefined;
const off = onServerEvent((e) => {
  const mine = (id: string) => !!work.value?.roundList.some((r) => r.id === id) || !!detail.value?.children.some((c) => c.id === id);
  if ((e.type === "run" && (mine(e.runId) || e.status === "queued")) || (e.type === "changed" && (e as { entity?: string }).entity === "code-task")) {
    clearTimeout(timer);
    timer = setTimeout(() => void load(), 500);
  }
});
// Back from a hidden tab: rounds and reviews may have moved on.
const offResync = onServerResync(() => void load());
onBeforeUnmount(() => { ++seq; off(); offResync(); clearTimeout(timer); });

const run = computed(() => detail.value?.run ?? null);
type Check = { command: string; code: number; output: string; ms?: number; commit?: string };
type Out = { appliedAt?: string; verdict?: string; discardedAt?: string; review?: string; coderSummary?: string; notes?: { id: string; text: string; at: string; deliveredAt?: string }[]; indexedSpaces?: string[]; repos?: { space: string; check: Check | null }[]; check?: Check };
const out = computed(() => (run.value?.output ?? {}) as Out);
const branchReview = computed(() => !!work.value?.branchReview);
const branchWork = computed(() => !!work.value?.branchWork);
const busy = computed(() => ["queued", "running"].includes(run.value?.status ?? ""));
const latest = computed(() => !!work.value && work.value.latestId === props.runId);
const roundNo = computed(() => work.value?.roundList.find((r) => r.id === props.runId)?.round ?? 1);
const rv = useReviews(computed(() => run.value?.id ?? ""), computed(() => run.value?.status));
const hasReview = computed(() => !!rv.data.value && (rv.reviews.value.length > 0 || !!rv.current.value?.plan));
const diffs = computed(() => parsePatches(detail.value?.patches ?? []));
const checks = computed(() => {
  if (out.value.repos?.length) return out.value.repos.flatMap((r) => (r.check ? [{ space: out.value.repos!.length > 1 ? r.space : "", check: r.check }] : []));
  return out.value.check ? [{ space: "", check: out.value.check }] : [];
});
// Repositories this round has no check for: the reviewers only have the coder's word on its tests.
const unchecked = computed(() => (out.value.repos ?? []).filter((r) => !r.check).map((r) => r.space));
const canFix = computed(() => run.value?.status === "done" && (branchReview.value || !out.value.discardedAt));

// ---- the branch lines at the top ----------------------------------------------------------------
type Branch = { space: string; branch: string; exists: boolean; base: string; cutFrom: string | null; newBranch: boolean; commits: unknown[]; root: string; mainBranch: string | null; checkedOut: string | null; inMain: boolean; workspace: string | null; remote: boolean; pushed: boolean; ahead: number | null; behind: number | null; pushedAt: string | null };
const branches = ref<Branch[] | null>(null);
watch(() => [work.value?.rootId, work.value?.branchWork, work.value?.latestId, run.value?.status] as const, async ([root, bw]) => {
  if (!root || !bw) return void (branches.value = null);
  branches.value = await get<Branch[]>(`/api/runs/${root}/branch`).catch(() => null);
}, { immediate: true });
const pushState = (b: Branch) => (!b.remote ? "没有 origin，只在本地" : !b.pushed ? "还没推送" : b.ahead || b.behind ? `origin 上有，本地领先 ${b.ahead ?? 0}、落后 ${b.behind ?? 0}` : "已推送，和 origin 一致");
const whereText = (b: Branch) => (b.inMain ? `在仓库目录 ${b.root} 检出，每轮自动快进` : b.checkedOut ? `在 ${b.checkedOut} 检出` : b.workspace ? "在交办工作区里" : "没有检出");
const multiRepo = computed(() => (work.value?.repos.length ?? 0) > 1);

// ---- what comes next ----------------------------------------------------------------------------
const ACTION: Record<WorkAction, { label: string; cls: string; title?: string }> = {
  stop: { label: "停止这一轮", cls: "" },
  retry: { label: "接着做（重试这一轮）", cls: "" },
  discard: { label: "丢弃", cls: "danger" },
  confirm: { label: "确认并推送…", cls: "primary", title: "在“分支”里选要不要压缩提交，然后推送" },
  apply: { label: "应用到原分支", cls: "primary" },
  move: { label: "移到目标分支最新提交", cls: "", title: "目标分支在交办后有了新提交、应用不上时：把改动移到它的最新提交上（冲突交给编码 Agent）" },
  "code-here": { label: "改用这台机器的 AI 编码", cls: "", title: "不等外部 Agent：这一轮的任务交给这台机器的编码 Agent，评审也在这里做" },
  clean: { label: "清理评审工作区", cls: "danger" },
  branch: { label: "去处理同步冲突", cls: "primary" },
};
const actions = computed(() => (work.value?.next.actions ?? []).filter((a) => a !== "stop" || busy.value || latest.value));
const moveMode = ref<"merge" | "rebase">("merge");
const working = ref(false);
async function act(a: WorkAction) {
  const w = work.value;
  if (!w || working.value) return;
  if (a === "confirm" || a === "branch") return void (tab.value = "branch");
  const target = w.latestId;
  working.value = true;
  try {
    if (a === "stop") {
      await post(`/api/runs/${target}/cancel`);
      toast("已停止这一轮", "ok");
    } else if (a === "retry") {
      const r = await post<{ id?: string; continued?: boolean }>(`/api/runs/${target}/retry`);
      toast(r.continued ? "已接着上次的进度重新开始" : "已重新排队", "ok");
      if (r.id) emit("open", r.id);
    } else if (a === "discard" || a === "clean") {
      const ok = await confirmDialog(a === "clean" ? "清理评审工作区？" : "丢弃这次交办？", { message: a === "clean" ? "删除评审用的工作区和它的索引，评审结论留着。" : w.branchWork ? "归还工作区。这次交办新建的分支如果没推送、也没在别处检出，会连同上面的提交一起删掉。" : "归还工作区，改动不再保留。", okText: a === "clean" ? "清理" : "丢弃", danger: true });
      if (!ok) return;
      await post(`/api/runs/${target}/discard`);
      toast(a === "clean" ? "已清理工作区" : "已丢弃", "ok");
    } else if (a === "apply") {
      const targets = await get<ApplyTarget[]>(`/api/runs/${target}/apply-targets`);
      if (!(await confirmDialog("应用到原目标分支？", { message: `${targets.map((t) => `${spaceName(t.space)} · ${t.branch ?? "指定版本"}\n${t.path}`).join("\n\n")}\n\n写成未提交的修改；之后在“分支”里检查并提交。`, okText: "应用" }))) return;
      await post(`/api/runs/${target}/apply`);
      toast("已应用到目标分支，可在“分支”里检查并提交", "ok");
    } else if (a === "move") {
      if (!(await confirmDialog("移到目标分支的最新提交？", { message: `${moveMode.value === "merge" ? "把目标分支的最新提交合并进来，集中处理冲突，保留合并提交。" : "逐个重放提交到目标的最新版本，历史长时可能反复处理冲突。"}冲突先交给编码 Agent，解决不了会问你；改动没变就沿用评审。`, okText: "开始" }))) return;
      const r = await post<{ id: string }>(`/api/runs/${target}/move-to-target`, { mode: moveMode.value });
      toast("已安排，完成后再应用", "ok");
      emit("open", r.id);
    } else if (a === "code-here") {
      const r = await post<{ id: string }>(`/api/runs/${target}/code-here`);
      toast("已交给这台机器的编码 Agent", "ok");
      emit("open", r.id);
    }
    void load();
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    working.value = false;
  }
}

// ---- the requirement map: this round's split, else the latest one on the work or branch ----------
// A round reviewed without a split (or a delegation that only tidies code) still shows the branch's
// requirement → code map: the split of an earlier round or of another review of the branch, with
// that round's code, since its locations point there (review-fix.ts inheritedSplit).
type Inherited = { runId: string; rootId: string; title: string; round: number; sameWork: boolean; branchReview: boolean };
const inherited = ref<Inherited | null>(null);
let inheritedFor = "";
watch(() => [run.value?.id, !!rv.data.value, rv.changePoints.value.length] as const, async ([id, loaded, own]) => {
  if (!id || !loaded || own) {
    inheritedFor = "";
    return void (inherited.value = null);
  }
  if (inheritedFor === id) return;
  inheritedFor = id;
  const split = (await get<{ split: Inherited | null }>(`/api/runs/${id}/inherited-split`).catch(() => null))?.split ?? null;
  if (inheritedFor === id) inherited.value = split;
}, { immediate: true });
const srcRv = useReviews(computed(() => inherited.value?.runId ?? ""), computed(() => inherited.value?.runId));
const srcPatches = ref<{ space: string; patch: string }[]>([]);
watch(() => inherited.value?.runId, async (id) => {
  srcPatches.value = id ? ((await get<Detail>(`/api/runs/${id}`).catch(() => null))?.patches ?? []) : [];
});
const mapRv = computed(() => (rv.changePoints.value.length || !inherited.value ? rv : srcRv));
const mapRunId = computed(() => (mapRv.value === rv ? run.value?.id ?? "" : inherited.value!.runId));
const mapDiffs = computed(() => (mapRv.value === rv ? diffs.value : parsePatches(srcPatches.value)));
const mapPoints = computed(() => mapRv.value.changePoints.value);
const inheritedLabel = computed(() => (inherited.value && mapRv.value === srcRv ? `${inherited.value.sameWork ? "" : `「${inherited.value.title}」`}第 ${inherited.value.round} 轮` : null));
watch([mapPoints, inheritedLabel], ([p, from]) => emit("points", p, from), { immediate: true });
const focusPoints = computed(() => {
  const f = props.focus;
  if (!f) return [];
  const all = mapPoints.value;
  const picked = new Set(all.filter((p) => p.req && f.ids.includes(p.req)).map((p) => p.id));
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of all) if (p.parent && picked.has(p.parent) && !picked.has(p.id)) { picked.add(p.id); grew = true; }
  }
  return all.filter((p) => picked.has(p.id));
});
const reqOpen = ref(false);
const POINT_STATE: Record<string, { text: string; cls: string }> = { done: { text: "已实现", cls: "ok" }, partial: { text: "部分实现", cls: "warn" }, missing: { text: "没实现", cls: "danger" } };

// ---- tabs (always there, also while coding) -----------------------------------------------------
/** Screenshots, recordings, reports: the work's count, kept current by the gallery once it is open. */
const shotCount = ref<number | null>(null);
const artifactCount = computed(() => shotCount.value ?? work.value?.artifacts ?? 0);
const artifactTask = ref<number | null>(null);
watch(() => props.runId, () => { shotCount.value = null; artifactTask.value = null; });
const openArtifacts = (seq: number | null) => {
  // The count the page loaded with may be older than the task's artifacts: keep the tab there.
  if (!artifactCount.value) shotCount.value = 1;
  artifactTask.value = seq;
  tab.value = "artifacts";
};
const localTab = ref<WorkTab>("overview");
const tab = computed<WorkTab>({ get: () => props.tab ?? localTab.value, set: (t) => { localTab.value = t; emit("update:tab", t); } });
const tabs = computed(() => [
  { id: "overview" as const, label: "概览" },
  ...(props.focus || work.value?.points.length ? [{ id: "req" as const, label: props.focus ? `需求点 ${focusPoints.value.length ? pointCount(focusPoints.value) : 0}` : `需求点 ${work.value!.points.length}` }] : []),
  { id: "change" as const, label: rv.changePoints.value.length ? `变更 ${pointCount(rv.changePoints.value)}` : "变更" },
  { id: "review" as const, label: "评审" },
  ...(artifactCount.value ? [{ id: "artifacts" as const, label: `产物 ${artifactCount.value}` }] : []),
  { id: "activity" as const, label: `活动 ${work.value?.rounds ?? ""}`.trim() },
  ...(branchReview.value ? [] : [{ id: "branch" as const, label: "分支" }]),
]);
watch(tabs, (list) => { if (!list.some((t) => t.id === tab.value)) tab.value = "overview"; });
const processFocus = ref<string | null>(null);
watch(tab, (t) => { if (t !== "activity") processFocus.value = null; });
const taskOpen = ref(false);
watch(() => work.value?.rootId, () => (taskOpen.value = false));
const taskLong = computed(() => (work.value?.task ?? "").split("\n").length > 8 || (work.value?.task.length ?? 0) > 600);

// ---- asking and quoting: a selection goes into a question or the next changes ------------------
const root = ref<HTMLElement>();
const asking = ref<"open" | "min" | null>(null);
const askDraft = ref("");
const fixOpen = ref(false);
const explaining = ref<ChangePoint | null>(null);
const selection = ref<{ top: number; left: number; quote: string; label: string } | null>(null);
watch(() => props.runId, () => { asking.value = null; fixOpen.value = false; selection.value = null; explaining.value = null; });
const askQuotes = computed(() => quotesOf(props.runId, "ask"));
const fixQuotes = computed(() => quotesOf(props.runId, "fix"));
const dropSelection = () => (selection.value = null);
const lineOf = (node: Node | null) => Number((node instanceof Element ? node : node?.parentElement)?.closest("[data-line]")?.getAttribute("data-line")) || null;
const onSelectKey = (e: KeyboardEvent) => { if (e.shiftKey) onSelect(); };
/** What can be quoted: this view and the citation drawer opened from it (both carry data-quotable). */
function onSelect() {
  setTimeout(() => {
    const sel = window.getSelection();
    const text = sel?.toString().trim() ?? "";
    if (!sel || !text || sel.rangeCount === 0) return void (selection.value = null);
    const range = sel.getRangeAt(0);
    const host = (range.commonAncestorContainer instanceof Element ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement)!;
    if (!host.closest("[data-quotable]") || host.closest("input, textarea")) return void (selection.value = null);
    const file = host.closest<HTMLElement>(".dfile");
    let label = host.closest<HTMLElement>("[data-ask-label]")?.dataset.askLabel ?? "交办里的一段";
    const lines = [lineOf(range.startContainer), lineOf(range.endContainer)].filter((n): n is number => !!n);
    const at = lines.length ? `:${Math.min(...lines)}${Math.max(...lines) !== Math.min(...lines) ? `-${Math.max(...lines)}` : ""}` : "";
    if (file) label = `${spaceName(file.dataset.space ?? "")} · ${file.dataset.path}${at}`;
    else if (host.closest("[data-lines]")) label += at;
    const rect = range.getBoundingClientRect();
    selection.value = { top: Math.max(8, rect.top - 40), left: Math.min(window.innerWidth - 260, Math.max(8, rect.left)), quote: text.slice(0, 4000), label };
  }, 0);
}
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
function quote(kind: QuoteKind, q?: { quote: string; label: string }) {
  const from = q ?? selection.value;
  if (!from) return;
  const n = addQuote(props.runId, kind, { quote: from.quote, label: from.label });
  selection.value = null;
  window.getSelection()?.removeAllRanges();
  if (kind === "fix") return toast(`已加入修改点 [${n}]，在右下角的图标里查看和开始修改`, "ok");
  explaining.value = null;
  if (asking.value === "min") toast(`已加入提问 [${n}]`, "ok");
  else asking.value = "open";
}
function explain(p: ChangePoint) {
  if (asking.value === "open") asking.value = "min";
  explaining.value = p;
}
const explainContext = computed(() => (explaining.value ? pointQuote(explaining.value, rv.changePoints.value) : null));
const pointFindings = computed(() => {
  const p = explaining.value;
  if (!p) return [];
  const files = p.locations.map((l) => l.file);
  return rv.findings.value.filter((f) => f.file_path && files.some((x) => x === f.file_path || x.endsWith(`/${f.file_path}`) || f.file_path!.endsWith(`/${x}`)));
});
const ctx = computed(() => detail.value?.context ?? null);
</script>

<template>
  <div ref="root" class="work" data-quotable>
    <Skeleton v-if="loading && !work" :rows="6" />
    <p v-else-if="!work || !run" class="muted small">打不开这次交办。</p>
    <template v-else>
      <div class="row wrap wh">
        <button v-if="from === 'reqs'" class="btn ghost sm icon" title="回到需求点" aria-label="回到需求点" @click="emit('close')"><Icon name="left" :size="15" /></button>
        <h2 class="title" :title="work.title">{{ work.title }}</h2>
        <button class="btn ghost sm" @click="explaining = null; asking = 'open'"><Icon name="chat" :size="14" />提问</button>
        <OpenInIde :key="`${run.id}:${out.appliedAt ?? ''}:${out.discardedAt ?? ''}:${run.status}`" :run-id="run.id" :space-name="spaceName" />
        <WorkPreview v-if="!work.branchReview" :key="`pv:${run.id}:${out.appliedAt ?? ''}:${out.discardedAt ?? ''}`" :run-id="run.id" />
        <router-link v-if="from === 'reqs'" :to="`/runs/${work.latestId}`" class="btn sm">运行页<Icon name="external" :size="13" /></router-link>
      </div>
      <div class="row wrap about small">
        <span class="badge">{{ work.branchReview ? "分支评审" : "交办编码" }}</span>
        <router-link v-if="work.item" :to="`/items/${work.item.id}`" :title="work.item.title" class="ellipsis link">事项：{{ work.item.title }}</router-link>
        <span v-else class="muted">没归到事项</span>
        <router-link v-for="r in work.reqs.slice(0, 3)" :key="r.id" :to="`/reqs/${r.id}`" class="ellipsis link" :title="r.title">需求：{{ r.title }}</router-link>
        <span class="muted">{{ work.spaceId ? spaceName(work.spaceId) : "" }} · 开始于 {{ fmtTime(work.createdAt) }}<template v-if="aiLabel(run)"> · <span class="mono">{{ aiLabel(run) }}</span></template></span>
      </div>

      <dl class="facts">
        <dt>现在</dt>
        <dd>
          <div class="line"><span class="badge" :class="work.stage.cls">{{ work.stage.text }}</span><span>{{ work.now }}</span></div>
          <div class="line muted small">{{ progressText(work) }}<template v-if="work.progress?.owner"> · 等你决定 {{ work.progress.owner }}</template><template v-if="work.progress?.assistant"> · 助手在处理 {{ work.progress.assistant }}</template> · {{ relTime(work.updatedAt) }}有动静</div>
        </dd>
        <dt>下一步</dt>
        <dd>
          <div class="line">{{ work.next.text }}</div>
          <div v-if="actions.length" class="line">
            <template v-for="a in actions" :key="a">
              <UiSelect v-if="a === 'move'" v-model="moveMode" :options="[{ value: 'merge', label: '合并（merge）' }, { value: 'rebase', label: '变基（rebase）' }]" size="sm" width="auto" aria-label="同步目标分支的方式" />
              <button class="btn sm" :class="ACTION[a].cls" :disabled="working" :title="ACTION[a].title" @click="act(a)">{{ ACTION[a].label }}</button>
            </template>
          </div>
        </dd>
        <dt>分支</dt>
        <dd>
          <template v-if="branches?.length">
            <div v-for="b in branches" :key="b.space" class="br">
              <div class="line"><strong v-if="multiRepo">{{ spaceName(b.space) }}</strong><span class="muted">{{ b.newBranch ? `从 ${b.cutFrom ?? "提交"}@${b.base.slice(0, 7)} 切出` : `接着已有分支（从 ${b.base.slice(0, 7)} 起）` }}</span><span class="muted" aria-hidden="true">→</span><code>{{ b.branch }}</code><span>{{ b.commits.length }} 个提交</span><span class="muted">·</span><span>{{ pushState(b) }}</span></div>
              <div class="line muted small">{{ whereText(b) }}<template v-if="!out.appliedAt && b.remote"> · 确认后推送到 <code>origin/{{ b.branch }}</code>，归还工作区</template><template v-else-if="!out.appliedAt"> · 确认后归还工作区，分支留在本地</template><template v-if="!b.exists"> · 分支已经不在了</template></div>
            </div>
          </template>
          <template v-else>
            <div v-for="r in work.repos" :key="r.space" class="line">
              <strong v-if="multiRepo">{{ spaceName(r.space) }}</strong>
              <template v-if="work.branchReview">评审分支 <code>{{ r.branch }}</code><span class="muted">对照 {{ r.base ?? "默认分支" }}</span></template>
              <template v-else-if="r.branch && work.branchWork"><span v-if="r.cutFrom" class="muted">从 {{ r.cutFrom }} 切出</span><span v-if="r.cutFrom" class="muted" aria-hidden="true">→</span><code>{{ r.branch }}</code><span class="muted">{{ r.pushedAt ? `推送过 ${relTime(r.pushedAt)}` : branches === null ? "读取分支状态…" : "" }}</span></template>
              <template v-else-if="r.branch"><code>{{ r.branch }}</code><span class="muted">{{ out.appliedAt ? "已应用" : "改动在交办工作区里，应用时写进这条分支" }}</span></template>
              <span v-else class="muted">还没建工作分支</span>
            </div>
            <div v-if="!work.repos.length" class="line muted">还没有工作区</div>
          </template>
        </dd>
      </dl>

      <!-- A round coding now: the owner's words for the coding Agent, and the review from now on. -->
      <CodeSteer v-if="!branchReview && latest && busy" :run-id="run.id" :coding="typeof out.coderSummary !== 'string'" :notes="out.notes ?? []" :review="(run.input as { roundReview?: { tier?: string; split?: boolean } }).roundReview" :tasks="work.taskMode" @changed="load" />

      <nav class="tabs" role="tablist" aria-label="交办详情">
        <button v-for="t in tabs" :key="t.id" role="tab" :class="{ on: tab === t.id }" :aria-selected="tab === t.id" @click="tab = t.id">{{ t.label }}</button>
      </nav>

      <template v-if="tab === 'overview'">
        <!-- Task-driven: its tasks, the owner's questions, the budget and the changes by task. -->
        <CodeTasks v-if="!branchReview" :key="`tasks:${run.id}`" :run-id="run.id" @artifacts="openArtifacts" />
        <PreCheckCard v-if="work.preCheck" :key="`pre:${work.rootId}`" :check="work.preCheck" :space="run.spaceId ?? undefined" data-ask-label="编码前的检查" />
        <ReviewSummary v-if="hasReview" :key="run.id" :rv="rv" :run-id="run.id" :review-text="out.review" :branch-review="branchReview" :branch-work="branchWork" :can-fix="canFix" :applied="!!out.appliedAt" stay data-ask-label="评审" @ask="(c) => { askDraft = c.text ?? ''; quote('ask', c); }" @go="(t) => (tab = t)" @started="(id) => emit('open', id)" @open="(id) => emit('open', id)" />
        <section v-else-if="!work.taskMode && out.coderSummary" class="block">
          <div class="section-title">{{ branchReview ? "要评审的分支" : "编码 Agent 的说明" }}</div>
          <div class="card pad"><Markdown :source="out.coderSummary" :space="run.spaceId ?? undefined" /></div>
        </section>
        <p v-else-if="!work.taskMode && busy" class="muted small">{{ branchReview ? "正在准备评审" : "正在编码" }}，完成后这里显示结论；过程在“活动”里。</p>
        <section v-if="work.task" class="card pad block" data-ask-label="交办时的任务">
          <div class="row"><strong class="small">交办时的任务</strong><span class="spacer" /><button v-if="taskLong" class="btn ghost sm" @click="taskOpen = !taskOpen">{{ taskOpen ? "收起" : "展开全文" }}</button></div>
          <div class="pre small task" :class="{ clipped: taskLong && !taskOpen }">{{ work.task }}</div>
        </section>
      </template>

      <template v-else-if="tab === 'req'">
        <template v-if="focus">
          <section class="card pad req">
            <div class="row wrap">
              <strong class="ellipsis">{{ focus.title }}</strong>
              <template v-for="s in (['done', 'partial', 'missing'] as const)" :key="s">
                <span v-if="focusPoints.some((p) => p.status === s)" class="badge" :class="POINT_STATUS[s].cls">{{ POINT_STATUS[s].text }} {{ focusPoints.filter((p) => p.status === s).length }}</span>
              </template>
              <span class="spacer" />
              <button v-if="focus.body || focus.acceptance" class="lnk small" :aria-expanded="reqOpen" @click="reqOpen = !reqOpen">{{ reqOpen ? "收起需求" : "看需求和验收" }}</button>
            </div>
            <template v-if="reqOpen">
              <Markdown v-if="focus.body" class="small" :source="focus.body" />
              <Markdown v-if="focus.acceptance" class="small" :source="`**验收**\n\n${focus.acceptance}`" />
            </template>
          </section>
          <p v-if="inheritedLabel" class="muted small inherited">{{ busy ? `这一轮还在进行，先用${inheritedLabel}的拆分和那时的代码。` : `这一轮没有自己的需求拆分，这里用${inheritedLabel}的拆分和那时的代码。` }}</p>
          <ChangeView :key="mapRunId" :rv="mapRv" :run-id="mapRunId" :diffs="mapDiffs" :only="focusPoints.map((p) => p.id)" @explain="explain" />
        </template>
        <section v-else class="card pad points">
          <div class="row wrap"><strong class="small">这次交办的需求点</strong><span class="muted small">状态来自评审的需求拆分；点开看需求和它的全部编码</span></div>
          <router-link v-for="p in work.points" :key="p.id" :to="`/reqs/${p.id}`" class="point">
            <span class="ellipsis">{{ p.title }}</span>
            <span v-if="p.status && POINT_STATE[p.status]" class="badge" :class="POINT_STATE[p.status].cls">{{ POINT_STATE[p.status].text }}</span>
            <span v-else class="badge">还没评审</span>
            <span v-if="p.at" class="muted small">{{ relTime(p.at) }}</span>
          </router-link>
        </section>
      </template>

      <template v-else-if="tab === 'change'">
        <ChangeView v-if="rv.changePoints.value.length" :rv="rv" :run-id="run.id" :diffs="diffs" @explain="explain" />
        <CodeDiffList v-else-if="diffs.length" :run-id="run.id" :diffs="diffs" :indexed="!out.appliedAt && !out.discardedAt ? out.indexedSpaces : undefined" />
        <p v-else class="empty-tab">{{ busy ? "这一轮还在编码，结束后这里显示改动。" : "这一轮没有改动。" }}<template v-if="work.taskMode">每个修改项自己的改动、两个检查点之间、我上次看过之后，在“概览”的修改项里“看改动”。</template></p>
      </template>

      <template v-else-if="tab === 'review'">
        <ReviewChecks v-if="hasReview" :rv="rv" :run-id="run.id" data-ask-label="评审" @process="(c) => { processFocus = c; tab = 'activity'; }" />
        <p v-else class="empty-tab">{{ work.taskMode ? "还没有阶段评审：待做的项做完后，评审负责人决定这次看什么。逐项验证的结论在“概览”的修改项上。" : busy ? "编码结束后开始评审。" : "这一轮没有评审。" }}</p>
      </template>

      <template v-else-if="tab === 'artifacts'">
        <RunArtifacts :run-id="run.id" :task="artifactTask" @count="(n) => (shotCount = n)" @task="(s) => (artifactTask = s)" />
      </template>

      <template v-else-if="tab === 'activity'">
        <section class="card pad rounds" aria-label="各轮">
          <div class="row"><strong class="small">各轮（{{ work.roundList.length }}）</strong><span class="muted small">点一轮看它的过程</span></div>
          <button v-for="r in [...work.roundList].reverse()" :key="r.id" type="button" class="round" :class="{ on: r.id === run.id }" @click="emit('open', r.id)">
            <span class="st" :class="r.status" /><span class="muted small no">{{ r.round }}</span>
            <span class="ellipsis grow" :title="r.title">{{ r.title }}</span>
            <span class="muted small">{{ statusLabel[r.status] ?? r.status }} · {{ fmtTime(r.createdAt) }}</span>
          </button>
        </section>
        <section v-if="ctx && (ctx.conversation || ctx.parent)" class="card pad ctx">
          <div v-if="ctx.conversation" class="row wrap small"><span class="muted">会话</span><router-link :to="`/ask/${ctx.conversation.id}`">{{ ctx.conversation.title || ctx.conversation.id }}</router-link><span class="badge">{{ ctx.conversation.work ? "多 Agent 工作会话" : ctx.conversation.topic ? "飞书话题" : ctx.conversation.channel === "lark" ? "飞书会话" : ctx.conversation.channel }}</span></div>
          <div v-if="ctx.parent" class="row wrap small"><span class="muted">由</span><router-link class="ellipsis" :to="`/runs/${ctx.parent.id}`" :title="ctx.parent.title">{{ ctx.parent.title }}</router-link></div>
        </section>
        <div class="row small muted round-head">第 {{ roundNo }} 轮 · {{ statusLabel[run.status] ?? run.status }} · {{ fmtTime(run.createdAt) }}<template v-if="run.finishedAt"> → {{ fmtTime(run.finishedAt) }}</template></div>
        <ContextUsage :events="detail!.events" />
        <ReviewProcess v-if="hasReview" :rv="rv" :focus="processFocus" />
        <section class="block"><RunActivity :run-id="run.id" :link="false" :open="busy" /></section>
        <section v-if="out.coderSummary && (work.taskMode || hasReview)" class="block">
          <div class="section-title">{{ branchReview ? "要评审的分支" : "编码 Agent 这一轮的说明" }}</div>
          <div class="card pad"><Markdown :source="out.coderSummary" :space="run.spaceId ?? undefined" /></div>
        </section>
        <section v-for="c in checks" :key="c.space" class="block">
          <div class="section-title">检查<template v-if="c.space"> · {{ spaceName(c.space) }}</template>：<span class="mono">{{ c.check.command }}</span> <span class="badge" :class="c.check.code === 0 ? 'ok' : 'danger'">退出码 {{ c.check.code }}</span> <span v-if="c.check.commit || c.check.ms" class="muted small"><template v-if="c.check.commit">提交 <span class="mono">{{ c.check.commit.slice(0, 8) }}</span></template><template v-if="c.check.commit && c.check.ms"> · </template><template v-if="c.check.ms">{{ Math.round(c.check.ms / 1000) }} 秒</template></span></div>
          <pre class="log">{{ stripAnsi(c.check.output ?? "") }}</pre>
        </section>
        <p v-if="unchecked.length && !branchReview" class="muted small block">{{ unchecked.map(spaceName).join("、") }} 没有设检查命令：评审只能看编码 Agent 自己写的验证。在 设置 → 空间 里给仓库设检查命令后，宿主每轮都会跑并交给评审。</p>
        <section v-if="detail!.children.filter((c) => c.kind !== 'code').length" class="block">
          <div class="section-title">这一轮里的其他运行</div>
          <router-link v-for="c in detail!.children.filter((c) => c.kind !== 'code')" :key="c.id" :to="`/runs/${c.id}`" class="round"><span class="st" :class="c.status" /><span class="grow ellipsis">{{ c.title }}</span><span class="muted small">{{ statusLabel[c.status] }}</span></router-link>
        </section>
      </template>

      <template v-else-if="tab === 'branch'">
        <CodeLanding :run="run" :branch-work="branchWork" :space-name="spaceName" @changed="load" @synced="(id) => emit('open', id)" />
        <p v-if="!branchWork && !out.appliedAt" class="muted small">这次交办的改动由宿主生成补丁，应用时写进目标分支（未提交），之后在这里检查、提交和推送。</p>
      </template>
    </template>

    <div v-if="selection" class="sel-ask" :style="{ top: `${selection.top}px`, left: `${selection.left}px` }" @mousedown.prevent>
      <button class="btn sm primary" @click="quote('ask')"><Icon name="chat" :size="13" />加入提问{{ askQuotes.length ? `（${askQuotes.length + 1}）` : "" }}</button>
      <button v-if="canFix" class="btn sm" title="作为下一轮修改的要求，攒够了一起开始修改" @click="quote('fix')"><Icon name="edit" :size="13" />加入修改点{{ fixQuotes.length ? `（${fixQuotes.length + 1}）` : "" }}</button>
    </div>
    <template v-if="run">
      <AskAboutRun v-if="asking" :key="run.id" basket :draft="askDraft" :minimized="asking === 'min'" :run-id="run.id" :run-title="run.title" :space-id="run.spaceId" @close="asking = null" @minimize="asking = 'min'" />
      <FixBasket v-if="fixOpen" :key="`fix:${run.id}`" :run-id="run.id" :rv="rv" :can-fix="canFix" :branch-review="branchReview" @close="fixOpen = false" />
      <QuoteDock v-if="!explaining && !fixOpen && (asking === 'min' || (!asking && askQuotes.length) || fixQuotes.length)" :ask="askQuotes.length" :fix="fixQuotes.length" :asking="!!asking" @ask="asking = 'open'" @fix="fixOpen = true" />
      <AskAboutRun v-if="explaining" :key="`${run.id}:${explaining.id}`" :run-id="run.id" :run-title="run.title" :space-id="run.spaceId" :context="explainContext" :heading="`${explaining.id} ${explaining.title}`" @close="explaining = null">
        <div class="explain">
          <div class="row"><span class="badge" :class="POINT_STATUS[explaining.status].cls">{{ POINT_STATUS[explaining.status].text }}</span></div>
          <template v-if="explaining.requirement"><div class="ex-h">需求怎么说</div><Markdown :source="explaining.requirement" :space="run.spaceId ?? undefined" /></template>
          <template v-if="explaining.implementation"><div class="ex-h">代码怎么做</div><Markdown :source="explaining.implementation" :space="run.spaceId ?? undefined" /></template>
          <template v-if="explaining.locations.length"><div class="ex-h">位置</div><div class="mono small locs"><a v-for="(l, i) in explaining.locations" :key="i" href="#" @click.prevent="openCitation({ kind: 'file', runId: run.id, path: l.file, from: l.start, to: l.end ?? l.start }, true)">{{ l.file }}{{ l.start ? `:${l.start}${l.end && l.end !== l.start ? `-${l.end}` : ""}` : "" }}</a></div></template>
          <template v-if="explaining.refs.length"><div class="ex-h">依据</div><div class="small"><template v-for="(r, i) in explaining.refs" :key="i"><a v-if="refAction(r, run.id)" href="#" class="mono" @click.prevent="refAction(r, run.id)!()">{{ r }}</a><span v-else class="mono">{{ r }}</span>{{ i < explaining.refs.length - 1 ? "、" : "" }}</template></div></template>
          <template v-if="pointFindings.length"><div class="ex-h">这些文件上的问题</div><div v-for="f in pointFindings" :key="f.id" class="small ex-f"><span class="badge" :class="SEV[f.severity].cls">{{ SEV[f.severity].text }}</span> {{ f.title }} <span class="mono muted">{{ findingWhere(f) }}</span></div></template>
        </div>
      </AskAboutRun>
    </template>
  </div>
</template>

<style scoped>
.work { display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px; min-width: 0; }
.wh { gap: 8px; }
.title { margin: 0; font-size: 19px; min-width: 0; flex: 1 1 16em; overflow-wrap: anywhere; }
.about { gap: 6px 10px; }
.about .link { max-width: 280px; }
.facts { display: grid; grid-template-columns: 52px minmax(0, 1fr); gap: 10px 12px; margin: 0; padding: 12px 14px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel); }
.facts dt { color: var(--muted); font-size: 12.5px; padding-top: 2px; }
.facts dd { margin: 0; min-width: 0; display: grid; gap: 4px; }
.line { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; min-width: 0; overflow-wrap: anywhere; }
.line code { font-size: 12.5px; background: var(--sunken); padding: 0 5px; border-radius: 4px; overflow-wrap: anywhere; }
.br { display: grid; gap: 2px; min-width: 0; }
.br + .br { padding-top: 6px; border-top: 1px dashed var(--line); }
.tabs { margin-bottom: 0; }
.block { display: grid; gap: 8px; min-width: 0; }
.block > .section-title { margin: 0; }
.task { margin: 0; }
.pre { white-space: pre-wrap; overflow-wrap: anywhere; }
.pre.clipped { max-height: 9.5em; overflow: hidden; -webkit-mask-image: linear-gradient(#000 70%, transparent); mask-image: linear-gradient(#000 70%, transparent); }
.req { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; }
.inherited { margin: 0; }
.points { display: grid; gap: 4px; }
.point { display: flex; align-items: center; gap: 8px; padding: 6px 4px; border-top: 1px solid var(--line); color: inherit; min-width: 0; }
.point:hover { text-decoration: none; background: var(--hover); }
.point .ellipsis { flex: 1; min-width: 0; }
.empty-tab { color: var(--muted); font-size: 13px; padding: 14px; border: 1px dashed var(--line-strong); border-radius: var(--radius); margin: 0; }
.rounds { display: grid; gap: 2px; max-height: 320px; overflow: auto; }
.round { display: flex; align-items: center; gap: 8px; width: 100%; min-width: 0; border: 0; background: none; color: inherit; font: inherit; text-align: left; padding: 5px 6px; border-radius: 6px; cursor: pointer; }
.round:hover { background: var(--hover); text-decoration: none; }
.round.on { background: var(--accent-soft); }
.round .no { width: 1.8em; text-align: right; flex: none; }
.round .grow { flex: 1; min-width: 0; }
.round-head { margin-top: 4px; }
.ctx { display: grid; gap: 6px; }
.st { width: 8px; height: 8px; border-radius: 50%; background: var(--line-strong); flex: none; }
.st.running, .st.queued { background: var(--accent); }
.st.done { background: var(--ok); }
.st.failed { background: var(--danger); }
.log { max-height: 320px; overflow: auto; background: var(--sunken); border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; font-size: 12px; white-space: pre-wrap; margin: 0; }
.lnk { border: 0; background: none; color: var(--accent); cursor: pointer; padding: 0; }
.explain { display: grid; gap: 6px; padding-bottom: 12px; border-bottom: 1px solid var(--line); }
.ex-h { margin-top: 8px; font-size: 12.5px; font-weight: 600; color: var(--muted); }
.locs { display: grid; gap: 2px; overflow-wrap: anywhere; }
.ex-f { overflow-wrap: anywhere; }
/* Above the citation drawer, whose text can be quoted too. */
.sel-ask { position: fixed; z-index: 45; display: flex; gap: 6px; }
.sel-ask .btn { box-shadow: var(--shadow-lg); }
.sel-ask .btn:not(.primary):hover:not(:disabled) { background: linear-gradient(var(--hover), var(--hover)), var(--panel); }
.sel-ask .btn.primary:hover:not(:disabled) { opacity: 1; filter: brightness(0.9); }
@media (max-width: 760px) {
  .facts { grid-template-columns: minmax(0, 1fr); gap: 2px 0; }
  .facts dt { padding-top: 6px; }
}
</style>
