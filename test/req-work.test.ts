import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createRun, getRun, setRunOutput } from "../src/agents/runs.ts";
import { recordReview, roundFindings } from "../src/agents/review.ts";
import { codeHere, fixedByInfo, inheritedSplit, markFindingsFixed, newerWork, reviseFinding, sameBranchWork, setFindingSuggestion, startFix } from "../src/agents/review-fix.ts";
import { callTool, type ToolContext } from "../src/agents/tools.ts";
import { run } from "../src/core/db.ts";
import { createSpace } from "../src/core/spaces.ts";
import { OWNER } from "../src/core/users.ts";
import { addMaterials } from "../src/items/materials.ts";
import { saveReqs } from "../src/items/requirements.ts";
import { upsertItem } from "../src/items/store.ts";
import { reqWork, reqWorkMarks } from "../src/items/work.ts";
import { testApp } from "./helpers.ts";

const app = testApp();
afterAll(() => app.db.close());

const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
const dir = mkdtempSync(join(tmpdir(), "omem-req-work-"));
const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", env });
git("init", "-q", "-b", "main");
writeFileSync(join(dir, "refund.ts"), "export const refund = 0;\n");
git("add", "-A");
git("commit", "-q", "-m", "init");
createSpace(app, { id: "shop-api", name: "订单服务", kind: "repo", rootPath: dir });
createSpace(app, { id: "shop", name: "示例商城", kind: "project" });

