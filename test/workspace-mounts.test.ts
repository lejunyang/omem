import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { sandboxCommand, sandboxSupport } from "../src/agents/sandbox.ts";
import * as runner from "../src/agents/runner.ts";
import { registerRound, dispatchTasks, joinHelpers } from "../src/agents/code-helpers.ts";
import { finishSync } from "../src/agents/code-sync.ts";
import { receiveMemberGit } from "../src/agents/member-git.ts";
import { addTask, commitTask, getTask, settleCodingRound, updateTask } from "../src/agents/code-tasks.ts";
import { callTool, type ToolContext } from "../src/agents/tools.ts";
import { createRun, getRun, setRunOutput } from "../src/agents/runs.ts";
import { leaseWorkspace, workspaceMounts } from "../src/agents/workspaces.ts";
import { createSpace, getSpace } from "../src/core/spaces.ts";
import { testApp } from "./helpers.ts";

const app = testApp();
afterAll(() => {
  app.db.close();
  rmSync(app.home, { recursive: true, force: true });
});

function repository(id: string) {
  const root = mkdtempSync(join(app.home, "repo-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root });
  git("init", "-q");
  git("-c", "user.name=Test", "-c", "user.email=test@example.org", "commit", "-qm", "init", "--allow-empty");
  createSpace(app, { id, name: id, kind: "repo", rootPath: root });
  return { id, root, git };
}

const a = repository("web");
const b = repository("api");
function leased(run: string, repo = a) {
  const path = join(app.runsDir, run, "work", repo.id);
  const slot = leaseWorkspace(app, getSpace(app, repo.id), run, path, () => {})!.path;
  return { space: repo.id, path, slot, commits: true };
}
const lead = leased("lead");
const helper = leased("helper");
const helperApi = leased("helper", b);
const group = dirname(lead.path);
const inline = { space: b.id, path: join(group, b.id), commits: true };
b.git("worktree", "add", "-q", "--detach", inline.path);

describe("delegation sandbox mounts", () => {
  it("mounts the assigned slot and reads Git metadata from the registered repository", () => {
    expect(workspaceMounts(app, [lead])).toEqual({ ro: [realpathSync(join(a.root, ".git"))], rw: [realpathSync(lead.slot)], links: [] });
    // An unreadable checkout pointer must never cause discovery of another mount.
    const pointer = join(inline.path, ".git");
    const gitdir = realpathSync(join(b.root, ".git"));
    const original = readFileSync(pointer);
    writeFileSync(pointer, "gitdir: missing\n");
    try {
      expect(workspaceMounts(app, [inline])).toEqual({ ro: [gitdir], rw: [realpathSync(inline.path)], links: [] });
    } finally {
      writeFileSync(pointer, original);
    }
  });

  it("recreates the multi-repo links and mounts only the selected trees writable", () => {
    expect(workspaceMounts(app, [lead, inline])).toEqual({
      ro: [join(a.root, ".git"), join(b.root, ".git")].map(p => realpathSync(p)),
      rw: [lead.slot, inline.path].map(p => realpathSync(p)),
      links: [{ path: join(realpathSync(group), a.id), target: realpathSync(lead.slot) }],
    });
  });

  it("mounts the pre-check's slots and inline checkouts read-only through their assigned links", () => {
    const trees = [lead, inline];
    const plan = workspaceMounts(app, trees, undefined, "read");
    expect(plan.rw).toEqual([]);
    expect(plan.ro).toEqual([join(a.root, ".git"), join(b.root, ".git"), lead.slot, inline.path].map(p => realpathSync(p)));
    expect(plan.links).toEqual([{ path: join(realpathSync(group), a.id), target: realpathSync(lead.slot) }]);
  });

  it.skipIf(!sandboxSupport().ok)("reads a leased checkout through the multi-repo pre-check cwd", () => {
    const home = join(app.home, "pre-check-home");
    mkdirSync(home);
    const cmd = sandboxCommand({ file: "/bin/sh", prefix: [] }, ["-ec",
      'git -C web rev-parse HEAD && git -C api rev-parse HEAD && test ! -w web && test ! -w api && test ! -e "$1"', "sh", helper.slot],
      {}, group, { userId: "member", backend: "test", home, env: {}, hide: [app.home], ro: [] }, workspaceMounts(app, [lead, inline], undefined, "read"));
    execFileSync(cmd.file, cmd.args, { env: cmd.env });
  });

  it("uses the helper's lease for the same repository", () => {
    expect(workspaceMounts(app, [helper])).toEqual({ ro: [realpathSync(join(a.root, ".git"))], rw: [realpathSync(helper.slot)], links: [] });
  });

  it("assigns a separate gitdir and read-only pointer to each member checkout", () => {
    expect(workspaceMounts(app, [{ ...lead, commits: false }], "legacy").pointers).toBeUndefined();
    const plan = workspaceMounts(app, [lead, inline], "multi");
    expect(plan.pointers?.map(p => p.path)).toEqual([join(realpathSync(lead.slot), ".git"), join(realpathSync(inline.path), ".git")]);
    for (const { source } of plan.pointers!) {
      const dir = readFileSync(source, "utf8").trim().slice(8);
      expect(plan.rw).toContain(dir);
      expect(plan.rw).not.toContain(dirname(dir));
    }
    expect(plan.rw).not.toContain(realpathSync(join(a.root, ".git")));
  });

  it.skipIf(!sandboxSupport().ok)("accepts only the assigned branch's fast-forward from the member sandbox", async () => {
    const repo = repository("member-repo");
    const wt = leased("member-round", repo);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: wt.slot, encoding: "utf8" }).trim();
    git("checkout", "-qb", "topic");
    const sibling = leased("another-round", repo);
    const siblingAdmin = execFileSync("git", ["rev-parse", "--absolute-git-dir"], { cwd: sibling.slot, encoding: "utf8" }).trim();
    const base = git("rev-parse", "HEAD");
    const actor = "member-round";
    const plan = workspaceMounts(app, [{ ...wt, branch: "topic" }], actor);
    const home = join(app.home, "member-home");
    mkdirSync(home);
    const acct = { userId: "member", backend: "test", home, env: {}, hide: [app.home], ro: [] };
    const run = (script: string, ...args: string[]) => {
      const cmd = sandboxCommand({ file: "/bin/sh", prefix: [] }, ["-ec", script, "sh", ...args], {}, wt.slot, acct, plan);
      return execFileSync(cmd.file, cmd.args, { env: cmd.env, encoding: "utf8" }).trim();
    };
    run('test -f "$1" && test ! -w "$1" && test -f "$2" && test ! -w "$2"', join(repo.root, ".git/config"), join(siblingAdmin, "HEAD"));
    const tip = run('echo hello > example && git add example && git commit -qm "direct commit" && git branch private-only && git rev-parse HEAD');
    expect(git("rev-parse", "HEAD")).toBe(base);
    const privateDir = readFileSync(plan.pointers![0].source, "utf8").trim().slice(8);
    writeFileSync(join(privateDir, "config"), "[invalid");
    const round = createRun(app, { kind: "code", spaceId: repo.id, title: "交付" });
    const task = addTask(app, round.id, { title: "task fallback", kind: "build" }, "host");
    const accept = () => commitTask(app, actor, round.id, task.seq, [{ ...wt, branch: "topic", base }], () => []);
    writeFileSync(join(wt.slot, "staged"), "host edit");
    git("add", "staged");
    await expect(accept()).rejects.toThrow("宿主暂存区已变化");
    expect(git("show", ":staged")).toBe("host edit");
    expect(git("rev-parse", "HEAD")).toBe(base);
    git("restore", "--staged", "staged");
    rmSync(join(wt.slot, "staged"));
    const hook = join(repo.root, ".git/hooks/reference-transaction");
    writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    await accept();
    expect(git("rev-parse", "HEAD")).toBe(tip);
    expect(git("status", "--porcelain")).toBe("");
    expect(git("branch", "--list", "private-only")).toBe("");
    await accept();
    writeFileSync(join(wt.slot, "second"), "second task");
    await accept();
    expect(git("log", "-1", "--format=%s")).toBe("task fallback");
    rmSync(hook);
    git("switch", "--detach");
    await expect(accept()).rejects.toThrow("分支或预期基点已变化");
    git("switch", "topic");
    git("-c", "user.name=Test", "-c", "user.email=test@example.org", "commit", "--allow-empty", "-qm", "concurrent");
    await expect(accept()).rejects.toThrow("预期基点已变化");
    expect(git("log", "-1", "--format=%s")).toBe("concurrent");
  });

  it.skipIf(!sandboxSupport().ok)("stages only the conflicted file edited in the member sandbox", async () => {
    const repo = repository("resolve-text");
    const file = "决策 [1].md";
    const commit = (cwd: string, value: string) => {
      writeFileSync(join(cwd, file), value);
      execFileSync("git", ["--literal-pathspecs", "add", "--", file], { cwd });
      execFileSync("git", ["-c", "user.name=T", "-c", "user.email=test@example.org", "commit", "-qm", value], { cwd });
    };
    writeFileSync(join(repo.root, ".gitattributes"), "*.md conflict-marker-size=5\n");
    repo.git("add", ".gitattributes");
    commit(repo.root, "base");
    const wt = leased("resolve-round", repo);
    commit(wt.slot, "ours");
    commit(repo.root, "theirs");
    const tip = repo.git("rev-parse", "HEAD").toString().trim();
    expect(() => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=test@example.org", "merge", tip], { cwd: wt.slot })).toThrow();
    const home = join(app.home, "resolve-home");
    mkdirSync(home);
    const left = await finishSync(wt.path, "合并", async files => {
      expect(files).toEqual([file]);
      const cmd = sandboxCommand({ file: "/bin/sh", prefix: [] }, ["-ec", 'printf "combined\\n=======\\n" > "$1"; echo draft > draft', "sh", file],
        {}, wt.slot, { userId: "member", backend: "test", home, env: {}, hide: [app.home], ro: [] }, workspaceMounts(app, [wt]));
      execFileSync(cmd.file, cmd.args, { env: cmd.env });
    });
    expect(left).toBeNull();
    expect(repo.git("-C", wt.slot, "show", "HEAD:" + file).toString()).toBe("combined\n=======\n");
    expect(repo.git("-C", wt.slot, "status", "--porcelain").toString().trim()).toBe("?? draft");
  });

  it.skipIf(!sandboxSupport().ok).each(["lead", "helper"])("finish_task receives a partial commit and the %s's remaining files", async (role) => {
    const repo = repository("partial-" + role);
    const round = createRun(app, { kind: "code", spaceId: repo.id, title: "交付", input: { taskMode: true } });
    app.db.prepare("update runs set status = 'running' where id = ?").run(round.id);
    const actor = role === "lead" ? round : createRun(app, { kind: "agent", spaceId: repo.id, title: "助手", parentId: round.id, input: { helperOf: round.id } });
    const wt = leased(actor.id, repo);
    const base = repo.git("rev-parse", "HEAD").toString().trim();
    setRunOutput(app, actor.id, { worktrees: [{ ...wt, base }] });
    const task = addTask(app, round.id, { title: "交付剩余文件", kind: "build" }, "host");
    updateTask(app, round.id, task.seq, { state: "coding", coderRun: actor.id });
    const home = join(app.home, "home-" + role);
    mkdirSync(home);
    const cmd = sandboxCommand({ file: "/bin/sh", prefix: [] }, ["-ec",
      'echo first > initial && git add initial && git commit -qm "partial" -m "Omem-Task: T1" && git rev-parse HEAD && echo last > remaining'],
      {}, wt.slot, { userId: "member", backend: "test", home, env: {}, hide: [app.home], ro: [] }, workspaceMounts(app, [wt], actor.id));
    const first = execFileSync(cmd.file, cmd.args, { env: cmd.env, encoding: "utf8" }).trim();
    const ctx = { app, runId: actor.id, spaceId: repo.id, spaces: null, tools: null, actor: "agent", role: "coder" } as ToolContext;
    const result = await callTool(ctx, "finish_task", { task: task.seq, summary: "代码与测试已完成" });
    expect(result.isError, result.text).toBe(false);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: wt.path, encoding: "utf8" }).trim();
    expect(git("rev-parse", "HEAD^")).toBe(first);
    expect(git("show", "HEAD:remaining")).toBe("last");
    expect(git("log", "-1", "--format=%B")).toContain("Omem-Task: T" + task.seq);
    expect(getTask(app, round.id, task.seq).state).toBe(task.verifier ? "verify" : "done");
  });

  it.skipIf(!sandboxSupport().ok)("merges accepted helper work and keeps a refused repository recoverable", async () => {
    const repos = [repository("partial-a"), repository("partial-b")];
    const round = createRun(app, { kind: "code", spaceId: repos[0].id, title: "多仓交付", input: { taskMode: true } });
    app.db.prepare("update runs set status = 'running' where id = ?").run(round.id);
    const trees = repos.map(repo => ({ ...leased(round.id, repo), branch: "", base: repo.git("rev-parse", "HEAD").toString().trim() }));
    const tasks = repos.map(repo => addTask(app, round.id, { title: repo.id, kind: "build" }, "host").seq);
    for (const seq of tasks) updateTask(app, round.id, seq, { state: "coding", coderRun: round.id });
    const home = join(app.home, "partial-helper-home");
    mkdirSync(home);
    const fake = vi.spyOn(runner, "runRole").mockImplementation(async (_, input) => {
      const actor = input.runId!;
      const worktrees = input.worktrees!;
      const plan = workspaceMounts(app, worktrees, actor);
      const run = (script: string) => {
        const cmd = sandboxCommand({ file: "/bin/sh", prefix: [] }, ["-ec", script], {}, input.cwd!,
          { userId: "member", backend: "test", home, env: {}, hide: [app.home], ro: [] }, plan);
        execFileSync(cmd.file, cmd.args, { env: cmd.env });
      };
      run('cd partial-a && echo first > first && git add first && git commit -qm "Omem-Task: T1"');
      const ctx = { app, runId: actor, spaceId: repos[0].id, spaces: null, tools: null, actor: "agent", role: "coder" } as ToolContext;
      const result = await callTool(ctx, "finish_task", { task: tasks[0], summary: "第一项完成" });
      expect(result.isError, result.text).toBe(false);
      run('cd partial-a && echo part > part && git add part && git commit -qm "Omem-Task: T2"');
      run('cd partial-b && git switch -qc private && echo other > other && git add other && git commit -qm "Omem-Task: T2" && echo draft > draft');
      return { text: "完成" } as Awaited<ReturnType<typeof runner.runRole>>;
    });
    try {
      registerRound(round.id, { worktrees: trees, repos: repos.map(repo => getSpace(app, repo.id)), spaces: repos.map(repo => repo.id),
        signal: new AbortController().signal, event: () => {}, where: dir => dir });
      dispatchTasks(app, round.id, [{ tasks }]);
      writeFileSync(join(trees[0].path, "first"), "lead");
      repos[0].git("-C", trees[0].path, "add", "first");
      repos[0].git("-C", trees[0].path, "-c", "user.name=T", "-c", "user.email=t@example.org", "commit", "-qm", "lead");
      const ids = await joinHelpers(app, round.id, async (wt, files) => {
        expect(files).toEqual(["first"]);
        const cmd = sandboxCommand({ file: "/bin/sh", prefix: [] }, ["-ec", 'printf "first\\n=======\\n" > first'],
          {}, wt.path, { userId: "member", backend: "test", home, env: {}, hide: [app.home], ro: [] }, workspaceMounts(app, [wt]));
        execFileSync(cmd.file, cmd.args, { env: cmd.env });
      });
      const run = getRun(app, ids[0]);
      expect(run.error).toContain("partial-b");
      expect(run.output.commits).toMatchObject({ "partial-a": [expect.any(String), expect.any(String)], "partial-b": [] });
      expect(repos[0].git("-C", trees[0].path, "show", "HEAD:first").toString()).toBe("first\n=======\n");
      expect(repos[0].git("-C", trees[0].path, "show", "HEAD:part").toString()).toBe("part\n");
      const failed = (run.output.worktrees as typeof trees)[1];
      expect(readFileSync(join(failed.path, "draft"), "utf8")).toBe("draft\n");
      const privateDir = join(app.runsDir, run.id, "member-git", failed.space, "git");
      expect(repos[1].git("--git-dir", privateDir, "show", "HEAD:other").toString()).toBe("other\n");
      expect(settleCodingRound(app, round.id, round.id, trees, 1, ids).finished).toEqual([tasks[0]]);
      expect(getTask(app, round.id, tasks[1]).state).toBe("todo");
    } finally { fake.mockRestore(); }
  });

  it.skipIf(!sandboxSupport().ok)("opens both repositories in bubblewrap and keeps the helper's slot hidden", async () => {
    const home = join(app.home, "account");
    mkdirSync(home);
    writeFileSync(join(group, "unassigned"), "host only");
    const probe = [
      'git -C web rev-parse --verify HEAD',
      'git -C api rev-parse --verify HEAD',
      'touch web/new-file api/new-file',
      'git -C web add new-file && git -C web commit -qm web-change',
      'git -C api add new-file && git -C api commit -qm api-change',
      'test ! -e unassigned && test ! -w "$1" && test ! -e "$2"',
    ].join(" && ");
    const acct = { userId: "member", backend: "test", home, env: {}, hide: [app.home], ro: [] };
    const command = sandboxCommand({ file: "/bin/sh", prefix: [] }, ["-c", probe, "sh", join(a.root, ".git"), helper.slot], {}, group,
      acct, workspaceMounts(app, [lead, inline], "multi"));
    execFileSync(command.file, command.args, { env: command.env });
    for (const wt of [lead, inline]) {
      expect(await receiveMemberGit(app, "multi", wt.space, wt.path, "finish")).toBe(true);
      expect(execFileSync("git", ["log", "-1", "--format=%s"], { cwd: wt.path, encoding: "utf8" }).trim()).toBe(wt.space + "-change");
    }
    for (const repo of [a, b]) expect(repo.git("log", "-1", "--format=%s").toString().trim()).toBe("init");

    const child = sandboxCommand({ file: "/bin/sh", prefix: [] },
      ["-c", 'git -C web rev-parse --verify HEAD && git -C api rev-parse --verify HEAD && touch web/helper-file && test ! -e "$1" && test ! -e "$2"', "sh", lead.slot, inline.path],
      {}, dirname(helper.path), acct, workspaceMounts(app, [helper, helperApi]));
    execFileSync(child.file, child.args, { env: child.env });
  });
});
