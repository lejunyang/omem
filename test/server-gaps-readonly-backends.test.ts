import { rmSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { testApp } from "./helpers.ts";
import { agentProfileSchema } from "../src/core/config.ts";
import { createUser, createApiToken } from "../src/core/users.ts";
import { run } from "../src/core/db.ts";
import { saveProbe } from "../src/agents/probe.ts";
import * as probe from "../src/agents/probe.ts";
import { startServer } from "../src/server/http.ts";

it("只有知识查看权的成员读取后端列表及缓存，无缓存不启动，刷新与改设置仍拒绝",async () => {
  const app=testApp();
  app.config.agents.profiles=[agentProfileSchema.parse({id:"fixture",name:"示例后端",transport:"acp",command:process.execPath,args:["--fixture-secret"],env:{FIXTURE_KEY:"fixture-secret"},cwd:"private-folder"})];
  createUser(app,{id:"knowledge-viewer",name:"查看成员",role:"observer"});
  run(app.db,"insert into member_capability_overrides(user_id,capability,scope_kind,scope_id,effect,created_at,created_by) values(?,'settings.knowledge.view','global','','allow','0','owner')","knowledge-viewer");
  const headers={authorization:`Bearer ${createApiToken(app,"knowledge-viewer")}`};
  saveProbe(app,"fixture",{at:"2026-01-01",agent:"fixture",models:["shared-model"],efforts:["low"],error:"private-folder",modelNotes:{private:"fixture-secret"}});
  saveProbe(app,"fixture",{at:"2026-01-02",agent:"fixture",models:["own-model"],efforts:["high"]},"knowledge-viewer");
  const launch=vi.spyOn(probe,"probeProfile").mockRejectedValue(new Error("测试不允许启动真实后端"));
  const server=await startServer(app,{port:0,quiet:true});
  try {
    const response=await server.inject({url:"/api/settings?section=knowledge",headers});
    expect(response.statusCode).toBe(200);
    expect(response.json().agents.find((p:{id:string})=>p.id==="fixture")).toMatchObject({id:"fixture",name:"示例后端",canProbe:false,probe:{models:["own-model"],efforts:["high"]}});
    for(const field of ["command","args","env","cwd","keyRef","home"]) expect(response.json().agents.find((p:{id:string})=>p.id==="fixture")).not.toHaveProperty(field);
    expect(response.body).not.toContain("fixture-secret");expect(response.body).not.toContain("private-folder");
    const test=await server.inject({method:"POST",url:"/api/agents/fixture/probe",headers,payload:{refresh:false}});
    expect(test.json()).toMatchObject({cached:true,readOnly:true,models:["own-model"]});
    run(app.db,"delete from kv where key like 'probe:%'");
    expect((await server.inject({method:"POST",url:"/api/agents/fixture/probe",headers,payload:{}})).json()).toMatchObject({readOnly:true,models:[],efforts:[]});
    expect((await server.inject({method:"POST",url:"/api/agents/fixture/probe",headers,payload:{refresh:true}})).statusCode).toBe(403);
    expect((await server.inject({method:"PUT",url:"/api/settings",headers,payload:{agents:{default:"fixture"}}})).statusCode).toBe(403);
    expect((await server.inject({url:"/api/search/providers",headers})).statusCode).toBe(200);
    expect(launch).not.toHaveBeenCalled();
  } finally {launch.mockRestore();await server.close();app.db.close();rmSync(app.home,{recursive:true,force:true});}
});
