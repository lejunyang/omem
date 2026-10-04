import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { llamaTool } from "./decision-models/client.js";

// Optional experiment runtime. Normal application startup never installs Python,
// packages or model weights. osdk owns Python/uv, uv.lock owns Python packages.
const run = (args: string[]) => {
  const result = spawnSync("osdk", args, {
    stdio: "inherit",
    env: {
      ...process.env,
      UV_PROJECT_ENVIRONMENT: resolve(
        ".repo-review/runtime/decision-models/venv",
      ),
      UV_PYTHON_DOWNLOADS: "never",
    },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
};
run(["install", "python@3.12.14"]);
run(["install", llamaTool, "--prerelease", "allow"]);
run([
  "exec",
  "--no-deps",
  "-t",
  "python@3.12.14",
  "-t",
  "pypi:uv@0.12.23",
  "--",
  "uv",
  "sync",
  "--project",
  "scripts/decision-models",
  "--frozen",
  "--python",
  "python",
]);
