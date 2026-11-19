import { afterAll, describe, expect, it } from "vitest";
import { createRun, setRunOutput } from "../src/agents/runs.ts";
import { openDelegationOn } from "../src/agents/review-fix.ts";
import { run } from "../src/core/db.ts";
import { createSpace } from "../src/core/spaces.ts";
import { testApp } from "./helpers.ts";

const app = testApp();
afterAll(() => app.db.close());
createSpace(app, { id: "shop-web", name: "商城前端", kind: "repo" });

describe("one delegation per branch", () => {
  it("counts a delegation still queued or preparing on the branch it asked for", () => {
    // Two flows' stages delegate on the same branch minutes apart: the first has no worktree yet.
    const first = createRun(app, { kind: "code", spaceId: "shop-web", title: "退款按钮文案", input: { task: "改文案", repos: ["shop-web"], fromBranches: { "shop-web": "feat/refund" } } });
    expect(openDelegationOn(app, ["shop-web"], "feat/refund", "owner")?.id).toBe(first.id);
    expect(openDelegationOn(app, ["shop-web"], "origin/feat/refund", "owner")?.id).toBe(first.id);
    expect(openDelegationOn(app, ["shop-web"], "feat/other", "owner")).toBeNull();
    expect(openDelegationOn(app, ["shop-api"], "feat/refund", "owner")).toBeNull();
    // Ended without a worktree (failed before preparing): nothing is open there.
    run(app.db, "update runs set status = 'failed' where id = ?", first.id);
    expect(openDelegationOn(app, ["shop-web"], "feat/refund", "owner")).toBeNull();
    // Once it has its worktree, that decides (it was gone here: not open).
    const second = createRun(app, { kind: "code", spaceId: "shop-web", title: "退款列表", input: { task: "改列表", repos: ["shop-web"], fromBranches: { "shop-web": "feat/refund" } } });
    setRunOutput(app, second.id, { worktrees: [{ space: "shop-web", path: "/nonexistent/wt", branch: "feat/refund", base: "", targetBranch: "feat/refund" }] });
    expect(openDelegationOn(app, ["shop-web"], "feat/refund", "owner")).toBeNull();
  });
});
