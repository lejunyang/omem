<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { get, onServerEvent, post, type Run } from "../api";
import Icon from "./Icon.vue";
import Markdown from "./Markdown.vue";
import Skeleton from "./Skeleton.vue";
import ReviewSummary from "./ReviewSummary.vue";
import ChangeView from "./ChangeView.vue";
import ReviewChecks from "./ReviewChecks.vue";
import ReviewProcess from "./ReviewProcess.vue";
import RunActivity from "./RunActivity.vue";
import AskAboutRun from "./AskAboutRun.vue";
import OpenInIde from "./OpenInIde.vue";
import { confirmDialog } from "../lib/dialog";
import { addQuote } from "../lib/quotes";
import { parsePatches, pointCount, pointQuote, POINT_STATUS, useReviews, type ChangePoint } from "../lib/reviews";
import { fmtTime, state, statusLabel, toast } from "../store";

/**
 * One delegation or branch review inside the requirements page (views/Requirements.vue), with the
 * run page's tabs: 概览 (the review, the owner's decisions, the next round, apply / discard), 变更,
 * 评审, 活动. `focus` is the requirement node chosen in the tree: “需求点” shows that node's part of
 * the change — the change points the review mapped to it (or to nodes under it) and their code.
 * The change points go up (`points`) so the tree can mark each node with this round's status.
 */
export type ReqFocus = { id: string; title: string; ids: string[]; body: string; acceptance: string };
export type WorkTab = "overview" | "req" | "change" | "review" | "activity";
const props = defineProps<{ runId: string; rounds: string[]; focus: ReqFocus | null; tab?: WorkTab }>();
const emit = defineEmits<{ close: []; open: [runId: string]; points: [points: ChangePoint[]]; "update:tab": [tab: WorkTab] }>();
const spaceName = (id: string) => state.spaces.find((s) => s.id === id)?.name ?? id;

type Detail = { run: Run; children: { id: string }[]; patches?: { space: string; patch: string }[] };
const detail = ref<Detail | null>(null);
const loading = ref(true);
async function load() {
  try {
    detail.value = await get<Detail>(`/api/runs/${props.runId}`);
  } catch (e) {
    detail.value = null;
    toast((e as Error).message, "error");
  } finally {
    loading.value = false;
  }
}
watch(() => props.runId, () => { loading.value = true; void load(); }, { immediate: true });
const off = onServerEvent((e) => {
  if (e.type === "run" && detail.value && (e.runId === detail.value.run.id || detail.value.children.some((c) => c.id === e.runId))) void load();
});
onBeforeUnmount(() => off());

const run = computed(() => detail.value?.run ?? null);
type Check = { command: string; code: number; output: string };
type Out = { appliedAt?: string; discardedAt?: string; review?: string; coderSummary?: string; worktrees?: { commits?: boolean }[]; repos?: { space: string; check: Check | null }[] };
const out = computed(() => (run.value?.output ?? {}) as Out);
const branchReview = computed(() => !!(run.value?.input as { branches?: unknown } | undefined)?.branches);
const branchWork = computed(() => !branchReview.value && (out.value.worktrees ?? []).some((w) => w.commits));
const rv = useReviews(computed(() => run.value?.id ?? ""), computed(() => run.value?.status));
const hasReview = computed(() => !!rv.data.value && (rv.reviews.value.length > 0 || !!rv.current.value?.plan));
const busy = computed(() => ["queued", "running"].includes(run.value?.status ?? ""));
const roundNo = computed(() => props.rounds.indexOf(props.runId) + 1 || props.rounds.length);
const canApply = computed(() => run.value?.status === "done" && !branchReview.value && !branchWork.value && !out.value.appliedAt && !out.value.discardedAt);
const diffs = computed(() => parsePatches(detail.value?.patches ?? []));
const checks = computed(() => (out.value.repos ?? []).flatMap((r) => (r.check ? [{ space: r.space, check: r.check }] : [])));
watch(() => rv.changePoints.value, (p) => emit("points", p), { immediate: true });

