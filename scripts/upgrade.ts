#!/usr/bin/env node
/**
 * Bring this checkout up to date and install it as the global `omem`:
 *
 *   node scripts/upgrade.ts [--restart] [--no-pull] [--no-global] [--home <dir>]
 *   osdk run upgrade [--restart] …
 *
 * 1. git pull --ff-only          (skipped with --no-pull, or when this is not a git checkout)
 * 2. osdk install --no-deps, osdk deps   (the toolchain from osdk.toml, then [deps.pnpm]: only the app,
 *                                 from the registry osdk.toml names); without osdk, pnpm install
 *                                 --frozen-lockfile --filter @omem-ai/app with the machine's own registry
 * 3. osdk run build (pnpm run build without osdk)
 * 4. npm install -g .            (links the global `omem` to this checkout; --no-global skips;
 *                                 a failure here, e.g. no permission, is reported and skipped)
 * 5. omem service restart        (only with --restart; --home picks the data directory)
 *
 * The remote `update` command (src/core/peer-exec.ts) runs this with --no-global and
 * restarts the service itself.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(f);
const homeAt = argv.indexOf("--home");
const home = homeAt >= 0 ? argv[homeAt + 1] : undefined;
const win = process.platform === "win32";

function step(title: string, cmd: string, args: string[], opts: { optional?: boolean } = {}) {
  console.log(`\n▶ ${title}`);
  // pnpm/npm are .cmd shims on Windows and need a shell; the arguments here are fixed.
  const r = spawnSync(cmd, args, { cwd: root, stdio: "inherit", shell: win && cmd !== process.execPath });
  if (r.status === 0) return true;
  const why = r.error?.message ?? `退出码 ${r.status}`;
  if (opts.optional) {
    console.log(`  跳过：${title} 没有成功（${why}）`);
    return false;
  }
  console.error(`\n✗ ${title} 失败（${why}）`);
  process.exit(r.status || 1);
}

if (!has("--no-pull") && existsSync(join(root, ".git"))) step("拉取最新代码", "git", ["pull", "--ff-only"]);
if (spawnSync("osdk", ["--version"], { cwd: root, stdio: "ignore", shell: win }).status === 0) {
  // osdk installs the toolchain osdk.toml pins, then the app's dependencies ([deps.pnpm]) from the
  // registry it names, whatever this machine's .npmrc points at. osdk.toml is trusted first (its
  // install command and registry): this script builds and runs the checkout's own code anyway.
  // osdk writes what it resolved on this machine back into osdk.lock (a platform's tools, the deps
  // record). A deploy checkout must stay clean, or the next `git pull --ff-only` can refuse: a lock
  // that was clean before is put back.
  const lockClean = () => spawnSync("git", ["diff", "--quiet", "--", "osdk.lock"], { cwd: root }).status === 0;
  const cleanBefore = existsSync(join(root, ".git")) && lockClean();
  const restoreLock = () => {
    if (cleanBefore && !lockClean()) {
      spawnSync("git", ["checkout", "--", "osdk.lock"], { cwd: root });
      console.log("  osdk.lock 的本机改动已还原（保持检出干净）");
    }
  };
  // Also when a step fails: step() exits the process, and "exit" handlers still run (synchronously).
  process.on("exit", restoreLock);
  // Trust is bound to osdk.toml's content, so a changed one needs it again.
  step("信任 osdk.toml（osdk trust）", "osdk", ["--yes", "trust", join(root, "osdk.toml")]);
  // Which registry pnpm will use and why (read-only): the first thing to look at when installing fails.
  step("依赖源（osdk registry test pnpm）", "osdk", ["registry", "test", "pnpm"], { optional: true });
  // The toolchain, then the dependencies on their own: `osdk install` also rebuilds shims, and a machine
  // where two tools provide one command (a global `omem` linked into both node's and npm's prefix) fails
  // there after the dependencies are already in; that is the machine's to sort out, not a failed update.
  step("安装工具（osdk install --no-deps）", "osdk", ["--yes", "install", "--no-deps"], { optional: true });
  step("安装依赖（osdk deps）", "osdk", ["--yes", "deps"]);
  step("构建（osdk run build）", "osdk", ["--yes", "run", "build"]);
} else {
  // Without osdk: pnpm directly, with the machine's own registry. Without a TTY (peer update,
  // services) pnpm aborts instead of asking when it must rebuild node_modules.
  step("安装依赖", "pnpm", ["install", "--frozen-lockfile", "--filter", "@omem-ai/app", "--config.confirmModulesPurge=false"]);
  step("构建", "pnpm", ["run", "build"]);
}
if (!has("--no-global")) {
  // The package was called "omem", then "omem-assistant", before it became @omem-ai/app: a global
  // link under an old name owns the `omem` command, and npm would refuse to link the new one over it.
  const globalRoot = spawnSync("npm", ["root", "-g"], { cwd: root, encoding: "utf8", shell: win }).stdout?.trim();
  for (const old of ["omem", "omem-assistant"])
    if (globalRoot && existsSync(join(globalRoot, old))) step(`移除旧名字的全局 omem（npm uninstall -g ${old}）`, "npm", ["uninstall", "-g", old], { optional: true });
  step("安装为全局 omem（npm install -g .）", "npm", ["install", "-g", "."], { optional: true });
}
if (has("--restart")) step("重启后台服务", process.execPath, [join(root, "dist", "src", "cli.js"), ...(home ? ["--home", home] : []), "service", "restart"]);
console.log("\n✓ 完成");
