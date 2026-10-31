<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { get, post, put } from "../api";
import { confirmDialog, promptDialog } from "../lib/dialog";
import Markdown from "./Markdown.vue";
import UiSegmented from "./UiSegmented.vue";
import UiCheckbox from "./UiCheckbox.vue";
import { relTime, toast } from "../store";
import { refAction } from "../lib/refs";
import { findingMarkdown } from "../lib/findingText";
import { clearFixDraft, clearQuotes, draftReview, fixDraft, quotesOf, quotesText } from "../lib/quotes";
import NextRoundReview from "./NextRoundReview.vue";
import { decisionOf, findingWhere, fixLabel, pointCount, reviewAi, settled, severityCounts, SEV, suggestionOf, type Decision, type Finding, type FixInfo, type LatestState, type Review, type Reviews } from "../lib/reviews";

/**
 * The run page's “概览” for a coding delegation or branch review: the verdict and review-lead's
 * summary, one line per check, the change request, and the problems to deal with. When the review
 * waits for the owner (a plan to confirm, or a stop) the decision is answered here.
 */
// `branchWork`: a delegation on work branches, whose rounds are commits already (nothing to apply first).
// `stay`: shown inside another page (the requirements page), which follows the next round itself (`started`).
const props = defineProps<{ rv: Reviews; runId: string; reviewText?: string; branchReview?: boolean; branchWork?: boolean; canFix?: boolean; stay?: boolean }>();
const emit = defineEmits<{ ask: [context: { quote: string; label: string; text?: string }]; go: [tab: "review" | "change"]; started: [runId: string]; open: [runId: string] }>();

const STATE: Record<string, string> = { accepted: "要改", rejected: "已驳回", merged: "已合并" };
const STOP: Record<string, string> = {
  "auto-limit": "到了这一档的自动修改轮数上限",
  "not-converging": "这一轮要改的问题不比上一轮少，修改没有收敛",
  stalemate: "同一个问题连续两轮修改后仍被报出",
  escalated: "评审负责人判断是需求或方案上的分歧",
};
const rv = props.rv;
const current = rv.current;
const headline = computed(() => {
  const c = current.value;
  if (!c || !rv.verdict.value) return "";
  if (c.verdict === "approved") return props.branchReview ? "可以合并" : "可以应用";
  if (c.verdict === "changes-requested") return c.stop ? "停下来等你决定" : "需要修改";
  return "";
});
const lastAt = computed(() => rv.reviews.value.reduce((t, r) => (r.created_at > t ? r.created_at : t), ""));

// “待处理”: every finding the owner still has a call on (to fix, put off, or not yet decided) and
// whatever is set to be fixed; behind “全部” only what review-lead rejected or merged and the hints
// nobody asked to fix.
const quiet = (f: Finding) => settled(f) || !!fixOf(f) || (f.severity === "nit" && decisionOf(f) !== "fix");

// ---- later work on the branch (review-fix.ts fixed_by / newerWork) ----
// A finding handed to a later fix shows how that fix stands instead of “open”; an older review also
// names the newest code on the branch, which questions and fixes from here use.
const fixedBy = ref<Record<string, FixInfo>>({});
const newer = ref<LatestState["newer"]>(null);
async function loadLatest(ids: string[]) {
  const states = await Promise.all(ids.map((id) => get<LatestState>(`/api/runs/${id}/latest-state`).catch(() => null)));
  for (const s of states) if (s) fixedBy.value = { ...fixedBy.value, ...s.fixedBy };
  return states;
}
watch(() => props.runId, async (id) => {
  fixedBy.value = {};
  newer.value = null;
  newer.value = (await loadLatest([id]))[0]?.newer ?? null;
}, { immediate: true });
/** The later fix a finding was handed to, while it counts (a discarded one does not). */
const fixOf = (f: Finding) => {
  const i = f.fixed_by ? fixedBy.value[f.fixed_by] : undefined;
  return i && !i.discarded ? i : null;
};
function openWork(id: string) {
  if (props.stay) emit("open", id);
  else router.push(`/runs/${id}`);
}
const NEWER_STATUS: Record<string, string> = { queued: "排队中", running: "进行中", done: "已完成", failed: "失败", cancelled: "已停止" };

