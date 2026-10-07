import { execFileSync } from "node:child_process";
import {
  readFile,
  writeFile,
  mkdir,
  mkdtemp,
  rename,
  rm,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
const runtime = resolve(".osdk/runtime/decision");
const manifest = JSON.parse(
  await readFile("scripts/startlux/upstream.json", "utf8"),
);
const directory = join(runtime, "upstream/startlux_decision");
await mkdir(runtime, { recursive: true });
const staging = await mkdtemp(join(runtime, ".upstream-prepare-"));
const pending = join(staging, "next");
const previous = join(staging, "previous");
let recoveryNeeded = false;
try {
  await mkdir(pending);
  for (const [file, hash] of Object.entries(manifest.files)) {
    const response = await fetch(
      `https://raw.githubusercontent.com/${manifest.repository}/${manifest.commit}/startlux_decision/${file}`,
    );
    if (!response.ok) throw Error(`Upstream download failed: ${file}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (createHash("sha256").update(bytes).digest("hex") !== hash)
      throw Error(`Upstream checksum mismatch: ${file}`);
    await writeFile(join(pending, file), bytes);
  }
  execFileSync(
    "osdk",
    [
      "exec",
      "--no-deps",
      "-t",
      "python@3.12.14",
      "-t",
      "pypi:uv@0.12.23",
      "--",
      "uv",
      "sync",
      "--system-certs",
      "--project",
      "scripts/startlux",
      "--frozen",
      "--python",
      "python",
    ],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        UV_PROJECT_ENVIRONMENT: join(runtime, "venv"),
        UV_PYTHON_DOWNLOADS: "never",
      },
    },
  );
  // Keep the working source intact until every download and dependency step has
  // succeeded. Replacing the whole package avoids mixing old and new modules.
  await mkdir(join(runtime, "upstream"), { recursive: true });
  let hadPrevious = false;
  try {
    await rename(directory, previous);
    hadPrevious = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    await rename(pending, directory);
  } catch (error) {
    if (hadPrevious) {
      try {
        await rename(previous, directory);
      } catch (restoreError) {
        // Do not delete the last working copy if filesystem permissions also
        // prevent rollback. Report its exact location for recovery.
        recoveryNeeded = true;
        throw Error(
          `StartLux 源码替换失败，旧源码保留在 ${previous}，请恢复后重跑 setup。`,
          { cause: restoreError },
        );
      }
    }
    throw error;
  }
} finally {
  if (!recoveryNeeded) await rm(staging, { recursive: true, force: true });
}
console.log(
  "StartLux 原生运行环境已准备。权重需单独 osdk model sync；正常启动不会下载。",
);
