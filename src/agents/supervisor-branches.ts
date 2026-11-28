import { can } from "../auth/permissions.ts";
import type { App } from "../core/app.ts";
import { all } from "../core/db.ts";
import { findSpace } from "../core/spaces.ts";
import { gitAsync } from "../core/git.ts";
import { truncate } from "../core/util.ts";
import { changeBase } from "./code-branch.ts";
import { worktreesOf } from "./code.ts";
import type { LongTask } from "./long-tasks.ts";

/** Only committed changes on these delegations' local branches. Never fetch or generate a patch. */
export async function supervisorBranches(app: App, task: LongTask & { sourceKind?: string | null; sourceId?: string | null }) {
  const roots = all<{ id: string }>(app.db, `select id from runs where kind='code'
    and json_extract(input,'$.longTaskId')=? and json_extract(input,'$.continueFrom') is null
    order by created_at desc limit 4`, task.id).map(r => r.id);
  if (task.sourceKind === "code" && task.sourceId) roots.unshift(task.sourceId);
  const summaries: string[] = [];
  for (const root of new Set(roots)) {
    for (const wt of worktreesOf(app, root)) {
      const repo = findSpace(app, wt.space);
      if (!wt.commits || !repo?.rootPath || (repo.id !== task.spaceId && repo.parentId !== task.spaceId)
        || !can(app, task.userId, "space.read", repo.id) || !can(app, task.userId, "code.review.view", repo.id)) continue;
      if (summaries.length === 4) return summaries.join("\n\n") + "\n其余工作分支已省略。";
      const label = truncate(`${root} · ${repo.id} · ${wt.branch}`, 220);
      const ref = wt.pending ?? `refs/heads/${wt.branch}`;
      const tip = await gitAsync(repo.rootPath, ["rev-parse", "--verify", ref + "^{commit}"], { timeoutMs: 3000 });
      if (!tip.ok) {
        summaries.push(label + "\n工作分支当前不可读取。");
        continue;
      }
      const head = tip.stdout.trim();
      const base = changeBase(repo.rootPath, wt, head);
      const [log, stat] = await Promise.all([
        gitAsync(repo.rootPath, ["log", "-5", "--no-color", "--format=%h %<(96,trunc)%s", base + ".." + head, "--"], { timeoutMs: 3000 }),
        gitAsync(repo.rootPath, ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--stat=100,65,12", base, head, "--"], { timeoutMs: 3000 }),
      ]);
      summaries.push([label, base.slice(0, 12) + ".." + head.slice(0, 12),
        log.ok ? truncate(log.stdout.trim(), 650) : "提交记录不可读取。",
        stat.ok ? truncate(stat.stdout.trim(), 1400) || "分支没有文件改动。" : "文件改动统计不可读取。",
      ].filter(Boolean).join("\n"));
    }
  }
  return summaries.join("\n\n");
}
