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
});
