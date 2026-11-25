import type { App } from "../core/app.ts";
import { git } from "../core/git.ts";
import { HttpError, truncate } from "../core/util.ts";
import { repositoryCommand, worktreesOf, type Check } from "./code.ts";
import { checkCommandOf, checkHistoryOf as history, requireCheckEvidence, type CheckEvidence as Evidence } from "./code-check-state.ts";
import { gitDirOf, listTasks, retryTask, taskLabel, workRootOf } from "./code-tasks.ts";
import { getRun, setRunOutput, type Run } from "./runs.ts";
import { workDirOf } from "./workspaces.ts";

export type RepositoryCheckChoice = { space: string; mode: "full" | "focused" | "skip"; commands?: string[]; covers?: string[]; reruns_failure?: boolean; reason: string };
type Choice = RepositoryCheckChoice;

const wordsOnly = /^[\w./:@=-]+(?: +[\w./:@=-]+)*$/;
const testRunner = /^(?:(?:pnpm exec|npx|npm exec --) )?(?:vitest run|jest|playwright test|pytest|node --test)$/;
const testPath = /^(?:\.\/)?\w[\w./@-]*\.(?:[cm]?[jt]sx?|py)$/;

export function allowedCheckCommand(full: string, proposed: string, scripts: Record<string, unknown> = {}) {
  if (!wordsOnly.test(proposed)) return false;
  const command = proposed.replace(/ +/g, " ");
  const segments = new Set<string>();
  const expand = (source: string, depth: number) => {
    const parts = source.trim().split(/ *&& */);
    if (!parts.every(part => wordsOnly.test(part))) return;
    for (const raw of parts) {
      const part = raw.replace(/ +/g, " ");
      if (segments.has(part) || segments.size >= 100) continue;
      segments.add(part);
      const script = /^(?:npm|pnpm|yarn|bun) run ([\w:-]+)$/.exec(part)?.[1];
      if (script && depth < 5 && typeof scripts[script] === "string") expand(scripts[script], depth + 1);
    }
  };
  expand(full, 0);
  if (segments.has(command)) return true;
  return [...segments].some(part => {
    const filtered = /^pnpm --filter (\.\/[\w@][\w@./-]*) run ([\w:-]+)$/.exec(command);
    if (filtered && !filtered[1].split("/").includes("..") && [`pnpm -r run ${filtered[2]}`, `pnpm --recursive run ${filtered[2]}`].includes(part)) return true;
    const runner = command.startsWith(`${part} `) ? part : command.startsWith(`pnpm exec ${part} `) && !part.includes(" exec ") ? `pnpm exec ${part}` : "";
    if (!testRunner.test(part) || !runner) return false;
    const args = command.slice(runner.length + 1).split(" ");
    return args.every((arg, index) => testPath.test(arg) && !arg.split("/").includes("..") ||
      ((arg === "-t" || arg === "--testNamePattern" || arg === "--grep") && /^[\w-]+$/.test(args[index + 1] ?? "")) ||
      (index > 0 && ["-t", "--testNamePattern", "--grep"].includes(args[index - 1]) && /^[\w-]+$/.test(arg)));
  });
}

const documentation = (file: string) => /^(?:docs\/[^\n]+|README(?:\.[\w-]+)?)\.md$/i.test(file);

function facts(app: App, run: Run) {
  const root = workRootOf(app, run.id);
  const prior = history(app, root);
  return worktreesOf(app, root).flatMap(tree => {
    const full = checkCommandOf(app, run, tree.space);
    if (!full) return [];
    const path = workDirOf(tree);
    const head = git(path, ["rev-parse", "HEAD"]).stdout.trim();
    const rows = prior.filter(row => row.space === tree.space && row.full === full);
    const current = rows.find(row => row.mode === "full" && row.passed && row.head === head);
    const baseline = current ?? rows.find(row => row.mode === "full" && row.passed && git(path, ["merge-base", "--is-ancestor", row.head, head]).ok);
    const from = baseline?.head ?? tree.diffBase ?? tree.start ?? tree.base;
    const diff = git(path, ["diff", "--name-only", "--no-renames", "-z", from, head]);
    const files = diff.ok ? diff.stdout.split("\0").filter(Boolean) : null;
    const failure = rows[0] && !rows[0].passed ? rows[0] : undefined;
    const manifest = git(path, ["show", `${head}:package.json`]);
    let scripts: Record<string, unknown> = {};
    if (manifest.ok) try { scripts = JSON.parse(manifest.stdout)?.scripts ?? {}; } catch { /* Use only the configured command. */ }
    return [{ tree, full, head, baseline, files, failure, scripts }];
  });
}

