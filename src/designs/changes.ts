import type { App } from "../core/app.ts";
import { all, one } from "../core/db.ts";
import { git } from "../core/git.ts";
import { HttpError, now } from "../core/util.ts";
import { getRun, setRunOutput, type Run } from "../agents/runs.ts";
import { attributeFiles, designForWork, type Design } from "./store.ts";

/**
 * Where each decision landed in the code (docs/v2/coding-plan.md §2.4, §6.4 `changes` / `outside`),
 * from what the host has, not what a model says. A delegation: the tasks under each decision (an own
 * or someone else's design: the tasks naming it; a change description: the tasks it lists), their
 * commits and the files and lines those commits touch; the tasks under none are outside the design.
 * A branch review: the files its split put under each decision, counted on the review's diff. Line
 * counts come from commits or the saved patch; a workspace already cleaned up gives 0, not an error.
 */
export type ChangedFile = { space: string; path: string; add: number; del: number };
export type DecisionChange = {
  decision: string;
  tasks: { seq: number; title: string; state: string }[];
  commits: number;
  files: ChangedFile[];
  findings: { open: number; total: number };
};
/** The same shape as `/api/runs/:id/task-diff` (the web parses both alike). */
export type DesignPatch = { space: string; patch: string; label?: string; from?: string; to?: string; at?: string };

type TaskRow = { seq: number; title: string; state: string; origin: { decision?: string }; commits: Record<string, string[]>; kind: string };

/** `<repo id>/<path>` → its space and path (a path without the repository: the design's only repository, if it has one). */
function splitFile(design: Design, file: string): ChangedFile {
  const slash = file.indexOf("/");
  // With one repository a path may leave it out (`src/a.ts`); a prefix that is a repository is one.
  if (slash > 0 && (design.repos.includes(file.slice(0, slash)) || design.repos.length !== 1)) return { space: file.slice(0, slash), path: file.slice(slash + 1), add: 0, del: 0 };
  return { space: design.repos.length === 1 ? design.repos[0] : "", path: file, add: 0, del: 0 };
}

/** The work the design's code is in: its delegation or branch review (first run), if it still exists. */
function workOf(app: App, design: Design): Run | null {
  if (!design.workId) return null;
  const r = one<{ id: string }>(app.db, "select id from runs where id = ? and kind = 'code'", design.workId);
  return r ? getRun(app, r.id) : null;
}
const isBranch = (root: Run) => !!(root.input as { branches?: unknown }).branches;
const roundsOf = (app: App, rootId: string) => all<{ id: string }>(app.db, "select id from runs where kind = 'code' and (id = ? or json_extract(input, '$.continueFrom') = ?) order by created_at", rootId, rootId).map((r) => r.id);

function tasksOfWork(app: App, rootId: string): TaskRow[] {
  return all<{ seq: number; title: string; state: string; origin: string; commits: string; kind: string }>(app.db, "select seq, title, state, origin, commits, kind from code_tasks where work_id = ? order by seq", rootId)
    .map((t) => ({ seq: t.seq, title: t.title, state: t.state, kind: t.kind, origin: JSON.parse(t.origin || "{}"), commits: JSON.parse(t.commits || "{}") }));
}

/** Which tasks each decision has, and those under none. */
function taskSplit(design: Design, tasks: TaskRow[]) {
  const by = new Map<string, TaskRow[]>(design.body.decisions.map((d) => [d.id, []]));
  const placed = new Set<number>();
  for (const d of design.body.decisions) {
    const mine = design.origin === "derived" ? tasks.filter((t) => d.tasks?.includes(t.seq)) : tasks.filter((t) => t.origin.decision === d.id);
    by.set(d.id, mine);
    for (const t of mine) placed.add(t.seq);
  }
  // Outside: what was built or fixed under no decision (reverted and dropped tasks changed nothing that stays).
  const outside = tasks.filter((t) => !placed.has(t.seq) && !["reverted", "wontdo"].includes(t.state));
  return { by, outside };
}

