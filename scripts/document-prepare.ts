import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

// Explicit setup only. Importing a file never downloads packages or weights.
const result = spawnSync("osdk", ["exec", "--no-deps", "-t", "python@3.12.14", "-t", "pypi:uv@0.12.23", "--", "uv", "sync", "--project", "scripts/document-parser", "--frozen", "--python", "python"], {
  stdio: "inherit", env: { ...process.env, UV_PROJECT_ENVIRONMENT: resolve(".osdk/runtime/docling/venv"), UV_PYTHON_DOWNLOADS: "never" },
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
