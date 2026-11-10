<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { idQuery } from "../../../src/core/id-query";
import { useRoute, useRouter } from "vue-router";
import { aiLabel, get, onServerEvent, onServerResync, post, type Run, type RunEvent } from "../api";
import Icon from "../components/Icon.vue";
import Skeleton from "../components/Skeleton.vue";
import VirtualList from "../components/VirtualList.vue";
import UiCheckbox from "../components/UiCheckbox.vue";
import ChipPicker from "../components/ChipPicker.vue";
import UiSegmented from "../components/UiSegmented.vue";
import UiSelect from "../components/UiSelect.vue";
import { pageParam } from "../lib/route";
import Markdown from "../components/Markdown.vue";
import RunActivity from "../components/RunActivity.vue";
import ContextUsage from "../components/ContextUsage.vue";
import CodeWork from "../components/CodeWork.vue";
import CodeWorkList from "../components/CodeWorkList.vue";
import { fmtTime, relTime, runKindLabel, state, statusLabel, toast } from "../store";

const route = useRoute();
const router = useRouter();
/** 编码: one row per delegation or branch review (CodeWorkList); 全部运行: every other run, newest first. Kept in this browser. */
const view = ref<"code" | "all">((() => { try { return localStorage.getItem("omem.runs.view") === "code" ? "code" : "all"; } catch { return "all"; } })());
watch(view, (v) => { try { localStorage.setItem("omem.runs.view", v); } catch { /* private window */ } });
/** Coding and review runs are listed as their work under 编码, not one row per round here. */
const CODE_KINDS = "code,review";
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
const id = pageParam("runs");

