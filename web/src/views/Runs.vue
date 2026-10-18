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
const kind = ref("");
const showQuiet = ref(false);
const detail = ref<{ run: Run; events: RunEvent[]; children: Run[]; patches?: { space: string; patch: string }[] } | null>(null);
const id = computed(() => route.params.id as string | undefined);

const listLoading = ref(true);
const detailLoading = ref(false);
async function load() {
  const q = new URLSearchParams({ limit: "500" });
  if (kind.value) q.set("kind", kind.value);
  if (showQuiet.value) q.set("all", "true");
  try {
    runs.value = await get<Run[]>(`/api/runs?${q.toString()}`);
  } finally {
    listLoading.value = false;
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
    void load();
    if (detail.value && (e.runId === detail.value.run.id || detail.value.children.some((c) => c.id === e.runId))) void loadDetail();
  }
});
onBeforeUnmount(() => off());

const out = computed(() => detail.value?.run.output ?? {});
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
const kinds = ["", "ask", "ingest", "ingest-shadow", "memory-review", "wiki-plan", "wiki-write", "wiki-lint", "code", "heartbeat", "dream", "tutor", "brief", "sync"];
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
      <div class="items">
        <Skeleton v-if="listLoading && !runs.length" :rows="8" />
        <VirtualList v-else :items="runs" :item-key="(r) => r.id" :estimate="54">
          <template #default="{ item: r }">
            <router-link :to="`/runs/${r.id}`" class="run" :class="{ on: r.id === id }">
              <span class="st" :class="r.status" />
              <div class="grow">
                <div class="ellipsis">{{ r.title }}</div>
                <div class="muted small">{{ runKindLabel[r.kind] ?? r.kind }} · {{ statusLabel[r.status] }} · {{ relTime(r.createdAt) }}</div>
              </div>
            </router-link>
          </template>
        </VirtualList>
        <div v-if="!runs.length && !listLoading" class="muted small pad">还没有运行记录。</div>
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
          <h1>{{ detail.run.title }}</h1>
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

        <section v-if="detail.run.input?.task || detail.run.input?.text" class="card pad block">
          <div class="section-title">任务</div>
          <div class="pre">{{ detail.run.input.task ?? detail.run.input.text }}</div>
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
