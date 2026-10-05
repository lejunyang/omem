import { execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
const runtime = resolve(".osdk/runtime/decision");
const manifest = JSON.parse(await readFile("scripts/startlux/upstream.json", "utf8"));
const directory = join(runtime, "upstream/startlux_decision");
await mkdir(directory, { recursive: true });
for (const [file, hash] of Object.entries(manifest.files)) {
  const response = await fetch(`https://raw.githubusercontent.com/${manifest.repository}/${manifest.commit}/startlux_decision/${file}`);
  if (!response.ok) throw Error(`Upstream download failed: ${file}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== hash) throw Error(`Upstream checksum mismatch: ${file}`);
  await writeFile(join(directory, file), bytes);
}
execFileSync("osdk", ["exec", "--no-deps", "-t", "python@3.12.14", "-t", "pypi:uv@0.12.23", "--", "uv", "sync", "--project", "scripts/startlux", "--frozen", "--python", "python"], {
  stdio: "inherit", env: { ...process.env, UV_PROJECT_ENVIRONMENT: join(runtime, "venv"), UV_PYTHON_DOWNLOADS: "never" },
});
console.log("StartLux 原生运行环境已准备。权重需单独 osdk model sync；正常启动不会下载。");