/** Lines added and removed per file over some commits of one repository (numstat), or nothing when Git cannot say. */
function numstat(dir: string | null, shas: string[]): Map<string, { add: number; del: number }> {
  const out = new Map<string, { add: number; del: number }>();
  if (!dir) return out;
  for (const sha of shas) {
    const r = git(dir, ["show", "--numstat", "--format=", sha]);
    if (!r.ok) continue;
    for (const line of r.stdout.split("\n")) {
      const [a, d, path] = line.split("\t");
      if (!path) continue;
      const cur = out.get(path) ?? { add: 0, del: 0 };
      cur.add += Number(a) || 0;
      cur.del += Number(d) || 0;
      out.set(path, cur);
    }
  }
  return out;
}

async function repoDirs(app: App, rootId: string) {
  try {
    const { worktreesOf } = await import("../agents/code.ts");
    const { gitDirOf } = await import("../agents/code-tasks.ts");
    return new Map(worktreesOf(app, rootId).map((w) => [w.space, gitDirOf(app, w)]));
  } catch {
    return new Map<string, string | null>();
  }
}

function filesOfTasks(tasks: TaskRow[], dirs: Map<string, string | null>): ChangedFile[] {
  const files = new Map<string, ChangedFile>();
  const spaces = new Set(tasks.flatMap((t) => Object.keys(t.commits)));
  for (const space of spaces) {
    const shas = [...new Set(tasks.flatMap((t) => t.commits[space] ?? []))];
    for (const [path, n] of numstat(dirs.get(space) ?? null, shas)) {
      const key = `${space}/${path}`;
      const cur = files.get(key) ?? { space, path, add: 0, del: 0 };
      cur.add += n.add;
      cur.del += n.del;
      files.set(key, cur);
    }
  }
  return [...files.values()];
}

/** One file's sections of a unified diff, by path (the new path, else the old one). */
function patchSections(patch: string): { path: string; text: string }[] {
  const parts = patch.split(/^(?=diff --git )/m).filter((p) => p.startsWith("diff --git "));
  return parts.map((text) => {
    const head = /^diff --git a\/(.+?) b\/(.+)$/m.exec(text);
    const plus = /^\+\+\+ b\/(.+)$/m.exec(text)?.[1];
    return { path: plus ?? head?.[2] ?? head?.[1] ?? "", text };
  });
}
function sectionStat(text: string) {
  let add = 0, del = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) add++;
    else if (line.startsWith("-")) del++;
  }
  return { add, del };
}

/** A branch review's diff, file by file: what it changed, with the lines, keyed `<space>/<path>`. */
async function branchFiles(app: App, root: Run): Promise<Map<string, { space: string; path: string; text: string; add: number; del: number }>> {
  const out = new Map<string, { space: string; path: string; text: string; add: number; del: number }>();
  try {
    const { codePatches } = await import("../agents/code.ts");
    const last = roundsOf(app, root.id).at(-1) ?? root.id;
    for (const p of codePatches(app, last)) for (const s of patchSections(p.patch)) out.set(`${p.space}/${s.path}`, { space: p.space, path: s.path, text: s.text, ...sectionStat(s.text) });
  } catch {
    // The patch is gone (an old run): nothing to count.
  }
  return out;
}

/** Findings that name each decision, over every round of the work. */
function findingsBy(app: App, rootId: string): Map<string, { open: number; total: number }> {
  const rounds = roundsOf(app, rootId);
  const out = new Map<string, { open: number; total: number }>();
  if (!rounds.length) return out;
  const rows = all<{ d: string; state: string; decision: string | null }>(app.db, `select f.design_decision d, f.state, f.decision from review_findings f join reviews r on r.id = f.review_id
    where r.code_run_id in (${rounds.map(() => "?").join(",")}) and f.design_decision is not null`, ...rounds);
  for (const f of rows) {
    const c = out.get(f.d) ?? { open: 0, total: 0 };
    c.total++;
    if (["open", "accepted"].includes(f.state) && f.decision !== "wontfix" && f.decision !== "later") c.open++;
    out.set(f.d, c);
  }
  return out;
}

