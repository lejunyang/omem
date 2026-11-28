import { posix } from "node:path";
import { git } from "../core/git.ts";
import type { App } from "../core/app.ts";
import type { CodeTask } from "./code-tasks.ts";
import type { LongTask } from "./long-tasks.ts";
import { wakeSupervisor } from "./supervisor.ts";

export function checkTaskDuration(app: App, task: CodeTask): string | null {
  if (task.origin.deadline && Date.now() > Date.parse(task.origin.deadline)) return `T${task.seq} 超过指定时限 ${task.origin.deadline}`;
  if (!task.origin.startedAt) return null;
  const durations = app.db.prepare(`select (julianday(json_extract(origin,'$.finishedAt'))-julianday(json_extract(origin,'$.startedAt')))*86400000 ms
    from code_tasks where work_id=? and state='done' and id!=? and ms>0 order by ms`).all(task.workId, task.id) as { ms: number }[];
  if (!durations.length) return null;
  const middle = Math.floor(durations.length / 2);
  const median = (durations[middle].ms + durations[Math.floor((durations.length - 1) / 2)].ms) / 2;
  const elapsed = Date.now() - Date.parse(task.origin.startedAt);
  return elapsed > median * 3 ? `T${task.seq} 用时 ${Math.ceil(elapsed / 60000)} 分钟，超过其他已完成项中位数的三倍` : null;
}

export function inScope(scope: string[], repo: string, path: string) {
  return scope.some(entry => {
    const prefix = entry.trim().replace(/^\.\//, "").replace(/\/(?:\*\*)?$/, "");
    return prefix === "." || prefix === repo || [path, `${repo}/${path}`].some(p => p === prefix || p.startsWith(prefix + "/") || posix.matchesGlob(p, prefix));
  });
}

export function checkCheckpoint(app: App, task: LongTask, work: string, seq: number, repo: string, dir: string, middle: string, head: string) {
  if (middle === head) return;
  const paths = git(dir, ["diff", "--name-only", "--no-renames", "-z", middle, head]);
  const outside = paths.ok && task.brief.scope.length ? paths.stdout.split("\0").filter(p => p && !inScope(task.brief.scope, repo, p)) : [];
  if (outside.length) {
    const note = `交办 ${work} 检查点 ${seq}（${middle} → ${head}）\n超出任务书范围：${outside.slice(0, 20).map(p => repo + "/" + p).join("、")}`;
    wakeSupervisor(app, task.id, note, { immediate: true, drift: true });
  }
}