export function reviewCheckFacts(app: App, run: Run) {
  const repos = facts(app, run);
  if (!repos.length) return "";
  const root = workRootOf(app, run.id);
  return [
    "## 仓库检查：随 `plan_review` 写 `repository_checks`（每仓库一项）",
    "`full` 跑配置的完整命令；`focused` 写配置（含 package.json 脚本）里的子命令或原测试工具加用例过滤，`covers` 列出全量通过后由这些检查覆盖的非文档文件、`reason` 说明依据；`skip` 只用于已有全量通过且无变动或只改文档。不填、无法核对或不满足交付覆盖时按全量。同一提交已通过不重复跑。上次失败时先选能重跑失败用例和覆盖新增改动的命令，并填 `reruns_failure: true`；没有全量基线时，这些命令通过后仍须全量。",
    ...repos.map(({ tree, full, baseline, files, failure }) => {
      const categories = new Map<string, string[]>();
      for (const file of files ?? []) {
        const key = `${documentation(file) ? "文档" : /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)|\.(?:spec|test)\./.test(file) ? "测试" : "代码或配置"} · ${file.includes("/") ? file.split("/")[0] : "仓库根目录"}`;
        categories.set(key, [...(categories.get(key) ?? []), file]);
      }
      return [`- ${tree.space}：完整命令 ${JSON.stringify(full)}；${baseline ? `上次全量通过 ${baseline.head}，用时 ${baseline.checks.at(-1)!.ms}ms` : "没有同历史上的全量通过记录"}`,
        files === null ? "变更路径不可核对" : files.length ? truncate([...categories].map(([key, paths]) => `  - ${key}：${paths.join("、")}`).join("\n"), 6000) : "无文件变更",
        failure ? `  - 上次没通过：${failure.checks.filter(check => check.code !== 0).map(check => `${check.command}\n${truncate(check.output.slice(-1600), 1600)}`).join("\n")}` : ""].filter(Boolean).join("\n");
    }),
    "### 编码 Agent 的单项验证",
    ...listTasks(app, root).flatMap(task => {
      const note = task.notes.findLast(note => note.kind === "coder" && note.text.includes("验证：")) ?? task.notes.findLast(note => note.kind === "coder");
      return note ? [`- ${taskLabel(task.seq)}：${truncate(note.text, 600)}`] : [];
    }),
  ].join("\n");
}

export function validateRepositoryChecks(app: App, run: Run, choices: Choice[]) {
  const known = new Map(facts(app, run).map(item => [item.tree.space, item]));
  const seen = new Set<string>();
  for (const choice of choices) {
    const repo = known.get(choice.space);
    if (!repo || seen.has(choice.space)) throw new HttpError(400, `${choice.space} 没有仓库检查命令或重复列出`);
    seen.add(choice.space);
    const commands = choice.commands ?? [];
    if (choice.mode !== "focused" && commands.length) throw new HttpError(400, "只有 focused 能填 commands");
    if (choice.mode === "focused" && (!commands.length || commands.some(command => !allowedCheckCommand(repo.full, command, repo.scripts))))
      throw new HttpError(400, `${choice.space} 的点名命令不是允许的配置子命令或测试过滤，改用 full 或改正命令`);
    if (choice.mode === "skip" && !canSkip(repo)) throw new HttpError(400, `${choice.space} 还没有全量基线，或有非纯文档变更，不能跳过`);
  }
}

type Facts = ReturnType<typeof facts>[number];
const canSkip = (repo: Facts) => !!repo.baseline && !repo.failure && !!repo.files?.every(documentation);

