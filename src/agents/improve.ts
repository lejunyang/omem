import { existsSync } from "node:fs";
import type { App } from "../core/app.ts";
import { all, one, run, tx } from "../core/db.ts";
import { git } from "../core/git.ts";
import { notify } from "../core/notify.ts";
import { canWrite, OWNER, scopeFor } from "../core/users.ts";
import { HttpError, newId, now } from "../core/util.ts";
import { codeChainFor, codeChainRounds } from "./code-chain.ts";
import { checkedOutAt, identity } from "./code-branch.ts";
import { checkCommandOf, repositoryCommand, worktreesOf, type Check } from "./code.ts";
import { addRunEvent, getRun, setRunOutput, type Run } from "./runs.ts";
import { findThread } from "./threads.ts";
import type { ToolContext } from "./tools.ts";
import type { WorktreeRef } from "./worktree-index.ts";

export type ImproveGoal = {
  id: string; run_id: string; space_id: string; name: string; metric_command: string; direction: "down" | "up";
  target: number | null; min_gain: number; max_rounds: number; until: string | null; protect: string[];
  baseline: number; best: number; head: string; rounds: number; stale: number;
  state: "running" | "done" | "stopped"; stop_reason: string | null; created_by: string; created_at: string; updated_at: string;
};
export type ImproveRound = {
  goal_id: string; seq: number; at: string; note: string; expect: string | null; from_commit: string; to_commit: string;
  before: number; after: number | null; verdict: "kept" | "reverted" | "broken" | "protected" | "nothing"; why: string; revert_commit: string | null;
};
type GoalRow = Omit<ImproveGoal, "protect"> & { protect: string };
export const VERDICTS = { kept: "留下", reverted: "回退", broken: "回退（检查或度量失败）", protected: "回退（受保护路径）", nothing: "没有提交" };
export const CHANGE_APPROACH = "连着两轮没有变好：下一轮换一个结构上不同的做法，不要在同一个做法上调参数";
const verdictText = (r: ImproveRound) => !["kept", "nothing"].includes(r.verdict) && !r.revert_commit ? "回退失败" : VERDICTS[r.verdict];

export function improveGoal(app: App, id: string): ImproveGoal {
  const row = one<GoalRow>(app.db, "select * from improve_goals where id = ?", id);
  if (!row) throw new HttpError(404, "改进目标不存在");
  return { ...row, protect: JSON.parse(row.protect) };
}
export const improveRounds = (app: App, goal: string) => all<ImproveRound>(app.db, "select * from improve_rounds where goal_id = ? order by seq", goal);

/** Read-only view for the already permission-checked delegation page. */
export function improvementOf(app: App, runId: string) {
  const seed = getRun(app, runId);
  const root = String(seed.input.continueFrom ?? seed.id);
  const row = one<{ id: string }>(app.db, "select id from improve_goals where run_id = ? order by created_at desc, rowid desc limit 1", root);
  return row ? { goal: improveGoal(app, row.id), rounds: improveRounds(app, row.id) } : null;
}

/** Same delegation and conversation-owner checks as continue_code_run, plus this call's space scope. */
export function improveDelegation(ctx: ToolContext, id: string, write = true) {
  const app = ctx.app, user = ctx.userId ?? OWNER, seed = getRun(app, id);
  let rounds = codeChainRounds(app, seed.kind === "code" ? seed.parentId ?? id : id).filter((r) => r.kind === "code");
  if (seed.kind === "code") rounds = rounds.filter((r) => String(r.input.continueFrom ?? r.id) === String(seed.input.continueFrom ?? seed.id));
  const last = rounds.at(-1);
  if (!last || last.input.branches) throw new HttpError(400, "这不是可改进的编码交办");
  const chain = codeChainFor(app, last);
  if (!chain || findThread(app, chain.conversationId)?.userId !== user) throw new HttpError(403, "只能操作本人发起的编码交办");
  const root = String(last.input.continueFrom ?? rounds[0].id);
  const wts = worktreesOf(app, root);
  for (const space of new Set([last.spaceId!, ...((last.input.repos as string[] | undefined) ?? []), ...wts.map((w) => w.space)])) {
    const allowed = scopeFor(app, user, ctx.spaces);
    if (allowed && !allowed.includes(space) || write && (!canWrite(app, user, space) || ctx.writable && !ctx.writable.includes(space)))
      throw new HttpError(403, `本次不能${write ? "修改" : "读取"}空间 ${space}`);
  }
  return { root, last, rounds, wts };
}

