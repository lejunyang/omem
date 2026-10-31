import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { App } from "../core/app.ts";
import { all } from "../core/db.ts";
import { git, resolveRef } from "../core/git.ts";
import { getSpace } from "../core/spaces.ts";
import { HttpError, truncate } from "../core/util.ts";
import { materialsBrief } from "../items/materials.ts";
import type { CodeInput } from "./code.ts";
import { getRun, runUser, type Run } from "./runs.ts";
import { workDirOf } from "./workspaces.ts";

/**
 * Coding by an outside Agent on a paired device (delegate_code over `--peer`): this machine makes
 * the work branch, worktree and dependencies, then the other device's Agent reads, edits and runs
 * the commands the owner allowed for the repository through `code_workspace`. `finish` queues a
 * round that runs the checks and the review as for any delegation; nothing here asks a model to code.
 */

const PAGE = 400;
const MAX_WRITE = 1_000_000;
/** Arguments appended to an allowed command: no shell syntax, so `sh -c` only sees words. */
const SAFE_ARG = /^[\w@%+=:,.\/-]+$/;

type Job = { id: string; command: string; started: number; done: boolean; code: number | null; output: string; ms?: number };
const jobs = new Map<string, Job[]>();
// Ids keep counting after old jobs are dropped, so `output job=…` never finds a newer job under an old id.
const jobCount = new Map<string, number>();

function rootOf(app: App, runId: string) {
  const r = getRun(app, runId);
  return getRun(app, String((r.input as { continueFrom?: string }).continueFrom ?? r.id));
}

function rounds(app: App, rootId: string): Run[] {
  return all<{ id: string }>(app.db, "select id from runs where id = ? or (kind = 'code' and json_extract(input, '$.continueFrom') = ?) order by created_at", rootId, rootId).map((x) => getRun(app, x.id));
}

/** The delegation `runId` belongs to, checked against the calling device. */
function peerWork(app: App, runId: string, caller: string) {
  const root = rootOf(app, runId);
  const peer = root.kind === "code" ? (root.input as CodeInput).peerCoder : undefined;
  if (!peer) throw new HttpError(400, `运行 ${runId} 不是交给设备外部 Agent 编码的交办`);
  if (peer.caller !== caller) throw new HttpError(403, `这次交办交给的是设备 ${peer.caller}，不是 ${caller}`);
  if (root.output.appliedAt || root.output.discardedAt) throw new HttpError(409, "这次交办已经确认或丢弃，工作区已释放");
  const all = rounds(app, root.id);
  const worktrees = (root.output.worktrees ?? []) as { space: string; path: string; branch: string; base: string; start?: string; commits?: boolean }[];
  return { root, peer, all, last: all.at(-1)!, worktrees };
}

/**
 * A path's real location even when it does not exist yet: the nearest existing ancestor resolved
 * through links (the workspace may sit behind one, e.g. a home directory that is a link) plus the rest.
 */
function realish(path: string): string {
  let head = path;
  const rest: string[] = [];
  while (!existsSync(head)) {
    const parent = dirname(head);
    if (parent === head) return path;
    rest.unshift(basename(head));
    head = parent;
  }
  return join(realpathSync(head), ...rest);
}

