// The extension in a real VS Code against a seeded omem (test/seed.mts): `npm test` in vscode/.
// VS Code: VSCODE_PATH (an installed Code executable) or one @vscode/test-electron downloads.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runTests } from "@vscode/test-electron";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const home = mkdtempSync(join(tmpdir(), "omem-vscode-"));
const port = String(4300 + Math.floor(Math.random() * 80));
const server = spawn(process.execPath, ["vscode/test/seed.mts", home], { cwd: repoRoot, env: { ...process.env, OMEM_TEST_PORT: port }, stdio: ["ignore", "pipe", "inherit"] });
const seeded = await new Promise((ok, fail) => {
  let out = "";
  server.stdout.on("data", (d) => {
    out += d;
    const line = out.split("\n").find((l) => l.startsWith("{"));
    if (line) ok(JSON.parse(line));
  });
  server.on("exit", (code) => fail(new Error(`seed 退出：${code}`)));
});

let code = 0;
try {
  await runTests({
    ...(process.env.VSCODE_PATH ? { vscodeExecutablePath: process.env.VSCODE_PATH } : {}),
    extensionDevelopmentPath: resolve(here, ".."),
    extensionTestsPath: resolve(here, "suite.cjs"),
    launchArgs: [seeded.folder, "--disable-extensions", "--skip-welcome", "--skip-release-notes", "--user-data-dir", join(home, "vscode-user")],
    extensionTestsEnv: { OMEM_TEST_URL: seeded.url, OMEM_TEST_RUN: seeded.runId, OMEM_TEST_TOKEN: seeded.token },
  });
} catch (e) {
  console.error(e);
  code = 1;
} finally {
  server.kill();
}
process.exit(code);
