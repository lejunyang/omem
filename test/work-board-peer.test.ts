import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import { testApp } from "./helpers.ts";
import type { App } from "../src/core/app.ts";
import { all, one, run } from "../src/core/db.ts";
import { now } from "../src/core/util.ts";
import { addPeer, invite, savePeers, listPeers } from "../src/core/peers.ts";
import { createApiToken, createUser } from "../src/core/users.ts";
import { createSpace } from "../src/core/spaces.ts";
import { saveConfig } from "../src/core/config.ts";
import { startServer } from "../src/server/http.ts";
import { importText } from "../src/sources/import.ts";
import { listMemories } from "../src/memory/store.ts";
import { createThread } from "../src/agents/threads.ts";
import { callTool, type ToolContext } from "../src/agents/tools.ts";
import { __testHandlers, createRun, getRun, setRunOutput, addRunEvent } from "../src/agents/runs.ts";
import { readBoard, pollBoardPeers, maintainBoards } from "../src/agents/work-board.ts";
import { runRole } from "../src/agents/runner.ts";
import { artifactInbox, artifactsByIds, collectInbox } from "../src/agents/artifacts.ts";
import { runProgress } from "../src/agents/progress.ts";
import { workProgressView } from "../src/channels/lark-work-progress.ts";
import { refreshWork } from "../src/agents/agent-work.ts";
import { selectDevice, workCommand, workDevices } from "../src/agents/work-device.ts";
import { closeAcpServing } from "../src/core/peer-acp.ts";
import { releaseAll } from "../src/agents/sessions.ts";
import { PEER_LOST_MS } from "../src/studies/remote.ts";
import { MAX_EVIDENCE_FILE } from "../src/studies/remote-host.ts";

