<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { get, post } from "../api";
import Markdown from "./Markdown.vue";
import UiSegmented from "./UiSegmented.vue";
import { toast } from "../store";

/**
 * “本次评审” of a coding delegation: which tier and why, each check's verdict, review-lead's
 * ruling on the problems they found, and — when the review waits for the owner (a plan to confirm,
 * or a stop) — the decision itself, answerable here. Raw review text stays one click away.
 */
type Finding = { id: number; severity: "blocker" | "major" | "minor" | "nit"; file_path: string | null; line: number | null; title: string; detail: string; suggestion: string; evidence: string[]; confidence: string; state: string; merged_into: number | null; triage_note: string };
type Review = { id: string; round: number; check_name: string; verdict: "approved" | "changes_requested" | "failed"; summary: string; profile_id: string | null; model: string | null; effort: string | null; findings: Finding[] };
type Lead = { verdict: "approve" | "revise" | "escalate"; summary: string; changeRequest: string; rerun: string[]; by: "lead" | "host"; stop?: string; escalation?: { summary: string } };
type AskInfo = { id: string; status: string; question: string; options: { label: string }[]; answer: string | null };
type Round = { runId: string; round: number; status: string; plan: { tier: string; tierName: string; checks: string[]; reasons: string[]; lead?: boolean } | null; verdict: string | null; stage: string | null; lead: Lead | null; stop: string | null; ask: AskInfo | null; acceptedByOwner: boolean };
const props = defineProps<{ runId: string; reviewText?: string; refreshKey?: string }>();
const emit = defineEmits<{ ask: [context: { quote: string; label: string }] }>();

const data = ref<{ estimate: { tierName: string; reason: string } | null; rounds: Round[]; reviews: Review[]; labels: Record<string, string> } | null>(null);
const round = ref(1);
let timer: ReturnType<typeof setTimeout> | undefined;
async function load(keepRound = false) {
  clearTimeout(timer);
  try {
    data.value = await get(`/api/runs/${props.runId}/reviews`);
    if (!keepRound) round.value = data.value!.rounds.find((r) => r.runId === props.runId)?.round ?? data.value!.rounds.at(-1)?.round ?? 1;
    // A review running after the coding run ended (confirmed plan) has no run of this page to follow.
    if (["queued", "checks", "lead"].includes(current.value?.stage ?? "")) timer = setTimeout(() => void load(true), 3000);
  } catch {
    data.value = null;
  }
}
watch(() => [props.runId, props.refreshKey], () => void load(), { immediate: true });
onBeforeUnmount(() => clearTimeout(timer));

