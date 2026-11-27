import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { prepareRun } from "../src/agents/runner.ts";
import { sandboxSupport } from "../src/agents/sandbox.ts";
import { launch } from "../src/agents/spawn.ts";
import { revokeToolToken } from "../src/agents/tools.ts";
import * as lark from "../src/channels/lark-cli-path.ts";
import { agentProfileSchema } from "../src/core/config.ts";
import { startServer } from "../src/server/http.ts";
import { testApp } from "./helpers.ts";

const support = sandboxSupport();
it.skipIf(!support.ok)("飞书 CLI 由同身份执行器读写两处登录，Agent 看不到模拟凭据 " + (support.reason ?? ""), async () => {
  const app = testApp();
  const root = mkdtempSync(join(tmpdir(), "lark-sandbox-"));
  const home = join(root, "home"), cwd = join(root, "work"), pkg = join(root, "cli");
  const binary = join(pkg, "bin/lark-cli"), script = join(pkg, "scripts/run.js");
  const config = join(home, ".lark-cli"), login = join(home, ".local/share/lark-cli");
  for (const dir of [config, login, cwd, join(pkg, "bin"), join(pkg, "scripts")]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(config, "profile"), "example");
  writeFileSync(join(login, "state"), "old");
  writeFileSync(script, "process.exit(22);");
  writeFileSync(binary, '#!/bin/sh\nset -e\ntest "$(cat "$HOME/.lark-cli/profile")" = example\ntest "$(cat "$HOME/.local/share/lark-cli/state")" = old\necho renewed > "$HOME/.local/share/lark-cli/state"\n', { mode: 0o755 });
  vi.spyOn(lark, "larkCliInstallation").mockReturnValue({ root: pkg, binary, script });
  vi.stubEnv("HOME", home);
  const server = await startServer(app, { host: "127.0.0.1", port: 0, quiet: true });
  app.config.agents.ownSandbox.mode = "require";
  const profile = agentProfileSchema.parse({ id: "fixture", transport: "acp", command: "/bin/sh" });
  const prep = prepareRun(app, { actor: { role: "coder" }, spaceId: "personal", runId: null, profile, cwd });
  const box = prep.isolation.box!;
  box.plan.ro.push(home); // Make the fake HOME visible under /tmp before applying its login masks.
  try {
    const child = launch("/bin/sh", ["-ec", 'test ! -s "$HOME/.lark-cli/profile"; test ! -s "$HOME/.local/share/lark-cli/state"; lark-cli'], { cwd, env: prep.mcp.env, ownSandbox: box });
    let stderr = "";
    child.stderr.on("data", bytes => stderr += bytes);
    expect((await once(child, "close"))[0], stderr).toBe(0);
    expect(readFileSync(join(login, "state"), "utf8")).toBe("renewed\n");
  } finally {
    revokeToolToken(prep.token); await server.close(); vi.restoreAllMocks(); vi.unstubAllEnvs();
    app.db.close(); rmSync(root, { recursive: true, force: true }); rmSync(app.home, { recursive: true, force: true });
  }
});
