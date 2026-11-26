<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { idQuery } from "../../../src/core/id-query";
import { useRoute, useRouter } from "vue-router";
import { accountLabel, aiLabel, get, onServerEvent, onServerResync, post, triggerLabel, type Run, type RunEvent } from "../api";
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
import TaskBoard from "../components/TaskBoard.vue";
import ProgressBoard from "../components/ProgressBoard.vue";
import ContextUsage from "../components/ContextUsage.vue";
import FirstLookStages from "../components/FirstLookStages.vue";
import { msText } from "../lib/first-look";
import { fmtTime, relTime, runKindLabel, state, statusLabel, toast } from "../store";
import { promptDialog } from "../lib/dialog";

const route = useRoute();
const router = useRouter();
/** Coding and review runs are listed as their work under 编码 → 交办 (views/Code.vue), not one row per round here. */
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
// The person behind a run (someone asking the bot, someone looking for you, a member, yourself).
const byFilter = ref("");
const people = ref<{ key: string; name: string; runs: number; ways: Record<string, number> }[]>([]);
/** How: asking the assistant, looking for you (有人找你), a guest's question… (core/run-trigger.ts VIA_LABEL). */
const viaFilter = ref("");
const WAYS: Record<string, string> = { chat: "找助手", mention: "有人找你", guest: "访客提问", rule: "规则", schedule: "定时", member: "成员操作", flow: "流程", peer: "同伴设备" };
const wayHint = (ways: Record<string, number>) => Object.entries(ways).sort((a, b) => b[1] - a[1]).map(([w, n]) => `${WAYS[w] ?? w} ${n}`).join(" · ");
const byOptions = computed(() => [{ value: "", label: "所有人" }, ...people.value.map((p) => ({ value: p.key, label: p.name, hint: `近 30 天 ${p.runs} 次：${wayHint(p.ways)}` })), ...(byFilter.value && !people.value.some((p) => p.key === byFilter.value) ? [{ value: byFilter.value, label: byFilter.value.replace(/^name:/, "") }] : [])]);
const viaOptions = computed(() => {
  const ways = byFilter.value ? people.value.find((p) => p.key === byFilter.value)?.ways ?? {} : Object.fromEntries(Object.keys(WAYS).map((w) => [w, 1]));
  return [{ value: "", label: "所有方式" }, ...Object.keys(WAYS).filter((w) => ways[w] || w === viaFilter.value).map((w) => ({ value: w, label: WAYS[w] }))];
});
/** The backend (AI profile) and, optionally, its model: `<profile>` or `<profile> · <model>`. */
const aiFilter = ref("");
const AI_SEP = " · ";
const ais = ref<{ profile: string; runs: number; models: { model: string; runs: number }[] }[]>([]);
const aiOptions = computed(() => {
  const opts = [{ value: "", label: "所有后端" } as { value: string; label: string; hint?: string; indent?: boolean }];
  for (const b of ais.value) {
    opts.push({ value: b.profile, label: b.profile, hint: `近 30 天 ${b.runs} 次` });
    // A backend that ran one model (and every run says so): its own row already covers it.
    if (b.models.length > 1 || (b.models[0] && b.models[0].runs < b.runs)) for (const m of b.models) opts.push({ value: `${b.profile}${AI_SEP}${m.model}`, label: m.model, hint: `${b.profile} · ${m.runs} 次`, indent: true });
  }
  if (aiFilter.value && !opts.some((o) => o.value === aiFilter.value)) opts.push({ value: aiFilter.value, label: aiFilter.value.split(AI_SEP).pop()! });
  return opts;
});
const loadAis = () => get<{ backends: typeof ais.value }>("/api/runs/ais").then((r) => (ais.value = r.backends)).catch(() => {});
const loadPeople = () => get<{ people: { key: string; name: string; runs: number; ways: Record<string, number> }[] }>("/api/runs/triggerers").then((r) => (people.value = r.people)).catch(() => {});
/** The filter's key for a run's person: one entry per person by name (run-trigger.ts triggerers), you as yourself. */
const personKey = (by: { key: string; name: string }) => (by.key === "user:owner" ? by.key : `name:${by.name}`);
function filterBy(key: string) {
  scope.value = "all";
  byFilter.value = key;
}
const statusOptions = [{ value: "" as const, label: "全部" }, { value: "queued" as const, label: "排队中" }, { value: "running" as const, label: "进行中" }, { value: "failed" as const, label: "失败" }];
type Brief = { id: string; kind: string; title: string; status: string };
type RunContextInfo = {
  items: { id: string; title: string; status: string }[];
  conversation: { id: string; title: string; channel: string; topic: boolean; work: boolean; parentId: string | null; parentTitle: string | null; own: boolean; turnCount: number; turns: { id: string; title: string; status: string; createdAt: string }[] } | null;
  parent: Brief | null;
  source: Brief | null;
  work: { id: string; title: string; rounds: { runId: string; agent: string; kind: string; status: string; title: string }[] } | null;
};
type ReplyOutcome = { label: string | null; text: string; dueAt: string; first: { label: string; confidence: number | null; by: string } | null; revised: { label: string; by: string; why: string } | null; checked?: { verdict: "confirmed" | "revised"; label: string; by: string; why: string } | null; evidence: { who: string; text: string }[] };
const detail = ref<{ can?: { operate: boolean; edit: boolean }; run: Run; events: RunEvent[]; children: Run[]; board?: { workId: string; taskId?: string }; patches?: { space: string; patch: string }[]; context?: RunContextInfo; reply?: ReplyOutcome | null } | null>(null);
/** What a reply came to, judged from what people said after it; the owner may overrule the label. */
const REPLY_LABELS: Record<string, string> = { resolved: "解决了", followup: "被追问", corrected: "被纠正", taken_over: "别人接手了", unrelated: "看不出", silent: "没人接话", unjudged: "没判" };
const REVISABLE = ["resolved", "followup", "corrected", "taken_over", "unrelated"];
const isOwner = computed(() => !state.me || state.me.role === "owner");
/** 停止 / 重试 on the opened run (`can.operate`); an older server sends no `can`: shown as before. */
const mayOperate = computed(() => detail.value?.can?.operate ?? true);
async function reviseReply(label: string) {
  if (!detail.value) return;
  const why = await promptDialog(`改成“${REPLY_LABELS[label]}”`, { message: "写一句依据：后面哪句话说明了什么。可以不写。", okText: "改判" });
  if (why === null) return;
  try { detail.value.reply = await post<ReplyOutcome>(`/api/runs/${detail.value.run.id}/reply-outcome`, { label, why }); }
  catch (e) { toast((e as Error).message, "error"); }
}
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
  if (byFilter.value) q.set("by", byFilter.value);
  if (viaFilter.value) q.set("via", viaFilter.value);
  if (aiFilter.value) {
    const at = aiFilter.value.indexOf(AI_SEP);
    q.set("ai", at < 0 ? aiFilter.value : aiFilter.value.slice(0, at));
    if (at >= 0) q.set("model", aiFilter.value.slice(at + AI_SEP.length));
  }
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
/** The filters behind 筛选 (the status stays out): how many differ from the default, and whether they are shown. */
/** A round of the work: who did it, then its title — once, when the title already starts with the agent's name. */
function roundLabel(w: { kind: string; agent: string; title: string }) {
  const who = w.kind === "agent-followup" ? "消化结论" : w.agent;
  const title = w.title.replace(new RegExp(`^(${w.agent.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[·:：]\\s*)+`), "");
  return who ? `${who} · ${title}` : title;
}
/** A list row names only the backend; the model and effort are in its tooltip. */
const aiShort = (r: Run) => r.ai?.profile ?? r.profileId ?? "";
const moreFilters = computed(() => kindFilter.value.length + (byFilter.value ? 1 : 0) + (viaFilter.value ? 1 : 0) + (aiFilter.value ? 1 : 0) + (showQuiet.value ? 1 : 0) + (scope.value === "all" ? 1 : 0));
const filtersOpen = ref(false);
watch(scope, load);
watch(kindFilter, load);
watch(showQuiet, load);
watch(statusFilter, load);
watch(byFilter, load);
watch(viaFilter, load);
watch(aiFilter, load);
onMounted(loadPeople);
onMounted(loadAis);
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
// A delegation's round or a branch review is coding work: it opens under 编码 → 交办 (links and
// notifications still point here).
watch(() => detail.value?.run, (r) => { if (r?.kind === "code") void router.replace({ path: `/code/${r.id}`, query: route.query }); });
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
/** Whether the progress view answered: an older server has none, and the board shows on its own then. */
const progressState = ref<"ready" | "empty" | "error" | null>(null);
watch(id, () => (progressState.value = null));
const finalText = computed(() => out.value.answer ?? out.value.summary ?? "");
const spaceName = (id: string) => state.spaces.find((s) => s.id === id)?.name ?? id;
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
      <div class="head">
        <label class="search"><Icon name="search" :size="14" /><input v-model="keyword" placeholder="标题、id 或任务里的字" aria-label="搜索运行记录" /></label>
        <button type="button" class="btn ghost sm more-toggle" :class="{ on: moreFilters > 0 }" :aria-expanded="filtersOpen" aria-controls="run-filters" @click="filtersOpen = !filtersOpen">筛选<span v-if="moreFilters" class="n">{{ moreFilters }}</span><Icon name="down" :size="13" class="chev" :class="{ open: filtersOpen }" /></button>
        <UiSegmented v-model="statusFilter" class="status-filter" size="sm" aria-label="状态" :options="statusOptions" />
        <div v-if="filtersOpen" id="run-filters" class="more-filters">
          <UiSegmented v-model="scope" size="sm" aria-label="范围" :options="[{ value: 'space', label: '当前空间' }, { value: 'all', label: '所有空间' }]" />
          <!-- Two columns of the same widths: 类型 · 后端 above, 触发人 · 触发方式 below. -->
          <div class="filter-grid">
            <ChipPicker v-model="kindFilter" :options="kindOptions" labels :add-label="kindFilter.length ? '＋ 类型' : '全部类型 ＋'" />
            <UiSelect v-model="aiFilter" size="sm" width="100%" aria-label="后端或模型" :options="aiOptions" :search-at="8" :title="aiFilter ? `后端或模型：${aiFilter}` : '按运行用的 AI 后端筛选，后端下面缩进的是它用过的模型'" />
            <UiSelect v-model="byFilter" size="sm" width="100%" aria-label="触发人" :options="byOptions" :search-at="8" title="按触发人筛选：私聊或 @ 机器人提问的人、找你的人、成员、你自己" />
            <UiSelect v-model="viaFilter" size="sm" width="100%" aria-label="触发方式" :options="viaOptions" title="按触发方式筛选：找助手（@ 或私聊机器人）、有人找你……" />
          </div>
          <UiCheckbox v-model="showQuiet" size="sm" class="small muted" title="后台任务（巡检、检查页面、筛选群、复盘…）没发现要处理的事时以 QUIET 结束，这些运行默认不显示；勾选后一起显示">含无事可报</UiCheckbox>
        </div>
      </div>
      <div class="items" @scroll.passive="onListScroll">
        <Skeleton v-if="listLoading && !runs.length" :rows="8" />
        <VirtualList v-else :items="runs" :item-key="(r) => r.id" :estimate="54">
          <template #default="{ item: r }">
            <router-link :to="`/runs/${r.id}`" class="run" :class="{ on: r.id === id }" :title="hintOf(r)">
              <span class="st" :class="r.status" />
              <div class="grow">
                <div class="ellipsis">{{ r.title }}</div>
                <div class="muted small ellipsis">{{ runKindLabel[r.kind] ?? r.kind }}<template v-if="r.status !== 'done'"> · {{ statusLabel[r.status] }}</template> · {{ relTime(r.createdAt) }}<template v-if="r.parentId"> · 后续</template><template v-if="aiShort(r)"> · <span :title="[aiLabel(r), accountLabel(r, state.me)].filter(Boolean).join(' · ')">{{ aiShort(r) }}</span></template></div>
                <div v-if="r.trigger && (r.trigger.via !== 'chat' || r.trigger.by?.key !== 'user:owner')" class="muted small ellipsis by" :title="triggerLabel(r.trigger, true)"><Icon :name="r.trigger.by ? 'user' : r.trigger.via === 'schedule' ? 'clock' : 'zap'" :size="11" />{{ triggerLabel(r.trigger) }}</div>
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
        <Icon name="activity" :size="34" />
        <h3>后台运行</h3>
        <p>问答、整理、Wiki 写作和巡检都会在这里留下记录：Agent 做了哪些调查、结果如何。交办编码和分支评审在“编码”里。</p>
      </div>
      <!-- Coding work moves on to 编码 → 交办 (the watch above). -->
      <div v-else-if="detail.run.kind === 'code'" class="pad-loading"><Skeleton variant="text" :rows="8" /></div>
      <template v-else>
        <header class="dh">
          <div class="row wrap small">
            <span class="badge accent">{{ runKindLabel[detail.run.kind] ?? detail.run.kind }}</span>
            <span class="badge" :class="{ ok: detail.run.status === 'done', danger: detail.run.status === 'failed', warn: detail.run.status === 'running' }">{{ statusLabel[detail.run.status] }}</span>
            <span class="muted">{{ fmtTime(detail.run.createdAt) }}<template v-if="detail.run.finishedAt"> → {{ fmtTime(detail.run.finishedAt) }}</template></span>
            <span v-if="aiLabel(detail.run)" class="muted" title="这次运行用的后端、模型和思考强度">· {{ aiLabel(detail.run) }}</span>
            <span v-if="accountLabel(detail.run, state.me)" class="muted" :title="detail.run.ai?.account?.reason ?? '这次运行用的 AI 账号'">· {{ accountLabel(detail.run, state.me) }}</span>
            <span v-if="detail.run.spaceId" class="muted">· {{ spaceName(detail.run.spaceId) }}</span>
            <span v-if="detail.run.trigger" class="muted">· 触发：<button v-if="detail.run.trigger.by" class="linkish" type="button" title="看这个人触发的全部运行" @click="filterBy(personKey(detail.run.trigger.by))">{{ detail.run.trigger.by.name }}</button><template v-if="detail.run.trigger.by"> · </template><router-link v-if="detail.run.trigger.via === 'flow' && detail.run.input.itemId" :to="`/items/${detail.run.input.itemId}`">{{ triggerLabel({ ...detail.run.trigger, by: undefined }, true) }}</router-link><template v-else>{{ triggerLabel({ ...detail.run.trigger, by: undefined }, true) }}</template></span>
            <router-link v-for="it in ctxInfo?.items ?? []" :key="it.id" :to="`/items/${it.id}`" class="item-link" :title="it.title">事项：{{ it.title }}</router-link>
          </div>
          <h1 :title="hintOf(detail.run)">{{ detail.run.title }}</h1>
          <p v-if="detail.run.waiting" class="muted small waiting" title="omem 自己的排队：开始运行时才选定后端和模型">排队中：{{ detail.run.waiting }}。开始运行时才选定后端和模型；后端自己的排队会在开始后的过程里显示。</p>
          <div v-if="mayOperate" class="row wrap">
            <button v-if="['queued', 'running'].includes(detail.run.status)" class="btn sm" @click="act('cancel')"><Icon name="stop" :size="13" />停止</button>
            <button v-if="['failed', 'cancelled'].includes(detail.run.status)" class="btn sm" @click="act('retry')"><Icon name="refresh" :size="13" />重试</button>
          </div>
        </header>

        <section v-if="ctxInfo && (ctxInfo.conversation || ctxInfo.parent || ctxInfo.work)" class="card pad block ctx">
          <div class="section-title">所在会话与关联</div>
          <div v-if="ctxInfo.conversation" class="ctx-row">
            <span class="muted small">{{ ctxInfo.conversation.own ? "会话" : "结果发到" }}</span>
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
              <span class="grow ellipsis">{{ roundLabel(w) }}</span>
              <span class="muted small">{{ statusLabel[w.status] }}</span>
            </router-link>
          </div>
          <div v-if="ctxInfo.conversation && ctxInfo.conversation.turns.length > 1" class="ctx-steps">
            <div class="muted small">同一会话里的对话轮次（{{ ctxInfo.conversation.turnCount > ctxInfo.conversation.turns.length ? `共 ${ctxInfo.conversation.turnCount} 轮，这是前后的 ${ctxInfo.conversation.turns.length} 轮` : ctxInfo.conversation.turns.length }}）</div>
            <router-link v-for="t in ctxInfo.conversation.turns" :key="t.id" :to="`/runs/${t.id}`" class="li" :class="{ on: t.id === detail.run.id }" :title="t.title">
              <span class="st" :class="t.status" /><span class="grow ellipsis">{{ t.title }}</span><span class="muted small">{{ fmtTime(t.createdAt) }}</span>
            </router-link>
          </div>
        </section>

        <section v-if="detail.reply" class="card pad block reply-outcome">
          <div class="section-title">回复发出后</div>
          <div class="reply-head">
            <strong>{{ detail.reply.text }}</strong>
            <span v-if="detail.reply.revised" class="muted small">{{ detail.reply.revised.by }}改判{{ detail.reply.revised.why ? `：${detail.reply.revised.why}` : "" }}（原先标的是“{{ REPLY_LABELS[detail.reply.first?.label ?? ""] }}”）</span>
            <span v-else-if="detail.reply.first" class="muted small">{{ detail.reply.first.by }}{{ detail.reply.first.confidence != null ? `，把握 ${detail.reply.first.confidence.toFixed(2)}` : "" }}{{ detail.reply.first.label !== detail.reply.label ? `；它选的是“${REPLY_LABELS[detail.reply.first.label]}”，把握不够，按看不出算` : "" }}</span>
            <span v-else class="muted small">{{ fmtTime(detail.reply.dueAt) }} 以后，按大家在这之后说的话判断这条回复有没有用</span>
            <span v-if="detail.reply.checked?.verdict === 'confirmed'" class="muted small">夜里复查（{{ detail.reply.checked.by }}）同意{{ detail.reply.checked.why ? `：${detail.reply.checked.why}` : "" }}</span>
          </div>
          <ul v-if="detail.reply.evidence.length" class="reply-lines">
            <li v-for="(l, i) in detail.reply.evidence" :key="i"><span class="muted">{{ l.who }}</span>{{ l.text }}</li>
          </ul>
          <div v-if="isOwner && detail.reply.first" class="reply-revise">
            <span class="muted small">标得不对就改：</span>
            <button v-for="l in REVISABLE.filter((x) => x !== detail!.reply!.label)" :key="l" type="button" class="btn ghost sm" @click="reviseReply(l)">{{ REPLY_LABELS[l] }}</button>
          </div>
        </section>

        <section v-if="detail.run.kind === 'first-look' && out.stages" class="card pad block">
          <div class="section-title">各层用了多久、结果如何</div>
          <FirstLookStages :stages="out.stages" :outcome="out.outcome" />
        </section>
        <section v-if="detail.run.kind === 'probe' && (out.stdout !== undefined || out.stderr !== undefined)" class="card pad block probe-out">
          <div class="section-title">预查{{ detail.run.input?.trial ? "（试跑）" : "" }}的结果</div>
          <div class="row wrap small">
            <span class="badge" :class="out.exitCode === 0 && !out.timedOut ? 'ok' : 'danger'">{{ out.timedOut ? "超时" : out.exitCode === 0 ? "成功" : "失败" }}</span>
            <span>退出码 {{ out.exitCode ?? "—" }}</span>
            <span>用时 {{ msText(out.ms) }}</span>
            <span v-if="detail.run.input?.probe" class="muted">预查「{{ detail.run.input.probe }}」 · <router-link :to="`/rules/probes?name=${encodeURIComponent(detail.run.input.probe)}`">在预查库里打开</router-link></span>
          </div>
          <div v-if="detail.run.input?.captures && Object.keys(detail.run.input.captures).length" class="small muted">匹配到的：<code v-for="(v, k) in detail.run.input.captures" :key="k" class="cap">{{ k }}={{ v }}</code></div>
          <pre class="pre">{{ out.stdout || "（没有输出）" }}</pre>
          <pre v-if="out.stderr" class="pre err">{{ out.stderr }}</pre>
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

        <!-- The whole work this run belongs to, block by block (the board's own track opens from its block);
             an older server without the view keeps the board alone. -->
        <ProgressBoard class="block" :run="detail.run.id" :focus="detail.board?.taskId" label="分头在做的" @state="(s) => (progressState = s)" />
        <section v-if="detail.board && progressState === 'error'" class="block">
          <TaskBoard :work-id="detail.board.workId" :focus="detail.board.taskId" />
        </section>

        <section v-if="detail.children.length" class="block">
          <div class="section-title">后续任务</div>
          <div class="list">
            <router-link v-for="c in detail.children" :key="c.id" :to="`/runs/${c.id}`" class="li"><span class="st" :class="c.status" /><span class="grow ellipsis">{{ c.title }}</span><span class="muted small">{{ statusLabel[c.status] }}</span></router-link>
          </div>
        </section>
      </template>
    </main>

  </div>
</template>

<style scoped>
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
  /* A search and the most used status on top; the rest behind 筛选. */
  grid-template-areas:
    "search search search"
    "status . more"
    "filters filters filters";
  row-gap: 8px;
  align-items: center;
}
.head .more-toggle { grid-area: more; justify-self: end; gap: 4px; color: var(--ink-2); }
.head .more-toggle .n { min-width: 16px; padding: 0 4px; border-radius: 999px; background: var(--accent-soft); color: var(--accent); font-size: 12px; text-align: center; }
.head .more-toggle .chev { color: var(--muted); transition: transform 0.15s ease; }
.head .more-toggle .chev.open { transform: rotate(180deg); }
.head .more-filters { grid-area: filters; display: grid; gap: 8px; justify-items: start; padding-top: 8px; border-top: 1px dashed var(--line); }
.head .search { grid-area: search; display: flex; align-items: center; gap: 6px; height: 30px; padding: 0 8px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); color: var(--muted); }
.head .search:focus-within { border-color: var(--accent); }
.head .search input { flex: 1; min-width: 0; border: 0; outline: 0; background: none; font: inherit; font-size: 13px; color: var(--ink); }
.head .status-filter { grid-area: status; justify-self: start; }
.head .filter-grid { display: grid; grid-template-columns: 132px 124px; gap: 6px; align-items: start; }
.head .filter-grid > * { min-width: 0; }
.run .by { display: flex; align-items: center; gap: 4px; }
.linkish { border: 0; background: none; padding: 0; font: inherit; color: var(--accent); cursor: pointer; }
.linkish:hover { text-decoration: underline; }
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
.probe-out {
  display: grid;
  gap: 8px;
}
.probe-out .row {
  gap: 10px;
  align-items: center;
}
.probe-out pre.pre {
  margin: 0;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--sunken);
  font-family: var(--mono);
  font-size: 12.5px;
  max-height: 360px;
  overflow-y: auto;
}
.probe-out pre.err {
  color: var(--danger);
}
.probe-out .cap {
  margin-left: 6px;
  overflow-wrap: anywhere;
  word-break: break-all;
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
.reply-outcome {
  display: grid;
  gap: 8px;
}
.reply-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 10px;
}
.reply-lines {
  margin: 0;
  padding: 0 0 0 10px;
  list-style: none;
  display: grid;
  gap: 4px;
  border-left: 2px solid var(--line);
  font-size: 13px;
  overflow-wrap: anywhere;
}
.reply-lines .muted {
  margin-right: 8px;
}
.reply-revise {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
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
