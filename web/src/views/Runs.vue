<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { get, onServerEvent, post, type Run, type RunEvent } from "../api";
import Icon from "../components/Icon.vue";
import Markdown from "../components/Markdown.vue";
import RunActivity from "../components/RunActivity.vue";
import { fmtTime, relTime, runKindLabel, statusLabel, toast } from "../store";

const route = useRoute();
const runs = ref<Run[]>([]);
const kind = ref("");
const detail = ref<{ run: Run; events: RunEvent[]; children: Run[]; patch?: string } | null>(null);
const id = computed(() => route.params.id as string | undefined);

async function load() {
  runs.value = await get<Run[]>(`/api/runs?limit=150${kind.value ? `&kind=${kind.value}` : ""}`);
}
async function loadDetail() {
  detail.value = id.value ? await get(`/api/runs/${id.value}`).catch(() => null) : null;
}
onMounted(() => {
  void load();
  void loadDetail();
});
watch(kind, load);
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
const diffFiles = computed(() => {
  const p = detail.value?.patch ?? "";
  if (!p) return [];
  return p
    .split(/^diff --git /m)
    .filter(Boolean)
    .map((chunk) => {
      const name = /^a\/(\S+)/.exec(chunk)?.[1] ?? "?";
      const lines = chunk.split("\n").slice(1);
      return { name, lines, add: lines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length, rm: lines.filter((l) => l.startsWith("-") && !l.startsWith("---")).length };
    });
});
async function act(action: "cancel" | "retry" | "apply" | "discard") {
  if (!detail.value) return;
  if (action === "apply" && !confirm("把这些改动应用到仓库工作区（不提交）？")) return;
  try {
    await post(`/api/runs/${detail.value.run.id}/${action}`);
    toast({ cancel: "已停止", retry: "已重新排队", apply: "已应用到工作区，请在仓库中检查并提交", discard: "已清理工作区" }[action], "ok");
    void loadDetail();
  } catch (e) {
    toast((e as Error).message, "error");
  }
}
const kinds = ["", "ask", "ingest", "wiki-plan", "wiki-write", "wiki-lint", "code", "heartbeat", "dream", "tutor", "sync"];
</script>

<template>
  <div class="runs">
    <aside class="list-col">
      <div class="head row">
        <strong>运行记录</strong>
        <span class="spacer" />
        <select v-model="kind" class="select sm-select">
          <option v-for="k in kinds" :key="k" :value="k">{{ k ? runKindLabel[k] : "全部" }}</option>
        </select>
      </div>
      <div class="items">
        <router-link v-for="r in runs" :key="r.id" :to="`/runs/${r.id}`" class="run" :class="{ on: r.id === id }">
          <span class="st" :class="r.status" />
          <div class="grow">
            <div class="ellipsis">{{ r.title }}</div>
            <div class="muted small">{{ runKindLabel[r.kind] ?? r.kind }} · {{ statusLabel[r.status] }} · {{ relTime(r.createdAt) }}</div>
          </div>
        </router-link>
        <div v-if="!runs.length" class="muted small pad">还没有运行记录。</div>
      </div>
    </aside>
    <main class="detail">
      <div v-if="!detail" class="empty">
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
            <template v-if="detail.run.kind === 'code' && detail.run.status === 'done' && detail.patch && !out.appliedAt && !out.discardedAt">
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

        <section v-if="out.check" class="block">
          <div class="section-title">检查：<span class="mono">{{ out.check.command }}</span> <span class="badge" :class="out.check.code === 0 ? 'ok' : 'danger'">退出码 {{ out.check.code }}</span></div>
          <pre class="log">{{ out.check.output }}</pre>
        </section>

        <section v-if="out.review" class="block">
          <div class="section-title">独立评审 <span class="badge" :class="out.verdict === 'approved' ? 'ok' : 'warn'">{{ out.verdict === "approved" ? "通过" : "需要修改" }}</span></div>
          <div class="card pad"><Markdown :source="out.review" /></div>
        </section>

        <section v-if="diffFiles.length" class="block">
          <div class="section-title">改动 · {{ diffFiles.length }} 个文件</div>
          <details v-for="f in diffFiles" :key="f.name" class="file" open>
            <summary class="mono small"><span>{{ f.name }}</span><span class="add">+{{ f.add }}</span><span class="rm">-{{ f.rm }}</span></summary>
            <pre class="diff"><code v-for="(l, i) in f.lines" :key="i" :class="l.startsWith('+') ? 'a' : l.startsWith('-') ? 'r' : l.startsWith('@@') ? 'h' : ''">{{ l }}
</code></pre>
          </details>
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