// ---- other reviews of the same branch (another AI's review of it, an earlier delegation on it) ----
// Their findings can be shown here and fixed in the same round (review-fix.ts sameBranchWork).
type Source = { runId: string; title: string; label: string };
type Row = Finding & { check: string; fromRound?: number; source?: Source };
const others = ref<{ rootId: string; latestId: string; title: string; branchReview: boolean }[]>([]);
const withOthers = ref(false);
const otherFindings = ref<Row[]>([]);
const loadingOthers = ref(false);
watch(() => props.runId, async (id) => {
  others.value = [];
  withOthers.value = false;
  otherFindings.value = [];
  if (!props.canFix) return;
  others.value = await get<typeof others.value>(`/api/runs/${id}/same-branch`).catch(() => []);
}, { immediate: true });
watch(withOthers, async (on) => {
  if (!on || otherFindings.value.length) return;
  loadingOthers.value = true;
  try {
    const lists = await Promise.all(others.value.map(async (o) => {
      const d = await get<{ rounds: { round: number }[]; reviews: Review[]; labels: Record<string, string> }>(`/api/runs/${o.latestId}/reviews`);
      const last = d.rounds.at(-1)?.round;
      return d.reviews.filter((r) => r.round === last).flatMap((r) => r.findings.map((f): Row => ({ ...f, check: r.check_name, source: { runId: o.latestId, title: o.title, label: d.labels[r.check_name] ?? r.check_name } })));
    }));
    otherFindings.value = lists.flat();
    await loadLatest(others.value.map((o) => o.latestId));
  } catch (e) {
    toast((e as Error).message, "error");
    withOthers.value = false;
  } finally {
    loadingOthers.value = false;
  }
});
const allFindings = computed<Row[]>(() => [...rv.findings.value, ...(withOthers.value ? otherFindings.value : [])]);
const checkLabel = (f: Row) => f.source?.label ?? rv.label(f.check);
const runOf = (f: Row) => f.source?.runId ?? props.runId;
/** A finding's copies here (every round's copy of an own one, or the other review's). */
function patchFinding(f: Row, fields: Partial<Finding>) {
  if (f.source) return void Object.assign(f, fields);
  for (const r of rv.data.value?.reviews ?? []) for (const x of r.findings) if (x.id === f.id) Object.assign(x, fields);
}
// The owner says a finding was already taken care of by later work on the branch (or takes that back).
const marking = ref<number | null>(null);
async function markFixed(f: Row, by: string | null) {
  marking.value = f.id;
  try {
    await put(`/api/runs/${runOf(f)}/findings-fixed`, { ids: [f.id], by });
    if (by && !fixedBy.value[by]) await loadLatest([runOf(f)]);
    patchFinding(f, { fixed_by: by });
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    marking.value = null;
  }
}
const filter = ref<"open" | "all">("open");
const openCount = computed(() => allFindings.value.filter((f) => !quiet(f)).length);
const quietCount = computed(() => allFindings.value.length - openCount.value);
const filterOptions = computed(() => [{ value: "open" as const, label: `待处理 ${openCount.value}` }, { value: "all" as const, label: `全部 ${allFindings.value.length}` }]);
const shown = computed(() => (filter.value === "all" ? allFindings.value : allFindings.value.filter((f) => !quiet(f))));
const open = ref(new Set<number>());
const toggle = (id: number) => { const n = new Set(open.value); n.has(id) ? n.delete(id) : n.add(id); open.value = n; };
const rawOpen = ref(false);
const reasonsOpen = ref(false);
const changeOpen = ref(false);

