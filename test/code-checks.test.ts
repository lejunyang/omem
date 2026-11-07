import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import "../src/agents/jobs.ts";
import { latestCheck, shell } from "../src/agents/code.ts";
import { verifyChecks } from "../src/agents/code-overlap.ts";
import type { CodeTask } from "../src/agents/code-tasks.ts";
import { reviewContext } from "../src/agents/review-chain.ts";
import { commonGuide } from "../src/agents/runner.ts";
import { createRun, getRun, setRunOutput } from "../src/agents/runs.ts";
import { createSpace } from "../src/core/spaces.ts";
import { OWNER } from "../src/core/users.ts";
import { testApp } from "./helpers.ts";

/** A repository with a base commit and two more, as a delegation's worktree. */
function repo() {
  const dir = mkdtempSync(join(tmpdir(), "omem-checks-"));
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: dir, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  writeFileSync(join(dir, "refund.ts"), "export const refund = 0;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  const base = git("rev-parse", "HEAD");
  writeFileSync(join(dir, "refund.ts"), "export const refund = 1;\n");
  git("commit", "-qam", "T1\n\nOmem-Task: T1");
  const t1 = git("rev-parse", "HEAD");
  writeFileSync(join(dir, "refund.ts"), "export const refund = 2;\n");
  git("commit", "-qam", "T2\n\nOmem-Task: T2");
  const t2 = git("rev-parse", "HEAD");
  return { dir, base, t1, t2, wt: { space: "shop-api", path: dir, branch: "main", base, start: base, commits: true } };
}

const task = (seq: number, sha: string) => ({ seq, commits: { "shop-api": [sha] } }) as unknown as CodeTask;

describe("the host's checks as the reviewers' evidence", () => {
  it("gives the check command where the change starts", async () => {
    const r = await shell(`node -e "process.stdout.write(process.env.OMEM_BASE)"`, tmpdir(), new AbortController().signal, undefined, { OMEM_BASE: "abc123" });
    expect(r).toMatchObject({ code: 0, output: "abc123" });
  });

  it("tells a verification whether the host's last check ran on the tasks' commits", () => {
    const app = testApp();
    const { dir, t1, t2, wt } = repo();
    try {
      createSpace(app, { id: "shop-api", name: "订单服务", kind: "repo", rootPath: dir });
      const r = createRun(app, { kind: "code", spaceId: "shop-api", title: "退款", input: { task: "退款", repos: ["shop-api"], taskMode: true }, userId: OWNER });
      setRunOutput(app, r.id, { worktrees: [wt] });
      // No check command: only the coder's word.
      expect(verifyChecks(app, r.id, getRun(app, r.id), [wt], [task(1, t1)])).toContain("仓库没有设检查命令");
      // A command, but no check since the task's commit.
      const withCommand = createRun(app, { kind: "code", spaceId: "shop-api", title: "退款", input: { task: "退款", repos: ["shop-api"], checkCommand: "npm test", continueFrom: r.id }, userId: OWNER });
      setRunOutput(app, withCommand.id, { repos: [{ space: "shop-api", diffStat: "", diffBytes: 0, check: { command: "npm test", code: 0, output: "3 passed", ms: 1000, commit: t1 } }] });
      expect(latestCheck(app, r.id, "shop-api")?.commit).toBe(t1);
      const later = verifyChecks(app, r.id, getRun(app, withCommand.id), [wt], [task(2, t2)]);
      expect(later).toContain("这些项提交以后宿主还没跑过检查命令（npm test）");
      expect(later).toContain(`编码工作区（依赖和构建产物在这里）：${dir}`);
      // The check ran on a commit that holds the task's: its result goes along.
      const covered = verifyChecks(app, r.id, getRun(app, withCommand.id), [wt], [task(1, t1)]);
      expect(covered).toContain(`跑在提交 ${t1.slice(0, 8)}，包含这些项的提交：退出码 0`);
      expect(covered).toContain("3 passed");
    } finally {
      app.db.close();
    }
  });

  it("shows the reviewers which commit the check ran on, and that later commits went unchecked", async () => {
    const app = testApp();
    const { dir, base, t1, t2, wt } = repo();
    try {
      createSpace(app, { id: "shop-api", name: "订单服务", kind: "repo", rootPath: dir });
      const r = createRun(app, { kind: "code", spaceId: "shop-api", title: "退款", input: { task: "退款只按未发货的行计算", repos: ["shop-api"] }, userId: OWNER });
      const check = { command: "npm test", code: 0, output: "Tests: 3 passed", ms: 42_000, base };
      setRunOutput(app, r.id, { worktrees: [wt], coderSummary: "改了退款", repos: [{ space: "shop-api", diffStat: "", diffBytes: 0, check: { ...check, commit: t2 } }] });
      const same = (await reviewContext(app, r.id)).brief;
      expect(same).toContain(`跑在提交 ${t2.slice(0, 8)}，就是这次看的代码`);
      expect(same).toContain(`改动从 ${base.slice(0, 8)} 起（命令里的 OMEM_BASE）`);
      expect(same).toContain("用时 42 秒");
      expect(same).toContain("Tests: 3 passed");
      setRunOutput(app, r.id, { repos: [{ space: "shop-api", diffStat: "", diffBytes: 0, check: { ...check, commit: t1 } }] });
      expect((await reviewContext(app, r.id)).brief).toContain(`跑在提交 ${t1.slice(0, 8)}；这次看的是 ${t2.slice(0, 8)}，两者之间的改动没有经过检查`);
      setRunOutput(app, r.id, { repos: [{ space: "shop-api", diffStat: "", diffBytes: 0, check: null }] });
      expect((await reviewContext(app, r.id)).brief).toContain("仓库没有设检查命令：宿主没有替这次改动跑检查");
    } finally {
      app.db.close();
    }
  });

  it("tells reviewers, not the coder, how to judge the check instead of running the suite again", () => {
    expect(commonGuide(new Set(["submit_review"]))).toContain("## 评审时的测试和检查结果");
    expect(commonGuide(new Set(["verify_tasks"]))).toContain("不要再跑整套测试");
    expect(commonGuide(new Set(["finish_task", "plan_tasks"]))).not.toContain("评审时的测试和检查结果");
  });
});
