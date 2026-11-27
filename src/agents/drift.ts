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

function inScope(scope: string[], repo: string, path: string) {
  return scope.some(entry => {
    const prefix = entry.trim().replace(/^\.\//, "").replace(/\/(?:\*\*)?$/, "");
    return prefix === "." || prefix === repo || [path, `${repo}/${path}`].some(p => p === prefix || p.startsWith(prefix + "/") || posix.matchesGlob(p, prefix));
  });
}

/** Both diffs end at the middle checkpoint. Equal added/removed lines at the same middle
 * coordinates mean the second change restored the first one, even if other hunks survived. */
function hunksAt(dir: string, from: string, middle: string): Map<string, string> {
  const result = git(dir, ["-c", "core.quotePath=false", "diff", "--no-ext-diff", "--no-renames", "--unified=0", from, middle]);
  const hunks = new Map<string, string>();
  if (!result.ok) return hunks;
  let file = "", key = "";
  let lines: string[] = [];
  function finish() {
    if (key && lines.length) hunks.set(JSON.stringify([file, key, lines]), file);
    key = "";
    lines = [];
  }
  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("diff --git ")) { finish(); file = ""; }
    else if (!key && line.startsWith("--- a/")) file = line.slice(6);
    else if (!key && line.startsWith("+++ b/")) file = line.slice(6);
    else if (line.startsWith("@@ ")) {
      finish();
      key = /\+(\d+(?:,\d+)?) @@/.exec(line)?.[1] ?? "";
    } else if (key && (line.startsWith("+") || line.startsWith("-") || line.startsWith("\\"))) lines.push(line);
  }
  finish();
  return hunks;
}

export function checkCheckpoint(app: App, task: LongTask, work: string, seq: number, repo: string, dir: string, before: string | undefined, middle: string, head: string) {
  if (middle === head) return;
  const paths = git(dir, ["diff", "--name-only", "--no-renames", "-z", middle, head]);
  const outside = paths.ok && task.brief.scope.length ? paths.stdout.split("\0").filter(p => p && !inScope(task.brief.scope, repo, p)) : [];
  const messages: string[] = [];
  if (outside.length) messages.push(`超出任务书范围：${outside.slice(0, 20).map(p => repo + "/" + p).join("、")}`);
  if (before && before !== middle) {
    const old = hunksAt(dir, before, middle);
    const restored = new Set([...hunksAt(dir, head, middle)].filter(([key]) => old.has(key)).map(([, file]) => file));
    if (restored.size) messages.push(`相邻两次检查点把同一段改回原样：${[...restored].slice(0, 20).map(p => repo + "/" + p).join("、")}`);
  }
  if (messages.length) wakeSupervisor(app, task.id, `交办 ${work} 检查点 ${seq}（${middle} → ${head}）\n${messages.join("\n")}`, { immediate: true, drift: true });
}
