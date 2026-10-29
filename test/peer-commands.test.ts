import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { agentProfileSchema } from "../src/core/config.ts";
import { adapterPackage } from "../src/core/peer-inspect.ts";
import { peerCommands, runPeerCommand } from "../src/core/peer-exec.ts";
import { upsertSource } from "../src/sources/store.ts";
import { remember } from "../src/memory/store.ts";
import { saveProbe } from "../src/agents/probe.ts";
import { testApp } from "./helpers.ts";

const app = testApp();
app.baseUrl = "http://127.0.0.1:1";
afterAll(() => app.db.close());

const call = (name: string, args?: unknown) => runPeerCommand(app, name, args) as Promise<any>;
const write = (file: string, text: string) => (mkdirSync(join(file, ".."), { recursive: true }), writeFileSync(file, text));

describe("read-only peer commands: agents, search, prompt, ide", () => {
  it("are in the fixed list and check their arguments", async () => {
    for (const c of ["agents", "search", "prompt", "ide"]) expect(peerCommands[c].description).toMatch(/[一-龥]/);
    await expect(call("search", {})).rejects.toThrow(/query/);
    await expect(call("search", { query: "" })).rejects.toThrow(/query/);
    await expect(call("search", { query: "退款", limit: 31 })).rejects.toThrow(/limit/);
    await expect(call("search", { query: "退款", space: "没有这个空间" })).rejects.toThrow(/没有空间/);
    await expect(call("prompt", {})).rejects.toThrow(/space/);
    await expect(call("prompt", { space: "personal", role: "不存在的角色" })).rejects.toThrow(/role/);
    await expect(call("prompt", { space: "personal", agent: "../x" })).rejects.toThrow(/agent/);
    await expect(call("prompt", { space: "personal", agent: "没有这个档案" })).rejects.toThrow(/agent/);
    await expect(call("prompt", { space: "personal", agent: "nobody-here" })).rejects.toThrow(/没有名为/);
    await expect(call("prompt", { space: "personal", agent: "x", role: "coder" })).rejects.toThrow();
    await expect(call("prompt", { space: "没有这个空间" })).rejects.toThrow(/空间不存在/);
  });

  it("search returns the hits the agents' tool would see, with where they come from", async () => {
    upsertSource(app, { spaceId: "personal", kind: "doc", uri: "lark:refund", title: "退款方案", text: "# 退款规则\n退款金额按已发货行计算，不含运费。\n".repeat(60) });
    const hits = await call("search", { query: "退款金额", limit: 5 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]).toMatchObject({ type: "chunk", title: "退款方案", uri: "lark:refund", kind: "doc", space: "personal" });
    expect(hits[0].sourceId).toBeTruthy();
    expect(typeof hits[0].score).toBe("number");
    expect(hits[0].snippet.length).toBeLessThanOrEqual(500);
    expect((await call("search", { query: "退款金额", space: "personal", limit: 1 })).length).toBe(1);
    expect(await call("search", { query: "退款金额", space: "*" })).not.toHaveLength(0);
  });

  it("prompt shows the standing instructions without the tool token or MCP access", async () => {
    app.config.memory.review.enabled = false;
    remember(app, { spaceId: "personal", kind: "preference", subject: "称呼", content: "称呼本人为老板。", createdBy: "user", userId: "owner" });
    const r = await call("prompt", { space: "personal" });
    expect(r.actor).toEqual({ role: "assistant" });
    expect(r.system).toContain("# 角色：");
    expect(r.system).toContain("称呼本人为老板。");
    expect(r.parts).toMatchObject({ common: expect.any(Number), role: expect.any(Number), lessonCount: 1 });
    expect(r.now).toMatch(/^现在：/);
    expect(r.truncated).toBe(r.systemChars > 30_000);
    expect(r.system.length).toBeLessThanOrEqual(30_000);
    const text = JSON.stringify(r);
    expect(text).not.toMatch(/ot_[A-Za-z0-9_-]{10,}/);
    expect(Object.keys(r)).not.toEqual(expect.arrayContaining(["token", "mcp"]));

    // A role with a task: the lessons are the task's, and a coder does not get the memory-writing guide.
    const coder = await call("prompt", { space: "personal", role: "coder", task: "实现退款按钮" });
    expect(coder.actor).toEqual({ role: "coder" });
    expect(coder.system).not.toContain("## 怎么写记忆");
  });

  it("agents lists each backend with availability, the adapter's package version, the model and the cached probe", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omem-adapter-"));
    const bin = join(dir, "lib", "node_modules", "@vendor", "fake-acp", "bin", "fake-acp.js");
    write(bin, "#!/usr/bin/env node\n");
    chmodSync(bin, 0o755);
    write(join(dir, "lib", "node_modules", "@vendor", "fake-acp", "package.json"), JSON.stringify({ name: "@vendor/fake-acp", version: "2.5.0" }));
    expect(adapterPackage({ command: bin, args: [] })).toEqual({ name: "@vendor/fake-acp", version: "2.5.0", via: "installed" });
    // Outside node_modules a package.json nearby does not count; a missing command has nothing.
    write(join(dir, "tool", "bin", "tool.js"), "");
    write(join(dir, "tool", "package.json"), JSON.stringify({ name: "not-an-adapter", version: "1.0.0" }));
    expect(adapterPackage({ command: join(dir, "tool", "bin", "tool.js"), args: [] })).toBeNull();
    expect(adapterPackage({ command: join(dir, "missing"), args: [] })).toBeNull();
    expect(adapterPackage({ command: "npx", args: ["-y", "@vendor/fake-acp@1.2.3", "--flag"] })).toEqual({ name: "@vendor/fake-acp", version: null, via: "npx" });

    app.config.agents.profiles = [agentProfileSchema.parse({ id: "fake-acp", transport: "acp", command: bin, args: [], model: "m1", effort: "low" })];
    saveProbe(app, "fake-acp", { at: "2026-10-30T00:00:00.000Z", agent: "fake", models: ["m1", "m2"], efforts: ["low", "high"] });
    const list = await call("agents");
    expect(list.map((x: { id: string }) => x.id)).toEqual(expect.arrayContaining(["codex", "claude", "doubao", "fake-acp"]));
    const fake = list.find((x: { id: string }) => x.id === "fake-acp");
    expect(fake).toMatchObject({ transport: "acp", installed: true, model: "m1", effort: "low", adapter: { name: "@vendor/fake-acp", version: "2.5.0", via: "installed" }, cachedProbe: { models: ["m1", "m2"] } });
    expect(list.find((x: { id: string }) => x.id === "codex").adapter.expected).toBe("@agentclientprotocol/codex-acp");
    expect(list.find((x: { id: string }) => x.id === "doubao").adapter).toBeNull();
    expect(list.find((x: { id: string }) => x.id === "codex-cli").adapter).toBeNull();
  });

  it("ide describes the web VS Code without leaking tokens", async () => {
    const ide = join(app.home, "ide");
    const commit = "0123456789abcdef0123456789abcdef01234567";
    const server = join(ide, "cli", "serve-web", commit);
    write(join(server, "product.json"), JSON.stringify({ version: "1.143.1", commit, quality: "stable" }));
    write(join(server, "bin", "code-server"), "");
    write(join(server, "node_modules", "node-pty", "build", "Release", "pty.node"), "");
    const pack = "ms-ceintl.vscode-language-pack-zh-hans-1.131.2026090407";
    const ext = join(ide, "server", "extensions");
    write(join(ext, "extensions.json"), JSON.stringify([{ identifier: { id: "ms-ceintl.vscode-language-pack-zh-hans" }, version: "1.131.2026090407" }]));
    write(join(ext, pack, "package.json"), JSON.stringify({ version: "1.131.2026090407", engines: { vscode: "^1.131.0" }, contributes: { localizations: [{ languageId: "zh-cn" }] } }));
    write(join(ide, "server", "data", "languagepacks.json"), JSON.stringify({ "zh-cn": { extensions: [{ extensionIdentifier: { id: "ms-ceintl.vscode-language-pack-zh-hans" }, version: "1.131.2026090407" }], translations: { vscode: join(ext, pack, "main.i18n.json") } } }));
    write(join(ide, "server", "data", "User", "settings.json"), '{\n  // 终端\n  "terminal.integrated.defaultProfile.windows": "PowerShell", /* x */\n  "editor.fontSize": 14,\n  "workbench.link": "http://example.com",\n}\n');
    write(join(ide, "server", "argv.json"), '{ // locale\n  "locale": "zh-cn",\n}');
    write(join(ide, "server", "data", "logs", "20261030T010101", "remoteagent.log"), `Extension host started --connection-token abcdef0123456789abcdef0123456789 ok\nGET /?tkn=secretvalue&x=1\n`);
    write(join(ide, "server", "data", "logs", "20261030T010101", "ptyhost.log"), "pty host started\n");

    const r = await call("ide");
    expect(r.servers).toEqual([expect.objectContaining({ commit, version: "1.143.1", binary: "bin/code-server", nodePty: { installed: true, native: ["pty.node"] } })]);
    expect(r.extensions).toEqual(["ms-ceintl.vscode-language-pack-zh-hans@1.131.2026090407"]);
    expect(r.languagePacks.installed).toEqual([expect.objectContaining({ languages: ["zh-cn"], engine: "^1.131.0", minorsBehindServer: 12 })]);
    expect(r.languagePacks.registered).toEqual([expect.objectContaining({ language: "zh-cn", translations: 1, mainFileExists: false })]);
    expect(r.locale.argv).toContainEqual({ file: join(ide, "server", "argv.json"), locale: "zh-cn" });
    const settings = r.locale.settings.find((s: { exists: boolean }) => s.exists);
    expect(settings.file).toBe(join(ide, "server", "data", "User", "settings.json"));
    expect(settings.relevant).toEqual({ "terminal.integrated.defaultProfile.windows": "PowerShell" });
    expect(r.dirs.extensions).toBe(ext);
    expect(r.logs.sessions[0].name).toBe("20261030T010101");
    expect(r.logs["ptyhost.log"]).toEqual(["pty host started"]);
    expect(JSON.stringify(r)).not.toMatch(/abcdef0123456789abcdef0123456789|secretvalue/);
    expect(r.logs["remoteagent.log"][0]).toContain("<已隐藏>");
    expect(Array.isArray(r.running.processes)).toBe(true);
    expect(r.running.own).toBeNull();
  }, 60_000);
});
