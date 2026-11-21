import { startServer } from "../src/server/http.ts";
import { stagePlugin } from "./flow-plugin-fixture.ts";
import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { testApp } from "./helpers.ts";
import { forgetPlugin, loadPlugins, reloadPlugin, setPluginEnabled, trustPlugin } from "../src/plugins/registry.ts";
import { parseFlow, parseFlowForSave, summarizeStage, runnerApproved, saveFlow } from "../src/flows/definitions.ts";
import { flowView, ownerAction, startFlow, reportStage, updateStageBudget, recordStage } from "../src/flows/engine.ts";
import { checkPluginSignals } from "../src/flows/plugin-signals.ts";
import { checkGitSignals } from "../src/flows/signals.ts";
import { proposeFlow } from "../src/flows/engine.ts";
import { answerAsk, getAsk } from "../src/agents/asks.ts";
import { getRun, setRunOutput } from "../src/agents/runs.ts";
import { runPluginStage } from "../src/flows/plugin-runner.ts";
import { all, run } from "../src/core/db.ts";
import { upsertSource } from "../src/sources/store.ts";
import { mergeSources } from "../src/sources/duplicates.ts";
import { createSpace } from "../src/core/spaces.ts";
import { addMember, createApiToken, createUser } from "../src/core/users.ts";
import { callTool } from "../src/agents/tools.ts";
import { upsertItem } from "../src/items/store.ts";
import { gateSettingsForFlow, saveGateChecks } from "../src/flows/plugin-gates.ts";