const current = computed(() => data.value?.rounds.find((r) => r.round === round.value) ?? null);
const reviews = computed(() => {
  const list = (data.value?.reviews ?? []).filter((r) => r.round === round.value);
  const order = current.value?.plan?.checks ?? [];
  return [...list].sort((a, b) => order.indexOf(a.check_name) - order.indexOf(b.check_name));
});
const label = (name: string) => data.value?.labels[name] ?? name;
const SEV: Record<Finding["severity"], { text: string; cls: string }> = { blocker: { text: "阻断", cls: "danger" }, major: { text: "严重", cls: "danger" }, minor: { text: "一般", cls: "warn" }, nit: { text: "提示", cls: "" } };
const STATE: Record<string, string> = { accepted: "要改", rejected: "已驳回", merged: "已合并" };
const STOP: Record<string, string> = {
  "auto-limit": "到了这一档的自动修改轮数上限",
  "not-converging": "这一轮要改的问题不比上一轮少，修改没有收敛",
  stalemate: "同一个问题连续两轮修改后仍被报出",
  escalated: "评审负责人判断是需求或方案上的分歧",
};
const RANK = { blocker: 0, major: 1, minor: 2, nit: 3 };
const findings = computed(() => reviews.value.flatMap((r) => r.findings.map((f) => ({ ...f, check: r.check_name }))).sort((a, b) => Number(["rejected", "merged"].includes(a.state)) - Number(["rejected", "merged"].includes(b.state)) || RANK[a.severity] - RANK[b.severity]));
const showAll = ref(false);
const quiet = (f: Finding) => f.severity === "nit" || ["rejected", "merged"].includes(f.state);
const shown = computed(() => (showAll.value ? findings.value : findings.value.filter((f) => !quiet(f))));
const open = ref(new Set<number>());
const toggle = (id: number) => { const n = new Set(open.value); n.has(id) ? n.delete(id) : n.add(id); open.value = n; };
const counts = (r: Review) => (["blocker", "major", "minor", "nit"] as const).map((s) => ({ s, n: r.findings.filter((f) => f.severity === s && !["rejected", "merged"].includes(f.state)).length })).filter((x) => x.n);
const ai = (r: Review) => [r.profile_id, r.model, r.effort].filter(Boolean).join(" · ");
const where = (f: Finding) => (f.file_path ? `${f.file_path}${f.line ? `:${f.line}` : ""}` : "");
const rawOpen = ref(false);
const roundOptions = computed(() => (data.value?.rounds ?? []).map((r) => ({ value: r.round, label: `第 ${r.round} 轮` })));
const verdictOf = computed(() => {
  const c = current.value;
  if (!c) return null;
  if (["queued", "checks", "lead"].includes(c.stage ?? "")) return { text: c.stage === "lead" ? "负责人汇总中" : "评审中", cls: "accent" };
  if (c.verdict === "awaiting-plan") return { text: "计划等你确认", cls: "accent" };
  if (c.verdict === "approved") return { text: c.acceptedByOwner ? "你已接受" : "评审通过", cls: "ok" };
  if (c.stop) return { text: "等你决定", cls: "warn" };
  if (c.verdict === "changes-requested") return { text: "需要修改", cls: "warn" };
  return null;
});
function askAbout(f: Finding & { check: string }) {
  emit("ask", { quote: [`[${SEV[f.severity].text}] ${f.title}`, where(f), f.detail, f.suggestion ? `建议：${f.suggestion}` : ""].filter(Boolean).join("\n"), label: `${label(f.check)}评审的问题` });
}

// ---- the owner's decision -------------------------------------------------------------------
const pendingAsk = computed(() => (current.value?.ask?.status === "pending" ? current.value.ask : null));
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
    await load(true);
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    answering.value = false;
  }
}
</script>

