/**
 * Where each check of one round's stage review stands (the work page's 评审 and 活动 tabs, and its
 * 下一步 while the review runs). Self-contained, so tests read it without the page's API client.
 */
type FindingLike = { state: string };
type ReviewLike = { check_name: string; verdict: "approved" | "changes_requested" | "failed"; profile_id: string | null; model: string | null; effort: string | null; findings: FindingLike[] };
type RoundLike = { plan: { checks: string[]; looks?: string[] } | null; stage: string | null; live?: Record<string, { startedAt?: string; ai?: string }> };

/** Where one check of a stage review stands. */
export type CheckState = "queued" | "running" | "approved" | "changes_requested" | "failed" | "missing";
export const CHECK_STATE: Record<CheckState, { text: string; cls: string }> = {
  queued: { text: "排队", cls: "" }, running: { text: "进行中", cls: "accent" }, approved: { text: "通过", cls: "ok" },
  changes_requested: { text: "需要修改", cls: "warn" }, failed: { text: "没有完成", cls: "danger" }, missing: { text: "没交结果", cls: "" },
};
export type CheckRow<R extends ReviewLike = ReviewLike> = { name: string; state: CheckState; ai: string; findings: number; review: R | null; startedAt: string | null };
/**
 * The checks of one round's stage review, in the plan's order (then any recorded outside it, such as a
 * second look): its result once handed in, else queued or running from the round's stage.
 */
export function checkRows<R extends ReviewLike>(round: RoundLike, reviews: R[]): CheckRow<R>[] {
  const names = [...new Set([...(round.plan?.checks ?? []), ...(round.plan?.looks ?? []), ...reviews.map((r) => r.check_name)])];
  return names.map((name) => {
    const review = reviews.find((r) => r.check_name === name) ?? null;
    const started = round.live?.[name]?.startedAt ?? null;
    const state: CheckState = review ? review.verdict : round.stage === "checks" ? (started ? "running" : "queued") : round.stage === "plan" || round.stage === "queued" ? "queued" : "missing";
    const ai = review ? [review.profile_id, review.model, review.effort].filter(Boolean).join(" · ") : round.live?.[name]?.ai ?? "";
    // Findings review-lead set aside (rejected, merged) are not counted.
    return { name, state, ai, findings: review ? review.findings.filter((f) => !["rejected", "merged"].includes(f.state)).length : 0, review, startedAt: started };
  });
}
