import { execFileSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { App } from "../src/core/app.ts";
import { overwriteLocal, snapshotStream } from "../src/core/pull.ts";
import { callTool, toolList } from "../src/agents/tools.ts";
import { BuildNeeded, buildPlan, installPlugin } from "../src/plugins/install.ts";
import { linkPlugin, readLinks, unlinkPlugin, watchLinkedPlugins, watchTree } from "../src/plugins/links.ts";
import { describePlugin, findPlugin, forgetPlugin, getPlugin, loadPlugins, manifestSchema, reloadLinked, trustPlugin } from "../src/plugins/registry.ts";
import { trustState } from "../src/plugins/trust.ts";
import { startServer } from "../src/server/http.ts";
import { testApp } from "./helpers.ts";

/**
 * Developing a plugin (docs/v2/flows.md §8, “安装”): `omem plugin link` reads a directory where it is,
 * trusted by directory, loaded again when it changes, this device only; a package from source is built
 * only after the owner has seen and confirmed the exact commands.
 */
let app: App;
const servers: FastifyInstance[] = [];
const dirs: string[] = [];
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), "omem-plugin-dev-"));
  dirs.push(d);
  return d;
};
const tools = () => new Set(toolList().map((t) => t.name));
const call = async (name: string) => (await callTool({ app, runId: null, spaceId: "personal", spaces: null, tools: new Set([name]), actor: "user", userId: "owner" }, name, {})).text;

/** A plugin being written: a tool whose answer tells which version of the file ran. */
function devPlugin(id = "devnotes", answer = "第一版") {
  const dir = scratch();
  writeFileSync(join(dir, "plugin.yaml"), `id: ${id}\nname: 开发中的笔记\n`);
  writeFileSync(join(dir, "server.mjs"), server(id, answer));
  return dir;
}
const server = (id: string, answer: string) => `export default function register(api) {
  api.tool({ name: "${id}_hello", description: "打个招呼", schema: api.z.object({}), handler: async () => ${JSON.stringify(answer)} });
}
`;

beforeEach(() => {
  app = testApp();
});
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const id of ["devnotes", "srcnotes"]) if (findPlugin(id)) forgetPlugin(id);
  app.db.close();
  rmSync(app.home, { recursive: true, force: true });
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.OMEM_TEST_BUILD_MARK;
  delete process.env.PLUGIN_BUILD_MARK;
});

