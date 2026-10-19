<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { get, onServerEvent, post, type Run, type RunEvent } from "../api";
import Icon from "../components/Icon.vue";
import Skeleton from "../components/Skeleton.vue";
import VirtualList from "../components/VirtualList.vue";
import UiCheckbox from "../components/UiCheckbox.vue";
import UiSelect from "../components/UiSelect.vue";
import { confirmDialog } from "../lib/dialog";
import Markdown from "../components/Markdown.vue";
import RunActivity from "../components/RunActivity.vue";
import { fmtTime, relTime, runKindLabel, state, statusLabel, toast } from "../store";

const route = useRoute();
const router = useRouter();
const runs = ref<Run[]>([]);
const total = ref(0);
const PAGE = 100;
const loadingMore = ref(false);
const kind = ref("");
const showQuiet = ref(false);
type Brief = { id: string; kind: string; title: string; status: string };
type RunContextInfo = {
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
  const q = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
  if (kind.value) q.set("kind", kind.value);
  if (showQuiet.value) q.set("all", "true");
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
  void load();
  void loadDetail();
});
watch(kind, load);
watch(showQuiet, load);
watch(id, loadDetail);
const off = onServerEvent((e) => {
  if (e.type === "run") {
    // Keep the list itself stable: only refresh when a new top-level run might appear.
    if (e.status === "queued") void load();
    if (detail.value && (e.runId === detail.value.run.id || detail.value.children.some((c) => c.id === e.runId))) void loadDetail();
  }
});
function onListScroll(ev: Event) {
  const el = ev.target as HTMLElement;
  if (el.scrollHeight - el.scrollTop - el.clientHeight < 400) void loadMore();
}
onBeforeUnmount(() => off());

const out = computed(() => detail.value?.run.output ?? {});
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
const spaceName = (id: string) => state.spaces.find((s) => s.id === id)?.name ?? id;
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
const task = ref({ repos: [] as string[], task: "", check: "" });
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
    const r = await post<Run>("/api/delegate", { space, repos: task.value.repos, task: task.value.task, checkCommand: task.value.check || undefined });
    delegateOpen.value = false;
    task.value = { repos: [], task: "", check: "" };
    router.push(`/runs/${r.id}`);
  } catch (e) {
    toast((e as Error).message, "error");
  }
}
const kinds = ["", "ask", "ingest", "ingest-shadow", "memory-review", "wiki-plan", "wiki-write", "wiki-lint", "code", "heartbeat", "dream", "tutor", "brief", "curate", "sync", "agent-followup"];
</script>