function askAbout(f: Row, rewrite = false) {
  emit("ask", {
    quote: [`#${f.id} [${SEV[f.severity].text}] ${f.title}`, findingWhere(f), f.detail, suggestionOf(f) ? `建议：${suggestionOf(f)}` : ""].filter(Boolean).join("\n"),
    label: `${f.source ? "另一份评审 · " : ""}${checkLabel(f)}评审的问题`,
    ...(rewrite ? { text: `这条问题我看不懂。请读相关代码（是迁移的话也读源实现），确认问题是否成立，然后用 revise_finding（run_id ${runOf(f)}，finding_id ${f.id}）重新描述：标题说清什么情况下、哪里、出了什么错；正文分“现在的实现 / 源实现 / 触发条件 / 问题”，每点后面带代码引用。不成立就在正文里写明。` } : {}),
  });
}
/** Evidence the detail does not already cite inline. */
const extraEvidence = (f: Row) => f.evidence.filter((e) => !f.detail.includes(e.replace(/^`|`$/g, "").split("#")[0]));
/** The reviewer's first wording of a finding someone re-described (revise_finding). */
function originalOf(f: Row): { title: string; detail: string } | null {
  if (!f.revised) return null;
  try { return JSON.parse(f.revised) as { title: string; detail: string }; } catch { return null; }
}

// ---- what to fix: each finding's call, then the fix with the owner's own additions ------------
const DECISIONS = [{ value: "fix" as const, label: "改" }, { value: "later" as const, label: "暂不改" }, { value: "wontfix" as const, label: "不改" }];
const latestRound = computed(() => rv.round.value === (rv.data.value?.rounds.at(-1)?.round ?? rv.round.value));
const deciding = computed(() => !!props.canFix && latestRound.value);
async function decide(f: Row, d: Decision) {
  let note = "";
  if (d === "wontfix") {
    const why = await promptDialog("为什么不改？", { message: "写业务上的决定（如“运营确认存量工具不需要重新裁剪”）。会记到事项上，之后的评审不再提这个问题。", value: f.decision_note, placeholder: "理由", okText: "不改" });
    if (!why?.trim()) return;
    note = why.trim();
  }
  try {
    await put(`/api/runs/${runOf(f)}/findings/${f.id}`, { decision: d, note });
    // Every round's copy: a carried “暂不改” lives in an earlier round's review.
    patchFinding(f, { decision: d, decision_note: note });
  } catch (e) {
    toast((e as Error).message, "error");
  }
}
// The owner rewrites a suggestion in place, so the coder acts on that instead of the reviewer's wording.
const editingSug = ref<number | null>(null);
const sugText = ref("");
const savingSug = ref(false);
function editSug(f: Finding) {
  editingSug.value = f.id;
  sugText.value = suggestionOf(f);
}
async function saveSug(f: Row, text = sugText.value) {
  if (savingSug.value) return;
  savingSug.value = true;
  try {
    const r = await put<{ ownerSuggestion: string | null; decision: Decision | null }>(`/api/runs/${runOf(f)}/findings/${f.id}/suggestion`, { text });
    patchFinding(f, { owner_suggestion: r.ownerSuggestion, decision: r.decision });
    editingSug.value = null;
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    savingSug.value = false;
  }
}
const tally = computed(() => {
  const t = { fix: 0, later: 0, wontfix: 0 };
  for (const f of allFindings.value) if (!fixOf(f)) t[decisionOf(f)]++;
  return t;
});
// The text and the next rounds' review survive switching tabs (lib/quotes.ts keeps them per run).
const draft = computed(() => fixDraft(props.runId));
const starting = ref(false);
const router = useRouter();
// Passages the owner selected on the page (“加入修改点”) go along with the findings and the extra text.
const picked = computed(() => quotesOf(props.runId, "fix"));
// `applyFirst`: what is done now goes to the target branch (uncommitted) before the next round, which goes on in the same worktree.
async function startFix(applyFirst = false) {
  // A finding already handed to later work on the branch is not sent again.
  const ids = allFindings.value.filter((f) => decisionOf(f) === "fix" && !fixOf(f)).map((f) => f.id);
  const text = [quotesText(picked.value, "本人在页面上选中、要求修改的地方（按 [1]、[2] 编号）："), draft.value.text.trim()].filter(Boolean).join("\n\n");
  if (starting.value || (!ids.length && !text)) return;
  if (applyFirst && !(await confirmDialog("先应用到原分支，再接着改？", { message: "现在的改动先写进原目标分支（未提交，可以在运行页提交）；下一轮在同一个工作区接着改，之后再应用只带新的改动。", okText: "应用并接着改" }))) return;
  starting.value = true;
  try {
    const r = await post<{ id: string }>(`/api/runs/${props.runId}/fix`, { findingIds: ids, text: text || undefined, ...draftReview(draft.value), ...(applyFirst ? { applyFirst: true } : {}), ...(withOthers.value ? { withSameBranch: true } : {}) });
    clearFixDraft(props.runId);
    clearQuotes(props.runId, "fix");
    toast(props.branchReview ? "已基于这个分支交办修改" : "已安排下一轮修改", "ok");
    if (props.stay) emit("started", r.id);
    else router.push(`/runs/${r.id}`);
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    starting.value = false;
  }
}

