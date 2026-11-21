import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import type { App } from "../src/core/app.ts";
import { all, one, run } from "../src/core/db.ts";
import * as gitTools from "../src/core/git.ts";
import * as users from "../src/core/users.ts";
import { createSpace, findSpace } from "../src/core/spaces.ts";
import { createRun, getRun, listRuns, setRunOutput, __testHandlers, type Run } from "../src/agents/runs.ts";
import { answerAsk, getAsk, listAsks } from "../src/agents/asks.ts";
import { callTool, type ToolContext } from "../src/agents/tools.ts";
import * as runner from "../src/agents/runner.ts";
import { getItem, upsertItem } from "../src/items/store.ts";
import { addLocalMaterials, itemMaterials } from "../src/items/materials.ts";
import { materialCandidates } from "../src/items/places.ts";
import { saveFlow } from "../src/flows/definitions.ts";
import { startFlow } from "../src/flows/engine.ts";
import { getStage } from "../src/flows/store.ts";
import { checkGitSignals } from "../src/flows/signals.ts";
import { checkUnclaimedCommits, claimCommits, finishCommitClaim } from "../src/flows/commits.ts";
import { testApp } from "./helpers.ts";

const apps: App[] = [];
function git(path: string, args: string[]) {
  const result = gitTools.git(path, args);
  if (!result.ok) throw new Error(`${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}
async function setup(quiet = 0) {
  const app = testApp(); apps.push(app); app.config.flows.commits.quietMinutes = quiet;
  const path = join(app.home, "repo"); mkdirSync(path);
  git(path, ["init", "-q", "-b", "main"]);
  git(path, ["config", "user.name", "Example"]); git(path, ["config", "user.email", "example@example.com"]);
  git(path, ["config", "core.autocrlf", "false"]);
  let seq = 0;
  const commit = (title = "实现退款校验", author?: string) => {
    writeFileSync(join(path, "refund.txt"), `${++seq}\n`);
    git(path, ["add", "."]); git(path, ["commit", "-qm", title, ...(author ? ["--author", author] : [])]);
    return git(path, ["rev-parse", "HEAD"]);
  };
  const base = commit("初始内容");
  createSpace(app, { id: "demo", name: "示例商城", kind: "repo", rootPath: path });
  const origin = Date.now(), scan = (minutes: number) => checkUnclaimedCommits(app, new Date(origin + minutes * 60000));
  await scan(0);
  const runs = () => listRuns(app, { kind: "commit-claim", includeQuiet: true });
  const cursor = () => one<{ commit_id: string; pending: string | null }>(app.db, "select * from git_commit_cursors where space_id='demo' and branch='main'")!;
  const item = () => upsertItem(app, undefined, { title: "实现退款校验", spaceId: "personal" }, "user");
  const processing = async (minutes = 30) => {
    commit(); await scan(minutes); const r = runs()[0]; expect(r).toBeDefined();
    run(app.db, "update runs set status='running' where id=?", r.id); return getRun(app, r.id);
  };
  const suggest = (r: Run, claims: Parameters<typeof claimCommits>[2]["claims"]) => {
    claimCommits(app, r.id, { claims }); finishCommitClaim(app, r);
    run(app.db, "update runs set status='done' where id=?", r.id);
    return listAsks(app, { runId: r.id })[0];
  };
  return { app, path, base, commit, scan, runs, cursor, item, processing, suggest };
}
afterEach(async () => {
  vi.restoreAllMocks();
  await new Promise((resolve) => setImmediate(resolve)); await new Promise((resolve) => setImmediate(resolve));
  for (const app of apps.splice(0)) { app.events.emit("close"); app.db.close(); rmSync(app.home, { recursive: true, force: true }); }
});

describe("没人认领的提交", () => {
  it("首次只记顶端，三十分钟限频，顶端安静满期才成一批；Git 全部异步带超时", async () => {
    const t = await setup(30); expect(t.cursor().commit_id).toBe(t.base); expect(t.runs()).toHaveLength(0);
    const asyncGit = vi.spyOn(gitTools, "gitAsync"), syncGit = vi.spyOn(gitTools, "git");
    t.commit(); syncGit.mockClear();
    await t.scan(29); expect(asyncGit).not.toHaveBeenCalled();
    await t.scan(30); expect(t.runs()).toHaveLength(0);
    await t.scan(59); expect(t.runs()).toHaveLength(0);
    await t.scan(60); expect(t.runs()).toHaveLength(1);
    expect(asyncGit.mock.calls.every((c) => c[2]?.timeoutMs === 15000)).toBe(true);
    expect(syncGit).not.toHaveBeenCalled();
    expect(String(t.runs()[0].input.task)).toContain("refund.txt");
    expect(String(t.runs()[0].input.task)).not.toContain("初始内容");
  });
  it("二十条立即成批，同分支并发巡检只起一个运行，关闭设置完全不读 Git", async () => {
    const t = await setup(30);
    for (let i = 0; i < 20; i++) t.commit(`退款校验 ${i}`);
    await Promise.all([t.scan(30), t.scan(30)]); expect(t.runs()).toHaveLength(1);
    await t.scan(60); expect(t.runs()).toHaveLength(1);
    t.app.config.flows.commits.enabled = false; const spy = vi.spyOn(gitTools, "gitAsync");
    await t.scan(90); expect(spy).not.toHaveBeenCalled();
  });
  it("作者不符和远端跟踪分支不算；合并带入的本人提交也不算", async () => {
    const t = await setup();
    t.commit("他人的修改", "Other <other@example.com>");
    git(t.path, ["switch", "-qc", "side"]); const side = t.commit("侧线退款");
    git(t.path, ["switch", "main"]); git(t.path, ["merge", "--no-ff", "-qm", "合并", "side"]);
    git(t.path, ["branch", "-D", "side"]); git(t.path, ["update-ref", "refs/remotes/origin/side", side]);
    await t.scan(30); expect(t.runs()).toHaveLength(0);
    expect(all(t.app.db, "select branch from git_commit_cursors")).toEqual([{ branch: "main" }]);
  });
  it("交办工作分支、应用提交和已挂到未结束事项的分支不再判断", async () => {
    const t = await setup();
    const head = t.commit();
    const work = createRun(t.app, { kind: "code", title: "交办", spaceId: "demo" });
    setRunOutput(t.app, work.id, { appliedTo: [{ space: "demo", branch: "main", base: t.base, head }] });
    await t.scan(30); expect(t.runs()).toHaveLength(0); expect(t.cursor().commit_id).toBe(head);
    setRunOutput(t.app, work.id, { worktrees: [{ space: "demo", branch: "main", base: head }] });
    t.commit(); await t.scan(60); expect(t.runs()).toHaveLength(0);
    setRunOutput(t.app, work.id, { worktrees: undefined, worktree: join(t.app.home, "old-worktree"), branch: "main", base: head });
    t.commit(); await t.scan(90); expect(t.runs()).toHaveLength(0);
    setRunOutput(t.app, work.id, { worktree: undefined });
    addLocalMaterials(t.app, t.item().id, [{ kind: "repo", ref: "demo", branch: "main" }], "owner");
    await t.scan(120); expect(t.runs()).toHaveLength(0);
  });
  it("仓库邮箱缺失就跳过，缺少本机目录的空间不看", async () => {
    const t = await setup(); t.commit(); git(t.path, ["config", "user.email", ""]);
    createSpace(t.app, { id: "missing", name: "未落地的仓库", kind: "repo" });
    const spy = vi.spyOn(gitTools, "gitAsync");
    await t.scan(30); expect(t.runs()).toHaveLength(0); expect(spy).toHaveBeenCalledTimes(1);
  });
  it("旧的原地补丁应用核对留存补丁，不把本人后续提交都当成交办", async () => {
    const t = await setup(), head = t.commit("应用交办补丁");
    const patch = git(t.path, ["diff", t.base, head]);
    const work = createRun(t.app, { kind: "code", title: "旧交办", spaceId: "demo" });
    const dir = join(t.app.runsDir, work.id, "patches"); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, "demo.patch"), `${patch}\n`);
    setRunOutput(t.app, work.id, { appliedAt: new Date().toISOString(), appliedTo: [{ space: "demo", branch: "main", base: t.base }],
      worktrees: [{ space: "demo", branch: "main", base: t.base, start: t.base, path: t.path, inPlace: true }], repos: [{ space: "demo", diffBytes: patch.length }] });
    const sync = vi.spyOn(gitTools, "git");
    await t.scan(30); expect(t.runs()).toHaveLength(0); expect(t.cursor().commit_id).toBe(head); expect(sync).not.toHaveBeenCalled();
    t.commit("本人另外修改"); sync.mockClear(); await t.scan(60);
    expect(t.runs()).toHaveLength(1); expect(String(t.runs()[0].input.task)).toContain("本人另外修改"); expect(sync).not.toHaveBeenCalled();
  });
  it("每次最多十个仓库，每个最多最近二十条本地分支，下次轮到剩下仓库", async () => {
    const t = await setup();
    for (let i = 0; i < 25; i++) git(t.path, ["branch", `feature-${String(i).padStart(2, "0")}`]);
    for (let i = 0; i < 10; i++) createSpace(t.app, { id: `repo-${i}`, name: `仓库 ${i}`, kind: "repo", rootPath: t.path });
    await t.scan(1);
    expect(all(t.app.db, "select distinct space_id from git_commit_cursors")).toHaveLength(11);
    expect(all(t.app.db, "select * from git_commit_cursors where space_id='repo-0'")).toHaveLength(20);
    expect(all(t.app.db, "select * from git_commit_cursors where space_id='demo'")).toHaveLength(1);
    // All ten additional repositories were due; demo was still throttled.
    const app2 = testApp(); apps.push(app2);
    for (let i = 0; i < 11; i++) createSpace(app2, { id: `repo-${i}`, name: `仓库 ${i}`, kind: "repo", rootPath: t.path });
    const at = new Date(); await checkUnclaimedCommits(app2, at);
    expect(all(app2.db, "select distinct space_id from git_commit_cursors")).toHaveLength(10);
    await checkUnclaimedCommits(app2, new Date(at.getTime() + 60000));
    expect(all(app2.db, "select distinct space_id from git_commit_cursors")).toHaveLength(11);
  }, 90000);
  it("工具只给本角色本次运行，事项必须本人可写且未结束，最多三项", async () => {
    const t = await setup(), r = await t.processing(), item = t.item();
    const ctx: ToolContext = { app: t.app, role: "commit-claim", runId: r.id, actor: "agent", userId: "owner", tools: new Set(["claim_commits"]), spaces: null, spaceId: "demo" };
    const args = { claims: [{ item: item.id, reason: "实现了退款校验" }] };
    expect((await callTool({ ...ctx, role: "assistant" }, "claim_commits", args)).isError).toBe(true);
    expect((await callTool(ctx, "claim_commits", { claims: Array(4).fill(args.claims[0]) })).isError).toBe(true);
    expect((await callTool(ctx, "claim_commits", { claims: [{ ...args.claims[0], title: "混合类型" }] })).isError).toBe(true);
    run(t.app.db, "update items set status='done' where id=?", item.id);
    expect(() => claimCommits(t.app, r.id, args)).toThrow("没结束");
    run(t.app.db, "update items set status='open',user_id='someone' where id=?", item.id);
    expect(() => claimCommits(t.app, r.id, args)).toThrow("本人可写");
    run(t.app.db, "update items set user_id='owner' where id=?", item.id);
    const noWrite = vi.spyOn(users, "canWrite").mockReturnValue(false);
    expect(() => claimCommits(t.app, r.id, args)).toThrow("本人可写"); noWrite.mockRestore();
    expect((await callTool(ctx, "claim_commits", args)).isError).toBe(false);
    const fake = createRun(t.app, { kind: "commit-claim", title: "另一个批次", input: r.input });
    expect(() => claimCommits(t.app, fake.id, args)).toThrow("本次运行");
    expect(itemMaterials(t.app, item.id)).toHaveLength(0);
  });
  it.each(["pending", "gated", "doing", "done"])("确认挂到事项并记时间线；编码阶段 %s 的补录边界", async (state) => {
    const t = await setup(), item = t.item();
    saveFlow(t.app, YAML.stringify({ id: "demo", name: "示例交付", stages: [
      { id: "clarify", name: "澄清", by: "wait" },
      { id: "code", name: "编码", by: { object: "code-work" }, needs: ["clarify"] },
      { id: "verify", name: "验证", by: "wait", needs: ["code"] },
    ] }), "owner");
    await startFlow(t.app, item.id, "demo", { actor: "owner", userId: "owner" });
    run(t.app.db, "update item_stages set state=? where item_id=? and stage_id='code'", state, item.id);
    const r = await t.processing(), ask = t.suggest(r, [{ item: item.id, reason: "提交实现了退款校验" }]);
    expect(itemMaterials(t.app, item.id)).toHaveLength(0);
    await expect(answerAsk(t.app, ask.id, { choice: 0, by: "someone" })).rejects.toThrow("只有本人");
    expect(getAsk(t.app, ask.id).status).toBe("pending");
    await answerAsk(t.app, ask.id, { choice: 0, by: "owner" });
    expect(itemMaterials(t.app, item.id)[0]).toMatchObject({ kind: "repo", ref: "demo#main", meta: { space: "demo", branch: "main" } });
    const stage = getStage(t.app, item.id, "code");
    if (["pending", "gated"].includes(state)) { expect(stage.control.recorded).toBe(true); expect(getStage(t.app, item.id, "verify").state).toBe("doing"); }
    else expect(stage.state).toBe(state);
    expect(all<{ text: string }>(t.app.db, "select text from item_events where item_id=?", item.id).some((v) => v.text.includes("本人确认：demo 的 main 分支上 1 条提交"))).toBe(true);
    expect(one<{ outcome: string }>(t.app.db, "select outcome from flow_signals where type='git.commits'")!.outcome).toBe("问了本人，挂到了 实现退款校验");
    expect(t.cursor().pending).toBeNull();
  });
  it("确认新建还没做完的待办、挂分支，不自动开流程", async () => {
    const t = await setup(), r = await t.processing();
    const ask = t.suggest(r, [{ title: "退款校验", detail: "增加退款金额校验。\n修改 refund.txt。", reason: "只搭了校验入口", ongoing: true }]);
    expect(ask.options[0].label).toBe("新建一件事（还没做完）：退款校验");
    await answerAsk(t.app, ask.id, { choice: 0, by: "owner" });
    const created = one<{ id: string }>(t.app.db, "select id from items where title='退款校验'")!;
    expect(getItem(t.app, created.id)).toMatchObject({ kind: "todo", status: "open", spaceId: "demo", detail: "增加退款金额校验。\n修改 refund.txt。" });
    expect(itemMaterials(t.app, created.id)[0].ref).toBe("demo#main");
    expect(one(t.app.db, "select * from item_flows where item_id=?", created.id)).toBeUndefined();
  });
  it("没标还要接着做的新建建议，确认后记为已完成", async () => {
    const t = await setup(), r = await t.processing();
    const ask = t.suggest(r, [{ title: "退款校验", detail: "增加退款金额校验。", reason: "完整修复" }]);
    expect(ask.options[0].label).toBe("记一件已完成的事：退款校验");
    await answerAsk(t.app, ask.id, { choice: 0, by: "owner" });
    const created = getItem(t.app, one<{ id: string }>(t.app.db, "select id from items where title='退款校验'")!.id);
    expect(created.status).toBe("done");
    expect(itemMaterials(t.app, created.id)[0].ref).toBe("demo#main");
    expect(one<{ outcome: string }>(t.app.db, "select outcome from flow_signals where type='git.commits'")!.outcome).toBe("问了本人，记了已完成的 退款校验");
  });
  it("不用管前移游标并留下结局，同一提交出现在另一分支也不再问", async () => {
    const t = await setup(), item = t.item();
    git(t.path, ["branch", "other"]); await t.scan(30);
    const r = await t.processing(60), ask = t.suggest(r, [{ item: item.id, reason: "退款校验" }]);
    await answerAsk(t.app, ask.id, { choice: 1, by: "owner" });
    const head = git(t.path, ["rev-parse", "HEAD"]); expect(t.cursor().commit_id).toBe(head);
    git(t.path, ["branch", "-f", "other", head]);
    await t.scan(90); expect(t.runs()).toHaveLength(1);
    expect(all(t.app.db, "select outcome from flow_signals where type='git.commits'")).toEqual([{ outcome: "本人说不用管" }]);
  });
  it("这个仓库以后不用问：前移游标、关掉仓库的提交认领，之后的提交不再起运行", async () => {
    const t = await setup(), item = t.item();
    const r = await t.processing(), ask = t.suggest(r, [{ item: item.id, reason: "退款校验" }]);
    expect(getAsk(t.app, ask.id).options.at(-1)?.label).toBe("这个仓库以后不用问");
    await answerAsk(t.app, ask.id, { choice: 2, by: "owner" });
    expect(findSpace(t.app, "demo")!.settings.commitClaim).toBe(false);
    expect(one<{ outcome: string }>(t.app.db, "select outcome from flow_signals where type='git.commits'")!.outcome).toBe("本人说这个仓库以后不用问");
    t.commit(); await t.scan(120); await t.scan(200);
    expect(t.runs()).toHaveLength(1);
  });
  it("stay_quiet 前移、不出卡；运行失败保留游标，同一批最多两次", async () => {
    const t = await setup(), r = await t.processing();
    const ctx: ToolContext = { app: t.app, role: "commit-claim", runId: r.id, actor: "agent", userId: "owner", tools: null, spaces: null, spaceId: "demo" };
    expect((await callTool(ctx, "stay_quiet", { reason: "只有格式整理" })).isError).toBe(false);
    finishCommitClaim(t.app, r); run(t.app.db, "update runs set status='done' where id=?", r.id);
    expect(listAsks(t.app, { runId: r.id })).toHaveLength(0); expect(t.cursor().commit_id).not.toBe(t.base);
    const next = await t.processing(60), previous = t.cursor().commit_id;
    const spy = vi.spyOn(runner, "runRole").mockRejectedValue(new Error("模型暂不可用"));
    const invoke = (r: Run) => __testHandlers.get("commit-claim")!({ app: t.app, run: r, signal: new AbortController().signal, event: () => {}, output: () => {} });
    await expect(invoke(next)).rejects.toThrow("模型暂不可用");
    expect(spy).toHaveBeenCalledWith(t.app, expect.objectContaining({ role: "commit-claim", runId: next.id, userId: "owner" }));
    run(t.app.db, "update runs set status='failed' where id=?", next.id);
    await t.scan(90); expect(t.runs()).toHaveLength(3);
    run(t.app.db, "update runs set status='failed' where kind='commit-claim' and status='queued'");
    await t.scan(120); expect(t.runs()).toHaveLength(3); expect(t.cursor().commit_id).toBe(previous);
  });
  it("待答期间增加提交合到下一版，只留一张卡；旧运行不能交结果", async () => {
    const t = await setup(), item = t.item(), r = await t.processing();
    const old = t.suggest(r, [{ item: item.id, reason: "退款校验" }]);
    await t.scan(60); expect(t.runs()).toHaveLength(1);
    const next = await t.processing(90); expect(getAsk(t.app, old.id).status).toBe("cancelled");
    const ask = t.suggest(next, [{ item: item.id, reason: "退款校验及边界情况" }]);
    expect(ask.question).toContain("2 条提交");
    expect(listAsks(t.app, { status: "pending" }).filter((a) => a.handler === "commit-claim")).toHaveLength(1);
    expect(() => claimCommits(t.app, r.id, { claims: [{ item: item.id, reason: "过时" }] })).toThrow("本次运行");
    await expect(answerAsk(t.app, old.id, { choice: 0, by: "owner" })).rejects.toThrow("失效");
  });
  it("重写历史只重置基线，不追溯新历史；现有 Git 核对入口也初始化提交游标", async () => {
    const t = await setup(); git(t.path, ["checkout", "--orphan", "rewritten"]); t.commit("新的历史");
    git(t.path, ["branch", "-f", "main", "HEAD"]); git(t.path, ["checkout", "main"]); git(t.path, ["branch", "-D", "rewritten"]);
    await t.scan(30); expect(t.runs()).toHaveLength(0); expect(t.cursor().commit_id).not.toBe(t.base);
    run(t.app.db, "delete from git_commit_cursors"); run(t.app.db, "delete from kv where key like 'flow-commits:%'");
    await checkGitSignals(t.app); expect(t.cursor()).toBeDefined();
  });
  it("Git 读取失败保留原游标，不误当历史重写；下次仍能处理", async () => {
    const t = await setup(); t.commit();
    const original = gitTools.gitAsync;
    const spy = vi.spyOn(gitTools, "gitAsync").mockImplementation((path, args, options) => args.includes("--ancestry-path") ? Promise.resolve({ ok: false, stdout: "", stderr: "temporary failure" }) : original(path, args, options));
    await t.scan(30); expect(t.cursor().commit_id).toBe(t.base); expect(t.runs()).toHaveLength(0);
    spy.mockRestore(); await t.scan(60); expect(t.runs()).toHaveLength(1);
  });
  it("候选复用共同词、链接和时间打分，最多三项；最近清单最多三十个标题", async () => {
    const t = await setup();
    for (let i = 0; i < 35; i++) upsertItem(t.app, undefined, { title: `退款 金额 校验 refund amount check ${i}`, detail: "https://example.com/refund", spaceId: "personal" }, "user");
    const scored = materialCandidates(t.app, "refund amount check https://example.com/refund", "owner", 3, { lastAt: new Date().toISOString() });
    expect(scored).toHaveLength(3); expect(scored[0].reasons).toEqual(expect.arrayContaining(["时间相近", "有 6 处共同的词", "同一个链接或单号（https://example.com/refund）"]));
    const r = await t.processing();
    const task = String(r.input.task); expect(task.split("本人最近没结束的事项（id、标题）：")[1].trim().split("\n\n")).toHaveLength(30);
    expect(runner.loadRole("commit-claim", t.app).tools).toEqual(["read_item", "search", "read_source", "claim_commits", "stay_quiet"]);
  });
});

describe("之后才新建的分支", () => {
  it("从它离开已经看过的位置算起：新分支上马上做的提交也会成批来问；第一次看一个仓库仍然不翻历史", async () => {
    const t = await setup(30);
    expect(t.runs()).toHaveLength(0);
    git(t.path, ["checkout", "-qb", "feat/export"]);
    const first = t.commit("导出加筛选"), second = t.commit("导出加测试");
    await t.scan(31);
    // Seen for the first time, but the repository was already known: it starts at the fork point, and the quiet period begins.
    expect(one<{ commit_id: string }>(t.app.db, "select commit_id from git_commit_cursors where space_id='demo' and branch='feat/export'")!.commit_id).toBe(t.base);
    expect(t.runs()).toHaveLength(0);
    run(t.app.db, "delete from kv where key like 'flow-commits:%'");
    await t.scan(62);
    const r = t.runs()[0];
    expect(r).toBeDefined();
    expect(String(r.input.task)).toContain("导出加筛选"); expect(String(r.input.task)).toContain("导出加测试"); expect(String(r.input.task)).not.toContain("初始内容");
    expect(r.input.batch).toMatchObject({ from: t.base, to: second });
    expect(first).not.toBe(second);
  });
});
