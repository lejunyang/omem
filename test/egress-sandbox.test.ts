import { expect, it } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { egressSupport } from "../src/agents/sandbox.ts";
import { launch } from "../src/agents/spawn.ts";
import { launchRun, egressStatus } from "../src/agents/egress-run.ts";
import { issueToolToken, revokeToolToken } from "../src/agents/tools.ts";
import { catalogProfile } from "../src/agents/catalog.ts";
import { mcpBridge } from "../src/agents/runner.ts";
import { createRun, runEvents } from "../src/agents/runs.ts";
import { startServer } from "../src/server/http.ts";
import { testApp } from "./helpers.ts";

const support = egressSupport();
it.skipIf(!support.ok)("真实 bubblewrap 中 curl 直连失败、按规则访问、命令回调核对令牌 " + (support.reason ?? ""), async () => {
  const app = testApp();
  app.config.agents.accountIsolation = "require";
  const home = join(app.home, "account");
  mkdirSync(home);
  const seen: string[] = [];
  const upstream = createServer((req, res) => { seen.push(req.url!); res.end("upstream"); });
  const callback = await startServer(app, { port: 0, host: "127.0.0.1", quiet: true });
  const runId = createRun(app, { kind: "ask", title: "代理验证" }).id;
  const token = issueToolToken({ runId, userId: "member", spaceId: "personal", actor: "agent", spaces: [], tools: null });
  try {
    upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
    const origin = (s: typeof upstream) => "http://127.0.0.1:" + (s.address() as { port: number }).port;
    const baseUrl = app.baseUrl!;
    app.config.security.operationRules = [{ id: "read", revision: 1, enabled: true, action: "allow", match: { kind: "http", host: "127.0.0.1", pathRegex: "^/ok$" } }];
    const profile = { ...catalogProfile({ id: "fixture", name: "fixture", command: "curl" }), ownAccount: { userId: "member", backend: "fixture", home, ro: [], hide: [app.home], env: {} } };
    const script = [
      'curl -sf --max-time 2 --noproxy "*" "$1/direct" && exit 7',
      'curl -sf --max-time 5 --noproxy "" "$1/ok" || exit 8',
      'curl -s --max-time 5 --noproxy "" -w "%{http_code}" "$1/blocked" || exit 9',
      'curl -sf --max-time 5 -H "Authorization: Bearer $OMEM_TOKEN" "$OMEM_URL/api/tools" | grep -q tools || exit 10',
      'curl -sf --max-time 5 -H "Authorization: Bearer $OMEM_TOKEN" -H "Content-Type: application/json" -d \'{"command":"sample","args":[],"cwd":"/tmp"}\' "$OMEM_URL/api/command-gate" || exit 11',
      'curl -sf --max-time 5 -H "Authorization: Bearer $OMEM_TOKEN" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d \'{"jsonrpc":"2.0","id":1,"method":"tools/list"}\' "$OMEM_URL/mcp" | grep -q tools || exit 12',
      'curl -s --max-time 5 -o /dev/null -w "%{http_code}" "$OMEM_URL/api/tools"',
    ].join("\n");
    const child = await launchRun(profile, { app, mcp: { baseUrl, url: baseUrl + "/mcp", token, stdio: { command: "", args: [] } } }, sandbox =>
      launch("/bin/sh", ["-c", script, "sh", origin(upstream)], { cwd: home, sandbox, env: { OMEM_URL: baseUrl, OMEM_TOKEN: token } }));
    let out = "", err = "";
    child.stdout.on("data", b => out += b); child.stderr.on("data", b => err += b);
    const [code] = await once(child, "exit");
    expect(code, err + out).toBe(0);
    expect(out).toMatch(/upstream.*403.*"decision":"allow".*403/s);
    expect(seen).toEqual(["/ok"]);
    const bridge = mcpBridge();
    const stdio = await launchRun(profile, { app, mcp: {baseUrl,url:baseUrl+"/mcp",token,stdio:bridge} }, sandbox =>
      launch(bridge.command, bridge.args, {cwd:home,sandbox,env:{OMEM_URL:baseUrl,OMEM_TOKEN:token}}));
    const exit = once(stdio,"exit");
    const output = once(stdio.stdout,"data");
    stdio.stdin.write(JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/list"}) + "\n");
    try {
      expect(String(await Promise.race([output,exit]))).toContain('"tools"');
    } finally { stdio.stdin.end(); await exit; }
    // Start a second process in the same run, revoke its token between two callback requests.
    const script2 = 'echo ready; read next; curl -sf --max-time 2 -H "Authorization: Bearer $OMEM_TOKEN" "$OMEM_URL/api/tools"';
    const second = await launchRun(profile, { app, mcp: { baseUrl, url: baseUrl + "/mcp", token, stdio: { command: "", args: [] } } }, sandbox =>
      launch("/bin/sh", ["-c", script2], { cwd: home, sandbox, env: { OMEM_URL: baseUrl, OMEM_TOKEN: token } }));
    await once(second.stdout, "data");
    revokeToolToken(token);
    second.stdin.end("retry\n");
    expect((await once(second, "exit"))[0]).not.toBe(0);
    expect(egressStatus(app).runs[0]).toMatchObject({ runId, hosts: [{ count: 2, denied: 1 }] });
    expect(runEvents(app, runId).filter(r => r.type === "status" && (r.data as {kind?:string}).kind === "egress")).toHaveLength(1);
  } finally { revokeToolToken(token); upstream.close(); await callback.close(); app.db.close(); }
}, 20000);

it.skipIf(!support.ok)("本人沙箱可经本轮代理访问允许的地址 " + (support.reason ?? ""), async () => {
  const { ownRun } = await import("../src/agents/own-run.ts");
  const { egressRequested } = await import("../src/agents/sandbox.ts");
  const app = testApp();
  const cwd = join(app.home, "workspaces", "fixture");
  mkdirSync(cwd, { recursive: true });
  const profile = catalogProfile({ id: "fixture", name: "fixture", command: "/bin/sh" });
  const upstream = createServer((_req, res) => res.end("fixture"));
  try {
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const url = "http://127.0.0.1:" + (upstream.address() as { port: number }).port + "/ok";
    expect(egressRequested(app.config, profile, true)).toBe(false);
    app.config.security.egress.mode = "all-sandboxed";
    app.config.agents.ownSandbox.mode = "require";
    app.config.security.operationRules = [{ id: "fixture", revision: 1, enabled: true, action: "allow", match: { kind: "http", host: "127.0.0.1" } }];
    const box = ownRun(app, profile, cwd, false).box!;
    // Keep the test independent of the local user's cache and backend state.
    box.state = [];
    box.plan.rw = [cwd];
    const nodeFetch = process.allowedNodeEnvironmentFlags.has("--use-env-proxy")
      ? `; NO_PROXY= no_proxy= node -e 'fetch(process.argv[1]).then(async r=>process.stdout.write(await r.text()))' "$1"` : "";
    const child = await launchRun(profile, { app, ownSandbox: box }, (_account, ownSandbox) =>
      launch("/bin/sh", ["-ec", 'if curl -fs --noproxy "*" --max-time 2 "$1"; then exit 1; fi; curl -fs --noproxy "" --max-time 5 "$1"' + nodeFetch, "sh", url], { cwd, ownSandbox }));
    let out = "", err = "";
    child.stdout.on("data", chunk => out += chunk);
    child.stderr.on("data", chunk => err += chunk);
    expect((await once(child, "close"))[0], err).toBe(0);
    expect(out).toBe(nodeFetch ? "fixturefixture" : "fixture");
  } finally { upstream.close(); app.db.close(); }
});