// ---- the owner's decision -------------------------------------------------------------------
// The finished review's card is for Feishu; here the page's own controls (decisions, fix box, apply) do the same.
const pendingAsk = computed(() => (current.value?.ask?.status === "pending" && current.value.ask.handler !== "review-done" ? current.value.ask : null));
const reply = ref("");
const answering = ref(false);
async function answer(choice: number | null) {
  const a = pendingAsk.value;
  if (!a || answering.value || (choice === null && !reply.value.trim())) return;
  answering.value = true;
  try {
    await post(`/api/asks/${a.id}/answer`, choice === null ? { text: reply.value.trim() } : { choice });
    reply.value = "";
    toast("已记下你的决定", "ok");
    await rv.load(true);
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    answering.value = false;
  }
}
</script>

<template>
  <section v-if="rv.data.value && (rv.reviews.value.length || current?.plan || rv.data.value.estimate)" class="block review">
    <div v-if="pendingAsk" class="card pad decide stack">
      <div class="row"><span class="badge accent">{{ current?.verdict === "awaiting-plan" ? "确认评审计划" : "停下来等你决定" }}</span></div>
      <p class="q">{{ pendingAsk.question }}</p>
      <div class="row wrap">
        <button v-for="(o, i) in pendingAsk.options" :key="i" class="btn sm" :class="{ primary: i === 0 }" :disabled="answering" @click="answer(i)">{{ o.label }}</button>
      </div>
      <div class="row">
        <input v-model="reply" class="input sm grow" :placeholder="current?.verdict === 'awaiting-plan' ? '或者补充一句要求，按计划开始' : '或者直接写新的要求，作为下一轮的任务'" aria-label="回复" @keydown.enter="answer(null)" />
        <button class="btn sm" :disabled="answering || !reply.trim()" @click="answer(null)">发送</button>
      </div>
    </div>

    <!-- While the plan waits for the owner, the question above already lists the tier, checks and reasons. -->
    <div v-if="!(pendingAsk && current?.verdict === 'awaiting-plan')" class="card pad summary">
      <div class="head row wrap">
        <span v-if="rv.verdict.value" class="badge" :class="rv.verdict.value.cls">{{ rv.verdict.value.text }}</span>
        <strong v-if="headline" class="headline">{{ headline }}</strong>
        <span v-if="current?.plan" class="muted small">「{{ current.plan.tierName }}」档 · 第 {{ current.round }} 轮 · {{ current.plan.checks.length }} 项评审<template v-if="current.lead?.by === 'lead' && lastAt"> · 负责人汇总于 {{ relTime(lastAt) }}</template></span>
        <span class="spacer" />
        <button v-if="rv.reviews.value.length" class="lnk small" @click="emit('go', 'review')">每项的完整过程 →</button>
      </div>
      <p v-if="current?.lead?.summary" class="lead-summary">{{ current.lead.summary }}</p>
      <p v-if="current?.stop" class="stop small">停下来的原因：{{ STOP[current.stop] ?? current.stop }}</p>
      <p v-if="current?.lead?.escalation && !pendingAsk" class="small esc">{{ current.lead.escalation.summary }}</p>

      <div v-if="rv.reviews.value.length" class="checks">
        <div v-for="r in rv.reviews.value" :key="r.id" class="check-row">
          <span class="st" :class="r.verdict" :title="r.verdict" />
          <strong>{{ rv.label(r.check_name) }}</strong>
          <span class="muted small ellipsis" :title="r.summary">{{ r.verdict === "failed" ? `没有完成：${r.summary}` : r.summary.split("\n")[0] }}</span>
          <span class="row sev"><span v-for="c in severityCounts(r)" :key="c.s" class="badge" :class="SEV[c.s].cls">{{ SEV[c.s].text }} {{ c.n }}</span><span v-if="!severityCounts(r).length && r.verdict === 'approved'" class="badge">无问题</span></span>
          <span class="muted small mono ai">{{ reviewAi(r) }}</span>
        </div>
      </div>

      <div class="foot row wrap small">
        <button v-if="current?.plan?.reasons.length || rv.data.value.estimate" class="lnk" :aria-expanded="reasonsOpen" @click="reasonsOpen = !reasonsOpen">为什么是这一档</button>
        <button v-if="current?.lead?.changeRequest" class="lnk" :aria-expanded="changeOpen" @click="changeOpen = !changeOpen">修改单</button>
        <button v-if="rv.changePoints.value.length" class="lnk" @click="emit('go', 'change')">{{ pointCount(rv.changePoints.value) }} 个变更点 →</button>
        <span v-if="current?.lead?.verdict === 'revise' && current.lead.rerun.length && current.lead.by === 'lead'" class="muted">下一轮复审：{{ current.lead.rerun.map(rv.label).join("、") }}</span>
        <span class="spacer" />
        <button v-if="reviewText" class="lnk" @click="rawOpen = !rawOpen">{{ rawOpen ? "收起评审原文" : "评审原文" }}</button>
      </div>
      <ul v-if="reasonsOpen" class="reasons muted small">
        <li v-if="rv.data.value.estimate && rv.round.value === rv.data.value.rounds[0]?.round">编码前预估「{{ rv.data.value.estimate.tierName }}」档：{{ rv.data.value.estimate.reason }}</li>
        <li v-for="(r, i) in current?.plan?.reasons ?? []" :key="i">{{ r }}</li>
      </ul>
      <div v-if="changeOpen && current?.lead?.changeRequest" class="sub" data-ask-label="修改单"><Markdown :source="current.lead.changeRequest" /></div>
      <div v-if="rawOpen && reviewText" class="sub"><Markdown :source="reviewText" /></div>
    </div>

    <div v-if="newer" class="row wrap newer small">
      <span>这个分支后来有更新的编码：</span>
      <a href="#" @click.prevent="openWork(newer.rootId)">{{ newer.title }}</a>
      <span class="muted">（{{ newer.applied ? "已应用到分支" : NEWER_STATUS[newer.status] ?? newer.status }}）</span>
      <span class="muted">这里提问、开始修改都按它的代码；已在那边改了的问题，展开后点“已在新编码里改了”。</span>
    </div>
    <div v-if="allFindings.length || (deciding && others.length)" class="card pad findings">
      <div class="row wrap"><div class="section-title flat">待处理问题</div><span class="spacer" /><UiSegmented v-model="filter" size="sm" :options="filterOptions" aria-label="显示哪些问题" /></div>
      <div v-if="deciding && others.length" class="row wrap others small">
        <UiCheckbox v-model="withOthers" size="sm">一起看同一分支的其他评审（{{ others.length }} 份）</UiCheckbox>
        <span class="muted ellipsis" :title="others.map((o) => o.title).join('\n')">{{ others.map((o) => o.title).join("、") }}</span>
        <span v-if="loadingOthers" class="muted">读取中…</span>
        <span v-else-if="withOthers" class="muted">勾上的问题和这份评审的一起改，开一次修改</span>
      </div>
      <p v-if="!shown.length" class="muted small">没有要处理的问题。</p>
      <p v-if="filter === 'open' && quietCount" class="muted small">另有 {{ quietCount }} 个已交给后来的修改、已驳回、已合并或只是提示的，在“全部”里。</p>
      <div v-for="f in shown" :key="f.id" class="finding" :class="{ dim: quiet(f) }">
        <div class="row line1">
          <span class="badge" :class="SEV[f.severity].cls">{{ SEV[f.severity].text }}</span>
          <button class="title" :aria-expanded="open.has(f.id)" @click="toggle(f.id)">{{ f.title }}</button>
          <span v-if="STATE[f.state]" class="badge" :class="{ warn: f.state === 'accepted' }">{{ STATE[f.state] }}</span>
          <span v-if="f.owner_suggestion" class="badge accent" title="建议按你改写的执行">建议已改</span>
          <a v-if="fixOf(f)" href="#" class="badge ok" :title="`交给了「${fixOf(f)!.title}」`" @click.prevent="openWork(fixOf(f)!.rootId)">{{ fixLabel(fixOf(f)!) }}</a>
          <span class="spacer" />
          <span v-if="f.source" class="badge" :title="f.source.title">另一份评审</span>
          <span class="muted small nowrap">{{ f.fromRound ? `第 ${f.fromRound} 轮 · ` : "" }}{{ checkLabel(f) }} · #{{ f.id }}</span>
          <UiSegmented v-if="deciding && !fixOf(f)" :model-value="decisionOf(f)" class="decide-f" size="sm" :options="DECISIONS" :aria-label="`#${f.id} 怎么处理`" @change="(d) => decide(f, d)" />
        </div>
        <div v-if="f.decision === 'wontfix' && f.decision_note" class="small wontfix">不改：{{ f.decision_note }}</div>
        <div v-if="findingWhere(f) || f.triage_note || f.merged_into" class="line2 small">
          <a v-if="findingWhere(f)" href="#" class="loc mono" title="打开这段代码" @click.prevent="refAction(findingWhere(f), runOf(f))?.()">{{ findingWhere(f) }}</a>
          <span v-if="f.triage_note || f.merged_into" class="muted">负责人：{{ f.merged_into ? `合并到 #${f.merged_into}` : "" }}{{ f.merged_into && f.triage_note ? "；" : "" }}{{ f.triage_note }}</span>
        </div>
        <div v-if="open.has(f.id)" class="more small">
          <Markdown v-if="f.detail" class="fd" :source="findingMarkdown(f.detail)" :run-id="runOf(f)" breaks />
          <p v-if="extraEvidence(f).length" class="muted">{{ f.detail ? "其他依据" : "依据" }}：<template v-for="(e, i) in extraEvidence(f)" :key="i"><a v-if="refAction(e, runOf(f))" href="#" class="mono" @click.prevent="refAction(e, runOf(f))!()">{{ e }}</a><span v-else class="mono">{{ e }}</span>{{ i < extraEvidence(f).length - 1 ? "、" : "" }}</template></p>
          <details v-if="originalOf(f)" class="orig"><summary class="muted">评审原来的描述</summary><p class="muted"><strong>{{ originalOf(f)!.title }}</strong></p><Markdown class="fd muted" :source="findingMarkdown(originalOf(f)!.detail)" :run-id="runOf(f)" breaks /></details>
          <div v-if="editingSug === f.id" class="sug-edit">
            <textarea v-model="sugText" class="textarea" rows="4" :aria-label="`改写 #${f.id} 的建议`" placeholder="写清楚要怎么改；下一轮按这段改，不再看评审的原建议" @keydown.esc.stop="editingSug = null" />
            <div class="row wrap">
              <button class="btn primary sm" :disabled="savingSug || !sugText.trim()" @click="saveSug(f)">保存</button>
              <button class="btn ghost sm" @click="editingSug = null">取消</button>
              <button v-if="f.owner_suggestion" class="btn ghost sm" :disabled="savingSug" @click="saveSug(f, '')">恢复原建议</button>
              <span class="muted">{{ f.decision ? "" : "保存后这条标为“改”。" }}</span>
            </div>
          </div>
          <template v-else>
            <div v-if="suggestionOf(f)" class="sug"><strong>建议{{ f.owner_suggestion ? "（你改过）" : "" }}：</strong><Markdown class="fd" :source="findingMarkdown(suggestionOf(f))" :run-id="runOf(f)" breaks /></div>
            <details v-if="f.owner_suggestion && f.suggestion" class="orig"><summary class="muted">评审的原建议</summary><Markdown class="fd muted" :source="findingMarkdown(f.suggestion)" :run-id="runOf(f)" breaks /></details>
          </template>
          <div class="row wrap">
            <button v-if="deciding && editingSug !== f.id" class="btn ghost sm" @click="editSug(f)">{{ suggestionOf(f) ? "改建议" : "写建议" }}</button>
            <button class="btn ghost sm" @click="askAbout(f)">就这条提问</button>
            <button class="btn ghost sm" title="让助手读代码（迁移的也读源实现）后重写这条：现在的实现、触发条件、问题，引用写在正文里" @click="askAbout(f, true)">看不懂，重新描述</button>
            <button v-if="newer && !fixOf(f)" class="btn ghost sm" :disabled="marking === f.id" :title="`标为已在「${newer.title}」里改了`" @click="markFixed(f, newer.latestId)">已在新编码里改了</button>
            <button v-if="f.fixed_by" class="btn ghost sm" :disabled="marking === f.id" @click="markFixed(f, null)">{{ fixOf(f) ? "不算已改" : "清除" }}</button>
          </div>
        </div>
      </div>
    </div>

    <div v-if="deciding" class="card pad fix">
      <div class="row wrap">
        <div class="section-title flat">{{ branchReview ? "按评审修改这个分支" : "再改一轮" }}</div>
        <span class="spacer" />
        <span class="muted small">要改 {{ tally.fix }} · 暂不改 {{ tally.later }} · 不改 {{ tally.wontfix }}</span>
      </div>
      <textarea v-model="draft.text" class="textarea" rows="3" placeholder="补充要求（可选）：需求变化、评审没发现的问题、实现上的约束" aria-label="补充要求" />
      <p v-if="picked.length" class="muted small">另有 {{ picked.length }} 处选中加入的修改点（右下角“修改点”里查看），会一起交给编码 Agent。</p>
      <div class="row wrap actions">
        <NextRoundReview :draft="draft" />
        <span class="spacer" />
        <button v-if="!branchReview && !branchWork" class="btn sm" title="现在的改动先写进原分支（未提交），下一轮在同一个工作区接着改" :disabled="starting || (!tally.fix && !draft.text.trim() && !picked.length)" @click="startFix(true)">先应用再接着改</button>
        <button class="btn primary sm" :disabled="starting || (!tally.fix && !draft.text.trim() && !picked.length)" @click="startFix()">开始修改{{ tally.fix || picked.length ? `（${[tally.fix ? `${tally.fix} 个问题` : "", picked.length ? `${picked.length} 处修改点` : "", draft.text.trim() ? "补充" : ""].filter(Boolean).join(" + ")}）` : "" }}</button>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* One shrinkable column: a long unbroken line (a check summary, a path) must not widen the page. */
