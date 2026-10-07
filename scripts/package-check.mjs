import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
for (const path of [
  "dist/apps/server/src/cli.js",
  "dist/apps/server/src/main.js",
  "apps/web/dist/index.html",
  "packages/agent-runtime/roles/daily-assistant/1/manifest.json",
  "skills/omem-cli/SKILL.md",
  "skills/omem-cli/references/dependencies.md",
  "skills/omem-cli/references/knowledge-outlines.md",
  "config/models.toml",
  "dist/scripts/document-prepare.js",
  "dist/scripts/document-models.js",
  "dist/scripts/startlux-prepare.js",
  "scripts/document-parser/convert.py",
  "scripts/document-parser/pyproject.toml",
  "scripts/document-parser/uv.lock",
  "scripts/startlux/worker.py",
  "scripts/startlux/selection.py",
  "scripts/startlux/pyproject.toml",
  "scripts/startlux/uv.lock",
  "scripts/startlux/upstream.json",
  "packages/agent-runtime/roles/knowledge-outliner/1/manifest.json",
  ".agents/skills/lieflat-less-ai-tone/SKILL.md",
  ".agents/skills/lieflat-less-ai-tone/LICENSE",
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
