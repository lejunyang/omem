<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { get, onServerEvent, post, type Run } from "../api";
import Icon from "./Icon.vue";
import Skeleton from "./Skeleton.vue";
import ReviewSummary from "./ReviewSummary.vue";
import AskAboutRun from "./AskAboutRun.vue";
import OpenInIde from "./OpenInIde.vue";
import { confirmDialog } from "../lib/dialog";
import { addQuote } from "../lib/quotes";
import { useReviews } from "../lib/reviews";
import { fmtTime, state, statusLabel, toast } from "../store";

/**
 * One delegation or branch review shown inside the requirements page (views/Requirements.vue): its
 * review overview with the owner's decisions, the next round, and applying or discarding the result.
 * Diffs, activity and work-branch pushes stay on the run page, linked from here.
 */
const props = defineProps<{ runId: string; rounds: string[] }>();
const emit = defineEmits<{ close: []; open: [runId: string] }>();
const router = useRouter();
const spaceName = (id: string) => state.spaces.find((s) => s.id === id)?.name ?? id;

type Detail = { run: Run; children: { id: string }[] };
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
const out = computed(() => (run.value?.output ?? {}) as { appliedAt?: string; discardedAt?: string; review?: string; worktrees?: { commits?: boolean }[] });
const branchReview = computed(() => !!(run.value?.input as { branches?: unknown } | undefined)?.branches);
const branchWork = computed(() => !branchReview.value && (out.value.worktrees ?? []).some((w) => w.commits));
const rv = useReviews(computed(() => run.value?.id ?? ""), computed(() => run.value?.status));
const hasReview = computed(() => !!rv.data.value && (rv.reviews.value.length > 0 || !!rv.current.value?.plan));
const busy = computed(() => ["queued", "running"].includes(run.value?.status ?? ""));
const roundNo = computed(() => props.rounds.indexOf(props.runId) + 1 || props.rounds.length);
const canApply = computed(() => run.value?.status === "done" && !branchReview.value && !branchWork.value && !out.value.appliedAt && !out.value.discardedAt);

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

// “就这条提问” collects the finding into the run's question basket and opens it here.
const asking = ref(false);
function ask(c: { quote: string; label: string }) {
  if (!run.value) return;
  addQuote(run.value.id, "ask", c);
  asking.value = true;
}
</script>

<template>
  <div class="work">
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
        <button class="btn ghost sm" @click="asking = true"><Icon name="chat" :size="14" />提问</button>
      </div>
      <p v-if="branchWork && !out.appliedAt && !out.discardedAt && run.status === 'done'" class="muted small">这次交办直接提交在工作分支上，推送和确认在运行页做。</p>
      <ReviewSummary v-if="hasReview" :key="run.id" :rv="rv" :run-id="run.id" :review-text="out.review" :branch-review="branchReview" :branch-work="branchWork" :can-fix="run.status === 'done' && !out.appliedAt && (branchReview || !out.discardedAt)" stay @ask="ask" @go="router.push(`/runs/${run.id}`)" @started="(id) => emit('open', id)" />
      <p v-else-if="busy" class="muted small">{{ branchReview ? "正在准备评审" : "正在编码" }}，完成后这里显示评审结论。</p>
      <p v-else class="muted small">这一轮没有评审结果，详情在运行页。</p>
    </template>
    <p v-else class="muted small">打不开这次运行。</p>
    <AskAboutRun v-if="asking && run" :key="run.id" basket :run-id="run.id" :run-title="run.title" :space-id="run.spaceId" @close="asking = false" @minimize="asking = false" />
  </div>
</template>

<style scoped>
.work { display: grid; gap: 12px; }
.wh { gap: 8px; }
.title { margin: 0; font-size: 18px; min-width: 0; }
.meta { gap: 8px; }
.rounds { gap: 2px; flex-wrap: wrap; }
.rounds .on { background: var(--sunken); color: var(--ink); }
</style>
