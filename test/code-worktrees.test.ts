import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { applyCodeRun, codePatches, codeRepos, discardCodeRun } from "../src/agents/code.ts";
import { createRun, setRunOutput } from "../src/agents/runs.ts";
import { callTool, type ToolContext } from "../src/agents/tools.ts";
import { indexWorktree, sweepWorktreeSpaces, worktreeSpaceId, worktreeSpacesOf, type WorktreeRef } from "../src/agents/worktree-index.ts";
import { run as sql } from "../src/core/db.ts";
import { createSpace, findSpace, listSpaces } from "../src/core/spaces.ts";
import { search } from "../src/search/search.ts";
import { testApp } from "./helpers.ts";

const app = testApp();
afterAll(() => app.db.close());

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" } });

function repo(name: string, files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), `omem-${name}-`));
  sh(dir, "init", "-q");
  for (const [f, text] of Object.entries(files)) writeFileSync(join(dir, f), text);
  sh(dir, "add", "-A");
  sh(dir, "commit", "-q", "-m", "init");
  return dir;
}

const web = repo("web", { "app.ts": "export function showOrder() {\n  return 1;\n}\n" });
const api = repo("api", { "orders.ts": "export function listOrders() {\n  return [];\n}\n" });
createSpace(app, { id: "shop", name: "商城", kind: "project" });
createSpace(app, { id: "shop-web", name: "商城前端", kind: "repo", rootPath: web });
createSpace(app, { id: "shop-api", name: "订单服务", kind: "repo", rootPath: api });

/** What runCodeTask leaves behind once the coder is done, without running an agent. */
function finishedRun(changes: Record<string, Record<string, string>>) {
  const r = createRun(app, { kind: "code", spaceId: "shop", title: "订单页显示退款状态", input: { task: "订单页显示退款状态", repos: Object.keys(changes) } });
  const worktrees: WorktreeRef[] = [];
  const repos: { space: string; diffStat: string; diffBytes: number; check: null }[] = [];
  mkdirSync(join(app.runsDir, r.id, "patches"), { recursive: true });
  for (const [space, files] of Object.entries(changes)) {
    const root = findSpace(app, space)!.rootPath!;
    const path = join(app.runsDir, r.id, "work", space);
    const base = sh(root, "rev-parse", "HEAD").trim();
    sh(root, "worktree", "add", "-q", "-b", `omem/${r.id}`, path, base);
    for (const [f, text] of Object.entries(files)) writeFileSync(join(path, f), text);
    sh(path, "add", "-A");
    const diff = sh(path, "diff", "--cached", "--no-color", "HEAD");
    writeFileSync(join(app.runsDir, r.id, "patches", `${space}.patch`), diff);
    worktrees.push({ space, path, branch: `omem/${r.id}`, base });
    repos.push({ space, diffStat: "", diffBytes: diff.length, check: null });
  }
  setRunOutput(app, r.id, { worktrees, repos });
  sql(app.db, "update runs set status = 'done' where id = ?", r.id);
  return { id: r.id, worktrees };
}

describe("delegated coding across repositories", () => {
  it("checks that every repository is a Git repository", () => {
    expect(codeRepos(app, "shop", ["shop-web", "shop-api"]).map((s) => s.id)).toEqual(["shop-web", "shop-api"]);
    expect(() => codeRepos(app, "shop")).toThrow(/没有关联 Git 仓库/);
  });

  it("indexes only the changed files while the worktree exists; apply puts every repository's change in place and drops the index", async () => {
    const { id, worktrees } = finishedRun({
      "shop-web": { "app.ts": "export function showOrder() {\n  return refundBadge();\n}\n", "badge.ts": "export function refundBadge() {\n  return '退款中';\n}\n" },
      "shop-api": { "orders.ts": "export function listOrders() {\n  return [{ refundStatus: 'pending' }];\n}\n" },
    });
    for (const wt of worktrees) await indexWorktree(app, id, wt);
    const spaces = worktreeSpacesOf(app, id).map((s) => s.id).sort();
    expect(spaces).toEqual([worktreeSpaceId(id, "shop-api"), worktreeSpaceId(id, "shop-web")]);
    // Temporary spaces stay out of ordinary listings but are searchable.
    expect(listSpaces(app).some((s) => s.kind === "worktree")).toBe(false);
    const hits = await search(app, "refundBadge", { spaces });
    expect(hits.some((h) => h.spaceId === worktreeSpaceId(id, "shop-web"))).toBe(true);
    expect(await search(app, "refundBadge", { spaces: ["shop-web"] })).toEqual([]);

    // Agents may read them, never write into them.
    const ctx: ToolContext = { app, runId: null, spaceId: "shop", spaces: null, tools: null, actor: "agent" };
    const refused = await callTool(ctx, "remember", { content: "退款状态由订单服务返回", kind: "fact", space: worktreeSpaceId(id, "shop-web") });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/只能读/);

    expect(codePatches(app, id).map((p) => p.space)).toEqual(["shop-web", "shop-api"]);
    expect(applyCodeRun(app, id).spaces).toEqual(["shop-web", "shop-api"]);
    expect(readFileSync(join(web, "badge.ts"), "utf8")).toContain("退款中");
    expect(readFileSync(join(api, "orders.ts"), "utf8")).toContain("refundStatus");
    expect(worktrees.every((w) => !existsSync(w.path))).toBe(true);
    expect(worktreeSpacesOf(app, id)).toEqual([]);
    expect(await search(app, "refundBadge", { spaces })).toEqual([]);
    expect(() => applyCodeRun(app, id)).toThrow(/已经应用过/);
    sh(web, "reset", "-q", "--hard");
    sh(web, "clean", "-qfd");
    sh(api, "reset", "-q", "--hard");
  });

  it("applies nothing when one repository cannot take its change", () => {
    const { id } = finishedRun({
      "shop-web": { "app.ts": "export function showOrder() {\n  return 2;\n}\n" },
      "shop-api": { "orders.ts": "export function listOrders() {\n  return [1];\n}\n" },
    });
    writeFileSync(join(api, "orders.ts"), "// rewritten locally\n");
    expect(() => applyCodeRun(app, id)).toThrow(/shop-api：无法干净应用/);
    expect(readFileSync(join(web, "app.ts"), "utf8")).toContain("return 1");
    sh(api, "reset", "-q", "--hard");
    discardCodeRun(app, id);
  });

  it("drops the index when a worktree is removed by hand, and on discard", async () => {
    const a = finishedRun({ "shop-web": { "app.ts": "export function showOrder() {\n  return 3;\n}\n" } });
    await indexWorktree(app, a.id, a.worktrees[0]);
    sh(web, "worktree", "remove", "--force", a.worktrees[0].path);
    expect(sweepWorktreeSpaces(app)).toBe(1);
    expect(worktreeSpacesOf(app, a.id)).toEqual([]);

    const b = finishedRun({ "shop-api": { "orders.ts": "export function listOrders() {\n  return [2];\n}\n" } });
    await indexWorktree(app, b.id, b.worktrees[0]);
    discardCodeRun(app, b.id);
    expect(worktreeSpacesOf(app, b.id)).toEqual([]);
    expect(existsSync(b.worktrees[0].path)).toBe(false);
    expect(sh(api, "branch", "--list", `omem/${b.id}`).trim()).toBe("");
  });
});
