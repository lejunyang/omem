import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { testApp } from "./helpers.ts";
import { forgetPlugin, loadPlugins, setPluginEnabled, trustPlugin } from "../src/plugins/registry.ts";
import { parseFlow, saveFlow } from "../src/flows/definitions.ts";
import { flowView, ownerAction, startFlow } from "../src/flows/engine.ts";
import { checkGitSignals } from "../src/flows/signals.ts";
import { proposeFlow } from "../src/flows/engine.ts";
import { answerAsk } from "../src/agents/asks.ts";
import { getRun, setRunOutput } from "../src/agents/runs.ts";
import { runPluginStage } from "../src/flows/plugin-runner.ts";
import { all, run } from "../src/core/db.ts";
import { upsertItem } from "../src/items/store.ts";

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
    writeFileSync(join(dir, "plugin.yaml"), "id: stagekit\nname: 阶段示例\npermissions:\n  flow: { signal: true, run: true }\n");
    writeFileSync(join(dir, "server.mjs"), `import { existsSync, writeFileSync } from "node:fs";
      import { join } from "node:path";
      const data = process.env.OMEM_PLUGIN_DATA;
      export default function(api) {
      api.stageRunner({ id:"job", name:"作业", describe:"写入标记", async start(ctx) {
        const ref = ctx.idempotencyKey, path = join(data,ref);
        if (!existsSync(path)) writeFileSync(path,ref,{flag:"wx"});
        return {ref,status:ctx.with.fail ? "failed" : "running",summary:"作业结果"};
      }, async check(ref){ return {ref,status:"done",summary:"作业完成",evidence:[{text:"标记"}]}; },
      async cancel(ref){writeFileSync(join(data,ref+".cancel"),"cancel");} });
      api.flowSignal({ id: "mark", name: "标记", describe: "检查通过", params: {type:"object",properties:{fail:{type:"boolean"}}},
        async check(ctx) { if (ctx.with.fail) throw Error("读取失败"); return {done:true,evidence:[{text:"检查单",link:"https://example.org/check"}]}; } });
    }`);
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
  const job = (fail = false) => ({ id: "job", name: "运行作业", by: { runner: "stagekit:job", with: { fail } }, budget: { minutes: 10 } });
  async function tick(item: string) {
    const id = flowView(app, item).stages[0].by!;
    return runPluginStage({ app, run: getRun(app,id), signal: new AbortController().signal,
      output: value => setRunOutput(app,id,value), event: () => {} });
  }
  it("本人确认运行器，重启后同键恢复并交付结果", async () => {
    expect(() => saveFlow(app,raw([job()]),"member")).toThrow("本人确认");
    const item = await begin([job()]);
    const id = flowView(app,item).stages[0].by!;
    await expect(tick(item)).rejects.toThrow("下一次检查");
    const operation = getRun(app,id).output.runnerResult;
    // Crash window after the external write and before the host receives the reference.
    setRunOutput(app,id,{runnerResult:null});
    await expect(tick(item)).rejects.toThrow("下一次检查");
    expect(getRun(app,id).output.runnerResult).toEqual(operation);
    await tick(item);
    expect(flowView(app,item).stages[0]).toMatchObject({state:"done",evidence:[id],pluginEvidence:[{text:"标记"}]});
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
});