function idle(rounds: Run[]) {
  if (rounds.some((r) => ["running", "queued"].includes(r.status))) throw new HttpError(409, "交办仍在运行，等它结束后再度量");
  if (rounds.some((r) => r.output.appliedAt || r.output.discardedAt)) throw new HttpError(409, "交办已经应用或丢弃");
}
function command(dir: string, args: string[]) {
  const result = git(dir, args);
  if (!result.ok) throw new HttpError(409, `Git 操作失败：${result.stderr.slice(-2000)}`);
  return result.stdout.trim();
}
function clean(wt: WorktreeRef) {
  if (!existsSync(wt.path) || !wt.commits) throw new HttpError(409, "改进目标需要仍在本机的编码工作分支");
  if (command(wt.path, ["status", "--porcelain"])) throw new HttpError(409, "工作区有未提交的修改，请先交完这一轮再度量");
  return command(wt.path, ["rev-parse", "HEAD"]);
}

/** Last number on the last nonempty line; reject comma-separated numbers as a whole. */
export function metricValue(output: string): number | null {
  const line = output.trimEnd().split(/\r?\n/).filter((l) => l.trim()).at(-1) ?? "";
  const tokens = line.match(/-?\d[\d,]*(?:\.\d+)?|-?\.\d+/g);
  const last = tokens?.at(-1);
  if (!last || last.includes(",")) return null;
  const value = Number(last);
  return Number.isFinite(value) ? value : null;
}

export async function measure(app: App, goal: Pick<ImproveGoal, "run_id" | "space_id" | "metric_command">, timeoutMs?: number) {
  const wt = worktreesOf(app, goal.run_id).find((w) => w.space === goal.space_id);
  if (!wt) throw new HttpError(409, "找不到交办的仓库工作区");
  const rounds = all<{ id: string }>(app.db, "select id from runs where kind = 'code' and (id = ? or json_extract(input, '$.continueFrom') = ?) order by created_at desc, rowid desc limit 1", goal.run_id, goal.run_id);
  const result = await repositoryCommand(app, getRun(app, rounds[0].id), wt, goal.metric_command, new AbortController().signal, timeoutMs);
  const value = result.code === 0 ? metricValue(result.output) : null;
  return { value, why: value === null ? `度量失败（退出码 ${result.code}，超时也算失败；末行必须有数字）：\n${result.output.slice(-2000)}` : "", result };
}

/** A clock time means its next occurrence today or tomorrow in the configured timezone. */
export function improveUntil(time: string | undefined, timezone: string, at = Date.now()): string | null {
  if (!time) return null;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new HttpError(400, "until 写成 HH:mm（今天或明天，按设置的时区）");
  const format = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  for (let t = Math.ceil(at / 60000) * 60000; t <= at + 48 * 3600000; t += 60000) if (format.format(t) === time) return new Date(t).toISOString();
  throw new HttpError(400, "今天或明天没有这个本地时间");
}

/** Serialize independent tool calls, including CLI processes. A crashed command lease expires. */
async function locked<T>(app: App, root: string, fn: () => Promise<T>): Promise<T> {
  const key = `improve-lock:${root}`, value = String(Date.now());
  tx(app.db, () => {
    run(app.db, "delete from kv where key = ? and cast(value as integer) < ?", key, Date.now() - 45 * 60000);
    if (one(app.db, "select key from kv where key = ?", key)) throw new HttpError(409, "宿主正在度量或回退这次交办");
    run(app.db, "insert into kv(key,value) values(?,?)", key, value);
  });
  try { return await fn(); }
  finally { run(app.db, "delete from kv where key = ? and value = ?", key, value); }
}

