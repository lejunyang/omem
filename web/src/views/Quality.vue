<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { get, onServerEvent, post } from "../api";
import Skeleton from "../components/Skeleton.vue";
import Markdown from "../components/Markdown.vue";
import RichText from "../components/RichText.vue";
import HelpText from "../components/HelpText.vue";
import { fmtTime, runKindLabel } from "../store";

type Finding = { kind: string; quote: string; problem: string; basis: string; fix?: string };
type Audit = { category?: string; suggestedLevel?: string; reviewReason?: string; id: string; at: string; spaceId: string; target: string; title?: string; pipeline: string; writerAi: string; checkerAi: string; verdict: string; why: string; findings: Finding[]; fixRun: string | null; auditRun: string | null };
type Pipeline = { pipeline: string; audited: number; ok: number; style: number; wrong: number; unchecked: number; accuracy: number | null; flagged: boolean };
type Overview = { settings: { days: number }; pipelines: Pipeline[]; recent: Audit[]; waiting: number };
const data = ref<Overview>();
const error = ref("");
const busy = ref(false);
const runId = ref("");
const notice = ref("");
let request = 0;
const totals = computed(() => data.value?.pipelines.filter(p => p.pipeline !== "level").reduce((n, p) => ({ audited: n.audited + p.audited, wrong: n.wrong + p.wrong }), { audited: 0, wrong: 0 }));
const levelLabels: Record<string, string> = { focus: "重点关注", normal: "一般关注", reference: "仅检索", ignore: "忽略" };
const verdicts: Record<string, string> = { ok: "没问题", style: "只有写法问题", wrong: "有事实问题", unchecked: "没核完" };
const findingKinds: Record<string, string> = { cite: "引用", code: "代码", negative: "否定结论", conflict: "冲突", unsure: "尚未查清", wording: "表达", hedge: "含糊表达", length: "篇幅" };
async function load() {
  const current = ++request;
  error.value = "";
  try { const result = await get<Overview>("/api/quality"); if (current === request) data.value = result; }
  catch (e) { if (current === request) error.value = (e as Error).message; }
}
async function audit() {
  busy.value = true;
  notice.value = "";
  runId.value = "";
  try {
    const result = await post<{ runId: string | null; reason?: string }>("/api/quality/audit", {});
    runId.value = result.runId ?? "";
    notice.value = result.runId ? "抽检已排队" : ({ disabled: "每晚抽检已关闭，可在设置中开启", "nothing to audit": "没有等着抽检的页面或定级", "already under way": "已有抽检在排队或运行" }[result.reason ?? ""] ?? "没有启动抽检");
    await load();
  } catch (e) { error.value = (e as Error).message; }
  finally { busy.value = false; }
}
onMounted(load);
const pageOf = (a: Audit) => a.category === "level" ? (a.target.startsWith("level-source:") ? `#/sources/${a.target.slice(13)}` : "#/sources?review=1") : `#/wiki/${encodeURIComponent(a.spaceId)}/${a.target.split("/").map(encodeURIComponent).join("/")}`;
const verdictOf = (a: Audit) => a.category === "level" && a.verdict === "wrong" ? "定级不对" : (verdicts[a.verdict] ?? a.verdict);
const off = onServerEvent((e) => { if (e.type === "run" && e.runId === runId.value) void load(); });
onBeforeUnmount(() => { request++; off(); });
</script>

