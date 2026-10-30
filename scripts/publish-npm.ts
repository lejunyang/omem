/**
 * Publish the npm packages whose version is not on npm yet (.github/workflows/publish.yml runs this
 * when a pushed commit says [publish]; it needs the build first):
 *
 *   omem-assistant    the app (the repository root)
 *   omem-plugin-sdk   packages/plugin-sdk
 *
 * A package whose version is already published is skipped, so bumping only one of them publishes
 * only that one. `--dry-run` shows what would be published without publishing.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dry = process.argv.includes("--dry-run");
const registry = "https://registry.npmjs.org";
// npm is a .cmd on Windows and needs a shell; the arguments here are fixed.
const npm = (args: string[], cwd: string) => spawnSync("npm", args, { cwd, encoding: "utf8", shell: process.platform === "win32" });

let failed = false;
for (const dir of [root, join(root, "packages", "plugin-sdk")]) {
  const { name, version } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name: string; version: string };
  const seen = npm(["view", `${name}@${version}`, "version", "--registry", registry], dir);
  if (seen.status === 0 && seen.stdout.trim() === version) {
    console.log(`${name}@${version} 已发布过，跳过`);
    continue;
  }
  console.log(`${dry ? "试发布" : "发布"} ${name}@${version}`);
  const args = ["publish", "--access", "public", "--registry", registry, ...(dry ? ["--dry-run"] : process.env.CI ? ["--provenance"] : [])];
  const r = spawnSync("npm", args, { cwd: dir, stdio: "inherit", shell: process.platform === "win32" });
  if (r.status !== 0) {
    console.error(`✗ ${name}@${version} 发布失败`);
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