type Start = { run_id: string; repo_space?: string; name: string; metric_command: string; direction: "down" | "up"; target?: number; max_rounds?: number; until?: string; protect?: string[]; min_gain?: number };
export async function startImprove(ctx: ToolContext, input: Start) {
  const { app } = ctx, delegation = improveDelegation(ctx, input.run_id);
  return locked(app, delegation.root, async () => {
    idle(improveDelegation(ctx, input.run_id).rounds);
    if (one(app.db, "select id from improve_goals where run_id = ? and state = 'running'", delegation.root)) throw new HttpError(409, "这次交办已有正在进行的改进目标");
    if (!input.repo_space && delegation.wts.length !== 1) throw new HttpError(400, "多个仓库时必须指定 repo_space");
    const wt = delegation.wts.find((w) => w.space === (input.repo_space ?? delegation.wts[0]?.space));
    if (!wt) throw new HttpError(400, "repo_space 不在这次交办中");
    const head = clean(wt), until = improveUntil(input.until, app.config.timezone);
    if (input.protect?.length) command(wt.path, ["ls-files", "--", ...input.protect.map((p) => `:(glob)${p}`)]);
    const result = await measure(app, { run_id: delegation.root, space_id: wt.space, metric_command: input.metric_command });
    if (result.value === null) throw new HttpError(400, result.why);
    if (clean(wt) !== head) throw new HttpError(409, "度量命令改了提交，不能建立基线");
    const at = now(), id = newId("ig");
    run(app.db, `insert into improve_goals(id,run_id,space_id,name,metric_command,direction,target,min_gain,max_rounds,until,protect,baseline,best,head,state,created_by,created_at,updated_at)
      values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'running',?,?,?)`, id, delegation.root, wt.space, input.name, input.metric_command, input.direction, input.target ?? null, input.min_gain ?? 0.01, input.max_rounds ?? 6, until, JSON.stringify(input.protect ?? []), result.value, result.value, head, ctx.userId ?? OWNER, at, at);
    const goal = improveGoal(app, id);
    if (targetReached(goal)) finish(app, goal, "done", "达到目标");
    app.emit({ type: "changed", entity: "code-task", id: delegation.root });
    return improveGoal(app, id);
  });
}

function targetReached(g: ImproveGoal) { return g.target !== null && (g.direction === "down" ? g.best <= g.target : g.best >= g.target); }
function finish(app: App, g: ImproveGoal, state: "done" | "stopped", reason: string) {
  run(app.db, "update improve_goals set state = ?, stop_reason = ?, updated_at = ? where id = ?", state, reason, now(), g.id);
  const rounds = improveRounds(app, g.id);
  const lines = rounds.map((r) => `- 第 ${r.seq} 轮：${r.note}；${r.before} → ${r.after ?? "未量出"}；${verdictText(r)}：${r.why}`);
  notify(app, { title: `改进目标${state === "done" ? "完成" : "停止"}：${g.name}`, body: `${reason}\n基线 → 最佳：${g.baseline} → ${g.best}\n\n留下的轮次：\n${lines.filter((_, i) => rounds[i].verdict === "kept").join("\n") || "无"}\n\n未留下的轮次：\n${lines.filter((_, i) => rounds[i].verdict !== "kept").join("\n") || "无"}\n\n本循环没有合并或推送分支。`, urgency: "later", userId: g.created_by, link: `#/runs/${g.run_id}`, runId: g.run_id });
}

