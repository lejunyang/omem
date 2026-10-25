import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import "../src/agents/jobs.ts";
import { applyCodeRun, codePatches, createBranchReview, discardCodeRun, worktreesOf } from "../src/agents/code.ts";
import { codeChainFor } from "../src/agents/code-chain.ts";
import { __testHandlers, addRunEvent, cancelRun, createRun, getRun, setRunOutput, type Run } from "../src/agents/runs.ts";
import { createThread } from "../src/agents/threads.ts";
import { callTool, type ToolContext } from "../src/agents/tools.ts";
import { branchIndexes, indexBranch, sweepWorktreeSpaces } from "../src/agents/worktree-index.ts";
import { run } from "../src/core/db.ts";
import { listBranches, resolveRef } from "../src/core/git.ts";
import { createSpace } from "../src/core/spaces.ts";
import { search } from "../src/search/search.ts";
import { startServer } from "../src/server/http.ts";
import { testApp } from "./helpers.ts";

const app = testApp();
afterAll(() => app.db.close());

const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
const dir = mkdtempSync(join(tmpdir(), "omem-branch-"));
const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", env });
const commit = (files: Record<string, string | null>, message: string) => {
  for (const [f, text] of Object.entries(files)) text === null ? unlinkSync(join(dir, f)) : writeFileSync(join(dir, f), text);
  git("add", "-A");
  git("commit", "-q", "-m", message);
};

// main: refund.ts + legacy.ts. feature/refund changes refund.ts, adds lines.ts, deletes legacy.ts;
// main moves on afterwards (notes.md), which the branch's diff must not include.
git("init", "-q", "-b", "main");
commit({ "refund.ts": "export function refundAmount() {\n  return 0;\n}\n", "legacy.ts": "export function oldRefundRule() {\n  return 'legacyRefundRule';\n}\n" }, "init");
git("checkout", "-q", "-b", "feature/refund");
commit({ "refund.ts": "export function refundAmount(lines: Line[]) {\n  return shippedOnly(lines).length;\n}\n", "lines.ts": "export function shippedOnly(lines: Line[]) {\n  return lines.filter((l) => !l.shipped);\n}\n", "legacy.ts": null }, "只退未发货的行");
git("checkout", "-q", "main");
commit({ "notes.md": "# 发布说明\n\nmainOnlyChange\n" }, "main 上的新提交");
createSpace(app, { id: "shop-api", name: "订单服务", kind: "repo", rootPath: dir });
const repoFiles = ["refund.ts", "legacy.ts", "notes.md"];
for (const f of repoFiles) {
  const { upsertSource } = await import("../src/sources/store.ts");
  upsertSource(app, { spaceId: "shop-api", kind: f.endsWith(".md") ? "doc" : "code", uri: f, title: f, text: readFileSync(join(dir, f), "utf8") });
}

