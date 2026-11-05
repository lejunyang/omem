/**
 * Coding work as the run page's “编码” view and the requirements page show it (src/agents/code-works.ts):
 * one entry per delegation or branch review with all its rounds.
 */
export type WorkGroup = "owner" | "active" | "assistant" | "idle" | "ended";
export type WorkAction = "stop" | "retry" | "discard" | "confirm" | "apply" | "move" | "code-here" | "clean" | "branch";
export type WorkRepo = { space: string; branch: string | null; base: string | null; cutFrom: string | null; newBranch: boolean; pushedAt: string | null };
export type CodeWork = {
  rootId: string;
  latestId: string;
  title: string;
  spaceId: string | null;
  stage: { key: string; text: string; cls: string; group: WorkGroup };
  now: string;
  next: { text: string; actions: WorkAction[] };
  branchReview: boolean;
  branchWork: boolean;
  taskMode: boolean;
  rounds: number;
  progress: { build: [number, number]; fix: [number, number]; owner: number; assistant: number; later: number } | null;
  open: number;
  item: { id: string; title: string } | null;
  reqs: { id: string; title: string; kind: string }[];
  repos: WorkRepo[];
  peer: string | null;
  createdAt: string;
  updatedAt: string;
};
export type WorkRound = { id: string; round: number; status: string; title: string; verdict: string | null; createdAt: string; finishedAt: string | null };
export type CodeWorkDetail = CodeWork & { task: string; roundList: WorkRound[]; points: { id: string; title: string; status: string | null; at: string | null }[] };

export const GROUPS: { id: WorkGroup; label: string }[] = [
  { id: "owner", label: "等你" },
  { id: "active", label: "进行中" },
  { id: "assistant", label: "助手在处理" },
  { id: "idle", label: "搁着" },
  { id: "ended", label: "已结束" },
];

/** “需求 2/3 · 评审修改 3/5 · 第 3 轮”: how far it got, in the owner's words. */
export function progressText(w: CodeWork) {
  const p = w.progress;
  const parts: string[] = [];
  if (w.branchReview) parts.push("分支评审");
  if (p && p.build[1]) parts.push(`需求 ${p.build[0]}/${p.build[1]}`);
  if (p && p.fix[1]) parts.push(`评审修改 ${p.fix[0]}/${p.fix[1]}`);
  if (p?.later) parts.push(`以后再做 ${p.later}`);
  if (!w.branchReview) parts.push(`${w.rounds} 轮`);
  return parts.join(" · ");
}

/** “前端 · feat/x ← main”: the repositories and the branch they work on. */
export function branchText(w: CodeWork, spaceName: (id: string) => string) {
  const names = w.repos.map((r) => spaceName(r.space));
  const branches = [...new Set(w.repos.map((r) => r.branch).filter(Boolean))];
  const from = [...new Set(w.repos.map((r) => (w.branchReview ? r.base : r.cutFrom)).filter(Boolean))];
  const pushed = w.repos.some((r) => r.pushedAt);
  return [names.join("、"), branches.length ? `${branches.join("、")}${from.length ? ` ← ${from.join("、")}` : ""}` : "", pushed ? "推送过" : ""].filter(Boolean).join(" · ");
}
