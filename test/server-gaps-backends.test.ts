import { rmSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { testApp } from "./helpers.ts";
import { allProfiles } from "../src/core/config.ts";
import { declarePluginBackends, registerPluginBackends } from "../src/agents/catalog.ts";
import { saveAgentSpec } from "../src/agents/specs.ts";
import { startServer } from "../src/server/http.ts";

const cleanup: (() => Promise<unknown> | void)[]=[];
afterEach(async () => {for(const fn of cleanup.splice(0).reverse()) await fn();});
it.each(["tier","role","spec","fallback","rotation","candidate","roleModel"])("停用的插件后端只由 %s 引用也出现在设置的不可用列表",async place => {
  const app=testApp(), id="backenddemo:worker";
  cleanup.push(() => {app.db.close();rmSync(app.home,{recursive:true,force:true});});
  declarePluginBackends("backenddemo","示例插件",[{id:"worker",name:"示例后端",command:process.execPath}]);
  const unregister=registerPluginBackends("backenddemo");
  if(place==="tier") app.config.agents.tiers.cheap={profile:id};
  if(place==="role") app.config.agents.roles.assistant=id;
  if(place==="spec") saveAgentSpec(app,{name:"inspect",description:"核对",agent:id,prompt:"核对"},"user");
  if(place==="fallback") app.config.agents.fallback=[{profile:id}];
  if(place==="rotation") app.config.review.rotation=[{profile:id}];
  if(place==="candidate") app.config.agents.routing.candidates=[{profile:id,when:"核对"}];
  if(place==="roleModel") app.config.agents.roleModels.assistant={[id]:{model:"demo"}};
  unregister();
  if(place!=="spec") expect(allProfiles(app.config).some(p=>p.id===id)).toBe(true);
  const server=await startServer(app,{port:0,quiet:true});cleanup.push(() => server.close());
  const response=(await server.inject("/api/settings")).json();
  expect(response.unavailableBackends).toContainEqual({id,name:"示例后端 (ACP)",pluginBackend:{plugin:"backenddemo",name:"示例插件",available:false,reason:expect.stringContaining("停用")}});
  expect(response.agents.find((p:{id:string})=>p.id===id).pluginBackend.available).toBe(false);
});
