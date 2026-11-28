import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testApp } from "./helpers.ts";
import type { App } from "../src/core/app.ts";
import { gitAsync } from "../src/core/git.ts";
import { all, run } from "../src/core/db.ts";
import { now } from "../src/core/util.ts";
import { createSpace, getSpace, updateSpace } from "../src/core/spaces.ts";
import { createApiToken, createUser, addMember } from "../src/core/users.ts";
import { upsertItem } from "../src/items/store.ts";
import { agentProfileSchema } from "../src/core/config.ts";
import { saveFlow } from "../src/flows/definitions.ts";
import { advance, flowReminders, startFlow, stopFlow } from "../src/flows/engine.ts";
import { getStage } from "../src/flows/store.ts";
import { answerAsk } from "../src/agents/asks.ts";
import { createRun, getRun, __testHandlers, setRunOutput } from "../src/agents/runs.ts";
import { runCodeTask, worktreesOf } from "../src/agents/code.ts";
import { leaseWorkspaceAsync } from "../src/agents/workspaces.ts";
import { cleanupCandidates } from "../src/agents/code-cleanup.ts";
import * as runner from "../src/agents/runner.ts";
import { markOutOfQuota } from "../src/agents/capacity.ts";
import { putScope } from "../src/studies/scope.ts";
import { chooseDirection, proposeDirections, reportTrial, studyView, readLedger } from "../src/studies/service.ts";
import { closeDirection, direction, directions, recordFinding, setFindingState, trials } from "../src/studies/store.ts";
import { captureBaseline } from "../src/studies/workspace.ts";
import { planningMaterials } from "../src/studies/materials.ts";
import { fixFinding } from "../src/studies/fix.ts";
import { startServer } from "../src/server/http.ts";

const apps: App[] = [], servers: FastifyInstance[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  vi.restoreAllMocks();
  for (const a of apps.splice(0)) {
    a.events.emit("close");
    for (const f of all<{ item_id: string }>(a.db, "select item_id from item_flows where ended_at is null")) await stopFlow(a, f.item_id);
    await new Promise((r) => setImmediate(r));
    a.db.close(); rmSync(a.home, { recursive: true, force: true });
  }
});
async function git(dir: string, ...args: string[]) { const r = await gitAsync(dir, args, { timeoutMs: 10000 }); if (!r.ok) throw new Error(r.stderr); return r.stdout.trim(); }
async function setup(n = 2, configure?: (a: App) => void, home?: string) {
  const app = testApp(home); apps.push(app); app.config.flows.autoAdvance = 20;
  const root = join(app.home, "original"); mkdirSync(root);
  await git(root, "init", "-qb", "main"); await git(root, "config", "user.name", "test"); await git(root, "config", "user.email", "test@example.com");
  writeFileSync(join(root, "entry.txt"), "before"); await git(root, "add", "entry.txt"); await git(root, "commit", "-qm", "first");
  const base = await git(root, "rev-parse", "HEAD"); writeFileSync(join(root, "owner-untracked.txt"), "keep");
  createSpace(app, { id: "project", name: "项目 A" }); createSpace(app, { id: "repo", name: "仓库 A", kind: "repo", rootPath: root, parentId: "project" });
  configure?.(app);
  const item = upsertItem(app, undefined, { spaceId: "project", kind: "watch", title: "示例研究" }, "user");
  saveFlow(app, JSON.stringify({ id: "workspace-study", name: "研究", stages: [
    { id: "plan", name: "定方向", by: { run: {} }, tools: ["propose_directions"] },
    { id: "try", name: "试验", by: { object: "trials" }, ai: "cheap", escalate: { to: "strong", max: 1 } },
    { id: "summary", name: "小结", by: { run: {} }, tools: ["read_ledger", "record_finding"] },
  ] }), "user");
  await startFlow(app, item.id, "workspace-study", { actor: "owner", userId: "owner" });
  const stage = () => getStage(app, item.id, "try");
  await proposeDirections(app, { item: item.id, directions: [{ goal: "验证退出码", approach: "运行示例命令", acceptance: "逐项核对", env: app.config.studies.envs[0]?.id ?? "", trials: Array.from({ length: n }, (_, i) => ({ object: `对象 ${i}`, check: "检查退出码" })) }] }, { actor: "assistant", userId: "owner", runId: getStage(app, item.id, "plan").control.runId });
  const select = () => answerAsk(app, getStage(app, item.id, "plan").askId!, { choice: 0, by: "owner" });
  const finish = async () => {
    const s = stage(); await reportTrial(app, { trial: s.control.trialId!, result: "failed", summary: "预期失败退出，实际成功", evidence: [] }, { actor: "assistant", userId: "owner", runId: s.control.runId });
    run(app.db, "update runs set status='done',finished_at=? where id=?", now(), s.control.runId!); await advance(app, item.id);
  };
  return { app, item, root, base, stage, select, finish };
}

