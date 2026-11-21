import { rmSync } from "node:fs";
import { expect, it } from "vitest";
import { testApp } from "./helpers.ts";
import { createUser, createApiToken } from "../src/core/users.ts";
import { saveAgentSpec, readAgentSpec, saveSkill, readSkill, setPluginSpecSource } from "../src/agents/specs.ts";
import { startServer } from "../src/server/http.ts";

it("无管理权成员可看列表，逐项不可改删，删除接口拒绝且内容仍在", async () => {
  const app=testApp();
  saveAgentSpec(app,{name:"inspect",description:"核对",prompt:"核对"},"user");
  saveSkill(app,{name:"inspect",description:"核对",body:"核对材料"},"user");
  const bundled={...readAgentSpec(app,"inspect"),name:"bundled",plugin:"demo"};
  setPluginSpecSource({list:()=>[bundled],find:(_app,name)=>name==="bundled"?bundled:null,raw:()=>""});
  createUser(app,{id:"reader",name:"只读成员"});
  const headers={authorization:`Bearer ${createApiToken(app,"reader")}`};
  const server=await startServer(app,{port:0,quiet:true});
  try {
    for(const kind of ["agents","skills"]) {
      const member=await server.inject({url:`/api/${kind}`,headers});
      expect(member.statusCode).toBe(200);
      expect(member.json().find((s:{name:string})=>s.name==="inspect")).toMatchObject({canEdit:false,canDelete:false});
      const owner=(await server.inject(`/api/${kind}`)).json();
      expect(owner.find((s:{name:string})=>s.name==="inspect")).toMatchObject({canEdit:true,canDelete:true});
      expect((await server.inject({method:"DELETE",url:`/api/${kind}/inspect`,headers})).statusCode).toBe(403);
    }
    expect((await server.inject("/api/agents")).json().find((s:{name:string})=>s.name==="bundled")).toMatchObject({canEdit:true,canDelete:false});
    expect(readAgentSpec(app,"inspect").prompt).toBe("核对");expect(readSkill(app,"inspect").body).toBe("核对材料");
  } finally {setPluginSpecSource(null);await server.close();app.db.close();rmSync(app.home,{recursive:true,force:true});}
});
