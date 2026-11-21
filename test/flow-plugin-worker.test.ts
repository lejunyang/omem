import { mkdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { testApp } from "./helpers.ts";
import { stagePlugin } from "./flow-plugin-fixture.ts";
import { forgetPlugin, loadPlugins, trustPlugin } from "../src/plugins/registry.ts";
import { getRun, startWorker, stopWorker, updateQueuedRun } from "../src/agents/runs.ts";
import { itemProgress } from "../src/agents/progress.ts";
import { one, run } from "../src/core/db.ts";
import { saveFlow } from "../src/flows/definitions.ts";
import { flowView, startFlow } from "../src/flows/engine.ts";
import { upsertItem } from "../src/items/store.ts";

it("宿主恢复两种插件中断的运行，使用原键排队续查并只写一次文件", async () => {
  const app = testApp();
  const modes = ["isolated", "inprocess"] as const;
  const root = join(app.home, "plugins");
  const cases = [];
  try {
    for (const mode of modes) {
      const dir = join(root, mode);
      mkdirSync(dir, {recursive:true});
      writeFileSync(join(dir,"plugin.yaml"), JSON.stringify({id:mode, name:mode, permissions:{flow:{run:true,signal:true,gate:true}}}));
      writeFileSync(join(dir,"server.mjs"), stagePlugin);
    }
    await loadPlugins(app, [{dir:root,source:"data"}]);
    for (const mode of modes) {
      const data = join(app.home,"plugin-data",mode);
      mkdirSync(data,{recursive:true});
      if (mode === "inprocess") vi.stubEnv("OMEM_PLUGIN_DATA",data);
      await trustPlugin(app,mode,mode);
      const flow = JSON.stringify({id:mode,name:mode,stages:[{id:"job",name:"作业",by:{runner:mode+":job"}}]});
      expect(() => saveFlow(app,flow,"member")).toThrow("本人确认");
      saveFlow(app,flow,"owner",true);
      const item = upsertItem(app,undefined,{title:"恢复作业",spaceId:"personal"},"user");
      const view = await startFlow(app,item.id,mode,{actor:"owner"});
      const id = view.stages[0].by!, file = join(data,id);
      // Crash snapshot: the external write happened, the running row has no receipt yet.
      writeFileSync(file,id);
      utimesSync(file,1,1);
      run(app.db,"update runs set status='running',started_at=CURRENT_TIMESTAMP where id=?",id);
      cases.push({item:item.id,id,file});
    }
    startWorker(app);
    for (const {item,id,file} of cases) {
      await vi.waitFor(() => expect(getRun(app,id)).toMatchObject({status:"queued",input:{restarted:expect.anything()},
        output:{runnerResult:{ref:id,status:"running"}}}),{timeout:5000});
      expect(one<{at:string}>(app.db,"select not_before at from runs where id=?",id)?.at).toBeTruthy();
      expect(updateQueuedRun(app,id,{notBefore:new Date().toISOString()})).toBe(true);
      await vi.waitFor(() => expect(getRun(app,id).status).toBe("done"),{timeout:5000});
      expect(statSync(file).mtimeMs).toBe(1000);
      expect(flowView(app,item).stages[0]).toMatchObject({by:id,state:"done",evidence:[id],pluginEvidence:[{text:"标记"}]});
      expect(itemProgress(app,item,{user:"owner"}).find(v => v.kind === "flow")?.tasks[0].attempts.some(a => a.runId === id)).toBe(true);
    }
  } finally {
    stopWorker();
    for (const mode of modes) forgetPlugin(mode);
    app.events.emit("close");
    vi.unstubAllEnvs();
  }
});
