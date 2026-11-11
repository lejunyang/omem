import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import "../src/agents/jobs.ts";
import { discardCodeRun, worktreesOf } from "../src/agents/code.ts";
import { fileAt, workPatches, WORKTREE } from "../src/agents/code-tasks.ts";
import { startServer } from "../src/server/http.ts";
import { __testHandlers, addRunEvent, createRun, getRun, listRuns, setRunOutput } from "../src/agents/runs.ts";
import { callTool, type ToolContext } from "../src/agents/tools.ts";
import { run } from "../src/core/db.ts";
import { createSpace, updateSpace } from "../src/core/spaces.ts";
import { testApp } from "./helpers.ts";

const app = testApp();
afterAll(() => app.db.close());

const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
const dir = mkdtempSync(join(tmpdir(), "omem-peer-code-"));
const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", env });
git("init", "-q", "-b", "main");
writeFileSync(join(dir, "refund.ts"), "export function refundAmount() {\n  return 0;\n}\n");
git("add", "-A");
git("commit", "-q", "-m", "init");
createSpace(app, { id: "shop-api", name: "订单服务", kind: "repo", rootPath: dir });
updateSpace(app, "shop-api", { settings: { setupCommand: "none", checkCommand: "node -e \"process.exit(0)\"", peerCommands: "test: node -e \"console.log('tests ran')\"\nshot: node -e \"require('fs').writeFileSync(require('path').join(process.env.OMEM_ARTIFACTS, 'shot.txt'), 'list')\"" } });

/** Run one queued round of the delegation as the job runner would. */
async function runRound(id: string) {
  run(app.db, "update runs set status = 'running' where id = ?", id);
  const out = (await __testHandlers.get("code")!({
    app, run: getRun(app, id), signal: new AbortController().signal,
    event: (type, data) => addRunEvent(app, id, type, data),
    output: (data) => setRunOutput(app, id, data),
  })) as { verdict: string };
  run(app.db, "update runs set status = 'done' where id = ?", id);
  return out.verdict;
}

