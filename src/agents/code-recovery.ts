import type { App } from "../core/app.ts";
import type { AgentProfile } from "../core/config.ts";
import { all } from "../core/db.ts";
import { git } from "../core/git.ts";
import { truncate } from "../core/util.ts";
import { listTasks, stateLabel, taskLabel, taskText } from "./code-tasks.ts";
import { notesText, type CodeNote } from "./code-steer.ts";
import { getRun, type Run } from "./runs.ts";
import type { WorktreeRef } from "./worktree-index.ts";
import { workDirOf } from "./workspaces.ts";

export type CodingAI = { profile: string; model?: string; effort?: string };
export type CodingAttempt = { ai: CodingAI; sessionId: string };
export type CodingRecovery = {
  resumeAI?: CodingAI;
  freshTask: () => string;
  onSession: (attempt: CodingAttempt) => void;
};

const efforts = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
const modelKey = (model?: string) => model?.trim().toLowerCase();
const atLeastEffort = (candidate?: string, required?: string) => candidate === required || !required ||
  (!!candidate && efforts.includes(required) && efforts.indexOf(candidate) >= efforts.indexOf(required));

export function codingCandidateFloor(original: AgentProfile, tiers: (AgentProfile | undefined)[]) {
  const sameModel = (left: AgentProfile, right: AgentProfile) => left.id === right.id && modelKey(left.model) === modelKey(right.model);
  const rank = (profile: AgentProfile) => tiers.findLastIndex(tier => tier && sameModel(profile, tier) && atLeastEffort(profile.effort, tier.effort));
  const minimum = rank(original);
  return (candidate: AgentProfile) => {
    if (sameModel(candidate, original)) return atLeastEffort(candidate.effort, original.effort);
    return minimum >= 0 && rank(candidate) >= minimum && atLeastEffort(candidate.effort, original.effort);
  };
}

export function sameCodingSelection(left?: CodingAI, right?: CodingAI) {
  return left?.profile === right?.profile && modelKey(left?.model) === modelKey(right?.model) && left?.effort === right?.effort;
}

export function recoveryBrief(app: App, rootId: string, run: Run, trees: WorktreeRef[], previous?: Run | null) {
  const tasks = listTasks(app, rootId);
  const assigned = tasks.filter(task => task.coderRun === run.id);
  const recent = all<{ data: string }>(app.db, `select data from run_events where run_id = ? and type = 'text' and json_extract(data, '$.phase') = 'coder'
    order by seq desc limit 20`, run.id).reverse().map(row => (JSON.parse(row.data) as { text?: string }).text ?? "").join("").trim();
  const commits = trees.map(tree => {
    const path = workDirOf(tree);
    const log = git(path, ["log", "--oneline", "-20", `${tree.diffBase ?? tree.start ?? tree.base}..HEAD`]);
    const status = git(path, ["status", "--porcelain"]);
    return `${tree.space}：\n${log.stdout.trim() || "无新增提交"}${status.stdout.trim() ? `\n未提交文件：\n${truncate(status.stdout.trim(), 1000)}` : ""}`;
  });
  const summary = recent.slice(-2000) || String(run.output.coderProgress ?? "") || String(previous?.output.coderSummary ?? previous?.output.coderProgress ?? "");
  const currentNotes = ((run.output.notes ?? []) as CodeNote[]).slice(-8);
  return {
    taskCount: assigned.length,
    markdown: [
      "# 已有编码进展\n保留工作区和已有提交。只继续未完成的项；已完成、待验证的项不要重做。",
      tasks.length ? `## 修改项状态\n${tasks.map(task => `- ${taskLabel(task.seq)} [${stateLabel(task)}${task.coderRun === run.id ? "，本轮" : ""}] ${task.title}`).join("\n")}` : "",
      assigned.some(task => task.state === "coding") ? `## 本轮还在做的项\n${assigned.filter(task => task.state === "coding").map(task => taskText(app, task)).join("\n\n")}` : "",
      `## 已有提交和未提交文件\n${commits.map(commit => `\`\`\`\n${commit}\n\`\`\``).join("\n")}`,
      summary ? `## 上一次编码的进展小结\n${truncate(summary, 3500)}` : "",
      currentNotes.length ? notesText(currentNotes, app.config.timezone) : "",
    ].filter(Boolean).join("\n\n"),
  };
}

export function codingAttemptOf(run: Run): CodingAttempt | undefined {
  return run.output.coderAttempt as CodingAttempt | undefined;
}

export function priorCodingRun(app: App, run: Run, rootId: string, sessionId?: string) {
  const rows = all<{ id: string }>(app.db, `select id from runs where kind = 'code' and (id = ? or json_extract(input, '$.continueFrom') = ?) and rowid < (select rowid from runs where id = ?) order by rowid desc`, rootId, rootId, run.id);
  const prior = rows.map(row => getRun(app, row.id));
  return (sessionId ? prior.find(other => other.output.coderSessionId === sessionId || codingAttemptOf(other)?.sessionId === sessionId) : undefined) ?? prior[0];
}
