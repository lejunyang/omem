import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
for (const path of [
  "dist/apps/server/src/cli.js",
  "dist/apps/server/src/main.js",
  "apps/web/dist/index.html",
  "packages/agent-runtime/roles/daily-assistant/1/manifest.json",
  "skills/omem-cli/SKILL.md",
  "packages/agent-runtime/roles/coding-agent/1/manifest.json",
  "packages/agent-runtime/roles/code-reviewer/1/manifest.json",
  "LICENSE",
]) {
  if (!existsSync(resolve(root, path)))
    throw Error(`发布包缺少 ${path}；先运行 osdk run build`);
}
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
if (pkg.private || pkg.license !== "Apache-2.0")
  throw Error("请检查发布元数据与许可证");
