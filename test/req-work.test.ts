import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { getRun, setRunOutput } from "../src/agents/runs.ts";
import { recordReview, roundFindings } from "../src/agents/review.ts";
import { setFindingSuggestion, startFix } from "../src/agents/review-fix.ts";
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
});
