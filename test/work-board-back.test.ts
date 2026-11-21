import { expect, it, vi } from "vitest";
import { setupBoardPeers } from "./work-board-peer-fixture.ts";
import { addPeer, findPeer, invite } from "../src/core/peers.ts";
import { backState, setServeBack } from "../src/core/peer-back.ts";
import { createApiToken, pairedTokens } from "../src/core/users.ts";
import { all } from "../src/core/db.ts";
import { runPeerCommand } from "../src/core/peer-exec.ts";
import { callTool } from "../src/agents/tools.ts";
import { __testHandlers, getRun, startWorker, stopWorker, waitForRun } from "../src/agents/runs.ts";
import { workCommand } from "../src/agents/work-device.ts";
import { readBoard } from "../src/agents/work-board.ts";

it("直连响应丢失或中断，反向连接延续同一派单、结果、取消与来源限制",async () => {
  const f = await setupBoardPeers();
  f.there.config.concurrency = 3;
  const direct = pairedTokens(f.there)[0].id;
  await addPeer(f.there,invite(f.here,{url:f.here.baseUrl!}).code);
  setServeBack(f.there,"desk",true);
  await vi.waitFor(() => expect(backState(f.here,"lab").incoming?.online).toBe(true),{timeout:10000});
  const peer = findPeer(f.here,"lab")!;
  expect(peer.back!.token === peer.token).toBe(false);
  const dispatch = await callTool(f.ctx,"dispatch_work",{title:"分别核对",tasks:["重发","续查","停止"].map(title =>
    ({title,goal:"核对材料",accept:"给出报告",device:"lab",mode:"remote"}))});
  expect(dispatch.isError,dispatch.text).toBe(false);
  const [retry,query,stop] = readBoard(f.here,f.id).tasks;
  const retryKey = retry.attempts[0].runId, stopKey = stop.attempts[0].runId;
  const directFetch = globalThis.fetch;
  let responseLost = false, disconnected = false;
  vi.spyOn(globalThis,"fetch").mockImplementation(async (url,init) => {
    if (String(url) !== f.there.baseUrl + "/api/peer/exec") return directFetch(url,init);
    if (disconnected) throw new Error("直连已断开");
    const response = await directFetch(url,init);
    const {command,args} = JSON.parse(String(init?.body));
    if (command === "work-accept" && args.key === retryKey && !responseLost) {
      expect(response.ok).toBe(true);
      await response.json();
      responseLost = true;
      throw new Error("接活已成功，响应丢失");
    }
    return response;
  });
  // Hold the three actual worker invocations open while the transport changes.
  const finish = new Map<string,() => void>();
  const handler = __testHandlers.get("peer-work")!;
  const execute = vi.fn<typeof handler>(({run,signal}) => new Promise((resolve,reject) => {
    finish.set(run.id,() => resolve({answer:"原运行的核对报告"}));
    signal.addEventListener("abort",() => reject(new Error("CANCELLED")),{once:true});
  }));
  __testHandlers.set("peer-work",execute);
  try {
    await f.poll();
    expect(responseLost).toBe(true);
    const ids = readBoard(f.here,f.id).tasks.map(t => t.attempts[0].remoteRunId!);
    expect(f.remoteRuns().map(r => r.id).sort()).toEqual([...ids].sort());
    startWorker(f.there);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(3));
    disconnected = true;
    await f.poll();
    expect(readBoard(f.here,f.id).tasks.map(t => t.status)).toEqual(["running","running","running"]);

    const independent = {user:"owner",token:createApiToken(f.there,"owner","peer:independent")};
    await expect(runPeerCommand(f.there,"work-status",{key:stopKey},independent)).rejects.toThrow("没有这次派单");
    await runPeerCommand(f.there,"work-cancel",{key:stopKey},independent);
    expect(getRun(f.there,ids[2]).status).toBe("running");

    f.there.config.node.acceptWorkFrom = {[direct]:"off"};
    const req = {key:stopKey,from:"desk",space:"personal",goal:"核对",accept:"报告",deadline:stop.attempts[0].deadline};
    await expect(workCommand(f.here,"lab","work-info",{target:{space:"personal"},remote:true})).rejects.toThrow("关闭接活");
    await expect(workCommand(f.here,"lab","work-accept",{...req,key:"new-key"})).rejects.toThrow("关闭接活");
    expect((await callTool(f.ctx,"work_cancel",{work_id:f.id,task:stop.id})).isError).toBe(false);
    await f.poll();
    expect((await waitForRun(f.there,ids[2])).status).toBe("cancelled");
    await expect(workCommand(f.here,"lab","work-accept",req)).resolves.toEqual({runId:ids[2]});
    finish.get(ids[0])!(); finish.get(ids[1])!();
    await Promise.all(ids.slice(0,2).map(id => waitForRun(f.there,id)));
    await f.poll();
    const board = readBoard(f.here,f.id);
    expect(board.tasks.map(t => t.attempts[0].remoteRunId)).toEqual(ids);
    for (const task of [retry,query]) expect(board.tasks.find(t => t.id === task.id)).toMatchObject({status:"done",report:"原运行的核对报告"});
    expect(board.tasks[2].status).toBe("cancelled");
    expect(execute).toHaveBeenCalledTimes(3);
    // Only the independent caller's cancellation created a tombstone.
    expect(f.remoteRuns()).toHaveLength(4);
    const local = all<{id:string}>(f.here.db,"select id from runs where status in ('queued','running')");
    await Promise.all(local.map(r => waitForRun(f.here,r.id)));
  } finally {
    stopWorker();
    __testHandlers.set("peer-work",handler);
  }
},60000);
