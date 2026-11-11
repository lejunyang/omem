import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import "../src/agents/jobs.ts";
import { answerAsk, getAsk, listAsks } from "../src/agents/asks.ts";
import { codeChainFor, trySettleCodeChain } from "../src/agents/code-chain.ts";
import { listTasks } from "../src/agents/code-tasks.ts";
import { codeWork } from "../src/agents/code-works.ts";
import { __testHandlers, addRunEvent, createRun, getRun, runEvents, setRunOutput } from "../src/agents/runs.ts";
import { createThread } from "../src/agents/threads.ts";
import { callTool, type ToolContext } from "../src/agents/tools.ts";
import { App } from "../src/core/app.ts";
import { all, run } from "../src/core/db.ts";
import { createSpace } from "../src/core/spaces.ts";
import { OWNER } from "../src/core/users.ts";
import { designChanges, designDiff } from "../src/designs/changes.ts";
import { createDesign, decideDesign, designForWork, getDesign, setDesignWork, submitRevision } from "../src/designs/store.ts";
import { designDigest, designStage } from "../src/designs/work.ts";
import { startServer } from "../src/server/http.ts";
import { testApp } from "./helpers.ts";

const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };

/** A repository with refund.ts on main. */
function repo() {
  const dir = mkdtempSync(join(tmpdir(), "omem-design-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", env });
  git("init", "-q", "-b", "main");
  writeFileSync(join(dir, "refund.ts"), "export const refund = 0;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  return { dir, git };
}

/** Run a queued run's handler the way the worker does, and mark it finished. */
async function work(app: App, id: string) {
  run(app.db, "update runs set status = 'running' where id = ?", id);
  const r = getRun(app, id);
  const out = await __testHandlers.get(r.kind)!({
    app, run: r, signal: new AbortController().signal,
    event: (type, data) => addRunEvent(app, id, type, data),
    output: (data) => setRunOutput(app, id, data),
  }) as Record<string, unknown>;
  setRunOutput(app, id, out ?? {});
  run(app.db, "update runs set status = 'done' where id = ?", id);
  trySettleCodeChain(app, id);
  return out as { verdict: string; continuedRunId?: string };
}

function fakeAgent(app: App, extra: Record<string, string>) {
  app.config.agents.profiles.push({ id: "fake", name: "fake", transport: "acp", command: process.execPath, args: [resolve("test/fake-acp-agent.ts")], env: { FAKE_MODE: "tasks", ...extra }, idleTimeoutMs: 60000 });
  app.config.agents.default = "fake";
}
const lines = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : []);