export async function runStageChecks(app: App, run: Run, choices: Choice[], signal: AbortSignal, event: (type: string, data: unknown) => void) {
  const evidence: Evidence[] = [];
  const earlier = (getRun(app, run.id).output.repositoryCheckEvidence ?? []) as Evidence[];
  const results = (getRun(app, run.id).output.repos ?? []) as ({ space: string; check: Check | null } & Record<string, unknown>)[];
  const repos = facts(app, run);
  for (const repo of repos) {
    const { tree, full, head, baseline, files } = repo;
    const status = git(workDirOf(tree), ["status", "--porcelain", "--untracked-files=no"]);
    if (!head || !status.ok || status.stdout.trim()) throw new HttpError(409, `${tree.space} 还有未提交的受跟踪改动，不能记录仓库检查通过`);
    const choice = choices.find(item => item.space === tree.space);
    const cached = baseline?.head === head;
    const commands = [...new Set(choice?.commands ?? [])];
    const focused = choice?.mode === "focused" && commands.length > 0 && commands.every(command => allowedCheckCommand(full, command, repo.scripts)) && (!repo.failure || choice.reruns_failure);
    const covered = !!baseline && !!files?.every(file => documentation(file) || choice?.covers?.includes(file));
    let mode: Choice["mode"] = cached || commands.includes(full) ? "full" : choice?.mode === "skip" && canSkip(repo) ? "skip" : focused && covered ? "focused" : "full";
    const reason = cached ? "同一提交已通过全量" : mode === choice?.mode ? choice.reason : "没有可核对的全量基线及变更覆盖，按全量检查";
    const checks: Check[] = cached ? baseline.checks : [];
    for (const command of cached || mode === "skip" ? [] : mode === "focused" ? commands : [...(focused && repo.failure ? commands : []), full].filter((command, index, all) => all.indexOf(command) === index)) {
      const scope = command === full ? "full" : "focused";
      event("status", { text: `${tree.space} 检查（${scope === "full" ? "全量" : "相关"}）：${command}` });
      const check = await repositoryCommand(app, run, tree, command, signal);
      if (signal.aborted) throw signal.reason;
      const changed = git(workDirOf(tree), ["status", "--porcelain", "--untracked-files=no"]);
      if (check.commit !== head || !changed.ok || changed.stdout.trim()) {
        check.code = 1;
        check.output += "\n检查改变了提交或受 Git 跟踪的文件，不能计为通过。";
      }
      checks.push(check);
      event("check", { ...check, space: tree.space, scope });
      if (check.code !== 0) { mode = scope; break; }
    }
    const failure = checks.find(check => check.code !== 0);
    const check = failure ?? checks.at(-1) ?? null;
    const output = results.find(result => result.space === tree.space);
    if (output) {
      const lessons = output.check?.command === "学到的约定" ? output.check : null;
      output.check = check && lessons ? { ...check, code: check.code || lessons.code, output: [check.output, lessons.output].filter(Boolean).join("\n\n") } : check ?? lessons;
    }
    const summary = failure ? `未通过：${failure.command}` : mode === "full" ? `全量通过于 ${head.slice(0, 12)}${cached ? "（复用）" : ""}` :
      `全量通过于 ${baseline!.head.slice(0, 12)}，之后${mode === "focused" ? `运行 ${commands.join("；")}` : "无代码变更，未重跑"}`;
    evidence.push({ space: tree.space, full, head, passed: !failure, ...(baseline ? { baseline: baseline.head } : {}), mode, reason, checks, summary });
    const saved = [...evidence, ...earlier.filter(previous => !evidence.some(current => current.space === previous.space && current.full === previous.full && current.head === previous.head))];
    setRunOutput(app, run.id, { repositoryCheckEvidence: saved });
  }
  setRunOutput(app, run.id, { repos: results, check: results.length === 1 ? results[0].check : undefined });
  return evidence.every(row => row.passed) && results.every(row => !row.check || row.check.code === 0);
}

export function assertStageCoverage(app: App, run: Run, spaces?: string[]) {
  const root = workRootOf(app, run.id);
  if (!getRun(app, root).input.taskMode) return;
  for (const tree of worktreesOf(app, root)) {
    if (spaces && !spaces.includes(tree.space)) continue;
    const full = checkCommandOf(app, run, tree.space);
    if (!full) continue;
    const path = gitDirOf(app, tree);
    const head = path ? git(path, ["rev-parse", tree.commits ? `refs/heads/${tree.branch}` : "HEAD"]).stdout.trim() : "";
    requireCheckEvidence(app, root, tree.space, full, head);
  }
}

export function checkEvidenceText(app: App, run: Run) {
  const rows = history(app, workRootOf(app, run.id));
  return [...new Set(rows.map(row => row.space))].map(space => `${space}：${rows.find(row => row.space === space)!.summary}`).join("\n\n");
}

export function returnFailedTasks(app: App, run: Run) {
  const root = workRootOf(app, run.id);
  const tasks = listTasks(app, root).filter(task => task.state === "done");
  for (const { tree, head, baseline } of facts(app, run)) {
    const failed = history(app, root).find(row => row.space === tree.space && row.head === head);
    if (!failed || failed.passed) continue;
    const path = workDirOf(tree);
    const from = baseline?.head ?? tree.diffBase ?? tree.start ?? tree.base;
    const newCommits = new Set(git(path, ["rev-list", `${from}..${head}`]).stdout.trim().split("\n"));
    const candidates = tasks.filter(task => task.commits[tree.space]?.some(sha => newCommits.has(sha)));
    const details = failed.checks.filter(check => check.code !== 0).map(check => `${check.command}：\n${check.output.slice(-2400)}`).join("\n");
    const named = candidates.filter(task => {
      const files = new Set(task.origin.files ?? []);
      for (const sha of task.commits[tree.space] ?? []) if (newCommits.has(sha)) {
        const diff = git(path, ["diff-tree", "--no-commit-id", "-r", "--no-renames", "--name-only", "-z", sha]);
        if (diff.ok) for (const name of diff.stdout.split("\0").filter(Boolean)) files.add(name);
      }
      return [...files].some(file => details.includes(file));
    });
    const chosen = named.length ? named : candidates.length === 1 ? candidates : [];
    for (const task of chosen) if (!listTasks(app, root).some(item => item.seq === task.seq && item.state === "todo"))
      retryTask(app, root, task.seq, { by: "host", kind: "host", text: `仓库检查未通过，请先重跑失败用例，再核实是否由本项导致：\n${details}` });
  }
}
