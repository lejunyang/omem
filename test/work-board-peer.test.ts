import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import { setupBoardPeers as setup } from "./work-board-peer-fixture.ts";
import type { App } from "../src/core/app.ts";
import { all, run } from "../src/core/db.ts";
import { now } from "../src/core/util.ts";
import { savePeers, listPeers } from "../src/core/peers.ts";
import { createApiToken, createUser, pairedTokens } from "../src/core/users.ts";
import { createSpace, updateSpace } from "../src/core/spaces.ts";
import { importText } from "../src/sources/import.ts";
import { moveSource } from "../src/sources/archive.ts";
import { getSource, upsertSource } from "../src/sources/store.ts";
import { organizeSkills } from "../src/agents/agent-skills.ts";
import { listMemories } from "../src/memory/store.ts";
import { callTool } from "../src/agents/tools.ts";
import { __testHandlers, getRun, setRunOutput, addRunEvent, startWorker, stopWorker, waitForRun, trackAbort } from "../src/agents/runs.ts";
import { readBoard, maintainBoards } from "../src/agents/work-board.ts";
import { saveMcpServer } from "../src/agents/mcp-servers.ts";
import { saveAgentSpec, saveSkill } from "../src/agents/specs.ts";
import { artifactInbox, collectInbox } from "../src/agents/artifacts.ts";
import { runProgress } from "../src/agents/progress.ts";
import { workProgressView } from "../src/channels/lark-work-progress.ts";
import { clearRiskCache } from "../src/channels/lark-cli-tools.ts";
import { setLarkCliForTests } from "../src/channels/lark-cli.ts";
import { persistChatMessages } from "../src/channels/lark-messages.ts";
import { refreshWork } from "../src/agents/agent-work.ts";
import { selectDevice, workCommand, workDevices } from "../src/agents/work-device.ts";
import { PEER_LOST_MS } from "../src/studies/remote.ts";
import { MAX_EVIDENCE_FILE } from "../src/studies/remote-host.ts";

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
  expect(progress[0].tasks[0].attempts[0]).toMatchObject({device:"lab",mode:"remote",remoteRunId:id});
  expect(progress[0].usage).toMatchObject({input:100,output:20,cached:10});
  const [peer] = listPeers(f.here);
  savePeers(f.here, [{ ...peer, back: { name: "实验设备", token: "fixture", since: now() } }]);
  expect(readBoard(f.here,f.id).tasks[0].attempts[0]).toMatchObject({ device: "lab", deviceName: "实验设备" });
  const [board] = runProgress(f.here,f.id,{user:"owner"});
  expect(board.tasks[0]).toMatchObject({
    href: "#/runs/" + t.attempts[0].runId,
    who: { local: false, device: "实验设备", mode: "remote" },
    attempts: [{ local: false, device: "实验设备", remoteRunId: id }],
  });
  const redo = await callTool(f.ctx,"work_review",{work_id:f.id,decisions:[{task:t.id,decision:"redo",note:"补证据"}]});
  expect(redo.isError,redo.text).toBe(false);
  expect(readBoard(f.here,f.id).tasks[0].attempts[1]).toMatchObject({ device: "lab", mode: "remote" });
},60000);
it("remote 要写时两边授权且对方开启，工具层允许范围内记忆写入",async () => {
  const f = await setup(); f.there.config.node.acceptWork = "write";
  await f.dispatch("remote",{access:"write"}); await f.poll(); const id = f.remoteRuns()[0].id;
  const out = await __testHandlers.get("peer-work")!({app:f.there,run:getRun(f.there,id),signal:new AbortController().signal,event:(type,data)=>addRunEvent(f.there,id,type,data),output:d=>setRunOutput(f.there,id,d)});
  expect((out as {answer:string}).answer).toContain('"writeDenied":false');
  expect(listMemories(f.there,{})).toHaveLength(1); expect(listMemories(f.here,{})).toHaveLength(0);
},60000);
it.each(["read","write"])("remote %s 使用接活设备的技能和认证只读 MCP，拒绝外部写和越界写",async access => {
  const f = await setup();
  f.there.config.node.acceptWork = "write";
  f.there.config.agents.profiles[0].env.FAKE_MODE = "device-platform";
  createSpace(f.there,{id:"other",name:"其他材料"});
  saveSkill(f.there,{name:"report-guide",description:"查报告",body:"按签收日期核对报告。"},"user");
  for (const name of ["project-guide", "global-guide", "other-guide"]) {
    saveSkill(f.there, { name, description: name, body: "核对材料", files: { "references/check.md": "核对签收记录" } }, "user");
  }
  updateSpace(f.there, "other", { settings: { skills: ["report-guide", "other-guide"] } });
  updateSpace(f.there, "personal", { settings: { skills: ["project-guide"] } });
  organizeSkills(f.there, { skills: [
    { name: "project-guide", group: "guides" }, { name: "other-guide", group: "guides" },
  ] });
  const command = {command:process.execPath,args:[resolve("test/fixture-mcp-server.ts")]};
  saveMcpServer(f.there,"reports",{...command,readOnly:true,secrets:{REPORT_KEY:"fixture-reader"}});
  saveMcpServer(f.there,"writer",command);
  saveAgentSpec(f.there,{name:"report-reader",description:"查平台报告",prompt:"核对签收日期",skills:["report-guide"],
    tools:["read_source","lark_read","lark_write","remember"],mcpServers:["reports","writer"]},"user");
  const saved = importText(f.there, "personal", { title: "上期清单", text: "项目 A 已签收" });
  const moved = importText(f.there, "personal", { title: "归档清单", text: "归档条目" });
  writeFileSync(join(f.there.filesDir, "pending.txt"), "项目 A 本期清单");
  persistChatMessages(f.there, {
    chatId: "oc_reports", spaceId: "personal", name: "项目 A",
    messages: [{ message_id: "om_reports", msg_type: "post", content: "两期清单", create_time: String(Date.now()) }],
    resources: new Map([["om_reports", {
      file_moved: { type: "file", name: "归档清单.txt", sourceId: moved.id },
      file_saved: { type: "file", name: "上期.txt", sourceId: saved.id },
      file_pending: { type: "file", name: "本期.txt", file: "pending.txt" },
    }]]),
  });
  const archived = moveSource(f.there, moved.id, "other", "只归档附件");
  const resources = () => all(f.there.db, "select resources from lark_messages where message_id='om_reports'");
  const before = resources();
  await f.dispatch("remote",{agent:"report-reader",access}); await f.poll();
  const id = f.remoteRuns()[0].id;
  const result = await __testHandlers.get("peer-work")!({app:f.there,run:getRun(f.there,id),signal:new AbortController().signal,
    event:(type,data)=>addRunEvent(f.there,id,type,data),output:data=>setRunOutput(f.there,id,data)});
  await f.complete(id,(result as {answer:string}).answer); await f.poll();
  const report = JSON.parse(readBoard(f.here,f.id).tasks[0].report);
  expect(report).toMatchObject({externalWriteDenied:true,outsideDenied:true,writer:false,platformRead:true});
  expect(report.report[0].text).toBe("项目 A 平台报告已签收");
  expect(report.skill[0].text).toContain("按签收日期核对报告");
  expect(report.catalog).toEqual({ global: true, hidden: false, group: true });
  expect(report.group).toEqual({ mounted: true, hidden: false });
  expect(report.hub).toEqual({ mounted: true, hidden: false });
  expect(report.hiddenBodyDenied).toBe(true);
  expect(report.hiddenFileDenied).toBe(true);
  expect(report.projectFile).toContain("核对签收记录");
  expect(report.movedDenied).toBe(true);
  expect(report.moved[0].text).toContain("不在本次任务能读的空间");
  expect(report.moved[0].text).not.toContain(moved.id);
  expect(report.moved[0].text).not.toContain("归档清单");
  expect(getSource(f.there, moved.id)).toEqual(archived);
  expect(report.saved[0].text).toContain(`src:${saved.id}`);
  expect(report.pendingDenied).toBe(true);
  expect(report.pending[0].text).toContain("附件尚未存为原件");
  expect(resources()).toEqual(before);
  expect(all(f.there.db, "select id from sources where uri like 'lark:oc_reports/om_reports/%'")).toHaveLength(0);
  expect(listMemories(f.there,{})).toHaveLength(0);
},60000);
it.each(["read", "write"])("remote %s 按已归档目标的当前空间读取飞书文档和群消息", async access => {
  const f = await setup();
  f.there.config.node.acceptWork = "write";
  createSpace(f.there, { id: "other", name: "其他材料" });
  const origin = "https://tenant.larkoffice.com";
  const doc = (id: string) => origin + "/docx/" + id;
  for (const id of ["Current", "Archived"]) {
    const source = upsertSource(f.there, { spaceId: "personal", kind: "doc", uri: id === "Current" ? origin + "/wiki/CurrentNode" : doc(id), title: id, text: "文档快照", meta: { documentId: id } });
    if (id === "Archived") moveSource(f.there, source.id, "other", "归档文档");
  }
  for (const id of ["current", "archived"]) {
    const chatId = "oc_" + id;
    persistChatMessages(f.there, { chatId, spaceId: "personal", name: id, messages: [
      { message_id: "om_" + id, msg_type: "text", content: "归档消息", create_time: String(Date.now()) },
      { message_id: "om_second_" + id, msg_type: "text", content: "另一条消息", create_time: String(Date.now() + 1) },
    ] });
    if (id === "archived") {
      const [source] = all<{ id: string }>(f.there.db, "select id from sources where uri=?", "lark:" + chatId);
      moveSource(f.there, source.id, "other", "归档群消息");
    }
  }
  for (const [spaceId, suffix] of [["personal", ""], ["other", "@2025-01"]]) {
    upsertSource(f.there, { spaceId, kind: "chat", uri: "lark:oc_split" + suffix, title: "分月归档", text: "归档内容" });
  }
  upsertSource(f.there, { spaceId: "personal", kind: "chat", uri: "lark:oc_month@2025-01", title: "单月材料", text: "归档内容" });
  const fetchDoc = (id: string) => ({ name: "lark_doc_fetch", arguments: { doc: doc(id) } });
  const cli = (...command: string[]) => ({ name: "lark_read", arguments: { command } });
  const chat = (id: string) => cli("im", "+chat-messages-list", "--chat-id", id);
  const messages = (ids: string) => cli("im", "+messages-mget", "--message-ids", ids);
  const allowed = [fetchDoc("Current"), cli("docs", "+fetch", "--doc", doc("Current") + "?from=share"),
    chat("oc_current"), messages("om_current,om_second_current")];
  const refused = [fetchDoc("Archived"), fetchDoc("Unknown"), cli("docs", "+fetch", "--doc", doc("Archived")),
    chat("oc_archived"), chat("oc_unknown"), chat("oc_split"), chat("oc_month"), messages("om_archived"), messages("om_current,om_archived"),
    messages("om_current,om_unknown"), cli("im", "+messages-search", "--query", "项目"),
    cli("im", "+chat-messages-list", "--chat-id=oc_current", "--chat-id=oc_archived"),
    cli("im", "+messages-resources-download", "--message-id", "om_unknown", "--file-key", "file_pending")];
  saveAgentSpec(f.there, { name: "reader", description: "核对材料", prompt: "读取飞书材料", tools: ["lark_read", "lark_doc_fetch", "read_source"] }, "user");
  Object.assign(f.there.config.agents.profiles[0].env, { FAKE_MODE: "device-lark", FAKE_LARK_READS: JSON.stringify([...allowed, ...refused]) });
  const liveReads: string[][] = [];
  clearRiskCache();
  setLarkCliForTests(async args => {
    if (args.includes("--help")) return "Risk: read";
    liveReads.push(args);
    return args[0] === "docs" ? { data: { document: { content: "飞书文档现文" } } } : { data: { content: "飞书群消息现文" } };
  });
  onTestFinished(() => { setLarkCliForTests(null); clearRiskCache(); });
  await f.dispatch("remote", { agent: "reader", access });
  await f.poll();
  const id = f.remoteRuns()[0].id;
  const out = await __testHandlers.get("peer-work")!({ app: f.there, run: getRun(f.there, id), signal: new AbortController().signal,
    event: (type, data) => addRunEvent(f.there, id, type, data), output: data => setRunOutput(f.there, id, data) });
  await f.complete(id, (out as { answer: string }).answer);
  await f.poll();
  const results = JSON.parse(readBoard(f.here, f.id).tasks[0].report) as { denied: boolean; content: { text: string }[] }[];
  expect(results.map(r => r.denied)).toEqual([...allowed.map(() => false), ...refused.map(() => true)]);
  for (const [i, r] of results.slice(0, allowed.length).entries()) expect(r.content[0].text).toContain(i < 2 ? "飞书文档现文" : "飞书群消息现文");
  for (const r of results.slice(allowed.length)) expect(r.content[0].text).toMatch(/任务能读的空间|无法确定本次飞书读取的范围/);
  const targets = liveReads.map(args => {
    const flag = args.findIndex(a => ["--doc", "--chat-id", "--message-ids"].includes(a));
    return [args[1], args[flag + 1]];
  });
  expect(targets).toEqual([["+fetch", doc("Current")], ["+fetch", doc("Current")],
    ["+chat-messages-list", "oc_current"], ["+messages-mget", "om_current,om_second_current"]]);
  for (const args of liveReads) expect(args).toEqual(expect.arrayContaining(["--as", "user"]));
}, 60000);

