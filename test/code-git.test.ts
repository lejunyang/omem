import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { actCodeGit, readCodeGit } from "../src/agents/code-git.ts";
import { createRun, getRun, setRunOutput } from "../src/agents/runs.ts";
import { callTool, type ToolContext } from "../src/agents/tools.ts";
import { git } from "../src/core/git.ts";
import { run as sql } from "../src/core/db.ts";
import { createSpace } from "../src/core/spaces.ts";
import { createApiToken, createUser } from "../src/core/users.ts";
import { startServer } from "../src/server/http.ts";
import { testApp } from "./helpers.ts";

let app: ReturnType<typeof testApp>, root: string, path: string, remote: string, id: string;
function sh(cwd: string, ...args: string[]) {
  const r = git(cwd, args);
  if (!r.ok) throw new Error(r.stderr);
  return r.stdout.trim();
}
const status = () => readCodeGit(app, id, "shop");
const act = (action: "commit" | "commit_push" | "push", message = "显示退款状态") =>
  actCodeGit(app, id, { space: "shop", action, message, expected_state: status().state });
beforeEach(() => {
  app = testApp();
  root = join(app.home, "repo"); path = join(app.home, "receiving"); remote = join(app.home, "remote.git");
  mkdirSync(root); mkdirSync(remote);
  sh(root, "init", "-q", "-b", "main");
  sh(root, "config", "user.name", "Example"); sh(root, "config", "user.email", "example@example.com");
  writeFileSync(join(root, "app.txt"), "before\n");
  sh(root, "add", "."); sh(root, "commit", "-qm", "initial");
  sh(remote, "init", "--bare", "-q");
  sh(root, "remote", "add", "origin", remote);
  sh(root, "worktree", "add", "-q", "-b", "feature/refund", path);
  sh(path, "push", "-q", "origin", "HEAD:refs/heads/feature/refund");
  createSpace(app, { id: "shop", name: "项目 A", kind: "repo", rootPath: root });
  const r = createRun(app, { kind: "code", spaceId: "shop", title: "显示退款状态", input: { repos: ["shop"] } });
  id = r.id;
  sql(app.db, "update runs set status='done' where id=?", id);
  setRunOutput(app, id, { appliedAt: new Date().toISOString(), appliedTo: [{ space: "shop", path, branch: "feature/refund" }] });
  writeFileSync(join(path, "app.txt"), "after\n"); sh(path, "add", "app.txt");
});
afterEach(() => { app.db.close(); rmSync(app.home, { recursive: true, force: true }); });

