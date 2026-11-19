import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createRun } from "../src/agents/runs.ts";
import { callTool, type ToolContext } from "../src/agents/tools.ts";
import { run } from "../src/core/db.ts";
import { createSpace } from "../src/core/spaces.ts";
import { OWNER } from "../src/core/users.ts";
import { droppedFor, latestCodeWork } from "../src/flows/objects.ts";
import { listTasks, updateTask } from "../src/agents/code-tasks.ts";
import { getItem, upsertItem } from "../src/items/store.ts";
import { testApp } from "./helpers.ts";

const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
function repo() {
  const dir = mkdtempSync(join(tmpdir(), "omem-delegate-scope-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", env });
  git("init", "-q", "-b", "main");
  writeFileSync(join(dir, "refund.ts"), "export const refund = 0;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  return dir;
}

describe("delegate_code from a run that writes only its project space", () => {
  it("hands coding to a repository under that project, not to one elsewhere", async () => {
    const app = testApp();
    createSpace(app, { id: "shop", name: "示例商城", kind: "project" });
    createSpace(app, { id: "shop-web", name: "商城前端", kind: "repo", rootPath: repo(), parentId: "shop" });
    createSpace(app, { id: "other-api", name: "别的服务", kind: "repo", rootPath: repo() });
    const stage = createRun(app, { kind: "flow-stage", spaceId: "shop", title: "退款缺陷 · 修复", input: {} });
    // A flow stage: it reads the project's repositories but writes only the project space.
    const ctx: ToolContext = { app, runId: stage.id, spaceId: "shop", spaces: ["shop", "shop-web", "other-api"], writable: ["shop"], tools: null, actor: "agent", userId: OWNER };

    const ok = await callTool(ctx, "delegate_code", { repo_spaces: ["shop-web"], task: "退款金额只按未发货的行计算" });
    expect(ok.isError, ok.text).toBe(false);
    expect(ok.text).toMatch(/运行 r\w+/);

    const outside = await callTool(ctx, "delegate_code", { repo_spaces: ["other-api"], task: "顺手改一下别的服务" });
    expect(outside.isError).toBe(true);
    expect(outside.text).toContain("只能读");

    // Writing the repository's own content (a memory, a page) is still out of scope for this run.
    const note = await callTool(ctx, "remember", { space: "shop-web", content: "退款金额按未发货的行计算，见退款缺陷的复现记录。", kind: "fact" });
    expect(note.isError).toBe(true);
    run(app.db, "update runs set status = 'cancelled' where kind = 'code'");
  });

  it("puts another item's change into the open delegation on the branch, and that item follows it", async () => {
    const app = testApp();
    createSpace(app, { id: "shop", name: "示例商城", kind: "project" });
    createSpace(app, { id: "shop-web", name: "商城前端", kind: "repo", rootPath: repo(), parentId: "shop" });
    const a = upsertItem(app, undefined, { title: "退款金额按未发货的行算", spaceId: "shop" }, "user");
    const b = upsertItem(app, undefined, { title: "退款单号显示不全", spaceId: "shop" }, "user");
    const stage = createRun(app, { kind: "flow-stage", spaceId: "shop", title: "修复", input: {} });
    const ctx: ToolContext = { app, runId: stage.id, spaceId: "shop", spaces: ["shop", "shop-web"], writable: ["shop"], tools: null, actor: "agent", userId: OWNER };
    const first = await callTool(ctx, "delegate_code", { repo_spaces: ["shop-web"], task: "退款金额按未发货的行算", item_id: a.id, branch: "feat/refund" });
    expect(first.isError, first.text).toBe(false);
    const runId = /运行 (r\w+)/.exec(first.text)![1];
    expect(latestCodeWork(app, getItem(app, b.id))).toBeNull();

    const joined = await callTool(ctx, "continue_code_run", { run_id: runId, when: "now", task: "退款单号在列表里显示不全，改成完整显示", new_item: true, item_id: b.id });
    expect(joined.isError, joined.text).toBe(false);
    expect(latestCodeWork(app, getItem(app, b.id))?.rootId).toBe(latestCodeWork(app, getItem(app, a.id))?.rootId);
    run(app.db, "update runs set status = 'cancelled' where kind = 'code'");
  });

  it("a joined item whose own change was declined is not fixed when the delegation ends", async () => {
    const app = testApp();
    createSpace(app, { id: "shop", name: "示例商城", kind: "project" });
    createSpace(app, { id: "shop-web", name: "商城前端", kind: "repo", rootPath: repo(), parentId: "shop" });
    const a = upsertItem(app, undefined, { title: "退款金额按未发货的行算", spaceId: "shop" }, "user");
    const b = upsertItem(app, undefined, { title: "退款单保存失败", spaceId: "shop" }, "user");
    const stage = createRun(app, { kind: "flow-stage", spaceId: "shop", title: "修复", input: {} });
    const ctx: ToolContext = { app, runId: stage.id, spaceId: "shop", spaces: ["shop", "shop-web"], writable: ["shop"], tools: null, actor: "agent", userId: OWNER };
    const first = await callTool(ctx, "delegate_code", { repo_spaces: ["shop-web"], task: "退款金额按未发货的行算", item_id: a.id, branch: "feat/refund" });
    const runId = /运行 (r\w+)/.exec(first.text)![1];
    // Between rounds the joined change becomes a task of its own, marked with the item it came from.
    run(app.db, "update runs set status = 'done', output = json_set(coalesce(output, '{}'), '$.coderSummary', '做完了') where kind = 'code'");
    const joined = await callTool(ctx, "continue_code_run", { run_id: runId, when: "now", task: "退款单保存失败，查清后修复", new_item: true, item_id: b.id });
    expect(joined.text).toContain("已记成修改项");
    const rootId = latestCodeWork(app, getItem(app, b.id))!.rootId;
    const mine = listTasks(app, rootId).filter((t) => t.origin.item === b.id);
    expect(mine).toHaveLength(1);
    expect(droppedFor(app, getItem(app, a.id), rootId)).toBeNull();
    expect(droppedFor(app, getItem(app, b.id), rootId)).toBeNull();
    updateTask(app, rootId, mine[0].seq, { state: "wontdo", answer: "原因在下游服务，不在这个仓库" });
    expect(droppedFor(app, getItem(app, b.id), rootId)).toContain("原因在下游服务");
    run(app.db, "update runs set status = 'cancelled' where kind = 'code'");
  });
});
