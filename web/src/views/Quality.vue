<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { get, onServerEvent, post } from "../api";
import Skeleton from "../components/Skeleton.vue";
import Markdown from "../components/Markdown.vue";
import RichText from "../components/RichText.vue";
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
const off = onServerEvent((e) => { if (e.type === "run" && e.runId === runId.value) void load(); });
onBeforeUnmount(() => { request++; off(); });
</script>

<template>
  <div class="page quality stack">
    <div class="page-head row wrap"><h1 class="grow">每晚抽检</h1><a href="#/settings?tab=agents">抽检设置</a><button class="btn primary" :disabled="busy" @click="audit">{{ busy ? '正在排队…' : '现在抽检' }}</button></div>
    <p v-if="error" role="alert">{{ error }} <button class="btn sm" @click="load">重试</button></p>
    <p v-if="notice" role="status">{{ notice }} <a v-if="runId" :href="`#/runs/${runId}`">查看运行</a></p>
    <Skeleton v-if="!data && !error" :rows="5" />
    <template v-if="data">
      <p>近 {{ data.settings.days }} 天抽检 {{ totals?.audited }} 页，{{ totals?.wrong }} 页有事实问题；还有 {{ data.waiting }} 页等着抽</p>
      <div v-if="data.pipelines.length" class="figures" tabindex="0" aria-label="按运行类型统计，可横向滚动">
        <table><thead><tr><th>页面来源 / 定级</th><th>抽检</th><th>没问题</th><th>只有写法问题</th><th>不对</th><th>没核完</th><th>准确率</th></tr></thead>
          <tbody><tr v-for="p in data.pipelines" :key="p.pipeline"><th>{{ p.pipeline === "level" ? "定级" : (runKindLabel[p.pipeline] ?? p.pipeline) }} <span v-if="p.flagged" class="badge danger">加严：每页都看</span></th><td>{{ p.audited }}</td><td>{{ p.ok }}</td><td>{{ p.style }}</td><td>{{ p.wrong }}</td><td>{{ p.unchecked }}</td><td>{{ p.accuracy === null ? '—' : `${Math.round(p.accuracy * 100)}%` }}</td></tr></tbody>
        </table>
      </div>
      <p class="muted small">比例按核完的页面计算，只有写法问题也计入没有事实问题；没核完的不计入。定级单列，准确率按判对 /（判对 + 判错）计算，不自动加严。</p>
      <h2>最近抽检</h2>
      <p v-if="!data.recent.length" class="muted">还没有抽检过；每晚 05:10 会从助手自己写的页面里抽几页（设置里可改）</p>
      <article v-for="a in data.recent" :key="a.id" class="card pad stack">
        <div class="row wrap"><a class="grow" :href="a.category === 'level' ? (a.target.startsWith('level-source:') ? `#/sources/${a.target.slice(13)}` : '#/sources?review=1') : `#/wiki/${encodeURIComponent(a.spaceId)}/${a.target.split('/').map(encodeURIComponent).join('/')}`">{{ a.title ?? a.target }}</a><span class="badge" :class="{ danger: a.verdict === 'wrong' }">{{ a.category === "level" && a.verdict === "wrong" ? "定级不对" : (verdicts[a.verdict] ?? a.verdict) }}</span><time class="muted small">{{ fmtTime(a.at) }}</time></div>
        <p class="small">{{ a.category === "level" ? "定级" : "写作" }}：{{ runKindLabel[a.pipeline] ?? a.pipeline }} · {{ a.writerAi || '未记录 AI' }}<br>核对：{{ a.checkerAi || '未记录 AI' }} <span v-if="a.writerAi && a.writerAi === a.checkerAi" class="badge">和写的是同一个模型</span></p>
        <p v-if="a.reviewReason" class="small">{{ a.suggestedLevel ? `建议级别：${levelLabels[a.suggestedLevel] ?? a.suggestedLevel}。` : "" }}<RichText :text="a.reviewReason" :space="a.spaceId" /></p>
        <p class="small muted">抽到原因：{{ a.why }}</p>
        <details v-if="a.findings.length"><summary>{{ a.findings.length }} 个问题</summary><div v-for="(f, i) in a.findings" :key="i" class="finding stack"><strong>{{ findingKinds[f.kind] ?? f.kind }}</strong><blockquote><Markdown :source="f.quote" :space="a.spaceId" compact /></blockquote><RichText tag="p" :text="f.problem" :space="a.spaceId" breaks /><p class="small">依据：<RichText :text="f.basis" :space="a.spaceId" /></p><p v-if="f.fix" class="small">建议：<RichText :text="f.fix" :space="a.spaceId" /></p></div></details>
        <div class="row wrap small"><a v-if="a.fixRun" :href="`#/runs/${a.fixRun}`">查看修改运行</a><a v-if="a.auditRun" :href="`#/runs/${a.auditRun}`">查看抽检运行</a></div>
      </article>
    </template>
  </div>
</template>

<style scoped>
.quality { max-width: 1100px; margin: 0 auto; min-width: 0; }
.quality article, .quality a, .finding { min-width: 0; overflow-wrap: anywhere; }
.figures { max-width: 100%; overflow-x: auto; }
table { width: 100%; min-width: 760px; border-collapse: collapse; font-size: 13px; }
th, td { padding: 10px; text-align: left; border-bottom: 1px solid var(--line); }
th { font-weight: 500; }
.finding { padding: 12px 0; border-bottom: 1px solid var(--line); }
blockquote { margin: 0; padding-left: 12px; border-left: 2px solid var(--line); }
</style>
