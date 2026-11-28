import { can } from "../auth/permissions.ts";
import type { App } from "../core/app.ts";
import { all } from "../core/db.ts";
import { gitAsync } from "../core/git.ts";
import { findSpace } from "../core/spaces.ts";
import { truncate } from "../core/util.ts";
import { changeBase } from "./code-branch.ts";
import { worktreesOf } from "./code.ts";
import { inScope } from "./drift.ts";
import type { LongTask } from "./long-tasks.ts";

const limits = { timeoutMs: 3000, maxBuffer: 512 * 1024 };
const label = (s: string) => truncate(s.replace(/[\u0000-\u001f\u007f]/g, " "), 120);

function directoryStats(data: string, scope: string[], repo: string) {
  const dirs = new Map<string, { added: number; deleted: number; binary: number; outside: boolean }>();
  for (const record of data.split("\0")) {
    if (!record) continue;
    const first = record.indexOf("\t"), second = record.indexOf("\t", first + 1);
    const path = record.slice(second + 1), slash = path.indexOf("/");
    const dir = slash === -1 ? "（根目录）" : path.slice(0, slash) + "/";
    const stats = dirs.get(dir) ?? { added: 0, deleted: 0, binary: 0, outside: false };
    if (record.startsWith("-\t")) stats.binary++;
    else {
      stats.added += Number(record.slice(0, first));
      stats.deleted += Number(record.slice(first + 1, second));
    }
    if (scope.length && !inScope(scope, repo, path)) stats.outside = true;
    dirs.set(dir, stats);
  }
  return [...dirs].sort(([a, x], [b, y]) => Number(y.outside) - Number(x.outside) || a.localeCompare(b))
    .map(([dir, s]) => `${s.outside ? "【范围外】" : ""}${label(dir)} +${s.added} -${s.deleted}${s.binary ? "，二进制文件 " + s.binary : ""}`);
}

/** Each wake resumes at the last observed local tip. Git never reads file contents into the prompt. */
export async function supervisorBranches(app: App, task: LongTask, previous: [string, string][] = []) {
  const roots = all<{ id: string }>(app.db, `select id from runs where kind='code'
    and json_extract(input,'$.longTaskId')=? and json_extract(input,'$.continueFrom') is null
    order by created_at desc limit 4`, task.id).map(r => r.id);
  if (task.sourceKind === "code" && task.sourceId) roots.unshift(task.sourceId);
  const previousHeads = new Map(previous);
  const heads = new Map<string, string>(), sections: string[][] = [];
  for (const root of new Set(roots)) {
    if (sections.length === 4) break;
    for (const wt of worktreesOf(app, root)) {
      if (sections.length >= 4) break;
      const repo = findSpace(app, wt.space);
      if (!wt.commits || !repo?.rootPath || (repo.id !== task.spaceId && repo.parentId !== task.spaceId)
        || !can(app, task.userId, "space.read", repo.id) || !can(app, task.userId, "code.review.view", repo.id)) continue;
      const key = JSON.stringify([root, repo.id, wt.branch]);
      const previousHead = previousHeads.get(key);
      if (previousHead) heads.set(key, previousHead);
      const ref = wt.pending ?? `refs/heads/${wt.branch}`;
      const tip = await gitAsync(repo.rootPath, ["rev-parse", "--verify", ref + "^{commit}"], limits);
      const rows = [label(`${repo.id} · ${wt.branch} · ${root}`)];
      sections.push(rows);
      if (!tip.ok) { rows.push("工作分支当前不可读取。"); continue; }
      const head = tip.stdout.trim();
      const base = previousHead ?? changeBase(repo.rootPath, wt, head);
      if (base === head) { heads.set(key, head); rows.push("没有新提交。"); continue; }
      const [log, stat] = await Promise.all([
        gitAsync(repo.rootPath, ["log", "-5", "--no-color", "--format=%h %<(96,trunc)%s", base + ".." + head, "--"], limits),
        gitAsync(repo.rootPath, ["diff", "--numstat", "-z", "--no-ext-diff", "--no-textconv", "--no-renames", base, head, "--"], limits),
      ]);
      rows.push(...(log.ok ? log.stdout.trim().split("\n").filter(Boolean).map(label) : ["提交记录不可读取。"]));
      rows.push(...(stat.ok ? directoryStats(stat.stdout, task.brief.scope, repo.id) : ["目录统计不可读取或超出大小限制。"]));
      if (log.ok && stat.ok) heads.set(key, head);
    }
  }
  // Leave room for each branch, and surface out-of-scope directories first within its allowance.
  const lines = sections.flatMap((rows, i) => {
    const available = Math.floor(30 / sections.length) + Number(i < 30 % sections.length);
    if (rows.length <= available) return rows;
    const visible = rows.slice(0, available - 1);
    const outside = rows.find(row => row.startsWith("【范围外】"));
    if (outside && !visible.includes(outside)) visible[visible.length - 1] = outside;
    return [...visible, `其余 ${rows.length - visible.length} 行已省略。`];
  });
  return { heads: [...heads], text: lines.join("\n") };
}
