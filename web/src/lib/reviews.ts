import { computed, onBeforeUnmount, ref, watch, type Ref } from "vue";
import { get } from "../api";

/** The reviews of a coding delegation or branch review (GET /api/runs/:id/reviews), shared by the run page's tabs. */
export type Severity = "blocker" | "major" | "minor" | "nit";
export type Finding = { id: number; severity: Severity; file_path: string | null; line: number | null; title: string; detail: string; suggestion: string; evidence: string[]; confidence: string; state: string; merged_into: number | null; triage_note: string; decision: Decision | null; decision_note: string };
/** The owner's call on a finding (src/agents/review-fix.ts). */
export type Decision = "fix" | "later" | "wontfix";
/** Without a call of the owner's: what review-lead accepted and the serious ones get fixed, the rest wait. */
export const decisionOf = (f: Finding): Decision => f.decision ?? (f.state === "accepted" || (f.state === "open" && (f.severity === "blocker" || f.severity === "major")) ? "fix" : "later");
export type ChangePoint = { id: string; title: string; status: "done" | "partial" | "missing" | "extra"; requirement: string; implementation: string; refs: string[]; locations: { file: string; start?: number; end?: number }[] };
export type Review = { id: string; round: number; check_name: string; verdict: "approved" | "changes_requested" | "failed"; summary: string; profile_id: string | null; model: string | null; effort: string | null; created_at: string; findings: Finding[]; change_points: ChangePoint[] };
export type Lead = { verdict: "approve" | "revise" | "escalate"; summary: string; changeRequest: string; rerun: string[]; by: "lead" | "host"; stop?: string; escalation?: { summary: string } };
export type AskInfo = { id: string; status: string; question: string; options: { label: string }[]; answer: string | null; handler?: string | null };
export type Round = { runId: string; round: number; status: string; plan: { tier: string; tierName: string; checks: string[]; reasons: string[]; lead?: boolean } | null; verdict: string | null; stage: string | null; lead: Lead | null; stop: string | null; ask: AskInfo | null; acceptedByOwner: boolean; changePoints: ChangePoint[] | null; reviewRuns?: { id: string; status: string; title: string }[] };
type Data = { estimate: { tierName: string; reason: string } | null; rounds: Round[]; reviews: Review[]; labels: Record<string, string> };

export const SEV: Record<Severity, { text: string; cls: string }> = { blocker: { text: "阻断", cls: "danger" }, major: { text: "严重", cls: "danger" }, minor: { text: "一般", cls: "warn" }, nit: { text: "提示", cls: "" } };
const RANK: Record<Severity, number> = { blocker: 0, major: 1, minor: 2, nit: 3 };
export const POINT_STATUS: Record<ChangePoint["status"], { text: string; cls: string }> = { done: { text: "已实现", cls: "ok" }, partial: { text: "部分实现", cls: "warn" }, missing: { text: "没实现", cls: "danger" }, extra: { text: "需求外", cls: "warn" } };
/** Findings review-lead set aside: shown dimmed, not counted. */
export const settled = (f: Finding) => ["rejected", "merged"].includes(f.state);
export const findingWhere = (f: Finding) => (f.file_path ? `${f.file_path}${f.line ? `:${f.line}` : ""}` : "");
export const reviewAi = (r: Review) => [r.profile_id, r.model, r.effort].filter(Boolean).join(" · ");
export const severityCounts = (r: Review) => (["blocker", "major", "minor", "nit"] as const).map((s) => ({ s, n: r.findings.filter((f) => f.severity === s && !settled(f)).length })).filter((x) => x.n);

export function useReviews(runId: Ref<string>, refreshKey: Ref<string | undefined>) {
  const data = ref<Data | null>(null);
  const round = ref(1);
  let timer: ReturnType<typeof setTimeout> | undefined;
  async function load(keepRound = false) {
    clearTimeout(timer);
    if (!runId.value) return void (data.value = null);
    try {
      data.value = await get<Data>(`/api/runs/${runId.value}/reviews`);
      if (!keepRound) round.value = data.value.rounds.find((r) => r.runId === runId.value)?.round ?? data.value.rounds.at(-1)?.round ?? 1;
      // A review running after the coding run ended (confirmed plan) has no run of this page to follow.
      if (["queued", "checks", "lead"].includes(current.value?.stage ?? "")) timer = setTimeout(() => void load(true), 3000);
    } catch {
      data.value = null;
    }
  }
  watch([runId, refreshKey], () => void load(), { immediate: true });
  onBeforeUnmount(() => clearTimeout(timer));

  const current = computed(() => data.value?.rounds.find((r) => r.round === round.value) ?? null);
  const reviews = computed(() => {
    const list = (data.value?.reviews ?? []).filter((r) => r.round === round.value);
    const order = current.value?.plan?.checks ?? [];
    return [...list].sort((a, b) => order.indexOf(a.check_name) - order.indexOf(b.check_name));
  });
  const label = (name: string) => data.value?.labels[name] ?? name;
  const findings = computed(() =>
    reviews.value
      .flatMap((r) => r.findings.map((f) => ({ ...f, check: r.check_name })))
      .sort((a, b) => Number(settled(a)) - Number(settled(b)) || RANK[a.severity] - RANK[b.severity]),
  );
  /** The change points of this round: the requirement split of its own if one ran, else the business check's. */
  const changePoints = computed(() => {
    if (current.value?.changePoints?.length) return current.value.changePoints;
    const withPoints = reviews.value.filter((r) => r.change_points.length);
    return (withPoints.find((r) => r.check_name === "review-business") ?? withPoints[0])?.change_points ?? [];
  });
  const roundOptions = computed(() => (data.value?.rounds ?? []).map((r) => ({ value: r.round, label: `第 ${r.round} 轮` })));
  const verdict = computed(() => {
    const c = current.value;
    if (!c) return null;
    if (["queued", "checks", "lead"].includes(c.stage ?? "")) return { text: c.stage === "lead" ? "负责人汇总中" : "评审中", cls: "accent" };
    if (c.verdict === "awaiting-plan") return { text: "计划等你确认", cls: "accent" };
    if (c.verdict === "approved") return { text: c.acceptedByOwner ? "你已接受" : "评审通过", cls: "ok" };
    if (c.stop) return { text: "等你决定", cls: "warn" };
    if (c.verdict === "changes-requested") return { text: "需要修改", cls: "warn" };
    return null;
  });
  return { data, round, current, reviews, label, findings, changePoints, roundOptions, verdict, load };
}
export type Reviews = ReturnType<typeof useReviews>;
