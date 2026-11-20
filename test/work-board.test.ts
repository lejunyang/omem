import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { boot } from "../src/main.ts";
import { all, run } from "../src/core/db.ts";
import { createUser, createApiToken } from "../src/core/users.ts";
import { createThread, threadMessages } from "../src/agents/threads.ts";
import { __testHandlers, createRun, getRun, stopWorker, waitForRun } from "../src/agents/runs.ts";
import { releaseAll } from "../src/agents/sessions.ts";
import { callTool, type ToolContext } from "../src/agents/tools.ts";
import { maintainBoards, readBoard } from "../src/agents/work-board.ts";
import { saveAgentSpec } from "../src/agents/specs.ts";

describe("协同任务板", async () => {
  const home = mkdtempSync(join(tmpdir(), "omem-board-"));
  writeFileSync(join(home, "config.json"), JSON.stringify({
    interactiveConcurrency: 5,
    agents: { default: "fake", workBoard: { concurrency: 2 }, tiers: { strong: { profile: "fake", model: "m2" } },
      profiles: [{ id: "fake", transport: "acp", model: "m1", command: process.execPath, args: [resolve("test/fake-acp-agent.ts")],
        env: { FAKE_MODE: "board", FAKE_TRAE: "1", FAKE_USAGE: "321" } }] },
  }));
  const { app, server } = await boot(home, { port: 0, quiet: true, background: false });
  afterAll(async () => { stopWorker(); releaseAll(); await server.close(); });
  function origin(): ToolContext & { runId: string } {
    const thread = createThread(app, { spaceId: "personal", channel: "web" });
    const ask = createRun(app, { kind: "ask", spaceId: "personal", title: "核对材料", input: { conversationId: thread.id } });
    return { app, runId: ask.id, spaceId: "personal", spaces: null, tools: null, actor: "agent", userId: "owner" };
  }
  async function dispatch(names: string[], options: { agent?: string; required?: boolean }[] = []) {
    const ctx = origin();
    const tasks = names.map((name,i) => ({ title: name, goal: "材料编号 " + name, accept: "给出原件 " + name, ...options[i] }));
    const result = await callTool(ctx, "dispatch_work", { title: "分别核对材料", tasks });
    expect(result.isError, result.text).toBe(false);
    return { ctx, id: ctx.runId, tasks: readBoard(app, ctx.runId).tasks };
  }
  const coordinates = (id: string) => all<{ id: string }>(app.db,"select id from runs where parent_id=? and kind='ask' order by created_at",id);
  async function wave(id: string, n: number) {
    await vi.waitFor(() => expect(coordinates(id)).toHaveLength(n), { timeout: 45000, interval: 100 });
    const r = await waitForRun(app, coordinates(id)[n-1].id);
    expect(r.error).toBeNull();
    return r;
  }
  it("三块限两路并行，收齐一次协调，详情按发起运行授权", async () => {
    const { id, tasks } = await dispatch(["first","second","third"]);
    const r = await wave(id, 1);
    const board = readBoard(app, id);
    const [a,b,c] = board.tasks.map(t => t.attempts[0]);
    expect(a.startedAt! < b.finishedAt! && b.startedAt! < a.finishedAt!).toBe(true);
    expect(c.startedAt! >= [a.finishedAt!,b.finishedAt!].sort()[0]).toBe(true);
    const message = threadMessages(app,board.workConversationId).find(m => m.meta.board === id)!.text;
    for (const t of tasks) {
      expect(message).toContain("材料报告 " + t.title);
      expect(message).toContain(t.accept);
    }
    expect(r.input.lane ?? r.lane).toBe(board.workConversationId);
    expect(board.tasks.map(t => t.status)).toEqual(["done","done","done"]);
    expect(a).toMatchObject({ used: 321, backend: "fake", ai: { model: "m1" } });
    const get = async (path: string) => (await fetch(app.baseUrl + path)).json();
    expect(await get("/api/agent-work/" + id + "/board")).toMatchObject({ status: "review", askRunId: id });
    expect(await get("/api/runs/" + id)).toMatchObject({ board: { workId: id } });
    expect(await get("/api/runs/" + a.runId)).toMatchObject({ board: { workId: id, taskId: tasks[0].id } });
    createUser(app, { id: "reader", name: "读者" });
    const token = createApiToken(app, "reader", "test");
    expect((await fetch(app.baseUrl + "/api/agent-work/" + id + "/board",{ headers: { authorization: "Bearer " + token } })).status).toBe(404);
  }, 60000);

  it("失败不挡验收，换模型只重做原块，两次后只能接受或阻塞", async () => {
    const { id, ctx, tasks } = await dispatch(["ok","fail"]);
    await wave(id,1);
    const before = readBoard(app,id);
    expect(before.tasks.map(t => t.status)).toEqual(["done","failed"]);
    const failed = before.tasks[1].attempts[0].runId;
    const retry = await fetch(app.baseUrl + "/api/runs/" + failed + "/retry", { method: "POST" });
    expect(retry.status).toBe(409);
    for (const target of [failed, id]) {
      const swap = await callTool(ctx, "switch_run_ai", { run_id: target, execution: { profile: "fake", model: "m2", reason: "核对原件" } });
      expect(swap.text).toContain("work_review");
    }
    const review = (decisions: unknown[]) => callTool(ctx,"work_review",{ work_id: id, decisions });
    const redo = { task: tasks[1].id, decision: "redo", note: "补齐原件", execution: "strong" };
    expect((await review([{ task: tasks[0].id, decision: "accept" },redo])).isError).toBe(false);
    await wave(id,2);
    const after = readBoard(app,id);
    expect(after.tasks[0].attempts).toEqual(before.tasks[0].attempts);
    expect(after.tasks[1]).toMatchObject({ status: "done", report: "材料报告 fail" });
    const second = after.tasks[1].attempts[1];
    expect(second.model).toBe("m2");
    expect(getRun(app,second.runId).input.task).toContain(redo.note);
    expect((await review([redo])).isError).toBe(false);
    await wave(id,3);
    expect((await review([redo])).text).toContain("最多重做 2 次");
    expect((await review([{ task: tasks[1].id, decision: "block", note: "证据有冲突" }])).isError).toBe(false);
    expect(readBoard(app,id).status).toBe("summarized");
    expect(readBoard(app,id).tasks[1].verdict?.note).toBe("证据有冲突");
  }, 90000);

  it("可选块不挡协调，运行超时后标失败，迟到的收尾不再触发协调", async () => {
    const { id,tasks } = await dispatch(["ok","slow"],[{}, { required: false }]);
    await wave(id,1);
    expect(readBoard(app,id).tasks[1].status).toBe("running");
    run(app.db,"update agent_work_tasks set deadline_at=? where id=?","2000-01-01",tasks[1].id);
    maintainBoards(app);
    expect((await waitForRun(app,tasks[1].attempts[0].runId)).status).toBe("cancelled");
    expect(readBoard(app,id).tasks[1]).toMatchObject({ status:"failed", report:"超时" });
    expect(coordinates(id)).toHaveLength(1);
  },60000);

  it("取消整板停止已启动和排队的尝试",async () => {
    const { id,ctx,tasks } = await dispatch(["slow","slow","slow"]);
    expect((await callTool(ctx,"work_cancel",{ work_id:id })).isError).toBe(false);
    await wave(id,1);
    for (const t of tasks) expect((await waitForRun(app,t.attempts[0].runId)).status).toBe("cancelled");
    expect(readBoard(app,id).tasks.every(t => t.status === "cancelled")).toBe(true);
  },60000);

  it("档案的子任务拿不到交办和发消息工具", async () => {
    saveAgentSpec(app,{ name:"material-check",description:"核对材料",prompt:"逐项核对",status:"active",tools:["group:delegate","group:lark-msg","group:ask"] },"user");
    const { id } = await dispatch(["permissions","ok"],[{ agent:"material-check" }]);
    await wave(id,1);
    expect(readBoard(app,id).tasks[0].report).toMatch(/工具核对：\s*材料报告 permissions/);
  },60000);

  it("旧执行者在取消后清理期间仍占板内名额，迟到结果保留在旧尝试", async () => {
    const original = __testHandlers.get("agent")!;
    const limit = app.config.agents.workBoard.concurrency;
    const cleanup = Promise.withResolvers<void>();
    let starts = 0;
    app.config.agents.workBoard.concurrency = 1;
    __testHandlers.set("agent", async ctx => {
      if (starts++ !== 0) return original(ctx);
      await cleanup.promise;
      return { answer: "旧尝试的报告" };
    });
    try {
      const { id, ctx, tasks } = await dispatch(["first","second"]);
      await vi.waitFor(() => expect(starts).toBe(1));
      expect((await callTool(ctx, "work_cancel", { work_id: id })).isError).toBe(false);
      await wave(id, 1);
      expect((await callTool(ctx, "work_review", { work_id: id, decisions: [{ task: tasks[0].id, decision: "redo" }] })).isError).toBe(false);
      expect(starts).toBe(1);
      const retryId = readBoard(app,id).tasks[0].attempts[1].runId;
      expect(getRun(app,retryId).status).toBe("queued");
      cleanup.resolve();
      await wave(id, 2);
      expect(readBoard(app,id).tasks[0]).toMatchObject({
        status: "done", report: "材料报告 first", attempts: [{ result: "已取消" }, { result: "材料报告 first" }],
      });
    } finally {
      cleanup.resolve();
      __testHandlers.set("agent", original);
      app.config.agents.workBoard.concurrency = limit;
    }
  },60000);

  it("重启收回失去运行的块，保留排队的块，收齐只协调一次", async () => {
    const limit = app.config.interactiveConcurrency;
    app.config.interactiveConcurrency = 0;
    let id: string;
    try {
      const board = await dispatch(["lost","ok"]);
      id = board.id;
      const t = board.tasks[0];
      run(app.db,"delete from runs where id=?", t.attempts[0].runId);
      run(app.db,"update agent_work_tasks set status='running' where id=?",t.id);
      maintainBoards(app,true);
      expect(readBoard(app,id).tasks[0]).toMatchObject({ status:"failed", report:"服务重启" });
      expect(coordinates(id)).toHaveLength(0);
    } finally { app.config.interactiveConcurrency = limit; }
    await wave(id,1);
    maintainBoards(app,true);
    expect(coordinates(id)).toHaveLength(1);
  },60000);
});
