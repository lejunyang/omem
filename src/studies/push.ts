import { resolve } from "node:path";
import type { z } from "zod";
import type { App } from "../core/app.ts";
import { all, run } from "../core/db.ts";
import { gitAsync } from "../core/git.ts";
import { getSpace } from "../core/spaces.ts";
import { HttpError, newId, now } from "../core/util.ts";
import { getRun } from "../agents/runs.ts";
import { worktreesOf } from "../agents/code.ts";
import { workDirOf } from "../agents/workspaces.ts";
import { getStage, itemFlow, type ItemFlow } from "../flows/store.ts";
import { getItem } from "../items/store.ts";
import { trial, direction } from "./store.ts";
import { studyScope } from "./scope.ts";
import { fixWorkspace } from "./workspace.ts";
import { studyPushSchema } from "./schema.ts";

export { studyPushSchema } from "./schema.ts";
export function pushAuthorized(app: App, item: string) {
  const s = studyScope(app, item);
  return !!s.pushRemote && !!s.pushPrefix && !!s.repos.length;
}
type Push = { id: string; trial_id: string; repo: string; remote: string; branch: string; commit: string; note: string; at: string };
export function studyPushes(app: App, item: string) {
  return all<Push>(app.db, "select * from study_pushes where item_id=? order by at desc,rowid desc limit 50", item).map((p) => ({ id: p.id, trialId: p.trial_id, repo: p.repo, remote: p.remote, branch: p.branch, commit: p.commit, note: p.note, at: p.at }));
}
export function pushSummary(app: App, f: ItemFlow) {
  const rows = all<{ branch: string }>(app.db, "select branch from study_pushes where item_id=? and flow_started_at=? and round=? order by at,rowid", f.itemId, f.startedAt, f.round);
  return `这一轮推送 ${rows.length} 次${rows.length ? `：${rows.map((p) => p.branch).join("、")}` : ""}`;
}
async function checked(cwd: string, args: string[]) {
  const r = await gitAsync(cwd, args, { timeoutMs: 60_000 });
  if (!r.ok) throw new HttpError(409, r.stderr.trim().slice(0, 1000) || "Git 命令失败");
  return r.stdout.trim();
}
/** Called under the item's serial lock; caller cannot supply a repository or a full ref. */
export async function studyPush(app: App, input: z.infer<typeof studyPushSchema>, runId: string | null, user: string) {
  const t = trial(app, input.trial), item = getItem(app, t.item_id), scope = studyScope(app, item.id);
  let repo = "", commit = "", branch = `${scope.pushPrefix}${item.id}/${input.name}`;
  try {
    studyPushSchema.parse(input);
    if (!runId || item.userId !== user || t.run_id !== runId) throw new HttpError(403, "只能推送这个运行自己的试验");
    const r = getRun(app, runId), f = itemFlow(app, item.id);
    const d = f?.definition.stages.find((s) => s.id === r.input.stageId);
    const s = d ? getStage(app, item.id, d.id) : null;
    const kind = typeof d?.by === "object" && "object" in d.by ? d.by.object : null;
    if (r.kind !== "study-trial" || !f || f.endedAt || f.startedAt !== r.input.flowStartedAt || f.round !== r.input.round || s?.state !== "doing" || s.control.runId !== r.id || t.state !== "running" || !(kind === "trials" && !t.fix_of || kind === "fixes" && t.fix_of)) throw new HttpError(403, "只有当前试验和改后重跑能推送");
    if (!pushAuthorized(app, item.id)) throw new HttpError(403, "课题没有登记推送授权");
    const cwd = typeof r.input.cwd === "string" ? r.input.cwd : "";
    const expected = t.work_id ? (await fixWorkspace(app, item.id, t.work_id)).cwd : (() => {
      const owner = direction(app, t.direction_id).workspace_run_id;
      return owner ? worktreesOf(app, owner)[0] && workDirOf(worktreesOf(app, owner)[0]) : undefined;
    })();
    if (!cwd || !expected || resolve(cwd) !== resolve(expected)) throw new HttpError(403, "运行目录不是试验工作区");
    const common = await checked(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    for (const p of scope.repos) {
      const root = getSpace(app, p.id).rootPath;
      if (root && resolve(await checked(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"])) === resolve(common) && resolve(root) !== resolve(cwd)) { repo = p.id; break; }
    }
    if (!repo) throw new HttpError(403, "工作区不属于范围内仓库");
    commit = await checked(cwd, ["rev-parse", "HEAD"]);
    if (await checked(cwd, ["status", "--porcelain", "--untracked-files=all"])) throw new HttpError(409, "工作区有未提交的改动，请先提交或丢弃");
    if (!(await checked(cwd, ["remote"])).split(/\r?\n/).includes(scope.pushRemote)) throw new HttpError(403, "登记的远端已不在仓库里");
    if (!scope.pushPrefix.endsWith("/") || /\.\.|\s|:/.test(scope.pushPrefix) || scope.pushRemote.startsWith("-")) throw new HttpError(403, "登记的推送范围不合法");
    await checked(cwd, ["check-ref-format", `refs/heads/${branch}`]);
    // One explicit refspec, no force, mirror, follow-tags or configured refspecs.
    await checked(cwd, ["-c", "remote." + scope.pushRemote + ".mirror=false", "-c", "push.followTags=false", "push", "--no-force", "--no-follow-tags", "--recurse-submodules=no", scope.pushRemote, `${commit}:refs/heads/${branch}`]);
    run(app.db, `insert into study_pushes(id,item_id,trial_id,repo,remote,branch,"commit",note,run_id,round,flow_started_at,at) values(?,?,?,?,?,?,?,?,?,?,?,?)`, newId("sp"), item.id, t.id, repo, scope.pushRemote, branch, commit, input.note, r.id, f.round, f.startedAt, now());
    run(app.db, "insert into audit_events(at,actor,action,target,detail) values(?,?,?,?,?)", now(), user, "study.push", item.id, JSON.stringify({ item: item.id, trial: t.id, repo, remote: scope.pushRemote, branch, commit, run: runId, note: input.note, success: true }));
    return `已推送到 ${scope.pushRemote} ${branch}，提交 ${commit}`;
  } catch (e) {
    run(app.db, "insert into audit_events(at,actor,action,target,detail) values(?,?,?,?,?)", now(), user, "study.push", item.id, JSON.stringify({ item: item.id, trial: t.id, repo, remote: scope.pushRemote, branch, commit, run: runId, note: input.note, success: false, error: (e as Error).message }));
    throw e;
  }
}
