import { existsSync, lstatSync, mkdirSync, symlinkSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import YAML from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { testApp } from "./helpers.ts";
import { saveAgentSpec, saveSkill } from "../src/agents/specs.ts";
import { listMcpServers, saveMcpServer } from "../src/agents/mcp-servers.ts";
import { setKey } from "../src/core/ai-keys.ts";
import { createApiToken, createUser } from "../src/core/users.ts";
import { manifestSchema } from "../src/plugins/registry.ts";
import { ROUTE_RULES } from "../src/auth/routes.ts";
import { startServer } from "../src/server/http.ts";
import { packPlugin } from "../src/plugins/pack.ts";
import { installPlugin } from "../src/plugins/install.ts";
import { describePlugin, forgetPlugin, getPlugin, loadPlugins, reloadPlugin, setPluginEnabled, trustPlugin } from "../src/plugins/registry.ts";
import { deleteRule, getRule, listRules, saveRule } from "../src/rules/store.ts";

const ids = new Set<string>();
afterEach(() => { for (const id of ids) forgetPlugin(id); ids.clear(); });
const rule = { name: "项目 A 提醒", description: "项目 A 有新消息时通知本人", judge: "ai" as const, actions: [{ type: "notify" as const }] };
function fixture(app: ReturnType<typeof testApp>, id: string, manifest: string, files: Record<string, string> = {}) {
  ids.add(id);
  const dir = join(app.home, "plugins", id);
  for (const [file, raw] of Object.entries({ "plugin.yaml": `id: ${id}\nname: 示例商城\n${manifest}`, ...files })) {
    mkdirSync(join(dir, file, ".."), { recursive: true }); writeFileSync(join(dir, file), raw);
  }
  return dir;
}

describe("场景包与插件带来的配置", () => {
  it("规则只导入一次且停用，保留来源；删除后重载和重装也不重建", async () => {
    const app = testApp();
    fixture(app, "packrules", "rules: [first]\n", { "rules/first.yaml": YAML.stringify({ ...rule, enabled: true, id: "foreign", createdBy: "agent" }) });
    await loadPlugins(app, [{ dir: join(app.home, "plugins"), source: "data" }]);
    const imported = listRules(app)[0];
    expect(imported).toMatchObject({ enabled: false, createdBy: "user", origin: { plugin: "packrules", name: "示例商城", file: "first" } });
    expect(imported.id).not.toBe("foreign");
    saveRule(app, { ...imported, temporary: undefined, enabled: true }, "user", "owner");
    await setPluginEnabled(app, "packrules", false);
    expect(listRules(app)[0]).toMatchObject({ enabled: true, origin: imported.origin });
    await setPluginEnabled(app, "packrules", true);
    expect(listRules(app)).toHaveLength(1);
    deleteRule(app, imported.id);
    forgetPlugin("packrules");
    await reloadPlugin(app, "packrules");
    expect(listRules(app)).toHaveLength(0);
    expect(describePlugin(getPlugin("packrules")).rules[0]).toMatchObject({ id: null, created: true });
  });

  it("URL MCP 保留未填的密钥名，命令 MCP 等信任；短名解析，不覆盖已有服务", async () => {
    const app = testApp();
    fixture(app, "packmcp", `agents: [helper]\nmcp:\n  search:\n    url: https://search.example/mcp\n    headers: [Authorization]\n    readOnly: true\n  local:\n    command: npx\n    args: [-y, some-mcp-server]\n    env: [API_KEY]\n`, { "agents/helper.md": "---\ndescription: 查项目 A\nmcpServers: [search, local]\n---\n查资料。" });
    await reloadPlugin(app, "packmcp");
    expect(getPlugin("packmcp").specs[0].mcpServers).toEqual(["packmcp-search", "packmcp-local"]);
    expect(listMcpServers(app)).toEqual([expect.objectContaining({ name: "packmcp-search", secrets: [{ name: "Authorization", set: false }] })]);
    expect(getPlugin("packmcp").trust).toBe("required");
    expect(describePlugin(getPlugin("packmcp")).permissions.services).toContain("npx -y some-mcp-server");
    await trustPlugin(app, "packmcp");
    expect(listMcpServers(app)).toHaveLength(2);
    saveMcpServer(app, "packmcp-search", { url: "https://changed.example/mcp", secrets: { Authorization: "owner-key-value" } });
    await setPluginEnabled(app, "packmcp", false); await setPluginEnabled(app, "packmcp", true);
    expect(listMcpServers(app).find((s) => s.name === "packmcp-search")).toMatchObject({ url: "https://changed.example/mcp", secrets: [{ name: "Authorization", set: true }] });
    forgetPlugin("packmcp");
    expect(listMcpServers(app)).toHaveLength(2);
  });

  it("停用的插件不导入任何规则、技能或 MCP，启用后才加入", async () => {
    const app = testApp(); app.config.plugins.disabled.push("packoff");
    fixture(app, "packoff", "rules: [first]\nskills: [guide]\nmcp: { search: { url: https://search.example/mcp } }\n", { "rules/first.yaml": YAML.stringify(rule), "skills/guide/SKILL.md": "---\ndescription: 示例\n---\n项目 A" });
    await reloadPlugin(app, "packoff");
    expect(listRules(app)).toHaveLength(0); expect(listMcpServers(app)).toHaveLength(0);
    expect(existsSync(join(app.libraryDir, "_skills", "guide", "SKILL.md"))).toBe(false);
    await setPluginEnabled(app, "packoff", true);
    expect(listRules(app)).toHaveLength(1); expect(listMcpServers(app)).toHaveLength(1);
  });

  it("导出完整技能、档案和停用规则；MCP 只有名字，遗漏依赖给提醒；本地安装是副本", async () => {
    const app = testApp();
    saveSkill(app, { name: "guide", description: "项目 A 做法", body: "先查原件。", files: { "references/steps.md": "逐项核对。" } });
    saveAgentSpec(app, { name: "helper", description: "项目 A", skills: ["guide", "other"], mcpServers: ["search", "unpacked"], prompt: "查资料。" }, "user");
    saveMcpServer(app, "search", { url: "https://search.example/mcp", secrets: { Authorization: "sample-secret-value" }, readOnly: true });
    const r = saveRule(app, rule, "user", "owner");
    const packed = packPlugin(app, { id: "portable", name: "示例商城", agents: ["helper"], skills: ["guide"], rules: [r.id], mcp: ["search"] });
    expect(packed.dir).toBe(join(app.home, "plugins-out", "portable"));
    expect(packed.warnings).toHaveLength(2);
    const manifest = readFileSync(join(packed.dir, "plugin.yaml"), "utf8");
    expect(manifest).not.toContain("sample-secret-value");
    expect(YAML.parse(manifest).mcp.search.headers).toEqual(["Authorization"]);
    expect(readFileSync(join(packed.dir, "skills/guide/references/steps.md"), "utf8")).toBe("逐项核对。");
    const receiver = testApp();
    const installed = await installPlugin(receiver, packed.dir); ids.add(installed.id);
    writeFileSync(join(packed.dir, "agents/helper.md"), "changed");
    expect(readFileSync(join(installed.dir, "agents/helper.md"), "utf8")).toContain("查资料。");
    expect(lstatSync(installed.dir).isSymbolicLink()).toBe(false);
    await reloadPlugin(receiver, installed.id);
    expect(getPlugin(installed.id).trust).toBe("none");
    // Only the servers the pack brings: a name among the receiver's own servers is not the pack's to use.
    expect(getPlugin(installed.id).specs[0].mcpServers).toEqual(["portable-search"]);
    expect(existsSync(join(receiver.libraryDir, "_skills/guide/references/steps.md"))).toBe(true);
  });

  it("扫描每行的密钥与用户目录，拒绝时没有输出；allow 只放行用户目录路径，已存密钥不能放行", () => {
    const app = testApp(); setKey(app.home, "demo", "stored-key-value");
    const files = { "steps.md": "参考 /Users/" + "example/work/" };
    saveSkill(app, { name: "unsafe", description: "示例", body: "说明\nstored-key-value\n" + "/home/" + "example/notes/", files });
    const o = { id: "blocked", name: "示例", skills: ["unsafe"] };
    expect(() => packPlugin(app, o)).toThrow(/skills\/unsafe\/SKILL.md:\d+：存储的密钥/);
    expect(existsSync(join(app.home, "plugins-out/blocked"))).toBe(false);
    const all = ["skills/unsafe/SKILL.md", "skills/unsafe/steps.md"];
    expect(() => packPlugin(app, { ...o, allow: all })).toThrow(/存储的密钥（不能放行/);
    expect(existsSync(join(app.home, "plugins-out/blocked"))).toBe(false);
    saveSkill(app, { name: "unsafe", description: "示例", body: "说明\n" + "/home/" + "example/notes/", files });
    expect(() => packPlugin(app, { ...o, allow: ["skills/unsafe/SKILL.md"] })).toThrow(/steps.md/);
    const packed = packPlugin(app, { ...o, allow: all });
    expect(packed.warnings).toEqual([expect.stringContaining("已按 --allow 放行 skills/unsafe/SKILL.md"), expect.stringContaining("已按 --allow 放行 skills/unsafe/steps.md")]);
  });

  it("规则里本人在这台机器上选的东西不带走：带脚本的规则不打包，空间、AI、完全访问去掉并提醒", () => {
    const app = testApp();
    const scripted = saveRule(app, { ...rule, name: "带脚本", actions: [{ type: "script" as const, runtime: "node" as const, code: "return 1" }] }, "user", "owner");
    expect(() => packPlugin(app, { id: "noscript", name: "示例", rules: [scripted.id] })).toThrow(/规则「带脚本」：带脚本的规则不随场景包走/);
    expect(existsSync(join(app.home, "plugins-out/noscript"))).toBe(false);
    const full = saveRule(app, { ...rule, name: "周报", spaceId: "personal", actions: [{ type: "agent" as const, spec: "assistant", task: "写周报", fullAccess: true }, { type: "notify" as const }] }, "user", "owner");
    const packed = packPlugin(app, { id: "weekly", name: "示例", rules: [full.id] });
    expect(packed.warnings).toEqual([expect.stringContaining("规则「周报」的所属空间")]);
    const out = YAML.parse(readFileSync(join(packed.dir, "rules/rule-1.yaml"), "utf8"));
    expect(out).toMatchObject({ name: "周报", enabled: false });
    expect(out.spaceId).toBeUndefined();
    expect(out.actions[0].fullAccess).toBeUndefined();
  });

  it("插件带来的规则：带脚本或转发的不创建并说明原因，完全访问和这里没有的空间、AI 去掉，其余照常导入", async () => {
    const app = testApp();
    fixture(app, "mixed", "rules: [script, forward, full, plain]\n", {
      "rules/script.yaml": YAML.stringify({ ...rule, name: "脚本", actions: [{ type: "script", runtime: "node", code: "return 1" }] }),
      "rules/forward.yaml": YAML.stringify({ ...rule, name: "转发", trigger: { event: "message" }, actions: [{ type: "forward", to: { kind: "origin" } }] }),
      "rules/full.yaml": YAML.stringify({ ...rule, name: "完全访问", spaceId: "nowhere", actions: [{ type: "agent", spec: "assistant", task: "查一下", fullAccess: true, ai: { profile: "missing-backend" } }] }),
      "rules/plain.yaml": YAML.stringify(rule),
    });
    await loadPlugins(app, [{ dir: join(app.home, "plugins"), source: "data" }]);
    const brought = describePlugin(getPlugin("mixed")).rules;
    expect(brought.map((r) => [r.file, !!r.id])).toEqual([["script", false], ["forward", false], ["full", true], ["plain", true]]);
    expect(brought[0].error).toContain("带脚本的规则不随场景包走");
    expect(brought[1].error).toContain("带转发的规则不随场景包走");
    const full = getRule(app, brought[2].id!);
    expect(full.enabled).toBe(false);
    expect(full.spaceId).toBeUndefined();
    expect(full.actions[0]).not.toHaveProperty("fullAccess");
    expect(full.actions[0]).not.toHaveProperty("ai");
  });

  it("扫描 JSON 里的 MCP 密钥及 Windows 路径，不把值写进错误", () => {
    const app = testApp(); saveMcpServer(app, "search", { url: "https://search.example/mcp", secrets: { Authorization: "header-key-value" } });
    saveSkill(app, { name: "unsafe", description: "示例", body: "header-key-value\n" + ["C:", "Users", "example", "work", ""].join(String.fromCharCode(92)) });
    try { packPlugin(app, { id: "scanwin", name: "示例", skills: ["unsafe"] }); throw new Error("没有拦截"); }
    catch (e) { expect((e as Error).message).toContain("用户目录绝对路径"); expect((e as Error).message).not.toContain("header-key-value"); }
  });

  it("拒绝存活插件目录、已有目录和无效 id", () => {
    const app = testApp();
    expect(() => packPlugin(app, { id: "safeid", name: "示例", out: join(app.home, "plugins/safeid") })).toThrow(/plugins/);
    expect(() => packPlugin(app, { id: "safeid", name: "示例", out: "plugins/safeid" })).toThrow(/plugins/);
    expect(() => packPlugin(app, { id: "../escape", name: "示例" })).toThrow();
    const r = packPlugin(app, { id: "safeid", name: "示例" });
    expect(() => packPlugin(app, { id: "safeid", name: "示例", out: r.dir })).toThrow(/已存在/);
  });

  it("内嵌 MCP 转成清单，不把未存入密钥库的值打进档案；命令仍需信任", async () => {
    const app = testApp();
    saveAgentSpec(app, { name: "inlinehelper", description: "项目 A", tools: ["group:read", "-search"],
      mcp: { local: { command: "npx", args: ["some-mcp-server"], env: { API_KEY: "inline-value-never-exported" } } }, prompt: "查项目 A。" }, "user");
    const result = packPlugin(app, { id: "inlinepack", name: "示例商城", agents: ["inlinehelper"] });
    const manifest = YAML.parse(readFileSync(join(result.dir, "plugin.yaml"), "utf8"));
    const agent = readFileSync(join(result.dir, "agents/inlinehelper.md"), "utf8");
    expect(JSON.stringify(manifest) + agent).not.toContain("inline-value-never-exported");
    expect(manifest.mcp["inline-1"]).toMatchObject({ command: "npx", env: ["API_KEY"] });
    expect(manifest.tools).not.toContain("search"); expect(manifest.tools).toContain("read_source");
    const receiver = testApp(); const installed = await installPlugin(receiver, result.dir); ids.add(installed.id);
    await reloadPlugin(receiver, installed.id);
    expect(getPlugin(installed.id).trust).toBe("required");
    expect(listMcpServers(receiver)).toHaveLength(0);
  });

  it("跨行密钥也按起始行拦截", () => {
    const app = testApp(); setKey(app.home, "demo", "first-key-line\nsecond-key-line");
    saveSkill(app, { name: "multiline", description: "示例", body: "前文\nfirst-key-line\nsecond-key-line\n后文" });
    expect(() => packPlugin(app, { id: "multilinepack", name: "示例", skills: ["multiline"] })).toThrow(/SKILL.md:\d+：存储的密钥/);
    expect(existsSync(join(app.home, "plugins-out/multilinepack"))).toBe(false);
  });

  it("清单拒绝 MCP 值、双重传输和加前缀后超长的名字", () => {
    expect(() => manifestSchema.parse({ id: "badmcp", name: "示例", mcp: { search: { url: "https://search.example/mcp", headers: { Authorization: "value" } } } })).toThrow();
    expect(() => manifestSchema.parse({ id: "badmcp", name: "示例", mcp: { search: { url: "https://search.example/mcp", command: "npx" } } })).toThrow();
    const app = testApp();
    const long = "a".repeat(31);
    saveAgentSpec(app, { name: long, description: "示例", prompt: "项目 A" }, "user");
    expect(() => packPlugin(app, { id: "abcdefghijklmnopqrstuvwx", name: "示例", agents: [long] })).toThrow(/48/);
    expect(existsSync(join(app.home, "plugins-out/abcdefghijklmnopqrstuvwx"))).toBe(false);
  });

  it("输出路径经过 junction 也不能进入 live plugins，技能内不跟随链接", () => {
    const app = testApp(), live = join(app.home, "plugins"); mkdirSync(live);
    const alias = join(app.home, "alias"); symlinkSync(live, alias, "junction");
    expect(() => packPlugin(app, { id: "linkedpack", name: "示例", out: join(alias, "linkedpack") })).toThrow(/plugins/);
    saveSkill(app, { name: "linked", description: "示例", body: "项目 A" });
    symlinkSync(live, join(app.libraryDir, "_skills/linked/link"), "junction");
    expect(() => packPlugin(app, { id: "linkedpack", name: "示例", skills: ["linked"] })).toThrow(/符号链接/);
  });

  it("CLI 帮助说明扫描与 allow，pack 命令实际导出配置", () => {
    const help = spawnSync(process.execPath, [resolve("src/cli.ts"), "plugin", "pack", "--help"], { encoding: "utf8", timeout: 20_000 });
    expect(help.status).toBe(0); expect(help.stdout).toContain("--allow"); expect(help.stdout).toContain("绝对路径");
    const app = testApp();
    saveAgentSpec(app, { name: "helper", description: "示例商城", prompt: "处理项目 A。" }, "user");
    const output = spawnSync(process.execPath, [resolve("src/cli.ts"), "--home", app.home, "plugin", "pack", "--id", "clipack", "--name", "示例商城", "--agents", "helper"], { encoding: "utf8", timeout: 20_000 });
    expect(output.status, output.stderr).toBe(0);
    expect(readFileSync(join(app.home, "plugins-out/clipack/agents/helper.md"), "utf8")).toContain("处理项目 A。");
  }, 60_000);

  it("打包 API 和选择列表只给本人，返回目录和提醒", async () => {
    expect(ROUTE_RULES["POST /api/plugins/pack"]).toBe("owner");
    expect(ROUTE_RULES["GET /api/plugins/pack"]).toBe("owner");
    const app = testApp(), server = await startServer(app, { port: 0, quiet: true });
    try {
      const result = await server.inject({ method: "POST", url: "/api/plugins/pack", payload: { id: "apipack", name: "示例商城" } });
      expect(result.statusCode).toBe(200); expect(result.json()).toMatchObject({ dir: join(app.home, "plugins-out/apipack"), warnings: [] });
      expect((await server.inject({ url: "/api/plugins/pack" })).json()).toHaveProperty("agents");
      const member = createUser(app, { name: "小王", role: "admin" });
      const token = createApiToken(app, member.id);
      const headers = { authorization: `Bearer ${token}` };
      expect((await server.inject({ method: "POST", url: "/api/plugins/pack", headers, payload: { id: "memberpack", name: "示例" } })).statusCode).toBe(403);
      expect((await server.inject({ url: "/api/plugins/pack", headers })).statusCode).toBe(403);
      expect(existsSync(join(app.home, "plugins-out/memberpack"))).toBe(false);
    } finally { await server.close(); }
  });
});
