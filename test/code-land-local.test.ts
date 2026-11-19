import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { landLocally } from "../src/agents/code-branch.ts";
import type { WorktreeRef } from "../src/agents/worktree-index.ts";

/** Confirming a delegation on a repository without origin puts the work on the branch it was cut from. */
const dirs: string[] = [];
const git = (dir: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", ...args], { cwd: dir, encoding: "utf8" }).trim();
function repo() {
  const root = mkdtempSync(join(tmpdir(), "omem-land-"));
  dirs.push(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "commit", "-q", "--allow-empty", "-m", "init");
  git(root, "branch", "work");
  git(root, "checkout", "-q", "work");
  writeFileSync(join(root, "a.txt"), "a\n");
  git(root, "add", "a.txt");
  git(root, "commit", "-q", "-m", "work");
  return root;
}
const ref = (branch = "work", cutFrom = "main"): WorktreeRef => ({ space: "s", path: "/x", branch, base: "", commits: true, newBranch: true, cutFrom });
const tip = (root: string, b: string) => git(root, "rev-parse", b);

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("没有 origin 的仓库确认交办", () => {
  it("main 检出在仓库目录：快进过去，工作区文件跟着更新", () => {
    const root = repo();
    git(root, "checkout", "-q", "main");
    expect(landLocally(root, ref())).toBe("没有 origin，已快进合进本地的 main");
    expect(tip(root, "main")).toBe(tip(root, "work"));
    expect(git(root, "status", "--porcelain")).toBe("");
  });

  it("main 没被检出：直接移动引用", () => {
    const root = repo();
    expect(landLocally(root, ref())).toBe("没有 origin，已快进合进本地的 main");
    expect(tip(root, "main")).toBe(tip(root, "work"));
  });

  it("main 上有这次交办之外的提交：不合，留在分支上并说明", () => {
    const root = repo();
    git(root, "checkout", "-q", "main");
    git(root, "commit", "-q", "--allow-empty", "-m", "other");
    const before = tip(root, "main");
    expect(landLocally(root, ref())).toContain("没有合进去");
    expect(tip(root, "main")).toBe(before);
  });

  it("接着已有分支做的交办（没有 cutFrom）照旧只在本地", () => {
    const root = repo();
    expect(landLocally(root, { ...ref(), cutFrom: undefined, newBranch: false })).toBe("没有 origin，只在本地");
  });
});