describe("a delegation that writes a design first", () => {
  it("writes the design after the check before coding, waits for the owner, reworks it on a comment, and codes from it once approved — also after a restart", async () => {
    const app = testApp();
    app.config.agents.autoAdvance.preCheck = true;
    const scratch = mkdtempSync(join(tmpdir(), "omem-design-log-"));
    const toolLog = join(scratch, "tools.jsonl");
    const promptLog = join(scratch, "prompts.jsonl");
    fakeAgent(app, { FAKE_DESIGN_NEEDED: "1", FAKE_TOOL_LOG: toolLog, FAKE_PROMPT_LOG: promptLog });
    const { dir } = repo();
    createSpace(app, { id: "shop-api", name: "订单服务", kind: "repo", rootPath: dir });
    const server = await startServer(app, { port: 0, quiet: true });
    try {
      const t = createThread(app, { channel: "web", spaceId: "shop-api", userId: OWNER });
      const ask = createRun(app, { kind: "ask", spaceId: "shop-api", title: "交办", input: { conversationId: t.id } });
      const r1 = createRun(app, { kind: "code", spaceId: "shop-api", title: "退款金额", input: { task: "退款只按未发货的行计算", repos: ["shop-api"], taskMode: true }, parentId: ask.id });
      codeChainFor(app, r1);

      // The check before coding says a design is worth it: the designer writes one and the round ends waiting.
      expect((await work(app, r1.id)).verdict).toBe("awaiting-design");
      expect((getRun(app, r1.id).output.preCheck as { design?: unknown }).design).toMatchObject({ needed: true });
      const d = designForWork(app, r1.id)!;
      expect(d).toMatchObject({ origin: "own", status: "review", revision: 1, workId: r1.id });
      expect(listTasks(app, r1.id)).toEqual([]);
      const designer = lines(promptLog).map((l) => JSON.parse(l) as string).find((p) => p.includes("# 写方案"))!;
      expect(designer).toContain("## 编码前的检查");
      expect(designer).toContain("要改退款金额在退款单和对账之间的分工");
      // The owner's card: one line per decision, the link, the question as a field of its own.
      const card = listAsks(app, { status: "pending" }).find((a) => a.handler === "design-confirm")!;
      expect(card.question).toContain("D1 [修改] 退款金额在 refund.ts 里算（要你定）");
      expect(card.question).toContain(`#/design/${d.id}`);
      expect(card.ui?.fields?.map((f) => f.id)).toEqual(["action", "D1", "text"]);
      expect(codeWork(app, r1.id)!.stage).toMatchObject({ key: "design", group: "owner" });
      expect(getRun(app, ask.id).output.codeChain).toMatchObject({ awaitingUser: false });

      // Words for the coder while it waits are kept for when coding starts; going on would skip the design.
      const ctx: ToolContext = { app, runId: ask.id, spaceId: "shop-api", spaces: ["shop-api", "personal"], tools: null, actor: "agent", userId: OWNER };
      const said = await callTool(ctx, "message_code_run", { run_id: r1.id, text: "测试用例写在 refund.test.ts" });
      expect(said.text).toContain("在等方案");

      // A comment: the same designer session writes the next version, the old card closes, a new one goes out.
      decideDesign(app, d.id, { action: "comment", text: "对账也改成调用同一个函数", by: "owner" });
      expect(getAsk(app, card.id).status).toBe("cancelled");
      expect(getRun(app, r1.id).status).toBe("queued");
      expect((await work(app, r1.id)).verdict).toBe("awaiting-design");
      const v2 = getDesign(app, d.id);
      expect(v2).toMatchObject({ revision: 2, status: "review" });
      expect(v2.body.decisions.map((x) => [x.id, x.title])).toEqual([["D1", "退款金额只在 refund.ts 里算，对账直接调用"]]);
      const card2 = listAsks(app, { status: "pending" }).find((a) => a.handler === "design-confirm")!;
      expect(card2.id).not.toBe(card.id);

      // After a restart (another process on the same library) the card still works: approved with the answer, the round queued again.
      const again = App.open(app.home);
      try {
        await answerAsk(again, card2.id, { value: { action: "通过", D1: "按金额比例", text: "" }, by: OWNER });
      } finally { again.db.close(); }
      expect(getDesign(app, d.id)).toMatchObject({ status: "approved" });
      expect(getDesign(app, d.id).body.decisions[0].question?.answer).toBe("按金额比例");
      expect(getRun(app, r1.id).status).toBe("queued");

      // Coding from the design: the task names its decision (a made-up one is refused), the deviation lands on the decision.
      const third = await work(app, r1.id);
      expect(third.verdict).not.toBe("awaiting-design");
      const coder = lines(promptLog).map((l) => JSON.parse(l) as string).filter((p) => p.includes("先用 `plan_tasks` 拆分")).at(-1)!;
      expect(coder).toContain("## 方案（本人已确认，第 2 版）");
      expect(coder).toContain("本人的回答：按金额比例");
      expect(coder).toContain("测试用例写在 refund.test.ts");
      const calls = lines(toolLog).map((l) => JSON.parse(l) as { name: string; args: Record<string, unknown>; error: unknown });
      const plans = calls.filter((c) => c.name === "plan_tasks");
      expect(JSON.stringify(plans[0].error)).toContain("没有决定 D9");
      expect(plans[1].error).toBeNull();
      const tasks = listTasks(app, r1.id);
      expect(tasks[0].origin.decision).toBe("D1");
      expect(tasks[1].origin.decision).toBeUndefined();
      const after = getDesign(app, d.id).body.decisions[0].after!;
      expect(after.deviation).toBe("T1：对账脚本也顺手改成调用 refund.ts");
      expect(after.simpler).toContain("导出任务也可以");
      // An own design goes by itself: no change description for this delegation.
      expect(all(app.db, "select id from designs where work_id = ? and origin = 'derived'", r1.id)).toEqual([]);

      // Where each decision landed: its task, commit and lines; the other task is outside the design.
      const { changes, outside } = await designChanges(app, getDesign(app, d.id));
      expect(changes[0]).toMatchObject({ decision: "D1", tasks: [{ seq: 1, title: "退款只算未发货的行" }], commits: 1 });
      expect(changes[0].files).toEqual([expect.objectContaining({ space: "shop-api", path: "refund.ts" })]);
      expect(changes[0].files[0].add).toBeGreaterThan(0);
      expect(outside.map((f) => f.path)).toContain("refund.test.ts");
      const diff = await designDiff(app, getDesign(app, d.id), "D1");
      expect(diff.patches[0]).toMatchObject({ space: "shop-api", label: "T1 退款只算未发货的行" });
      expect(diff.patches[0].patch).toContain("refund.ts");
      expect((await designDiff(app, getDesign(app, d.id), "outside")).patches.map((p) => p.patch).join("")).toContain("refund.test.ts");
      expect(designDigest(app, r1.id)).toContain("D1 [修改] 退款金额只在 refund.ts 里算，对账直接调用");
      expect(designDigest(app, r1.id)).toContain("（有偏差）");
    } finally {
      await server.close();
    }
  }, 240000);

  it("does not write a design when told not to, and the coder hands in a change description instead", async () => {
    const app = testApp();
    app.config.agents.autoAdvance.preCheck = true;
    fakeAgent(app, { FAKE_DESIGN_NEEDED: "1", FAKE_DERIVED: "1" });
    const { dir } = repo();
    createSpace(app, { id: "shop-api", name: "订单服务", kind: "repo", rootPath: dir });
    const server = await startServer(app, { port: 0, quiet: true });
    try {
      const t = createThread(app, { channel: "web", spaceId: "shop-api", userId: OWNER });
      const ask = createRun(app, { kind: "ask", spaceId: "shop-api", title: "交办", input: { conversationId: t.id } });
      const r1 = createRun(app, { kind: "code", spaceId: "shop-api", title: "退款金额", input: { task: "退款只按未发货的行计算", repos: ["shop-api"], taskMode: true, design: "never" }, parentId: ask.id });
      codeChainFor(app, r1);
      expect((await work(app, r1.id)).verdict).not.toBe("awaiting-design");
      expect(listAsks(app, { status: "pending" }).some((a) => a.handler === "design-confirm")).toBe(false);
      const d = designForWork(app, r1.id)!;
      expect(d).toMatchObject({ origin: "derived", status: "recorded", revision: 1 });
      expect(d.body.decisions[0]).toMatchObject({ kind: "change", title: "退款只算未发货的行", tasks: [1] });
      const { changes } = await designChanges(app, d);
      expect(changes[0].tasks.map((x) => x.seq)).toEqual([1]);
    } finally {
      await server.close();
    }
  }, 120000);
});