export async function roundImprove(ctx: ToolContext, id: string, note: string, expect?: string): Promise<{ goal: ImproveGoal; round: ImproveRound | null; next?: string; stop?: string }> {
  const { app } = ctx, original = improveGoal(app, id), delegation = improveDelegation(ctx, original.run_id);
  return locked(app, delegation.root, async () => {
    const g = improveGoal(app, id);
    idle(improveDelegation(ctx, g.run_id).rounds);
    if (g.state !== "running") throw new HttpError(409, `目标已结束：${g.stop_reason}`);
    const wt = delegation.wts.find((w) => w.space === g.space_id);
    if (!wt) throw new HttpError(409, "找不到交办工作区");
    const tip = clean(wt), seq = g.rounds + 1;
    command(wt.path, ["merge-base", "--is-ancestor", g.head, tip]);
    const commits = command(wt.path, ["rev-list", "--topo-order", `${g.head}..${tip}`]).split(/\r?\n/).filter(Boolean);
    const row: ImproveRound = { goal_id: id, seq, at: now(), note, expect: expect ?? null, from_commit: g.head, to_commit: tip, before: g.best, after: null, verdict: "nothing", why: "没有新提交", revert_commit: null };
    if (commits.length) {
      const protectedPaths = new Set<string>();
      for (const sha of commits) if (g.protect.length) {
        const paths = command(wt.path, ["diff-tree", "--root", "--no-commit-id", "-r", "-m", "--no-renames", "--name-only", "-z", sha, "--", ...g.protect.map((p) => `:(glob)${p}`)]);
        for (const path of paths.split("\0").filter(Boolean)) protectedPaths.add(path);
      }
      row.verdict = "protected";
      row.why = `改了受保护路径：${[...protectedPaths].join("、")}`;
      if (!protectedPaths.size) {
        const cmd = checkCommandOf(app, delegation.last, g.space_id);
        let check: Check | null = null;
        if (cmd) {
          check = await repositoryCommand(app, delegation.last, wt, cmd, new AbortController().signal);
          const previous = getRun(app, delegation.last.id).output.improveChecks as { space: string; check: Check }[] | undefined;
          setRunOutput(app, delegation.last.id, { improveChecks: [...(previous ?? []), { space: g.space_id, check }] });
          addRunEvent(app, delegation.last.id, "check", { ...check, space: g.space_id, goal: id, round: seq });
        }
        row.verdict = "broken";
        row.why = check && check.code !== 0 ? `检查失败（退出码 ${check.code}）：\n${check.output.slice(-2000)}` : "";
        if (!row.why) {
          const measured = await measure(app, g);
          row.after = measured.value;
          row.why = measured.why;
          if (row.after !== null) {
            const gain = (g.direction === "down" ? g.best - row.after : row.after - g.best);
            const better = gain > 0 && (g.best === 0 || gain / Math.abs(g.best) >= g.min_gain - Number.EPSILON);
            row.verdict = better ? "kept" : "reverted";
            row.why = better ? "达到最小增益" : `没有变好（${g.best} → ${row.after}；最小相对增益 ${g.min_gain}）`;
          }
        }
      }
      // Commands may generate ignored artifacts, but must not edit tracked or untracked source files.
      if (clean(wt) !== tip) throw new HttpError(409, "检查或度量命令改了提交，请先处理工作区");
      if (row.verdict !== "kept") {
        try {
          // A merge already includes its side branch: undo first-parent commits to avoid undoing it twice.
          const undo = command(wt.path, ["rev-list", "--first-parent", `${g.head}..${tip}`]).split(/\r?\n/).filter(Boolean);
          for (const sha of undo) {
            const parents = command(wt.path, ["rev-list", "--parents", "-n", "1", sha]).split(" ");
            command(wt.path, ["revert", "--no-edit", "--no-commit", ...(parents.length > 2 ? ["-m", "1"] : []), sha]);
          }
          command(wt.path, [...identity(wt.path), "commit", "--allow-empty", "--no-verify", "-m", `回退第 ${seq} 轮：${row.why}`]);
          row.revert_commit = command(wt.path, ["rev-parse", "HEAD"]);
          if (command(wt.path, ["rev-parse", `${g.head}^{tree}`]) !== command(wt.path, ["rev-parse", "HEAD^{tree}"])) throw new Error("回退后的文件树与上一最佳版本不同");
          // settleRound leaves pooled worktrees detached. Preserve the new commits without applying
          // anything to a branch checked out in the owner's directory (the normal next round settles it).
          if (!checkedOutAt(wt.path, wt.branch, wt.path)) {
            const branchTip = command(wt.path, ["rev-parse", `refs/heads/${wt.branch}`]);
            command(wt.path, ["merge-base", "--is-ancestor", branchTip, row.revert_commit]);
            command(wt.path, ["update-ref", `refs/heads/${wt.branch}`, row.revert_commit, branchTip]);
            delete wt.pending;
          } else wt.pending = row.revert_commit;
          setRunOutput(app, g.run_id, { worktrees: delegation.wts });
          if (delegation.last.id !== g.run_id) setRunOutput(app, delegation.last.id, { worktrees: delegation.wts });
        } catch (e) {
          row.why += `；自动回退失败，需处理工作区：${(e as Error).message}`;
          saveRound(app, g, row, g.head);
          finish(app, improveGoal(app, id), "stopped", row.why);
          app.emit({ type: "changed", entity: "code-task", id: g.run_id });
          return { goal: improveGoal(app, id), round: row, stop: row.why };
        }
      }
    }
    saveRound(app, g, row, command(wt.path, ["rev-parse", "HEAD"]));
    const updated = improveGoal(app, id);
    const stop = targetReached(updated) ? "达到目标" : updated.rounds >= updated.max_rounds ? "预算用完" : updated.stale >= 4 ? "连着四轮没有变好" : updated.until && Date.now() > Date.parse(updated.until) ? "到点了" : null;
    if (stop) finish(app, updated, stop === "达到目标" ? "done" : "stopped", stop);
    app.emit({ type: "changed", entity: "code-task", id: g.run_id });
    return { goal: improveGoal(app, id), round: row, ...(stop ? { stop } : updated.stale === 2 ? { next: CHANGE_APPROACH } : {}) };
  });
}

