import type { App } from "../core/app.ts";
import { all, run } from "../core/db.ts";
import { HttpError, json, now } from "../core/util.ts";
import { canWrite } from "../core/users.ts";
import { can } from "../auth/permissions.ts";
import { getItem } from "../items/store.ts";
import { codeWork } from "../agents/code-works.ts";
import { queueCodeWork } from "../agents/code-delegate.ts";
import { fixExecutions, studyScope } from "./scope.ts";
import { captureBaseline } from "./workspace.ts";
import { assertOwner, direction, findings, trial, type Finding } from "./store.ts";

/** What the trials run again after this finding's change say: null until every rerun has finished. */
export function fixVerified(app: App, f: Pick<Finding, "id" | "work_id">) {
  const reruns = all<{ id: string; result: string | null; state: string }>(app.db, "select id,result,state from study_trials where fix_of=? and work_id=? order by seq", f.id, f.work_id);
  const verified = reruns.some((t) => t.result === "failed") ? "failed" : !reruns.length || reruns.some((t) => ["queued", "running"].includes(t.state)) ? null : reruns.every((t) => t.result === "passed") ? "passed" : reruns.some((t) => t.result === "blocked") ? "blocked" : "unclear";
  return { verified, reruns: reruns.map((t) => t.id) };
}
export function findingFix(app: App, f: Finding) {
  const w = f.work_id ? codeWork(app, f.work_id) : null;
  return w ? { workId: w.rootId, status: w.stage.key, active: w.stage.group === "active", link: `#/runs/${w.latestId}`, ...fixVerified(app, f) } : null;
}
export async function fixFinding(app: App, itemId: string, finding: string, note: string | undefined, user: string) {
  assertOwner(app, itemId, user);
  if (!can(app, user, "code.delegate")) throw new HttpError(403, "没有交办编码的权限");
  const item = getItem(app, itemId);
  if (!canWrite(app, user, item.spaceId)) throw new HttpError(403, "事项空间不可写");
  return queueFindingFix(app, itemId, finding, note);
}
/** The owner action and unattended stages share enqueueing, baseline selection and ledger writes. */
export async function queueFindingFix(app: App, itemId: string, finding: string, note?: string) {
  const item = getItem(app, itemId), scope = studyScope(app, itemId);
  if (!scope.allowCode) throw new HttpError(409, "先在研究范围里打开可以改代码");
  const f = findings(app, itemId).find((f) => f.id === finding);
  if (!f) throw new HttpError(404, "没有这条发现");
  if (!["new", "confirmed", "later"].includes(f.state)) throw new HttpError(409, "这条发现的状态不能发起修改");
  if (f.fixed_at) throw new HttpError(409, "这条发现已标为改好");
  const previous = f.work_id ? codeWork(app, f.work_id) : null;
  if (previous && previous.stage.group !== "ended") throw new HttpError(409, "这条发现已有进行中的交办");
  if (!scope.repos.length) throw new HttpError(409, "先在研究范围里登记仓库");
  const evidence = json<string[]>(f.trials, []).map((id) => trial(app, id));
  const startCommits = evidence.length ? json<Record<string, string>>(direction(app, evidence[0].direction_id).baseline, {}) : {};
  const missing = scope.repos.filter((repo) => !startCommits[repo.id]);
  let fallbackNote = "";
  if (missing.length) {
    const { baseline, headFallbacks } = await captureBaseline(app, itemId);
    for (const repo of missing) {
      if (!baseline[repo.id]) throw new HttpError(409, `${repo.name} 没有可用的提交`);
      startCommits[repo.id] = baseline[repo.id];
    }
    fallbackNote = `这些仓库没有方向基线，改用发起时的当前提交：${missing.map((repo) => repo.name).join("、")}`;
    const fromHead = missing.filter((repo) => headFallbacks.has(repo.id));
    if (fromHead.length) fallbackNote += `\n${fromHead.map((repo) => repo.name).join("、")} 的代码索引基线引用不可用，使用本地 HEAD。`;
  }
  const task = [
    `## 发现：${f.title}\n${f.repro}`,
    `## 依据的试验\n${evidence.map((t) => `${t.id}\n对象：${t.object}\n检查：${t.check}\n结果：${t.result}\n摘要：${t.summary}\n证据引用：${t.evidence}`).join("\n\n")}`,
    note?.trim() ? `## 本人的要求\n${note.trim()}` : "",
    fallbackNote,
    "照这条发现的复现办法验收，交代改前和改后的结果。只处理挡住验收的问题和本次引入的回归；无关旧问题或可选改进另记，不作为续轮理由。\n改动只留在这次交办的分支上，不合并、不推送。",
  ].filter(Boolean).join("\n\n");
  // Called under studyOperation's per-item lock, so two clicks cannot create two works.
  const r = queueCodeWork(app, { spaceId: item.spaceId, userId: item.userId, title: f.title.slice(0, 80), input: { itemId, studyFindingId: f.id, repos: scope.repos.map((r) => r.id), task, startCommits, ...fixExecutions(scope) } });
  run(app.db, "update study_findings set work_id=?,state='confirmed',updated_at=? where id=?", r.id, now(), f.id);
  return findingFix(app, { ...f, work_id: r.id });
}