describe("branches of a repository space", () => {
  it("lists branches and resolves local names", () => {
    expect(listBranches(dir).map((b) => b.name).sort()).toEqual(["feature/refund", "main"]);
    expect(resolveRef(dir, "feature/refund")?.ref).toBe("refs/heads/feature/refund");
    expect(resolveRef(dir, "nope")).toBeNull();
  });

  it("indexes what a branch changed since it left main, and search shows the code as it is there", async () => {
    const idx = await indexBranch(app, "shop-api", "feature/refund");
    expect(idx).toMatchObject({ baseRef: "main", files: 2, deleted: 1, refreshed: true });
    const spaces = ["shop-api", idx.space];
    // The branch's copy stands in for the repository's: changed and deleted files come from the branch.
    const refund = await search(app, "refundAmount", { spaces });
    expect(refund.filter((h) => h.uri === "refund.ts").map((h) => h.spaceId)).toEqual([idx.space]);
    expect((await search(app, "legacyRefundRule", { spaces })).filter((h) => h.uri === "legacy.ts")).toEqual([]);
    expect((await search(app, "shippedOnly", { spaces })).some((h) => h.spaceId === idx.space && h.uri === "lines.ts")).toBe(true);
    // Files the branch did not touch, and the repository on its own, are unchanged.
    expect((await search(app, "mainOnlyChange", { spaces })).some((h) => h.spaceId === "shop-api")).toBe(true);
    expect((await search(app, "legacyRefundRule", { spaces: ["shop-api"] })).some((h) => h.uri === "legacy.ts")).toBe(true);
    // Unchanged branch: nothing is re-read.
    expect((await indexBranch(app, "shop-api", "feature/refund")).refreshed).toBe(false);
  });

  it("gives agents a branch parameter on search and find_symbol, scoped by the repository", async () => {
    const ctx: ToolContext = { app, runId: null, spaceId: "shop-api", spaces: ["shop-api"], tools: null, actor: "agent" };
    const found = await callTool(ctx, "search", { query: "refundAmount", space: "shop-api", branch: "feature/refund" });
    expect(found.isError).toBeFalsy();
    expect(found.text).toContain("分支 feature/refund");
    expect(found.text).toContain("〔空间 br-shop-api-");
    const sym = await callTool(ctx, "find_symbol", { name: "refundAmount", space: "shop-api", branch: "feature/refund" });
    expect(sym.text).toContain("refundAmount(lines: Line[])");
    expect(sym.text).not.toContain("refundAmount()");
    // The index goes with the repository it is over: a run that may not read the repository may not read it.
    const other: ToolContext = { ...ctx, spaces: ["personal"] };
    expect((await callTool(other, "search", { query: "refundAmount", space: "shop-api", branch: "feature/refund" })).isError).toBe(true);
    const listed = await callTool(ctx, "list_branches", { space: "shop-api" });
    expect(listed.text).toContain("feature/refund");
    expect(listed.text).toContain("已建索引的分支");
    // Spaces the reviewers also read (requirement docs, the source of a migration) are the caller's to give.
    const queued = await callTool({ ...ctx, spaces: ["shop-api", "personal"] }, "review_branch", { repo_spaces: ["shop-api"], branch: "feature/refund", read_spaces: ["personal"], fetch: false });
    const runId = queued.text.match(/运行 (\S+)（/)![1];
    expect(getRun(app, runId).input.readSpaces).toEqual(["personal"]);
    cancelRun(app, runId);
    expect((await callTool(ctx, "review_branch", { repo_spaces: ["shop-api"], branch: "feature/refund", read_spaces: ["personal"], fetch: false })).isError).toBe(true);
  });

  it("follows the branch when it moves, and goes when the branch is deleted", async () => {
    git("branch", "-q", "tmp/old", "feature/refund");
    const first = await indexBranch(app, "shop-api", "tmp/old");
    git("checkout", "-q", "tmp/old");
    commit({ "refund.ts": "export function refundAmount() {\n  return 'movedOn';\n}\n" }, "再改一次");
    git("checkout", "-q", "main");
    const moved = await indexBranch(app, "shop-api", "tmp/old");
    expect(moved.refreshed).toBe(true);
    expect(moved.commit).not.toBe(first.commit);
    expect((await search(app, "movedOn", { spaces: ["shop-api", moved.space] })).some((h) => h.spaceId === moved.space)).toBe(true);
    git("branch", "-q", "-D", "tmp/old");
    sweepWorktreeSpaces(app);
    expect(branchIndexes(app, "shop-api").map((s) => s.settings.branch)).toEqual(["feature/refund"]);
  });
});