function saveRound(app: App, g: ImproveGoal, r: ImproveRound, head: string) {
  tx(app.db, () => {
    run(app.db, `insert into improve_rounds(goal_id,seq,at,note,expect,from_commit,to_commit,before,after,verdict,why,revert_commit) values(?,?,?,?,?,?,?,?,?,?,?,?)`, r.goal_id, r.seq, r.at, r.note, r.expect, r.from_commit, r.to_commit, r.before, r.after, r.verdict, r.why, r.revert_commit);
    run(app.db, "update improve_goals set head = ?, best = ?, rounds = rounds + 1, stale = ?, updated_at = ? where id = ?", head, r.verdict === "kept" ? r.after! : g.best, r.verdict === "kept" ? 0 : g.stale + 1, now(), g.id);
  });
}

export function improveText(goal: ImproveGoal, rounds: ImproveRound[] = []) {
  return `改进目标 ${goal.id}：${goal.name}\n交办 ${goal.run_id} · 仓库 ${goal.space_id}\n度量：${goal.metric_command}（${goal.direction === "down" ? "越低越好" : "越高越好"}）\n基线 ${goal.baseline} → 最佳 ${goal.best}${goal.target === null ? "" : `；目标 ${goal.target}`}\n最小相对增益 ${goal.min_gain}；截止 ${goal.until ?? "未设"}；保护路径：${goal.protect.join("、") || "未设"}\n工作区提交：${goal.head}\n已做 ${goal.rounds} 轮，剩余 ${Math.max(0, goal.max_rounds - goal.rounds)} 轮；连着未留下 ${goal.stale} 轮\n状态：${goal.state === "running" ? "进行中" : goal.state === "done" ? "完成" : "停止"}${goal.stop_reason ? `；stop：${goal.stop_reason}` : ""}\n${rounds.map((r) => `第 ${r.seq} 轮：${r.note}${r.expect ? `；预期：${r.expect}` : ""}；${r.before} → ${r.after ?? "未量出"}；${verdictText(r)}：${r.why}\n提交 ${r.from_commit.slice(0, 8)} → ${r.to_commit.slice(0, 8)}${r.revert_commit ? `；回退提交 ${r.revert_commit.slice(0, 8)}` : ""}`).join("\n")}`;
}