describe("designs and delegations without an agent", () => {
  const app = testApp();
  const { dir } = repo();
  createSpace(app, { id: "shop-api", name: "订单服务", kind: "repo", rootPath: dir });
  const t = createThread(app, { channel: "web", spaceId: "shop-api", userId: OWNER });
  const ask = createRun(app, { kind: "ask", spaceId: "shop-api", title: "交办", input: { conversationId: t.id } });
  const ctx = (extra: Partial<ToolContext> = {}): ToolContext => ({ app, runId: ask.id, spaceId: "shop-api", spaces: ["shop-api", "personal"], tools: null, actor: "agent", userId: OWNER, ...extra });
  const external = () => {
    const d = createDesign(app, { spaceId: "shop-api", title: "小王的退款方案", origin: "external", author: "小王", repos: ["shop-api"], userId: OWNER });
    return submitRevision(app, d.id, { decisions: [{ kind: "change", title: "退款金额改由订单服务计算", concerns: [{ level: "problem", text: "对账读的是落库前的金额" }] }] });
  };

  it("takes an existing design as the baseline (design_id), and refuses one that is not ready", async () => {
    const ext = external();
    const res = await callTool(ctx(), "delegate_code", { repo_spaces: ["shop-api"], task: "照小王的方案改退款", design_id: ext.id });
    expect(res.isError, res.text).toBe(false);
    expect(res.text).toContain(`照方案 ${ext.id}`);
    const runId = /运行 (r\w+)/.exec(res.text)![1];
    expect(designForWork(app, runId)!.id).toBe(ext.id);
    const drafting = createDesign(app, { spaceId: "shop-api", title: "还在写", origin: "own", userId: OWNER });
    const refused = await callTool(ctx(), "delegate_code", { repo_spaces: ["shop-api"], task: "改退款", design_id: drafting.id });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("不能作为基线");
    run(app.db, "update runs set status = 'cancelled' where kind = 'code'");
  });

  it("checks plan_tasks' decision and puts finish_task's deviation onto it", async () => {
    const own = createDesign(app, { spaceId: "shop-api", title: "退款", origin: "own", userId: OWNER });
    const r = createRun(app, { kind: "code", spaceId: "shop-api", title: "退款", input: { task: "改退款", repos: ["shop-api"], taskMode: true }, parentId: ask.id });
    submitRevision(app, own.id, { decisions: [{ kind: "remove", title: "删掉页面里的合计", fields: { removes: { brief: "两处合计" }, users: { brief: "只有退款页" }, fallback: { brief: "不涉及：页面改调接口" }, cleanup: { brief: "不涉及" } } }] });
    decideDesign(app, own.id, { action: "approve", by: "owner" });
    setDesignWork(app, own.id, r.id);
    run(app.db, "update runs set status = 'running' where id = ?", r.id);
    const coder = ctx({ runId: r.id, role: "coder" });
    const bad = await callTool(coder, "plan_tasks", { tasks: [{ title: "删合计", decision: "D7" }] });
    expect(bad.text).toContain("没有决定 D7");
    expect((await callTool(coder, "plan_tasks", { tasks: [{ title: "删合计", decision: "D1" }, { title: "改文案" }] })).isError).toBe(false);
    await callTool(coder, "finish_task", { task: "T1", summary: "删了", deviation: "退款页还留了一份，给旧版本用" });
    await callTool(coder, "finish_task", { task: "T2", summary: "改了", deviation: "这项不在方案里" });
    const after = getDesign(app, own.id).body.decisions[0].after!;
    expect(after.deviation).toBe("T1：退款页还留了一份，给旧版本用");
    // The coder of an own design does not hand in a change description.
    const refused = await callTool(coder, "submit_design", { decisions: [{ kind: "change", title: "x", fields: { behavior: { brief: "y" } } }] });
    expect(refused.text).toContain("不交变更说明");
    run(app.db, "update runs set status = 'done' where id = ?", r.id);
  });

  it("leaves the confirmation to the assistant that delegated when the setting says so and nothing waits on the owner", async () => {
    app.config.agents.design = { mode: "auto", confirm: "assistant" };
    try {
      const r = createRun(app, { kind: "code", spaceId: "shop-api", title: "退款", input: { task: "改退款", repos: ["shop-api"], taskMode: true }, parentId: ask.id });
      codeChainFor(app, r);
      const d = createDesign(app, { spaceId: "shop-api", title: "退款", origin: "own", workId: r.id, userId: OWNER });
      submitRevision(app, d.id, { decisions: [{ kind: "remove", title: "删掉页面里的合计", fields: { removes: { brief: "两处合计" }, users: { brief: "只有退款页" }, fallback: { brief: "不涉及" }, cleanup: { brief: "不涉及" } } }] });
      // Found waiting (as after a restart): the assistant is woken, not the owner.
      const stage = await designStage(app, { run: getRun(app, r.id), task: "改退款", spaces: ["shop-api"], cwd: dir, signal: new AbortController().signal, event: () => {}, pre: null });
      expect(stage.wait).toBe(true);
      run(app.db, "update runs set status = 'done' where id = ?", r.id);
      expect(getRun(app, r.id).output).toMatchObject({ verdict: "awaiting-design", designWait: { designId: d.id, by: "assistant" } });
      expect(listAsks(app, { status: "pending" }).some((a) => a.handler === "design-confirm" && a.runId === r.id)).toBe(false);
      const turn = all<{ id: string; input: string }>(app.db, "select id, input from runs where kind = 'ask' and json_extract(input, '$.handoff.designId') = ?", d.id);
      expect(turn).toHaveLength(1);
      expect(JSON.parse(turn[0].input).handoff).toMatchObject({ kind: "design", workId: r.id });
      expect(codeWork(app, r.id)!.stage).toMatchObject({ key: "design", group: "assistant" });
      // The assistant confirms in that turn: the delegation goes on to code.
      const settled = await callTool(ctx({ runId: turn[0].id }), "settle_design", { design_id: d.id, action: "approve" });
      expect(settled.isError, settled.text).toBe(false);
      expect(getRun(app, r.id).status).toBe("queued");
      run(app.db, "update runs set status = 'cancelled' where id in (?, ?)", r.id, turn[0].id);
    } finally {
      app.config.agents.design = { mode: "auto", confirm: "owner" };
    }
  });

  it("goes on to code without the design when the owner says so while it waits", async () => {
    const r = createRun(app, { kind: "code", spaceId: "shop-api", title: "退款", input: { task: "改退款", repos: ["shop-api"], taskMode: true }, parentId: ask.id });
    codeChainFor(app, r);
    const d = createDesign(app, { spaceId: "shop-api", title: "退款", origin: "own", workId: r.id, userId: OWNER });
    submitRevision(app, d.id, { decisions: [{ kind: "remove", title: "删掉页面里的合计", fields: { removes: { brief: "两处合计" }, users: { brief: "只有退款页" }, fallback: { brief: "不涉及" }, cleanup: { brief: "不涉及" } } }] });
    await designStage(app, { run: getRun(app, r.id), task: "改退款", spaces: ["shop-api"], cwd: dir, signal: new AbortController().signal, event: () => {}, pre: null });
    run(app.db, "update runs set status = 'done' where id = ?", r.id);
    const card = listAsks(app, { status: "pending" }).find((a) => a.handler === "design-confirm" && a.runId === r.id)!;
    const res = await callTool(ctx(), "continue_code_run", { run_id: r.id, task: "不等方案了，直接改" });
    expect(res.text).toContain("不再等方案确认");
    expect(getAsk(app, card.id).status).toBe("cancelled");
    expect(getRun(app, r.id)).toMatchObject({ status: "queued" });
    expect(getRun(app, r.id).output.designSkipped).toBeTruthy();
    expect(designForWork(app, r.id)).toBeNull();
    // Started again, it does not write a design: its stage passes straight to coding.
    expect(await designStage(app, { run: getRun(app, r.id), task: "改退款", spaces: ["shop-api"], cwd: dir, signal: new AbortController().signal, event: () => {}, pre: null })).toEqual({ wait: false, design: null });
    run(app.db, "update runs set status = 'cancelled' where id = ?", r.id);
  });
});

