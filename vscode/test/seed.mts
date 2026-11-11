/**
 * An omem for the extension test: a repository space, a finished delegation whose worktree has a
 * change and whose review has findings, a task-driven delegation with a task done and one waiting
 * for the owner and a design it codes from, a delegation an outside Agent has not handed in, and the fake ACP agent (answers echo the question).
 * Prints `{ url, folder, runId }` on one line once the server listens. Run from the repository
 * root: node vscode/test/seed.mts <home>
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { App } from "../../src/core/app.ts";
import { createSpace, ensurePersonalSpace } from "../../src/core/spaces.ts";
import { createRun, setRunOutput } from "../../src/agents/runs.ts";
import { recordReview } from "../../src/agents/review.ts";
import { addTask, recordCheckpoint, setWorkState, updateTask } from "../../src/agents/code-tasks.ts";
import { createDesign, submitRevision } from "../../src/designs/store.ts";
import { run as sql } from "../../src/core/db.ts";
import { boot } from "../../src/main.ts";
import { addPeer } from "../../src/core/peers.ts";
import { createApiToken, OWNER } from "../../src/core/users.ts";

const home = process.argv[2] ?? mkdtempSync(join(tmpdir(), "omem-vscode-"));
const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env });

mkdirSync(home, { recursive: true });
writeFileSync(join(home, "config.json"), JSON.stringify({
  agents: { default: "fake", profiles: [{ id: "fake", name: "fake", transport: "acp", command: process.execPath, args: [resolve("test/fake-acp-agent.ts")], env: { FAKE_MODE: "thread" }, idleTimeoutMs: 60000 }] },
}));

const app = App.open(home);
ensurePersonalSpace(app);
const repo = join(home, "shop-web");
mkdirSync(repo);
git(repo, "init", "-q", "-b", "main");
writeFileSync(join(repo, "refund.ts"), "export function refund(amount: number) {\n  return amount;\n}\n");
git(repo, "add", "-A");
git(repo, "commit", "-q", "-m", "init");
createSpace(app, { id: "shop-web", name: "商城前端", kind: "repo", rootPath: repo });

const r = createRun(app, { kind: "code", spaceId: "shop-web", title: "退款金额保留两位小数", input: { task: "退款金额保留两位小数", repos: ["shop-web"] } });
const folder = join(app.runsDir, r.id, "work", "shop-web");
const base = git(repo, "rev-parse", "HEAD").trim();
git(repo, "worktree", "add", "-q", "-b", `omem/${r.id}`, folder, base);
writeFileSync(join(folder, "refund.ts"), "export function refund(amount: number) {\n  return Math.round(amount * 100) / 100;\n}\n");
git(folder, "add", "-A");
mkdirSync(join(app.runsDir, r.id, "patches"), { recursive: true });
writeFileSync(join(app.runsDir, r.id, "patches", "shop-web.patch"), git(folder, "diff", "--cached", "--no-color", "HEAD"));
setRunOutput(app, r.id, { worktrees: [{ space: "shop-web", path: folder, branch: `omem/${r.id}`, base, targetBranch: "main" }], repos: [{ space: "shop-web", diffStat: "", diffBytes: 1, check: null }], verdict: "changes-requested" });
recordReview(app, {
  codeRunId: r.id, round: 1, check: "reviewer", verdict: "changes_requested", summary: "四舍五入方式要和财务对齐",
  findings: [
    { severity: "major", file: "refund.ts", line: 2, title: "负数金额的舍入方向不对", detail: "Math.round 对 -0.005 向正方向舍入。", suggestion: "用财务约定的舍入函数。", evidence: [], confidence: "high" },
    { severity: "minor", title: "缺少单元测试", detail: "没有覆盖小数位的测试。", suggestion: "补一条测试。", evidence: [], confidence: "medium" },
  ],
});
sql(app.db, "update runs set status = 'done', finished_at = ? where id = ?", new Date().toISOString(), r.id);

// A task-driven delegation (docs/v2/coding-loop.md): T1 done in its own commit, T2 a question for the owner.
const t = createRun(app, { kind: "code", spaceId: "shop-web", title: "退款原因必填", input: { task: "退款原因必填", repos: ["shop-web"], taskMode: true } });
const taskFolder = join(app.runsDir, t.id, "work", "shop-web");
git(repo, "worktree", "add", "-q", "-b", `omem/${t.id}`, taskFolder, base);
writeFileSync(join(taskFolder, "reason.ts"), "export const requireReason = true;\n");
git(taskFolder, "add", "-A");
git(taskFolder, "commit", "-q", "-m", "退款原因必填\n\nOmem-Task: T1");
const head = git(taskFolder, "rev-parse", "HEAD").trim();
const taskWt = { space: "shop-web", path: taskFolder, branch: `omem/${t.id}`, base, start: base, targetBranch: "main", commits: true };
setRunOutput(app, t.id, { worktrees: [taskWt], repos: [{ space: "shop-web", diffStat: "", diffBytes: 1, check: null }], verdict: "awaiting-owner", reviewStop: "owner", reviewStage: "done" });
const t1 = addTask(app, t.id, { title: "退款原因必填", doneWhen: "没填原因不能提交", kind: "build", state: "done", origin: { decision: "D1" } }, "coder");
updateTask(app, t.id, t1.seq, { commits: { "shop-web": [head] }, coderRun: t.id }, { by: "coder", kind: "coder", text: "加了必填校验" });
addTask(app, t.id, { title: "原因选项从哪来", kind: "fix", state: "owner", question: "退款原因用固定选项还是让用户自己写？", options: ["固定选项", "自己写"] }, "review-lead");
recordCheckpoint(app, t.id, [taskWt], t.id, [1], "第 1 轮：T1");
setWorkState(app, t.id, { budget: 3, until: 3 });
sql(app.db, "update runs set status = 'done', finished_at = ? where id = ?", new Date().toISOString(), t.id);
// The design that delegation codes from (docs/v2/coding-plan.md): T1 was done for its first decision.
const dsg = createDesign(app, { spaceId: "shop-web", title: "退款原因必填的方案", origin: "external", author: "小王", repos: ["shop-web"], workId: t.id });
submitRevision(app, dsg.id, { decisions: [
  { kind: "add", title: "提交退款时校验原因", fields: { entry: { brief: "退款表单的提交按钮" } }, concerns: [{ level: "risk", text: "旧版客户端不带原因字段，上线顺序没写" }] },
  { kind: "change", title: "原因选项由后端下发" },
] });

// A delegation an outside Agent codes (peer-code.ts) and has not handed in: one commit on its branch and
// a new file nobody committed yet. No tasks, no saved patch.
const p = createRun(app, { kind: "code", spaceId: "shop-web", title: "退款金额显示千分位", input: { task: "退款金额显示千分位", repos: ["shop-web"], peerCoder: { caller: "laptop" } } });
const peerFolder = join(app.runsDir, p.id, "work", "shop-web");
git(repo, "worktree", "add", "-q", "-b", `omem/${p.id}`, peerFolder, base);
writeFileSync(join(peerFolder, "refund.ts"), "export function refund(amount: number) {\n  return amount.toLocaleString();\n}\n");
git(peerFolder, "commit", "-qam", "金额显示千分位");
writeFileSync(join(peerFolder, "format.ts"), "export const thousands = true;\n");
setRunOutput(app, p.id, { worktrees: [{ space: "shop-web", path: peerFolder, branch: `omem/${p.id}`, base, start: base, targetBranch: `omem/${p.id}`, commits: true, newBranch: true }], verdict: "awaiting-peer-code" });
sql(app.db, "update runs set status = 'done', finished_at = ? where id = ?", new Date().toISOString(), p.id);

// Paired with itself, for the "through this omem to a paired device" connection.
const port = Number(process.env.OMEM_TEST_PORT ?? 4391);
const token = createApiToken(app, OWNER, "vscode-test");
await addPeer(app, "omem1." + Buffer.from(JSON.stringify({ id: "box", urls: [`http://127.0.0.1:${port}`], token })).toString("base64url"));
app.db.close();

await boot(home, { port, quiet: true, background: false });
console.log(JSON.stringify({ url: `http://127.0.0.1:${port}`, folder, runId: r.id, taskRunId: t.id, peerRunId: p.id, token }));
