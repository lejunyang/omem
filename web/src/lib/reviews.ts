import { computed, onBeforeUnmount, ref, watch, type Ref } from "vue";
import { get } from "../api";
import { splitPatch } from "./patch";

/** The reviews of a coding delegation or branch review (GET /api/runs/:id/reviews), shared by the run page's tabs. */
export type Severity = "blocker" | "major" | "minor" | "nit";
export type Finding = { id: number; severity: Severity; file_path: string | null; line: number | null; title: string; detail: string; suggestion: string; evidence: string[]; confidence: string; state: string; merged_into: number | null; triage_note: string; decision: Decision | null; decision_note: string; owner_suggestion?: string | null; fixed_by?: string | null; revised?: string | null };
/** The suggestion the next round acts on: the owner's rewrite when there is one. */
export const suggestionOf = (f: Pick<Finding, "suggestion" | "owner_suggestion">) => f.owner_suggestion?.trim() || f.suggestion;
/** The owner's call on a finding (src/agents/review-fix.ts). */
export type Decision = "fix" | "later" | "wontfix";
/** Without a call of the owner's: what review-lead accepted and the serious ones get fixed, the rest wait. */
export const decisionOf = (f: Finding): Decision => f.decision ?? (f.state === "accepted" || (f.state === "open" && (f.severity === "blocker" || f.severity === "major")) ? "fix" : "later");
/** `parent` nests a point under a page or module (a tree); without it the list is flat. */
export type ChangePoint = { id: string; parent?: string; req?: string; title: string; status: "done" | "partial" | "missing" | "extra"; requirement: string; implementation: string; refs: string[]; locations: { file: string; start?: number; end?: number }[] };
export type Review = { id: string; round: number; check_name: string; verdict: "approved" | "changes_requested" | "failed"; summary: string; profile_id: string | null; model: string | null; effort: string | null; created_at: string; findings: Finding[]; change_points: ChangePoint[] };
export type Lead = { verdict: "approve" | "revise" | "escalate"; summary: string; changeRequest: string; rerun: string[]; by: "lead" | "host"; stop?: string; escalation?: { summary: string } };
export type AskInfo = { id: string; status: string; question: string; options: { label: string }[]; answer: string | null; handler?: string | null };
export type Round = { runId: string; round: number; status: string; plan: { tier: string; tierName: string; checks: string[]; reasons: string[]; lead?: boolean } | null; verdict: string | null; stage: string | null; lead: Lead | null; stop: string | null; ask: AskInfo | null; acceptedByOwner: boolean; changePoints: ChangePoint[] | null; reviewRuns?: { id: string; status: string; title: string }[] };
type Data = { estimate: { tierName: string; reason: string } | null; rounds: Round[]; reviews: Review[]; labels: Record<string, string> };

export const SEV: Record<Severity, { text: string; cls: string }> = { blocker: { text: "阻断", cls: "danger" }, major: { text: "严重", cls: "danger" }, minor: { text: "一般", cls: "warn" }, nit: { text: "提示", cls: "" } };
const RANK: Record<Severity, number> = { blocker: 0, major: 1, minor: 2, nit: 3 };
export const POINT_STATUS: Record<ChangePoint["status"], { text: string; cls: string }> = { done: { text: "已实现", cls: "ok" }, partial: { text: "部分实现", cls: "warn" }, missing: { text: "没实现", cls: "danger" }, extra: { text: "需求外", cls: "warn" } };
/** How many change points there are, not counting the groups (pages, modules) that hold others. */
export const pointCount = (points: ChangePoint[]) => points.filter((p) => !points.some((x) => x.parent === p.id && x.id !== p.id)).length;
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
  const findings = computed(() => {
    const own: (Finding & { check: string; fromRound?: number })[] = reviews.value.flatMap((r) => r.findings.map((f) => ({ ...f, check: r.check_name })));
    // In the latest round, what the owner put off (“暂不改”) in earlier rounds stays in view to take up again.
    const latest = round.value === (data.value?.rounds.at(-1)?.round ?? round.value);
    const carried = latest ? (data.value?.reviews ?? []).filter((r) => r.round < round.value).flatMap((r) => r.findings.filter((f) => f.decision === "later").map((f) => ({ ...f, check: r.check_name, fromRound: r.round }))) : [];
    return [...own, ...carried].sort((a, b) => Number(settled(a)) - Number(settled(b)) || RANK[a.severity] - RANK[b.severity]);
  });
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
    if (c.stage === "peer") return { text: "等外部 Agent 评审", cls: "accent" };
    if (c.verdict === "awaiting-peer-code") return { text: "等外部 Agent 编码", cls: "accent" };
    if (c.verdict === "approved") return { text: c.acceptedByOwner ? "你已接受" : "评审通过", cls: "ok" };
    if (c.stop) return { text: "等你决定", cls: "warn" };
    if (c.verdict === "changes-requested") return { text: "需要修改", cls: "warn" };
    return null;
  });
  return { data, round, current, reviews, label, findings, changePoints, roundOptions, verdict, load };
}
export type Reviews = ReturnType<typeof useReviews>;

/** A run's saved patches (one per repository) split into files, for the diff views. */
export function parsePatches(patches: { space: string; patch: string }[]) {
  return patches.map((p) => ({ space: p.space, files: splitPatch(p.patch) }));
}

/** A change point as a quote for the ask drawer (“讲解”), with the points under a group. */
export function pointQuote(p: ChangePoint, all: ChangePoint[]) {
  const list = all.filter((x) => x.parent === p.id);
  const under = list.length ? `下面的变更点：${list.map((x) => `${x.id} ${x.title}（${POINT_STATUS[x.status].text}）`).join("；")}` : "";
  return { quote: [`${p.id} ${p.title}（${POINT_STATUS[p.status].text}）`, p.requirement && `需求：${p.requirement}`, p.implementation && `实现：${p.implementation}`, p.locations.map((l) => `${l.file}${l.start ? `:${l.start}${l.end && l.end !== l.start ? `-${l.end}` : ""}` : ""}`).join("、"), under].filter(Boolean).join("\n"), label: `变更点 ${p.id}` };
}

/** Later work on the branch that findings were handed to, and the newest work after a review (GET /api/runs/:id/latest-state). */
export type FixInfo = { rootId: string; title: string; status: string; applied: boolean; discarded: boolean };
export type NewerWork = { rootId: string; latestId: string; title: string; branchReview: boolean; status: string; applied: boolean };
export type LatestState = { fixedBy: Record<string, FixInfo>; newer: NewerWork | null };
/** How a handed-over finding stands: being fixed, fixed, or fixed and applied. */
export const fixLabel = (i: FixInfo) => (i.applied ? "已修改并应用" : ["queued", "running"].includes(i.status) ? "修改中" : i.status === "done" ? "已修改" : "修改没完成");