describe("a branch review against a design", () => {
  const app = testApp();
  const dir = mkdtempSync(join(tmpdir(), "omem-design-branch-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", env });
  const commit = (files: Record<string, string | null>, message: string) => {
    for (const [f, text] of Object.entries(files)) text === null ? unlinkSync(join(dir, f)) : writeFileSync(join(dir, f), text);
    git("add", "-A");
    git("commit", "-q", "-m", message);
  };
  git("init", "-q", "-b", "main");
  commit({ "refund.ts": "export function refundAmount() {\n  return 0;\n}\n", "legacy.ts": "export const old = 1;\n" }, "init");
  git("checkout", "-q", "-b", "feature/refund");
  commit({ "refund.ts": "export function refundAmount(lines: Line[]) {\n  return shippedOnly(lines).length;\n}\n", "lines.ts": "export function shippedOnly(lines: Line[]) {\n  return lines.filter((l) => !l.shipped);\n}\n", "legacy.ts": null }, "只退未发货的行");
  git("checkout", "-q", "main");
  createSpace(app, { id: "shop-api", name: "订单服务", kind: "repo", rootPath: dir });
  app.config.agents.profiles.push({ id: "fake", name: "fake", transport: "acp", command: process.execPath, args: [resolve("test/fake-acp-agent.ts")], env: { FAKE_MODE: "review" }, idleTimeoutMs: 60000 });
  app.config.agents.default = "fake";
  app.config.review = {
    tiers: [{ id: "standard", name: "标准", guide: "", when: null, checks: ["review-business"], maxRounds: 2, lead: true, confirmPlan: false }],
    rereviewAllEvery: 2,
    checks: {},
  };
  const t = createThread(app, { channel: "web", spaceId: "shop-api", userId: OWNER });
  const ask = createRun(app, { kind: "ask", spaceId: "shop-api", title: "评审", input: { conversationId: t.id } });
  const ctx: ToolContext = { app, runId: ask.id, spaceId: "shop-api", spaces: ["shop-api", "personal"], tools: null, actor: "agent", userId: OWNER };
  const exec = (id: string) => {
    run(app.db, "update runs set status = 'running' where id = ?", id);
    return __testHandlers.get("code")!({ app, run: getRun(app, id), signal: new AbortController().signal, event: (type, data) => addRunEvent(app, id, type, data), output: (data) => setRunOutput(app, id, data) });
  };

  it("puts the branch's files under the decisions without rewriting the design, reviews by decision, and the lead says what came of each", async () => {
    const d = createDesign(app, { spaceId: "shop-api", title: "小王的退款方案", origin: "external", author: "小王", repos: ["shop-api"], userId: OWNER });
    submitRevision(app, d.id, { decisions: [{ kind: "change", title: "退款只算未发货的行", concerns: [{ level: "problem", text: "对账读的是落库前的金额" }] }, { kind: "add", title: "退款记录可导出" }] });
    const server = await startServer(app, { port: 0, quiet: true });
    try {
      const res = await callTool(ctx, "review_branch", { repo_spaces: ["shop-api"], branch: "feature/refund", task: "对照小王的方案评审", fetch: false, design_id: d.id });
      expect(res.isError, res.text).toBe(false);
      expect(res.text).toContain(`对照方案 ${d.id}`);
      const r = getRun(app, /运行 (r\w+)/.exec(res.text)![1]);
      expect(r.input.designId).toBe(d.id);
      expect(getDesign(app, d.id).workId).toBe(r.id);
      await exec(r.id);
      run(app.db, "update runs set status = 'done' where id = ?", r.id);

      const after = getDesign(app, d.id);
      // Only where the code landed was written: same version, same text.
      expect(after.revision).toBe(1);
      expect(after.body.decisions.map((x) => x.title)).toEqual(["退款只算未发货的行", "退款记录可导出"]);
      expect(after.body.decisions[0].files).toEqual(["shop-api/refund.ts", "shop-api/lines.ts"]);
      expect(after.body.decisions[1].files).toBeUndefined();
      expect(after.body.outside).toEqual(["shop-api/legacy.ts"]);
      const said = JSON.stringify(runEvents(app, r.id).map((e) => e.data));
      expect(said).toContain("不在这次的改动里");
      // The business finding names its decision; the lead's ruling says what came of it and of the concern.
      expect(all<{ d: string | null }>(app.db, "select f.design_decision d from review_findings f join reviews v on v.id = f.review_id where v.code_run_id = ? and f.title = '已发货行不能退'", r.id)).toEqual([{ d: "D1" }]);
      expect(after.body.decisions[0].after).toMatchObject({ done: "partly", deviation: "金额在网关里又算了一遍", by: "review-lead" });
      expect(after.body.decisions[0].concerns?.[0]).toMatchObject({ id: "C1", state: "resolved", note: "分支改了对账" });

      // Counted on the review's diff; the decision's patch is its files only.
      const { changes, outside } = await designChanges(app, after);
      expect(changes[0].files.map((f) => [f.path, f.add > 0])).toEqual([["refund.ts", true], ["lines.ts", true]]);
      expect(changes[0].findings.total).toBe(1);
      expect(outside).toEqual([expect.objectContaining({ space: "shop-api", path: "legacy.ts", add: 0, del: 1 })]);
      const diff = await designDiff(app, after, "D1");
      expect(diff.patches).toHaveLength(1);
      expect(diff.patches[0].patch).toContain("shippedOnly");
      expect(diff.patches[0].patch).not.toContain("legacy.ts");
      // Both ends of the review's diff come along, so an editor can show the two sides of each file.
      const { fileAt, workPatches } = await import("../src/agents/code-tasks.ts");
      const { worktreesOf } = await import("../src/agents/code.ts");
      expect(diff.patches[0].from).toMatch(/^[0-9a-f]{40}$/);
      expect(diff.patches[0].to).toMatch(/^[0-9a-f]{40}$/);
      expect(fileAt(app, worktreesOf(app, r.id), "shop-api", "refund.ts", diff.patches[0].to!)!.toString()).toContain("shippedOnly");
      expect(fileAt(app, worktreesOf(app, r.id), "shop-api", "refund.ts", diff.patches[0].from!)?.toString() ?? "").not.toContain("shippedOnly");
      // The whole of a branch review's change: the branch against its base.
      const [whole] = await workPatches(app, r.id, worktreesOf(app, r.id), { work: true });
      expect(whole).toMatchObject({ space: "shop-api", from: diff.patches[0].from, to: diff.patches[0].to });
      expect(whole.patch).toContain("legacy.ts");
      expect((await designDiff(app, after, "outside")).patches[0].patch).toContain("legacy.ts");
      expect((await designDiff(app, after, "D2")).patches).toEqual([]);
    } finally {
      await server.close();
    }
  }, 120000);

  it("keeps the requirement's change points as its split when there is no design to hold the branch against", async () => {
    const res = await callTool(ctx, "review_branch", { repo_spaces: ["shop-api"], branch: "feature/refund", task: "评审退款分支", fetch: false });
    const r = getRun(app, /运行 (r\w+)/.exec(res.text)![1]);
    expect(res.text).not.toContain("对照方案");
    expect(designForWork(app, r.id)).toBeNull();
    expect(all(app.db, "select id from designs where work_id = ?", r.id)).toEqual([]);
  });
});