export async function designChanges(app: App, design: Design): Promise<{ changes: DecisionChange[]; outside: ChangedFile[] }> {
  const plain = () => ({
    changes: design.body.decisions.map((d) => ({ decision: d.id, tasks: [], commits: 0, files: (d.files ?? []).map((f) => splitFile(design, f)), findings: { open: 0, total: 0 } })),
    outside: (design.body.outside ?? []).map((f) => splitFile(design, f)),
  });
  const root = workOf(app, design);
  if (!root) return plain();
  const findings = findingsBy(app, root.id);
  if (isBranch(root)) {
    const diff = await branchFiles(app, root);
    const counted = (f: string): ChangedFile => {
      const file = splitFile(design, f);
      const d = diff.get(`${file.space}/${file.path}`);
      return d ? { ...file, add: d.add, del: d.del } : file;
    };
    return {
      changes: design.body.decisions.map((d) => ({ decision: d.id, tasks: [], commits: 0, files: (d.files ?? []).map(counted), findings: findings.get(d.id) ?? { open: 0, total: 0 } })),
      outside: (design.body.outside ?? []).map(counted),
    };
  }
  const tasks = tasksOfWork(app, root.id);
  if (!tasks.length) {
    const base = plain();
    return { ...base, changes: base.changes.map((c) => ({ ...c, findings: findings.get(c.decision) ?? c.findings })) };
  }
  const dirs = await repoDirs(app, root.id);
  const { by, outside } = taskSplit(design, tasks);
  return {
    changes: design.body.decisions.map((d) => {
      const mine = by.get(d.id) ?? [];
      const files = mine.length ? filesOfTasks(mine, dirs) : (d.files ?? []).map((f) => splitFile(design, f));
      return {
        decision: d.id,
        tasks: mine.map((t) => ({ seq: t.seq, title: t.title, state: t.state })),
        commits: new Set(mine.flatMap((t) => Object.values(t.commits).flat())).size,
        files,
        findings: findings.get(d.id) ?? { open: 0, total: 0 },
      };
    }),
    outside: filesOfTasks(outside, dirs),
  };
}

/**
 * One decision's patch (`outside`: the changes under none), in the shape of `/api/runs/:id/task-diff`:
 * a delegation's by the decision's tasks, a branch review's by the files put under it.
 */
export async function designDiff(app: App, design: Design, decision: string): Promise<{ patches: DesignPatch[] }> {
  if (decision !== "outside" && !design.body.decisions.some((d) => d.id === decision)) throw new HttpError(404, `方案 ${design.id} 没有决定 ${decision}`);
  const root = workOf(app, design);
  if (!root) throw new HttpError(404, "这份方案还没有关联的代码");
  if (isBranch(root)) {
    const diff = await branchFiles(app, root);
    const named = decision === "outside" ? design.body.outside ?? [] : design.body.decisions.find((d) => d.id === decision)!.files ?? [];
    const by = new Map<string, string[]>();
    for (const f of named) {
      const file = splitFile(design, f);
      const d = diff.get(`${file.space}/${file.path}`);
      if (d) by.set(file.space, [...(by.get(file.space) ?? []), d.text]);
    }
    // Both ends of the review's diff, so an editor can show the two sides of each file (`/api/runs/:id/file-at`).
    const { worktreesOf } = await import("../agents/code.ts");
    const ends = new Map(worktreesOf(app, root.id).map((w) => [w.space, w.tip ? { from: w.base, to: w.tip } : {}]));
    return { patches: [...by].map(([space, parts]) => ({ space, patch: parts.join(""), label: decision === "outside" ? "方案之外" : decision, ...ends.get(space) })) };
  }
  const tasks = tasksOfWork(app, root.id);
  const { by, outside } = taskSplit(design, tasks);
  const mine = decision === "outside" ? outside : by.get(decision) ?? [];
  const { worktreesOf } = await import("../agents/code.ts");
  const { workPatches } = await import("../agents/code-tasks.ts");
  try {
    if (mine.length) return { patches: await workPatches(app, root.id, worktreesOf(app, root.id), { tasks: mine.map((t) => t.seq) }) };
    // No task carries it (a work not driven by tasks, a change description that lists files): its
    // files' part of everything the work changed.
    const named = (decision === "outside" ? design.body.outside ?? [] : design.body.decisions.find((d) => d.id === decision)!.files ?? []).map((f) => splitFile(design, f));
    if (!named.length) return { patches: [] };
    const whole = await workPatches(app, root.id, worktreesOf(app, root.id), { work: true });
    return {
      patches: whole.flatMap((p) => {
        const parts = patchSections(p.patch).filter((s) => named.some((f) => f.path === s.path && (!f.space || f.space === p.space)));
        return parts.length ? [{ ...p, patch: parts.map((s) => s.text).join("") }] : [];
      }),
    };
  } catch {
    return { patches: [] };
  }
}