describe("reviewing an existing branch", () => {
  const fake = () => {
    app.config.agents.profiles.push({ id: "fake", name: "fake", transport: "acp", command: process.execPath, args: [resolve("test/fake-acp-agent.ts")], env: { FAKE_MODE: "review" }, idleTimeoutMs: 60000 });
    app.config.agents.default = "fake";
    app.config.review = {
      tiers: [{ id: "standard", name: "标准", guide: "", when: null, checks: ["reviewer", "review-business"], maxRounds: 2, lead: false, confirmPlan: false }],
      rereviewAllEvery: 2,
      checks: {},
    };
  };
  const exec = (r: Run) => {
    run(app.db, "update runs set status = 'running' where id = ?", r.id);
    return __testHandlers.get("code")!({
      app, run: getRun(app, r.id), signal: new AbortController().signal,
      event: (type, data) => addRunEvent(app, r.id, type, data),
      output: (data) => setRunOutput(app, r.id, data),
    }) as Promise<{ verdict: string; continuedRunId?: string }>;
  };

  it("checks the branch out, reviews only its own changes, never codes or continues, and leaves the branch alone", async () => {
    fake();
    const server = await startServer(app, { port: 0, quiet: true });
    try {
      const t = createThread(app, { channel: "web", spaceId: "shop-api", userId: "owner" });
      const ask = createRun(app, { kind: "ask", spaceId: "shop-api", title: "评审", input: { conversationId: t.id } });
      const r = createBranchReview(app, { repos: ["shop-api"], branch: "feature/refund", task: "退款只按未发货的行计算", fetch: false }, ask.id);
      codeChainFor(app, r);
      const out = await exec(r);
      run(app.db, "update runs set status = 'done' where id = ?", r.id);

      const done = getRun(app, r.id).output as { coderSummary: string; verdict: string; indexedSpaces: string[] };
      expect(out.verdict).toBe("changes-requested");
      expect(out.continuedRunId).toBeUndefined();
      expect(done.coderSummary).toContain("feature/refund");
      expect(done.coderSummary).toContain("只退未发货的行");
      expect(done.coderSummary).toContain("HEAD 特意放在分叉点");
      const [wt] = worktreesOf(app, r.id);
      expect(wt).toMatchObject({ ref: "feature/refund", branch: "", baseRef: "main" });
      // The coder never ran (it would have appended to refund.ts).
      expect(readFileSync(join(wt.path, "refund.ts"), "utf8")).not.toContain("round");
      const patch = codePatches(app, r.id)[0].patch;
      expect(patch).toContain("shippedOnly");
      expect(patch).toContain("deleted file mode");
      expect(patch).not.toContain("mainOnlyChange");
      // Reviewers searched the branch: its index stands in for the repository's copies.
      expect(done.indexedSpaces).toHaveLength(1);
      expect((await search(app, "legacyRefundRule", { spaces: ["shop-api", ...done.indexedSpaces] })).filter((h) => h.uri === "legacy.ts")).toEqual([]);

      expect(() => applyCodeRun(app, r.id)).toThrow(/分支评审/);
      const ctx: ToolContext = { app, runId: ask.id, spaceId: "shop-api", spaces: null, tools: null, actor: "agent" };
      const cont = await callTool(ctx, "continue_code_run", { run_id: r.id, task: "按意见改" });
      expect(cont.isError).toBe(true);
      expect(cont.text).toMatch(/from_branch/);

      discardCodeRun(app, r.id);
      // (On Windows the folder can outlive the worktree while review sessions still sit in it.)
      expect(git("worktree", "list", "--porcelain")).not.toContain(`/runs/${r.id}/`);
      expect(resolveRef(dir, "feature/refund")).not.toBeNull();
      expect(git("rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("main");
    } finally {
      await server.close();
    }
  }, 120000);

  it("a review for an item reads its materials, joins it, and records the outcome on its timeline", async () => {
    fake();
    const server = await startServer(app, { port: 0, quiet: true });
    try {
      const { upsertItem, itemEvents } = await import("../src/items/store.ts");
      const { addMaterials, itemMaterials } = await import("../src/items/materials.ts");
      const { upsertSource } = await import("../src/sources/store.ts");
      const doc = upsertSource(app, { spaceId: "personal", kind: "doc", uri: "prd-refund.md", title: "退款需求", text: "# 退款\n\n只退未发货的行。\n" });
      const item = upsertItem(app, undefined, { spaceId: "personal", title: "退款需求", kind: "todo" }, "user");
      addMaterials(app, item.id, [{ kind: "source", ref: `src:${doc.id}#L1-L3`, note: "需求原文" }], "owner", "user");
      const r = createBranchReview(app, { repos: ["shop-api"], branch: "feature/refund", task: "评审退款分支", fetch: false, itemId: item.id });
      expect(itemMaterials(app, item.id).map((m) => `${m.kind}:${m.ref}`).sort()).toEqual([`repo:shop-api#feature/refund`, `run:${r.id}`, `source:${doc.id}`].sort());
      await exec(r);
      run(app.db, "update runs set status = 'done' where id = ?", r.id);

      const { reviewsOf } = await import("../src/agents/review.ts");
      const reviews = reviewsOf(app, [r.id]);
      expect(reviews.every((x) => x.summary.includes("读了事项材料"))).toBe(true);
      // The business check mapped the requirement to the code.
      expect(reviews.find((x) => x.check_name === "review-business")!.change_points).toEqual([expect.objectContaining({ id: "C1", status: "partial", locations: [{ file: "refund.ts", start: 1, end: 3 }] })]);
      expect(itemEvents(app, item.id).map((e) => e.text).join("\n")).toMatch(/分支评审要求修改/);
      // The run page links back to the item.
      const ctx = await (await fetch(`${app.baseUrl}/api/runs/${r.id}`)).json() as { context: { items: { id: string }[] } };
      expect(ctx.context.items.map((i) => i.id)).toEqual([item.id]);
      const page = await (await fetch(`${app.baseUrl}/api/items/${item.id}`)).json() as { materials: { kind: string; run?: { verdict: string; branchReview: boolean } }[] };
      expect(page.materials.find((m) => m.kind === "run")!.run).toMatchObject({ verdict: "changes-requested", branchReview: true });
      discardCodeRun(app, r.id);
    } finally {
      await server.close();
    }
  }, 120000);

  it("codes on top of a branch when asked (from_branch)", async () => {
    const tip = resolveRef(dir, "feature/refund")!.commit;
    const r = createRun(app, { kind: "code", spaceId: "shop-api", title: "按评审意见修改", input: { task: "按评审意见修改", repos: ["shop-api"], fromBranches: { "shop-api": "feature/refund" } } });
    const server = await startServer(app, { port: 0, quiet: true });
    try {
      await exec(r);
      const [wt] = worktreesOf(app, r.id);
      expect(wt.base).toBe(tip);
      // The change is relative to the branch: only the coder's line, not the branch's own commits.
      const patch = codePatches(app, r.id)[0].patch;
      expect(patch).toContain("export const round");
      expect(patch).not.toContain("lines.ts");
      discardCodeRun(app, r.id);
    } finally {
      await server.close();
    }
  }, 120000);
});
