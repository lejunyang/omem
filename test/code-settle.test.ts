import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { settleCodeWorks } from "../src/agents/code-branch.ts";
import { addTask, listTasks } from "../src/agents/code-tasks.ts";
import { listCodeWorks } from "../src/agents/code-works.ts";
import { createRun, getRun, setRunOutput } from "../src/agents/runs.ts";
import { run } from "../src/core/db.ts";
import { git } from "../src/core/git.ts";
import { createSpace } from "../src/core/spaces.ts";
import { testApp } from "./helpers.ts";

function sh(cwd: string, ...args: string[]) {
  const r = git(cwd, args);
  if (!r.ok) throw new Error(r.stderr);
  return r.stdout.trim();
}
const commit = (cwd: string, file: string, text: string) => {
  writeFileSync(join(cwd, file), text);
  sh(cwd, "add", file);
  sh(cwd, "commit", "-qm", file);
};
const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

/** A repository with origin, the branch `feat/refund` made locally with one commit the work made. */
function setup() {
  const app = testApp();
  const root = join(app.home, "repo");
  const remote = join(app.home, "remote.git");
  mkdirSync(root);
  mkdirSync(remote);
  sh(remote, "init", "--bare", "-q");
  sh(root, "init", "-q", "-b", "main");
  sh(root, "config", "user.name", "Example");
  sh(root, "config", "user.email", "example@example.com");
  commit(root, "a.txt", "a\n");
  sh(root, "remote", "add", "origin", remote);
  sh(root, "push", "-q", "origin", "main");
  sh(root, "checkout", "-q", "-b", "feat/refund");
  commit(root, "b.txt", "b\n");
  createSpace(app, { id: "shop", name: "示例商城", kind: "repo", rootPath: root });
  return { app, root };
}

function work(app: ReturnType<typeof testApp>, title: string, at: string) {
  const r = createRun(app, { kind: "code", spaceId: "shop", title, input: { task: title, taskMode: true, repos: ["shop"] } });
  setRunOutput(app, r.id, { worktrees: [{ space: "shop", path: join(app.home, `gone-${r.id}`), branch: "feat/refund", targetBranch: "feat/refund", base: "abc", commits: true }] });
  run(app.db, "update runs set status = 'done', created_at = ?, finished_at = ? where id = ?", at, at, r.id);
  return r;
}

describe("settling coding work finished outside its page", () => {
  it("counts a branch pushed by hand as confirmed, but not before it is on origin or while it was just touched", async () => {
    const { app, root } = setup();
    try {
      const w = work(app, "退款只按已发货的行计算", hoursAgo(5));
      setRunOutput(app, w.id, { work: { paused: "budget" } });
      addTask(app, w.id, { title: "重复提交只退一次", kind: "fix", state: "todo" }, "review-lead");
      expect(await settleCodeWorks(app)).toEqual({ pushed: [], superseded: [] });

      sh(root, "push", "-q", "origin", "feat/refund");
      const fresh = work(app, "取消后恢复入口", hoursAgo(0));
      setRunOutput(app, fresh.id, { worktrees: [] });
      const res = await settleCodeWorks(app);
      expect(res.pushed).toEqual([w.id]);
      expect(getRun(app, w.id).output).toMatchObject({ settled: "pushed-outside", pushed: [{ space: "shop", branch: "feat/refund", head: sh(root, "rev-parse", "feat/refund") }] });
      expect(listCodeWorks(app).find((x) => x.rootId === w.id)).toMatchObject({ stage: { text: "已推送", group: "ended" } });
      // What it left stays open: the next delegation on the branch carries it on.
      expect(listTasks(app, w.id)[0].state).toBe("todo");
    } finally { app.db.close(); }
  });

  it("leaves work pushed by omem's own “推送” open", async () => {
    const { app, root } = setup();
    try {
      sh(root, "push", "-q", "origin", "feat/refund");
      const w = work(app, "退款只按已发货的行计算", hoursAgo(5));
      setRunOutput(app, w.id, { work: { delivered: [{ at: hoursAgo(5), branches: [{ space: "shop", branch: "feat/refund", head: sh(root, "rev-parse", "feat/refund") }] }] } });
      expect((await settleCodeWorks(app)).pushed).toEqual([]);
    } finally { app.db.close(); }
  });

  it("ends work a later delegation on the same branch carried on, its open questions pointing there", async () => {
    const { app, root } = setup();
    try {
      commit(root, "c.txt", "c\n"); // not pushed: only the later delegation explains it
      const old = work(app, "主页模板验收", hoursAgo(72));
      run(app.db, "update runs set status = 'cancelled' where id = ?", old.id);
      setRunOutput(app, old.id, { stoppedByOwner: "本人在网页上停下" });
      addTask(app, old.id, { title: "把验收证据挂回事项", kind: "build", state: "owner", question: "要开 write_file", options: ["按原来的要求再做一次"] }, "coder");
      expect(listCodeWorks(app).find((x) => x.rootId === old.id)!.stage).toMatchObject({ text: "你停下的", group: "idle" });
      const later = work(app, "主页测试改写成用例文件", hoursAgo(30));
      const res = await settleCodeWorks(app);
      expect(res.superseded).toEqual([old.id]);
      expect(listTasks(app, old.id)[0]).toMatchObject({ state: "wontdo" });
      expect(listCodeWorks(app).find((x) => x.rootId === old.id)).toMatchObject({ stage: { text: "由新交办接着做", group: "ended" } });
      expect(listCodeWorks(app).find((x) => x.rootId === later.id)!.stage.group).not.toBe("ended");
    } finally { app.db.close(); }
  });
});
