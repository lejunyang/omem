import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testApp } from "./helpers.ts";
import type { App } from "../src/core/app.ts";
import { gitAsync } from "../src/core/git.ts";
import { all, one, run } from "../src/core/db.ts";
import { now } from "../src/core/util.ts";
import { createSpace } from "../src/core/spaces.ts";
import { addPeer, invite } from "../src/core/peers.ts";
import { shareInvite } from "../src/core/federation.ts";
import { remoteKey } from "../src/core/repositories.ts";
import { upsertItem } from "../src/items/store.ts";
import { saveFlow } from "../src/flows/definitions.ts";
import { advance, flowReminders, startFlow, stopFlow } from "../src/flows/engine.ts";
import { getStage, itemFlow } from "../src/flows/store.ts";
import { getItem } from "../src/items/store.ts";
import { startTrial } from "../src/studies/trials.ts";
import { answerAsk } from "../src/agents/asks.ts";
import { getRun, setRunOutput, __testHandlers } from "../src/agents/runs.ts";
import { artifactInbox, artifactPath, artifactsByIds } from "../src/agents/artifacts.ts";
import { seedBuiltinSkills } from "../src/agents/specs.ts";
import * as runner from "../src/agents/runner.ts";
import { callTool, type ToolContext } from "../src/agents/tools.ts";
import { proposeDirections, readLedger, studyView } from "../src/studies/service.ts";
import { trials } from "../src/studies/store.ts";
import { checkEnvPeers } from "../src/studies/envs.ts";
import { acceptPeerTrial, findRepoByRemotes, MAX_EVIDENCE_FILE } from "../src/studies/remote-host.ts";
import { PEER_LOST_MS, PEER_RETRY_MS } from "../src/studies/remote.ts";
import { startServer } from "../src/server/http.ts";

/**
 * A trial handed to another of the owner's devices (docs/v2/studies.md §6): two apps in one process,
 * the device a real HTTP server; its Agent is a stand-in for runRole that reports through the real tool.
 */