const listLoading = ref(true);
const detailLoading = ref(false);
let listSeq = 0;
let detailSeq = 0;
let loadedCount = 0;
async function load() {
  clearTimeout(keywordTimer);
  const seq = ++listSeq;
  loadingMore.value = false;
  listLoading.value = true;
  runs.value = [];
  total.value = 0;
  loadedCount = 0;
  const query = pageQuery();
  const exactId = idQuery(keyword.value);
  try {
    if (exactId) {
      // An exact id finds any run, a coding round too (it opens as its work).
      const exact = new URLSearchParams(query);
      exact.delete("q");
      exact.delete("exclude");
      exact.set("id", exactId);
      const found = await get<{ runs: Run[]; total: number }>(`/api/runs?${exact}`).catch(() => ({ runs: [], total: 0 }));
      if (seq !== listSeq) return;
      runs.value = found.runs;
      total.value = found.total;
    }
    const page = await loadPage(0, query);
    if (seq !== listSeq) return;
    appendRuns(page.runs);
    loadedCount = page.runs.length;
    total.value = page.total;
  } finally {
    if (seq === listSeq) listLoading.value = false;
  }
}
function pageQuery() {
  const q = new URLSearchParams({ limit: String(PAGE), brief: "1", exclude: CODE_KINDS });
  // A guest's question runs in the group's space, a rule in the chat's: "所有空间" finds them from anywhere.
  if (scope.value === "space") q.set("space", state.space);
  if (keyword.value.trim()) q.set("q", idQuery(keyword.value) ?? keyword.value.trim());
  if (kindFilter.value.length) q.set("kind", kindFilter.value.join(","));
  if (showQuiet.value) q.set("all", "true");
  if (statusFilter.value) q.set("status", statusFilter.value);
  return q;
}
function loadPage(offset: number, query = pageQuery()) {
  const q = new URLSearchParams(query);
  q.set("offset", String(offset));
  return get<{ runs: Run[]; total: number }>(`/api/runs?${q}`);
}
function appendRuns(page: Run[]) {
  const known = new Set(runs.value.map((r) => r.id));
  runs.value.push(...page.filter((r) => !known.has(r.id)));
}
async function loadMore() {
  if (listLoading.value || loadingMore.value || loadedCount >= total.value) return;
  const seq = listSeq;
  loadingMore.value = true;
  try {
    const page = await loadPage(loadedCount);
    if (seq !== listSeq) return;
    appendRuns(page.runs);
    loadedCount += page.runs.length;
    total.value = page.total;
  } finally {
    if (seq === listSeq) loadingMore.value = false;
  }
}
async function loadDetail() {
  const seq = ++detailSeq, target = id.value;
  if (detail.value?.run.id !== target) detail.value = null;
  detailLoading.value = !!target && !detail.value;
  try {
    const result = target ? await get<NonNullable<typeof detail.value>>(`/api/runs/${target}`).catch(() => null) : null;
    if (seq === detailSeq && target === id.value) detail.value = result;
  } finally {
    if (seq === detailSeq && target === id.value) detailLoading.value = false;
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
watch(() => state.space, load);
let keywordTimer: ReturnType<typeof setTimeout> | undefined;
watch(keyword, () => {
  clearTimeout(keywordTimer);
  // Invalidate both stages immediately, including during the text-search debounce.
  ++listSeq;
  runs.value = [];
  total.value = 0;
  listLoading.value = true;
  loadingMore.value = false;
  keywordTimer = setTimeout(() => void load(), idQuery(keyword.value) ? 0 : 250);
});
watch(id, loadDetail);
watch(() => detail.value?.run.kind, (k) => { if (k === "code" && view.value !== "code" && !keyword.value.trim()) view.value = "code"; });
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
// Back from a hidden tab: runs started and finished meanwhile.
const offResync = onServerResync(() => {
  reloadSoon();
  if (detail.value) void loadDetail();
});
onBeforeUnmount(() => { ++listSeq; ++detailSeq; off(); offResync(); clearTimeout(reloadTimer); clearTimeout(keywordTimer); });

const out = computed(() => detail.value?.run.output ?? {});
const ctxInfo = computed(() => detail.value?.context ?? null);
// The full task as given to the agent (agent rounds, digests); ask turns carry their messages.
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
const finalText = computed(() => out.value.answer ?? out.value.summary ?? "");
const spaceName = (id: string) => state.spaces.find((s) => s.id === id)?.name ?? id;
/** A coding run (a delegation's round or a branch review) opens as its whole work (CodeWork). */
const codeRoot = computed(() => (detail.value?.run.kind === "code" ? String((detail.value.run.input as { continueFrom?: string }).continueFrom ?? detail.value.run.id) : null));
async function act(action: "cancel" | "retry") {
  if (!detail.value) return;
  try {
    const r = await post<{ id?: string; continued?: boolean }>(`/api/runs/${detail.value.run.id}/${action}`);
    if (action === "retry" && r?.id) {
      // An agent run is told what the failed attempt did.
      toast(r.continued ? "已接着上次的进度重新开始" : "已重新排队", "ok");
      router.push(`/runs/${r.id}`);
      return;
    }
    toast(action === "cancel" ? "已停止" : "已重新排队", "ok");
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
  ...Object.entries(runKindLabel).filter(([k]) => !CODE_KINDS.split(",").includes(k)).map(([k, label]) => ({ value: k, label, hint: k })),
  ...roles.value.map((r) => ({ value: `role:${r.name}`, label: `内置 · ${r.name}`, hint: r.description ?? "" })),
  ...specs.value.map((s) => ({ value: `agent:${s.name}`, label: `Agent · ${s.name}`, hint: s.description ?? "这个 Agent 档案的运行" })),
]);
</script>

<template>
  <div class="runs">
    <aside class="list-col">
      <div class="head" :class="{ code: view === 'code' }">
        <UiSegmented v-model="view" class="view-pick" size="sm" aria-label="运行页视图" :options="[{ value: 'code', label: '编码' }, { value: 'all', label: '全部运行' }]" />
        <label class="search"><Icon name="search" :size="14" /><input v-model="keyword" :placeholder="view === 'code' ? '标题、分支、任务里的字或 id' : '标题、id 或任务里的字'" :aria-label="view === 'code' ? '搜索交办' : '搜索运行记录'" /></label>
        <button class="btn sm delegate" title="交办编码任务" @click="delegateOpen = true"><Icon name="code" :size="14" />交办</button>
        <template v-if="view === 'all'">
          <ChipPicker v-model="kindFilter" class="kind-filter" :options="kindOptions" labels :add-label="kindFilter.length ? '＋ 类型' : '全部类型 ＋'" />
          <UiSegmented v-model="statusFilter" class="status-filter" size="sm" aria-label="状态" :options="statusOptions" />
          <UiCheckbox v-model="showQuiet" size="sm" class="small muted quiet" title="后台任务（巡检、检查页面、筛选群、复盘…）没发现要处理的事时以 QUIET 结束，这些运行默认不显示；勾选后一起显示">含无事可报</UiCheckbox>
        </template>
        <UiSegmented v-model="scope" class="scope-filter" size="sm" aria-label="范围" :options="[{ value: 'space', label: '当前空间' }, { value: 'all', label: '所有空间' }]" />
      </div>
      <div v-if="view === 'code'" class="items">
        <CodeWorkList :space="scope === 'space' ? state.space : null" :q="keyword" :active="codeRoot" @pick="(w) => router.push(`/runs/${w.latestId}`)" />
      </div>
      <div v-else class="items" @scroll.passive="onListScroll">
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
        <div v-else-if="runs.length && (listLoading || loadingMore)" class="list-foot"><span class="spinner" />{{ loadingMore ? "加载中…" : "搜索中…" }}</div>
        <div v-else-if="runs.length >= total" class="list-foot">共 {{ total }} 条</div>
      </div>
    </aside>
    <main class="detail">
      <div v-if="detailLoading" class="pad-loading"><Skeleton variant="text" :rows="8" /></div>
      <div v-else-if="!detail" class="empty">
        <Icon :name="view === 'code' ? 'code' : 'activity'" :size="34" />
        <h3>{{ view === "code" ? "编码" : "后台运行" }}</h3>
        <p v-if="view === 'code'">每次交办编码和分支评审是一行，按等谁分组，等你决定或确认的在最上面。点开看它现在在做什么、下一步、分支推到哪，以及修改项、评审和每一轮的过程。</p>
        <p v-else>问答、整理、Wiki 写作和巡检都会在这里留下记录：Agent 做了哪些调查、结果如何。交办编码和评审在“编码”里。</p>
      </div>
      <!-- A delegation's round or a branch review: the whole work, the same view as on the requirements page. -->
      <CodeWork v-else-if="codeRoot" :key="codeRoot" :run-id="detail.run.id" from="runs" @open="(r) => router.push(`/runs/${r}`)" />
      <template v-else>
        <header class="dh">
          <div class="row wrap small">
            <span class="badge accent">{{ runKindLabel[detail.run.kind] ?? detail.run.kind }}</span>
            <span class="badge" :class="{ ok: detail.run.status === 'done', danger: detail.run.status === 'failed', warn: detail.run.status === 'running' }">{{ statusLabel[detail.run.status] }}</span>
            <span class="muted">{{ fmtTime(detail.run.createdAt) }}<template v-if="detail.run.finishedAt"> → {{ fmtTime(detail.run.finishedAt) }}</template></span>
            <span v-if="aiLabel(detail.run)" class="muted" title="这次运行用的后端、模型和思考强度">· <span class="mono">{{ aiLabel(detail.run) }}</span></span>
            <span v-if="detail.run.spaceId" class="muted">· {{ spaceName(detail.run.spaceId) }}</span>
            <router-link v-for="it in ctxInfo?.items ?? []" :key="it.id" :to="`/items/${it.id}`" class="item-link" :title="it.title">事项：{{ it.title }}</router-link>
          </div>
          <h1 :title="hintOf(detail.run)">{{ detail.run.title }}</h1>
          <p v-if="detail.run.waiting" class="muted small waiting" title="omem 自己的排队：开始运行时才选定后端和模型">排队中：{{ detail.run.waiting }}。开始运行时才选定后端和模型；后端自己的排队会在开始后的过程里显示。</p>
          <div class="row wrap">
            <button v-if="['queued', 'running'].includes(detail.run.status)" class="btn sm" @click="act('cancel')"><Icon name="stop" :size="13" />停止</button>
            <button v-if="['failed', 'cancelled'].includes(detail.run.status)" class="btn sm" @click="act('retry')"><Icon name="refresh" :size="13" />重试</button>
          </div>
        </header>

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

        <ContextUsage :events="detail.events" />

        <section class="block">
          <RunActivity :run-id="detail.run.id" :link="false" :open="['queued', 'running'].includes(detail.run.status)">
            <template #default="{ text, running }">
              <Markdown v-if="running && text" :source="text" />
            </template>
          </RunActivity>
        </section>

        <section v-if="finalText" class="block">
          <div class="section-title">结果</div>
          <div class="card pad"><Markdown :source="String(finalText)" :space="detail.run.spaceId ?? undefined" /></div>
        </section>

        <section v-if="detail.children.length" class="block">
          <div class="section-title">后续任务</div>
          <div class="list">
            <router-link v-for="c in detail.children" :key="c.id" :to="`/runs/${c.id}`" class="li"><span class="st" :class="c.status" /><span class="grow ellipsis">{{ c.title }}</span><span class="muted small">{{ statusLabel[c.status] }}</span></router-link>
          </div>
        </section>
      </template>
    </main>

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
.sync .row { gap: 10px; align-items: center; }
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
  padding: 12px 12px 10px;
  border-bottom: 1px solid var(--line);
  display: grid;
  grid-template-columns: auto 1fr auto;
  grid-template-areas:
    "view . delegate"
    "search search search"
    "status status status"
    "scope scope quiet"
    "kind kind kind";
  row-gap: 8px;
  align-items: center;
}
.head.code {
  grid-template-areas:
    "view . delegate"
    "search search search"
    "scope scope scope";
}
.head .view-pick { grid-area: view; justify-self: start; }
.head .search { grid-area: search; display: flex; align-items: center; gap: 6px; height: 30px; padding: 0 8px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); color: var(--muted); }
.head .search:focus-within { border-color: var(--accent); }
.head .search input { flex: 1; min-width: 0; border: 0; outline: 0; background: none; font: inherit; font-size: 13px; color: var(--ink); }
.head .delegate { grid-area: delegate; }
.head .kind-filter { grid-area: kind; justify-self: start; }
.head .status-filter { grid-area: status; justify-self: start; }
.head .scope-filter { grid-area: scope; justify-self: start; }
.head .quiet { grid-area: quiet; justify-self: end; white-space: nowrap; }
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
  align-items: center;
  gap: 10px;
  min-width: 0;
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
