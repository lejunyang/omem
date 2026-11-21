import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { testApp } from "./helpers.ts";
import { answerAsk } from "../src/agents/asks.ts";
import { startWorker, stopWorker } from "../src/agents/runs.ts";
import { auditLog } from "../src/auth/permissions.ts";
import { flowView, proposeFlow, startFlow } from "../src/flows/engine.ts";
import { saveGateChecks } from "../src/flows/plugin-gates.ts";
import { upsertItem } from "../src/items/store.ts";
import { forgetPlugin, loadPlugins, trustPlugin } from "../src/plugins/registry.ts";

it("文件示例按 README 到达越过卡，默认结果直接通过", async () => {
  const app = testApp(), root = join(app.home,"plugins"), dir = join(root,"stagekit");
  cpSync("examples/plugins/stagekit",dir,{recursive:true});
  const yaml = readFileSync(join(dir,"README.md"),"utf8").split("```yaml\n")[1].split("```")[0];
  try {
    await loadPlugins(app,[{dir:root,source:"data"}]);
    await trustPlugin(app,"stagekit","isolated");
    const data = join(app.home,"plugin-data","stagekit");
    mkdirSync(data,{recursive:true});
    writeFileSync(join(data,"ready.txt"),"ready");
    startWorker(app);
    for (const blocked of [true,false]) {
      const ask = proposeFlow(app,blocked ? yaml : yaml.replace(", with: { verified: false }",""),{actor:"owner"});
      await answerAsk(app,ask.id,{choice:0,by:"owner"});
      saveGateChecks(app,"local-check",[{id:"stagekit:word",stages:["write"],mandatory:true}]);
      const item = upsertItem(app,undefined,{title:"示例检查",spaceId:"personal"},"user");
      await startFlow(app,item.id,"local-check",{actor:"owner"});
      const stage = () => flowView(app,item.id).stages[1];
      await vi.waitFor(() => expect(stage().state).toBe(blocked ? "blocked" : "done"),{timeout:5000});
      expect(readFileSync(join(data,"proof-"+stage().by+".txt"),"utf8").trim()).toBe(blocked ? "待复核" : "已验证");
      if (blocked) {
        await answerAsk(app,stage().askId!,{choice:0,by:"owner"});
        expect(stage().state).toBe("done");
        expect(auditLog(app)).toContainEqual(expect.objectContaining({action:"flow.gate-override",target:item.id,
          detail:expect.objectContaining({checks:["stagekit:word"]})}));
      }
    }
  } finally { stopWorker(); forgetPlugin("stagekit"); app.events.emit("close"); }
});