.review { display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px; }
.flat { margin: 0; }
.decide { border-color: var(--accent); }
.decide .q { margin: 0; white-space: pre-wrap; }
.summary { display: grid; grid-template-columns: minmax(0, 1fr); gap: 10px; }
.head { gap: 10px; }
.headline { font-size: 16px; }
.lead-summary { margin: 0; line-height: 1.65; }
.stop { margin: 0; color: var(--warn); }
.esc { margin: 0; white-space: pre-wrap; }
.checks { display: grid; grid-template-columns: minmax(0, 1fr); }
.check-row { display: grid; grid-template-columns: 10px 64px minmax(0, 1fr) auto auto; gap: 10px; align-items: center; padding: 9px 0; border-top: 1px solid var(--line); }
.sev { gap: 4px; }
.ai { white-space: nowrap; }
.st { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
.st.approved { background: var(--ok); }
.st.changes_requested { background: var(--warn); }
.st.failed { background: var(--danger); }
.foot { gap: 14px; border-top: 1px solid var(--line); padding-top: 8px; }
.reasons { margin: 0; padding-left: 18px; }
.sub { border-top: 1px solid var(--line); padding-top: 10px; }
.lnk { border: 0; background: none; padding: 0; font: inherit; color: var(--accent); cursor: pointer; }
.lnk:hover { text-decoration: underline; }
.findings { display: grid; grid-template-columns: minmax(0, 1fr); gap: 0; }
.finding { border-top: 1px solid var(--line); padding: 10px 0; display: grid; grid-template-columns: minmax(0, 1fr); gap: 4px; }
.findings > .row + .finding, .findings > .row + p + .finding { border-top-color: var(--line); }
.line1 { gap: 8px; min-width: 0; }
.line2 { display: flex; flex-wrap: wrap; gap: 4px 12px; }
.nowrap { white-space: nowrap; }
.finding.dim .title { color: var(--ink-2); font-weight: 450; }
.title { border: 0; background: none; padding: 0; font: inherit; font-weight: 600; color: var(--ink); cursor: pointer; text-align: left; min-width: 0; }
.title:hover { color: var(--accent); }
.loc { color: var(--accent); overflow-wrap: anywhere; }
.more { background: var(--sunken); border-radius: 8px; padding: 8px 10px; display: grid; grid-template-columns: minmax(0, 1fr); gap: 6px; }
.more p { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
/* A finding's detail and suggestion are Markdown (sections, lists, inline code links); kept at the card's size. */
.more :deep(.fd) { font-size: inherit; line-height: 1.6; overflow-wrap: anywhere; }
.more :deep(.fd > :first-child) { margin-top: 0; }
.more :deep(.fd > :last-child) { margin-bottom: 0; }
.more :deep(.fd p) { white-space: normal; margin: 4px 0; }
.more :deep(.fd ul), .more :deep(.fd ol) { margin: 2px 0 4px; padding-left: 20px; }
.more :deep(.fd pre) { max-width: 100%; overflow-x: auto; }
/* Every citation in a finding (code location, original, memory, message, bare path) reads as one kind of
   link: underlined text in the surrounding font, not the mono chips used in answers. */
.more :deep(.fd a.cite) { display: inline; font: inherit; padding: 0; margin: 0; background: none; white-space: normal; max-width: none; vertical-align: baseline; text-decoration: underline; text-underline-offset: 2px; }
.sug { display: grid; grid-template-columns: minmax(0, 1fr); gap: 2px; }
.more .btn { justify-self: start; }
.sug-edit { display: grid; gap: 6px; }
.others { gap: 8px; padding: 6px 0; }
.newer { gap: 6px; padding: 8px 12px; border-radius: 8px; background: var(--sunken); }
.others .ellipsis { min-width: 0; flex: 1 1 160px; }
.orig summary { cursor: pointer; }
.decide-f { flex: none; }
.wontfix { color: var(--ink-2); background: var(--sunken); border-radius: 6px; padding: 3px 8px; justify-self: start; }
.fix { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; }
.fix p { margin: 0; }
.actions { gap: 8px; align-items: flex-start; }
@media (max-width: 760px) {
  .check-row { grid-template-columns: 10px 52px minmax(0, 1fr) auto; }
  .ai { display: none; }
  .line1 { flex-wrap: wrap; }
}
</style>
