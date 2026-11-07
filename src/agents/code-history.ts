import type { App } from "../core/app.ts";
import { all } from "../core/db.ts";
import { git, isGitRepo } from "../core/git.ts";
import { findSpace, spaceFamily } from "../core/spaces.ts";
import { HttpError, truncate } from "../core/util.ts";

/**
 * What omem knows about files before they are changed (docs/v2/pre-check.md): the requirement
 * points they implement, the delegations that changed them, the review findings raised on them and
 * the last commits. Looked up once by the host, read by the check before coding (business-analyst)
 * and by the history review after it (review-history), so both start from the same facts.
 */

type Finding = { severity: string; title: string; state: string; decision: string | null; fixed_by: string | null; line: number | null; check_name: string; code_run_id: string; created_at: string; file_path: string };
type Status = { node_id: string; title: string; status: string; at: string; run_id: string; locations: string };
type Work = { id: string; title: string; created_at: string; applied: string | null; discarded: string | null };

const STATUS: Record<string, string> = { done: "已实现", partial: "部分实现", missing: "没实现", extra: "需求外" };
const SEV: Record<string, string> = { blocker: "阻塞", major: "严重", minor: "一般", nit: "细节" };
const DECISION: Record<string, string> = { fix: "本人要改", later: "以后再做", wontfix: "本人说不改" };
const FINDING_STATE = (f: Finding) => (f.fixed_by ? "已修复" : f.decision ? DECISION[f.decision] ?? f.decision : ({ rejected: "驳回", merged: "合并到别的问题", accepted: "接受，待改", open: "没处理" } as Record<string, string>)[f.state] ?? f.state);

const norm = (p: string) => p.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
/** A stored path names the file: the same path, or the path under a repository folder (several repositories). */
const names = (stored: string, path: string) => {
  const s = norm(stored);
  return s === path || s.endsWith(`/${path}`) || path.endsWith(`/${s}`);
};

/** The repositories a space stands for: itself, or a business space's repositories. */
function reposOf(app: App, spaceId: string) {
  const ids = spaceFamily(app, spaceId);
  return ids.map((id) => findSpace(app, id)).filter((s): s is NonNullable<typeof s> => !!s?.rootPath && isGitRepo(s.rootPath));
}

/**
 * The history of some files of a repository (or of a business space's repositories: `仓库id/路径`
 * picks one). `spaces`: what the caller may read; runs and findings of other spaces are left out.
 */
export function codeHistory(app: App, o: { space: string; paths: string[]; spaces: string[] | null; limit?: number }): string {
  const repos = reposOf(app, o.space);
  if (!repos.length) throw new HttpError(400, `${o.space} 不是代码仓库，也没有挂代码仓库`);
  const limit = o.limit ?? 6;
  const readable = (space: string | null) => !o.spaces || (!!space && o.spaces.includes(space));
  const out: string[] = [];
  for (const raw of o.paths.slice(0, 20)) {
    let path = norm(raw);
    let repo = repos[0];
    const named = repos.find((r) => path.startsWith(`${r.id}/`));
    if (named) {
      repo = named;
      path = path.slice(named.id.length + 1);
    } else if (repos.length > 1) {
      const has = repos.find((r) => git(r.rootPath!, ["ls-files", "--error-unmatch", "--", path]).ok);
      if (has) repo = has;
    }
    const lines: string[] = [];

    // Requirement points located in it (review splits; later, tasks).
    const like = `%${path.split("/").pop()}%`;
    const statuses = all<Status & { space_id: string }>(app.db, `select s.node_id, n.title, s.status, s.at, s.run_id, s.locations, n.space_id from req_status s join req_nodes n on n.id = s.node_id
      where s.locations like ? and n.status = 'active' order by s.at desc limit 200`, like)
      .filter((s) => readable(s.space_id) && (JSON.parse(s.locations || "[]") as { file?: string }[]).some((l) => !!l.file && names(l.file, path)));
    const latest = new Map<string, Status>();
    for (const s of statuses) if (!latest.has(s.node_id)) latest.set(s.node_id, s);
    if (latest.size) lines.push(`需求点（${latest.size}）：${[...latest.values()].slice(0, 8).map((s) => `${s.title}（${STATUS[s.status] ?? s.status}，${s.at.slice(0, 10)}，req:${s.node_id}）`).join("；")}`);

    // Delegations that changed it: their tasks' planned files, findings and requirement locations.
    const fromTasks = all<{ work_id: string; origin: string; title: string }>(app.db, "select work_id, origin, title from code_tasks where origin like ? order by id desc limit 200", like)
      .filter((t) => ((JSON.parse(t.origin) as { files?: string[] }).files ?? []).some((f) => names(f, path)));
    const findings = all<Finding & { space_id: string | null }>(app.db, `select f.severity, f.title, f.state, f.decision, f.fixed_by, f.line, f.file_path, r.check_name, r.code_run_id, r.created_at, runs.space_id
      from review_findings f join reviews r on r.id = f.review_id join runs on runs.id = r.code_run_id
      where f.file_path like ? order by r.created_at desc limit 200`, like)
      .filter((f) => readable(f.space_id) && names(f.file_path, path));
    const rootOf = (id: string) => all<{ root: string }>(app.db, "select coalesce(json_extract(input, '$.continueFrom'), id) root from runs where id = ?", id)[0]?.root ?? id;
    const workIds = [...new Set([...fromTasks.map((t) => t.work_id), ...findings.map((f) => rootOf(f.code_run_id)), ...statuses.map((s) => rootOf(s.run_id))])];
    const works = workIds.flatMap((id) => all<Work & { space_id: string | null }>(app.db, `select id, title, created_at, space_id, json_extract(output, '$.appliedAt') applied, json_extract(output, '$.discardedAt') discarded from runs where id = ? and kind = 'code'`, id))
      .filter((w) => readable(w.space_id)).sort((a, b) => b.created_at.localeCompare(a.created_at));
    if (works.length) lines.push(`交办（${works.length}）：${works.slice(0, limit).map((w) => `「${truncate(w.title, 40)}」${w.created_at.slice(0, 10)}${w.applied ? " 已确认" : w.discarded ? " 已丢弃" : ""}（run:${w.id}）`).join("；")}`);
    if (findings.length) lines.push(`评审问题（${findings.length}）：\n${findings.slice(0, limit).map((f) => `  - [${SEV[f.severity] ?? f.severity}] ${truncate(f.title, 120)}${f.line ? `（第 ${f.line} 行）` : ""} · ${f.check_name} · ${f.created_at.slice(0, 10)} · ${FINDING_STATE(f)}（run:${rootOf(f.code_run_id)}）`).join("\n")}`);

    // The repository's own record.
    const log = git(repo.rootPath!, ["log", `-n${limit}`, "--follow", "--date=short", "--format=%h %ad %s", "--", path]);
    if (log.ok && log.stdout.trim()) lines.push(`最近的提交：\n${log.stdout.trim().split("\n").map((l) => `  ${truncate(l, 160)}`).join("\n")}`);
    else if (!git(repo.rootPath!, ["ls-files", "--error-unmatch", "--", path]).ok) lines.push("仓库里没有这个文件（新文件，或路径写错了）");

    out.push(`### ${repos.length > 1 ? `${repo.id}/` : ""}${path}\n${lines.length ? lines.join("\n") : "omem 里没有这个文件的记录（没有交办改过、没有评审问题、没有对上需求点）"}`);
  }
  return out.join("\n\n");
}