const apps: App[] = [], servers: FastifyInstance[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); releaseAll(); closeAcpServing();
  for (const s of servers.splice(0)) await s.close();
  for (const a of apps.splice(0)) { a.events.emit("close"); a.db.close(); rmSync(a.home,{recursive:true,force:true}); }
});
async function setup() {
  const here = testApp(), there = testApp(); apps.push(here,there);
  here.config.node.id = "desk"; there.config.node.id = "lab";
  there.config.node.acceptWork = "read";
  for (const a of [here,there]) {
    a.config.agents.default = "fake";
    a.config.agents.profiles = [{ id:"fake", transport:"acp", command:process.execPath,args:[resolve("test/fake-acp-agent.ts")],env:{FAKE_MODE:"device-work"},idleTimeoutMs:60000 }];
    servers.push(await startServer(a,{port:0,quiet:true}));
    saveConfig(a.config,a.home);
  }
  await addPeer(here,invite(there,{url:there.baseUrl!,label:"desk"}).code);
  const thread = createThread(here,{spaceId:"personal",channel:"web"});
  const origin = createRun(here,{kind:"ask",spaceId:"personal",title:"核对材料",input:{conversationId:thread.id}});
  const ctx: ToolContext = {app:here,runId:origin.id,userId:"owner",actor:"agent",spaceId:"personal",spaces:null,tools:null};
  const dispatch = async (mode = "remote", extra = {}) => {
    const result = await callTool(ctx,"dispatch_work",{title:"设备材料核对",tasks:[
      {title:"设备调查",goal:"读设备材料",accept:"给出证据",device:"lab",mode,execution:{profile:"fake",source:"user",reason:"假后端验证"},...extra},
      {title:"辅助核对",goal:"读另一份",accept:"给出行号",required:false},
    ]});
    expect(result.isError,result.text).toBe(false);
    return readBoard(here,origin.id).tasks[0];
  };
  const poll = async () => { run(here.db,"update board_peer_polls set next_at=?",now()); await pollBoardPeers(here); };
  const remoteRuns = () => all<{id:string}>(there.db,"select id from runs where kind='peer-work' order by rowid");
  const complete = async (id:string, answer = "核对报告 [依据](src:remote-source#L1-L2)") => {
    run(there.db,"update runs set status='done',started_at=?,finished_at=?,ai=? where id=?",now(),now(),JSON.stringify({profile:"fake",model:"small"}),id);
    setRunOutput(there,id,{answer}); addRunEvent(there,id,"usage",{input:100,output:20,cached:10});
  };
  return {here,there,ctx,id:origin.id,dispatch,poll,remoteRuns,complete};
}
it("remote 起在对方，用对方的库、只读工具和目录；产物、用量、设备进度回本机",async () => {
  const f = await setup(); importText(f.there,"personal",{title:"设备材料",text:"设备材料：项目 A 的检查安排。"});
  const t = await f.dispatch("remote",{agent:"missing-profile"}); await f.poll();
  const id = f.remoteRuns()[0].id;
  run(f.there.db,"update runs set status='running',started_at=? where id=?",now(),id);
  const out = await __testHandlers.get("peer-work")!({app:f.there,run:getRun(f.there,id),signal:new AbortController().signal,event:(type,data)=>addRunEvent(f.there,id,type,data),output:d=>setRunOutput(f.there,id,d)});
  const answer = (out as {answer:string}).answer;
  expect(answer).toContain("设备材料"); expect(answer).toContain('"writeDenied":true');
  expect(listMemories(f.there,{})).toHaveLength(0);
  await f.complete(id,answer); await f.poll();
  const task = readBoard(f.here,f.id).tasks[0];
  expect(task.status).toBe("done");
  expect(task.attempts[0]).toMatchObject({device:"lab",deviceName:"lab",mode:"remote",key:t.attempts[0].runId,remoteRunId:id,used:120});
  expect(task.attempts[0].remoteUrl).toContain(id);
  expect(all(f.here.db,"select id from run_artifacts where run_id=?",t.attempts[0].runId)).toHaveLength(1);
  const progress = runProgress(f.here,f.id,{user:"owner"});
  expect(progress[0].usage).toMatchObject({input:100,output:20,cached:10});
},60000);
it("remote 要写时两边授权且对方开启，工具层允许范围内记忆写入",async () => {
  const f = await setup(); f.there.config.node.acceptWork = "write";
  await f.dispatch("remote",{access:"write"}); await f.poll(); const id = f.remoteRuns()[0].id;
  const out = await __testHandlers.get("peer-work")!({app:f.there,run:getRun(f.there,id),signal:new AbortController().signal,event:(type,data)=>addRunEvent(f.there,id,type,data),output:d=>setRunOutput(f.there,id,d)});
  expect((out as {answer:string}).answer).toContain('"writeDenied":false');
  expect(listMemories(f.there,{})).toHaveLength(1); expect(listMemories(f.here,{})).toHaveLength(0);
},60000);
it("borrow 借对方假 ACP 后端，在本机读库并记录设备，写入被拒",async () => {
  const f = await setup(); importText(f.here,"personal",{title:"设备材料",text:"设备材料只存在本机。"});
  const t = await f.dispatch("borrow"); const id = t.attempts[0].runId;
  const result = await runRole(f.here,{role:"assistant",borrow:{device:"lab",backend:"fake"},boardAccess:"read",spaceId:"personal",spaces:["personal"],runId:id,task:"读设备材料",requiredTools:["read_source"]});
  expect(result.text).toContain("只存在本机"); expect(result.text).toContain('"writeDenied":true');
  run(f.here.db,"update runs set status='done',started_at=?,finished_at=?,ai=? where id=?",now(),now(),JSON.stringify(result.ai),id);
  setRunOutput(f.here,id,{answer:result.text});
  const { settleBoardRun } = await import("../src/agents/work-board.ts"); settleBoardRun(f.here,getRun(f.here,id));
  expect(readBoard(f.here,f.id).tasks[0].status).toBe("done");
  expect(f.remoteRuns()).toHaveLength(0); expect(readBoard(f.here,f.id).tasks[0].attempts[0]).toMatchObject({device:"lab",mode:"borrow"});
},60000);
it("未开启接活、空间缺失、非映射成员、未配对及旧协议均明确拒绝",async () => {
  const f = await setup(); f.there.config.node.acceptWork = "off";
  await expect(selectDevice(f.here,{device:"lab",mode:"remote"},"owner","personal")).rejects.toThrow("关闭接活");
  await expect(selectDevice(f.here,{device:"lab",mode:"borrow"},"owner","personal")).resolves.toMatchObject({mode:"borrow"});
  f.there.config.node.acceptWork = "read";
  await expect(selectDevice(f.here,{device:"lab",mode:"remote",access:"write"},"owner","personal")).rejects.toThrow("只接只读");
  await expect(selectDevice(f.here,{device:"lab",mode:"remote"},"owner","missing")).rejects.toThrow();
  await expect(selectDevice(f.here,{device:"lab",mode:"remote"},"reader","personal")).rejects.toThrow("未映射");
  await expect(selectDevice(f.here,{device:"unknown"},"owner","personal")).rejects.toThrow("未配对");
  createUser(f.there,{id:"reader",name:"读者"});
  const peers = listPeers(f.here);
  savePeers(f.here,[{...peers[0],token:createApiToken(f.there,"reader","peer:reader")}]);
  await expect(selectDevice(f.here,{device:"lab",mode:"remote"},"owner","personal")).rejects.toThrow();
  savePeers(f.here,peers);
  const info = await workDevices(f.here,"owner"); expect(info[0]).toMatchObject({device:"lab",version:1});
  expect(JSON.stringify(info)).not.toContain("设备材料：");
  const spy = vi.spyOn(globalThis,"fetch").mockResolvedValue(new Response(JSON.stringify({result:{version:0}}),{status:200}));
  await expect(selectDevice(f.here,{device:"lab"},"owner","personal")).rejects.toThrow("版本不兼容"); spy.mockRestore();
});
it("同一尝试重发不重复起运行；先取消的键永远作废",async () => {
  const f = await setup(); const t = await f.dispatch(); await f.poll();
  const local = getRun(f.here,t.attempts[0].runId);
  const args = {key:local.id,from:"desk",space:"personal",goal:String(local.input.task),accept:t.accept,deadline:t.attempts[0].deadline};
  const first = await workCommand(f.here,"lab","work-accept",args); const second = await workCommand(f.here,"lab","work-accept",args);
  expect(second).toEqual(first); expect(f.remoteRuns()).toHaveLength(1);
  await workCommand(f.here,"lab","work-cancel",{key:"cancel-before-send"});
  const cancelled = await workCommand<{runId:string}>(f.here,"lab","work-accept",{...args,key:"cancel-before-send"});
  expect(getRun(f.there,cancelled.runId).status).toBe("cancelled");
});
it("期限到了失败，可换设备重派；旧结果只记迟到，整组取消传到对方",async () => {
  const f = await setup(); const t = await f.dispatch(); await f.poll(); const old = f.remoteRuns()[0].id;
  run(f.here.db,"update agent_work_tasks set deadline_at=? where id=?",new Date(Date.now()-1000).toISOString(),t.id);
  maintainBoards(f.here,true); expect(readBoard(f.here,f.id).tasks[0].status).toBe("failed");
  const result = await callTool(f.ctx,"work_review",{work_id:f.id,decisions:[{task:t.id,decision:"redo",note:"补证据",device:"lab",mode:"remote"}]});
  expect(result.isError,result.text).toBe(false);
  await f.complete(old,"过期报告"); await f.poll();
  const task = readBoard(f.here,f.id).tasks[0]; expect(task.attempts[0].lateAt).toBeTruthy(); expect(task.report).not.toBe("过期报告");
  expect(f.remoteRuns()).toHaveLength(2);
  await callTool(f.ctx,"work_cancel",{work_id:f.id}); await f.poll();
  expect(getRun(f.there,f.remoteRuns()[1].id).status).toBe("cancelled");
});
it("短时失联保留尝试，恢复继续；失联超过一小时失败且不覆盖重派",async () => {
  const f = await setup(); const t = await f.dispatch(); await f.poll(); const id = f.remoteRuns()[0].id;
  const fetch = vi.spyOn(globalThis,"fetch").mockRejectedValue(new Error("offline")); await f.poll();
  expect(readBoard(f.here,f.id).tasks[0].status).not.toBe("failed"); fetch.mockRestore();
  await f.complete(id); await f.poll(); expect(readBoard(f.here,f.id).tasks[0].report).toContain("在 lab 上");
  const redo = await callTool(f.ctx,"work_review",{work_id:f.id,decisions:[{task:t.id,decision:"redo",note:"重试"}]}); expect(redo.isError,redo.text).toBe(false);
  await f.poll();
  run(f.here.db,"update board_peer_polls set seen_at=?",new Date(Date.now()-PEER_LOST_MS-1000).toISOString());
  vi.spyOn(globalThis,"fetch").mockRejectedValue(new Error("offline")); await f.poll();
  expect(readBoard(f.here,f.id).tasks[0]).toMatchObject({status:"failed",report:expect.stringContaining("失联超过一小时")});
});
it("设备尝试共享任务板并发上限，远端运行跨本机重启继续，卡片列明设备",async () => {
  const f = await setup(); f.here.config.agents.workBoard.concurrency = 1;
  await f.dispatch(); const board = readBoard(f.here,f.id);
  run(f.here.db,"update runs set status='running' where id=?",board.tasks[1].attempts[0].runId);
  await f.poll(); expect(f.remoteRuns()).toHaveLength(0);
  run(f.here.db,"update runs set status='done' where id=?",board.tasks[1].attempts[0].runId);
  await f.poll(); expect(f.remoteRuns()).toHaveLength(1);
  maintainBoards(f.here,true); expect(readBoard(f.here,f.id).tasks[0].status).not.toBe("failed");
});
it("大文本证据限量返回，二进制超限留在对方并给出运行地址",async () => {
  const f = await setup(); const t = await f.dispatch(); await f.poll(); const id = f.remoteRuns()[0].id;
  const inbox = artifactInbox(f.there,id); mkdirSync(inbox,{recursive:true});
  writeFileSync(join(inbox,"长报告.txt"),"x".repeat(MAX_EVIDENCE_FILE+100));
  writeFileSync(join(inbox,"大截图.png"),Buffer.alloc(MAX_EVIDENCE_FILE+100));
  await collectInbox(f.there,id,{source:"agent",by:"test"}); await f.complete(id); await f.poll();
  expect(readBoard(f.here,f.id).tasks[0].report).toContain("在 lab 上看");
  expect(all(f.here.db,"select id from run_artifacts where run_id=?",t.attempts[0].runId)).toHaveLength(1);
});
