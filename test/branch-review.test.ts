import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import "../src/agents/jobs.ts";
import { applyCodeRun, codePatches, createBranchReview, discardCodeRun, worktreesOf } from "../src/agents/code.ts";
import { codeChainFor } from "../src/agents/code-chain.ts";
import { __testHandlers, addRunEvent, cancelRun, createRun, getRun, listRuns, runEvents, setRunOutput, type Run } from "../src/agents/runs.ts";
import { createThread } from "../src/agents/threads.ts";
import { callTool, type ToolContext } from "../src/agents/tools.ts";
import { branchIndexes, indexBranch, sweepWorktreeSpaces } from "../src/agents/worktree-index.ts";
import { run } from "../src/core/db.ts";
import { listBranches, resolveRef } from "../src/core/git.ts";
import { createSpace, getSpace, updateSpace } from "../src/core/spaces.ts";
import { managedSlot } from "../src/agents/workspaces.ts";
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
      // The tier has the business check, and the requirement split still ran as a session of its own.
      expect((getRun(app, r.id).output as { changePoints?: { points: { id: string }[] } }).changePoints?.points.map((p) => p.id)).toEqual(["C1"]);
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

  it("the owner picks what to fix, sets some aside with a reason, and the fix codes on the branch", async () => {
    fake();
    const server = await startServer(app, { port: 0, quiet: true });
    try {
      const { upsertItem, itemEvents } = await import("../src/items/store.ts");
      const { materialsBrief } = await import("../src/items/materials.ts");
      const { decisionsBrief, setFindingDecision, workRuns } = await import("../src/agents/review-fix.ts");
      const { reviewsOf } = await import("../src/agents/review.ts");
      const item = upsertItem(app, undefined, { spaceId: "personal", title: "退款需求（修改）", kind: "todo" }, "user");
      const r = createBranchReview(app, { repos: ["shop-api"], branch: "feature/refund", task: "评审退款分支", fetch: false, itemId: item.id });
      await exec(r);
      run(app.db, "update runs set status = 'done' where id = ?", r.id);
      const findings = reviewsOf(app, [r.id]).flatMap((x) => x.findings);
      const major = findings.find((f) => f.severity === "major")!;
      const nit = findings.find((f) => f.severity === "nit")!;
      const minor = findings.find((f) => f.severity === "minor")!;

      expect(() => setFindingDecision(app, r.id, nit.id, "wontfix")).toThrow(/理由/);
      setFindingDecision(app, r.id, nit.id, "wontfix", "命名沿用源仓库，运营已确认");
      // The reason is a business decision on the item, which later work reads.
      expect(itemEvents(app, item.id).some((e) => e.kind === "decision" && e.text.includes("运营已确认"))).toBe(true);
      expect(materialsBrief(app, item.id, "owner")).toContain("命名沿用源仓库");

      const ctx: ToolContext = { app, runId: null, spaceId: "shop-api", spaces: null, tools: null, actor: "agent" };
      const res = await callTool(ctx, "fix_review", { run_id: r.id, fix: [major.id], later: [minor.id], text: "另外：部分退款要记操作日志" });
      expect(res.isError).toBeFalsy();
      const fixRun = getRun(app, /运行 (r\w+)/.exec(res.text)![1]);
      const input = fixRun.input as { task: string; fromBranches: Record<string, string>; itemId: string; fromReview: string };
      expect(input).toMatchObject({ fromBranches: { "shop-api": "feature/refund" }, itemId: item.id, fromReview: r.id });
      expect(input.task).toContain(major.title);
      expect(input.task).toContain("部分退款要记操作日志");
      // The fix was started elsewhere: the review's card stops offering one.
      const { listAsks } = await import("../src/agents/asks.ts");
      expect(listAsks(app, { runId: r.id }).map((a) => a.status)).toEqual(["cancelled"]);
      const setAside = input.task.slice(input.task.indexOf("## 这次不改"));
      expect(setAside).toContain("[不改] 命名可以更具体");
      expect(setAside).toContain("[暂不改] 可以补一条测试");
      // The fix's own reviews are told what was decided on the branch review.
      expect(decisionsBrief(app, [...workRuns(app, fixRun.id), ...workRuns(app, input.fromReview)])).toMatch(/不改\] 命名可以更具体.*运营已确认/);
      const read = await callTool(ctx, "read_run", { run_id: r.id });
      expect(read.text).toContain(`#${major.id} [严重`);
      expect(read.text).toMatch(/本人：要改/);
      cancelRun(app, fixRun.id);
      discardCodeRun(app, r.id);
    } finally {
      await server.close();
    }
  }, 120000);

  it("ends with a card to the owner: what the review found and buttons for the next step", async () => {
    fake();
    const server = await startServer(app, { port: 0, quiet: true });
    try {
      const { listAsks, answerAsk } = await import("../src/agents/asks.ts");
      const r = createBranchReview(app, { repos: ["shop-api"], branch: "feature/refund", task: "评审退款分支", fetch: false });
      await exec(r);
      run(app.db, "update runs set status = 'done' where id = ?", r.id);
      const [card] = listAsks(app, { runId: r.id, status: "pending" });
      expect(card.options.map((o) => o.label)).toEqual(["按评审修改", "先不改"]);
      expect(card.question).toMatch(/分支评审要求修改/);
      expect(card.question).toMatch(/\*\*问题\*\*：严重 1 · 一般 1 · 提示 1，默认要改 1 个/);
      expect(card.question).toContain("refund.ts");
      // A button with a note: the serious finding and the note become the fix, on the branch.
      await answerAsk(app, card.id, { choice: 0, text: "顺便把退款原因写进日志", by: "owner" });
      const fixRun = listRuns(app, { kind: "code" }).find((x) => (x.input as { fromReview?: string }).fromReview === r.id)!;
      const task = (fixRun.input as { task: string }).task;
      expect(task).toContain("顺便把退款原因写进日志");
      expect(task).toContain("[严重]");
      expect(task).not.toMatch(/选定要改的问题[\s\S]*\[一般\][\s\S]*## 本人补充/);
      cancelRun(app, fixRun.id);
      discardCodeRun(app, r.id);
    } finally {
      await server.close();
    }
  }, 120000);

  it("splits the requirement into change points next to the checks, or on request for an earlier review", async () => {
    fake();
    // A tier without the business check: the split runs on its own.
    app.config.review.tiers[0].checks = ["reviewer"];
    const server = await startServer(app, { port: 0, quiet: true });
    try {
      const r = createBranchReview(app, { repos: ["shop-api"], branch: "feature/refund", task: "评审退款分支", fetch: false });
      await exec(r);
      run(app.db, "update runs set status = 'done' where id = ?", r.id);
      const reviews = async () => (await (await fetch(`${app.baseUrl}/api/runs/${r.id}/reviews`)).json()) as { rounds: { changePoints: { id: string }[] | null }[] };
      expect((await reviews()).rounds[0].changePoints?.map((p) => p.id)).toEqual(["C1"]);
      // The made-up source id was refused, the corrected submission kept.
      expect(runEvents(app, r.id).some((e) => JSON.stringify(e.data).includes("拆分完成 true"))).toBe(true);
      // The split and the check ran side by side; their text stays apart, each tagged with its check.
      const texts = runEvents(app, r.id).filter((e) => e.type === "text") as unknown as { data: { check?: string; text: string } }[];
      expect(new Set(texts.map((e) => e.data.check))).toEqual(new Set(["split", "reviewer"]));
      expect(texts.filter((e) => e.data.check === "reviewer").some((e) => e.data.text.includes("拆分完成"))).toBe(false);

      setRunOutput(app, r.id, { changePoints: null });
      const res = await fetch(`${app.baseUrl}/api/runs/${r.id}/change-points`, { method: "POST" });
      const splitRun = (await res.json()) as { id: string; kind: string };
      expect(splitRun.kind).toBe("review");
      run(app.db, "update runs set status = 'running' where id = ?", splitRun.id);
      await __testHandlers.get("review")!({ app, run: getRun(app, splitRun.id), signal: new AbortController().signal, event: (type, data) => addRunEvent(app, splitRun.id, type, data), output: (data) => setRunOutput(app, splitRun.id, data) });
      expect((await reviews()).rounds[0].changePoints?.map((p) => p.id)).toEqual(["C1"]);
      // The run page finds the split's process through the round.
      expect(((await reviews()).rounds[0] as unknown as { reviewRuns: { id: string }[] }).reviewRuns.map((x) => x.id)).toEqual([splitRun.id]);

      // Reworking the split by the owner's note: refused while a split is still running, then the
      // points as they stand and the note reach the splitter, which nests the point under a page.
      const again = () => fetch(`${app.baseUrl}/api/runs/${r.id}/change-points`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ revise: true, note: "按页面分组" }) });
      expect((await again()).status).toBe(409);
      run(app.db, "update runs set status = 'done' where id = ?", splitRun.id);
      const resplit = (await (await again()).json()) as { id: string; title: string };
      expect(resplit.title).toMatch(/^重新整理需求拆分/);
      run(app.db, "update runs set status = 'running' where id = ?", resplit.id);
      await __testHandlers.get("review")!({ app, run: getRun(app, resplit.id), signal: new AbortController().signal, event: (type, data) => addRunEvent(app, resplit.id, type, data), output: (data) => setRunOutput(app, resplit.id, data) });
      const tree = (await reviews()).rounds[0].changePoints as { id: string; parent?: string }[];
      expect(tree.map((p) => [p.id, p.parent])).toEqual([["M1", undefined], ["C1", "M1"]]);
      expect(runEvents(app, resplit.id).some((e) => JSON.stringify(e.data).includes("重新整理 true true"))).toBe(true);
      run(app.db, "update runs set status = 'done' where id = ?", resplit.id);
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
      expect(wt.targetBranch).toBe("feature/refund");
      // The change is relative to the branch: only the coder's line, not the branch's own commits.
      const patch = codePatches(app, r.id)[0].patch;
      expect(patch).toContain("export const round");
      expect(patch).not.toContain("lines.ts");
      discardCodeRun(app, r.id);
    } finally {
      await server.close();
    }
  }, 120000);

  it("codes in a reused workspace: dependencies are prepared once and stay for the next run", async () => {
    fake();
    writeFileSync(join(dir, ".git", "info", "exclude"), "node_modules/\n");
    const before = getSpace(app, "shop-api").settings;
    const setup = `node -e "const fs=require('fs');fs.mkdirSync('node_modules',{recursive:true});fs.appendFileSync('node_modules/installs','x')"`;
    updateSpace(app, "shop-api", { settings: { ...before, pool: 1, setupCommand: setup } });
    const server = await startServer(app, { port: 0, quiet: true });
    try {
      for (const n of [1, 2]) {
        const r = createRun(app, { kind: "code", spaceId: "shop-api", title: `第 ${n} 次`, input: { task: "按评审意见修改", repos: ["shop-api"], fromBranches: { "shop-api": "feature/refund" } } });
        await exec(r);
        const [wt] = worktreesOf(app, r.id);
        expect(wt.slot).toBe(managedSlot(app, "shop-api", 1));
        const prepared = runEvents(app, r.id).filter((e) => String((e.data as { text?: string }).text ?? "").startsWith("准备依赖"));
        expect(prepared).toHaveLength(n === 1 ? 1 : 0);
        expect(readFileSync(join(wt.slot!, "node_modules", "installs"), "utf8")).toBe("x");
        expect(codePatches(app, r.id)[0].patch).not.toContain("node_modules");
        run(app.db, "update runs set status = 'done' where id = ?", r.id);
        discardCodeRun(app, r.id);
      }
    } finally {
      updateSpace(app, "shop-api", { settings: before });
      await server.close();
    }
  }, 120000);

  it("codes in the repository's main directory when allowed: applying keeps the changes there, discarding resets it", async () => {
    fake();
    const before = getSpace(app, "shop-api").settings;
    updateSpace(app, "shop-api", { settings: { ...before, inPlace: true } });
    const branch = git("symbolic-ref", "--short", "HEAD").trim();
    const server = await startServer(app, { port: 0, quiet: true });
    const status = () => git("status", "--porcelain").trim();
    try {
      expect(status()).toBe("");
      const r = createRun(app, { kind: "code", spaceId: "shop-api", title: "主目录里改", input: { task: "按评审意见修改", repos: ["shop-api"] } });
      await exec(r);
      const [wt] = worktreesOf(app, r.id);
      expect(wt).toMatchObject({ inPlace: true, branch: "", targetBranch: branch });
      expect(resolve(wt.slot!)).toBe(resolve(dir));
      expect(status()).not.toBe("");
      const changed = status();
      run(app.db, "update runs set status = 'done' where id = ?", r.id);
      const res = applyCodeRun(app, r.id);
      expect(res.targets).toMatchObject([{ space: "shop-api", branch }]);
      expect(resolve(res.targets[0].path)).toBe(resolve(dir));
      // Already there: nothing applied twice, nothing reset, still on the owner's branch, no omem branch.
      expect(status()).toBe(changed);
      expect(git("symbolic-ref", "--short", "HEAD").trim()).toBe(branch);
      expect(git("branch", "--list", `omem/${r.id}`).trim()).toBe("");

      // While the main directory has uncommitted changes, the next run gets a worktree of its own.
      const r2 = createRun(app, { kind: "code", spaceId: "shop-api", title: "另一处", input: { task: "按评审意见修改", repos: ["shop-api"] } });
      await exec(r2);
      expect(worktreesOf(app, r2.id)[0].inPlace).toBeUndefined();
      run(app.db, "update runs set status = 'done' where id = ?", r2.id);
      discardCodeRun(app, r2.id);
      expect(status()).toBe(changed);

      // Discarding a run that worked in the main directory resets it.
      git("stash", "-u", "-q");
      const r3 = createRun(app, { kind: "code", spaceId: "shop-api", title: "丢弃", input: { task: "按评审意见修改", repos: ["shop-api"] } });
      await exec(r3);
      expect(worktreesOf(app, r3.id)[0].inPlace).toBe(true);
      run(app.db, "update runs set status = 'done' where id = ?", r3.id);
      // Meanwhile another delegation in a worktree of its own may not land in the borrowed main directory.
      const r4 = createRun(app, { kind: "code", spaceId: "shop-api", title: "并行", input: { task: "按评审意见修改", repos: ["shop-api"] } });
      await exec(r4);
      expect(worktreesOf(app, r4.id)[0].inPlace).toBeUndefined();
      run(app.db, "update runs set status = 'done' where id = ?", r4.id);
      expect(() => applyCodeRun(app, r4.id)).toThrow(new RegExp(`正借给交办 ${r3.id}`));
      discardCodeRun(app, r4.id);
      discardCodeRun(app, r3.id);
      expect(status()).toBe("");
      expect(git("symbolic-ref", "--short", "HEAD").trim()).toBe(branch);
      git("stash", "drop", "-q");
    } finally {
      updateSpace(app, "shop-api", { settings: before });
      await server.close();
    }
  }, 180000);
});