<template>
  <div class="page quality">
    <div class="page-head">
      <div>
        <h1>每晚抽检</h1>
        <p>助手写的页面和给原件定的级，每晚抽几条让另一个模型核对。</p>
      </div>
      <span class="spacer" />
      <a class="btn ghost sm" href="#/settings?card=audit">抽检设置</a>
      <button class="btn primary sm" :disabled="busy" @click="audit">{{ busy ? "正在排队…" : "现在抽检" }}</button>
    </div>
    <p v-if="error" class="err" role="alert">{{ error }} <button class="btn sm" @click="load">重试</button></p>
    <p v-if="notice" class="small" role="status">{{ notice }} <a v-if="runId" :href="`#/runs/${runId}`">查看运行</a></p>
    <Skeleton v-if="!data && !error" :rows="5" />
    <template v-if="data">
      <section class="block">
        <h2 class="section-title">近 {{ data.settings.days }} 天</h2>
        <p class="lead">抽检 {{ totals?.audited }} 页，<span :class="{ bad: totals?.wrong }">{{ totals?.wrong }} 页有事实问题</span>；还有 {{ data.waiting }} 页等着抽</p>
        <table v-if="data.pipelines.length" class="figures">
          <thead><tr><th>页面来源 / 定级</th><th>抽检</th><th>没问题</th><th class="opt">只有写法问题</th><th>不对</th><th class="opt">没核完</th><th>准确率</th></tr></thead>
          <tbody>
            <tr v-for="p in data.pipelines" :key="p.pipeline">
              <th><span class="pcell"><span class="pname">{{ p.pipeline === "level" ? "定级" : (runKindLabel[p.pipeline] ?? p.pipeline) }}</span><span v-if="p.flagged" class="badge danger">加严：每页都看</span></span></th>
              <td>{{ p.audited }}</td><td>{{ p.ok }}</td><td class="opt">{{ p.style }}</td><td :class="{ bad: p.wrong }">{{ p.wrong }}</td><td class="opt">{{ p.unchecked }}</td><td>{{ p.accuracy === null ? "—" : `${Math.round(p.accuracy * 100)}%` }}</td>
            </tr>
          </tbody>
        </table>
        <HelpText>比例按核完的页面计算，只有写法问题也计入没有事实问题；没核完的不计入。定级单列，准确率按判对 /（判对 + 判错）计算，不自动加严。</HelpText>
      </section>

      <section class="block">
        <h2 class="section-title">最近抽检</h2>
        <p v-if="!data.recent.length" class="muted">还没有抽检过；每晚 05:10 会从助手自己写的页面里抽几页（设置里可改）。</p>
        <div class="list-rows">
          <article v-for="a in data.recent" :key="a.id" class="audit">
            <div class="a-head">
              <a class="a-title" :href="pageOf(a)">{{ a.title ?? a.target }}</a>
              <span class="badge" :class="{ danger: a.verdict === 'wrong' }">{{ verdictOf(a) }}</span>
              <span class="spacer" />
              <time class="muted small" :title="`抽到原因：${a.why}`">{{ fmtTime(a.at) }}</time>
            </div>
            <p class="muted small a-meta">
              {{ a.category === "level" ? "定级" : "写作" }}：{{ runKindLabel[a.pipeline] ?? a.pipeline }} · {{ a.writerAi || "未记录 AI" }} → 核对：{{ a.checkerAi || "未记录 AI" }}<span v-if="a.writerAi && a.writerAi === a.checkerAi" class="same">（同一个模型）</span>
            </p>
            <p v-if="a.reviewReason" class="small a-reason">{{ a.suggestedLevel ? `建议级别：${levelLabels[a.suggestedLevel] ?? a.suggestedLevel}。` : "" }}<RichText :text="a.reviewReason" :space="a.spaceId" :lines="2" /></p>
            <details v-if="a.findings.length || a.why" class="small">
              <summary>{{ a.findings.length ? `${a.findings.length} 个问题` : "抽到原因" }}<template v-if="a.fixRun || a.auditRun"> · 运行</template></summary>
              <p class="muted">抽到原因：{{ a.why }}</p>
              <div v-for="(f, i) in a.findings" :key="i" class="finding">
                <strong>{{ findingKinds[f.kind] ?? f.kind }}</strong>
                <blockquote><Markdown :source="f.quote" :space="a.spaceId" compact /></blockquote>
                <RichText tag="p" :text="f.problem" :space="a.spaceId" breaks />
                <p class="muted">依据：<RichText :text="f.basis" :space="a.spaceId" /></p>
                <p v-if="f.fix" class="muted">建议：<RichText :text="f.fix" :space="a.spaceId" /></p>
              </div>
              <div v-if="a.fixRun || a.auditRun" class="row wrap"><a v-if="a.fixRun" :href="`#/runs/${a.fixRun}`">修改运行</a><a v-if="a.auditRun" :href="`#/runs/${a.auditRun}`">抽检运行</a></div>
            </details>
          </article>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.quality { min-width: 0; }
.err { color: var(--danger); }
.block { display: grid; gap: 8px; margin-bottom: 32px; min-width: 0; }
.block .section-title { margin: 0; }
.lead { margin: 0; font-size: 14px; }
.bad { color: var(--danger); }
.figures { width: 100%; border-collapse: collapse; font-size: 13px; font-variant-numeric: tabular-nums; }
.figures th, .figures td { padding: 7px 8px; text-align: right; border-bottom: 1px solid var(--line); white-space: nowrap; }
.figures thead th { font-size: 12px; font-weight: 500; color: var(--muted); }
.figures th:first-child { text-align: left; white-space: normal; font-weight: 400; padding-left: 0; }
.pcell { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; }
.pname { overflow-wrap: anywhere; }
.list-rows { display: grid; border-top: 1px solid var(--line); }
.audit { display: grid; gap: 4px; padding: 10px 0; border-bottom: 1px solid var(--line); min-width: 0; }
.a-head { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.a-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; }
.a-head .badge, .a-head time { flex: none; }
.a-meta, .a-reason { margin: 0; overflow-wrap: anywhere; }
.same { color: var(--warn); }
details summary { cursor: pointer; color: var(--accent); width: fit-content; }
details[open] { display: grid; gap: 8px; }
details p { margin: 0; }
.finding { display: grid; gap: 4px; padding: 8px 0; border-top: 1px dashed var(--line); min-width: 0; overflow-wrap: anywhere; }
blockquote { margin: 0; padding-left: 12px; border-left: 2px solid var(--line); }
@media (max-width: 640px) {
  .figures .opt { display: none; }
  .figures th, .figures td { padding: 7px 4px; }
}
</style>
