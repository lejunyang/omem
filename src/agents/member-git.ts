import { spawn, spawnSync } from "node:child_process";
import { closeSync, copyFileSync, createReadStream, readSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import type { App } from "../core/app.ts";
import { git } from "../core/git.ts";
import { sandboxSupport } from "./sandbox.ts";

type State = { tree: string; admin: string; common: string; ref: string; base: string; format: string; renameTo?: string; pending?: string };

const location = (app: App, actor: string, space: string) => join(app.runsDir, actor, "member-git", space);
const hooksOff = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "--no-replace-objects"];
function checked(dir: string, args: string[]) {
  const r = git(dir, [...hooksOff, ...args]);
  if (!r.ok) throw new Error(r.stderr.trim() || "Git 操作失败");
  return r.stdout.trim();
}
function save(file: string, state: State) {
  writeFileSync(file + ".new", JSON.stringify(state));
  renameSync(file + ".new", file);
}

/** Only the gitdir is writable in the agent namespace. The pointer and receipt stay host-owned. */
export function memberGitMount(app: App, actor: string, space: string, tree: string, common: string, branch?: string) {
  const root = location(app, actor, space);
  const dir = join(root, "git");
  const pointer = join(root, "pointer");
  const stateFile = join(root, "state");
  if (!existsSync(stateFile)) {
    const dot = join(tree, ".git");
    if (!lstatSync(dot).isFile()) throw new Error("成员提交需要独立的 Git 工作树");
    const line = readFileSync(dot, "utf8").trim();
    const admin = resolve(tree, line.slice("gitdir: ".length));
    if (!line.startsWith("gitdir: ") || dirname(admin) !== join(common, "worktrees") || realpathSync(admin) !== admin) throw new Error("Git 工作树与登记仓库不一致");
    const registeredTree = readFileSync(join(admin, "gitdir"), "utf8").trim();
    if (realpathSync(resolve(admin, registeredTree)) !== dot) throw new Error("Git 工作树与登记仓库不一致");
    const args = ["--git-dir", admin];
    const ref = git(common, [...args, "symbolic-ref", "-q", "HEAD"]).stdout.trim();
    if (ref && ref !== "refs/heads/" + branch) throw new Error("工作树已切换到其他分支");
    const base = checked(common, [...args, "rev-parse", "HEAD"]);
    const format = checked(common, [...args, "rev-parse", "--show-object-format"]);
    mkdirSync(dirname(root), { recursive: true });
    const tmp = mkdtempSync(join(dirname(root), ".prepare-"));
    try {
      const repo = join(tmp, "git");
      checked(tmp, ["init", "-q", "--bare", "--template=", "--object-format=" + format, repo]);
      writeFileSync(join(repo, "objects/info/alternates"), join(common, "objects") + "\n");
      const local = ["--git-dir", repo, "--work-tree", tree];
      checked(tmp, [...local, "config", "core.bare", "false"]);
      checked(tmp, [...local, "config", "user.name", "omem"]);
      checked(tmp, [...local, "config", "user.email", "omem@localhost"]);
      checked(tmp, [...local, "symbolic-ref", "HEAD", ref || "refs/heads/work"]);
      checked(tmp, [...local, "update-ref", "HEAD", base]);
      checked(tmp, [...local, "read-tree", base]);
      writeFileSync(join(tmp, "pointer"), "gitdir: " + dir + "\n");
      save(join(tmp, "state"), { tree, admin, common, ref, base, format });
      renameSync(tmp, root);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  }
  return { dir, pointer };
}

// Export with a fresh Git configuration. Only the assigned branch and its reachable objects
// cross the namespace as a pack. Git never opens the member's config or installs its refs.
const exportScript = `
set -eu
git init -q --template= --bare --object-format="$4" /view
export GIT_DIR=/view GIT_WORK_TREE=/work GIT_OBJECT_DIRECTORY=/member/objects
export GIT_ALTERNATE_OBJECT_DIRECTORIES=/base GIT_NO_REPLACE_OBJECTS=1
rm -r /view/refs
ln -s /member/refs /view/refs
ln -s /member/packed-refs /view/packed-refs
test "$(cat /member/HEAD)" = "ref: $1" || { echo '成员工作区已切换分支' >&2; exit 1; }
git symbolic-ref HEAD "$1"
git config core.bare false
git config core.hooksPath /dev/null
git config core.fsmonitor false
git config user.name omem
git config user.email omem@localhost
git merge-base --is-ancestor "$2" HEAD || { echo '成员提交没有从预期基点快进' >&2; exit 1; }
git read-tree HEAD
git add -A -- .
if ! git diff --cached --quiet --; then
  git -c gc.auto=0 commit -qm "$3"
  cp /view/index /member/index.next
  mv -fT /member/index.next /member/index
fi
tip=$(git rev-parse --verify 'HEAD^{commit}')
if test "$tip" != "$2"; then
  echo "$tip"
  printf '%s\\n' "$tip" "^$2" | git pack-objects --revs --stdout
fi
`;

function gitNamespace(state: State, root: string) {
  const support = sandboxSupport();
  if (!support.ok || !support.bwrap) throw new Error("接收成员提交需要可用的 bubblewrap");
  // The trusted binary and runtime libraries, the worktree, and the base objects are read-only.
  // Even a symlink/alternate supplied in the private object database resolves inside this view.
  const args = ["--die-with-parent", "--unshare-all", "--clearenv", "--setenv", "PATH", "/usr/bin:/bin",
    "--setenv", "GIT_CONFIG_NOSYSTEM", "1", "--setenv", "HOME", "/empty", "--dir", "/empty",
    ...["/usr", "/bin", "/lib", "/lib64"].flatMap(p => ["--ro-bind-try", p, p]), "--dev", "/dev", "--tmpfs", "/view",
    "--bind", join(root, "git"), "/member", "--ro-bind", state.tree, "/work", "--ro-bind", join(state.common, "objects"), "/base",
    "--ro-bind", join(state.common, "objects"), join(state.common, "objects"),
    "--chdir", "/work", "--"];
  return { file: support.bwrap, args };
}

async function exportPack(state: State, root: string, message: string, file: string) {
  const ns = gitNamespace(state, root);
  const args = [...ns.args, "/bin/sh", "-c", exportScript, "git-export", state.ref || "refs/heads/work", state.base, message, state.format];
  const fd = openSync(file, "wx", 0o600);
  try {
    await new Promise<void>((ok, fail) => {
      const proc = spawn(ns.file, args, { stdio: ["ignore", fd, "pipe"], timeout: 120_000 });
      let error = "";
      proc.stderr!.on("data", chunk => { error = (error + chunk).slice(-2048); });
      proc.on("error", fail);
      proc.on("close", code => code === 0 ? ok() : fail(new Error(error.trim() || "导出成员提交失败")));
    });
  } finally { closeSync(fd); }
}

/** A receipt records the requested name before either namespace moves, so the same request can resume. */
export function renameMemberGit(app: App, actor: string, space: string, old: string, next: string) {
  const root = location(app, actor, space);
  const file = join(root, "state");
  if (!existsSync(file)) return false;
  if (receiving.has(root)) throw new Error("正在接收此工作树的提交");
  const state: State = JSON.parse(readFileSync(file, "utf8"));
  const ref = "refs/heads/" + next;
  const previous = "refs/heads/" + old;
  const host = (...args: string[]) => checked(state.common, ["--git-dir", state.admin, ...args]);
  const current = host("symbolic-ref", "HEAD");
  if (state.ref === ref && current === ref) return true;
  if (state.ref !== previous || state.pending || (state.renameTo && state.renameTo !== ref) || host("rev-parse", "HEAD") !== state.base)
    throw new Error("工作树的接收登记或预期基点已变化");
  if (current !== previous && !(state.renameTo === ref && current === ref)) throw new Error("宿主工作树已切换分支");
  if (current === previous && git(state.common, ["show-ref", "--verify", "--quiet", ref]).ok) throw new Error(`已经有分支 ${next}`);
  const ns = gitNamespace(state, root);
  const script = `
set -eu
export GIT_DIR=/member GIT_WORK_TREE=/work
current=$(git symbolic-ref HEAD)
if test "$current" = "refs/heads/$1"; then
  git -c core.hooksPath=/dev/null -c core.fsmonitor=false branch -m -- "$1" "$2"
elif test "$3" != resume || test "$current" != "refs/heads/$2"; then
  echo '成员工作区已切换分支' >&2; exit 1
fi
`;
  save(file, { ...state, renameTo: ref });
  const r = spawnSync(ns.file, [...ns.args, "/bin/sh", "-c", script, "rename", old, next, state.renameTo ? "resume" : "start"], { encoding: "utf8", timeout: 10000 });
  if (r.status !== 0) {
    if (!state.renameTo && r.status !== null) save(file, state);
    throw new Error(r.stderr?.trim() || "成员分支改名没有完成");
  }
  if (current === previous) host("branch", "-m", "--", old, next);
  save(file, { ...state, ref, renameTo: undefined });
  return true;
}

/** Validate the pack in Git's indexer before changing a reference. No remote, tags or FETCH_HEAD. */
async function importPack(state: State, file: string) {
  const header = Buffer.alloc(state.format === "sha256" ? 65 : 41);
  const fd = openSync(file, "r");
  try {
    if (readSync(fd, header) !== header.length || header.at(-1) !== 10) throw new Error("成员交付的提交号不完整");
  } finally { closeSync(fd); }
  const tip = header.subarray(0, -1).toString("ascii");
  if (!/^[a-f0-9]+$/.test(tip)) throw new Error("成员交付的提交号无效");
  const proc = spawn("git", [...hooksOff, "--git-dir", state.admin, "index-pack", "--stdin", "--strict", "--fix-thin"], {
    cwd: state.common, stdio: ["pipe", "ignore", "pipe"], timeout: 120_000,
  });
  let error = "";
  proc.stderr.on("data", chunk => { error = (error + chunk).slice(-2048); });
  await Promise.all([
    new Promise<void>((ok, fail) => {
      proc.on("error", fail);
      proc.on("close", code => code === 0 ? ok() : fail(new Error(error.trim() || "成员提交的对象校验失败")));
    }),
    pipeline(createReadStream(file, { start: header.length }), proc.stdin),
  ]);
  return tip;
}

/** Last commit accepted into the host object store, even if a later handoff was refused. */
export function receivedMemberHead(app: App, actor: string, space: string): string | undefined {
  const file = join(location(app, actor, space), "state");
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as State).base : undefined;
}