describe("omem plugin link", () => {
  it("只链接这台机器上的插件目录，和内置、数据目录里的同名插件冲突时拒绝", async () => {
    await expect(linkPlugin(app, join(scratch(), "nope"))).rejects.toThrow(/没有这个目录/);
    await expect(linkPlugin(app, scratch())).rejects.toThrow(/plugin\.yaml/);
    await expect(linkPlugin(app, "\\\\fileserver\\share\\notes")).rejects.toThrow(/这台机器/);
    await expect(linkPlugin(app, "//fileserver/share/notes")).rejects.toThrow(/这台机器/);
    const builtin = scratch();
    writeFileSync(join(builtin, "plugin.yaml"), "id: english\nname: 冒名\n");
    await expect(linkPlugin(app, builtin)).rejects.toMatchObject({ status: 409 });
    mkdirSync(join(app.home, "plugins", "devnotes"), { recursive: true });
    await expect(linkPlugin(app, devPlugin())).rejects.toMatchObject({ status: 409 });
    expect(readLinks(app)).toEqual({});
  });

  it("不复制，按目录信任：改代码不用重新确认，重新加载后就是新代码；页面上标开发中", async () => {
    const dir = devPlugin();
    const r = await linkPlugin(app, dir);
    expect(r).toMatchObject({ id: "devnotes", replaced: false, again: false });
    expect(existsSync(join(app.home, "plugins", "devnotes"))).toBe(false);
    await loadPlugins(app);
    const d = describePlugin(getPlugin("devnotes"));
    expect(d).toMatchObject({ linked: true, source: "data", trust: "required", installed: null });
    expect(d.dir).toBe(r.dir);
    expect(tools().has("devnotes_hello")).toBe(false);
    // Isolated: each load is a fresh process, so the new file is what runs (vitest keeps imported files cached by path).
    await trustPlugin(app, "devnotes");
    expect(await call("devnotes_hello")).toBe("第一版");
    const record = JSON.parse(readFileSync(join(app.home, "secrets", "plugin-trust.json"), "utf8")).devnotes;
    expect(record).toMatchObject({ dir: r.dir, mode: "isolated" });
    writeFileSync(join(dir, "server.mjs"), server("devnotes", "第二版"));
    expect(trustState(app, "devnotes", r.dir, true)).toBe("trusted");
    expect(await reloadLinked(app, "devnotes")).toMatchObject({ linked: true, trust: "trusted" });
    expect(await call("devnotes_hello")).toBe("第二版");
    // The same code copied elsewhere is not trusted by that directory's record.
    expect(trustState(app, "devnotes", dir + "-copy", false)).toBe("changed");
  });

  it("运行中的服务：改了文件自动重新加载，unlink 后卸下，目录不动", async () => {
    const dir = devPlugin();
    await linkPlugin(app, dir);
    await reloadLinked(app, "devnotes");
    await trustPlugin(app, "devnotes");
    const events: unknown[] = [];
    const listen = (e: { type: string }) => { if (e.type === "plugin") events.push(e); };
    app.events.on("event", listen);
    const off = () => app.events.off("event", listen);
    const stop = watchLinkedPlugins(app, { delayMs: 50 });
    try {
      // A page under web/ is read on every request: no reload for it.
      mkdirSync(join(dir, "web"));
      writeFileSync(join(dir, "web", "index.html"), "<p>页面</p>");
      writeFileSync(join(dir, "server.mjs"), server("devnotes", "改过了"));
      await vi.waitFor(async () => expect(await call("devnotes_hello")).toBe("改过了"), { timeout: 8000, interval: 100 });
      expect(events).toContainEqual({ type: "plugin", plugin: "devnotes", conversationId: "" });
      expect(unlinkPlugin(app, "devnotes")).toBe(true);
      await vi.waitFor(() => expect(findPlugin("devnotes")).toBeNull(), { timeout: 8000, interval: 100 });
      expect(tools().has("devnotes_hello")).toBe(false);
      expect(existsSync(join(dir, "server.mjs"))).toBe(true);
      expect(trustState(app, "devnotes", dir, true)).toBe("required");
      expect(unlinkPlugin(app, "devnotes")).toBe(false);
    } finally {
      stop();
      off();
    }
  });

  it("链接着的 id 不能再安装；删除接口只去掉链接", async () => {
    const dir = devPlugin();
    await linkPlugin(app, dir);
    await expect(installPlugin(app, devPlugin())).rejects.toMatchObject({ status: 409, message: expect.stringContaining("unlink") });
    await reloadLinked(app, "devnotes");
    const s = await startServer(app, { port: 0, quiet: true });
    servers.push(s);
    expect((await s.inject({ method: "DELETE", url: "/api/plugins/devnotes" })).json()).toEqual({ ok: true, unlinked: true });
    expect(readLinks(app)).toEqual({});
    expect(findPlugin("devnotes")).toBeNull();
    expect(existsSync(join(dir, "plugin.yaml"))).toBe(true);
  });

  it("不随设备同步：快照里没有链接，拉取覆盖后本机的链接和信任还在", async () => {
    const dir = devPlugin();
    const r = await linkPlugin(app, dir);
    await reloadLinked(app, "devnotes");
    await trustPlugin(app, "devnotes", "inprocess");
    // What another device would get from this one.
    const snap = scratch();
    await pipeline(await snapshotStream(app), createWriteStream(join(snap, "snapshot.tar")));
    const listed = execFileSync("tar", ["-tf", "snapshot.tar"], { cwd: snap, encoding: "utf8" });
    expect(listed).not.toMatch(/links\.json|plugin-trust|(^|\/)plugins\//m);
    // This device taking another's data: its own links stay.
    const other = testApp();
    const theirs = scratch();
    await pipeline(await snapshotStream(other), createWriteStream(join(theirs, "snapshot.tar")));
    other.db.close();
    execFileSync("tar", ["-xf", "snapshot.tar"], { cwd: theirs });
    rmSync(join(theirs, "snapshot.tar"));
    const home = app.home;
    app.db.close();
    overwriteLocal(home, { dbDir: theirs, libraryDir: join(theirs, "library"), filesDir: join(theirs, "files"), fetchedFiles: readdirSync(join(theirs, "files")) });
    app = App.open(home);
    expect(readLinks(app)).toEqual({ devnotes: expect.objectContaining({ dir: r.dir }) });
    expect(trustState(app, "devnotes", r.dir, true)).toBe("trusted");
    rmSync(other.home, { recursive: true, force: true });
  });
});

describe("watching a plugin being written", () => {
  it("hears changes in subdirectories, also ones made after it started, and not in node_modules, .git or web", async (ctx) => {
    const dir = mkdtempSync(join(tmpdir(), "omem-tree-"));
    // Without a watcher from the system (Linux's inotify instances used up by other programs) the tree is looked over: the next test.
    try { watch(dir).close(); } catch { rmSync(dir, { recursive: true, force: true }); ctx.skip(); }
    mkdirSync(join(dir, "src", "lib"), { recursive: true });
    mkdirSync(join(dir, "node_modules", "x"), { recursive: true });
    const heard: string[] = [];
    const w = watchTree(dir, (name) => heard.push(name.replace(/\\/g, "/")));
    try {
      writeFileSync(join(dir, "node_modules", "x", "index.js"), "1");
      mkdirSync(join(dir, "web"));
      writeFileSync(join(dir, "web", "index.html"), "<p></p>");
      writeFileSync(join(dir, "src", "lib", "a.ts"), "1");
      await vi.waitFor(() => expect(heard).toContain("src/lib/a.ts"), { timeout: 5000, interval: 50 });
      mkdirSync(join(dir, "src", "fresh"));
      await vi.waitFor(() => expect(heard).toContain("src/fresh"), { timeout: 5000, interval: 50 });
      // Give the new directory's watcher a moment to be in place, then write into it.
      await new Promise((r) => setTimeout(r, 100));
      writeFileSync(join(dir, "src", "fresh", "b.ts"), "1");
      await vi.waitFor(() => expect(heard).toContain("src/fresh/b.ts"), { timeout: 5000, interval: 50 });
      expect(heard.filter((n) => /^(node_modules|web)(\/|$)/.test(n))).toEqual([]);
    } finally {
      w.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("when the system gives no watcher, looks the tree over instead and still hears a change", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omem-tree-"));
    mkdirSync(join(dir, "src"));
    mkdirSync(join(dir, "node_modules"));
    writeFileSync(join(dir, "src", "a.ts"), "1");
    let heard = 0;
    const w = watchTree(dir, () => heard++, { poll: true, pollMs: 30 });
    try {
      writeFileSync(join(dir, "node_modules", "x.js"), "1");
      await new Promise((r) => setTimeout(r, 120));
      expect(heard).toBe(0);
      writeFileSync(join(dir, "src", "a.ts"), "2");
      await vi.waitFor(() => expect(heard).toBeGreaterThan(0), { timeout: 3000, interval: 30 });
    } finally {
      w.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("从源码构建安装", () => {
  /** A plugin as source: its manifest points at dist/server.mjs, which only the build writes. */
  function sourcePackage(build = "node build.mjs", extra: Record<string, unknown> = {}) {
    const dir = scratch();
    writeFileSync(join(dir, "plugin.yaml"), "id: srcnotes\nname: 源码笔记\nserver: dist/server.mjs\n");
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "omem-plugin-srcnotes", version: "0.1.0", scripts: { build }, ...extra }));
    writeFileSync(join(dir, "build.mjs"), `import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
if (process.env.PLUGIN_BUILD_MARK) appendFileSync(process.env.PLUGIN_BUILD_MARK, "built\\n");
console.log("building in", process.cwd(), "secret:", process.env.OMEM_TEST_BUILD_MARK ?? "none");
mkdirSync("dist", { recursive: true });
writeFileSync("dist/server.mjs", ${JSON.stringify(server("srcnotes", "构建出来的"))});
`);
    return dir;
  }

  it("先列出命令，未确认不运行包里的任何脚本，也不安装", async () => {
    const mark = join(scratch(), "mark.txt");
    process.env.PLUGIN_BUILD_MARK = mark;
    const src = sourcePackage();
    const err = await installPlugin(app, src).catch((e) => e);
    expect(err).toBeInstanceOf(BuildNeeded);
    expect(err.status).toBe(409);
    expect(err.plan).toMatchObject({ id: "srcnotes", missing: ["dist/server.mjs"], commands: ["npm run build"], scripts: { build: "node build.mjs" } });
    expect(existsSync(mark)).toBe(false);
    expect(existsSync(join(app.home, "plugins", "srcnotes"))).toBe(false);
    // A key for some other plan is no confirmation.
    await expect(installPlugin(app, src, { build: "0".repeat(32) })).rejects.toBeInstanceOf(BuildNeeded);
    expect(existsSync(mark)).toBe(false);
    // The package changed after it was shown: asked again.
    writeFileSync(join(src, "package.json"), JSON.stringify({ name: "omem-plugin-srcnotes", version: "0.1.0", scripts: { build: "node build.mjs", postbuild: "node build.mjs" } }));
    const again = await installPlugin(app, src, { build: err.plan.key }).catch((e) => e);
    expect(again).toBeInstanceOf(BuildNeeded);
    expect(again.plan.key).not.toBe(err.plan.key);
    expect(again.plan.scripts).toEqual({ build: "node build.mjs", postbuild: "node build.mjs" });
    expect(existsSync(mark)).toBe(false);
  });

  it("依赖先装（不跑安装脚本），有锁文件用 npm ci；已经构建过或没有 build 脚本的不用构建", () => {
    const m = manifestSchema.parse({ id: "srcnotes", name: "源码笔记", server: "dist/server.mjs", services: [{ name: "probe", command: "node", args: ["dist/probe.js"] }] });
    const withDeps = sourcePackage("vite build", { devDependencies: { vite: "7.3.1" } });
    expect(buildPlan(withDeps, m, "x")!.plan).toMatchObject({ missing: ["dist/server.mjs", "dist/probe.js"], commands: ["npm install --ignore-scripts --no-audit --no-fund --no-package-lock", "npm run build"] });
    writeFileSync(join(withDeps, "package-lock.json"), "{}");
    expect(buildPlan(withDeps, m, "x")!.plan.commands[0]).toBe("npm ci --ignore-scripts --no-audit --no-fund");
    mkdirSync(join(withDeps, "dist"));
    writeFileSync(join(withDeps, "dist", "server.mjs"), "");
    writeFileSync(join(withDeps, "dist", "probe.js"), "");
    expect(buildPlan(withDeps, m, "x")).toBeNull();
    const noScript = scratch();
    writeFileSync(join(noScript, "package.json"), "{}");
    expect(buildPlan(noScript, m, "x")).toBeNull();
    expect(() => manifestSchema.parse({ id: "srcnotes", name: "x", server: "../outside.js" })).toThrow(/相对路径/);
    // The trust hash leaves these directories out: a server file there could change unnoticed.
    expect(() => manifestSchema.parse({ id: "srcnotes", name: "x", server: "web/server.js" })).toThrow(/信任不核对/);
    expect(() => manifestSchema.parse({ id: "srcnotes", name: "x", server: "node_modules/x/server.js" })).toThrow(/信任不核对/);
  });

  it("确认后在隔离的子进程里构建：在解开的目录里、不带 omem 的变量、输出进日志，再照常等信任", async () => {
    const mark = join(scratch(), "mark.txt");
    process.env.PLUGIN_BUILD_MARK = mark;
    process.env.OMEM_TEST_BUILD_MARK = "不该被构建看到";
    const src = sourcePackage();
    const { plan } = (await installPlugin(app, src).catch((e) => e)) as BuildNeeded;
    const r = await installPlugin(app, src, { build: plan.key });
    expect(readFileSync(mark, "utf8")).toBe("built\n");
    expect(r).toMatchObject({ id: "srcnotes", version: "0.1.0", replaced: false });
    expect(existsSync(join(r.dir, "dist", "server.mjs"))).toBe(true);
    // The source directory itself is left as it was: the build ran in the unpacked copy.
    expect(existsSync(join(src, "dist"))).toBe(false);
    const log = readFileSync(r.buildLog!, "utf8");
    expect(log).toContain("$ npm run build");
    expect(log).toContain("secret: none");
    expect(log).toMatch(/building in .*omem-plugin-/);
    expect(log).not.toContain(`building in ${src}`);
    await loadPlugins(app, [{ dir: join(app.home, "plugins"), source: "data" }]);
    expect(describePlugin(getPlugin("srcnotes"))).toMatchObject({ trust: "required", linked: false });
    expect(tools().has("srcnotes_hello")).toBe(false);
    await trustPlugin(app, "srcnotes", "inprocess");
    expect(await call("srcnotes_hello")).toBe("构建出来的");
  });

  it("构建失败：报出退出码和日志位置，什么都不装", async () => {
    const src = sourcePackage("node -e \"process.exit(3)\"");
    const { plan } = (await installPlugin(app, src).catch((e) => e)) as BuildNeeded;
    await expect(installPlugin(app, src, { build: plan.key })).rejects.toThrow(/退出码 3[\s\S]*plugin-builds/);
    expect(existsSync(join(app.home, "plugins", "srcnotes"))).toBe(false);
  });

  it("网页的安装入口：第一次只返回要运行的命令，带上确认的 key 再装", async () => {
    const mark = join(scratch(), "mark.txt");
    process.env.PLUGIN_BUILD_MARK = mark;
    const src = sourcePackage();
    const s = await startServer(app, { port: 0, quiet: true });
    servers.push(s);
    const first = await s.inject({ method: "POST", url: "/api/plugins/install", payload: { source: src } });
    expect(first.statusCode).toBe(200);
    const { build } = first.json();
    expect(build).toMatchObject({ id: "srcnotes", commands: ["npm run build"] });
    expect(existsSync(mark)).toBe(false);
    expect(existsSync(join(app.home, "plugins", "srcnotes"))).toBe(false);
    const second = await s.inject({ method: "POST", url: "/api/plugins/install", payload: { source: src, build: build.key } });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ id: "srcnotes", plugin: { id: "srcnotes", trust: "required" } });
    expect(readFileSync(mark, "utf8")).toBe("built\n");
  });
});
