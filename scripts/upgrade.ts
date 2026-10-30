#!/usr/bin/env node
/**
 * Bring this checkout up to date and install it as the global `omem`:
 *
 *   node scripts/upgrade.ts [--restart] [--no-pull] [--no-global] [--home <dir>]
 *   osdk run upgrade [--restart] …
 *
 * 1. git pull --ff-only          (skipped with --no-pull, or when this is not a git checkout)
 * 2. pnpm install --frozen-lockfile --filter omem-assistant   (only the app, not the docs site or VS Code extension)
 * 3. pnpm run build
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
step("安装依赖", "pnpm", ["install", "--frozen-lockfile", "--filter", "omem-assistant"]);
step("构建", "pnpm", ["run", "build"]);
if (!has("--no-global")) {
  // The package was called "omem" before it became omem-assistant: a global link under the old name
  // owns the `omem` command, and npm would refuse to link the new one over it.
  const globalRoot = spawnSync("npm", ["root", "-g"], { cwd: root, encoding: "utf8", shell: win }).stdout?.trim();
  if (globalRoot && existsSync(join(globalRoot, "omem"))) step("移除旧名字的全局 omem（npm uninstall -g omem）", "npm", ["uninstall", "-g", "omem"], { optional: true });
  step("安装为全局 omem（npm install -g .）", "npm", ["install", "-g", "."], { optional: true });
}
if (has("--restart")) step("重启后台服务", process.execPath, [join(root, "dist", "src", "cli.js"), ...(home ? ["--home", home] : []), "service", "restart"]);
console.log("\n✓ 完成");