const apps: App[] = [], servers: FastifyInstance[] = [], dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const s of servers.splice(0)) await s.close().catch(() => {});
  for (const a of apps.splice(0)) {
    a.events.emit("close");
    await new Promise((r) => setImmediate(r));
    a.db.close(); rmSync(a.home, { recursive: true, force: true });
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
async function git(dir: string, ...args: string[]) { const r = await gitAsync(dir, args, { timeoutMs: 20_000 }); if (!r.ok) throw new Error(r.stderr); return r.stdout.trim(); }
const slash = (p: string) => p.replace(/\\/g, "/");

type Opts = { repoThere?: boolean; serviceToken?: boolean; budget?: { minutes?: number; trials?: number }; thirdParty?: { env: boolean; direction: boolean } };
async function setup(o: Opts = {}) {
  const tmp = mkdtempSync(join(tmpdir(), "omem-remote-trial-")); dirs.push(tmp);
  const bare = slash(join(tmp, "bare.git"));
  await git(tmp, "init", "-q", "--bare", "-b", "main", bare);
  // This device: the study and its repository.
  const here = testApp(); apps.push(here); here.config.flows.autoAdvance = 20;
  const root = join(here.home, "repo"); mkdirSync(root);
  await git(root, "init", "-q", "-b", "main"); await git(root, "config", "user.name", "test"); await git(root, "config", "user.email", "test@example.com");
  writeFileSync(join(root, "entry.txt"), "first"); await git(root, "add", "."); await git(root, "commit", "-qm", "first");
  await git(root, "remote", "add", "origin", bare); await git(root, "remote", "add", "upstream", "https://Example.invalid/Demo/Sample.git");
  await git(root, "push", "-q", "origin", "main");
  // The other device: a checkout of the same repository, one commit behind (it fetches what the direction was confirmed on).
  const there = testApp(); apps.push(there); there.config.node.id = "build-box";
  seedBuiltinSkills(there, resolve("."));
  const rootThere = join(there.home, "checkout");
  await git(there.home, "clone", "-q", bare, rootThere);
  await git(rootThere, "remote", "add", "upstream", "git@example.invalid:demo/sample");
  const firstThere = await git(rootThere, "rev-parse", "HEAD");
  writeFileSync(join(rootThere, "owner-note.txt"), "the owner's own work in progress");
  if (o.repoThere !== false) createSpace(there, { id: "checkout", name: "示例仓库", kind: "repo", rootPath: rootThere });
  writeFileSync(join(root, "entry.txt"), "second"); await git(root, "commit", "-qam", "second"); await git(root, "push", "-q", "origin", "main");
  const base = await git(root, "rev-parse", "HEAD");
  const server = await startServer(there, { port: 0, quiet: true }); servers.push(server);
  if (o.serviceToken) createSpace(there, { id: "handbook", name: "手册" });
  const code = o.serviceToken ? shareInvite(there, { label: "here", shares: [{ space: "handbook", mode: "query" }], url: there.baseUrl! }).code : invite(there, { url: there.baseUrl!, label: "here" }).code;
  await addPeer(here, code);
  createSpace(here, { id: "project", name: "项目 A" }); createSpace(here, { id: "repo", name: "仓库 A", kind: "repo", rootPath: root, parentId: "project" });
  here.config.studies.envs = [{ id: "box", name: "构建机", note: "在构建机上跑。", thirdParty: o.thirdParty?.env ?? false, peer: "build-box" }];
  const item = upsertItem(here, undefined, { spaceId: "project", kind: "watch", title: "示例课题" }, "user");
  saveFlow(here, JSON.stringify({ id: "remote-study", name: "课题", stages: [
    { id: "plan", name: "定方向", by: { run: {} }, tools: ["propose_directions"] },
    { id: "try", name: "试验", by: { object: "trials", agent: "assistant", skill: "study-trial" }, ai: "cheap", ...(o.budget ? { budget: o.budget } : {}) },
    { id: "summary", name: "小结", by: { run: {} }, tools: ["read_ledger", "record_finding"] },
  ] }), "user");
  await startFlow(here, item.id, "remote-study", { actor: "owner", userId: "owner" });
  const stage = () => getStage(here, item.id, "try");
  await proposeDirections(here, { item: item.id, directions: [{ goal: "核对退出码", approach: "在构建机上运行示例命令", acceptance: "逐项核对", env: "构建机", thirdParty: o.thirdParty?.direction, trials: [{ object: "示例命令", check: "失败时退出码不是 0" }, { object: "帮助命令", check: "退出码是 0" }] }] }, { actor: "assistant", userId: "owner", runId: getStage(here, item.id, "plan").control.runId });
  const select = () => answerAsk(here, getStage(here, item.id, "plan").askId!, { choice: 0, by: "owner" });
  const remoteRuns = () => all<{ id: string; status: string }>(there.db, "select id,status from runs where kind='peer-trial' order by created_at,rowid");
  /** The other device's worker, by hand: the run starts, its Agent (a stand-in) works, the run ends. */
  const work = async (id: string, agent: (input: Parameters<typeof runner.runRole>[1]) => Promise<void>) => {
    run(there.db, "update runs set status='running',started_at=? where id=?", now(), id);
    vi.spyOn(runner, "runRole").mockImplementation(async (_app, input) => {
      await agent(input);
      return { text: "做完了", profileId: "fake", ai: { profile: "fake", model: "small" } } as Awaited<ReturnType<typeof runner.runRole>>;
    });
    await __testHandlers.get("peer-trial")!({ app: there, run: getRun(there, id), signal: new AbortController().signal, event() {}, output: (d) => setRunOutput(there, id, d) });
    run(there.db, "update runs set status='done',finished_at=?,ai=? where id=?", now(), JSON.stringify({ profile: "fake", model: "small" }), id);
  };
  const tool = (runId: string): ToolContext => ({ app: there, runId, spaceId: "checkout", spaces: null, writable: ["checkout"], tools: null, actor: "agent", userId: "owner", role: "assistant" });
  return { here, there, server, item, root, rootThere, firstThere, base, stage, select, remoteRuns, work, tool };
}

describe("把试验派给另一台设备", () => {
  it("那台按远端地址认出仓库，取一次缺的提交，在自己的工作区里跑；结果和证据回到本机台账", async () => {
    const f = await setup();
    await f.select();
    const [t0] = trials(f.here, f.item.id);
    expect(t0).toMatchObject({ state: "running", peer: "build-box", run_id: null });
    expect(f.stage().control).toMatchObject({ trialId: t0.id }); expect(f.stage().control.runId).toBeUndefined();
    expect(f.stage().note).toContain("派给了 build-box");
    const [remote] = f.remoteRuns();
    expect(remote.status).toBe("queued"); expect(t0.peer_run).toBe(remote.id);
    expect(JSON.parse(one<{ trigger: string }>(f.there.db, "select trigger from runs where id=?", remote.id)!.trigger)).toMatchObject({ via: "peer", where: expect.any(String) });
    // Still running there: asking changes nothing here.
    await advance(f.here, f.item.id);
    expect(trials(f.here, f.item.id)[0].state).toBe("running");

    await f.work(remote.id, async (input) => {
      const cwd = input.cwd!;
      expect(relative(f.there.home, cwd)).not.toMatch(/^\.\./); expect(resolve(cwd)).not.toBe(resolve(f.rootThere));
      expect(await git(cwd, "rev-parse", "HEAD")).toBe(f.base);
      expect(input.ownAI).toBe(true); expect(input.addTools).toEqual(["trial_report", "attach_artifact"]); expect(input.denyTools).toContain("read_ledger");
      expect(input.task).toContain("失败时退出码不是 0"); expect(input.task).toContain("# 做一个试验"); expect(input.task).toContain("不收 src: 引用");
      const inbox = artifactInbox(f.there, input.runId!);
      writeFileSync(join(inbox, "exit.log"), "$ demo run --fail\nexit 0\n");
      writeFileSync(join(inbox, "trace.log"), "x".repeat(MAX_EVIDENCE_FILE + 4096));
      // Only this trial, only files.
      expect((await callTool(f.tool(input.runId!), "trial_report", { trial: "st_other", result: "passed", summary: "别的" })).isError).toBe(true);
      expect((await callTool(f.tool(input.runId!), "trial_report", { trial: t0.id, result: "passed", summary: "引用", evidence: ["src:abcdef12"] })).isError).toBe(true);
      const ok = await callTool(f.tool(input.runId!), "trial_report", { trial: t0.id, result: "failed", summary: "失败时退出码仍是 0", evidence: [join(inbox, "exit.log"), join(inbox, "trace.log")], findings: [{ kind: "defect", title: "失败退出码是 0", repro: "demo run --fail; echo $?" }] });
      expect(ok.isError).toBe(false);
    });
    // The owner's checkout there is left as it was; the commit was fetched into its repository; the workspace is given back.
    expect(await git(f.rootThere, "rev-parse", "HEAD")).toBe(f.firstThere);
    expect(readFileSync(join(f.rootThere, "owner-note.txt"), "utf8")).toContain("work in progress");
    await git(f.rootThere, "cat-file", "-e", `${f.base}^{commit}`);
    expect(getRun(f.there, remote.id).output.worktrees).toEqual([]);

    await advance(f.here, f.item.id);
    const t = trials(f.here, f.item.id)[0];
    expect(t).toMatchObject({ state: "reported", result: "failed", peer: "build-box", peer_run: remote.id });
    expect(JSON.parse(t.commits)).toEqual({ repo: f.base });
    expect(JSON.parse(t.findings)).toEqual([expect.objectContaining({ title: "失败退出码是 0" })]);
    expect(t.summary).toContain("trace.log 原来"); expect(t.summary).toContain("只带回开头");
    const local = getRun(f.here, t.run_id!);
    expect(local).toMatchObject({ kind: "study-trial", status: "done", ai: { profile: "peer:build-box:fake", model: "small" } });
    const files = artifactsByIds(f.here, JSON.parse(t.evidence));
    expect(files.map((a) => a.name).sort()).toEqual(["exit.log", "trace.log"]);
    expect(readFileSync(artifactPath(f.here, files.find((a) => a.name === "exit.log")!), "utf8")).toContain("exit 0");
    const cut = readFileSync(artifactPath(f.here, files.find((a) => a.name === "trace.log")!), "utf8");
    expect(cut.length).toBeLessThan(MAX_EVIDENCE_FILE + 200); expect(cut).toContain("以下截断");
    const view = studyView(f.here, f.item.id).trials.find((x) => x.id === t.id)!;
    expect(view).toMatchObject({ peer: "build-box", peerRunId: remote.id, runId: local.id, result: "failed" });
    expect(readLedger(f.here, { item: f.item.id }, null)).toContain("在设备 build-box 上跑");
    // The next trial goes out on the same tick.
    expect(f.remoteRuns()).toHaveLength(2); expect(trials(f.here, f.item.id)[1]).toMatchObject({ state: "running", peer_run: f.remoteRuns()[1].id });
  }, 60_000);

  it("那台没有这个仓库：记跑不了，不再重试", async () => {
    const f = await setup({ repoThere: false });
    await f.select();
    const t = trials(f.here, f.item.id)[0];
    expect(t).toMatchObject({ state: "reported", result: "blocked", failures: 0, peer: "build-box" });
    expect(t.summary).toBe("build-box上没有这个仓库（仓库 A）");
    expect(f.remoteRuns().filter((r) => r.status === "queued")).toHaveLength(0);
  }, 60_000);

  it("别人的服务令牌被拒；第三方许可照环境的声明", async () => {
    const f = await setup({ serviceToken: true });
    await f.select();
    const t = trials(f.here, f.item.id)[0];
    expect(t).toMatchObject({ state: "reported", result: "blocked", failures: 0 }); expect(t.summary).toContain("没有接受这个试验");
    expect(f.remoteRuns()).toHaveLength(0);
    await expect(acceptPeerTrial(f.there, "svc-someone", {})).rejects.toThrow(/只接受本人自己设备/);
    const body = { from: { node: "laptop", item: "i1", title: "示例课题", trial: "st_1" }, trial: { id: "st_1", object: "样本", check: "安装" }, direction: { goal: "g", approach: "a", note: "", thirdParty: true }, env: { name: "构建机", note: "", thirdParty: false }, repos: [], minutes: 30 };
    await expect(acceptPeerTrial(f.there, "owner", body)).rejects.toThrow(/不允许/);
    expect((await acceptPeerTrial(f.there, "owner", { ...body, env: { ...body.env, thirdParty: true } })).runId).toMatch(/^r/);
  }, 60_000);

  it("对方离线：派不出去等一会儿再试一次，还不行记跑不了；跑着的时候失联超过一小时同样处理", async () => {
    const f = await setup();
    await f.server.close();
    await f.select();
    let t = trials(f.here, f.item.id)[0];
    expect(t).toMatchObject({ state: "queued", failures: 1 }); expect(t.summary).toContain("连不上 build-box");
    expect(f.stage()).toMatchObject({ waitingOn: "time" });
    const wait = Date.parse(f.stage().control.waitUntil!);
    expect(wait - Date.now()).toBeGreaterThan(PEER_RETRY_MS - 60_000);
    await flowReminders(f.here, new Date(wait + 1000));
    t = trials(f.here, f.item.id)[0];
    expect(t).toMatchObject({ state: "reported", result: "blocked" }); expect(t.summary).toContain("连不上 build-box");
    // The next trial is tried the same way (each trial has its own retry).
    expect(trials(f.here, f.item.id)[1]).toMatchObject({ state: "queued", failures: 1 });
  }, 60_000);

  it("跑着时失联：一小时内只等着，超过一小时算这一次没跑成", async () => {
    const f = await setup();
    await f.select();
    const out = trials(f.here, f.item.id)[0];
    expect(out.state).toBe("running");
    await f.server.close();
    const sent = Date.parse(out.peer_seen!);
    await flowReminders(f.here, new Date(sent + 30 * 60_000));
    expect(trials(f.here, f.item.id)[0]).toMatchObject({ state: "running", failures: 0 });
    await flowReminders(f.here, new Date(sent + PEER_LOST_MS + 60_000));
    const t = trials(f.here, f.item.id)[0];
    expect(t).toMatchObject({ state: "queued", failures: 1 }); expect(t.summary).toContain("超过 60 分钟");
  }, 60_000);

  it("停止流程、预算用完时请那台取消它的运行", async () => {
    const f = await setup({ budget: { minutes: 1 } });
    await f.select();
    const [first] = f.remoteRuns();
    // Running there two minutes already: over this round's minutes, so it is stopped there and here.
    run(f.there.db, "update runs set started_at=? where id=?", new Date(Date.now() - 2 * 60_000).toISOString(), first.id);
    await advance(f.here, f.item.id);
    expect(getRun(f.there, first.id).status).toBe("cancelled");
    expect(trials(f.here, f.item.id)[0]).toMatchObject({ state: "reported", result: "unclear" });
    expect(trials(f.here, f.item.id)[0].summary).toContain("分钟预算");
    expect(f.stage().state).toBe("done");

    const g = await setup();
    await g.select();
    const [second] = g.remoteRuns();
    await stopFlow(g.here, g.item.id);
    expect(getRun(g.there, second.id).status).toBe("cancelled");
    expect(trials(g.here, g.item.id)[0].state).toBe("queued");
  }, 90_000);

  it("准备不了工作区时那台交回“跑不了”", async () => {
    const f = await setup();
    await f.select();
    const [remote] = f.remoteRuns();
    // The commit is nowhere to be fetched from.
    const input = getRun(f.there, remote.id).input as { repos: { commit: string }[] };
    input.repos[0].commit = "0123456789abcdef0123456789abcdef01234567";
    run(f.there.db, "update runs set input=? where id=?", JSON.stringify(input), remote.id);
    const fake = vi.fn();
    await f.work(remote.id, fake);
    expect(fake).not.toHaveBeenCalled();
    await advance(f.here, f.item.id);
    const t = trials(f.here, f.item.id)[0];
    expect(t).toMatchObject({ state: "reported", result: "blocked" }); expect(t.summary).toContain("取过一次也没有");
  }, 60_000);

  it("改后重跑在本机交办的工作区里跑：第三方许可看本机的，不看那台环境的", async () => {
    const f = await setup({ thirdParty: { env: true, direction: true } });
    await f.select();
    const first = trials(f.here, f.item.id)[0];
    expect(first).toMatchObject({ state: "running", peer: "build-box" });
    run(f.here.db, `insert into study_trials(id,item_id,direction_id,round,seq,object,"check",env,state,fix_of,work_id,created_at,updated_at) values(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      "st_rerun", f.item.id, first.direction_id, 1, 99, first.object, first.check, first.env, "queued", "sf_demo", "r_demo", now(), now());
    const flow = itemFlow(f.here, f.item.id)!;
    await startTrial(f.here, getItem(f.here, f.item.id), flow, flow.definition.stages[1], trials(f.here, f.item.id).find((t) => t.id === "st_rerun")!, undefined);
    const rerun = trials(f.here, f.item.id).find((t) => t.id === "st_rerun")!;
    expect(rerun).toMatchObject({ state: "reported", result: "blocked", peer: null });
    expect(rerun.summary).toContain("本机没有允许");
  }, 60_000);
});

describe("环境登记和仓库的认法", () => {
  it("环境写的设备必须已配对，不能是别人的服务；没改过的旧条目不拦", async () => {
    const f = await setup();
    await expect(checkEnvPeers(f.here, [{ id: "x", name: "X", note: "", thirdParty: false, peer: "nowhere" }])).rejects.toThrow(/没有配对/);
    await expect(checkEnvPeers(f.here, [{ id: "x", name: "X", note: "", thirdParty: false, peer: "build-box" }], [])).resolves.toBeUndefined();
    await expect(checkEnvPeers(f.here, [{ id: "x", name: "X", note: "", thirdParty: false, peer: "nowhere" }], [{ id: "x", name: "X", note: "", thirdParty: false, peer: "nowhere" }])).resolves.toBeUndefined();
    run(f.here.db, "insert into kv(key,value) values(?,?)", "mesh_card:build-box", JSON.stringify({ peer: "build-box", at: now(), card: { node: "build-box", at: now(), as: "service" } }));
    await expect(checkEnvPeers(f.here, [{ id: "x", name: "X", note: "", thirdParty: false, peer: "build-box" }], [])).rejects.toThrow(/别人的服务/);
  }, 60_000);

  it("https、scp 写法、大小写和 .git 都认成同一个仓库", async () => {
    const f = await setup();
    expect(await findRepoByRemotes(f.there, [remoteKey("https://Example.invalid/Demo/Sample.git")])).toMatchObject({ space: { id: "checkout" }, remotes: ["upstream"] });
    expect(await findRepoByRemotes(f.there, [remoteKey("ssh://git@example.invalid:22/demo/sample")])).toMatchObject({ space: { id: "checkout" } });
    expect(await findRepoByRemotes(f.there, [remoteKey("https://example.invalid/demo/other")])).toBeNull();
    expect(existsSync(f.rootThere)).toBe(true);
  }, 60_000);
});
