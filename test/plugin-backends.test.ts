import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testApp } from "./helpers.ts";
import { forgetPlugin, loadPlugins, manifestSchema, reloadPlugin, setPluginEnabled, trustPlugin } from "../src/plugins/registry.ts";
import { catalogEntry, launchConfigEnv, pluginBackendStatus } from "../src/agents/catalog.ts";
import { allProfiles } from "../src/core/config.ts";
import { backendAvailable } from "../src/agents/availability.ts";
import { saveAgentSpec, readAgentSpec } from "../src/agents/specs.ts";
import { runRole, failoverProfiles, resolveRunProfile, listAgentProfiles } from "../src/agents/runner.ts";
import { backendHosts } from "../src/agents/egress-policy.ts";
import * as spawn from "../src/agents/spawn.ts";
import { sessionCleanup } from "../src/agents/session-cleanup.ts";
import { archiveSession } from "../src/agents/session-archive.ts";
import { one } from "../src/core/db.ts";
import { deleteAcpSession, openAcp } from "../src/agents/acp.ts";
import { setTrust, trustState } from "../src/plugins/trust.ts";

describe.each(["isolated", "inprocess"] as const)("声明式 ACP %s", mode => {
  const app = testApp(), dir = join(app.home,"plugins","backendkit");
  const declaration = {id:"backendkit",name:"后端示例",backends:[{id:"fake",name:"假 ACP",command:process.execPath,
    egressHosts:["first.example.org"], args:[resolve("test/fake-acp-agent.ts")], env:["FAKE_MODE"], launchConfig:{env:"DEMO_CONFIG",model:"model"}}, {id:"second", name:"另一后端", command:process.execPath, args:["--version"], egressHosts:["second.example.org"]}]};
  afterEach(() => { forgetPlugin("backendkit"); vi.unstubAllEnvs(); });
  async function install() {
    mkdirSync(dir,{recursive:true});
    writeFileSync(join(dir,"plugin.yaml"),JSON.stringify(declaration));
    await loadPlugins(app,[{dir:join(app.home,"plugins"),source:"data"}]);
  }
  it("信任后进入同一目录，能运行假 ACP，停用后已保存配置显示来源", async () => {
    await install();
    expect(catalogEntry("backendkit:fake")).toBeUndefined();
    expect(allProfiles(app.config).some(p => p.id === "backendkit:fake")).toBe(false);
    await trustPlugin(app,"backendkit",mode);
    const entry = catalogEntry("backendkit:fake")!;
    expect(entry).toMatchObject({plugin:"backendkit",pluginName:"后端示例",envNames:["FAKE_MODE"]});
    const profile = allProfiles(app.config).find(p => p.id === entry.id)!;
    const second = allProfiles(app.config).find(p => p.id === "backendkit:second")!;
    expect([...backendHosts(second)]).toEqual(["second.example.org"]);
    expect(profile.env).toEqual({});
    expect(launchConfigEnv(profile,{model:"m2"})).toEqual({DEMO_CONFIG:'{"model":"m2"}'});
    vi.stubEnv("FAKE_MODE","thread");
    const handle = await openAcp(profile,{cwd:app.home});
    try { expect(JSON.parse((await handle.prompt("检查",() => {})).text)).toMatchObject({turn:1}); }
    finally { handle.close(); }
    const cleanup = await sessionCleanup(app,profile,{cwd:app.home},() => {});
    cleanup.created(handle.sessionId);
    app.config.agents.profiles.push(profile);
    await setPluginEnabled(app,"backendkit",false);
    expect(catalogEntry(entry.id)).toBeUndefined();
    expect(backendAvailable(profile,app.home)).toBe(false);
    expect(listAgentProfiles(app).find(p => p.id === entry.id)?.pluginBackend).toMatchObject({plugin:"backendkit",available:false});
    const launches = vi.spyOn(spawn,"launch");
    try {
      await expect(openAcp(profile,{cwd:app.home})).rejects.toThrow("停用");
      await expect(deleteAcpSession(profile,handle.sessionId,app.home)).rejects.toThrow("停用");
      await expect(archiveSession({...profile,archiveArgs:["--version"]},handle.sessionId,app.home)).rejects.toThrow("停用");
      await cleanup.discard(handle.sessionId);
      expect(one(app.db,"select attempts,ready from session_cleanup where session_id=?",handle.sessionId)).toMatchObject({attempts:0,ready:1});
      expect(launches).not.toHaveBeenCalled();
    } finally { launches.mockRestore(); }
    await setPluginEnabled(app,"backendkit",true);
    expect(backendAvailable(profile,app.home)).toBe(true);
    app.config.agents.profiles = [];
  });
  it("修改命令参数必须重新确认，按目录信任也绑定后端声明", async () => {
    await install();
    await trustPlugin(app,"backendkit",mode);
    const changed = {...declaration,backends:[{...declaration.backends[0],args:["--version"]}]};
    writeFileSync(join(dir,"plugin.yaml"),JSON.stringify(changed));
    expect((await reloadPlugin(app,"backendkit")).trust).toBe("changed");
    expect(catalogEntry("backendkit:fake")).toBeUndefined();
    const manifest = manifestSchema.parse(changed);
    setTrust(app,"backendkit",dir,mode,true,undefined,undefined,manifest.backends);
    expect(trustState(app,"backendkit",dir,true,undefined,undefined,manifest.backends)).toBe("trusted");
    expect(trustState(app,"backendkit",dir,true,undefined,undefined,manifestSchema.parse(declaration).backends)).toBe("changed");
  });
  it("冷启动后已保存的插件 ID 保留来源，角色和档案能选择后备", async () => {
    const cold = testApp(), id = "removed:worker";
    cold.baseUrl = "http://127.0.0.1:1";
    const base = {id:"working",transport:"acp" as const,command:process.execPath,args:[resolve("test/fake-acp-agent.ts")],
      env:{FAKE_MODE:"thread"},idleTimeoutMs:20000};
    cold.config.agents.profiles.push(base);
    cold.config.agents.fallback = [{profile:base.id}];
    saveAgentSpec(cold,{name:"demo",description:"核对示例",agent:id,prompt:"核对示例"},"user");
    const spec = readAgentSpec(cold,"demo");
    const actors = [{spec}, {role:"assistant" as const}];
    for (const actor of actors) {
      if ("role" in actor) cold.config.agents.roles.assistant = id;
      const selected = resolveRunProfile(cold,{actor});
      expect(selected).toMatchObject({id,command:"",plugin:"removed"});
      expect(listAgentProfiles(cold).find(p => p.id === id)?.pluginBackend).toMatchObject({available:false,plugin:"removed"});
      expect(failoverProfiles(cold,actor,selected).map(p => p.id)).toContain(base.id);
      const result = await runRole(cold,{role:"assistant",spec:actor.spec,spaceId:"personal",runId:null,task:"核对示例"});
      expect(result.profileId).toBe(base.id);
    }
    expect(catalogEntry(id)).toBeUndefined();
    cold.db.close();
  });
  it("环境只能声明变量名，重复后端拒绝", () => {
    expect(() => manifestSchema.parse({...declaration,backends:[{...declaration.backends[0],env:{SECRET:"value"}}]})).toThrow();
    expect(() => manifestSchema.parse({...declaration,backends:[declaration.backends[0],declaration.backends[0]]})).toThrow();
  });
});