describe("coding seen from the requirement tree", () => {
  it("puts an item's delegation in the item's space, lists it on the item's nodes, and follows the owner's rewritten suggestion", async () => {
    const tree = saveReqs(app, [
      { op: "add", key: "page", kind: "page", title: "退款申请页" },
      { op: "add", key: "amount", parent: "$page", kind: "feature", title: "退款金额只算未发货的行" },
    ], { by: "user", label: "本人" }, { canWrite: () => {}, canRead: () => {}, defaultSpace: "shop" });
    const page = tree.keys.page, amount = tree.keys.amount;
    const item = upsertItem(app, undefined, { spaceId: "personal", kind: "todo", title: "退款改造", userId: OWNER }, "user");
    addMaterials(app, item.id, [{ kind: "req", ref: page }], OWNER, "user");

    const ctx: ToolContext = { app, runId: null, spaceId: "shop", spaces: null, tools: null, actor: "agent" };
    const started = await callTool(ctx, "delegate_code", { repo_spaces: ["shop-api"], task: "退款只按未发货的行计算", item_id: item.id });
    expect(started.isError).toBeFalsy();
    const id = started.text.match(/运行 (r\w+)/)![1];
    // The business of the item's requirement tree: not the first repository, nor the item's own (personal) space.
    expect(getRun(app, id).spaceId).toBe("shop");

    // The item is about the page: the feature under it and the page itself both show the work.
    expect(reqWork(app, amount, OWNER).map((w) => [w.rootId, w.stage])).toEqual([[id, "coding"]]);
    expect(reqWork(app, page, OWNER)).toHaveLength(1);
    expect(reqWorkMarks(app, "shop", OWNER).get(page)).toEqual({ total: 1, waiting: 0 });

    // Reviewed and waiting for the owner, with one finding to decide.
    run(app.db, "update runs set status = 'done' where id = ?", id);
    setRunOutput(app, id, { verdict: "changes-requested", worktrees: [{ space: "shop-api", path: dir, branch: "omem/refund", base: "main", targetBranch: "main" }] });
    recordReview(app, { codeRunId: id, round: 1, check: "reviewer", verdict: "changes_requested", summary: "运费没按比例", findings: [{ severity: "major", file: "refund.ts", line: 1, title: "运费没有按比例退", detail: "整单运费都退了", suggestion: "按已发货金额扣掉运费", evidence: [], confidence: "high" }] });
    const [w] = reqWork(app, amount, OWNER);
    expect(w).toMatchObject({ stage: "owner", open: 1, branch: "main", rounds: [id] });
    expect(reqWorkMarks(app, "shop", OWNER).get(page)).toEqual({ total: 1, waiting: 1 });

    // The owner rewrites the suggestion: kept beside the original, the finding is now one to fix.
    const f = roundFindings(app, id, 1)[0];
    expect(setFindingSuggestion(app, id, f.id, "运费按未发货金额占比退，不是扣掉已发货的")).toMatchObject({ decision: "fix" });
    expect(roundFindings(app, id, 1)[0]).toMatchObject({ suggestion: "按已发货金额扣掉运费", owner_suggestion: "运费按未发货金额占比退，不是扣掉已发货的" });
    expect(reqWork(app, amount, OWNER)[0].open).toBe(0);
    // The same text as the reviewer's is no rewrite; empty goes back to the original.
    expect(setFindingSuggestion(app, id, f.id, "按已发货金额扣掉运费").ownerSuggestion).toBeNull();
    setFindingSuggestion(app, id, f.id, "运费按未发货金额占比退，不是扣掉已发货的");

    // The next round acts on the owner's version only.
    const next = await startFix(app, id, { findingIds: [f.id] }, OWNER);
    const task = String((next.input as { task: string }).task);
    expect(task).toContain("建议（本人改写，以此为准）：运费按未发货金额占比退");
    expect(task).not.toContain("按已发货金额扣掉运费");
    expect(next.spaceId).toBe("shop");
    expect(reqWork(app, amount, OWNER)[0]).toMatchObject({ rounds: [id, next.id], stage: "coding" });

    setFindingSuggestion(app, id, f.id, "");
    expect(roundFindings(app, id, 1)[0].owner_suggestion).toBeNull();
  });

  it("fixes findings of two reviews of the same branch in one go", async () => {
    const review = (title: string) => {
      const r = createRun(app, { kind: "code", spaceId: "shop", title, input: { branches: { "shop-api": { branch: "feat/refund" } }, repos: ["shop-api"] } });
      run(app.db, "update runs set status = 'done' where id = ?", r.id);
      return r;
    };
    const a = review("评审 A"), b = review("评审 B");
    recordReview(app, { codeRunId: a.id, round: 1, check: "reviewer", verdict: "changes_requested", summary: "", findings: [{ severity: "minor", title: "A 说的问题", detail: "", suggestion: "", evidence: [], confidence: "high" }] });
    recordReview(app, { codeRunId: b.id, round: 1, check: "review-style", verdict: "changes_requested", summary: "", findings: [{ severity: "nit", title: "B 说的风格问题", detail: "", suggestion: "改成查表", evidence: [], confidence: "high" }, { severity: "minor", title: "B 没选的问题", detail: "", suggestion: "", evidence: [], confidence: "high" }] });
    expect(sameBranchWork(app, a.id, OWNER).map((w) => w.rootId)).toEqual([b.id]);
    const [fa] = roundFindings(app, a.id, 1);
    const [fb, fb2] = roundFindings(app, b.id, 1);
    // Without saying so, another review's finding is not this one's.
    await expect(startFix(app, a.id, { findingIds: [fa.id, fb.id] }, OWNER)).rejects.toThrow(/同一分支/);
    const fix = await startFix(app, a.id, { findingIds: [fa.id, fb.id], withSameBranch: true }, OWNER);
    const task = String((fix.input as { task: string }).task);
    expect(task).toMatch(/A 说的问题[\s\S]*B 说的风格问题[\s\S]*改成查表/);
    expect(task).toContain(`以及同一分支的 ${b.id}`);
    expect(roundFindings(app, b.id, 1).map((f) => f.decision)).toEqual(["fix", "later"]);
    expect(fb2.title).toBe("B 没选的问题");

    // B, opened later, shows the chosen finding as taken on by the fix and names the fix as the newer code.
    run(app.db, "update runs set created_at = ? where id = ?", new Date(Date.now() + 1000).toISOString(), fix.id);
    expect(roundFindings(app, b.id, 1).map((f) => f.fixed_by ?? null)).toEqual([fix.id, null]);
    expect(fixedByInfo(app, [fix.id])[fix.id]).toMatchObject({ rootId: fix.id, applied: false, discarded: false });
    expect(newerWork(app, b.id, OWNER)?.rootId).toBe(fix.id);
    expect(newerWork(app, fix.id, OWNER)).toBeNull();
    // Fixed elsewhere: the owner marks the other one too, and can take it back; only code on the branch counts.
    markFindingsFixed(app, b.id, [fb2.id], fix.id, OWNER);
    expect(roundFindings(app, b.id, 1)[1].fixed_by).toBe(fix.id);
    markFindingsFixed(app, b.id, [fb2.id], null, OWNER);
    expect(roundFindings(app, b.id, 1)[1].fixed_by).toBeNull();
    const elsewhere = createRun(app, { kind: "code", spaceId: "shop", title: "别的分支", input: { branches: { "shop-api": { branch: "feat/other" } }, repos: ["shop-api"] } });
    expect(() => markFindingsFixed(app, b.id, [fb2.id], elsewhere.id, OWNER)).toThrow(/同一分支/);
    expect(() => markFindingsFixed(app, b.id, [fa.id], fix.id, OWNER)).toThrow(/不属于/);
    // A discarded fix no longer counts.
    setRunOutput(app, fix.id, { ...getRun(app, fix.id).output, discardedAt: new Date().toISOString() });
    expect(fixedByInfo(app, [fix.id])[fix.id].discarded).toBe(true);
  });

  it("lets a round without a requirement split borrow the latest one of the branch", () => {
    const reviewRun = createRun(app, { kind: "code", spaceId: "shop", title: "分支评审", input: { branches: { "shop-api": { branch: "feat/split" } }, repos: ["shop-api"] } });
    recordReview(app, { codeRunId: reviewRun.id, round: 1, check: "review-business", verdict: "approved", summary: "", findings: [], changePoints: [{ id: "C1", title: "退款金额", status: "done", requirement: "", implementation: "", refs: [], locations: [{ file: "refund.ts" }] }] });
    const tidy = createRun(app, { kind: "code", spaceId: "shop", title: "整理代码", input: { task: "改风格", repos: ["shop-api"], fromBranches: { "shop-api": "feat/split" } } });
    run(app.db, "update runs set created_at = ? where id = ?", new Date(Date.now() + 2000).toISOString(), tidy.id);
    expect(inheritedSplit(app, tidy.id, OWNER)).toMatchObject({ runId: reviewRun.id, rootId: reviewRun.id, title: "分支评审", sameWork: false, branchReview: true });
    // Another branch's split is not borrowed.
    const other = createRun(app, { kind: "code", spaceId: "shop", title: "别的分支", input: { task: "x", repos: ["shop-api"], fromBranches: { "shop-api": "feat/none" } } });
    expect(inheritedSplit(app, other.id, OWNER)).toBeNull();
  });
  it("codes a fix here after an outside Agent coded the rounds before, and re-describes a finding", async () => {
    const peerCoder = { caller: "laptop", session: "s" };
    const root = createRun(app, { kind: "code", spaceId: "shop", title: "外部编码", input: { task: "改退款", repos: ["shop-api"], peerCoder } });
    run(app.db, "update runs set status = 'done' where id = ?", root.id);
    setRunOutput(app, root.id, { verdict: "changes-requested", worktrees: [{ space: "shop-api", path: dir, branch: "omem/peer", base: "main", targetBranch: "main" }] });
    recordReview(app, { codeRunId: root.id, round: 1, check: "reviewer", verdict: "changes_requested", summary: "", findings: [{ severity: "major", file: "refund.ts", line: 1, title: "入口消失", detail: "重新审核后入口消失", suggestion: "", evidence: [], confidence: "high" }] });
    const f = roundFindings(app, root.id, 1)[0];

    // Re-described: new wording, the first one kept; again keeps the first.
    reviseFinding(app, root.id, f.id, { title: "工具重新提交审核后，『取消挂载』按钮不再显示", detail: "**现在的实现**\n- [按钮条件](refund.ts:1)" });
    reviseFinding(app, root.id, f.id, { detail: "**问题**\n- 按钮不显示" });
    const revised = roundFindings(app, root.id, 1)[0];
    expect(revised).toMatchObject({ title: "工具重新提交审核后，『取消挂载』按钮不再显示", detail: "**问题**\n- 按钮不显示" });
    expect(JSON.parse(revised.revised!)).toMatchObject({ title: "入口消失", detail: "重新审核后入口消失" });

    // The owner's fix round is coded and reviewed here, not left for the outside Agent.
    const next = await startFix(app, root.id, { findingIds: [f.id] }, OWNER);
    expect((next.input as { peerCoder?: unknown }).peerCoder).toBeUndefined();

    // A round that did wait for it can be handed to this machine; the finding follows.
    run(app.db, "update runs set status = 'done' where id = ?", next.id);
    setRunOutput(app, next.id, { verdict: "awaiting-peer-code" });
    run(app.db, "update runs set input = json_set(input, '$.peerCoder', json(?)) where id = ?", JSON.stringify(peerCoder), next.id);
    const here = codeHere(app, next.id, OWNER);
    expect(here.input).toMatchObject({ task: (next.input as { task: string }).task, continueFrom: root.id, round: 3 });
    expect((here.input as { peerCoder?: unknown }).peerCoder).toBeUndefined();
    expect(roundFindings(app, root.id, 1)[0].fixed_by).toBe(here.id);
    expect(() => codeHere(app, root.id, OWNER)).toThrow(/不是在等/);
  });
});
