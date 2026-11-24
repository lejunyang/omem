import type { Artifact } from "../components/RunArtifacts.vue";

/** A study's ledger as the item page shows it (docs/v2/studies.md): directions, the trials run for them, and findings. */
export type TrialResult = "passed" | "failed" | "blocked" | "unclear";
export type StudyTrial = {
  id: string; directionId: string; round: number; seq: number; object: string; check: string; env: string;
  state: "queued" | "running" | "reported" | "skipped"; result: TrialResult | null; summary: string;
  evidence: string[]; artifacts: Artifact[]; findings: { kind: FindingKind; title: string; repro: string }[];
  runId: string | null; attempts: number; prior: string | null; unsure: boolean; escalated: boolean; updatedAt: string;
  /** The headings of the feature list it covers, as named when the direction was proposed. */
  features?: string[];
  /** The commit of each repository in the study's own workspace this trial ran on, by repository space. */
  commits?: Record<string, string>;
  /** A rerun after a code change: the finding it checks and the delegation whose workspace it ran in. */
  fixOf?: string | null; workId?: string | null;
  /** Handed to another of the owner's devices: which one, and its run there. */
  peer?: string | null; peerRunId?: string | null;
};
/** What a study may touch: the repositories it works in, whether a finding may be turned into a code change, whether samples' own scripts may run on this machine. */
export type StudyScope = {
  repos: { id: string; name: string }[]; allowCode: boolean; thirdParty: boolean; candidates?: { id: string; name: string }[];
  /** Standing permission to push: only to this remote, only under this branch prefix. Both set, or it cannot push. */
  pushRemote?: string | null; pushPrefix?: string | null;
};
/** A push a trial made under the study's standing permission. */
export type StudyPush = { id: string; trialId: string | null; repo: string; remote: string; branch: string; commit: string; note: string; at: string };
export function scopeWords(s: StudyScope) {
  return [s.repos.length ? s.repos.map((r) => r.name).join("、") : "没有登记仓库", s.allowCode ? "可以改代码" : "不改代码", s.thirdParty ? "本机可以执行第三方样本的代码" : "本机不执行第三方样本的代码", s.pushRemote && s.pushPrefix ? `可以推到 ${s.pushRemote} 的 ${s.pushPrefix} 下面` : "不推送"].join("；");
}
export type StudyDirection = {
  id: string; round: number; goal: string; approach: string; acceptance: string; env: string; estimate: string;
  state: "proposed" | "confirmed" | "active" | "done" | "dropped"; conclusion: string; note: string;
  plan: { object: string; check: string; prior?: string }[]; removed: { object: string; check: string; prior: string }[];
  counts: Record<"queued" | "running" | "skipped" | TrialResult, number>; createdAt: string; updatedAt: string;
  /** Findings of this direction may be turned into code changes; it runs other people's install or build scripts. */
  allowCode?: boolean; thirdParty?: boolean; baseline?: Record<string, string>;
};
export type FindingKind = "defect" | "gap" | "idea";
export type StudyFinding = {
  id: string; kind: FindingKind; title: string; repro: string; trials: StudyTrial[];
  state: "new" | "confirmed" | "rejected" | "later" | "duplicate"; stateReason: string; sameAs: string | null; createdAt: string; updatedAt: string;
  round?: number;
  /** Closed as fixed: when, and by what (a commit, a delegation whose reruns passed). */
  fixedAt?: string | null; fixedNote?: string;
  /** The wording before someone re-described it (revise_study_finding), kept once. */
  revised?: { kind: FindingKind; title: string; repro: string } | null;
  /** The code delegation started from this finding, and where it stands. */
  fix?: { workId: string; status: string; link: string; /** How the failed trials went when run again on the change. */ verified?: TrialResult | null; reruns?: string[] } | null;
};
export type StudyView = {
  directions: StudyDirection[]; trials: StudyTrial[]; findings: StudyFinding[];
  coverage: { path: string; ref: string | null; features: { title: string; trials: number; lastAt: string | null }[] };
  idleRounds: number; scope?: StudyScope; pushes?: StudyPush[];
};

export const kindWords: Record<FindingKind, string> = { defect: "缺陷", gap: "缺口", idea: "想法" };
export const findingWords: Record<StudyFinding["state"], string> = { new: "等你看", confirmed: "认可", rejected: "不算", later: "以后再说", duplicate: "和另一条是一回事" };
export const resultWords: Record<TrialResult, string> = { passed: "通过", failed: "没通过", blocked: "跑不了", unclear: "说不清" };
/** What rerunning the failed trials on a change showed. */
export const verifiedWords: Record<TrialResult, string> = { passed: "改后重跑通过", failed: "改后重跑仍然没通过", blocked: "改后没能重跑", unclear: "改后重跑说不清" };
export const directionWords: Record<StudyDirection["state"], string> = { proposed: "等你选", confirmed: "在做", active: "在做", done: "做完了", dropped: "放下了" };

/** What a trial is at now, in one word: its result once it has one. */
export function trialWord(t: StudyTrial) {
  return t.result ? resultWords[t.result] : t.state === "running" ? "在跑" : t.state === "skipped" ? "没跑" : "排着";
}
/** The colour of a trial's dot and of its share of the progress bar. */
export function trialTone(t: Pick<StudyTrial, "state" | "result">) {
  return t.result === "passed" ? "ok" : t.result === "failed" ? "bad" : t.result ? "warn" : t.state === "running" ? "run" : "rest";
}
/** Read first what did not go well: failed, could not run, unclear, running, passed, then the ones not run. */
const order = (t: StudyTrial) => t.result === "failed" ? 0 : t.result === "blocked" ? 1 : t.result === "unclear" ? 2 : t.state === "running" ? 3 : t.result === "passed" ? 4 : t.state === "queued" ? 5 : 6;
export const byConcern = (a: StudyTrial, b: StudyTrial) => order(a) - order(b) || a.seq - b.seq;
/** Findings the owner has not judged come first, then the ones put off; the ones fixed go to the end. */
const findingOrder: Record<StudyFinding["state"], number> = { new: 0, later: 1, confirmed: 2, rejected: 3, duplicate: 4 };
const rankOf = (f: StudyFinding) => f.fixedAt ? 5 : findingOrder[f.state];
export const byUnjudged = (a: StudyFinding, b: StudyFinding) => rankOf(a) - rankOf(b) || b.createdAt.localeCompare(a.createdAt);
/** Where a finding stands, in a word: fixed overrides the owner's earlier call. */
export const findingWord = (f: StudyFinding) => f.fixedAt ? "已改好" : findingWords[f.state];

/** The parts of a direction's progress bar, in a fixed order, leaving out the empty ones. */
export function progress(d: StudyDirection) {
  const c = d.counts;
  return [
    { tone: "ok", label: "通过", n: c.passed }, { tone: "bad", label: "没通过", n: c.failed },
    { tone: "warn", label: "跑不了或说不清", n: c.blocked + c.unclear }, { tone: "run", label: "在跑", n: c.running },
    { tone: "rest", label: "排着", n: c.queued }, { tone: "skip", label: "没跑", n: c.skipped },
  ].filter((p) => p.n > 0);
}
export const total = (d: StudyDirection) => Object.values(d.counts).reduce((a, b) => a + b, 0);
