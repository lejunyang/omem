import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import type { App } from "../src/core/app.ts";
import { all, one, run } from "../src/core/db.ts";
import * as gitTools from "../src/core/git.ts";
import { createSpace } from "../src/core/spaces.ts";
import { createRun, getRun, setRunOutput } from "../src/agents/runs.ts";
import { applyCodeRun } from "../src/agents/code.ts";
import { confirmBranchRun } from "../src/agents/code-branch.ts";
import { actCodeGit, readCodeGit } from "../src/agents/code-git.ts";
import { setWorkState } from "../src/agents/code-tasks.ts";
import { answerAsk, listAsks } from "../src/agents/asks.ts";
import { askConfirm } from "../src/agents/review-chain.ts";
import { askCard } from "../src/channels/lark-asks.ts";
import { addLocalMaterials } from "../src/items/materials.ts";
import { upsertItem } from "../src/items/store.ts";
import { describeStage, parseFlow, saveFlow } from "../src/flows/definitions.ts";
import { advance, flowReminders, flowView, ownerAction, reopenStage, reportStage, startFlow, stopFlow } from "../src/flows/engine.ts";
import { checkGitSignals, type GitSignal } from "../src/flows/signals.ts";
import { getStage, stageLog } from "../src/flows/store.ts";
import { testApp } from "./helpers.ts";

