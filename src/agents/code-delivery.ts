import type { App } from "../core/app.ts";
import { git } from "../core/git.ts";
import { OWNER } from "../core/users.ts";
import { HttpError, truncate } from "../core/util.ts";
import { createAsk, getAsk, type Ask } from "./asks.ts";
import { codeChainFor, reportConversation } from "./code-chain.ts";
import { assertBranchSyncIdle } from "./code-round-sync.ts";
import { commitsByTask, getTask, listCheckpoints, listTasks, recordCheckpoint, taskLabel, updateTask, type CodeTask } from "./code-tasks.ts";
import { worktreesOf } from "./code.ts";
import { addRunEvent, getRun, runUser, setRunOutput, type Run } from "./runs.ts";
import { workDirOf } from "./workspaces.ts";

export const PARTIAL_PUSH = "确认并推送";
export const PARTIAL_SKIP = "暂不推送";
const PARTIAL_MIN_TASKS = 2;
const PARTIAL_MIN_MS = 20 * 60_000;
type Proof = { task: number; validation: string };
type Offer = { askId: string; spaces: string[]; bases: Record<string, string>; proofs: Proof[]; runId: string };

const offersOf = (app: App, rootId: string) => (getRun(app, rootId).output.checkpointOffers ?? {}) as Record<number, Offer>;
const hasCommits = (task: CodeTask) => Object.values(task.commits).some(commits => commits.length);
const eligible = (task: CodeTask, runId: string) => task.coderRun === runId && task.state === "done" && hasCommits(task);

export function partialDeliveryHint(app: App, run: Run, rootId: string) {
  if (runUser(app, run.id) !== OWNER || !run.output.coderStartedAt || Date.now() - Date.parse(String(run.output.coderStartedAt)) < PARTIAL_MIN_MS) return "";
  const tasks = listTasks(app, rootId);
  if (!tasks.some(task => ["todo", "coding", "verify"].includes(task.state))) return "";
  const unpublished = tasks.filter(task => eligible(task, run.id) && task.checkpoint === null);
  return unpublished.length >= PARTIAL_MIN_TASKS ? ` 已编码至少 20 分钟，还有项没做完；现在可用 finish_task(checkpoint: …) 先交已单独验证的一批（候选：${unpublished.map(task => taskLabel(task.seq)).join("、")}），提交卡片后继续。` : "";
}

