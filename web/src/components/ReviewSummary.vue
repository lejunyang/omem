<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { get } from "../api";
import Markdown from "./Markdown.vue";
import UiSegmented from "./UiSegmented.vue";

/**
 * “本次评审” of a coding delegation: which tier and why, each check's verdict, and the problems
 * they found, round by round. Raw review text stays one click away.
 */
type Finding = { id: number; severity: "blocker" | "major" | "minor" | "nit"; file_path: string | null; line: number | null; title: string; detail: string; suggestion: string; evidence: string[]; confidence: string };
type Review = { id: string; round: number; check_name: string; verdict: "approved" | "changes_requested" | "failed"; summary: string; profile_id: string | null; model: string | null; effort: string | null; findings: Finding[] };
type Round = { runId: string; round: number; status: string; plan: { tier: string; tierName: string; checks: string[]; reasons: string[] } | null; verdict: string | null };
const props = defineProps<{ runId: string; reviewText?: string; refreshKey?: string }>();
const emit = defineEmits<{ ask: [context: { quote: string; label: string }] }>();

const data = ref<{ rounds: Round[]; reviews: Review[]; labels: Record<string, string> } | null>(null);
const round = ref(1);
async function load() {
  try {
    data.value = await get(`/api/runs/${props.runId}/reviews`);
    const own = data.value!.rounds.find((r) => r.runId === props.runId);
    round.value = own?.round ?? data.value!.rounds.at(-1)?.round ?? 1;
  } catch {
    data.value = null;
  }
}
watch(() => [props.runId, props.refreshKey], load, { immediate: true });

const current = computed(() => data.value?.rounds.find((r) => r.round === round.value) ?? null);
const reviews = computed(() => {
  const list = (data.value?.reviews ?? []).filter((r) => r.round === round.value);
  const order = current.value?.plan?.checks ?? [];
  return [...list].sort((a, b) => order.indexOf(a.check_name) - order.indexOf(b.check_name));
});
const label = (name: string) => data.value?.labels[name] ?? name;
const SEV: Record<Finding["severity"], { text: string; cls: string }> = { blocker: { text: "阻断", cls: "danger" }, major: { text: "严重", cls: "danger" }, minor: { text: "一般", cls: "warn" }, nit: { text: "提示", cls: "" } };
const RANK = { blocker: 0, major: 1, minor: 2, nit: 3 };
const findings = computed(() => reviews.value.flatMap((r) => r.findings.map((f) => ({ ...f, check: r.check_name }))).sort((a, b) => RANK[a.severity] - RANK[b.severity]));
const showAll = ref(false);
const shown = computed(() => (showAll.value ? findings.value : findings.value.filter((f) => f.severity !== "nit")));
const open = ref(new Set<number>());
const toggle = (id: number) => { const n = new Set(open.value); n.has(id) ? n.delete(id) : n.add(id); open.value = n; };
const counts = (r: Review) => (["blocker", "major", "minor", "nit"] as const).map((s) => ({ s, n: r.findings.filter((f) => f.severity === s).length })).filter((x) => x.n);
const ai = (r: Review) => [r.profile_id, r.model, r.effort].filter(Boolean).join(" · ");
const where = (f: Finding) => (f.file_path ? `${f.file_path}${f.line ? `:${f.line}` : ""}` : "");
const rawOpen = ref(false);
const roundOptions = computed(() => (data.value?.rounds ?? []).map((r) => ({ value: r.round, label: `第 ${r.round} 轮` })));
const verdictOf = computed(() => current.value?.verdict === "approved" ? { text: "评审通过", cls: "ok" } : current.value?.verdict === "changes-requested" ? { text: "需要修改", cls: "warn" } : null);
function askAbout(f: Finding & { check: string }) {
  emit("ask", { quote: [`[${SEV[f.severity].text}] ${f.title}`, where(f), f.detail, f.suggestion ? `建议：${f.suggestion}` : ""].filter(Boolean).join("\n"), label: `${label(f.check)}评审的问题` });
}
</script>

<template>
  <section v-if="data && (reviews.length || current?.plan)" class="block">
    <div class="section-title row">本次评审<span class="spacer" /><UiSegmented v-if="roundOptions.length > 1" v-model="round" size="sm" :options="roundOptions" aria-label="轮次" /></div>
    <div class="card pad stack">
      <div class="row wrap">
        <span v-if="verdictOf" class="badge" :class="verdictOf.cls">{{ verdictOf.text }}</span>
        <strong v-if="current?.plan">「{{ current.plan.tierName }}」档 · {{ current.plan.checks.length }} 项评审</strong>
        <span class="spacer" />
        <button v-if="reviewText" class="btn ghost sm" @click="rawOpen = !rawOpen">{{ rawOpen ? "收起评审原文" : "评审原文" }}</button>
      </div>
      <ul v-if="current?.plan?.reasons.length" class="reasons muted small"><li v-for="(r, i) in current.plan.reasons" :key="i">{{ r }}</li></ul>
      <div class="checks">
        <div v-for="r in reviews" :key="r.id" class="check-row">
          <span class="st" :class="r.verdict" :title="r.verdict" />
          <strong>{{ label(r.check_name) }}</strong>
          <span class="muted small ellipsis grow" :title="r.summary">{{ r.verdict === "failed" ? `没有完成：${r.summary}` : r.summary.split("\n")[0] }}</span>
          <span class="row sev"><span v-for="c in counts(r)" :key="c.s" class="badge" :class="SEV[c.s].cls">{{ SEV[c.s].text }} {{ c.n }}</span><span v-if="!counts(r).length && r.verdict === 'approved'" class="badge ok">通过</span></span>
          <span class="muted small mono ai">{{ ai(r) }}</span>
        </div>
      </div>
      <div v-if="rawOpen && reviewText" class="raw"><Markdown :source="reviewText" /></div>
    </div>

    <div v-if="findings.length" class="card pad">
      <div class="row"><div class="section-title flat">问题</div><span class="spacer" /><button v-if="findings.some((f) => f.severity === 'nit')" class="btn ghost sm" @click="showAll = !showAll">{{ showAll ? "隐藏提示级" : `含提示级（${findings.length}）` }}</button></div>
      <div v-for="f in shown" :key="f.id" class="finding">
        <div class="row wrap">
          <span class="badge" :class="SEV[f.severity].cls">{{ SEV[f.severity].text }}</span>
          <button class="title" :aria-expanded="open.has(f.id)" @click="toggle(f.id)">{{ f.title }}</button>
          <span class="spacer" />
          <span class="muted small">{{ label(f.check) }}</span>
        </div>
        <div v-if="where(f)" class="loc mono small">{{ where(f) }}</div>
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
.checks { display: grid; }
.check-row { display: grid; grid-template-columns: 10px 56px minmax(0, 1fr) auto auto; gap: 10px; align-items: center; padding: 8px 0; border-top: 1px solid var(--line); }
.check-row:first-child { border-top: 0; }
.grow { min-width: 0; }
.sev { gap: 4px; }
.ai { white-space: nowrap; }
.st { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
.st.approved { background: var(--ok); }
.st.changes_requested { background: var(--warn); }
.st.failed { background: var(--danger); }
.raw { border-top: 1px solid var(--line); padding-top: 10px; }
.finding { border-top: 1px solid var(--line); padding: 9px 0; display: grid; gap: 4px; }
.finding:first-of-type { border-top: 0; }
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
