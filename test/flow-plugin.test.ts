import { stagePlugin } from "./flow-plugin-fixture.ts";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { testApp } from "./helpers.ts";
import { forgetPlugin, loadPlugins, reloadPlugin, setPluginEnabled, trustPlugin } from "../src/plugins/registry.ts";
import { parseFlow, saveFlow } from "../src/flows/definitions.ts";
import { flowView, ownerAction, startFlow, reportStage, updateStageBudget, recordStage } from "../src/flows/engine.ts";
import { checkGitSignals } from "../src/flows/signals.ts";
import { proposeFlow } from "../src/flows/engine.ts";
import { answerAsk } from "../src/agents/asks.ts";
import { getRun, setRunOutput } from "../src/agents/runs.ts";
import { runPluginStage } from "../src/flows/plugin-runner.ts";
import { all, run } from "../src/core/db.ts";
import { upsertSource } from "../src/sources/store.ts";
import { createSpace } from "../src/core/spaces.ts";
import { upsertItem } from "../src/items/store.ts";
import { saveGateChecks } from "../src/flows/plugin-gates.ts";

describe.each(["isolated", "inprocess"] as const)("流程插件 %s", mode => {
  const app = testApp();
  const dir = join(app.home, "plugins", "stagekit");
  const owner = { actor: "owner", userId: "owner" };
  const raw = (stages: unknown[]) => JSON.stringify({ id: "inspect", name: "检查", stages });
  const signalStage = (fail: unknown) => ({ id: "mark", name: "检查标记", by: "wait", done: { signal: "stagekit:mark", with: { fail } } });
  async function begin(stages: unknown[]) {
    const f = parseFlow(raw(stages));
    if (f.stages.some(s => typeof s.by === "object" && "runner" in s.by)) {
      const ask = proposeFlow(app, raw(stages), { actor: "assistant", userId: "member" });
      expect(ask.question).toContain("这个阶段会由插件");
      await expect(answerAsk(app, ask.id, { choice: 0, by: "member" })).rejects.toThrow();
      await answerAsk(app, ask.id, { choice: 0, by: "owner" });
    } else saveFlow(app, raw(stages), "owner");
    const item = upsertItem(app, undefined, { title: "检查事项", spaceId: "personal" }, "user");
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
  it("校验参数，将信号和可打开的证据落到当前阶段", async () => {
    expect(() => parseFlow(raw([signalStage("错")]))).toThrow("with");
    const id = await begin([signalStage(false)]);
    await vi.waitFor(() => expect(flowView(app, id).stages[0]).toMatchObject({state:"done",pluginEvidence:[{text:"检查单",link:"https://example.org/check"}]}));
  });
  it("失败后退避，停用后可以手动完成", async () => {
    const id = await begin([signalStage(true)]);
    await vi.waitFor(() => expect(flowView(app, id).stages[0].waitingSignal).toMatchObject({failures:1,note:expect.stringContaining("问不到")}));
    await checkGitSignals(app);
    expect(all(app.db, "select id from flow_signals where item_id=?", id)).toHaveLength(1);
    await setPluginEnabled(app, "stagekit", false);
    expect(flowView(app, id).stages[0].waitingSignal?.note).toContain("没人能判断");
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
  const job = (fail = false) => ({ id: "job", name: "运行作业", by: { runner: "stagekit:job", with: { fail } }, budget: { minutes: 10 } });
  it("按已有授权开始的运行器只记一次自动开始", async () => {
    const stages = [{...job(), gate:"confirm"}];
    saveFlow(app, raw(stages), "owner", true);
    run(app.db, "insert into flow_gate_grants(flow_id,stage_id,user_id,granted_at,updated_at) values('inspect','job','owner',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)");
    const item = await begin(stages);
    expect(flowView(app,item).stages[0]).toMatchObject({state:"doing",autoStarted:true,attempt:1});
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
