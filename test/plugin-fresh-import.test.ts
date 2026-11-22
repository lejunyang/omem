import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";

// Vitest loads modules itself, so Node's resolve hook (src/plugins/fresh-import.ts) is checked in a
// plain Node child process, the way the service imports a plugin's server file.
const SCRIPT = `
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { importFresh } from ${JSON.stringify(pathToFileURL(resolve("src/plugins/fresh-import.ts")).href)};
const [mode, dir] = process.argv.slice(2);
const load = async () => {
  const file = join(dir, "server.mjs");
  const m = mode === "entry-only" ? await import(pathToFileURL(file).href + "?v=" + Math.random()) : await importFresh(file, dir);
  return m.default();
};
const out = {};
mkdirSync(join(dir, "src"));
mkdirSync(join(dir, "node_modules", "dep"), { recursive: true });
writeFileSync(join(dir, "node_modules/dep/package.json"), JSON.stringify({ name: "dep", type: "module", exports: "./index.js" }));
writeFileSync(join(dir, "node_modules/dep/index.js"), "export const loaded = Math.random();");
writeFileSync(join(dir, "server.mjs"), "import { name } from './src/a.mjs';\\nimport { loaded } from 'dep';\\nexport default () => ({ name: name(), loaded });\\n");
writeFileSync(join(dir, "src/a.mjs"), "import { inner } from './b.mjs';\\nexport const name = () => 'old-' + inner;\\n");
writeFileSync(join(dir, "src/b.mjs"), "export const inner = 'b1';\\n");
const first = await load();
out.first = first.name;
// The entry now asks for an export only the new copy has (what broke a linked plugin's re-trust).
writeFileSync(join(dir, "server.mjs"), "import { name, fresh } from './src/a.mjs';\\nimport { loaded } from 'dep';\\nexport default () => ({ name: name() + fresh, loaded });\\n");
writeFileSync(join(dir, "src/a.mjs"), "import { inner } from './b.mjs';\\nexport const fresh = '!';\\nexport const name = () => 'new-' + inner;\\n");
writeFileSync(join(dir, "src/b.mjs"), "export const inner = 'b2';\\n");
try {
  const second = await load();
  out.second = second.name;
  out.sameDependency = second.loaded === first.loaded;
} catch (e) {
  out.error = e.message;
}
console.log(JSON.stringify(out));
`;

function run(mode: "entry-only" | "fresh") {
  const dir = mkdtempSync(join(tmpdir(), "omem-fresh-"));
  try {
    const script = join(dir, "check.mjs");
    writeFileSync(script, SCRIPT);
    const plugin = join(dir, "plugin");
    mkdirSync(plugin);
    return JSON.parse(execFileSync(process.execPath, [script, mode, plugin], { encoding: "utf8" }).trim().split("\n").at(-1)!);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

it("只给入口加版本号时，插件引用的文件仍是启动时的旧副本（重新信任插件报缺少导出的原因）", () => {
  const r = run("entry-only");
  expect(r.first).toBe("old-b1");
  expect(r.error).toMatch(/does not provide an export named 'fresh'/);
});

it("importFresh 让插件目录里被引用的文件一起换新，node_modules 里的依赖不重载", () => {
  expect(run("fresh")).toEqual({ first: "old-b1", second: "new-b2!", sameDependency: true });
});