const receiving = new Set<string>();

export async function receiveMemberGit(app: App, actor: string, space: string, tree: string, message: string) {
  const root = location(app, actor, space);
  const file = join(root, "state");
  if (!existsSync(file)) return false;
  if (receiving.has(root)) throw new Error("正在接收此工作树的提交");
  receiving.add(root);
  const pack = join(root, "incoming.pack");
  try {
    const state: State = JSON.parse(readFileSync(file, "utf8"));
    if (state.renameTo) throw new Error("工作分支正在改名，请先完成改名");
    if (realpathSync(tree) !== state.tree) throw new Error("交办工作树已变化");
    const args = ["--git-dir", state.admin, "--work-tree", state.tree];
    const host = (...cmd: string[]) => checked(state.common, [...args, ...cmd]);
    const verify = () => {
      const ref = git(state.common, [...args, "symbolic-ref", "-q", "HEAD"]).stdout.trim();
      const head = host("rev-parse", "HEAD");
      if (ref !== state.ref || (head !== state.base && head !== state.pending)) throw new Error("宿主工作树分支或预期基点已变化，保留成员提交");
      const stagedAt = (commit: string) => git(state.common, [...hooksOff, ...args, "diff-index", "--cached", "--quiet", commit, "--"]).ok;
      if (!stagedAt(state.base) && !(state.pending === head && stagedAt(head))) throw new Error("宿主暂存区已变化，保留成员提交");
      return head;
    };
    verify();
    rmSync(pack, { force: true });
    await exportPack(state, root, message, pack);
    if (!statSync(pack).size) {
      if (verify() !== state.base) throw new Error("成员分支与待接收的提交不一致");
      return true;
    }
    const tip = await importPack(state, pack);
    if (host("cat-file", "-t", tip) !== "commit") throw new Error("交付对象必须是提交");
    host("merge-base", "--is-ancestor", state.base, tip);
    // Reserve Git's index lock as checkout/add would. Prepare the replacement before moving
    // the ref, and keep the expected tip in the receipt until both updates are durable.
    const index = join(state.admin, "index");
    const lock = index + ".lock";
    closeSync(openSync(lock, "wx"));
    let ownsLock = true;
    try {
      const head = verify();
      const nextIndex = join(root, "next-index");
      const prepared = git(state.common, [...hooksOff, ...args, "read-tree", tip], undefined, { GIT_INDEX_FILE: nextIndex });
      if (!prepared.ok) throw new Error(prepared.stderr);
      copyFileSync(nextIndex, lock);
      if (head !== tip) {
        host("merge-base", "--is-ancestor", head, tip);
        save(file, { ...state, pending: tip });
        host("update-ref", "--no-deref", state.ref || "HEAD", tip, head);
      }
      renameSync(lock, index);
      ownsLock = false;
      save(file, { ...state, base: tip, pending: undefined });
    } finally { if (ownsLock) rmSync(lock, { force: true }); }
    return true;
  } finally { receiving.delete(root); rmSync(pack, { force: true }); }
}

/** Returns true when the host created a local fallback commit. */
export async function commitWorktree(app: App, actor: string, space: string, dir: string, message: string, identity: (dir: string) => string[]): Promise<boolean> {
  if (await receiveMemberGit(app, actor, space, dir, message)) return false;
  if (!existsSync(dir) || !git(dir, ["status", "--porcelain"]).stdout.trim()) return false;
  return git(dir, ["add", "-A"]).ok && git(dir, [...identity(dir), "commit", "-q", "--no-verify", "-m", message]).ok;
}
