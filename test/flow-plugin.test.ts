import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { testApp } from "./helpers.ts";
import { forgetPlugin, loadPlugins, setPluginEnabled, trustPlugin } from "../src/plugins/registry.ts";
import { parseFlow, saveFlow } from "../src/flows/definitions.ts";
import { flowView, ownerAction, startFlow } from "../src/flows/engine.ts";
import { checkGitSignals } from "../src/flows/signals.ts";
import { all } from "../src/core/db.ts";
import { upsertItem } from "../src/items/store.ts";

describe.each(["isolated", "inprocess"] as const)("流程插件 %s", mode => {
  const app = testApp();
  const dir = join(app.home, "plugins", "stagekit");
  const owner = { actor: "owner", userId: "owner" };
  const raw = (stages: unknown[]) => JSON.stringify({ id: "inspect", name: "检查", stages });
  const signalStage = (fail: unknown) => ({ id: "mark", name: "检查标记", by: "wait", done: { signal: "stagekit:mark", with: { fail } } });
  async function begin(stages: unknown[]) {
    saveFlow(app, raw(stages), "owner");
    const item = upsertItem(app, undefined, { title: "检查事项", spaceId: "personal" }, "user");
    await startFlow(app, item.id, "inspect", owner);
    return item.id;
  }
  beforeAll(async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "plugin.yaml"), "id: stagekit\nname: 阶段示例\npermissions:\n  flow: { signal: true }\n");
    writeFileSync(join(dir, "server.mjs"), `export default function(api) {
      api.flowSignal({ id: "mark", name: "标记", describe: "检查通过", params: {type:"object",properties:{fail:{type:"boolean"}}},
        async check(ctx) { if (ctx.with.fail) throw Error("读取失败"); return {done:true,evidence:[{text:"检查单",link:"https://example.org/check"}]}; } });
    }`);
    await loadPlugins(app, [{ dir: join(app.home, "plugins"), source: "data" }]);
    await trustPlugin(app, "stagekit", mode);
  });
  afterAll(() => { forgetPlugin("stagekit"); app.events.emit("close"); app.db.close(); });
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
});
