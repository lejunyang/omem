<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { get } from "../api";
import { plainLine } from "../lib/plain";
import { CHECK_STATE, checkRows, findingWhere, settled, SEV, type CheckRow, type Finding, type Review, type Reviews, type Round } from "../lib/reviews";
import { refAction } from "../lib/refs";
import { fmtTime, relTime } from "../store";
import Markdown from "./Markdown.vue";

/**
 * A delegation's 评审 tab (docs/v2/coding-work.md): every round's stage review, newest first. One under
 * way shows each check's state (queued, running, passed, wants changes), the AI it runs on and how many
 * problems it raised so far; a finished one its conclusion and problems, each leading to the task it
 * became. Verifications of single tasks while the coder works on are listed apart (修改项验证).
 */
const props = defineProps<{ rv: Reviews; runId: string; taskMode?: boolean; rounds: { round: number; createdAt: string; finishedAt: string | null }[] }>();
const emit = defineEmits<{ process: [check: string]; task: [seq: number] }>();
const rv = props.rv;

const LEAD: Record<string, string> = { approve: "通过", revise: "再改一轮", escalate: "交给你决定" };
const LIVE = ["queued", "plan", "checks", "lead"];
type Shown = { r: Round; rows: CheckRow<Review>[]; findings: (Finding & { check: string })[]; live: boolean; verdict: { text: string; cls: string } };
const shownRounds = computed<Shown[]>(() => {
  const d = rv.data.value;
  if (!d) return [];
  return [...d.rounds].reverse().flatMap((r) => {
    const reviews = d.reviews.filter((x) => x.round === r.round);
    if (!r.plan && !reviews.length) return [];
    const live = LIVE.includes(r.stage ?? "") && ["running", "queued"].includes(r.status);
    const rows = checkRows(r, reviews);
    const findings = reviews.flatMap((x) => x.findings.map((f) => ({ ...f, check: x.check_name }))).filter((f) => !settled(f)).sort((a, b) => rank(a) - rank(b));
    return [{ r, rows, findings, live, verdict: verdictOf(r, rows, live) }];
  });
});
const RANK = { blocker: 0, major: 1, minor: 2, nit: 3 } as const;
const rank = (f: Finding) => RANK[f.severity];
function verdictOf(r: Round, rows: CheckRow<Review>[], live: boolean) {
  if (live) return { text: r.stage === "plan" ? "在定看什么" : r.stage === "lead" ? "负责人汇总中" : `进行中 · ${rows.filter((x) => ["approved", "changes_requested", "failed"].includes(x.state)).length}/${rows.length}`, cls: "accent" };
  if (r.verdict === "awaiting-plan") return { text: "计划等你确认", cls: "warn" };
  if (r.acceptedByOwner) return { text: "你已接受", cls: "ok" };
  if (r.stop) return { text: "等你决定", cls: "warn" };
  if (r.lead) return { text: LEAD[r.lead.verdict] ?? r.lead.verdict, cls: r.lead.verdict === "approve" ? "ok" : "warn" };
  if (rows.some((x) => x.state === "changes_requested")) return { text: "需要修改", cls: "warn" };
  if (rows.length && rows.every((x) => x.state === "approved")) return { text: "通过", cls: "ok" };
  return { text: r.status === "cancelled" ? "被停下" : "没有结论", cls: "" };
}

// The newest round open, older ones a line each; a check opens to its conclusion and problems.
const openRounds = ref(new Set<number>());
watch(() => shownRounds.value[0]?.r.round, (n) => { if (n !== undefined) openRounds.value = new Set([...openRounds.value, n]); }, { immediate: true });
const toggleRound = (n: number) => { const s = new Set(openRounds.value); s.has(n) ? s.delete(n) : s.add(n); openRounds.value = s; };
const openChecks = ref(new Set<string>());
const toggleCheck = (k: string) => { const s = new Set(openChecks.value); s.has(k) ? s.delete(k) : s.add(k); openChecks.value = s; };
const FINDINGS_SHOWN = 8;
const allFindings = ref(new Set<number>());