// ---- tabs ----------------------------------------------------------------------------------------
const tab = computed<WorkTab>({ get: () => props.tab ?? "overview", set: (t) => emit("update:tab", t) });
/** The change points for the chosen node: mapped to it or to a node under it, and the points under those. */
const focusPoints = computed(() => {
  const f = props.focus;
  if (!f) return [];
  const all = rv.changePoints.value;
  const picked = new Set(all.filter((p) => p.req && f.ids.includes(p.req)).map((p) => p.id));
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of all) if (p.parent && picked.has(p.parent) && !picked.has(p.id)) { picked.add(p.id); grew = true; }
  }
  return all.filter((p) => picked.has(p.id));
});
const tabs = computed(() => [
  { id: "overview" as const, label: "概览" },
  ...(props.focus ? [{ id: "req" as const, label: `需求点 ${focusPoints.value.length ? pointCount(focusPoints.value) : 0}` }] : []),
  { id: "change" as const, label: rv.changePoints.value.length ? `变更 ${pointCount(rv.changePoints.value)}` : "变更" },
  { id: "review" as const, label: "评审" },
  { id: "activity" as const, label: "活动" },
]);
const processFocus = ref<string | null>(null);
watch(tab, (t) => { if (t !== "activity") processFocus.value = null; });
const reqOpen = ref(false);

async function act(action: "apply" | "discard") {
  if (!run.value) return;
  const id = run.value.id;
  try {
    if (action === "apply") {
      const targets = await get<{ space: string; branch: string | null; path: string }[]>(`/api/runs/${id}/apply-targets`);
      if (!(await confirmDialog("应用到原目标分支？", { message: `${targets.map((t) => `${t.space} · ${t.branch ?? "指定版本"}\n${t.path}`).join("\n\n")}\n\n将写入未提交的修改；之后在运行页检查并提交。`, okText: "应用" }))) return;
    } else if (!(await confirmDialog(branchReview.value ? "清理评审工作区？" : "丢弃这次交办？", { message: branchWork.value ? "归还工作区。这次交办新建的分支如果没推送、也没在别处检出，会连同上面的提交一起删掉。" : "归还工作区，改动不再保留。", okText: branchReview.value ? "清理" : "丢弃", danger: true }))) return;
    await post(`/api/runs/${id}/${action}`);
    toast(action === "apply" ? "已应用到目标分支，在运行页检查并提交" : "已清理工作区", "ok");
    void load();
  } catch (e) {
    toast((e as Error).message, "error");
  }
}

// ---- asking: “就这条提问” and 提问 use the run's question basket; “讲解” explains a change point ----
const asking = ref(false);
function ask(c: { quote: string; label: string }) {
  if (!run.value) return;
  addQuote(run.value.id, "ask", c);
  explaining.value = null;
  asking.value = true;
}
const explaining = ref<ChangePoint | null>(null);
const explainContext = computed(() => (explaining.value ? pointQuote(explaining.value, rv.changePoints.value) : null));
function explain(p: ChangePoint) {
  asking.value = false;
  explaining.value = p;
}
</script>

