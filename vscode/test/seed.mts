/**
 * An omem for the extension test: a repository space, a finished delegation whose worktree has a
 * change and whose review has findings, and the fake ACP agent (answers echo the question).
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

// Paired with itself, for the "through this omem to a paired device" connection.
const port = Number(process.env.OMEM_TEST_PORT ?? 4391);
const token = createApiToken(app, OWNER, "vscode-test");
await addPeer(app, "omem1." + Buffer.from(JSON.stringify({ id: "box", urls: [`http://127.0.0.1:${port}`], token })).toString("base64url"));
app.db.close();

await boot(home, { port, quiet: true, background: false });
console.log(JSON.stringify({ url: `http://127.0.0.1:${port}`, folder, runId: r.id, token }));
