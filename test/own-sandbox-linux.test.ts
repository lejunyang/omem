import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { testApp } from "./helpers.ts";
import { startServer } from "../src/server/http.ts";
import { agentProfileSchema } from "../src/core/config.ts";
import { prepareRun, mcpBridge } from "../src/agents/runner.ts";
import { revokeToolToken } from "../src/agents/tools.ts";
import { openAcp } from "../src/agents/acp.ts";
import { sandboxSupport } from "../src/agents/sandbox.ts";
import { launch } from "../src/agents/spawn.ts";

const support = sandboxSupport();
it.skipIf(!support.ok)("本人沙箱中的工作区、快照、命令垫片和 MCP " + (support.reason ?? ""), async () => {
  const app = testApp();
  const server = await startServer(app, { host: "127.0.0.1", port: 0, quiet: true });
  const root = mkdtempSync(join(tmpdir(), "own-mounts-"));
  const work = join(root, "work"), extra = join(root, "extra"), home = join(root, "home");
  const snapshot = join(app.runsDir, "sample", "snap");
  for (const dir of [work, extra, home, snapshot, join(app.home, "secrets")]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(app.home, "secrets", "sample"), "private");
  app.config.agents.ownSandbox = { mode: "require", writable: [extra], hidden: [] };
  app.config.security.operationRules = [{ id: "blocked", enabled: true, revision: 1, action: "deny", match: { kind: "command", executable: "acme" } }];
  app.config.agents.fullAccess = "sandboxed";
  const profile = agentProfileSchema.parse({ id: "fixture", transport: "acp", command: process.execPath, args: [resolve("test/fake-acp-agent.ts")], env: { FAKE_MODE: "peer-gate", FAKE_LEGACY: "1" } });
  const prep = prepareRun(app, { actor: { role: "coder" }, spaceId: "personal", runId: null, profile, cwd: work });
  const box = prep.isolation.box!;
  box.runtime.push(home); // Restore the fixture HOME read-only under the private /tmp.
  box.snapshot = snapshot;
  const env = { ...prep.mcp.env, HOME: home };
  const exec = async (script: string, cwd = work, readOnly = false) => {
    const child = launch("/bin/sh", ["-ec", script], { cwd, env, ownSandbox: { ...box, readOnly },
      workspace: readOnly ? { ro: [work], rw: [] } : undefined });
    let output = "";
    child.stderr.on("data", b => output += b); child.stdout.on("data", b => output += b);
    const [code] = await once(child, "close");
    expect(code, output).toBe(0);
    return output;
  };
  try {
    await exec(`touch created "${extra}/allowed"; test -d "$HOME"; ! touch "$HOME/elsewhere" || exit 1
      test ! -e "${app.home}/secrets/sample"; test ! -e "${app.home}/omem.db"
      omem tool help search
      acme && exit 1; test "$?" = 126`);
    expect(existsSync(join(work, "created"))).toBe(true);
    await exec(`! touch "${work}/forbidden" || exit 2; node -e "require('fs').writeFileSync('tested','ok')"`, snapshot, true);
    expect(existsSync(join(snapshot, "tested"))).toBe(true);
    const status: string[] = [];
    const handle = await openAcp(profile, { cwd: work, ownSandbox: box, fullAccess: prep.fullAccess, mcp: prep.mcp, acpWritable: prep.acpWritable }, e => {
      if (e.type === "status") status.push(e.text);
    });
    try {
      const response = await handle.prompt("check", () => {});
      expect(status.join(" ")).toContain("完全访问：yolo（后端自己的沙箱和审批关了");
      expect(JSON.parse(response.text).status).toBe(126);
    } finally { handle.close(); }
    const bridge = mcpBridge();
    const child = launch(bridge.command, bridge.args, { cwd: work, env, ownSandbox: box });
    const result = once(child.stdout, "data");
    const closed = once(child, "close");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n");
    try { expect(String(await Promise.race([result, closed]))).toContain('"tools"'); }
    finally { child.stdin.end(); await closed; }
  } finally { revokeToolToken(prep.token); await server.close(); app.db.close(); }
}, 30000);