/** The worktree a path is in (`space/path` when there are several) and the file's absolute path inside it. */
function locate(work: ReturnType<typeof peerWork>, path: string) {
  const { worktrees } = work;
  if (!worktrees.length) throw new HttpError(409, "工作区还在准备，稍后再试（brief 看状态）");
  let wt = worktrees[0];
  let rel = path.replace(/\\/g, "/").replace(/^\.?\//, "");
  if (worktrees.length > 1) {
    const hit = worktrees.find((w) => rel === w.space || rel.startsWith(`${w.space}/`));
    if (!hit) throw new HttpError(400, `几个仓库一起改时路径写成 仓库空间id/路径（${worktrees.map((w) => w.space).join("、")}）`);
    wt = hit;
    rel = rel.slice(wt.space.length + 1);
  }
  const dir = workDirOf(wt);
  if (isAbsolute(rel) || rel.split("/").includes("..")) throw new HttpError(400, "路径写成仓库里的相对路径");
  const abs = resolve(dir, rel || ".");
  const inside = relative(realpathSync(dir), realish(abs));
  if (inside.startsWith("..") || isAbsolute(inside)) throw new HttpError(400, "路径不在工作区里");
  if (/(^|\/)\.git(\/|$)/.test(rel)) throw new HttpError(400, "不能动 .git");
  return { wt, dir, rel, abs };
}

/** Editing waits while a round of the delegation is queued or running (checks, review). */
function editable(work: ReturnType<typeof peerWork>) {
  const busy = work.all.find((r) => r.status === "queued" || r.status === "running");
  if (busy) throw new HttpError(409, `第 ${work.all.indexOf(busy) + 1} 轮（${busy.id}）还在${busy.status === "queued" ? "排队" : "进行"}，等它结束再改`);
}

/** Commands the owner allows for a repository: `check`, `setup`, and the named lines of `peerCommands`. */
export function peerCommands(app: App, spaceId: string): Record<string, string> {
  const s = getSpace(app, spaceId).settings as { checkCommand?: string; setupCommand?: string; peerCommands?: string };
  const out: Record<string, string> = {};
  if (s.checkCommand?.trim()) out.check = s.checkCommand.trim();
  if (s.setupCommand?.trim() && s.setupCommand.trim() !== "none") out.setup = s.setupCommand.trim();
  for (const line of String(s.peerCommands ?? "").split("\n")) {
    const m = line.match(/^\s*([\w-]+)\s*[:：]\s*(.+?)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function runShell(command: string, cwd: string, job: Job, timeoutMs: number) {
  const isWin = process.platform === "win32";
  const child = spawn(isWin ? (process.env.ComSpec ?? "cmd.exe") : "sh", isWin ? ["/d", "/s", "/c", `"${command}"`] : ["-c", command], { cwd, windowsHide: true, windowsVerbatimArguments: isWin, env: { ...process.env, CI: "1" } });
  const add = (d: Buffer) => { job.output = (job.output + d.toString()).slice(-30000); };
  child.stdout.on("data", add);
  child.stderr.on("data", add);
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  return new Promise<void>((done) => {
    const end = (code: number) => {
      clearTimeout(timer);
      Object.assign(job, { done: true, code, ms: Date.now() - job.started });
      done();
    };
    child.on("close", (code) => end(code ?? -1));
    child.on("error", (e) => { job.output += String(e); end(-1); });
  });
}

const jobText = (j: Job) => j.done
  ? `命令 ${j.id}（${j.command}）结束，退出码 ${j.code}，用时 ${Math.round((j.ms ?? 0) / 1000)} 秒。输出末尾：\n${j.output.slice(-6000) || "（无输出）"}`
  : `命令 ${j.id}（${j.command}）还在运行（${Math.round((Date.now() - j.started) / 1000)} 秒）。稍后用 action=output、job=${j.id} 取结果。输出末尾：\n${j.output.slice(-2000) || "（暂无输出）"}`;

export type WorkspaceAction = {
  action: "brief" | "list" | "read" | "grep" | "write" | "edit" | "delete" | "run" | "output" | "git" | "import" | "finish";
  from_run?: string;
  path?: string;
  from?: number;
  content?: string;
  old?: string;
  new?: string;
  replace_all?: boolean;
  pattern?: string;
  command?: string;
  args?: string[];
  wait?: number;
  job?: string;
  git?: "status" | "diff" | "log" | "commit" | "merge" | "merge-abort";
  ref?: string;
  message?: string;
  summary?: string;
  review?: "peer" | "here";
};

export async function peerWorkspace(app: App, runId: string, caller: string, a: WorkspaceAction): Promise<string> {
  const work = peerWork(app, runId, caller);
  const { root, worktrees } = work;
  const multi = worktrees.length > 1;
  switch (a.action) {
    case "brief": {
      const input = root.input as CodeInput;
      const stage = work.last.status === "queued" || work.last.status === "running" ? `第 ${work.all.length} 轮${work.last.status === "queued" ? "排队中" : "进行中"}${worktrees.length ? "" : "（在准备工作区和依赖）"}` : String(work.last.output.verdict ?? work.last.status);
      const ws = worktrees.map((w) => {
        const cmds = peerCommands(app, w.space);
        return `- ${w.space}：分支 ${w.branch}（从 ${w.base.slice(0, 8)} 起）${Object.keys(cmds).length ? `\n  可以运行的命令（action=run，command 写名字，args 追加参数）：\n${Object.entries(cmds).map(([k, v]) => `  - ${k}：${v}`).join("\n")}` : "\n  本人没有给这个仓库设可以运行的命令（仓库设置里的检查命令、准备命令、设备 Agent 可运行的命令）"}`;
      }).join("\n");
      const item = input.itemId ? `\n\n${materialsBrief(app, input.itemId, runUser(app, root.id))}` : "";
      // A round queued from here (the owner's fix request) waits for this Agent: its task is the ask.
      const ask = work.last.id !== root.id && work.last.output.verdict === "awaiting-peer-code" ? `

## 这一轮的要求

${String(work.last.input.task ?? "")}` : "";
      const reviews = work.all.length > 1 ? `\n\n## 各轮\n\n${work.all.map((r, i) => `- 第 ${i + 1} 轮 ${r.id}：${r.status}${r.output.verdict ? `，${r.output.verdict}` : ""}`).join("\n")}\n\n评审要求修改时，在同一个工作区接着改，再 finish。评审结论用 read_run 看。` : "";
      return `# 交办 ${root.id}：${root.title}\n\n状态：${stage}\n\n## 任务\n\n${input.task}${item}\n\n## 工作区\n\n${ws || "（还在准备）"}${multi ? "\n\n路径写成 仓库空间id/路径。" : ""}\n\n## 怎么做\n\n用 action=list / read / grep 看代码，write / edit / delete 改文件，run 运行上面的命令，git 看状态、diff、提交（按功能分几次提交，不用 push）。改完用 action=finish 写一段说明：这台机器提交剩下的改动、运行检查命令，再按 review 交给评审（peer = 你自己用 review_task / submit_review 评审，here = 这台机器的评审 Agent）。${reviews}`;
    }
    case "list": {
      const { dir, rel } = locate(work, a.path ?? (multi ? worktrees[0].space : ""));
      const files = git(dir, ["ls-files", "--cached", "--others", "--exclude-standard", "--", rel || "."]).stdout.split("\n").filter(Boolean);
      const from = a.from ?? 0;
      return files.length ? `${files.length} 个文件${files.length > from + 500 ? `（第 ${from + 1}–${from + 500} 个，from=${from + 500} 接着取）` : ""}：\n${files.slice(from, from + 500).join("\n")}` : "没有文件";
    }
    case "read": {
      if (!a.path) throw new HttpError(400, "read 要给 path");
      const { abs } = locate(work, a.path);
      if (!existsSync(abs) || !statSync(abs).isFile()) throw new HttpError(404, `没有文件 ${a.path}`);
      const lines = readFileSync(abs, "utf8").split("\n");
      const from = Math.max(1, a.from ?? 1);
      const to = Math.min(lines.length, from + PAGE - 1);
      return `${a.path}（${lines.length} 行，第 ${from}–${to} 行${to < lines.length ? `，from=${to + 1} 接着读` : ""}）\n${lines.slice(from - 1, to).map((l, i) => `${from + i}\t${l}`).join("\n")}`;
    }
    case "grep": {
      if (!a.pattern) throw new HttpError(400, "grep 要给 pattern");
      const out: string[] = [];
      for (const w of worktrees) {
        const { dir, rel } = a.path ? locate(work, a.path) : { dir: workDirOf(w), rel: "" };
        if (a.path && dir !== workDirOf(w)) continue;
        const r = git(dir, ["grep", "-n", "-I", "--untracked", "-E", "-e", a.pattern, "--", rel || "."]);
        out.push(...r.stdout.split("\n").filter(Boolean).map((l) => (multi ? `${w.space}/${l}` : l)));
      }
      return out.length ? `${out.length} 处${out.length > 200 ? "（只列前 200 处，缩小 path 或 pattern）" : ""}：\n${out.slice(0, 200).map((l) => truncate(l, 300)).join("\n")}` : "没有找到";
    }
    case "write":
    case "edit":
    case "delete": {
      editable(work);
      if (!a.path) throw new HttpError(400, `${a.action} 要给 path`);
      const { abs } = locate(work, a.path);
      if (a.action === "delete") {
        if (!existsSync(abs)) throw new HttpError(404, `没有文件 ${a.path}`);
        rmSync(abs, { recursive: false });
        return `已删除 ${a.path}`;
      }
      if (a.action === "write") {
        if (a.content === undefined) throw new HttpError(400, "write 要给 content（整个文件）");
        if (a.content.length > MAX_WRITE) throw new HttpError(400, "文件太大");
        const existed = existsSync(abs);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, a.content);
        return `已${existed ? "覆盖" : "新建"} ${a.path}（${a.content.split("\n").length} 行）`;
      }
      if (a.old === undefined || a.new === undefined) throw new HttpError(400, "edit 要给 old 和 new");
      if (!existsSync(abs)) throw new HttpError(404, `没有文件 ${a.path}`);
      const text = readFileSync(abs, "utf8");
      const count = text.split(a.old).length - 1;
      if (!count) throw new HttpError(400, `${a.path} 里没有找到 old（要和文件完全一致，包括缩进）`);
      if (count > 1 && !a.replace_all) throw new HttpError(400, `old 在 ${a.path} 里出现 ${count} 次：多带几行上下文，或传 replace_all`);
      writeFileSync(abs, a.replace_all ? text.split(a.old).join(a.new) : text.replace(a.old, () => a.new!));
      return `已修改 ${a.path}（${a.replace_all ? count : 1} 处）`;
    }
    case "run": {
      editable(work);
      const w = multi ? worktrees.find((x) => x.space === (a.path ?? "").split("/")[0]) : worktrees[0];
      if (!w) throw new HttpError(400, `几个仓库时 path 写仓库空间 id（${worktrees.map((x) => x.space).join("、")}）`);
      const cmds = peerCommands(app, w.space);
      const base = a.command ? cmds[a.command] : undefined;
      if (!base) throw new HttpError(400, `只能运行本人给仓库 ${w.space} 设的命令：${Object.keys(cmds).join("、") || "（没有设）"}`);
      const bad = (a.args ?? []).find((x) => !SAFE_ARG.test(x));
      if (bad) throw new HttpError(400, `参数只能是文件路径、选项这类不带空格和 shell 符号的词：${bad}`);
      const list = jobs.get(root.id) ?? [];
      if (list.some((j) => !j.done)) throw new HttpError(409, `已有命令在运行：${list.filter((j) => !j.done).map((j) => j.id).join("、")}（action=output 看）`);
      const command = [base, ...(a.args ?? [])].join(" ");
      const n = (jobCount.get(root.id) ?? 0) + 1;
      jobCount.set(root.id, n);
      const job: Job = { id: `${a.command}-${n}`, command, started: Date.now(), done: false, code: null, output: "" };
      jobs.set(root.id, [...list.slice(-9), job]);
      const finished = runShell(command, workDirOf(w), job, 30 * 60_000);
      const waitMs = Math.min(100, Math.max(0, a.wait ?? 90)) * 1000;
      await Promise.race([finished, new Promise((r) => setTimeout(r, waitMs))]);
      return jobText(job);
    }
    case "output": {
      const list = jobs.get(root.id) ?? [];
      const job = a.job ? list.find((j) => j.id === a.job) : list.at(-1);
      if (!job) throw new HttpError(404, a.job ? `没有命令 ${a.job}（这台机器重启后不保留）` : "还没有运行过命令");
      if (!job.done && a.wait) await new Promise((r) => setTimeout(r, Math.min(100, a.wait!) * 1000));
      return jobText(job);
    }
    case "git": {
      const op = a.git ?? "status";
      const out: string[] = [];
      for (const w of worktrees) {
        const dir = workDirOf(w);
        const head = multi ? `## ${w.space}\n` : "";
        if (op === "status") out.push(head + (git(dir, ["status", "--short", "--branch"]).stdout.trim() || "（干净）"));
        else if (op === "log") out.push(head + (git(dir, ["log", "--oneline", "-30", `${w.start ?? w.base}..HEAD`]).stdout.trim() || "（这次交办还没有提交）"));
        else if (op === "diff") {
          const d = git(dir, ["diff", "--no-color", "HEAD", ...(a.path ? ["--", locate(work, a.path).rel] : [])]).stdout;
          const from = a.from ?? 0;
          out.push(head + (d ? `${d.slice(from, from + 30000)}${d.length > from + 30000 ? `\n…（from=${from + 30000} 接着取）` : ""}` : "（没有未提交的改动）"));
        } else if (op === "merge" || op === "merge-abort") {
          // Another branch's work merged in; conflicts stay in the files for this Agent to resolve,
          // then `commit` concludes the merge (or merge-abort gives it up).
          editable(work);
          if (op === "merge-abort") {
            const r = git(dir, ["merge", "--abort"]);
            out.push(`${head}${r.ok ? "已放弃合并" : `没有进行中的合并：${truncate(r.stderr, 200)}`}`);
            continue;
          }
          if (!a.ref?.trim()) throw new HttpError(400, "merge 要给 ref（要合并进来的分支，如 origin/feat/x）");
          if (git(dir, ["status", "--porcelain"]).stdout.trim()) throw new HttpError(409, "工作区有没提交的改动，先 commit 再合并");
          git(dir, ["fetch", "-q", "origin"]);
          const target = resolveRef(dir, a.ref.trim());
          if (!target) throw new HttpError(404, `没有分支 ${a.ref}`);
          const r = git(dir, ["merge", "--no-edit", "--no-verify", target.ref]);
          const conflicts = git(dir, ["diff", "--name-only", "--diff-filter=U"]).stdout.split("\n").filter(Boolean);
          if (r.ok) out.push(`${head}已合并 ${target.ref}（${target.commit.slice(0, 8)}）：${git(dir, ["log", "-1", "--format=%h %s"]).stdout.trim()}`);
          else if (conflicts.length) out.push(`${head}合并 ${target.ref} 有 ${conflicts.length} 个文件冲突，冲突标记留在文件里：\n${conflicts.join("\n")}\n逐个改好后用 git=commit 完成合并（或 merge-abort 放弃）。`);
          else throw new HttpError(500, `合并失败：${truncate(r.stderr || r.stdout, 500)}`);
        } else {
          editable(work);
          if (!a.message?.trim()) throw new HttpError(400, "commit 要给 message（遵守仓库的提交信息规范）");
          git(dir, ["add", "-A"]);
          if (!git(dir, ["status", "--porcelain"]).stdout.trim()) { out.push(`${head}没有要提交的改动`); continue; }
          const r = git(dir, ["commit", "-q", "--no-verify", "-m", a.message.trim()]);
          if (!r.ok) throw new HttpError(500, `提交失败：${truncate(r.stderr, 500)}`);
          out.push(`${head}已提交 ${git(dir, ["rev-parse", "--short", "HEAD"]).stdout.trim()}`);
        }
      }
      return out.join("\n\n");
    }
    case "import": {
      // Another delegation's unapplied changes (its saved patch) brought into this workspace, e.g.
      // an older run's work this one continues. Its base commit has to be here first (git=merge).
      editable(work);
      if (!a.from_run) throw new HttpError(400, "import 要给 from_run（要接过来的交办运行 id）");
      const other = rootOf(app, a.from_run);
      if (other.kind !== "code" || other.id === root.id) throw new HttpError(400, `运行 ${a.from_run} 不是另一次编码交办`);
      if (other.output.appliedAt || other.output.discardedAt) throw new HttpError(409, `交办 ${other.id} 已经确认或丢弃`);
      const { codePatches } = await import("./code.ts");
      const last = rounds(app, other.id).filter((r) => r.status === "done").at(-1) ?? other;
      const out: string[] = [];
      for (const { space, patch } of codePatches(app, last.id)) {
        const w = worktrees.find((x) => x.space === space);
        if (!w) { out.push(`${space}：这次交办没有这个仓库，跳过`); continue; }
        if (!patch.trim()) { out.push(`${space}：没有改动`); continue; }
        const dir = workDirOf(w);
        if (git(dir, ["status", "--porcelain"]).stdout.trim()) throw new HttpError(409, "工作区有没提交的改动，先 commit 再导入");
        const file = resolve(dir, `.git-import-${other.id}.patch`);
        writeFileSync(file, patch);
        const r = git(dir, ["apply", "--3way", "--whitespace=nowarn", file]);
        rmSync(file, { force: true });
        const conflicts = git(dir, ["diff", "--name-only", "--diff-filter=U"]).stdout.split("\n").filter(Boolean);
        const changed = git(dir, ["status", "--porcelain"]).stdout.split("\n").filter(Boolean).length;
        if (!r.ok && !conflicts.length) throw new HttpError(409, `${space}：没能应用交办 ${other.id} 的改动（它基于的提交可能还没合并进来，先 git=merge 它的基线）：${truncate(r.stderr, 600)}`);
        out.push(`${space}：已导入交办 ${other.id}（第 ${rounds(app, other.id).indexOf(last) + 1} 轮）的 ${changed} 个文件改动，未提交${conflicts.length ? `；${conflicts.length} 个文件有冲突标记：${conflicts.join("、")}` : ""}。核对后用 git=commit 提交。`);
      }
      return out.join("\n") || "那次交办没有保存的改动";
    }
    case "finish": {
      editable(work);
      if (!a.summary?.trim()) throw new HttpError(400, "finish 要写 summary：改了什么、怎么验证的、还有什么没做");
      const { queueStandaloneFix } = await import("./review-fix.ts");
      const peerReviewer = a.review === "here" ? undefined : { ...work.peer };
      const next = queueStandaloneFix(app, root.id, work.last.id, a.summary.trim(), runUser(app, root.id), { peerFinished: true, peerReviewer });
      return `已排队第 ${work.all.length + 1} 轮 ${next.id}：这台机器提交剩下的改动、运行检查命令，再${peerReviewer ? `等你评审（review_task，run_id=${next.id}，用 submit_review 逐项交）` : "交给这台机器的评审 Agent"}。进度用 read_run 看；评审要求修改就在同一个工作区接着改，再 finish。`;
    }
  }
}