/**
 * A branch review's split onto its design (submit_change_points with `decisions`): each decision's
 * files, checked against the review's diff; the files left over are outside the design. The design's
 * text is not touched (attributeFiles).
 */
export async function attributeBranch(app: App, codeRun: Run, decisions: { decision: string; files: string[] }[]): Promise<string> {
  const rootId = String((codeRun.input as { continueFrom?: string }).continueFrom ?? codeRun.id);
  const root = getRun(app, rootId);
  const design = designForWork(app, rootId);
  if (!design || design.origin === "derived" || !design.revision) throw new HttpError(400, "这次评审没有对照方案：传 change_points 做需求拆分");
  if (!isBranch(root)) throw new HttpError(400, "按决定归属文件只用于分支评审；交办的改动按修改项挂在决定上");
  const diff = await branchFiles(app, root);
  const repos = Object.keys((root.input as { branches?: Record<string, unknown> }).branches ?? {});
  const norm = (f: string) => {
    const clean = f.trim().replace(/^\.?\//, "");
    if (diff.has(clean)) return clean;
    if (repos.length === 1 && diff.has(`${repos[0]}/${clean}`)) return `${repos[0]}/${clean}`;
    return null;
  };
  const known = new Set(design.body.decisions.map((d) => d.id));
  const badDecisions = decisions.filter((d) => !known.has(d.decision)).map((d) => d.decision);
  if (badDecisions.length) throw new HttpError(400, `方案 ${design.id} 没有决定 ${[...new Set(badDecisions)].join("、")}；有的是 ${[...known].join("、")}`);
  const unknown = decisions.flatMap((d) => d.files.filter((f) => !norm(f)));
  if (unknown.length) throw new HttpError(400, `这些文件不在这次的改动里：${[...new Set(unknown)].slice(0, 20).join("、")}；照 diff 里的路径写${repos.length > 1 ? "（几个仓库时写成 仓库空间id/路径）" : ""}`);
  const files: Record<string, string[]> = {};
  for (const d of decisions) files[d.decision] = [...new Set([...(files[d.decision] ?? []), ...d.files.map((f) => norm(f)!)])];
  const placed = new Set(Object.values(files).flat());
  const outside = [...diff.keys()].filter((k) => !placed.has(k));
  attributeFiles(app, design.id, { files, outside });
  const round = (codeRun.input as { round?: number }).round ?? 1;
  setRunOutput(app, codeRun.id, { designSplit: { round, designId: design.id, at: now() } });
  const empty = design.body.decisions.filter((d) => !files[d.id]?.length).map((d) => d.id);
  return `已把 ${placed.size} 个文件归到 ${Object.keys(files).filter((k) => files[k].length).length} 个决定上${outside.length ? `，${outside.length} 个文件在方案之外` : ""}${empty.length ? `；${empty.join("、")} 没有对应的改动` : ""}。`;
}