// ---- verifications of single tasks while the coder works on ----------------------------------------
type Note = { at: string; by: string; text: string; kind: string };
type Task = { seq: number; title: string; notes: Note[] };
const tasks = ref<Task[]>([]);
watch(() => [props.runId, props.taskMode, rv.data.value] as const, async ([id, mode]) => {
  if (!mode) return void (tasks.value = []);
  const d = await get<{ tasks?: Task[] }>(`/api/runs/${id}/tasks`).catch(() => null);
  if (id === props.runId) tasks.value = d?.tasks ?? [];
}, { immediate: true });
const roundAt = (at: string) => [...props.rounds].reverse().find((r) => r.createdAt <= at)?.round ?? null;
const verifications = computed(() => tasks.value.flatMap((t) => t.notes.filter((n) => n.kind === "verify").map((n) => ({ seq: t.seq, title: t.title, check: n.by, text: n.text, at: n.at, round: roundAt(n.at) }))).sort((a, b) => b.at.localeCompare(a.at)));
/** A verification's conclusion from how its note begins (code-loop.ts: 验证通过 / 没改好 / 改出了新问题 / 问题撤回). */
const OUTCOMES: [string, { text: string; cls: string }][] = [["验证通过", { text: "通过", cls: "ok" }], ["没改好", { text: "没改好", cls: "warn" }], ["改出了新问题", { text: "改出新问题", cls: "danger" }], ["问题撤回", { text: "撤回", cls: "" }]];
const outcome = (text: string) => OUTCOMES.find(([p]) => text.startsWith(p))?.[1] ?? null;
/** The note after its conclusion. */
const rest = (text: string) => text.replace(/^(验证通过|没改好|改出了新问题|问题撤回)[：:]?/, "").trim();
const VERIFY_SHOWN = 10;
const verifyAll = ref(false);
const verifyOpen = ref(new Set<string>());
const toggleVerify = (k: string) => { const s = new Set(verifyOpen.value); s.has(k) ? s.delete(k) : s.add(k); verifyOpen.value = s; };
</script>

<template>
  <section class="rounds-tab">
    <p v-if="!shownRounds.length" class="empty-tab">{{ taskMode ? "还没有阶段评审：待做的项做完后，评审负责人决定这次看什么。" : "这一轮没有评审。" }}</p>
    <article v-for="x in shownRounds" :key="x.r.round" class="round" :class="{ live: x.live }">
      <button class="rhead" :aria-expanded="openRounds.has(x.r.round)" @click="toggleRound(x.r.round)">
        <strong>第 {{ x.r.round }} 轮的阶段评审</strong>
        <span class="badge" :class="x.verdict.cls">{{ x.verdict.text }}</span>
        <span v-if="x.r.plan" class="muted small">{{ x.r.plan.tierName }} · {{ x.rows.length }} 个评审项</span>
        <span v-if="x.findings.length" class="muted small">{{ x.findings.length }} 个问题</span>
      </button>
      <div v-if="openRounds.has(x.r.round)" class="rbody">
        <p v-if="x.r.plan?.reasons?.length" class="muted small reason">{{ plainLine(x.r.plan.reasons[0], 240) }}</p>
        <div v-if="x.r.lead" class="lead small">
          <span class="muted">评审负责人：</span>{{ x.r.lead.summary }}
          <button class="lnk proc" @click="emit('process', 'lead')">看过程</button>
          <details v-if="x.r.lead.changeRequest"><summary class="muted">修改单</summary><Markdown compact :source="x.r.lead.changeRequest" /></details>
        </div>
        <ul class="checks">
          <li v-for="c in x.rows" :key="c.name" class="check">
            <button class="chead small" :aria-expanded="openChecks.has(`${x.r.round}:${c.name}`)" :disabled="!c.review" @click="toggleCheck(`${x.r.round}:${c.name}`)">
              <span class="cdot" :class="c.state" />
              <strong class="cname">{{ rv.label(c.name) }}</strong>
              <span class="badge" :class="CHECK_STATE[c.state].cls">{{ CHECK_STATE[c.state].text }}</span>
              <span v-if="c.review" class="muted">{{ c.findings ? `${c.findings} 个问题` : "没有问题" }}</span>
              <span v-else-if="c.startedAt" class="muted">{{ relTime(c.startedAt) }}开始</span>
              <span class="spacer" />
              <span v-if="c.ai" class="muted mono ai" :title="c.ai">{{ c.ai }}</span>
            </button>
            <button class="lnk small proc" @click="emit('process', c.name)">看过程</button>
            <div v-if="c.review && openChecks.has(`${x.r.round}:${c.name}`)" class="cbody">
              <Markdown compact :source="c.review.summary || '（没有写结论）'" />
              <div class="muted small">{{ fmtTime(c.review.created_at) }}交的</div>
            </div>
          </li>
        </ul>
        <div v-if="x.findings.length" class="findings">
          <div class="section-title">提出的问题</div>
          <div v-for="f in allFindings.has(x.r.round) ? x.findings : x.findings.slice(0, FINDINGS_SHOWN)" :key="f.id" class="f small">
            <span class="badge" :class="SEV[f.severity].cls">{{ SEV[f.severity].text }}</span>
            <span class="ft">{{ f.title }}<a v-if="findingWhere(f)" href="#" class="mono loc" @click.prevent="refAction(findingWhere(f), runId)?.()">{{ findingWhere(f) }}</a></span>
            <span class="muted nowrap">{{ rv.label(f.check) }}</span>
            <button v-if="f.task_seq" class="lnk nowrap" :title="`看修改项 T${f.task_seq}`" @click="emit('task', f.task_seq!)">T{{ f.task_seq }}</button>
          </div>
          <button v-if="x.findings.length > FINDINGS_SHOWN && !allFindings.has(x.r.round)" class="lnk small" @click="allFindings = new Set([...allFindings, x.r.round])">另外 {{ x.findings.length - FINDINGS_SHOWN }} 个</button>
        </div>
      </div>
    </article>

    <section v-if="verifications.length" class="verify">
      <div class="section-title">修改项验证<span class="muted small"> · 编码时评审项逐项核对做完的修改项，和阶段评审分开</span></div>
      <div v-for="(v, i) in verifyAll ? verifications : verifications.slice(0, VERIFY_SHOWN)" :key="`${v.seq}:${v.at}`" class="v small">
        <button class="lnk mono" :title="v.title" @click="emit('task', v.seq)">T{{ v.seq }}</button>
        <span class="muted nowrap">{{ rv.label(v.check) }}</span>
        <span v-if="outcome(v.text)" class="badge" :class="outcome(v.text)!.cls">{{ outcome(v.text)!.text }}</span>
        <button class="vtext" :class="{ open: verifyOpen.has(`${i}`) }" :aria-expanded="verifyOpen.has(`${i}`)" @click="toggleVerify(`${i}`)">{{ rest(v.text) }}</button>
        <span class="muted nowrap">{{ v.round ? `第 ${v.round} 轮 · ` : "" }}{{ fmtTime(v.at) }}</span>
      </div>
      <button v-if="verifications.length > VERIFY_SHOWN" class="lnk small" @click="verifyAll = !verifyAll">{{ verifyAll ? "收起" : `更早的 ${verifications.length - VERIFY_SHOWN} 条` }}</button>
    </section>
  </section>
