import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const manifestPath = new URL("../dist/manifest.json", import.meta.url);
// <all_urls>：拾取截图（captureVisibleTab）只认 activeTab 或 <all_urls>，测试里没有用户点击，只能直接授予。
const e2eHostPermissions = ["http://127.0.0.1/*", "http://localhost/*", "<all_urls>"];
const vitestArgs = process.argv.slice(2).filter((arg) => arg !== "--");

// 直接用 node 跑各工具的入口文件：不依赖 pnpm 垫片（Windows 上 .cmd 需要 shell），各平台行为一致。
const bin = (path) => fileURLToPath(new URL(`../node_modules/${path}`, import.meta.url));
await run(process.execPath, [bin("vite/bin/vite.js"), "build"]);
await run(process.execPath, [fileURLToPath(new URL("./build-inject.mjs", import.meta.url))]);

const originalManifest = await readFile(manifestPath, "utf8");

try {
  const manifest = JSON.parse(originalManifest);
  manifest.host_permissions = [...new Set([...(manifest.host_permissions ?? []), ...e2eHostPermissions])];
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await run(process.execPath, [bin("vitest/vitest.mjs"), "run", "--config", "vitest.e2e.config.ts", ...vitestArgs]);
} finally {
  await writeFile(manifestPath, originalManifest);
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      stdio: "inherit"
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} exited with code ${code ?? "unknown"}.`));
    });
  });
}