async function managedClone(f: Awaited<ReturnType<typeof setup>>, name: string) {
  const parent = join(f.app.home, "repos");
  mkdirSync(parent, { recursive: true });
  const root = join(parent, name);
  await git(parent, "clone", "-q", f.root, root);
  return root;
}

describe("研究的工作区", () => {
  it.each([
    { branch: "main", ref: "" },
    { branch: "release", ref: "origin/release" },
  ])("托管克隆的 $branch 基线与最近提交都跟代码索引走", async ({ branch, ref }) => {
    const f = await setup(1);
    const root = await managedClone(f, "example");
    updateSpace(f.app, "repo", { rootPath: root, settings: { codeIndex: { mode: "baseline", ref } } });
    if (ref) await git(f.root, "checkout", "-qb", branch);
    writeFileSync(join(f.root, "entry.txt"), "远端改动");
    await git(f.root, "commit", "-qam", "远端新增提交");
    const remote = await git(f.root, "rev-parse", "HEAD");
    await git(root, "fetch", "-q", "origin", `refs/heads/${branch}:refs/remotes/origin/${branch}`);
    writeFileSync(join(root, "entry.txt"), "检出目录改动");

    expect.soft((await captureBaseline(f.app, f.item.id)).baseline).toEqual({ repo: remote });
    expect.soft(await planningMaterials(f.app, f.item)).toContain("仓库 A：\n远端新增提交\nfirst");
    await f.select();
    expect.soft(JSON.parse(directions(f.app, f.item.id)[0].baseline)).toEqual({ repo: remote });
    expect.soft(JSON.parse(trials(f.app, f.item.id)[0].commits)).toEqual({ repo: remote });
    const cwd = String(getRun(f.app, f.stage().by!).input.cwd);
    expect.soft(readFileSync(join(cwd, "entry.txt"), "utf8")).toBe("远端改动");
    expect(await git(root, "rev-parse", "HEAD")).toBe(f.base);
    expect(readFileSync(join(root, "entry.txt"), "utf8")).toBe("检出目录改动");
  });

  it("本人检出用有未推送提交的 HEAD", async () => {
    const f = await setup(1);
    const remote = await managedClone(f, "example");
    await git(f.root, "remote", "add", "origin", remote);
    await git(f.root, "fetch", "-q", "origin");
    await git(f.root, "commit", "--allow-empty", "-qm", "本地未推送提交");
    const head = await git(f.root, "rev-parse", "HEAD");

    expect((await captureBaseline(f.app, f.item.id)).baseline).toEqual({ repo: head });
    expect(await planningMaterials(f.app, f.item)).toContain("仓库 A：\n本地未推送提交\nfirst");
  });

  it.each([false, true])("托管克隆缺远端引用时使用并注明本地 HEAD（有 origin：%s）", async (withOrigin) => {
    const f = await setup(1);
    const root = await managedClone(f, "example");
    updateSpace(f.app, "repo", { rootPath: root });
    await git(root, "remote", "remove", "origin");
    if (withOrigin) await git(root, "remote", "add", "origin", f.root);
    await git(root, "checkout", "-qb", "local");
    await git(root, "-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "本地 HEAD 提交");
    const head = await git(root, "rev-parse", "HEAD");

    expect((await captureBaseline(f.app, f.item.id)).baseline).toEqual({ repo: head });
    const materials = await planningMaterials(f.app, f.item);
    expect.soft(materials).toContain("使用本地 HEAD");
    expect(materials).toContain("本地 HEAD 提交\nfirst");
    await f.select();
    expect(JSON.parse(directions(f.app, f.item.id)[0].baseline)).toEqual({ repo: head });
    expect(getStage(f.app, f.item.id, "plan").note).toContain("使用本地 HEAD");
    expect(await git(root, "for-each-ref", "refs/remotes/origin")).toBe("");
  });

  it("运行拿到数据目录的工作区，试验间清理，基线不随原仓库 HEAD 改变", async () => {
    const f = await setup(), enqueued: ReturnType<typeof getRun>[] = [];
    f.app.events.on("event", (e) => { if (e.type === "run" && e.status === "queued") { const r = getRun(f.app, e.runId); if (r.kind === "study-trial") enqueued.push(r); } });
    await f.select();
    const d = directions(f.app, f.item.id)[0], first = getRun(f.app, f.stage().by!), cwd = String(first.input.cwd);
    expect(relative(f.app.home, cwd)).not.toMatch(/^\.\./); expect(cwd).not.toBe(f.root); expect(cwd).toContain("workspaces");
    expect(JSON.parse(d.baseline)).toEqual({ repo: f.base }); expect(JSON.parse(trials(f.app, f.item.id)[0].commits)).toEqual({ repo: f.base });
    expect(cleanupCandidates(f.app, { userId: null, spaces: null }).items.some((i) => i.run === first.id)).toBe(false);
    writeFileSync(join(cwd, "leftover.txt"), "leftover"); writeFileSync(join(cwd, ".gitignore"), "ignored.txt"); writeFileSync(join(cwd, "ignored.txt"), "ignored"); writeFileSync(join(cwd, "entry.txt"), "trial edit");
    writeFileSync(join(f.root, "entry.txt"), "new head"); await git(f.root, "add", "entry.txt"); await git(f.root, "commit", "-qm", "second"); const newer = await git(f.root, "rev-parse", "HEAD");
    await git(cwd, "checkout", "-qb", "saved-trial"); await git(cwd, "add", "entry.txt"); await git(cwd, "commit", "-qm", "trial checkpoint"); const savedTrial = await git(cwd, "rev-parse", "HEAD");
    await f.finish(); const second = getRun(f.app, f.stage().by!); expect(second.input.cwd).toBe(cwd);
    expect(existsSync(join(cwd, "leftover.txt"))).toBe(false); expect(existsSync(join(cwd, "ignored.txt"))).toBe(false); expect(readFileSync(join(cwd, "entry.txt"), "utf8")).toBe("before");
    expect(await git(cwd, "rev-parse", "HEAD")).toBe(f.base); expect(await git(f.root, "rev-parse", "HEAD")).toBe(newer);
    expect(await git(f.root, "rev-parse", "saved-trial")).toBe(savedTrial);
    expect(readFileSync(join(f.root, "owner-untracked.txt"), "utf8")).toBe("keep"); expect(readFileSync(join(f.root, "entry.txt"), "utf8")).toBe("new head");
    const fake = vi.spyOn(runner, "runRole").mockImplementation(async (_app, input) => {
      expect(input.cwd).toBe(cwd); expect(input.task).toContain(f.base);
      return { text: "假试验", profileId: "fake", ai: { profile: "fake" } } as Awaited<ReturnType<typeof runner.runRole>>;
    });
    expect(enqueued.at(-1)!.input.cwd).toBeUndefined();
    await __testHandlers.get("study-trial")!({ app: f.app, run: enqueued.at(-1)!, signal: new AbortController().signal, event() {}, output() {} }); expect(fake).toHaveBeenCalledOnce();
    await stopFlow(f.app, f.item.id); expect(worktreesOf(f.app, first.id)).toEqual([]); expect(direction(f.app, d.id).workspace_run_id).toBeNull(); expect(await git(cwd, "status", "--porcelain")).toBe("");
    expect(readFileSync(join(f.root, "owner-untracked.txt"), "utf8")).toBe("keep");
  });
  it("数据目录在链接过的路径下（/home 指向别处）也能租到槽位", async () => {
    const real = mkdtempSync(join(tmpdir(), "omem-real-")), linked = `${real}-link`;
    symlinkSync(real, linked, "junction"); mkdirSync(join(real, "home"));
    try {
      const f = await setup(1, undefined, join(linked, "home"));
      await f.select();
      expect(trials(f.app, f.item.id)[0].result ?? "").not.toBe("blocked");
      expect(String(getRun(f.app, f.stage().by!).input.cwd)).toContain("workspaces");
    } finally { for (const a of apps.splice(0)) { a.events.emit("close"); for (const r of all<{ item_id: string }>(a.db, "select item_id from item_flows where ended_at is null")) await stopFlow(a, r.item_id); await new Promise((r) => setImmediate(r)); a.db.close(); } rmSync(linked, { force: true, recursive: false }); rmSync(real, { recursive: true, force: true }); }
  });
  it("数据目录在链接过的路径下、槽位占满时，自建的工作区也能用", async () => {
    const real = mkdtempSync(join(tmpdir(), "omem-real-")), linked = `${real}-link`;
    symlinkSync(real, linked, "junction"); mkdirSync(join(real, "home"));
    try {
      const f = await setup(1, undefined, join(linked, "home")), repo = getSpace(f.app, "repo");
      for (let n = 0; n < 4; n++) {
        const r = createRun(f.app, { kind: "code", title: "占用工作区", spaceId: "project", input: { repos: ["repo"] } });
        expect(await leaseWorkspaceAsync(f.app, repo, r.id, join(f.app.runsDir, r.id, "work", "repo"))).not.toBeNull();
      }
      await f.select(); const r = getRun(f.app, f.stage().by!);
      expect(trials(f.app, f.item.id)[0].result ?? "").not.toBe("blocked");
      expect(worktreesOf(f.app, r.id)[0].slot).toBeUndefined(); expect(r.input.cwd).toBe(join(f.app.runsDir, r.id, "work", "repo"));
    } finally { for (const a of apps.splice(0)) { a.events.emit("close"); for (const r of all<{ item_id: string }>(a.db, "select item_id from item_flows where ended_at is null")) await stopFlow(a, r.item_id); await new Promise((r) => setImmediate(r)); a.db.close(); } rmSync(linked, { force: true, recursive: false }); rmSync(real, { recursive: true, force: true }); }
  });
  it("入队就唤醒的 worker 等工作区准备完，再读当前的运行目录", async () => {
    const f = await setup(1); let worker: Promise<unknown> | undefined;
    const fake = vi.spyOn(runner, "runRole").mockImplementation(async (_app, input) => {
      expect(input.cwd).toContain("workspaces"); expect(input.cwd).not.toBe(f.root); expect(input.task).toContain(f.base);
      return { text: "假运行", profileId: "fake", ai: { profile: "fake" } } as Awaited<ReturnType<typeof runner.runRole>>;
    });
    f.app.events.on("event", (e) => {
      if (e.type !== "run" || e.status !== "queued") return;
      const r = getRun(f.app, e.runId);
      if (r.kind === "study-trial") worker = __testHandlers.get("study-trial")!({ app: f.app, run: r, signal: new AbortController().signal, event() {}, output() {} });
    });
    await f.select(); await worker; expect(fake).toHaveBeenCalledOnce();
  });
  it("工作区建不出来只 blocked 试验，继续小结", async () => {
    const f = await setup(1); mkdirSync(join(f.app.home, "workspaces")); writeFileSync(join(f.app.home, "workspaces", "repo"), "cannot create slots");
    await f.select(); expect(trials(f.app, f.item.id)[0]).toMatchObject({ state: "reported", result: "blocked" }); expect(trials(f.app, f.item.id)[0].summary).toContain("工作区"); expect(f.stage().state).toBe("done");
    expect(getStage(f.app, f.item.id, "summary").state).toBe("doing");
  });
  it("槽位占满时沿用运行工作区布局，多仓库路径和提交全部进入任务", async () => {
    const f = await setup(1), repo = getSpace(f.app, "repo"), root2 = join(f.app.home, "original-2");
    await git(f.app.home, "clone", "-q", f.root, root2);
    createSpace(f.app, { id: "repo-2", name: "仓库 B", rootPath: root2, parentId: "project" });
    for (let n = 0; n < 4; n++) {
      const r = createRun(f.app, { kind: "code", title: "占用工作区", spaceId: "project", input: { repos: ["repo"] } });
      expect(await leaseWorkspaceAsync(f.app, repo, r.id, join(f.app.runsDir, r.id, "work", "repo"))).not.toBeNull();
    }
    await f.select(); const r = getRun(f.app, f.stage().by!), refs = worktreesOf(f.app, r.id);
    expect(r.input.cwd).toBe(join(f.app.runsDir, r.id, "work", "repo")); expect(refs[0].slot).toBeUndefined(); expect(refs).toHaveLength(2);
    expect(r.input.task).toContain("repo-2"); expect(r.input.task).toContain(refs[1].slot!); expect(trials(f.app, f.item.id)[0].commits).toContain("repo-2");
    await stopFlow(f.app, f.item.id); expect(existsSync(refs[0].path)).toBe(false);
  });
  it.each(["direction", "item"])("%s 结束后释放工作区", async (kind) => {
    const f = await setup(); await f.select(); const r = getRun(f.app, f.stage().by!), d = directions(f.app, f.item.id)[0];
    if (kind === "direction") await closeDirection(f.app, d.id, "dropped", "本轮停止");
    else { upsertItem(f.app, f.item.id, { status: "done" }, "user"); await advance(f.app, f.item.id); }
    expect(worktreesOf(f.app, r.id)).toEqual([]); expect(getRun(f.app, r.id).status).toBe("cancelled");
  });
  it("环境指定的 AI 用于入队和 worker、额度只等同一模型，升档仍去阶段目标", async () => {
    const f = await setup(1, (a) => {
      a.config.agents.profiles.push(agentProfileSchema.parse({ id: "env-ai", command: "node", transport: "acp", model: "small" }), agentProfileSchema.parse({ id: "stage-ai", command: "node", transport: "acp", model: "large" }));
      a.config.longTasks.auto.studies = false; // Exercise the original automatic escalation path.
      a.config.agents.tiers.strong = { profile: "stage-ai", model: "large" };
      a.config.studies.envs = [{ id: "registered", name: "登记环境", note: "按登记的技能使用", thirdParty: false, ai: { profile: "env-ai", model: "small", effort: "low" } }];
    });
    await f.select(); const r = getRun(f.app, f.stage().by!); expect(r.input.execution).toMatchObject({ profile: "env-ai", model: "small" });
    const fake = vi.spyOn(runner, "runRole").mockImplementation(async (_app, input) => {
      expect(input.execution).toMatchObject({ profile: "env-ai", model: "small" }); expect(input.task).toContain("登记环境"); expect(input.task).toContain("按登记的技能使用");
      return { text: "假运行", profileId: "env-ai", ai: { profile: "env-ai" } } as Awaited<ReturnType<typeof runner.runRole>>;
    });
    await __testHandlers.get("study-trial")!({ app: f.app, run: r, signal: new AbortController().signal, event() {}, output() {} }); expect(fake).toHaveBeenCalledOnce();
    markOutOfQuota(f.app, f.app.config.agents.profiles.find((p) => p.id === "env-ai")!, "usage limit; try again tomorrow");
    run(f.app.db, "update runs set status='failed',finished_at=? where id=?", now(), r.id); await advance(f.app, f.item.id); expect(f.stage().waitingOn).toBe("time");
    await flowReminders(f.app, new Date(Date.parse(f.stage().control.waitUntil!) + 1));
    const retry = getRun(f.app, f.stage().by!); expect(retry.input.execution).toMatchObject({ profile: "env-ai" });
    run(f.app.db, "update runs set status='done',finished_at=? where id=?", now(), retry.id); await advance(f.app, f.item.id);
    expect(getRun(f.app, f.stage().by!).input.execution).toMatchObject({ profile: "stage-ai", model: "large" });
  });

  it("试验在入队后改为指定云端 AI 时，worker 阻塞阶段并说明原因", async () => {
    const f = await setup(1, a => {
      a.config.agents.profiles.push(agentProfileSchema.parse({ id: "demo-cloud", transport: "doubao", command: "unused" }));
      mkdirSync(join(a.home, "secrets"), { recursive: true });
      writeFileSync(join(a.home, "secrets", "doubao.json"), JSON.stringify({ demo: {} }));
      a.config.studies.envs = [{ id: "registered", name: "登记环境", note: "执行示例命令", thirdParty: false }];
    });
    await f.select();
    const r = getRun(f.app, f.stage().by!);
    expect(r.input.cwd).toBeTruthy();
    f.app.config.studies.envs[0].ai = { profile: "demo-cloud" };
    const backend = vi.spyOn(runner, "runRole").mockRejectedValue(new Error("不应执行"));
    await __testHandlers.get("study-trial")!({ app: f.app, run: r, signal: new AbortController().signal, event() {}, output() {} });
    expect(backend).not.toHaveBeenCalled();
    expect(f.stage()).toMatchObject({ state: "blocked", note: expect.stringContaining("需要本机工作区或本机命令") });
  });
});

describe("从发现发起编码交办", () => {
  it("新增托管仓库没有方向基线时用远端提交，缺远端引用时注明用本地 HEAD", async () => {
    const f = await setup(1); await f.select(); await f.finish();
    const tracked = await managedClone(f, "tracked"), untracked = await managedClone(f, "untracked");
    await git(untracked, "remote", "remove", "origin");
    await git(f.root, "commit", "--allow-empty", "-qm", "远端新增提交");
    const remote = await git(f.root, "rev-parse", "HEAD");
    await git(tracked, "fetch", "-q", "origin");
    createSpace(f.app, { id: "tracked", name: "仓库 B", rootPath: tracked, parentId: "project" });
    createSpace(f.app, { id: "untracked", name: "仓库 C", rootPath: untracked, parentId: "project" });
    putScope(f.app, f.item.id, { allowCode: true }, "owner");
    const id = recordFinding(f.app, { item: f.item.id, kind: "defect", title: "异常退出码", repro: "执行示例命令", trials: [trials(f.app, f.item.id)[0].id] });

    const fix = await fixFinding(f.app, f.item.id, id, undefined, "owner");
    const work = getRun(f.app, fix!.workId);
    expect.soft(work.input.startCommits).toEqual({ repo: f.base, tracked: remote, untracked: f.base });
    expect(work.input.task).toContain("仓库 C 的代码索引基线引用不可用，使用本地 HEAD");
  });

  it("HTTP 授权、状态、重复点击、交办视图和记录；起点是试验方向基线", async () => {
    const f = await setup(1); await f.select(); await f.finish();
    const t = trials(f.app, f.item.id)[0], id = recordFinding(f.app, { item: f.item.id, kind: "defect", title: "异常退出码", repro: "执行示例命令，预期 1，实际 0", trials: [t.id] });
    const server = await startServer(f.app, { port: 0, quiet: true }); servers.push(server); const url = `/api/items/${f.item.id}/study/findings/${id}/fix`;
    expect((await server.inject({ method: "POST", url })).statusCode).toBe(409);
    putScope(f.app, f.item.id, { allowCode: true }, "owner");
    const member = createUser(f.app, { name: "小王" }); addMember(f.app, "project", member.id, "editor"); const token = createApiToken(f.app, member.id, "测试");
    expect((await server.inject({ method: "POST", url, headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(403);
    setFindingState(f.app, f.item.id, id, "rejected"); expect((await server.inject({ method: "POST", url })).statusCode).toBe(409);
    run(f.app.db, "update study_findings set state='duplicate' where id=?", id); expect((await server.inject({ method: "POST", url })).statusCode).toBe(409);
    setFindingState(f.app, f.item.id, id, "later");
    const res = await server.inject({ method: "POST", url, payload: { note: "保留原有帮助输出" } }); expect(res.statusCode).toBe(200);
    const finding = res.json().findings[0]; expect(finding).toMatchObject({ state: "confirmed", fix: { status: "running" } }); expect(finding.fix.link).toBe(`#/runs/${finding.fix.workId}`);
    const work = getRun(f.app, finding.fix.workId); expect(work.input).toMatchObject({ itemId: f.item.id, repos: ["repo"], startCommits: { repo: f.base } });
    expect(work.input.task).toContain("预期 1，实际 0"); expect(work.input.task).toContain("保留原有帮助输出"); expect(work.input.task).toContain("不合并、不推送");
    expect((await server.inject({ method: "POST", url })).statusCode).toBe(409);
    writeFileSync(join(f.root, "entry.txt"), "newer"); await git(f.root, "add", "entry.txt"); await git(f.root, "commit", "-qm", "newer");
    run(f.app.db, "update runs set input=? where id=?", JSON.stringify({ ...work.input, taskMode: false, design: "never", reviewTier: f.app.config.review.tiers[0].id }), work.id);
    const fake = vi.spyOn(runner, "runRole").mockImplementation(async (_app, input) => {
      expect(input.role).toBe("coder"); expect(readFileSync(join(input.cwd!, "entry.txt"), "utf8")).toBe("before");
      expect(await git(input.cwd!, "rev-parse", "HEAD")).toBe(f.base);
      return { text: "假后端核对了复现基线，未产生改动", profileId: "fake", ai: { profile: "fake" } } as Awaited<ReturnType<typeof runner.runRole>>;
    });
    await runCodeTask({ app: f.app, run: getRun(f.app, work.id), signal: new AbortController().signal, event() {}, output(data) { setRunOutput(f.app, work.id, data); } });
    expect(fake).toHaveBeenCalledOnce(); const wt = worktreesOf(f.app, work.id)[0]; expect(await git(f.root, "rev-parse", wt.branch)).toBe(f.base);
    // Fake completion uses the same run output the code backend supplies, without a model.
    setRunOutput(f.app, work.id, { verdict: "approved" }); run(f.app.db, "update runs set status='done',finished_at=? where id=?", now(), work.id);
    expect(studyView(f.app, f.item.id).findings[0].fix?.status).toBe("done"); expect(readLedger(f.app, { item: f.item.id }, null)).toContain("已有改动：done");
  });
});