</template>

<style scoped>
.rounds-tab { display: grid; gap: 10px; min-width: 0; }
.round { border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel); min-width: 0; }
.round.live { border-color: var(--accent); }
.rhead { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; width: 100%; padding: 10px 12px; border: 0; background: none; font: inherit; color: var(--ink); text-align: left; cursor: pointer; }
.rhead:hover { background: var(--hover); }
.rbody { border-top: 1px solid var(--line); padding: 10px 12px 12px; display: grid; gap: 10px; min-width: 0; }
.reason { margin: 0; overflow-wrap: anywhere; }
.lead { overflow-wrap: anywhere; display: grid; gap: 4px; }
.lead summary { cursor: pointer; }
.checks { list-style: none; margin: 0; padding: 0; display: grid; min-width: 0; }
.check { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; column-gap: 8px; border-bottom: 1px solid var(--line); min-width: 0; }
.chead { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; padding: 6px 2px; border: 0; background: none; font: inherit; color: var(--ink); text-align: left; cursor: pointer; min-width: 0; }
.chead:disabled { cursor: default; opacity: 1; }
.chead:not(:disabled):hover .cname { text-decoration: underline; }
.proc { justify-self: end; }
.cbody { grid-column: 1 / -1; padding: 0 2px 10px 15px; display: grid; gap: 4px; min-width: 0; }
.cdot { width: 7px; height: 7px; border-radius: 50%; background: var(--line-strong); flex: none; }
.cdot.running { background: var(--accent); }
.cdot.approved { background: var(--ok); }
.cdot.changes_requested { background: var(--warn); }
.cdot.failed { background: var(--danger); }
.ai { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 240px; }
.findings { display: grid; gap: 4px; min-width: 0; }
.findings .section-title { margin: 0; }
.f { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 8px; padding: 3px 0; min-width: 0; }
.ft { flex: 1 1 16em; min-width: 0; overflow-wrap: anywhere; }
.loc { margin-left: 6px; font-size: 12px; color: var(--muted); overflow-wrap: anywhere; }
.nowrap { white-space: nowrap; }
.lnk { border: 0; background: none; color: var(--accent); cursor: pointer; font: inherit; padding: 0; justify-self: start; }
.lnk.small { font-size: 12px; }
.lnk:hover { text-decoration: underline; }
.verify { display: grid; gap: 4px; min-width: 0; padding-top: 4px; }
.verify .section-title { margin: 0 0 2px; }
.v { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 8px; padding: 4px 0; border-bottom: 1px solid var(--line); min-width: 0; }
.vtext { flex: 1 1 14em; min-width: 0; border: 0; background: none; padding: 0; font: inherit; color: var(--ink-2); text-align: left; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vtext.open { white-space: pre-line; overflow-wrap: anywhere; }
.empty-tab { color: var(--muted); font-size: 13px; padding: 14px; border: 1px dashed var(--line-strong); border-radius: var(--radius); margin: 0; }
@media (max-width: 760px) { .ai { display: none; } }
</style>