describe.each(["isolated", "inprocess"] as const)("流程插件 %s", mode => {
  const app = testApp();
  const dir = join(app.home, "plugins", "stagekit");
  const owner = { actor: "owner", userId: "owner" };
  const raw = (stages: unknown[]) => JSON.stringify({ id: "inspect", name: "检查", stages });
  const signalStage = (fail: unknown) => ({ id: "mark", name: "检查标记", by: "wait", done: { signal: "stagekit:mark", with: { fail } } });
  async function begin(stages: unknown[], spaceId = "personal") {
    const f = parseFlow(raw(stages));
    if (f.stages.some(s => typeof s.by === "object" && "runner" in s.by)) {
      const ask = proposeFlow(app, raw(stages), owner);
      await answerAsk(app, ask.id, { choice: 0, by: "owner" });
    } else saveFlow(app, raw(stages), "owner");
    const item = upsertItem(app, undefined, { title: "检查事项", spaceId }, "user");
    await startFlow(app, item.id, "inspect", owner);
    return item.id;
  }
  beforeAll(async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "plugin.yaml"), "id: stagekit\nname: 阶段示例\npermissions:\n  flow: { signal: true, run: true, gate: true }\n");
    writeFileSync(join(dir, "server.mjs"), stagePlugin);
    const data = join(app.home, "plugin-data", "stagekit");
    mkdirSync(data, {recursive:true});
    if (mode === "inprocess") vi.stubEnv("OMEM_PLUGIN_DATA", data);
    await loadPlugins(app, [{ dir: join(app.home, "plugins"), source: "data" }]);
    await trustPlugin(app, "stagekit", mode);
  });
  afterAll(() => { forgetPlugin("stagekit"); app.events.emit("close"); app.db.close(); vi.unstubAllEnvs(); });
  it("停用运行器后通过 HTTP 改阶段名，草稿保留到本人启用新定义", async () => {
    const server = await startServer(app, { port: 0, quiet: true });
    const yaml = raw([{ id: "job", name: "原阶段名", by: { runner: "stagekit:job", with: { fail: false } } }]);
    const put = (yaml: string) => server.inject({ method: "PUT", url: "/api/flows/inspect", payload: { yaml } });
    const answer = (id: string) => server.inject({ method: "POST", url: `/api/asks/${id}/answer`, payload: { choice: 0 } });
    try {
      const initial = await put(yaml);
      expect(initial.statusCode).toBe(200);
      expect(initial.json().askId).toEqual(expect.any(String));
      expect((await answer(initial.json().askId)).statusCode).toBe(200);
      await setPluginEnabled(app, "stagekit", false);

      const changed = JSON.parse(yaml);
      changed.stages[0].name = "新阶段名";
      const saved = await put(JSON.stringify(changed));
      expect(saved.statusCode).toBe(200);
      const askId = saved.json().askId;
      expect(askId).toEqual(expect.any(String));
      const listed = (await server.inject("/api/flows")).json();
      expect(listed.drafts).toContainEqual(expect.objectContaining({ askId, id: "inspect", replaces: true }));
      expect(listed.flows.find((f: { id: string }) => f.id === "inspect").definition.stages[0].name).toBe("原阶段名");

      const enabled = await answer(askId);
      expect(enabled.statusCode).toBe(200);
      expect(enabled.json()).toMatchObject({ status: "answered", choice: 0 });
      const updated = (await server.inject("/api/flows")).json();
      expect(updated.drafts.some((d: { askId: string }) => d.askId === askId)).toBe(false);
      expect(updated.flows.find((f: { id: string }) => f.id === "inspect").definition.stages[0]).toMatchObject({
        name: "新阶段名", by: { runner: "stagekit:job", with: { fail: false } },
      });
      changed.stages[0].by.with.fail = true;
      const rejected = await put(JSON.stringify(changed));
      expect(rejected.statusCode).toBe(400);
      expect(rejected.json().error).toContain("未注册流程能力");
    } finally { await server.close(); await setPluginEnabled(app, "stagekit", true); }
  });
  it("停用后保留同阶段信号、运行器和检查，变更引用仍需注册", async () => {
    const initial = raw([signalStage(true), {id:"job",name:"作业",by:{runner:"stagekit:job",with:{fail:false}}}]);
    expect(parseFlow(initial).stages.map(summarizeStage)).toMatchObject([
      {done:{kind:"signal",id:"stagekit:mark",name:"标记",params:{fail:true}}},
      {carrier:{kind:"runner",id:"stagekit:job",name:"作业",params:{fail:false}}}
    ]);
    saveFlow(app, initial, "owner", true);
    saveGateChecks(app,"inspect",[{id:"stagekit:word",mandatory:true}]);
    const changed = JSON.parse(initial);
    changed.stages[0].name = "改过名称";
    const server = await startServer(app, {port:0,quiet:true});
    await setPluginEnabled(app,"stagekit",false);
    try {
      const response = await server.inject({method:"POST",url:"/api/flows/validate",payload:{yaml:JSON.stringify(changed)}});
      expect(response.json()).toMatchObject({ok:true,unavailableChecks:[{id:"stagekit:word",reason:"检查已停用"}],unavailableReferences:[
        {kind:"signal",stage:"mark",id:"stagekit:mark"}, {kind:"runner",stage:"job",id:"stagekit:job"}
      ]});
      expect(parseFlowForSave(app,JSON.stringify(changed)).stages[0].name).toBe("改过名称");
      saveFlow(app,JSON.stringify(changed),"owner",true);
      expect(saveGateChecks(app,"inspect",[{id:"stagekit:word",mandatory:true}])).toHaveLength(1);
      expect(gateSettingsForFlow(app,"inspect").unavailableChecks).toEqual([{id:"stagekit:word",reason:"检查已停用"}]);
      expect(() => saveGateChecks(app,"inspect",[{id:"stagekit:word",mandatory:false}])).toThrow("检查不可用");
      for (const change of [
        (f: typeof changed) => {f.stages[0].done.with.fail=false;},
        (f: typeof changed) => {f.stages[1].by.with.fail=true;},
        (f: typeof changed) => {f.stages[0].id="new-stage";},
        (f: typeof changed) => {f.stages.push({id:"new",name:"新阶段",by:"wait",done:{signal:"stagekit:mark"}});},
      ]) {
        const next=structuredClone(changed); change(next);
        const rejected = (await server.inject({method:"POST",url:"/api/flows/validate",payload:{yaml:JSON.stringify(next)}})).json();
        expect(rejected).toMatchObject({ok:false,problem:expect.stringContaining("未注册流程能力")});
        expect(() => saveFlow(app,JSON.stringify(next),"owner",true)).toThrow("未注册流程能力");
      }
    } finally { await server.close(); await setPluginEnabled(app,"stagekit",true); saveGateChecks(app,"inspect",[]); }
    const invalid = JSON.parse(initial); invalid.stages[0].done.with.fail="错";
    expect(() => parseFlowForSave(app,JSON.stringify(invalid))).toThrow("with");
  });
  it("校验参数，将信号和可打开的证据落到当前阶段", async () => {
    expect(() => parseFlow(raw([signalStage("错")]))).toThrow("with");
    const id = await begin([signalStage(false)]);
    await vi.waitFor(() => expect(flowView(app, id).stages[0]).toMatchObject({state:"done",pluginEvidence:[{text:"检查单",link:"https://example.org/check"}]}));
  });
  it("失败后退避，停用后可以手动完成", async () => {
    const id = await begin([signalStage(true)]);
    await vi.waitFor(() => expect(flowView(app, id).stages[0].waitingSignal).toMatchObject({id:"stagekit:mark",name:"标记",failures:1,note:expect.stringContaining("问不到")}));
    await checkGitSignals(app);
    expect(all(app.db, "select id from flow_signals where item_id=?", id)).toHaveLength(1);
    await setPluginEnabled(app, "stagekit", false);
    expect(flowView(app, id).stages[0].waitingSignal?.note).toContain("没人能判断");
    expect(flowView(app,id).stages[0].waitingSignal).toMatchObject({id:"stagekit:mark",name:"stagekit:mark"});
    await ownerAction(app, id, "mark", "done", "已人工核对");
    expect(flowView(app, id).stages[0].state).toBe("done");
    await setPluginEnabled(app, "stagekit", true);
  });
  it("多个慢插件信号并发有界，Git 巡检仍可独立结束", async () => {
    const stages = Array.from({length:7},(_,i) => ({id:"slow"+i,name:"慢检查",by:"wait",needs:[],done:{signal:"stagekit:delayed"}}));
    const previousLimit = app.config.flows.autoAdvance;
    app.config.flows.autoAdvance = 20;
    const id = await begin([...stages,{id:"push",name:"等待推送",by:"wait",needs:[],done:{signal:"git.pushed"}}]);
    const data = join(app.home,"plugin-data","stagekit");
    try {
      await vi.waitFor(() => expect(readdirSync(data).filter(n => n.endsWith(".asked"))).toHaveLength(3));
      const git = checkGitSignals(app);
      await vi.waitFor(async () => {
        expect(flowView(app,id).stages.at(-1)?.waitingSignal?.checkedAt).toEqual(expect.any(String));
      });
      await git;
      expect(readdirSync(data).filter(n => n.endsWith(".asked"))).toHaveLength(3);
    } finally { app.config.flows.autoAdvance = previousLimit; writeFileSync(join(data,"release"),"ready"); }
    await vi.waitFor(() => expect(all(app.db,"select id from flow_signals where item_id=? and type='stagekit:delayed'",id).length).toBeGreaterThanOrEqual(3));
  });
  it("批次尾部的正常信号留待下一批检查，保留完整超时且不记失败", async () => {
    const data = join(app.home,"plugin-data","stagekit"), release = join(data,"release");
    writeFileSync(release,"ready");
    const rows: {item_id:string;stage_id:string}[] = [];
    for (let i = 0; i < 4; i++) {
      const stage = "batch"+i;
      const item = await begin([{id:stage,name:"等待标记",by:"wait",done:{signal:"stagekit:delayed"}}]);
      await vi.waitFor(() => expect(flowView(app,item).stages[0].waitingSignal?.checkedAt).toBeTruthy());
      rows.push({item_id:item,stage_id:stage});
      unlinkSync(join(data,stage+".asked"));
    }
    // Make the four initial observations due together for the patrol.
    for (const row of rows) run(app.db,"delete from flow_signals where item_id=?",row.item_id);
    unlinkSync(release);
    const batch = checkPluginSignals(app,rows);
    const asked = () => rows.filter(r => existsSync(join(data,r.stage_id+".asked")));
    try {
      await vi.waitFor(() => expect(asked()).toHaveLength(3));
      await new Promise(resolve => setTimeout(resolve,3500));
    } finally { writeFileSync(release,"ready"); }
    await batch;
    expect(asked()).toHaveLength(3);
    const next = rows.find(r => !existsSync(join(data,r.stage_id+".asked")))!;
    expect(flowView(app,next.item_id).stages[0].waitingSignal).toMatchObject({checkedAt:null,failures:0});
    await checkPluginSignals(app,rows);
    expect(asked()).toHaveLength(4);
    for (const row of rows) expect(flowView(app,row.item_id).stages[0].waitingSignal).toMatchObject({
      checkedAt:expect.any(String),failures:0,note:"待确认",
    });
  });
  const job = (fail = false) => ({ id: "job", name: "运行作业", by: { runner: "stagekit:job", with: { fail } }, budget: { minutes: 10 } });
  it.each(["http", "save_flow"] as const)("%s 只接受本人提交流程，确认卡答复后才启用运行器", async entry => {
    const id = entry === "http" ? "runner-http" : "runner-tool";
    const yaml = JSON.stringify({ id, name: "流程授权", stages: [job()] });
    const definition = parseFlow(yaml);
    const member = createUser(app, { id: id + "-member", name: "普通成员" }).id;
    const headers = (user: string) => ({ authorization: "Bearer " + createApiToken(app, user, "流程验证") });
    const memberHeaders = headers(member), ownerHeaders = headers("owner");
    const server = await (await import("../src/server/http.ts")).startServer(app, { host: "127.0.0.1", port: 0, quiet: true });
    const catalog = async () => (await server.inject({ url: "/api/flows", headers: ownerHeaders })).json();
    const put = (headers: typeof ownerHeaders) => server.inject({ method: "PUT", url: "/api/flows/" + id, headers, payload: { yaml } });
    const tool = (userId: string) => callTool({ app, userId, actor: "agent", tools: new Set(["save_flow"]),
      spaceId: userId === "owner" ? "personal" : "personal-" + userId, spaces: null, runId: null }, "save_flow", { yaml });
    try {
      if (entry === "http") expect((await put(memberHeaders)).statusCode).toBe(403);
      else expect(await tool(member)).toMatchObject({ isError: true, deniedCapability: "owner" });
      expect((await catalog()).drafts).not.toContainEqual(expect.objectContaining({ id }));
      if (entry === "http") {
        const response = await put(ownerHeaders);
        expect(response.statusCode).toBe(200);
        expect(response.json().askId).toEqual(expect.any(String));
      } else expect(await tool("owner")).toMatchObject({ isError: false, text: expect.stringContaining("等本人确认") });
      const { drafts, flows } = await catalog();
      expect(flows).not.toContainEqual(expect.objectContaining({ id }));
      const draft = drafts.find((d: { id: string }) => d.id === id);
      const card = "/api/asks/" + draft.askId;
      expect((await server.inject({ url: card, headers: ownerHeaders })).json().question)
        .toContain("运行作业：这个阶段会由插件 stagekit:job 执行：写入标记");
      const answer = (headers: typeof ownerHeaders) => server.inject({ method: "POST", url: card + "/answer", headers, payload: { choice: 0 } });
      expect((await answer(memberHeaders)).statusCode).toBe(404);
      expect(runnerApproved(app, definition)).toBe(false);
      expect((await answer(ownerHeaders)).statusCode).toBe(200);
      expect((await catalog()).flows).toContainEqual(expect.objectContaining({ id, definition }));
      expect(runnerApproved(app, definition)).toBe(true);
    } finally { await server.close(); }
  });
  it("按已有授权开始的运行器只记一次自动开始", async () => {
    const stages = [{...job(), gate:"confirm"}];
    saveFlow(app, raw(stages), "owner", true);
    run(app.db, "insert into flow_gate_grants(flow_id,stage_id,user_id,granted_at,updated_at) values('inspect','job','owner',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)");
    const item = await begin(stages);
    expect(flowView(app,item).stages[0]).toMatchObject({state:"doing",autoStarted:true,attempt:1,carrier:{runner:{id:"stagekit:job",name:"作业"}}});
    expect(all(app.db,"select id from item_stage_log where item_id=? and event='granted-start'",item)).toHaveLength(1);
  });
  async function tick(item: string) {
    const id = flowView(app, item).stages[0].by!;
    return runPluginStage({ app, run: getRun(app,id), signal: new AbortController().signal,
      output: value => setRunOutput(app,id,value), event: () => {} });
  }
  it("批准新版和调整事项预算后，旧事项仍可进入运行器并续查", async () => {
    const stages = [{id:"first",name:"准备",by:"wait"}, {...job(),needs:["first"]}];
    const item = await begin(stages);
    saveFlow(app, raw([job(true)]), "owner", true);
    await ownerAction(app,item,"first","done","准备好了");
    const id = flowView(app,item).stages[1].by!;
    const ctx = { app, run:getRun(app,id), signal:new AbortController().signal,
      output:(data:Record<string, unknown>) => setRunOutput(app,id,data), event:() => {} };
    await expect(runPluginStage(ctx)).rejects.toThrow("下一次检查");
    await updateStageBudget(app,item,"job",{budget:{minutes:20}},"owner");
    await runPluginStage(ctx);
    expect(flowView(app,item).stages[1]).toMatchObject({state:"done",by:id});
  });
  it("期限到后取消，插件失败也停在当前阶段", async () => {
    const item = await begin([job()]);
    await expect(tick(item)).rejects.toThrow("下一次检查");
    run(app.db,"update item_stages set entered_at='2000-01-01' where item_id=?",item);
    await expect(tick(item)).rejects.toThrow("时限");
    const stage = flowView(app,item).stages[0];
    expect(stage.state).toBe("blocked");
    expect(existsSync(join(app.home,"plugin-data","stagekit",stage.by!+".cancel"))).toBe(true);
    const failed = await begin([job(true)]);
    await expect(tick(failed)).rejects.toThrow("作业结果");
    expect(flowView(app,failed).stages[0].state).toBe("blocked");
  });
  it("检查默认不启用，拦下结果后只有本人能单次越过", async () => {
    const item = await begin([{id:"mark",name:"人工检查",by:"wait"}]);
    saveGateChecks(app,"inspect",[{id:"stagekit:word",mandatory:true}]);
    await ownerAction(app,item,"mark","done","检查完成");
    const s = flowView(app,item).stages[0];
    expect(s).toMatchObject({state:"blocked",gateReview:{failed:[{id:"stagekit:word",reason:"缺少已验证"}]}});
    expect(s.pluginEvidence).toContainEqual({text:"验收要求",link:"https://example.org/rule"});
    await ownerAction(app,item,"mark","done","已验证");
    expect(flowView(app,item).stages[0]).toMatchObject({state:"done",pluginEvidence:[]});
    const blocked = await begin([{id:"mark",name:"人工检查",by:"wait"}]);
    await ownerAction(app,blocked,"mark","done","检查完成");
    const card = flowView(app,blocked).stages[0].askId!;
    await expect(answerAsk(app,card,{choice:0,by:"member"})).rejects.toThrow();
    await answerAsk(app,card,{choice:0,by:"owner"});
    expect(flowView(app,blocked).stages[0].state).toBe("done");
    expect(all<{note:string}>(app.db,"select note from item_stage_log where item_id=?",blocked).some(v => v.note.includes("越过检查 stagekit:word"))).toBe(true);
    const again = await begin([{id:"mark",name:"人工检查",by:"wait"}]);
    await ownerAction(app,again,"mark","done","检查完成");
    expect(flowView(app,again).stages[0].state).toBe("blocked");
    saveGateChecks(app,"inspect",[]);
  });
  it("事项查看者直接读取检查卡等待与两种答复，只有本人能回答", async () => {
    createSpace(app,{id:"gate-shared",name:"共享项目"});
    const item=await begin([{id:"mark",name:"人工检查",by:"wait"}],"gate-shared");
    saveGateChecks(app,"inspect",[{id:"stagekit:word",mandatory:true}]);
    await ownerAction(app,item,"mark","done","检查完成");
    createUser(app,{id:"gate-reader",name:"查看成员",role:"observer"});
    addMember(app,"gate-shared","gate-reader","reader");
    const server=await startServer(app,{port:0,quiet:true});
    const headers={authorization:`Bearer ${createApiToken(app,"gate-reader","test")}`};
    const read=async () => { const r=await server.inject({url:`/api/items/${item}/flow`,headers}); expect(r.statusCode).toBe(200); return r.json().stages[0]; };
    try {
      const stage=await read(), card=stage.askId;
      expect(stage.gateReview.ask).toEqual({id:card,status:"pending",choice:null,answeredAt:null});
      expect((await server.inject({method:"POST",url:`/api/asks/${card}/answer`,payload:{choice:0},headers})).statusCode).toBe(403);
      await answerAsk(app,card,{choice:1,by:"owner"});
      expect((await read()).gateReview.ask).toEqual({id:card,status:"answered",choice:"hold",answeredAt:getAsk(app,card).answeredAt});
      await ownerAction(app,item,"mark","done","检查完成");
      const next=(await read()).askId;
      await answerAsk(app,next,{choice:0,by:"owner"});
      expect(await read()).toMatchObject({state:"done",gateReview:{ask:{id:next,status:"answered",choice:"override",answeredAt:getAsk(app,next).answeredAt}}});
      await ownerAction(app,item,"mark","reopen","重新核对");
      expect((await read()).gateReview).toBeUndefined();
    } finally {await server.close();saveGateChecks(app,"inspect",[]);}
  });
  it("全流程启用的检查只覆盖声明的阶段，停用后仍按原范围处理", async () => {
    const first = {id:"first",name:"准备",by:"wait"};
    saveFlow(app, raw([first]), "owner");
    saveGateChecks(app,"inspect",[{id:"stagekit:first",mandatory:true}]);
    const stages = [first,{id:"more",name:"新增",by:"wait",needs:[]}];
    for (const enabled of [true,false]) {
      await setPluginEnabled(app,"stagekit",enabled);
      const id = await begin(stages);
      await ownerAction(app,id,"more","done","新增阶段直接完成");
      expect(flowView(app,id).stages[1].state).toBe("done");
      await ownerAction(app,id,"first","done","准备完毕");
      expect(flowView(app,id).stages[0]).toMatchObject({state:"blocked",gateReview:{failed:[
        {id:"stagekit:first",reason:expect.stringContaining(enabled ? "准备结果" : "问不到")}] }});
    }
    await setPluginEnabled(app,"stagekit",true);
    saveGateChecks(app,"inspect",[]);
  });
  it("检查收窄后随即停用，旧配置和新配置都按最近生效的声明处理", async () => {
    const first = {id:"first",name:"准备",by:"wait"}, more = {id:"more",name:"收尾",by:"wait",needs:[]};
    const checks = [{id:"stagekit:first",mandatory:true}];
    const file = join(dir,"server.mjs");
    const load = async (source:string) => {
      writeFileSync(file,source);
      await reloadPlugin(app,"stagekit");
      await trustPlugin(app,"stagekit",mode);
    };
    try {
      await load(stagePlugin.replace('stages:["first"]','stages:["first","more"]'));
      saveFlow(app,raw([first,more]),"owner");
      saveGateChecks(app,"inspect",checks);
      await load(stagePlugin);
      await setPluginEnabled(app,"stagekit",false);
      // The first format saved no declaration; the next saved a snapshot when enabled.
      for (const check of [checks[0], {...checks[0],scope:{stages:["first","more"],spaces:[]}}]) {
        run(app.db,"update kv set value=? where key='flow-checks:inspect'",JSON.stringify([check]));
        const item = await begin([first,more]);
        await ownerAction(app,item,"more","done","完成收尾");
        expect(flowView(app,item).stages[1].state).toBe("done");
        await ownerAction(app,item,"first","done","完成准备");
        expect(flowView(app,item).stages[0].gateReview?.failed[0].reason).toContain("问不到");
      }
    } finally {
      saveGateChecks(app,"inspect",[]);
      await setPluginEnabled(app,"stagekit",true);
    }
  });
  it("升级前已停用且无范围快照的强制检查等待本人处理", async () => {
    const root = join(app.home,"legacy-plugins"), dir = join(root,"legacygate");
    mkdirSync(dir,{recursive:true});
    writeFileSync(join(dir,"plugin.yaml"),JSON.stringify({id:"legacygate",name:"旧检查",permissions:{flow:{gate:true}},
      spaces:[{id:"personal",name:"个人"}]}));
    writeFileSync(join(dir,"server.mjs"), `export default api => api.stageGate({id:"first",name:"准备检查",describe:"核对准备",
      applies:{stages:["first"]},async review(){return {ok:false,reason:"准备结果需复核"}}})`);
    app.config.plugins.disabled.push("legacygate");
    await loadPlugins(app,[{dir:root,source:"data"}]);
    const check = {id:"legacygate:first",mandatory:true,stages:["first"]};
    const stages = [{id:"first",name:"准备",by:"wait"}, {id:"more",name:"收尾",by:"wait",needs:[]}];
    const item = await begin(stages);
    run(app.db,"insert or replace into kv(key,value) values('flow-checks:inspect',?)",JSON.stringify([check]));
    try {
      expect(gateSettingsForFlow(app,"inspect").pendingCheckScopes).toEqual([{id:check.id,reason:expect.stringContaining("重新加载")}]);
      await ownerAction(app,item,"more","done","完成收尾");
      expect(flowView(app,item).stages[1].state).toBe("done");
      createSpace(app,{id:"outside",name:"其他空间"});
      const outside = upsertItem(app,undefined,{title:"范围外作业",spaceId:"outside"},"user");
      await startFlow(app,outside.id,"inspect",owner);
      await ownerAction(app,outside.id,"first","done","完成准备");
      expect(flowView(app,outside.id).stages[0].state).toBe("done");
      await ownerAction(app,item,"first","done","完成准备");
      expect(flowView(app,item).stages[0]).toMatchObject({state:"blocked",waitingOn:"owner",
        gateReview:{failed:[{id:check.id,reason:expect.stringContaining("适用范围待确认")}]}});
      await trustPlugin(app,"legacygate",mode);
      await setPluginEnabled(app,"legacygate",true);
      expect(gateSettingsForFlow(app,"inspect").pendingCheckScopes).toEqual([]);
      await ownerAction(app,item,"first","done","再次提交");
      expect(flowView(app,item).stages[0].gateReview?.failed[0].reason).toContain("准备结果需复核");
    } finally {
      forgetPlugin("legacygate");
      saveGateChecks(app,"inspect",[]);
    }
  });
  it("补录的跨空间引用只留在事项上，检查只收到同空间原件", async () => {
    createSpace(app,{id:"other",name:"项目 B"});
    const refs = ["personal","other"].map(spaceId => {
      const source = upsertSource(app,{spaceId,kind:"note",title:"检查材料",uri:"note:proof",text:"原始依据"});
      return "src:" + source.id + "#L1-L1";
    });
    const item = await begin([{id:"mark",name:"核对",by:"wait",gate:"confirm"}]);
    saveGateChecks(app,"inspect",[{id:"stagekit:refs",mandatory:true}]);
    await recordStage(app,item,"mark","本人补录",refs);
    const stage = flowView(app,item).stages[0];
    expect(stage.evidence).toEqual(refs);
    expect(JSON.parse(stage.gateReview!.failed[0].reason)).toEqual([{text:refs[0]}]);
    saveGateChecks(app,"inspect",[]);
  });
  it("结构化站内链接解码后只向检查交付同空间且可读的原件", async () => {
    createSpace(app,{id:"proofs",name:"其他材料"});
    const [local,other] = ["personal","proofs"].map(spaceId =>
      upsertSource(app,{spaceId,kind:"note",title:"核对材料",uri:"note:link",text:"依据"}).id);
    const encoded = (id:string) => "%73" + id.slice(1,3) + "%" + id.charCodeAt(3).toString(16) + id.slice(4);
    const { startServer } = await import("../src/server/http.ts");
    const server = await startServer(app,{port:0,quiet:true});
    const sourceUrl = (id:string) => app.baseUrl + "/api/sources/" + encoded(id) + "?from=1&to=1";
    try {
      for (const id of [local,other]) {
        const response = await server.inject({url:new URL(sourceUrl(id)).pathname + "?from=1&to=1"});
        expect(response.statusCode).toBe(200);
        expect(response.json().source.id).toBe(id);
      }
    } finally { await server.close(); }
    const evidence = [
      {text:"可见原件",link:"#/%73ources/" + encoded(local) + "?from=2&to=3"},
      {text:"其他原件",link:"#/sources/" + encoded(other) + "#L2"},
      {text:"其他空间",link:"https://example.org/#/Sources/" + encoded(other)},
      {text:"公开说明",link:"https://example.org/check"},
      {text:"本空间原文行",link:sourceUrl(local)},
      {text:"其他空间原文行",link:sourceUrl(other)},
      {text:"其他空间原件注释",link:"https://reader.example.org/app/api/sources/" + encoded(other) + "/notes"},
      {text:"其他空间原文附本空间锚点",link:"https://reader.example.org/api/sources/" + other + "#/sources/" + local},
      {text:"第三方资料",link:"https://example.org/api/sources/sample"},
      {text:"文字里的原文链接 https://reader.example.org/api/sources/" + encoded(other) + "?from=4"},
      {text:"按原件 ID 定位",link:app.baseUrl + "/api/lookup?id=" + encodeURIComponent("src:" + other + "#L1")},
    ];
    const item = await begin([job()]);
    saveGateChecks(app,"inspect",[{id:"stagekit:refs",mandatory:true}]);
    const runId = flowView(app,item).stages[0].by!;
    await reportStage(app,item,"job",{state:"done",note:"交回依据",evidence:[runId],pluginEvidence:evidence},{actor:"stagekit:job",runId});
    const stage = flowView(app,item).stages[0];
    expect(stage.pluginEvidence).toEqual(evidence);
    expect(JSON.parse(stage.gateReview!.failed[0].reason)).toEqual([evidence[0],evidence[3],evidence[4],evidence[8]]);
    saveGateChecks(app,"inspect",[]);
  });
  it("合并别名和 URI 链接按读取目标裁剪，事项保留原始证据", async () => {
    createSpace(app, { id: "archive", name: "归档空间" });
    const source = (spaceId: string, uri: string) =>
      upsertSource(app, { spaceId, uri, kind: "note", title: "作业记录", text: "核对完成" }).id;
    const local = source("personal", "reports/proof.md"), other = source("archive", "reports/proof.md");
    const localAlias = source("personal", "note:local-copy"), otherAlias = source("personal", "note:moved-copy");
    mergeSources(app, localAlias, local, "合并副本");
    mergeSources(app, otherAlias, other, "移入归档空间");
    const server = await (await import("../src/server/http.ts")).startServer(app, { port: 0, quiet: true });
    try {
      const refs = [
        { path: "/api/sources/" + localAlias, target: local },
        { path: "/api/sources/" + otherAlias, target: other },
        { path: "/api/sources/resolve?space=personal&uri=.%2Freports%2Fproof.md", target: local },
        { path: "/api/sources/resolve?uri=proof.md&space=archive", target: other },
      ];
      for (const { path, target } of refs) {
        const response = await server.inject(path);
        expect(response.statusCode).toBe(200);
        expect(response.json().source?.id ?? response.json().id).toBe(target);
      }
      const evidence = refs.map(({ path }) => ({ text: "原件", link: app.baseUrl + path }));
      evidence.push({ text: "合并前的引用", link: "src:" + localAlias + "#L1" },
        { text: "归档前的引用", link: "#/sources/" + otherAlias });
      const item = await begin([job()]);
      saveGateChecks(app, "inspect", [{ id: "stagekit:refs", mandatory: true }]);
      const runId = flowView(app, item).stages[0].by!;
      await reportStage(app, item, "job", { state: "done", note: "交回记录", evidence: [runId], pluginEvidence: evidence },
        { actor: "stagekit:job", runId });
      const stage = flowView(app, item).stages[0];
      expect(stage.pluginEvidence).toEqual(evidence);
      expect(JSON.parse(stage.gateReview!.failed[0].reason)).toEqual([evidence[0], evidence[2], evidence[4]]);
    } finally {
      saveGateChecks(app, "inspect", []);
      await server.close();
    }
  });
  it("必须的检查超时暂停，非必须的检查超时放行并记下原因", async () => {
    const item = await begin([{id:"mark",name:"人工检查",by:"wait"}]);
    saveGateChecks(app,"inspect",[{id:"stagekit:slow",mandatory:true}]);
    await ownerAction(app,item,"mark","done","已验证");
    expect(flowView(app,item).stages[0]).toMatchObject({state:"blocked",gateReview:{failed:[{id:"stagekit:slow",reason:expect.stringContaining("问不到")}]}});
    saveGateChecks(app,"inspect",[{id:"stagekit:slow",mandatory:false}]);
    const next = await begin([{id:"mark",name:"人工检查",by:"wait"}]);
    await ownerAction(app,next,"mark","done","已验证");
    expect(flowView(app,next).stages[0].state).toBe("done");
    expect(all<{note:string}>(app.db,"select note from item_stage_log where item_id=?",next).some(v => v.note.includes("非强制检查放行"))).toBe(true);
    saveGateChecks(app,"inspect",[]);
  }, 15_000);
  it("结果检查在本人的签字之后，检查通过不提前放行", async () => {
    const item = await begin([{...job(),done:"confirm"}]);
    saveGateChecks(app,"inspect",[{id:"stagekit:word",mandatory:true}]);
    await expect(tick(item)).rejects.toThrow("下一次检查");
    await tick(item);
    const s = flowView(app,item).stages[0];
    expect(s.state).toBe("doing");
    expect(s.gateReview).toBeUndefined();
    await answerAsk(app,s.askId!,{choice:0,by:"owner"});
    expect(flowView(app,item).stages[0].state).toBe("done");
    saveGateChecks(app,"inspect",[]);
  });
  it("上游重开撤回下游的越过卡，后续阶段继续等待", async () => {
    const item = await begin([{id:"first",name:"准备",by:"wait"}, {id:"mark",name:"核对",by:"wait",needs:["first"]},
      {id:"last",name:"收尾",by:"wait",needs:["mark"]}]);
    saveGateChecks(app,"inspect",[{id:"stagekit:word",mandatory:true,stages:["mark"]}]);
    await ownerAction(app,item,"first","done","准备好了");
    await ownerAction(app,item,"mark","done","需要复核");
    const card = flowView(app,item).stages[1].askId!;
    await ownerAction(app,item,"first","reopen","材料已变");
    await expect(answerAsk(app,card,{choice:0,by:"owner"})).rejects.toThrow();
    expect(flowView(app,item).stages.map(s => s.state)).toEqual(["doing","stale","pending"]);
    await ownerAction(app,item,"first","done","已更新");
    expect(flowView(app,item).stages[1]).toMatchObject({state:"doing",gateReview:undefined});
    saveGateChecks(app,"inspect",[]);
  });
  it("上游尚在重做时，已选择继续做的结果可以越过，未答复的结果进入复核", async () => {
    for (const accept of [true,false]) {
      const item = await begin([{id:"first",name:"准备",by:"wait"},job()]);
      saveGateChecks(app,"inspect",[{id:"stagekit:word",mandatory:true,stages:["job"]}]);
      await ownerAction(app,item,"first","done","已准备");
      const runId = flowView(app,item).stages[1].by!;
      await ownerAction(app,item,"first","reopen","修改准备材料");
      const upstream = flowView(app,item).stages[1].upstream!.askId;
      if (accept) await answerAsk(app,upstream,{choice:1,by:"owner"});
      await reportStage(app,item,"job",{state:"done",note:"提交作业",evidence:[runId]},{actor:"stagekit:job",runId});
      if (accept) {
        const card = flowView(app,item).stages[1].askId!;
        expect(all(app.db,"select json_extract(context,'$.completion') as path from asks where id=?",card)).toEqual([{path:"continued"}]);
        await answerAsk(app,card,{choice:0,by:"owner"});
        expect(flowView(app,item).stages.map(s => s.state)).toEqual(["doing","done"]);
      } else {
        expect(flowView(app,item).stages[1]).toMatchObject({state:"stale",gateReview:undefined});
        expect(getAsk(app,upstream).status).toBe("cancelled");
      }
    }
    saveGateChecks(app,"inspect",[]);
  });
  it("可越过乱序补录的检查，上游重开后补录卡失效", async () => {
    const stages = [{id:"first",name:"准备",by:"wait"}, {id:"mark",name:"核对",by:"wait",needs:["first"]}];
    for (const reopen of [false,true]) {
      const item = await begin(stages);
      saveGateChecks(app,"inspect",[{id:"stagekit:word",mandatory:true,stages:["mark"]}]);
      await recordStage(app,item,"mark","提前补录");
      const card = flowView(app,item).stages[1].askId!;
      if (reopen) {
        await ownerAction(app,item,"first","done","第一次准备完成");
        await ownerAction(app,item,"first","reopen","材料变化");
        await ownerAction(app,item,"first","done","第二次准备完成");
        await expect(answerAsk(app,card,{choice:0,by:"owner"})).rejects.toThrow();
        expect(flowView(app,item).stages[1].state).toBe("doing");
      } else {
        await answerAsk(app,card,{choice:0,by:"owner"});
        expect(flowView(app,item).stages.map(s => s.state)).toEqual(["doing","done"]);
      }
    }
    saveGateChecks(app,"inspect",[]);
  });
  it("交回失败后，旧的单次越过卡片失效", async () => {
    const item = await begin([job()]);
    saveGateChecks(app,"inspect",[{id:"stagekit:word",mandatory:true}]);
    const id = flowView(app,item).stages[0].by!;
    await reportStage(app,item,"job",{state:"done",note:"缺少验收词",evidence:[id]},{actor:"stagekit:job",runId:id});
    const ask = flowView(app,item).stages[0].askId!;
    await reportStage(app,item,"job",{state:"blocked",note:"作业失败",waitingOn:"owner"},{actor:"stagekit:job",runId:id});
    await expect(answerAsk(app,ask,{choice:0,by:"owner"})).rejects.toThrow();
    expect(flowView(app,item).stages[0]).toMatchObject({state:"blocked",gateReview:undefined});
    saveGateChecks(app,"inspect",[]);
  });
});