<template>
  <div class="work" data-quotable>
    <div class="row wrap wh">
      <button class="btn ghost sm icon" title="回到需求点" aria-label="回到需求点" @click="emit('close')"><Icon name="left" :size="15" /></button>
      <h2 class="title ellipsis">{{ run?.title ?? "编码" }}</h2>
      <span class="spacer" />
      <div v-if="rounds.length > 1" class="rounds row" role="group" aria-label="各轮">
        <button v-for="(r, i) in rounds" :key="r" class="btn ghost sm" :class="{ on: r === runId }" :aria-pressed="r === runId" @click="emit('open', r)">第 {{ i + 1 }} 轮</button>
      </div>
      <router-link v-if="run" :to="`/runs/${run.id}`" class="btn sm">运行页<Icon name="external" :size="13" /></router-link>
    </div>
    <Skeleton v-if="loading" :rows="5" />
    <template v-else-if="run">
      <div class="row wrap muted small meta">
        <span>第 {{ roundNo }} 轮</span>
        <span class="badge" :class="{ danger: run.status === 'failed' }">{{ statusLabel[run.status] ?? run.status }}</span>
        <span>{{ fmtTime(run.createdAt) }}</span>
        <span v-if="out.appliedAt" class="badge ok">已应用 {{ fmtTime(out.appliedAt) }}</span>
        <span v-if="out.discardedAt" class="badge">已丢弃</span>
        <span class="spacer" />
        <button v-if="canApply" class="btn primary sm" @click="act('apply')"><Icon name="check" :size="14" />应用到原分支</button>
        <button v-if="run.status === 'done' && !out.appliedAt && !out.discardedAt" class="btn sm danger" @click="act('discard')">{{ branchReview ? "清理工作区" : "丢弃" }}</button>
        <OpenInIde :key="`${run.id}:${out.appliedAt ?? ''}:${out.discardedAt ?? ''}:${run.status}`" :run-id="run.id" :space-name="spaceName" />
        <button class="btn ghost sm" @click="explaining = null; asking = true"><Icon name="chat" :size="14" />提问</button>
      </div>
      <p v-if="branchWork && !out.appliedAt && !out.discardedAt && run.status === 'done'" class="muted small">这次交办直接提交在工作分支上，推送和确认在运行页做。</p>

      <nav v-if="hasReview" class="tabs" role="tablist" aria-label="编码详情">
        <button v-for="t in tabs" :key="t.id" role="tab" :class="{ on: tab === t.id }" :aria-selected="tab === t.id" @click="tab = t.id">{{ t.label }}</button>
      </nav>

      <template v-if="hasReview">
        <ReviewSummary v-if="tab === 'overview'" :key="run.id" :rv="rv" :run-id="run.id" :review-text="out.review" :branch-review="branchReview" :branch-work="branchWork" :can-fix="run.status === 'done' && !out.appliedAt && (branchReview || !out.discardedAt)" stay data-ask-label="评审" @ask="ask" @go="(t) => (tab = t)" @started="(id) => emit('open', id)" />
        <template v-else-if="tab === 'req' && focus">
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
          <ChangeView :rv="rv" :run-id="run.id" :diffs="diffs" :only="focusPoints.map((p) => p.id)" @explain="explain" />
        </template>
        <ChangeView v-else-if="tab === 'change'" :rv="rv" :run-id="run.id" :diffs="diffs" @explain="explain" />
        <ReviewChecks v-else-if="tab === 'review'" :rv="rv" :run-id="run.id" data-ask-label="评审" @process="(c) => { processFocus = c; tab = 'activity'; }" />
      </template>

      <template v-if="!hasReview || tab === 'activity'">
        <p v-if="!hasReview && busy" class="muted small">{{ branchReview ? "正在准备评审" : "正在编码" }}，完成后这里显示评审结论。</p>
        <section v-if="out.coderSummary" class="block">
          <div class="section-title">{{ branchReview ? "要评审的分支" : "编码 Agent 的说明" }}</div>
          <div class="card pad"><Markdown :source="out.coderSummary" :space="run.spaceId ?? undefined" /></div>
        </section>
        <section v-for="c in checks" :key="c.space" class="block">
          <div class="section-title">检查<template v-if="checks.length > 1"> · {{ spaceName(c.space) }}</template>：<span class="mono">{{ c.check.command }}</span> <span class="badge" :class="c.check.code === 0 ? 'ok' : 'danger'">退出码 {{ c.check.code }}</span></div>
          <pre class="log">{{ c.check.output }}</pre>
        </section>
        <ReviewProcess v-if="hasReview" :rv="rv" :focus="processFocus" />
        <section v-else class="block">
          <RunActivity :run-id="run.id" :link="false" :open="busy" />
        </section>
      </template>
    </template>
    <p v-else class="muted small">打不开这次运行。</p>
    <AskAboutRun v-if="asking && run" :key="run.id" basket :run-id="run.id" :run-title="run.title" :space-id="run.spaceId" @close="asking = false" @minimize="asking = false" />
    <AskAboutRun v-if="explaining && run" :key="`${run.id}:${explaining.id}`" :run-id="run.id" :run-title="run.title" :space-id="run.spaceId" :context="explainContext" :heading="`${explaining.id} ${explaining.title}`" @close="explaining = null">
      <div class="explain small">
        <span class="badge" :class="POINT_STATUS[explaining.status].cls">{{ POINT_STATUS[explaining.status].text }}</span>
        <p v-if="explaining.requirement"><strong>需求：</strong>{{ explaining.requirement }}</p>
        <p v-if="explaining.implementation"><strong>实现：</strong>{{ explaining.implementation }}</p>
      </div>
    </AskAboutRun>
  </div>
</template>

<style scoped>
.work { display: grid; gap: 12px; min-width: 0; }
.wh { gap: 8px; }
.title { margin: 0; font-size: 18px; min-width: 0; }
.meta { gap: 8px; }
.rounds { gap: 2px; flex-wrap: wrap; }
.rounds .on { background: var(--sunken); color: var(--ink); }
.req { display: grid; gap: 8px; }
.lnk { border: 0; background: none; color: var(--accent); cursor: pointer; padding: 0; }
.log { max-height: 320px; overflow: auto; background: var(--sunken); border-radius: 8px; padding: 8px 10px; font-size: 12px; white-space: pre-wrap; margin: 0; }
.explain { display: grid; gap: 6px; }
.explain p { margin: 0; }
</style>