<template>
  <section v-if="data && (reviews.length || current?.plan || data.estimate)" class="block">
    <div class="section-title row">本次评审<span class="spacer" /><UiSegmented v-if="roundOptions.length > 1" v-model="round" size="sm" :options="roundOptions" aria-label="轮次" /></div>

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

    <div class="card pad stack">
      <div class="row wrap">
        <span v-if="verdictOf" class="badge" :class="verdictOf.cls">{{ verdictOf.text }}</span>
        <strong v-if="current?.plan">「{{ current.plan.tierName }}」档 · {{ current.plan.checks.length }} 项评审{{ current.plan.lead ? " · 负责人协调" : "" }}</strong>
        <span class="spacer" />
        <button v-if="reviewText" class="btn ghost sm" @click="rawOpen = !rawOpen">{{ rawOpen ? "收起评审原文" : "评审原文" }}</button>
      </div>
      <ul v-if="current?.plan?.reasons.length || data.estimate" class="reasons muted small">
        <li v-if="data.estimate && round === data.rounds[0]?.round">编码前预估「{{ data.estimate.tierName }}」档：{{ data.estimate.reason }}</li>
        <li v-for="(r, i) in current?.plan?.reasons ?? []" :key="i">{{ r }}</li>
      </ul>
      <div v-if="current?.stop" class="stop small">停下来的原因：{{ STOP[current.stop] ?? current.stop }}</div>
      <div v-if="reviews.length" class="checks">
        <div v-for="r in reviews" :key="r.id" class="check-row">
          <span class="st" :class="r.verdict" :title="r.verdict" />
          <strong>{{ label(r.check_name) }}</strong>
          <span class="muted small ellipsis grow" :title="r.summary">{{ r.verdict === "failed" ? `没有完成：${r.summary}` : r.summary.split("\n")[0] }}</span>
          <span class="row sev"><span v-for="c in counts(r)" :key="c.s" class="badge" :class="SEV[c.s].cls">{{ SEV[c.s].text }} {{ c.n }}</span><span v-if="!counts(r).length && r.verdict === 'approved'" class="badge ok">通过</span></span>
          <span class="muted small mono ai">{{ ai(r) }}</span>
        </div>
      </div>
      <div v-if="current?.lead" class="lead">
        <div class="row small"><strong>{{ current.lead.by === "lead" ? "评审负责人" : "汇总" }}</strong><span class="muted">{{ current.lead.summary }}</span></div>
        <p v-if="current.lead.escalation" class="small esc">{{ current.lead.escalation.summary }}</p>
        <p v-if="current.lead.verdict === 'revise' && current.lead.rerun.length && current.lead.by === 'lead'" class="muted small">下一轮复审：{{ current.lead.rerun.map(label).join("、") }}</p>
      </div>
      <div v-if="rawOpen && reviewText" class="raw"><Markdown :source="reviewText" /></div>
    </div>

    <div v-if="findings.length" class="card pad">
      <div class="row"><div class="section-title flat">问题</div><span class="spacer" /><button v-if="findings.some(quiet)" class="btn ghost sm" @click="showAll = !showAll">{{ showAll ? "只看要处理的" : `全部（${findings.length}）` }}</button></div>
      <div v-for="f in shown" :key="f.id" class="finding" :class="{ dim: quiet(f) }">
        <div class="row wrap">
          <span class="badge" :class="SEV[f.severity].cls">{{ SEV[f.severity].text }}</span>
          <button class="title" :aria-expanded="open.has(f.id)" @click="toggle(f.id)">{{ f.title }}</button>
          <span v-if="STATE[f.state]" class="badge" :class="{ warn: f.state === 'accepted' }">{{ STATE[f.state] }}</span>
          <span class="spacer" />
          <span class="muted small">{{ label(f.check) }} · #{{ f.id }}</span>
        </div>
        <div v-if="where(f)" class="loc mono small">{{ where(f) }}</div>
        <div v-if="f.triage_note || f.merged_into" class="muted small">负责人：{{ f.merged_into ? `合并到 #${f.merged_into}` : "" }}{{ f.merged_into && f.triage_note ? "；" : "" }}{{ f.triage_note }}</div>
        <div v-if="open.has(f.id)" class="more small">
          <p v-if="f.detail">{{ f.detail }}</p>
          <p v-if="f.suggestion"><strong>建议：</strong>{{ f.suggestion }}</p>
          <p v-if="f.evidence.length" class="muted">依据：{{ f.evidence.join("、") }}</p>
          <button class="btn ghost sm" @click="askAbout(f)">就这条提问</button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.flat { margin: 0; }
.reasons { margin: 0; padding-left: 18px; }
.decide { border-color: var(--accent); }
.decide .q { margin: 0; white-space: pre-wrap; }
.stop { color: var(--warn); }
.checks { display: grid; }
.check-row { display: grid; grid-template-columns: 10px 56px minmax(0, 1fr) auto auto; gap: 10px; align-items: center; padding: 8px 0; border-top: 1px solid var(--line); }
.check-row:first-child { border-top: 0; }
.grow { min-width: 0; flex: 1; }
.sev { gap: 4px; }
.ai { white-space: nowrap; }
.st { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
.st.approved { background: var(--ok); }
.st.changes_requested { background: var(--warn); }
.st.failed { background: var(--danger); }
.lead { border-top: 1px solid var(--line); padding-top: 10px; display: grid; gap: 4px; }
.lead p { margin: 0; }
.esc { white-space: pre-wrap; }
.raw { border-top: 1px solid var(--line); padding-top: 10px; }
.finding { border-top: 1px solid var(--line); padding: 9px 0; display: grid; gap: 4px; }
.finding:first-of-type { border-top: 0; }
.finding.dim .title { color: var(--ink-2); font-weight: 450; }
.title { border: 0; background: none; padding: 0; font: inherit; font-weight: 550; color: var(--ink); cursor: pointer; text-align: left; }
.title:hover { color: var(--accent); }
.loc { color: var(--accent); overflow-wrap: anywhere; }
.more { background: var(--sunken); border-radius: 8px; padding: 8px 10px; display: grid; gap: 6px; }
.more p { margin: 0; white-space: pre-wrap; }
.more .btn { justify-self: start; }
@media (max-width: 760px) {
  .check-row { grid-template-columns: 10px 48px minmax(0, 1fr) auto; }
  .ai { display: none; }
}
</style>