export function offerCheckpoint(app: App, runId: string, rootId: string, proofs: Proof[], allow: (space: string) => void): { seq: number; ask: Ask } {
  const round = getRun(app, runId);
  if (runUser(app, runId) !== OWNER || round.status !== "running" || typeof round.output.coderSummary === "string") throw new HttpError(403, "只有本人的交办在编码时才能提请中途推送");
  assertBranchSyncIdle(app, runId);
  const trees = worktreesOf(app, rootId);
  for (const tree of trees) allow(tree.space);
  const tasks = [...new Set(proofs.map(proof => proof.task))].sort((left, right) => left - right);
  if (!tasks.length || tasks.length !== proofs.length || proofs.some(proof => !proof.validation.trim())) throw new HttpError(400, "每个修改项只列一次，写明实际通过的单项验证");
  const rows = tasks.map(seq => getTask(app, rootId, seq));
  if (rows.some(task => !eligible(task, runId))) throw new HttpError(409, "中途交付只包含本轮主编码已完成、有独立提交的项；待验证或尚未合回的项先不交");
  const offers = offersOf(app, rootId);
  const existing = Object.entries(offers).find(([, offer]) => offer.runId === runId && offer.proofs.length === tasks.length && offer.proofs.every(proof => tasks.includes(proof.task)));
  if (existing) return { seq: Number(existing[0]), ask: getAsk(app, existing[1].askId) };
  if (rows.some(task => task.checkpoint !== null)) throw new HttpError(409, "已经交过检查点的项不用再列；一批只列新增的项");
  const previous = listCheckpoints(app, rootId).at(-1)?.heads ?? {};
  const start = round.output.deliveryBases as Record<string, string> | undefined;
  const heads: Record<string, string> = {};
  const bases: Record<string, string> = {};
  const spaces: string[] = [];
  for (const tree of trees) {
    const path = workDirOf(tree);
    const shas = new Set(rows.flatMap(task => task.commits[tree.space] ?? []));
    const base = previous[tree.space] ?? start?.[tree.space];
    if (!tree.commits || !base || !git(path, ["merge-base", "--is-ancestor", base, "HEAD"]).ok) throw new HttpError(409, `${tree.space} 的检查点基线不在当前工作分支上，留到轮末交付`);
    heads[tree.space] = base;
    if (!shas.size) continue;
    if (!git(path, ["remote", "get-url", "origin"]).ok) throw new HttpError(409, `${tree.space} 没有 origin，不能中途推送`);
    const history = commitsByTask(path, base);
    const last = history.findLastIndex(commit => shas.has(commit.sha));
    if (last < 0) throw new HttpError(409, `${tree.space} 找不到这批提交，不能生成检查点`);
    const tip = history[last].sha;
    const prefix = commitsByTask(path, base, tip);
    if (prefix.length !== shas.size || prefix.some(commit => commit.revert || !shas.has(commit.sha) || commit.tasks.length !== 1 || !rows.some(task => task.seq === commit.tasks[0] && task.commits[tree.space]?.includes(commit.sha))))
      throw new HttpError(409, `${tree.space} 的这批提交夹着别的提交，不能只推这些项；请先选从上一检查点起连续完成的项，不要改写工作分支`);
    heads[tree.space] = tip;
    bases[tree.space] = base;
    spaces.push(tree.space);
  }
  if (!spaces.length) throw new HttpError(409, "没有可推送的提交");
  const label = `中途交付：${tasks.map(taskLabel).join("、")}`;
  const checkpoint = recordCheckpoint(app, rootId, trees, runId, tasks, label, heads)!;
  const chain = codeChainFor(app, round);
  const ask = createAsk(app, {
    runId,
    ...(chain ? { conversationId: reportConversation(app, chain) } : {}),
    question: [
      `**${getRun(app, rootId).title} · 检查点 ${checkpoint.seq}**`,
      ...rows.map(task => `- ${taskLabel(task.seq)} ${task.title}：${truncate(proofs.find(proof => proof.task === task.seq)!.validation, 600)}`),
      ...spaces.map(space => `- ${space}：${trees.find(tree => tree.space === space)!.branch}（${heads[space].slice(0, 8)}）`),
      "这里只列编码 Agent 跑过的单项验证，没有跑宿主检查。待做项清空后由评审负责人决定仓库检查范围，再评审整份改动。确认只推这批提交，编码不会停下来等你。",
    ].join("\n\n"),
    options: [{ label: PARTIAL_PUSH }, { label: PARTIAL_SKIP }], allowText: false,
    context: { handler: "work-deliver", rootId, checkpoint: checkpoint.seq },
  });
  setRunOutput(app, rootId, { checkpointOffers: { ...offers, [checkpoint.seq]: { askId: ask.id, runId, spaces, bases, proofs } } });
  for (const task of rows) updateTask(app, rootId, task.seq, { checkpoint: checkpoint.seq });
  addRunEvent(app, runId, "status", { text: `检查点 ${checkpoint.seq}：${label}，等本人确认推送` });
  return { seq: checkpoint.seq, ask };
}

export function offeredHeads(app: App, rootId: string, seq: number) {
  const offer = offersOf(app, rootId)[seq];
  const checkpoint = listCheckpoints(app, rootId).find(cp => cp.seq === seq);
  if (!offer || !checkpoint) throw new HttpError(404, "没有这个中途交付检查点");
  if (offer.proofs.some(proof => !eligible(getTask(app, rootId, proof.task), offer.runId))) throw new HttpError(409, "这批里有修改项已回退或重新打开，请确认新的检查点");
  return { heads: Object.fromEntries(offer.spaces.map(space => [space, checkpoint.heads[space]])), bases: offer.bases };
}

