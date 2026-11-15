import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { latestCheck } from "../src/agents/code.ts";
import { codeChainFor, queueNextCodeRound } from "../src/agents/code-chain.ts";
import { commandGate } from "../src/agents/command-gate.ts";
import { CHANGE_APPROACH, improveGoal, improveRounds, improveUntil, measure, metricValue, roundImprove, startImprove } from "../src/agents/improve.ts";
import { createRun, getRun, setRunOutput } from "../src/agents/runs.ts";
import { createThread } from "../src/agents/threads.ts";
import { callTool, type ToolContext } from "../src/agents/tools.ts";
import { all, one, run } from "../src/core/db.ts";
import { git } from "../src/core/git.ts";
import { createSpace } from "../src/core/spaces.ts";
import type { App } from "../src/core/app.ts";
import { commandRuleSchema } from "../src/core/config.ts";
import { testApp } from "./helpers.ts";

const garbage: { app: App; dir: string }[] = [];
afterEach(() => {
  for (const { app, dir } of garbage.splice(0)) {
    app.db.close();
    for (const path of [dir, app.home]) {
      const target = resolve(path);
      if (!target.startsWith(resolve(tmpdir()) + "\\") && !target.startsWith(resolve(tmpdir()) + "/")) throw new Error("仅清理临时目录");
      rmSync(target, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
    }
  }
});

function fixture() {
  const app = testApp(), dir = mkdtempSync(join(tmpdir(), "omem-improve-"));
  garbage.push({ app, dir });
  const root = join(dir, "repo"), work = join(dir, "work");
  mkdirSync(root);
  const g = (where: string, ...args: string[]) => {
    const r = git(where, args);
    if (!r.ok) throw new Error(r.stderr);
    return r.stdout.trim();
  };
  g(root, "init", "-q", "-b", "main");
  g(root, "config", "user.name", "test");
  g(root, "config", "user.email", "test@example.com");
  writeFileSync(join(root, "value.txt"), "100");
  writeFileSync(join(root, "measure.cjs"), `const fs = require('node:fs'); console.log('size ' + fs.readFileSync('value.txt', 'utf8') + ' units');`);
  writeFileSync(join(root, "check.cjs"), `process.exit(Number(require('node:fs').readFileSync('value.txt', 'utf8')) === 13 ? 1 : 0);`);
  writeFileSync(join(root, "parse.cjs"), `console.log('first line 999'); console.log(require('node:fs').readFileSync('output.txt', 'utf8')); process.exit(Number(process.env.MEASURE_EXIT || 0));`);
  writeFileSync(join(root, "output.txt"), "result 12.4 ms");
  writeFileSync(join(root, "slow.cjs"), `console.log(42); setTimeout(() => {}, 150);`);
  mkdirSync(join(root, "test"));
  writeFileSync(join(root, "test", "assert.txt"), "do not delete");
  g(root, "add", "-A"); g(root, "commit", "-qm", "基线");
  const base = g(root, "rev-parse", "HEAD");
  g(root, "worktree", "add", "-q", "-b", "improve/demo", work);
  createSpace(app, { id: "repo", name: "示例仓库", kind: "repo", rootPath: root });
  const thread = createThread(app, { spaceId: "repo", channel: "web", userId: "owner" });
  const ask = createRun(app, { kind: "ask", spaceId: "repo", title: "优化", input: { conversationId: thread.id }, userId: "owner" });
  const r = createRun(app, { kind: "code", spaceId: "repo", title: "优化", parentId: ask.id, input: { task: "优化", repos: ["repo"], checkCommand: "node check.cjs" }, userId: "owner" });
  run(app.db, "update runs set status = 'done' where id in (?,?)", ask.id, r.id);
  setRunOutput(app, r.id, { worktrees: [{ space: "repo", path: work, branch: "improve/demo", base, start: base, commits: true }] });
  const ctx: ToolContext = { app, runId: ask.id, spaceId: "repo", spaces: null, tools: null, actor: "agent", userId: "owner" };
  const start = (extra: Partial<Parameters<typeof startImprove>[1]> = {}) => startImprove(ctx, { run_id: r.id, name: "降低大小", metric_command: "node measure.cjs", direction: "down", ...extra });
  const edit = (value: number, file = "value.txt") => {
    writeFileSync(join(work, file), String(value));
    g(work, "add", "-A"); g(work, "commit", "-qm", `尝试 ${value}`);
    return g(work, "rev-parse", "HEAD");
  };
  return { app, ctx, r, root, work, g, start, edit };
}

describe("宿主控制的改进循环", () => {
  it.each([
    ["42", 42], ["value -12.4 ms", -12.4], ["start 8 then .25 end", 0.25], ["100\nresult 3.5 ms\n \n", 3.5],
    ["123\nno number", null], ["1,234", null], ["", null],
  ])("只解析最后一个非空行的最后一个数字：%s", (output, value) => expect(metricValue(output)).toBe(value));

  it("在委托工作区执行脚本，记录失败输出和超时", async () => {
    const f = fixture();
    const goal = { run_id: f.r.id, space_id: "repo", metric_command: "node parse.cjs" };
    for (const [output, value] of [["result 42 ms", 42], ["result -4.25 ms", -4.25], ["no number", null]] as const) {
      writeFileSync(join(f.work, "output.txt"), output);
      expect((await measure(f.app, goal)).value).toBe(value);
    }
    const failed = await measure(f.app, { ...goal, metric_command: 'node -e "console.log(99); process.exit(2)"' });
    expect(failed.value).toBeNull(); expect(failed.why).toContain("99"); expect(failed.why).toContain("退出码 2");
    const timed = await measure(f.app, { ...goal, metric_command: "node slow.cjs" }, 10);
    expect(timed.value).toBeNull(); expect(timed.why).toContain("超时");
  });

  it("拒绝失败基线，不创建目标", async () => {
    const f = fixture();
    await expect(f.start({ metric_command: 'node -e "console.log(78); process.exit(1)"' })).rejects.toThrow("78");
    expect(all(f.app.db, "select * from improve_goals")).toHaveLength(0);
  });

  it("留下改善，追加检查证据；两次提交没变好时新增回退提交，保留历史和最佳文件树", async () => {
    const f = fixture(), goal = await f.start();
    const kept = f.edit(80);
    const first = await roundImprove(f.ctx, goal.id, "减少重复数据", "变小两成");
    expect(first.round).toMatchObject({ verdict: "kept", before: 100, after: 80 });
    expect(first.goal).toMatchObject({ best: 80, head: kept, rounds: 1, stale: 0 });
    expect(latestCheck(f.app, f.r.id, "repo")).toMatchObject({ command: "node check.cjs", commit: kept, code: 0 });
    expect(getRun(f.app, f.r.id).output.improveChecks).toHaveLength(1);
    const bad1 = f.edit(85), bad2 = f.edit(90);
    const second = await roundImprove(f.ctx, goal.id, "调整缓存");
    expect(second.round).toMatchObject({ verdict: "reverted", before: 80, after: 90, to_commit: bad2 });
    expect(second.round!.revert_commit).toBe(second.goal.head);
    expect(f.g(f.work, "log", "-1", "--format=%s")).toContain("回退第 2 轮：没有变好（80 → 90");
    expect(f.g(f.work, "rev-parse", `${kept}^{tree}`)).toBe(f.g(f.work, "rev-parse", "HEAD^{tree}"));
    for (const sha of [bad1, bad2]) expect(f.g(f.work, "merge-base", "--is-ancestor", sha, "HEAD")).toBe("");
    expect(f.g(f.root, "show", "main:value.txt")).toBe("100");
    expect(improveRounds(f.app, goal.id)).toHaveLength(2);
  });

  it("保护路径逐提交检查，改了又还原仍回退", async () => {
    const f = fixture(), goal = await f.start({ protect: ["test/**"] });
    f.edit(20, "test/assert.txt");
    writeFileSync(join(f.work, "test/assert.txt"), "do not delete");
    f.g(f.work, "commit", "-qam", "还原断言");
    f.edit(50);
    const r = await roundImprove(f.ctx, goal.id, "替换测试");
    expect(r.round).toMatchObject({ verdict: "protected", after: null });
    expect(r.round!.why).toContain("test/assert.txt");
    expect(readFileSync(join(f.work, "value.txt"), "utf8")).toBe("100");
  });

  it("检查失败、度量无数字或非零退出均回退", async () => {
    const f = fixture(), goal = await f.start();
    f.edit(13);
    expect((await roundImprove(f.ctx, goal.id, "失败检查")).round?.verdict).toBe("broken");
    f.edit(40);
    writeFileSync(join(f.work, "measure.cjs"), "console.log('无数字')");
    f.g(f.work, "commit", "-qam", "坏度量");
    const r = await roundImprove(f.ctx, goal.id, "尝试度量");
    expect(r.round).toMatchObject({ verdict: "broken", after: null });
    expect(r.round!.why).toContain("无数字");
    expect(readFileSync(join(f.work, "value.txt"), "utf8")).toBe("100");
    f.edit(40);
    writeFileSync(join(f.work, "measure.cjs"), "console.log(20); process.exit(1)");
    f.g(f.work, "commit", "-qam", "失败度量");
    expect((await roundImprove(f.ctx, goal.id, "命令失败")).round?.verdict).toBe("broken");
  });

  it("空轮计入预算、停滞；两轮提示、四轮停止并由宿主发报告", async () => {
    const f = fixture(), goal = await f.start();
    expect((await roundImprove(f.ctx, goal.id, "没有提交")).round?.verdict).toBe("nothing");
    expect((await roundImprove(f.ctx, goal.id, "仍没有提交")).next).toBe(CHANGE_APPROACH);
    await roundImprove(f.ctx, goal.id, "第三轮");
    const last = await roundImprove(f.ctx, goal.id, "第四轮");
    expect(last).toMatchObject({ stop: "连着四轮没有变好", goal: { state: "stopped", rounds: 4, stale: 4 } });
    const notification = one<{ body: string; context: string; link: string }>(f.app.db, "select body,context,link from notifications order by at desc limit 1")!;
    expect(notification.body).toContain("100 → 100"); expect(notification.body).toContain("第四轮");
    expect(notification.body).toContain("没有合并或推送"); expect(JSON.parse(notification.context).urgency).toBe("later");
    expect(notification.link).toBe(`#/runs/${f.r.id}`);
    await expect(roundImprove(f.ctx, goal.id, "再做")).rejects.toThrow("目标已结束");
  });

  it.each(["down", "up"] as const)("%s 方向要求最小相对增益，零基准只要求严格改善", async (direction) => {
    const f = fixture(), goal = await f.start({ direction, min_gain: 0.1 });
    f.edit(direction === "down" ? 95 : 105);
    expect((await roundImprove(f.ctx, goal.id, "小改善")).round?.verdict).toBe("reverted");
    f.edit(direction === "down" ? 90 : 110);
    expect((await roundImprove(f.ctx, goal.id, "达阈值")).round?.verdict).toBe("kept");
    run(f.app.db, "update improve_goals set state = 'stopped' where id = ?", goal.id);
    f.edit(0);
    const zero = await f.start({ direction, min_gain: 0.9 });
    f.edit(direction === "down" ? -0.01 : 0.01);
    expect((await roundImprove(f.ctx, zero.id, "从零改善")).round?.verdict).toBe("kept");
  });

  it("目标、轮数和时限停止，报告包含留下和回退的轮次", async () => {
    const f = fixture(), goal = await f.start({ target: 80 });
    f.edit(101); await roundImprove(f.ctx, goal.id, "无效办法");
    f.edit(70);
    expect((await roundImprove(f.ctx, goal.id, "减少复制")).goal).toMatchObject({ state: "done", stop_reason: "达到目标" });
    const report = one<{ body: string }>(f.app.db, "select body from notifications order by at desc limit 1")!.body;
    expect(report).toContain("100 → 70"); expect(report).toContain("减少复制"); expect(report).toContain("无效办法");
    const budget = await f.start({ max_rounds: 1 });
    expect((await roundImprove(f.ctx, budget.id, "没提交")).stop).toBe("预算用完");
    const time = await f.start();
    run(f.app.db, "update improve_goals set until = ? where id = ?", new Date(Date.now() - 1000).toISOString(), time.id);
    expect((await roundImprove(f.ctx, time.id, "到点")).stop).toBe("到点了");
  });

  it("上升方向达标、基线已达标立即结束；时钟按配置时区取今天或明天", async () => {
    const f = fixture(), goal = await f.start({ direction: "up", target: 110 });
    f.edit(120);
    expect((await roundImprove(f.ctx, goal.id, "增加吞吐")).stop).toBe("达到目标");
    expect((await f.start({ direction: "up", target: 110 })).state).toBe("done");
    expect(improveUntil("23:00", "Asia/Tokyo", Date.parse("2026-11-15T12:00:00Z"))).toBe("2026-11-15T14:00:00.000Z");
    expect(improveUntil("01:00", "Asia/Tokyo", Date.parse("2026-11-15T12:00:00Z"))).toBe("2026-11-15T16:00:00.000Z");
    expect(() => improveUntil("25:00", "UTC")).toThrow("HH:mm");
  });

  it("拒绝运行中、已结束、重复目标、别人的委托和越界空间；状态用中文返回", async () => {
    const f = fixture();
    run(f.app.db, "update runs set status = 'running' where id = ?", f.r.id);
    await expect(f.start()).rejects.toThrow("仍在运行");
    run(f.app.db, "update runs set status = 'done' where id = ?", f.r.id);
    const goal = await f.start();
    await expect(f.start()).rejects.toThrow("已有正在进行");
    run(f.app.db, "update runs set status = 'running' where id = ?", f.r.id);
    await expect(roundImprove(f.ctx, goal.id, "忙碌")).rejects.toThrow("仍在运行");
    run(f.app.db, "update runs set status = 'done' where id = ?", f.r.id);
    await expect(roundImprove({ ...f.ctx, userId: "another" }, goal.id, "越权")).rejects.toThrow("本人发起");
    await expect(startImprove({ ...f.ctx, spaces: ["personal"] }, { run_id: f.r.id, name: "越界", metric_command: "node measure.cjs", direction: "down" })).rejects.toThrow("空间");
    const status = await callTool(f.ctx, "improve_status", { run_id: f.r.id });
    expect(status.text).toContain("基线 100 → 最佳 100");
    expect((await callTool({ ...f.ctx, userId: "another" }, "improve_status", { goal: goal.id })).isError).toBe(true);
    expect((await callTool(f.ctx, "improve_start", { run_id: f.r.id, name: "错预算", metric_command: "node measure.cjs", direction: "down", max_rounds: 21 })).isError).toBe(true);
    run(f.app.db, "update improve_goals set state = 'done', stop_reason = '达到目标' where id = ?", goal.id);
    await expect(roundImprove(f.ctx, goal.id, "多做")).rejects.toThrow("目标已结束");
    expect(improveGoal(f.app, goal.id).best).toBe(100);
    expect(existsSync(join(f.app.home, "bin", "guarded"))).toBe(false);
  });

  it("多仓库必须选择度量仓库，冻结命令，未提交文件拒绝裁定", async () => {
    const f = fixture(), original = getRun(f.app, f.r.id).output.worktrees as object[];
    setRunOutput(f.app, f.r.id, { worktrees: [...original, { ...original[0], space: "repo2" }] });
    createSpace(f.app, { id: "repo2", name: "第二仓库", kind: "repo", rootPath: f.root });
    await expect(f.start()).rejects.toThrow("repo_space");
    const goal = await f.start({ repo_space: "repo" });
    expect(goal.metric_command).toBe("node measure.cjs");
    writeFileSync(join(f.work, "value.txt"), "1");
    await expect(roundImprove(f.ctx, goal.id, "未交完")).rejects.toThrow("未提交");
    expect(improveGoal(f.app, goal.id).rounds).toBe(0);
  });

  it("与宿主检查共用命令规则 PATH，受保护的命令无法绕过", async () => {
    const f = fixture();
    f.app.config.security.commandRules = [commandRuleSchema.parse({ command: "node", action: "deny" })];
    const server = createServer(async (req, res) => {
      let body = "";
      for await (const part of req) body += part;
      const result = await commandGate(f.app, f.ctx, JSON.parse(body));
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(result));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    f.app.baseUrl = `http://127.0.0.1:${address.port}`;
    try {
      const result = await measure(f.app, { run_id: f.r.id, space_id: "repo", metric_command: "node measure.cjs" });
      expect(result.result.code).toBe(126);
      expect(result.value).toBeNull();
      expect(result.why).toContain("命令规则");
    } finally { await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve())); }
  });

  it("游离 worktree 的回退提交放回未检出的工作分支，其他目录未改变", async () => {
    const f = fixture(), goal = await f.start();
    f.edit(110);
    f.g(f.work, "checkout", "--detach");
    const result = await roundImprove(f.ctx, goal.id, "无效优化");
    expect(f.g(f.work, "rev-parse", "improve/demo")).toBe(result.goal.head);
    expect(f.g(f.root, "rev-parse", "HEAD")).toBe(f.g(f.root, "rev-parse", "main"));
    expect(f.g(f.root, "status", "--porcelain")).toBe("");
  });

  it("分支在别处检出时保留 pending 回退提交，不把回退应用到别处", async () => {
    const f = fixture(), goal = await f.start();
    const bad = f.edit(110);
    f.g(f.work, "checkout", "--detach");
    f.g(f.root, "checkout", "improve/demo");
    const result = await roundImprove(f.ctx, goal.id, "试错后回退");
    expect(result.round!.revert_commit).toBe(result.goal.head);
    expect(f.g(f.root, "rev-parse", "HEAD")).toBe(bad);
    expect(readFileSync(join(f.root, "value.txt"), "utf8")).toBe("110");
    expect(readFileSync(join(f.work, "value.txt"), "utf8")).toBe("100");
    expect(getRun(f.app, f.r.id).output.worktrees).toMatchObject([{ pending: result.goal.head }]);
  });

  it("合并提交只沿第一父链回退一次，最后文件树仍等于最佳版本", async () => {
    const f = fixture(), goal = await f.start();
    f.g(f.work, "checkout", "-b", "side/demo");
    f.edit(130);
    f.g(f.work, "checkout", "improve/demo");
    f.g(f.work, "merge", "--no-ff", "-m", "合入尝试", "side/demo");
    const result = await roundImprove(f.ctx, goal.id, "合入另一做法");
    expect(result.round!.verdict).toBe("reverted");
    expect(result.goal.state).toBe("running");
    expect(f.g(f.work, "rev-parse", `${goal.head}^{tree}`)).toBe(f.g(f.work, "rev-parse", "HEAD^{tree}"));
  });

  it("度量租约阻止重复裁定和同时续轮，过期租约可恢复", async () => {
    const f = fixture(), goal = await f.start();
    const key = `improve-lock:${f.r.id}`;
    run(f.app.db, "insert into kv(key,value) values(?,?)", key, String(Date.now()));
    await expect(roundImprove(f.ctx, goal.id, "重复裁定")).rejects.toThrow("宿主正在度量或回退");
    const chain = codeChainFor(f.app, getRun(f.app, f.r.id))!;
    expect(() => queueNextCodeRound(f.app, chain, "继续尝试", { manual: true })).toThrow("结束后再续轮");
    run(f.app.db, "update kv set value = ? where key = ?", String(Date.now() - 46 * 60000), key);
    expect((await roundImprove(f.ctx, goal.id, "恢复")).round?.verdict).toBe("nothing");
    expect(one(f.app.db, "select * from kv where key = ?", key)).toBeUndefined();
  });
});