it.each(["local","borrow"])("远端独有档案退回 %s 时，排队前选用本机主助手并执行",async target => {
  const f = await setup();
  saveAgentSpec(f.there,{name:"peer-reader",description:"核对材料",prompt:"核对设备材料",tools:["search","read_source"]},"user");
  importText(f.here,"personal",{title:"设备材料",text:"设备材料只存在本机。"});
  const t = await f.dispatch("remote",{agent:"peer-reader"}); await f.poll();
  const remoteId = f.remoteRuns()[0].id;
  async function handle(app: App,id: string) {
    const r = getRun(app,id);
    const result = await __testHandlers.get(r.kind)!({app,run:r,signal:new AbortController().signal,
      event:(type,data)=>addRunEvent(app,id,type,data),output:data=>setRunOutput(app,id,data)});
    return (result as {answer:string}).answer;
  }
  await f.complete(remoteId,await handle(f.there,remoteId)); await f.poll();
  const redo = await callTool(f.ctx,"work_review",{work_id:f.id,decisions:[{task:t.id,decision:"redo",note:"核对本机材料",
    ...(target === "local" ? {device:"local"} : {mode:"borrow"})}]});
  expect(redo.isError,redo.text).toBe(false);
  const attempts = readBoard(f.here,f.id).tasks[0].attempts;
  expect(attempts.map(a => a.agent)).toEqual(["peer-reader","assistant"]);
  expect(attempts[1]).toMatchObject({device:target === "local" ? "desk" : "lab", status:"queued"});
  expect(await handle(f.here,attempts[1].runId)).toContain("只存在本机");
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
  await expect(selectDevice(f.here,{device:"lab"},"owner","personal")).rejects.toThrow("版本不兼容");
  spy.mockResolvedValue(new Response(JSON.stringify({result:{version:1}}),{status:200}));
  await expect(selectDevice(f.here,{device:"lab",mode:"remote"},"owner","personal")).rejects.toThrow("版本不兼容");
  spy.mockRestore();
});
it("单改全局接活档位保留设备 ID 和禁用来源，显式移除覆盖后继承全局",async () => {
  const f = await setup();
  const pair = pairedTokens(f.there)[0].id;
  f.there.config.node.acceptWorkFrom = { [pair]: "off" };
  const put = (node: object) => fetch(f.there.baseUrl + "/api/settings",{method:"PUT",
    headers:{"content-type":"application/json"},body:JSON.stringify({node})});
  const global = await put({acceptWork:"write"});
  expect(global.status).toBe(200);
  expect((await global.json()).config.node).toEqual({id:"lab",acceptWork:"write",acceptWorkFrom:{[pair]:"off"}});
  const req = {key:"policy-check",from:"desk",space:"personal",access:"write",goal:"记录核对结果",accept:"给出依据",
    deadline:new Date(Date.now()+60000).toISOString()};
  await expect(workCommand(f.here,"lab","work-accept",req)).rejects.toThrow("关闭接活");
  expect(f.remoteRuns()).toHaveLength(0);
  expect((await put({acceptWorkFrom:{}})).status).toBe(200);
  await expect(workCommand(f.here,"lab","work-accept",req)).resolves.toHaveProperty("runId");
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
it("运行页停止当前远端尝试，断线重连后发出取消，迟到结果只记在旧尝试",async () => {
  const f = await setup();
  const t = await f.dispatch(); await f.poll();
  const localId = t.attempts[0].runId, remoteId = f.remoteRuns()[0].id;
  run(f.there.db,"update runs set status='running',started_at=? where id=?",now(),remoteId);
  await f.poll();
  expect(readBoard(f.here,f.id).tasks[0].status).toBe("running");
  const controller = new AbortController(), release = trackAbort(remoteId,controller);
  try {
    const response = await fetch(f.here.baseUrl + "/api/runs/" + localId + "/cancel",{ method:"POST" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({status:"cancelled"});
    expect(readBoard(f.here,f.id).tasks[0]).toMatchObject({status:"cancelled",report:"已取消"});
    const offline = vi.spyOn(globalThis,"fetch").mockRejectedValue(new Error("offline"));
    await f.poll(); offline.mockRestore();
    await f.poll(); expect(controller.signal.aborted).toBe(true);
    await f.complete(remoteId,"停止后到达的报告"); await f.poll();
    const stopped = readBoard(f.here,f.id).tasks[0];
    expect(stopped).toMatchObject({status:"cancelled",report:"已取消"});
    expect(stopped.attempts[0].lateAt).toBeTruthy();
    expect(getRun(f.here,localId).output.answer).toBeUndefined();
  } finally { release(); }
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
  expect(workProgressView(f.here,refreshWork(f.here,f.id)!).lines.join("\n")).toContain("lab（在对方跑）");
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

it("borrow 派单由 worker 认领，在本机只读并交报告，只排一次协调",async () => {
  const f = await setup();
  // Only the borrowed ACP reads the tool bridge. The local fake handles the other block and coordination.
  f.here.config.agents.profiles[0].env.FAKE_MODE = "board";
  importText(f.here,"personal",{title:"设备材料",text:"设备材料只存在本机。"});
  const t = await f.dispatch("borrow");
  startWorker(f.here);
  try {
    const attempt = await waitForRun(f.here,t.attempts[0].runId);
    expect(attempt.status,attempt.error ?? "").toBe("done");
    const board = readBoard(f.here,f.id);
    await waitForRun(f.here,board.tasks[1].attempts[0].runId);
    const coordinators = () => all<{id:string}>(f.here.db,"select id from runs where parent_id=? and kind='ask'",f.id);
    expect(coordinators()).toHaveLength(1);
    const review = await waitForRun(f.here,coordinators()[0].id);
    expect(review.status,review.error ?? "").toBe("done");
    expect(coordinators()).toHaveLength(1);
    expect(board.tasks[0]).toMatchObject({status:"done",attempts:[{device:"lab",mode:"borrow",backend:"peer:lab:fake",status:"done"}]});
    expect(board.tasks[0].report).toContain("只存在本机");
    expect(board.tasks[0].report).toContain('"writeDenied":true');
    expect(listMemories(f.here,{})).toHaveLength(0);
    expect(f.remoteRuns()).toHaveLength(0);
  } finally { stopWorker(); }
},60000);