describe("Git operations on applied code", () => {
  it("commits only the inspected index, keeps later edits, and records the commit without pushing", async () => {
    writeFileSync(join(path, "app.txt"), "later personal edit\n");
    writeFileSync(join(path, "notes.txt"), "not staged\n");
    const preview = status(), oldRemote = sh(remote, "rev-parse", "refs/heads/feature/refund");
    expect(preview.staged).toBe(1); expect(preview.unstaged).toBe(2); expect(preview.stagedDiff).toContain("+after");
    const result = await act("commit", "退款状态\n\n保留未暂存的修改");
    expect(result.ok).toBe(true); expect(result.pushed).toBe(false);
    expect(sh(path, "show", "HEAD:app.txt")).toBe("after");
    expect(readFileSync(join(path, "app.txt"), "utf8")).toBe("later personal edit\n");
    expect(status().unstaged).toBe(2);
    expect(sh(remote, "rev-parse", "refs/heads/feature/refund")).toBe(oldRemote);
    expect(sh(root, "branch", "--show-current")).toBe("main");
    expect(status().operations[0].committed).toBe(result.head);
    expect(sh(root, "rev-parse", "refs/heads/feature/refund")).toBe(result.head);
    await expect(act("commit")).rejects.toThrow(/没有已暂存/);
  });

  it("commits and pushes the original branch, including when push.default and mirror would select other refs", async () => {
    sh(root, "config", "push.default", "matching"); sh(root, "config", "remote.origin.mirror", "true");
    const result = await act("commit_push");
    expect(result.ok).toBe(true); expect(result.pushed).toBe(true);
    expect(sh(remote, "rev-parse", "refs/heads/feature/refund")).toBe(result.head);
    expect(git(remote, ["show-ref", "--verify", "refs/heads/main"]).ok).toBe(false);
    expect(status().operations).toHaveLength(1);
    expect(status().ahead).toBe(0);
  });

  it("keeps the commit on push failure and allows push-only retry without another commit", async () => {
    const hook = join(remote, "hooks", "pre-receive");
    writeFileSync(hook, "#!/bin/sh\necho rejected >&2\nexit 1\n"); chmodSync(hook, 0o755);
    const first = await act("commit_push");
    expect(first.ok).toBe(false); expect(first.committed).toBeTruthy(); expect(first.error).toContain("本地提交已完成");
    expect(status().staged).toBe(0);
    rmSync(hook);
    const retry = await act("push");
    expect(retry.ok).toBe(true); expect(retry.head).toBe(first.committed); expect(retry.committed).toBeNull();
    expect(status().operations).toHaveLength(2);
    expect(sh(remote, "rev-parse", "refs/heads/feature/refund")).toBe(first.committed);
  });

  it("rejects non-fast-forward pushes without replacing remote changes", async () => {
    await act("commit");
    sh(root, "commit", "--allow-empty", "-qm", "remote update");
    sh(root, "push", "-q", "origin", "HEAD:refs/heads/feature/refund");
    const remoteHead = sh(remote, "rev-parse", "refs/heads/feature/refund");
    const result = await act("push");
    expect(result.ok).toBe(false); expect(result.pushed).toBe(false);
    expect(sh(remote, "rev-parse", "refs/heads/feature/refund")).toBe(remoteHead);
  });

  it("rejects stale previews when staged contents, HEAD, or the push destination change", async () => {
    for (const change of [
      () => { writeFileSync(join(path, "app.txt"), "different\n"); sh(path, "add", "app.txt"); },
      () => sh(path, "commit", "-qm", "external commit"),
      () => sh(root, "remote", "set-url", "--push", "origin", join(app.home, "other.git")),
    ]) {
      const preview = status(); change();
      await expect(actCodeGit(app, id, { space: "shop", action: "push", expected_state: preview.state })).rejects.toThrow(/状态已变化/);
    }
  });

  it("rejects switched branches, foreign directories, missing applications, and unfinished merges", async () => {
    sh(path, "switch", "-qc", "feature/other");
    expect(status).toThrow(/切换分支/); sh(path, "switch", "-q", "feature/refund");
    const mergeHead = sh(path, "rev-parse", "--git-path", "MERGE_HEAD");
    writeFileSync(mergeHead, sh(path, "rev-parse", "HEAD") + "\n");
    await expect(act("commit")).rejects.toThrow(/未完成/); rmSync(mergeHead);
    setRunOutput(app, id, { appliedTo: [{ space: "shop", path: remote, branch: "feature/refund" }] });
    expect(status).toThrow(/不属于原仓库/);
    setRunOutput(app, id, { appliedAt: null }); expect(status).toThrow(/请先应用/);
  });

  it("checks push availability before committing and honors failing commit hooks", async () => {
    sh(root, "remote", "remove", "origin");
    const before = status().head;
    await expect(act("commit_push")).rejects.toThrow(/origin/);
    expect(status().head).toBe(before);
    const hook = join(root, ".git", "hooks", "pre-commit");
    writeFileSync(hook, "#!/bin/sh\necho check_failed >&2\nexit 1\n"); chmodSync(hook, 0o755);
    const result = await act("commit");
    expect(result.ok).toBe(false); expect(result.error).toContain("check_failed"); expect(status().head).toBe(before); expect(status().staged).toBe(1);
  });

  it("serializes concurrent operations and exposes the same history through continuation rounds", async () => {
    const next = createRun(app, { kind: "code", spaceId: "shop", title: "下一轮", input: { continueFrom: id } });
    const preview = status();
    const first = act("commit");
    await expect(actCodeGit(app, next.id, { space: "shop", action: "commit", message: "duplicate", expected_state: preview.state })).rejects.toThrow(/正在提交/);
    const result = await first;
    expect(readCodeGit(app, next.id, "shop").operations[0].head).toBe(result.head);
  });

  it("shares API/tool behavior and enforces owner, scope, and write permissions", async () => {
    const ctx: ToolContext = { app, actor: "agent", runId: null, spaceId: "shop", spaces: ["shop"], tools: null };
    const args = { run_id: id, space: "shop", action: "commit", message: "工具提交", expected_state: status().state };
    expect((await callTool({ ...ctx, spaces: [] }, "code_git_status", args)).isError).toBe(true);
    expect((await callTool({ ...ctx, writable: [] }, "code_git_action", args)).isError).toBe(true);
    expect((await callTool({ ...ctx, userId: "guest" }, "code_git_action", args)).isError).toBe(true);
    expect((await callTool({ ...ctx, tools: new Set() }, "code_git_action", args)).isError).toBe(true);
    expect((await callTool(ctx, "code_git_status", args)).isError).toBe(false);
    const result = await callTool(ctx, "code_git_action", args);
    expect(result.isError).toBe(false); expect(JSON.parse(result.text).committed).toBeTruthy();
    const server = await startServer(app, { port: 0, quiet: true });
    try {
      const response = await server.inject({ method: "GET", url: `/api/runs/${id}/git?space=shop` });
      expect(response.statusCode).toBe(200); expect(response.json().staged).toBe(0);
      const pushed = await server.inject({ method: "POST", url: `/api/runs/${id}/git`, payload: { space: "shop", action: "push", expected_state: response.json().state } });
      expect(pushed.statusCode).toBe(200); expect(pushed.json().pushed).toBe(true);
      createUser(app, { id: "reader", name: "读者" }); const token = createApiToken(app, "reader");
      const denied = await server.inject({ method: "GET", url: `/api/runs/${id}/git?space=shop`, headers: { authorization: `Bearer ${token}` } });
      expect(denied.statusCode).toBe(403);
      expect(getRun(app, id).output.gitOperations).toHaveLength(2);
    } finally { await server.close(); }
  });
});