const apps: App[] = [];
const owner = { actor: "owner", userId: "owner" };
function git(path: string, args: string[]) {
  const r = gitTools.git(path, args);
  if (!r.ok) throw new Error(`${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}
const signals = (app: App) => all<{ type: string; outcome: string; keys: string }>(app.db, "select * from flow_signals order by id");
async function setup(options: { count?: number; type?: GitSignal; by?: "owner" | "wait"; applied?: boolean; pushedBefore?: boolean; confirmation?: boolean; reviewedHead?: boolean } = {}) {
  const app = testApp(); apps.push(app);
  app.config.flows.autoAdvance = options.confirmation ? 1 : 20;
  const item = upsertItem(app, undefined, { title: "示例商城退款", spaceId: "personal" }, "user");
  const repos = Array.from({ length: options.count ?? 1 }, (_, i) => {
    const space = `shop-${i}`, path = join(app.home, space), remote = join(app.home, `${space}.git`);
    mkdirSync(path); mkdirSync(remote);
    git(remote, ["init", "--bare", "-q", "-b", "main"]);
    git(path, ["init", "-q", "-b", "main"]);
    git(path, ["config", "user.name", "Example"]); git(path, ["config", "user.email", "example@example.com"]);
    git(path, ["config", "core.autocrlf", "false"]);
    writeFileSync(join(path, "app.txt"), "base\n");
    git(path, ["add", "."]); git(path, ["commit", "-qm", "initial"]);
    const base = git(path, ["rev-parse", "HEAD"]);
    git(path, ["remote", "add", "origin", remote]);
    // Test fixtures alone push to a disposable local bare repository.
    git(path, ["push", "-qu", "origin", "main"]);
    git(path, ["switch", "-qc", "feat/refund"]);
    writeFileSync(join(path, "app.txt"), "base\nrefund\n");
    git(path, ["add", "."]); git(path, ["commit", "-qm", "refund"]);
    const head = git(path, ["rev-parse", "HEAD"]);
    createSpace(app, { id: space, name: "示例仓库", kind: "repo", rootPath: path });
    return { space, path, remote, base, head, branch: "feat/refund" };
  });
  const work = createRun(app, { kind: "code", spaceId: repos[0].space, title: "实现退款", input: { itemId: item.id, repos: repos.map((r) => r.space) }, userId: "owner" });
  addLocalMaterials(app, item.id, [{ kind: "run", ref: work.id }], "owner");
  run(app.db, "update runs set status='done' where id=?", work.id);
  setRunOutput(app, work.id, { verdict: "approved", worktrees: repos.map((r) => ({ ...r, commits: true, newBranch: true, cutFrom: "main", targetBranch: r.branch })),
    ...(options.reviewedHead ? { repos: repos.map(repo => ({ space: repo.space, check: { commit: repo.head } })) } : {}),
    ...(options.applied === false ? {} : { appliedAt: new Date().toISOString(), appliedTo: repos.map(({ space, path, branch, base, head }) => ({ space, path, branch, base, head })) }) });
  saveFlow(app, YAML.stringify({ id: "demo", name: "示例交付", stages: [
    ...(options.confirmation ? [{ id: "fix", name: "修复", by: { object: "code-work" } }] : []),
    { id: "push", name: "推送", by: options.by ?? "owner", done: { signal: options.type ?? "git.pushed" } },
    { id: "deploy", name: "部署", by: "wait" },
  ] }), "owner");
  if (options.confirmation) {
    app.config.webUrl = "https://omem.example.test/";
    // The disposable branch is in the repository; its returned workspace is already gone.
    setRunOutput(app, work.id, { worktrees: repos.map(r => ({ ...r, path: join(app.home, "returned-worktree", r.space), commits: true, newBranch: true, cutFrom: "main", targetBranch: r.branch })) });
    askConfirm(app, getRun(app, work.id), null, "交办完成：实现退款", "复测通过");
  }
  if (options.pushedBefore) for (const r of repos) git(r.path, ["push", "-q", "origin", "feat/refund"]);
  await startFlow(app, item.id, "demo", owner);
  return { app, item, repos, work, s: (id = "push") => getStage(app, item.id, id), push: (i = 0) => git(repos[i].path, ["push", "-q", "origin", "feat/refund"]) };
}
afterEach(async () => {
  vi.restoreAllMocks();
  await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
  for (const app of apps.splice(0)) { app.events.emit("close"); app.db.close(); rmSync(app.home, { recursive: true, force: true }); }
});

describe("Git 完成信号", () => {
  it("只允许 owner / wait，给出中文完成条件", () => {
    for (const by of ["owner", "wait"]) for (const type of ["git.pushed", "git.merged"] as const) {
      const f = parseFlow(YAML.stringify({ id: "demo", name: "示例", stages: [{ id: "push", name: "推送", by, done: { signal: type } }] }));
      expect(describeStage(f.stages[0]).done).toBe(type === "git.pushed" ? "改动推到远端就算做完（你也可以自己点做完）" : "改动合进目标分支就算做完");
    }
    for (const by of [{ run: {} }, { object: "code-work" }]) expect(() => parseFlow(YAML.stringify({ id: "demo", name: "示例", stages: [{ id: "push", name: "推送", by, done: { signal: "git.pushed" } }] }))).toThrow("Git 信号只允许用于 owner 或 wait");
  });
  it("推送前不完成，推送后下一次检查完成并开始部署，依据和宿主日志可查", async () => {
    const t = await setup();
    expect(flowView(t.app, t.item.id).stages[0].waitingSignal).toMatchObject({ type: "git.pushed", checkedAt: null });
    await checkGitSignals(t.app); expect(t.s().state).toBe("doing");
    expect(flowView(t.app, t.item.id).stages[0].waitingSignal).toMatchObject({ checkedAt: expect.any(String), note: expect.stringContaining("还在等") });
    t.push();
    await Promise.all([checkGitSignals(t.app), checkGitSignals(t.app)]);
    expect(t.s()).toMatchObject({ state: "done", evidence: [t.work.id], askId: null });
    expect(t.s("deploy").state).toBe("doing");
    expect(stageLog(t.app, t.item.id).filter((l) => l.stageId === "push" && l.toState === "done")).toMatchObject([{ actor: "host", refs: [t.work.id], note: expect.stringContaining(`shop-0@feat/refund（${t.repos[0].head.slice(0, 7)}）`) }]);
    expect(JSON.parse(signals(t.app).at(-1)!.keys)).toEqual([{ space: "shop-0", branch: "feat/refund", commits: [t.repos[0].head] }]);
  });
  it("轮到本人推送时先查一次：已经推了就直接完成、不问本人；没推才问一张“轮到你了”", async () => {
    let t0 = await setup({ pushedBefore: true });
    expect(t0.s()).toMatchObject({ state: "done", askId: null });
    expect(listAsks(t0.app)).toHaveLength(0);
    t0 = await setup();
    await vi.waitFor(() => expect(t0.s().askId).toBeTruthy());
    expect(t0.s()).toMatchObject({ state: "doing", waitingOn: "owner" });
    expect(listAsks(t0.app).map((a) => a.question.includes("轮到你了"))).toEqual([true]);
  });
  it("本人推送重验不受自动推进上限限制：未应用但远端已有本轮评审的提交", async () => {
    const t = await setup({ confirmation: true, applied: false, pushedBefore: true, reviewedHead: true });
    expect(t.s()).toMatchObject({ state: "done", askId: null });
    expect(t.s("deploy")).toMatchObject({ state: "gated", control: { gateLimit: true } });
    run(t.app.db, "update item_stages set state='stale' where item_id=? and stage_id='push'", t.item.id);
    await advance(t.app, t.item.id);
    expect(t.s()).toMatchObject({ state: "done", askId: null });
    expect(stageLog(t.app, t.item.id).filter(entry => entry.stageId === "push").map(entry => entry.toState)).not.toContain("gated");
  });
  it("交办确认卡已能推送，流程只提示在哪里操作；答卡后按 Git 信号推进", async () => {
    const t = await setup({ confirmation: true, applied: false, count: 2 });
    expect(t.s("fix").state).toBe("done");
    expect(t.s()).toMatchObject({ state: "doing", waitingOn: "owner", askId: null, note: "在『交办完成』那张卡片上点确认并推送，这一段随之完成。" });
    await reportStage(t.app, t.item.id, "push", { state: "done", note: "交办已准备好" }, { actor: "assistant" });
    const [card] = listAsks(t.app);
    expect(listAsks(t.app)).toHaveLength(1);
    expect(card.handler).toBe("review-done");
    const links = card.question.split("\n\n")[1];
    expect(links).toContain(`[看改动](https://omem.example.test/#/code/${t.work.id}?tab=change)`);
    expect(links).toContain(`[所属事项](https://omem.example.test/#/items/${t.item.id})`);
    expect(links).toContain("shop-0 `feat/refund`、shop-1 `feat/refund`");
    expect(JSON.stringify(askCard(t.app, card))).toContain(`[看改动](https://omem.example.test/#/code/${t.work.id}?tab=change)`);
    const choice = card.options.findIndex(o => o.label === "确认并推送");
    await answerAsk(t.app, card.id, { by: "owner", choice });
    expect(t.s()).toMatchObject({ state: "done", evidence: [t.work.id], askId: null });
    expect(git(t.repos[0].remote, ["rev-parse", "refs/heads/feat/refund"])).toBe(t.repos[0].head);
    expect(t.s("deploy")).toMatchObject({ state: "gated", control: { gateLimit: true } });
  });
  it("两个仓库只推一个继续等，全部推送才完成", async () => {
    const t = await setup({ count: 2 }); t.push();
    await checkGitSignals(t.app); expect(t.s().state).toBe("doing");
    expect(signals(t.app).at(-1)!.outcome).toContain("shop-1");
    t.push(1); await checkGitSignals(t.app); expect(t.s().state).toBe("done");
  });
  it("中途交付推进推送阶段，但不算已合并或结束编码", async () => {
    for (const type of ["git.pushed", "git.merged"] as const) {
      const t = await setup({ applied: false, by: "wait", type });
      run(t.app.db, "update runs set status='running' where id=?", t.work.id);
      const { space, branch, head } = t.repos[0];
      await checkGitSignals(t.app);
      expect(t.s().state).toBe("doing");
      t.push();
      setWorkState(t.app, t.work.id, { delivered: [{ at: new Date().toISOString(), branches: [{ space, branch, head }] }] });
      await checkGitSignals(t.app);
      expect(t.s().state).toBe(type === "git.pushed" ? "done" : "doing");
      expect(getRun(t.app, t.work.id)).toMatchObject({ status: "running" });
    }
  });
  it("交办没应用时不完成，同一个原因只记一次；重新尝试会重新记", async () => {
    const t = await setup({ applied: false }); t.push();
    await checkGitSignals(t.app); await checkGitSignals(t.app);
    expect(t.s().state).toBe("doing"); expect(signals(t.app).filter(s => s.type !== "reconcile")).toHaveLength(1);
    expect(signals(t.app)[0].outcome).toContain("还没应用");
    await reopenStage(t.app, t.item.id, "push", "再核对一次", [], owner);
    await checkGitSignals(t.app); expect(signals(t.app)).toHaveLength(2);
  });
  it("没有交办或没有远端都继续等，不重复记原因", async () => {
    const t = await setup();
    run(t.app.db, "delete from item_materials where item_id=? and kind='run'", t.item.id);
    await checkGitSignals(t.app); await checkGitSignals(t.app);
    expect(signals(t.app)).toHaveLength(1); expect(signals(t.app)[0].outcome).toContain("没有关联");
    addLocalMaterials(t.app, t.item.id, [{ kind: "run", ref: t.work.id }], "owner");
    git(t.repos[0].path, ["remote", "remove", "origin"]);
    await checkGitSignals(t.app); expect(t.s().state).toBe("doing"); expect(signals(t.app).at(-1)!.outcome).toContain("没有远端");
  });
  it("git.merged 只认目标分支的远端引用，功能分支推送不算", async () => {
    const t = await setup({ type: "git.merged", by: "wait" }); t.push();
    await checkGitSignals(t.app); expect(t.s().state).toBe("doing");
    git(t.repos[0].path, ["push", "-q", "origin", "feat/refund:main"]);
    await checkGitSignals(t.app); expect(t.s().state).toBe("done");
  });
  it("合并目标未指定时读取远端的自定义默认分支", async () => {
    const t = await setup({ type: "git.merged" });
    const wt = getRun(t.app, t.work.id).output.worktrees as Record<string, unknown>[];
    delete wt[0].cutFrom; setRunOutput(t.app, t.work.id, { worktrees: wt });
    git(t.repos[0].remote, ["symbolic-ref", "HEAD", "refs/heads/trunk"]);
    git(t.repos[0].path, ["push", "-q", "origin", "feat/refund:trunk"]);
    await checkGitSignals(t.app); expect(t.s().state).toBe("done");
  });
  it("本人仍能手动完成，后来的信号不会再完成一次", async () => {
    const t = await setup();
    await ownerAction(t.app, t.item.id, "push", "done", "本人已核对"); t.push();
    await checkGitSignals(t.app); expect(t.s().state).toBe("done"); expect(t.s("deploy").state).toBe("doing");
    expect(signals(t.app)).toHaveLength(0);
  });
  it("远端问不通不报错，十分钟内不再问；巡检仍能继续", async () => {
    const t = await setup();
    git(t.repos[0].path, ["remote", "set-url", "origin", join(t.app.home, "missing.git")]);
    const network = vi.spyOn(gitTools, "gitAsync");
    await expect(checkGitSignals(t.app)).resolves.toBeUndefined();
    // Only the fetch goes to the network; the local containment checks also run through gitAsync.
    const fetches = () => network.mock.calls.filter((c) => (c[1] as string[]).includes("fetch")).length;
    const calls = fetches(); expect(calls).toBe(1);
    await flowReminders(t.app); expect(fetches()).toBe(calls);
    expect(t.s().state).toBe("doing"); expect(signals(t.app).filter(s => s.type !== "reconcile")).toHaveLength(1);
    run(t.app.db, "update kv set value=? where key like 'flow-git-checked:%'", new Date(Date.now() - 601_000).toISOString());
    await checkGitSignals(t.app); expect(fetches()).toBeGreaterThan(calls);
    expect(network.mock.calls.filter((c) => (c[1] as string[]).includes("fetch")).every((c) => c[2]!.timeoutMs! <= 15_000)).toBe(true);
  });
  it("本地引用没有更新时限频 fetch 能发现远端上的提交", async () => {
    const t = await setup();
    // A different checkout updated the bare remote; this checkout has not fetched it.
    git(t.repos[0].remote, ["fetch", "-q", t.repos[0].path, "feat/refund:refs/heads/feat/refund"]);
    await checkGitSignals(t.app); expect(t.s().state).toBe("done");
  });
  it("已推送的应用提交之后又有本地提交，不会多等无关的新提交", async () => {
    const t = await setup(); t.push();
    writeFileSync(join(t.repos[0].path, "other.txt"), "later"); git(t.repos[0].path, ["add", "."]); git(t.repos[0].path, ["commit", "-qm", "later"]);
    await checkGitSignals(t.app); expect(t.s().state).toBe("done");
  });
  it("旧应用记录没有 head 时核对留存补丁，后来的文件改动不遮住已推送的提交", async () => {
    const t = await setup(); const r = t.repos[0];
    const patch = git(r.path, ["diff", r.base, r.head]);
    const dir = join(t.app.runsDir, t.work.id, "patches"); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, `${r.space}.patch`), `${patch}\n`);
    setRunOutput(t.app, t.work.id, { appliedTo: [{ space: r.space, path: r.path, branch: r.branch }], repos: [{ space: r.space, diffBytes: patch.length }] });
    t.push();
    writeFileSync(join(r.path, "app.txt"), "later change\n"); git(r.path, ["add", "."]); git(r.path, ["commit", "-qm", "later change"]);
    await checkGitSignals(t.app); expect(t.s().state).toBe("done");
  });
  it("普通补丁的应用本身不算提交，外部提交推送后才算，并且不改本人索引", async () => {
    const t = await setup({ applied: false }); const r = t.repos[0];
    const patch = git(r.path, ["diff", r.base, r.head]);
    git(r.path, ["reset", "--hard", r.base]);
    const dir = join(t.app.runsDir, t.work.id, "patches"); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, `${r.space}.patch`), `${patch}\n`);
    setRunOutput(t.app, t.work.id, { worktrees: [{ space: r.space, path: join(t.app.home, "removed-worktree"), branch: "work", base: r.base, targetBranch: r.branch }], repos: [{ space: r.space, diffBytes: patch.length }] });
    applyCodeRun(t.app, t.work.id);
    await checkGitSignals(t.app); expect(t.s().state).toBe("doing");
    expect(signals(t.app).at(-1)!.outcome).toContain("没有能核对");
    git(r.path, ["add", "."]); git(r.path, ["commit", "-qm", "owner refund"]); t.push();
    writeFileSync(join(r.path, "staged.txt"), "owner index"); git(r.path, ["add", "."]);
    const before = readFileSync(join(r.path, ".git/index"));
    await checkGitSignals(t.app); expect(t.s().state).toBe("done");
    expect(readFileSync(join(r.path, ".git/index"))).toEqual(before);
  });
  it("工作分支不推送的确认保留提交，随后推送才触发", async () => {
    const t = await setup({ applied: false });
    // Model the workspace being returned without removing the owner's checkout.
    const wt = getRun(t.app, t.work.id).output.worktrees as Record<string, unknown>[];
    wt[0].path = join(t.app.home, "returned-worktree");
    setRunOutput(t.app, t.work.id, { worktrees: wt });
    confirmBranchRun(t.app, t.work.id, { push: false });
    expect((getRun(t.app, t.work.id).output.appliedTo as object[])[0]).toMatchObject({ head: t.repos[0].head, base: t.repos[0].base });
    await checkGitSignals(t.app); expect(t.s().state).toBe("doing");
    t.push(); await checkGitSignals(t.app); expect(t.s().state).toBe("done");
  });
  it("通过 omem 推送成功会立即检查", async () => {
    const t = await setup(); const r = t.repos[0];
    await actCodeGit(t.app, t.work.id, { space: r.space, action: "push", expected_state: readCodeGit(t.app, t.work.id, r.space).state }, "owner");
    expect(t.s().state).toBe("done");
  });
  it.each(["stop", "reopen", "restart"] as const)("远端读取期间 %s，不会把旧依据用于新一轮", async (action) => {
    const t = await setup();
    const original = gitTools.gitAsync;
    let first = true;
    vi.spyOn(gitTools, "gitAsync").mockImplementation(async (...args) => {
      if (first) {
        first = false;
        if (action === "stop") await stopFlow(t.app, t.item.id);
        else if (action === "reopen") await reopenStage(t.app, t.item.id, "push", "重新核对", [], owner);
        else {
          await stopFlow(t.app, t.item.id);
          saveFlow(t.app, YAML.stringify({ id: "other", name: "另一个流程", stages: [{ id: "check", name: "核对", by: "wait" }] }), "owner");
          await startFlow(t.app, t.item.id, "other", owner);
        }
        t.push();
      }
      return original(...args);
    });
    await checkGitSignals(t.app); expect(t.s(action === "restart" ? "check" : "push").state).toBe("doing"); expect(signals(t.app)).toHaveLength(0);
  });
  it("只留三十天的信号记录，没有等待阶段时也清理", async () => {
    const t = await setup();
    run(t.app.db, "insert into flow_signals(at,type,keys,item_id,stage_id,outcome) values(?,?,?,?,?,?)", "2000-01-01", "git.pushed", "[]", t.item.id, "push", "旧记录");
    await ownerAction(t.app, t.item.id, "push", "done", "本人核对");
    await checkGitSignals(t.app); expect(signals(t.app)).toHaveLength(0);
    expect(one(t.app.db, "select value from kv where key like 'flow-git-checked:%'")).toBeUndefined();
  });
});
