import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testApp } from "./helpers.ts";
import { forgetPlugin, loadPlugins, manifestSchema, reloadPlugin, setPluginEnabled, trustPlugin } from "../src/plugins/registry.ts";
import { catalogEntry, launchConfigEnv, pluginBackendStatus } from "../src/agents/catalog.ts";
import { allProfiles } from "../src/core/config.ts";
import { backendAvailable } from "../src/agents/availability.ts";
import { listAgentProfiles } from "../src/agents/runner.ts";
import { backendHosts } from "../src/agents/egress-policy.ts";
import { openAcp } from "../src/agents/acp.ts";
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
    app.config.agents.profiles.push(profile);
    await setPluginEnabled(app,"backendkit",false);
    expect(catalogEntry(entry.id)).toBeUndefined();
    expect(backendAvailable(profile,app.home)).toBe(false);
    expect(listAgentProfiles(app).find(p => p.id === entry.id)?.pluginBackend).toMatchObject({plugin:"backendkit",available:false});
    await expect(openAcp(profile,{cwd:app.home})).rejects.toThrow("停用");
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
  it("环境只能声明变量名，重复后端拒绝", () => {
    expect(() => manifestSchema.parse({...declaration,backends:[{...declaration.backends[0],env:{SECRET:"value"}}]})).toThrow();
    expect(() => manifestSchema.parse({...declaration,backends:[declaration.backends[0],declaration.backends[0]]})).toThrow();
  });
});
