import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createRun, getRun, setRunOutput } from "../src/agents/runs.ts";
import { callTool, type ToolContext } from "../src/agents/tools.ts";
import { remoteKey } from "../src/core/repositories.ts";
import { relinkRepoSpace } from "../src/agents/repo-relink.ts";
import { listWorkspaces } from "../src/agents/workspaces.ts";
import { run as sql } from "../src/core/db.ts";
import { getSpace, listSpaces } from "../src/core/spaces.ts";
import { testApp } from "./helpers.ts";

const app = testApp();
afterAll(() => app.db.close());
const ctx: ToolContext = { app, runId: null, spaceId: "personal", spaces: null, tools: null, actor: "agent", userId: "owner" };
const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env });

// One repository, two checkouts: the space's, and the owner's own clone elsewhere (other remote form).
const base = mkdtempSync(join(tmpdir(), "omem-cw-"));
const first = join(base, "shop");
mkdirSync(first);
git(first, "init", "-q", "-b", "main");
writeFileSync(join(first, "app.ts"), "export const a = 1;\n");
git(first, "add", "-A");
git(first, "commit", "-q", "-m", "init");
git(first, "remote", "add", "origin", "git@example.com:Team/shop.git");
const second = join(base, "my-shop");
git(base, "clone", "-q", first, second);
git(second, "remote", "set-url", "origin", "https://example.com/team/shop");
const call = async (name: string, args: Record<string, unknown>) => {
  const r = await callTool(ctx, name, args);
  if (r.isError) throw new Error(r.text);
  return r.text;
};

describe("delegation workspaces from the assistant", () => {
  it("treats one repository's https and ssh remotes as the same", () => {
    expect(remoteKey("git@example.com:Team/shop.git")).toBe("example.com/team/shop");
    expect(remoteKey("https://example.com/team/shop")).toBe("example.com/team/shop");
    expect(remoteKey("ssh://git@example.com:22/team/shop.git/")).toBe("example.com/team/shop");
    expect(remoteKey("https://example.com/team/other.git")).not.toBe("example.com/team/shop");
  });

  it("finds the space of another checkout of the same repository instead of making a new one", async () => {
    await call("connect_repository", { repository: first, id: "shop", name: "商城" });
    const spaces = listSpaces(app).length;
    const text = await call("connect_repository", { repository: second });
    expect(text).toContain("已经有空间 shop");
    expect(text).toContain("relink: true");
    expect(listSpaces(app).length).toBe(spaces);
    expect(getSpace(app, "shop").rootPath).toBe(realpathSync(first));
  });

  it("sets up workspace reuse and working in the main directory", async () => {
    const text = await call("set_code_workspaces", { space: "shop", pool: 2, setup_command: "pnpm install", in_place: true });
    expect(text).toContain("允许在主目录里改");
    expect(text).toContain("仓库主目录");
    expect(getSpace(app, "shop").settings).toMatchObject({ pool: 2, setupCommand: "pnpm install", inPlace: true });
    await call("set_code_workspaces", { space: "shop", setup_command: "", in_place: false, pool: 0 });
    expect(getSpace(app, "shop").settings).toMatchObject({ pool: 0, inPlace: false });
    expect(getSpace(app, "shop").settings.setupCommand).toBeUndefined();
  });

  it("lists what delegations left behind, cleans only what the owner agreed to, then lets the space move", async () => {
    // A finished, unapplied delegation with a change in its worktree.
    const r = createRun(app, { kind: "code", spaceId: "shop", title: "改按钮", input: { task: "改按钮", repos: ["shop"] } });
    const work = join(app.runsDir, r.id, "work", "shop");
    git(first, "worktree", "add", "-q", "-b", `omem/${r.id}`, work, "HEAD");
    writeFileSync(join(work, "app.ts"), "export const a = 2;\n");
    setRunOutput(app, r.id, { worktrees: [{ space: "shop", path: work, branch: `omem/${r.id}`, base: git(first, "rev-parse", "HEAD").trim() }] });
    sql(app.db, "update runs set status = 'done' where id = ?", r.id);
    // A worktree under the runs directory whose delegation is gone.
    const stray = join(app.runsDir, "r-gone", "work", "shop");
    git(first, "worktree", "add", "-q", "--detach", stray, "HEAD");

    await expect(call("connect_repository", { repository: second, space: "shop", relink: true })).rejects.toThrow(new RegExp(r.id));

    const listed = await call("clean_code_runs", {});
    expect(listed).toContain(`[没应用的交办] ${r.id}`);
    expect(listed).toContain("改了 1 个文件");
    expect(listed).toContain("[遗留工作区] r-gone");
    expect(existsSync(work)).toBe(true);
    await expect(call("clean_code_runs", { confirm: true })).rejects.toThrow(/run_ids/);

    // Only the delegation the owner agreed to.
    await call("clean_code_runs", { confirm: true, run_ids: [r.id] });
    expect(existsSync(work)).toBe(false);
    expect(getRun(app, r.id).output.discardedAt).toBeTruthy();
    expect(git(first, "branch", "--list", `omem/${r.id}`).trim()).toBe("");
    expect(existsSync(stray)).toBe(true);
    await call("clean_code_runs", { confirm: true, run_ids: ["r-gone"] });
    expect(existsSync(stray)).toBe(false);
    expect(await call("clean_code_runs", {})).toContain("没有可清理");

    const moved = await call("connect_repository", { repository: second, space: "shop", relink: true });
    expect(moved).toContain("改为关联");
    expect(getSpace(app, "shop").rootPath).toBe(realpathSync(second));
  });

  it("tells a separate clone listed as a workspace from a worktree, and moves the space to it once unapplied work is let go", () => {
    // The space is on `second` now; the owner lists `first` (its own .git, same remote) as a workspace.
    sql(app.db, "update spaces set settings = json_set(settings, '$.workspaces', json_array(?)) where id = 'shop'", first);
    const [slot] = listWorkspaces(app, getSpace(app, "shop"));
    expect(slot).toMatchObject({ state: "invalid", clone: true });
    expect(slot.reason).toContain("仓库目录");

    const r = createRun(app, { kind: "code", spaceId: "shop", title: "改标题", input: { task: "改标题", repos: ["shop"] } });
    const work = join(app.runsDir, r.id, "work", "shop");
    git(second, "worktree", "add", "-q", "-b", `omem/${r.id}`, work, "HEAD");
    setRunOutput(app, r.id, { worktrees: [{ space: "shop", path: work, branch: `omem/${r.id}`, base: git(second, "rev-parse", "HEAD").trim() }] });
    sql(app.db, "update runs set status = 'done' where id = ?", r.id);

    const asked = relinkRepoSpace(app, "shop", first);
    expect(asked).toEqual({ done: false, pending: [{ run: r.id, title: "改标题" }] });
    expect(getSpace(app, "shop").rootPath).toBe(realpathSync(second));

    const done = relinkRepoSpace(app, "shop", first, { discard: true });
    expect(done).toMatchObject({ done: true, root: realpathSync(first), discarded: [r.id] });
    expect(getRun(app, r.id).output.discardedAt).toBeTruthy();
    expect(existsSync(work)).toBe(false);
    expect(getSpace(app, "shop").settings.workspaces).toEqual([]);

    const other = join(base, "other");
    mkdirSync(other);
    git(other, "init", "-q");
    git(other, "remote", "add", "origin", "https://example.com/team/other.git");
    expect(() => relinkRepoSpace(app, "shop", other)).toThrow(/不是同一个/);
  });
});
