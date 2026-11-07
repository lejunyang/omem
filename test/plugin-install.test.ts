import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { toolList } from "../src/agents/tools.ts";
import { installPlugin, parseSource, removeInstalled, setInstallFetchForTests } from "../src/plugins/install.ts";
import { describePlugin, forgetPlugin, getPlugin, loadPlugins, reloadPlugin, setPluginEnabled, trustPlugin } from "../src/plugins/registry.ts";
import { testApp } from "./helpers.ts";

/**
 * Someone else's plugin (docs/v2/plugins.md, “第三方插件”): installed from a GitHub tag into the data
 * directory, its code waiting for trust, its declared permissions enforced, turned off and on, removed.
 */
const tools = () => new Set(toolList().map((t) => t.name));

/** A plugin packed the way GitHub serves a tag: one top directory in a .tar.gz. */
function tarball(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "omem-pkg-"));
  const top = join(root, "notes-v1");
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(top, name, ".."), { recursive: true });
    writeFileSync(join(top, name), text);
  }
  const out = join(root, "pkg.tgz");
  const r = spawnSync("tar", ["-czf", "pkg.tgz", "notes-v1"], { cwd: root });
  if (r.status !== 0) throw new Error(String(r.stderr));
  return readFileSync(out);
}
const server = (write: boolean) => `export default function register(api) {
  api.tool({ name: "notes_count", description: "数笔记", schema: api.z.object({}), write: ${write}, handler: async () => "3" });
}
`;

describe("plugin install", async () => {
  const app = testApp();
  await loadPlugins(app);
  let served: Buffer = Buffer.alloc(0);
  const asked: string[] = [];
  setInstallFetchForTests((async (url: string | URL | Request) => {
    asked.push(String(url));
    return new Response(new Uint8Array(served));
  }) as typeof fetch);
  afterAll(() => setInstallFetchForTests(null));

  it("reads where a plugin comes from", () => {
    expect(parseSource("npm:omem-plugin-notes@1.2.0")).toEqual({ kind: "npm", spec: "omem-plugin-notes@1.2.0" });
    expect(parseSource("@acme/omem-notes")).toEqual({ kind: "npm", spec: "@acme/omem-notes" });
    expect(parseSource("github:acme/notes#v1.0.0")).toEqual({ kind: "github", owner: "acme", repo: "notes", ref: "v1.0.0" });
    expect(parseSource("https://github.com/acme/notes/tree/v1.0.0")).toMatchObject({ kind: "github", ref: "v1.0.0" });
    // A branch would change under the trust: a tag or commit is required.
    expect(() => parseSource("github:acme/notes")).toThrow(/tag/);
    expect(() => parseSource("rm -rf /")).toThrow(/看不懂/);
  });

  it("installs from a GitHub tag; its code waits for trust and shows what it declares", async () => {
    served = tarball({ "plugin.yaml": "id: notes\nname: 笔记\npermissions: { write: true }\n", "server.mjs": server(true), "package.json": '{"version":"1.0.0"}' });
    const r = await installPlugin(app, "github:acme/notes#v1.0.0");
    expect(asked.at(-1)).toBe("https://codeload.github.com/acme/notes/tar.gz/v1.0.0");
    expect(r).toMatchObject({ id: "notes", version: "1.0.0", replaced: false });
    expect(JSON.parse(readFileSync(join(r.dir, ".omem-install.json"), "utf8")).source).toBe("github:acme/notes#v1.0.0");
    const d = await reloadPlugin(app, "notes");
    expect(d).toMatchObject({ trust: "required", version: "1.0.0", installed: { source: "github:acme/notes#v1.0.0" }, permissions: { writes: true } });
    expect(tools().has("notes_count")).toBe(false);
    await trustPlugin(app, "notes");
    expect(tools().has("notes_count")).toBe(true);
    expect(describePlugin(getPlugin("notes")).permissions.tools).toEqual([{ name: "notes_count", write: true, approval: false }]);
  });

  it("turns a plugin off and on without a restart", async () => {
    await setPluginEnabled(app, "notes", false);
    expect(tools().has("notes_count")).toBe(false);
    expect(app.config.plugins.disabled).toContain("notes");
    expect(describePlugin(getPlugin("notes")).enabled).toBe(false);
    await setPluginEnabled(app, "notes", true);
    expect(tools().has("notes_count")).toBe(true);
  });

  it("updates to a new tag, and the changed code needs trust again", async () => {
    served = tarball({ "plugin.yaml": "id: notes\nname: 笔记\npermissions: { write: true }\n", "server.mjs": server(true) + "// v2\n", "package.json": '{"version":"2.0.0"}' });
    forgetPlugin("notes");
    const r = await installPlugin(app, "github:acme/notes#v2.0.0");
    expect(r).toMatchObject({ version: "2.0.0", replaced: true });
    expect((await reloadPlugin(app, "notes")).trust).toBe("changed");
    expect(tools().has("notes_count")).toBe(false);
  });

  it("refuses code that does more than its manifest declares", async () => {
    served = tarball({ "plugin.yaml": "id: sneaky\nname: 偷偷写\n", "server.mjs": server(true).replace(/notes_/g, "sneaky_") });
    await installPlugin(app, "github:acme/sneaky#v1");
    await reloadPlugin(app, "sneaky");
    await expect(trustPlugin(app, "sneaky")).rejects.toThrow(/permissions\.write/);
    expect(tools().has("sneaky_count")).toBe(false);
  });

  it("keeps built-in ids and the owner's own plugins", async () => {
    served = tarball({ "plugin.yaml": "id: english\nname: 冒名\n" });
    await expect(installPlugin(app, "github:acme/english#v1")).rejects.toThrow(/内置/);
    mkdirSync(join(app.home, "plugins", "mine"), { recursive: true });
    writeFileSync(join(app.home, "plugins", "mine", "plugin.yaml"), "id: mine\nname: 我的\n");
    served = tarball({ "plugin.yaml": "id: mine\nname: 覆盖\n" });
    await expect(installPlugin(app, "github:acme/mine#v1")).rejects.toThrow(/不覆盖/);
    expect(() => removeInstalled(app, "mine")).toThrow(/不是装进来的/);
  });

  it("removes an installed plugin", () => {
    forgetPlugin("notes");
    removeInstalled(app, "notes");
    expect(existsSync(join(app.home, "plugins", "notes"))).toBe(false);
    expect(tools().has("notes_count")).toBe(false);
  });
});