describe("coding an outside Agent on another device does itself", () => {
  it("prepares the worktree here, lets the Agent edit and run allowed commands, then checks and hands the review back", async () => {
    // No backend at all: anything that asked a model here would fail.
    app.config.agents.default = "no-such-backend";
    app.config.review = { tiers: [{ id: "light", name: "轻量", guide: "", when: null, checks: ["reviewer"], maxRounds: 2, lead: false, confirmPlan: false }], rereviewAllEvery: 2, checks: {} };
    const peerCtx = (caller: string): ToolContext => ({ app, runId: null, spaceId: "shop-api", spaces: null, tools: null, actor: "agent", agentProfile: `peer:${caller}`, model: "claude-test", peer: { caller, session: "编码" } });
    const ctx = peerCtx("laptop");
    expect((await callTool(ctx, "delegate_code", { repo_spaces: ["shop-api"], task: "x", execution: { profile: "codex", reason: "y" } })).text).toMatch(/它自己做/);
    const started = await callTool(ctx, "delegate_code", { repo_spaces: ["shop-api"], task: "退款只按未发货的行计算", branch: "feat/refund" });
    expect(started.isError).toBeFalsy();
    const runId = started.text.match(/运行 (r\w+)/)![1];
    expect((await callTool(ctx, "code_workspace", { run_id: runId, action: "read", path: "refund.ts" })).text).toMatch(/还在准备/);

    expect(await runRound(runId)).toBe("awaiting-peer-code");
    const brief = (await callTool(ctx, "code_workspace", { run_id: runId, action: "brief" })).text;
    expect(brief).toContain("退款只按未发货的行计算");
    expect(brief).toMatch(/feat\/refund/);
    expect(brief).toMatch(/test：node -e/);

    // Reading, editing and running only inside the worktree, and only what the owner allowed.
    expect((await callTool(ctx, "code_workspace", { run_id: runId, action: "read", path: "refund.ts" })).text).toMatch(/1\texport function refundAmount/);
    expect((await callTool(ctx, "code_workspace", { run_id: runId, action: "read", path: "../outside.ts" })).text).toMatch(/相对路径/);
    expect((await callTool(ctx, "code_workspace", { run_id: runId, action: "write", path: ".git/config", content: "x" })).text).toMatch(/\.git/);
    expect((await callTool(ctx, "code_workspace", { run_id: runId, action: "edit", path: "refund.ts", old: "return 0;", new: "return lines.filter((l) => !l.shipped).length;" })).text).toMatch(/已修改/);
    expect((await callTool(ctx, "code_workspace", { run_id: runId, action: "write", path: "lines.test.ts", content: "// shipped lines\n" })).text).toMatch(/已新建/);
    // A new file in new directories (the workspace may sit behind a link, e.g. a linked home directory).
    expect((await callTool(ctx, "code_workspace", { run_id: runId, action: "write", path: "tests/ui/new-dir/deep.test.ts", content: "// nested\n" })).text).toMatch(/已新建/);
    expect((await callTool(ctx, "code_workspace", { run_id: runId, action: "grep", pattern: "shipped" })).text).toMatch(/refund\.ts:2/);
    // Before the Agent hands anything in, the owner sees what it has changed so far: uncommitted edits and
    // new files too, read without touching the workspace's own index.
    const wts = worktreesOf(app, runId);
    const [loose] = await workPatches(app, runId, wts, { work: true });
    expect(loose.to).toBe(WORKTREE);
    expect(loose.patch).toContain("+  return lines.filter");
    expect(loose.patch).toContain("+++ b/lines.test.ts");
    expect(loose.patch).toContain("+++ b/tests/ui/new-dir/deep.test.ts");
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: wts[0].path, encoding: "utf8" })).toContain("?? lines.test.ts");
    expect(fileAt(app, wts, "shop-api", "lines.test.ts", WORKTREE)!.toString()).toBe("// shipped lines\n");
    expect(fileAt(app, wts, "shop-api", "refund.ts", loose.from!)!.toString()).toContain("return 0;");
    expect(fileAt(app, wts, "shop-api", "no-such.ts", WORKTREE)).toBeNull();
    expect(() => fileAt(app, wts, "shop-api", "../outside.ts", WORKTREE)).toThrow(/路径/);
    // Over HTTP (the web page's “变更” and the editor): a work not driven by tasks gives its whole change, not a refusal.
    const server = await startServer(app, { port: 0, host: "127.0.0.1", quiet: true });
    try {
      const api = async (path: string) => { const r = await fetch(`${app.baseUrl}${path}`); return { status: r.status, body: (await r.json()) as any }; };
      const whole = await api(`/api/runs/${runId}/task-diff`);
      expect(whole.status).toBe(200);
      expect(whole.body.patches[0]).toMatchObject({ space: "shop-api", to: WORKTREE, from: loose.from });
      expect((await api(`/api/runs/${runId}/task-diff?work=1`)).body.patches[0].patch).toBe(whole.body.patches[0].patch);
      const byTask = await api(`/api/runs/${runId}/task-diff?tasks=1`);
      expect(byTask.status).toBe(400);
      expect(byTask.body.error).toMatch(/不是按修改项推进的/);
      expect((await api(`/api/runs/${runId}/file-at?space=shop-api&path=lines.test.ts&rev=worktree`)).body.text).toBe("// shipped lines\n");
      expect((await api(`/api/runs/${runId}/task-diff?base=main`)).status).toBe(200);
    } finally {
      await server.close();
    }
    expect((await callTool(ctx, "code_workspace", { run_id: runId, action: "run", command: "rm", args: ["-rf"] })).text).toMatch(/只能运行本人给仓库/);
    expect((await callTool(ctx, "code_workspace", { run_id: runId, action: "run", command: "test", args: ["a;rm"] })).text).toMatch(/shell 符号/);
    const ran = (await callTool(ctx, "code_workspace", { run_id: runId, action: "run", command: "test", args: ["lines.test.ts"] })).text;
    expect(ran).toMatch(/退出码 0[\s\S]*tests ran/);
    // What a command writes to OMEM_ARTIFACTS, and a file of the workspace handed in, become the work's artifacts.
    expect((await callTool(ctx, "code_workspace", { run_id: runId, action: "run", command: "shot" })).text).toMatch(/收下 1 个产物：shot\.txt/);
    expect((await callTool(ctx, "code_workspace", { run_id: runId, action: "attach", path: "lines.test.ts", caption: "新加的测试" })).text).toMatch(/收下 1 个产物：lines\.test\.ts/);
    expect((await callTool(ctx, "code_workspace", { run_id: runId, action: "attach", path: "../outside.ts" })).text).toMatch(/找不到/);
    const { listArtifacts } = await import("../src/agents/artifacts.ts");
    expect((await listArtifacts(app, runId)).map((a) => [a.name, a.source, a.caption])).toEqual([["shot.txt", "command", "命令 node -e \"require('fs').writeFileSync(require('path').join(process.env.OMEM_ARTIFACTS, 'shot.txt'), 'list')\""], ["lines.test.ts", "agent", "新加的测试"]]);
    expect((await callTool(ctx, "code_workspace", { run_id: runId, action: "git", git: "commit", message: "只退未发货的行" })).text).toMatch(/已提交/);
    // Everything committed: the change is between two commits.
    const [committed] = await workPatches(app, runId, worktreesOf(app, runId), { work: true });
    expect(committed.to).toMatch(/^[0-9a-f]{40}$/);
    expect(committed.patch).toContain("+++ b/lines.test.ts");
    expect(fileAt(app, worktreesOf(app, runId), "shop-api", "lines.test.ts", committed.to!)!.toString()).toBe("// shipped lines\n");
    // A design over a work with no tasks: a decision's change is its files' part of the whole change.
    const { createDesign, getDesign, submitRevision } = await import("../src/designs/store.ts");
    const { designDiff } = await import("../src/designs/changes.ts");
    const dsg = createDesign(app, { spaceId: "shop-api", title: "退款按行算", origin: "external", repos: ["shop-api"], workId: runId });
    submitRevision(app, dsg.id, { decisions: [{ kind: "change", title: "只退未发货的行", files: ["refund.ts"] }], outside: ["shop-api/lines.test.ts"] });
    const part = await designDiff(app, getDesign(app, dsg.id), "D1");
    expect(part.patches).toHaveLength(1);
    expect(part.patches[0]).toMatchObject({ space: "shop-api", from: committed.from, to: committed.to });
    expect(part.patches[0].patch).toContain("+++ b/refund.ts");
    expect(part.patches[0].patch).not.toContain("lines.test.ts");
    expect((await designDiff(app, getDesign(app, dsg.id), "outside")).patches[0].patch).toContain("+++ b/lines.test.ts");
    // Another branch merged in: the conflict stays in the file, the Agent fixes it and commits.
    git("checkout", "-q", "-b", "feat/other", "main");
    writeFileSync(join(dir, "refund.ts"), "export function refundAmount() {\n  return -1;\n}\n");
    git("commit", "-qam", "other");
    git("checkout", "-q", "main");
    const merged = (await callTool(ctx, "code_workspace", { run_id: runId, action: "git", git: "merge", ref: "feat/other" })).text;
    expect(merged).toMatch(/1 个文件冲突[\s\S]*refund\.ts/);
    expect((await callTool(ctx, "code_workspace", { run_id: runId, action: "read", path: "refund.ts" })).text).toContain("<<<<<<<");
    await callTool(ctx, "code_workspace", { run_id: runId, action: "write", path: "refund.ts", content: "export function refundAmount(lines: { shipped: boolean }[]) {\n  return lines.filter((l) => !l.shipped).length;\n}\n" });
    expect((await callTool(ctx, "code_workspace", { run_id: runId, action: "git", git: "commit", message: "合并 feat/other" })).text).toMatch(/已提交/);
    expect((await callTool(ctx, "code_workspace", { run_id: runId, action: "git", git: "log" })).text).toMatch(/合并 feat\/other/);
    // An older, unapplied delegation's saved changes taken over into this workspace.
    const old = createRun(app, { kind: "code", spaceId: "shop-api", title: "旧交办", input: { task: "旧的改动", repos: ["shop-api"] } });
    run(app.db, "update runs set status = 'done' where id = ?", old.id);
    setRunOutput(app, old.id, { repos: [{ space: "shop-api", diffStat: "", diffBytes: 1, check: null }] });
    mkdirSync(join(app.runsDir, old.id, "patches"), { recursive: true });
    writeFileSync(join(app.runsDir, old.id, "patches", "shop-api.patch"), "diff --git a/notes.md b/notes.md\nnew file mode 100644\n--- /dev/null\n+++ b/notes.md\n@@ -0,0 +1 @@\n+旧交办写的说明\n");
    expect((await callTool(ctx, "code_workspace", { run_id: runId, action: "import", from_run: old.id })).text).toMatch(/已导入交办 .*1 个文件改动/);
    expect((await callTool(ctx, "code_workspace", { run_id: runId, action: "read", path: "notes.md" })).text).toContain("旧交办写的说明");
    expect((await callTool(ctx, "code_workspace", { run_id: runId, action: "import", from_run: old.id })).text).toMatch(/先 commit/);
    await callTool(ctx, "code_workspace", { run_id: runId, action: "git", git: "commit", message: "接手旧交办的说明" });
    // Another device, or this machine's own Agents, cannot work in it.
    expect((await callTool(peerCtx("other"), "code_workspace", { run_id: runId, action: "brief" })).text).toMatch(/不是 other/);
    expect((await callTool({ ...ctx, peer: undefined }, "code_workspace", { run_id: runId, action: "brief" })).isError).toBe(true);

    // finish: a round that commits, checks and waits for this Agent's own review.
    const finished = (await callTool(ctx, "code_workspace", { run_id: runId, action: "finish", summary: "退款按未发货的行计算，补了测试" })).text;
    const next = finished.match(/第 2 轮 (r\w+)/)![1];
    expect((await callTool(ctx, "code_workspace", { run_id: runId, action: "write", path: "x.ts", content: "" })).text).toMatch(/排队/);
    expect(await runRound(next)).toBe("awaiting-peer");
    const round = getRun(app, next).output as { coderSummary: string; diffStat: string; check: { code: number } };
    expect(round.coderSummary).toContain("退款按未发货的行计算");
    expect(round.diffStat).toMatch(/refund\.ts/);
    expect(round.check.code).toBe(0);
    expect((await callTool(ctx, "review_task", { run_id: next })).text).toContain("退款按未发货的行计算");
    const done = await callTool(ctx, "submit_review", { run_id: next, check: "reviewer", verdict: "approved", summary: "按行过滤正确", findings: [] });
    expect(done.text).toMatch(/都交齐了/);
    expect(listRuns(app, { includeQuiet: true }).some((r) => r.kind === "review" && r.parentId === next)).toBe(true);
    discardCodeRun(app, runId);
  }, 120000);
});
