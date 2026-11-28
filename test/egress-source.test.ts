import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as tcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { launchRun } from "../src/agents/egress-run.ts";
import { httpGate, httpWatch } from "../src/agents/http-gate.ts";
import { prepareRun } from "../src/agents/runner.ts";
import { egressSupport } from "../src/agents/sandbox.ts";
import { launch } from "../src/agents/spawn.ts";
import { revokeToolToken } from "../src/agents/tools.ts";
import { catalogProfile } from "../src/agents/catalog.ts";
import { startServer } from "../src/server/http.ts";
import { testApp } from "./helpers.ts";

const support = egressSupport();
it.skipIf(!support.ok)("本人沙箱、执行器和浏览器分别按 HTTP 来源判定，Git SSH 握手可达 " + (support.reason ?? ""), async () => {
  const app = testApp();
  const root = mkdtempSync(join(tmpdir(), "egress-sources-"));
  const cwd = join(root, "work"), home = join(root, "home");
  mkdirSync(cwd); mkdirSync(home);
  vi.stubEnv("HOME", home);
  vi.stubEnv("SSH_AUTH_SOCK", "");
  vi.stubEnv("OMEM_DESKTOP_TOOLS", "off");
  const upstream = createServer((_, res) => res.end("fixture"));
  let banner = "";
  const ssh = tcpServer(socket => socket.once("data", b => { banner = b.toString(); socket.end(); }));
  const server = await startServer(app, { host: "127.0.0.1", port: 0, quiet: true });
  app.config.agents.ownSandbox.mode = "require";
  app.config.security.egress.mode = "all-sandboxed";
  const host = "127.0.0.1";
  app.config.security.operationRules = [
    { id: "agent", revision: 1, enabled: true, action: "deny", match: { kind: "http", host, source: "agent" } },
    { id: "browser", revision: 1, enabled: true, action: "deny", match: { kind: "http", host, source: "browser", methods: ["POST"] } },
    { id: "executor", revision: 1, enabled: true, action: "allow", match: { kind: "http", host, source: "executor" } },
    { id: "protected", revision: 1, enabled: true, action: "allow", match: { kind: "command", executable: "curl" } },
  ];
  const profile = catalogProfile({ id: "fixture", name: "fixture", command: "/bin/sh" });
  const prepared = prepareRun(app, { actor: { role: "coder" }, spaceId: "personal", runId: null, profile, cwd });
  try {
    for (const service of [upstream, ssh]) { service.listen(0, host); await once(service, "listening"); }
    const url = "http://127.0.0.1:" + (upstream.address() as { port: number }).port;
    const sshPort = (ssh.address() as { port: number }).port;
    const ctx = { app, actor: "agent" as const, tools: null, spaces: [], spaceId: "personal", runId: null };
    expect(httpWatch(app, ctx).watch).toEqual([{ host, methods: ["POST"] }]);
    expect((await httpGate(app, ctx, { method: "GET", url })).decision).toBe("allow");
    expect((await httpGate(app, ctx, { method: "POST", url })).decision).toBe("deny");
    const script = [
      // Use the regular Node client to address the Agent proxy, and the protected curl entry for the same URL.
      `node -e 'require("node:http").get(process.env.HTTP_PROXY,{path:process.argv[1]},r=>{console.log(r.statusCode);r.resume()})' "$1"`,
      'curl --noproxy "" --max-time 5 -fsS "$1"',
      'git ls-remote "ssh://127.0.0.1:$2/example" || :',
    ].join("\n");
    const child = await launchRun(profile, { app, mcp: prepared.mcp, ownSandbox: prepared.isolation.box }, (_, ownSandbox) =>
      launch("/bin/sh", ["-ec", script, "sh", url, String(sshPort)], { cwd, ownSandbox, env: prepared.mcp.env }));
    let out = "", err = "";
    child.stdout.on("data", bytes => out += bytes); child.stderr.on("data", bytes => err += bytes);
    child.stdin.end();
    expect((await once(child, "close"))[0], err).toBe(0);
    expect(out, err).toBe("403\nfixture");
    expect(banner, err).toMatch(/^SSH-2\.0-/);
  } finally {
    revokeToolToken(prepared.token); upstream.close(); ssh.close(); await server.close();
    vi.unstubAllEnvs(); app.db.close(); rmSync(root, { recursive: true, force: true }); rmSync(app.home, { recursive: true, force: true });
  }
}, 30000);
