import { rmSync } from "node:fs";
import { resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, expect, vi } from "vitest";
import { testApp } from "./helpers.ts";
import type { App } from "../src/core/app.ts";
import { all, run } from "../src/core/db.ts";
import { now } from "../src/core/util.ts";
import { addPeer, invite } from "../src/core/peers.ts";
import { saveConfig } from "../src/core/config.ts";
import { startServer } from "../src/server/http.ts";
import { createThread } from "../src/agents/threads.ts";
import { callTool, type ToolContext } from "../src/agents/tools.ts";
import { createRun, setRunOutput, addRunEvent } from "../src/agents/runs.ts";
import { readBoard, pollBoardPeers } from "../src/agents/work-board.ts";
import { closeAcpServing } from "../src/core/peer-acp.ts";
import { releaseAll } from "../src/agents/sessions.ts";

const apps: App[] = [], servers: FastifyInstance[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); releaseAll(); closeAcpServing();
  for (const s of servers.splice(0)) await s.close();
  for (const a of apps.splice(0)) { a.events.emit("close"); a.db.close(); rmSync(a.home,{recursive:true,force:true}); }
});
export async function setupBoardPeers() {
  const here = testApp(), there = testApp(); apps.push(here,there);
  here.config.node.id = "desk"; there.config.node.id = "lab";
  there.config.node.acceptWork = "read";
  for (const a of [here,there]) {
    a.config.agents.default = "fake";
    a.config.agents.profiles = [{ id:"fake", transport:"acp", command:process.execPath,args:[resolve("test/fake-acp-agent.ts")],env:{FAKE_MODE:"device-work",OMEM_ARTIFACTS:""},idleTimeoutMs:60000 }];
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