<template>
  <div class="runs">
    <aside class="list-col">
      <div class="head row">
        <strong>运行记录</strong>
        <span class="spacer" />
        <button class="btn sm" title="交办编码任务" @click="delegateOpen = true"><Icon name="code" :size="14" />交办</button>
        <UiSelect v-model="kind" size="sm" width="110px" aria-label="运行类型" :options="kinds.map((k) => ({ value: k, label: k ? (runKindLabel[k] ?? k) : '全部' }))" />
        <UiCheckbox v-model="showQuiet" size="sm" class="small muted" title="没有发现变化的静默巡检默认不显示">静默</UiCheckbox>
      </div>
      <div class="items" @scroll.passive="onListScroll">
        <Skeleton v-if="listLoading && !runs.length" :rows="8" />
        <VirtualList v-else :items="runs" :item-key="(r) => r.id" :estimate="54">
          <template #default="{ item: r }">
            <router-link :to="`/runs/${r.id}`" class="run" :class="{ on: r.id === id }" :title="r.title">
              <span class="st" :class="r.status" />
              <div class="grow">
                <div class="ellipsis">{{ r.title }}</div>
                <div class="muted small">{{ runKindLabel[r.kind] ?? r.kind }} · {{ statusLabel[r.status] }} · {{ relTime(r.createdAt) }}<template v-if="r.parentId"> · 后续</template></div>
              </div>
            </router-link>
          </template>
        </VirtualList>
        <div v-if="!runs.length && !listLoading" class="muted small pad">还没有运行记录。</div>
        <div v-else-if="loadingMore" class="muted small pad center">加载中…</div>
        <div v-else-if="runs.length >= total" class="muted small pad center">共 {{ total }} 条</div>
      </div>
    </aside>
    <main class="detail">
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
            <span v-if="detail.run.profileId" class="muted">· {{ detail.run.profileId }}</span>
            <span v-if="detail.run.spaceId" class="muted">· {{ detail.run.spaceId }}</span>
          </div>
          <h1 :title="detail.run.title">{{ detail.run.title }}</h1>
          <div class="row">
            <button v-if="['queued', 'running'].includes(detail.run.status)" class="btn sm" @click="act('cancel')"><Icon name="stop" :size="13" />停止</button>
            <button v-if="['failed', 'cancelled'].includes(detail.run.status)" class="btn sm" @click="act('retry')"><Icon name="refresh" :size="13" />重试</button>
            <template v-if="detail.run.kind === 'code' && detail.run.status === 'done' && detail.patches?.length && !out.appliedAt && !out.discardedAt">
              <button class="btn primary sm" @click="act('apply')"><Icon name="check" :size="14" />应用到仓库</button>
              <button class="btn sm danger" @click="act('discard')">丢弃</button>
            </template>
            <span v-if="out.appliedAt" class="badge ok">已应用 {{ fmtTime(out.appliedAt) }}</span>
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

        <section v-if="taskText" class="card pad block">
          <div class="section-title row">任务<span class="spacer" /><button v-if="taskLong" class="btn ghost sm" @click="taskOpen = !taskOpen">{{ taskOpen ? "收起" : "展开全部" }}</button></div>
          <div class="pre task" :class="{ clipped: taskLong && !taskOpen }">{{ taskText }}</div>
        </section>

        <section class="block">
          <RunActivity :run-id="detail.run.id" :open="['queued', 'running'].includes(detail.run.status)">
            <template #default="{ text, running }">
              <Markdown v-if="running && text" :source="text" />
            </template>
          </RunActivity>
        </section>

        <section v-if="finalText" class="block">
          <div class="section-title">{{ detail.run.kind === "code" ? "编码 Agent 的说明" : "结果" }}</div>
          <div class="card pad"><Markdown :source="String(finalText)" :space="detail.run.spaceId ?? undefined" /></div>
        </section>

        <section v-for="c in checks" :key="c.space" class="block">
          <div class="section-title">检查<template v-if="c.space"> · {{ spaceName(c.space) }}</template>：<span class="mono">{{ c.check.command }}</span> <span class="badge" :class="c.check.code === 0 ? 'ok' : 'danger'">退出码 {{ c.check.code }}</span></div>
          <pre class="log">{{ c.check.output }}</pre>
        </section>

        <section v-if="out.review" class="block">
          <div class="section-title">独立评审 <span class="badge" :class="out.verdict === 'approved' ? 'ok' : 'warn'">{{ out.verdict === "approved" ? "通过" : "需要修改" }}</span></div>
          <div class="card pad"><Markdown :source="out.review" /></div>
        </section>

        <section v-if="fileCount" class="block">
          <div class="section-title">改动 · {{ diffs.length > 1 ? `${diffs.length} 个仓库，` : "" }}{{ fileCount }} 个文件</div>
          <p v-if="out.indexedSpaces?.length && !out.appliedAt && !out.discardedAt" class="muted small">应用或丢弃之前，改过的文件可以检索（空间 {{ out.indexedSpaces.join("、") }}）；之后连同 worktree 一起删除。</p>
          <template v-for="d in diffs" :key="d.space">
          <div v-if="diffs.length > 1" class="repo-title">{{ spaceName(d.space) }}</div>
          <details v-for="f in d.files" :key="f.name" class="file" open>
            <summary class="mono small"><span>{{ f.name }}</span><span class="add">+{{ f.add }}</span><span class="rm">-{{ f.rm }}</span></summary>
            <pre class="diff"><code v-for="(l, i) in f.lines" :key="i" :class="l.startsWith('+') ? 'a' : l.startsWith('-') ? 'r' : l.startsWith('@@') ? 'h' : ''">{{ l }}
</code></pre>
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
    </main>

    <div v-if="delegateOpen" class="modal-overlay" @mousedown.self="delegateOpen = false">
      <div class="modal stack">
        <div class="row"><strong>交办编码任务</strong><span class="spacer" /><button class="btn ghost sm icon" @click="delegateOpen = false"><Icon name="x" /></button></div>
        <p class="muted small">每个仓库各开一个独立的 Git worktree，由编码 Agent 一起实现，分别运行检查命令，再由评审 Agent 审查。确认后所有仓库一起应用。</p>
        <div v-if="!repos.length" class="muted">还没有关联代码目录的空间，请先在设置里新建代码仓库空间。</div>
        <template v-else>
          <div class="field">
            <span>仓库（可多选，一起改）</span>
            <div class="repo-picks">
              <UiCheckbox v-for="r in repos" :key="r.id" v-model="task.repos" :value="r.id" size="sm">{{ r.name }}</UiCheckbox>
            </div>
          </div>
          <label class="field"><span>任务</span><textarea v-model="task.task" class="textarea" rows="6" placeholder="目标、背景、验收标准、相关讨论" /></label>
          <label class="field"><span>检查命令（可选，默认用空间设置）</span><input v-model="task.check" class="input mono" placeholder="pnpm test" /></label>
          <div class="row"><span class="spacer" /><button class="btn primary" :disabled="!task.task.trim() || !task.repos.length" @click="delegate">交办</button></div>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
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
    "kind quiet .";
  row-gap: 8px;
  align-items: center;
}
.head > strong { grid-area: title; }
.head .btn[title="交办编码任务"] { grid-area: delegate; }
.head .sm-select { grid-area: kind; justify-self: start; }
.head .small.muted { grid-area: quiet; justify-self: end; white-space: nowrap; }
@media (max-width: 480px) {
  .head {
    grid-template-columns: 1fr auto;
    grid-template-areas:
      "title delegate"
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
.diff {
  margin: 0;
  font-size: 12px;
  overflow-x: auto;
  padding: 6px 0;
}
.diff code {
  display: block;
  white-space: pre;
  padding: 0 12px;
  font-family: var(--mono);
}
.diff .a {
  background: var(--ok-soft);
}
.diff .r {
  background: var(--danger-soft);
}
.diff .h {
  color: var(--muted);
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
