import { once } from "node:events";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { expect, it, vi } from "vitest";
import { catalogProfile } from "../src/agents/catalog.ts";
import { launchRun } from "../src/agents/egress-run.ts";
import { createRun } from "../src/agents/runs.ts";
import { getSession, closeSession } from "../src/remote/sessions.ts";
import { prepareRun } from "../src/agents/runner.ts";
import { egressSupport } from "../src/agents/sandbox.ts";
import { launch } from "../src/agents/spawn.ts";
import { revokeToolToken } from "../src/agents/tools.ts";
import { startServer } from "../src/server/http.ts";
import { testApp } from "./helpers.ts";

const support = egressSupport();
it.skipIf(!support.ok)("沙箱经执行器运行 aad，共享本轮辅助进程，Agent 无法连接其监听端口 " + (support.reason ?? ""), async () => {
  const app = testApp(), root = mkdtempSync(join(tmpdir(), "desktop-fixture-"));
  const cwd = join(root, "work"), home = join(root, "home"), bin = join(root, "bin");
  for (const p of [cwd, bin, join(home, ".config", "google-chrome")]) mkdirSync(p, { recursive: true });
  writeFileSync(join(home, ".config", "google-chrome", "fixture"), "private");
  const profiles = join(app.home, "remote", "profiles");
  mkdirSync(profiles, { recursive: true }); writeFileSync(join(profiles, "fixture"), "managed");
  const display = createServer();
  display.listen(join(root, "wayland")); await once(display, "listening");
  const script = join(import.meta.dirname, "../skills/library/desktop-control/scripts/browser.mjs");
  cpSync(script, join(cwd, "browser.mjs"));
  cpSync(dirname(createRequire(import.meta.url).resolve("ws/package.json")), join(cwd, "node_modules/ws"), { recursive: true });
  writeFileSync(join(cwd, "cdp.cjs"), `
const { createServer } = require("node:http"), { WebSocketServer } = require("ws");
const fs = require("node:fs"), path = require("node:path");
const profile = path.join(process.env.OMEM_BROWSER_PROFILES, "demo");
fs.mkdirSync(profile, {recursive:true});
const http = createServer((req,res)=>res.end(JSON.stringify(req.url === "/json/version" ? {} : [{id:"PAGE",type:"page"}])));
new WebSocketServer({server:http,path:"/devtools/page/PAGE"}).on("connection", ws => ws.on("message", data => {
  const m=JSON.parse(data); ws.send(JSON.stringify({id:m.id,result:{arguments:["--user-data-dir="+profile]}}));
}));
http.listen(0,"127.0.0.1",()=>fs.writeFileSync(path.join(profile,"DevToolsActivePort"),String(http.address().port)));
`);
  const executable = join(bin, "aad");
  writeFileSync(executable, `#!/usr/bin/env node
const fs=require("node:fs"), net=require("node:net"), cp=require("node:child_process");
(async () => {
  if(process.argv[2]==="cdp") {
    cp.spawn(process.execPath, ["cdp.cjs"], {detached:true,stdio:"ignore"}).unref(); return;
  }
  if(process.argv[2]==="assist") {
    const server=require("node:http").createServer((req,res)=>res.end("private viewer"));
    server.listen(0,"127.0.0.1",()=>console.log(JSON.stringify({websocket:"ws://127.0.0.1:"+server.address().port,token:"fake-viewer"}))); return;
  }
  if(process.argv[2]==="--version") return console.log("fixture");
  if(!fs.statSync(process.env.WAYLAND_DISPLAY).isSocket() || fs.existsSync(process.env.HOME+"/.config/google-chrome/fixture")) throw Error("mount");
  if(fs.readFileSync(process.env.OMEM_BROWSER_PROFILES+"/fixture","utf8")!=="managed") throw Error("profile");
  const r=await fetch(process.env.OMEM_URL+"/api/operation-gate/http",{headers:{authorization:"Bearer "+process.env.OMEM_TOKEN}});
  if(!r.ok || (await r.json()).watch[0]?.host!=="fixture.test") throw Error("gate");
  if(process.argv[2]==="start"){
    const child=cp.spawn(process.execPath,["-e", "const n=require('node:net').createServer(s=>s.end('alive')); n.listen(0,'127.0.0.1',()=>require('node:fs').writeFileSync('port',String(n.address().port)))"],{stdio:"ignore",detached:true});
    child.unref();
  } else { net.connect(+fs.readFileSync("port"),"127.0.0.1").pipe(process.stdout); }
})().catch(e=>{console.error(e);process.exitCode=1});
`, { mode: 0o755 });
  vi.stubEnv("HOME", home); vi.stubEnv("DISPLAY", ""); vi.stubEnv("XDG_RUNTIME_DIR", root); vi.stubEnv("WAYLAND_DISPLAY", "wayland");
  vi.stubEnv("OMEM_TOOL_AAD", executable); vi.stubEnv("OMEM_DESKTOP_TOOLS", "");
  const server = await startServer(app, { host: "127.0.0.1", port: 0, quiet: true });
  const profile = catalogProfile({ id: "fixture", name: "fixture", command: "/bin/sh" });
  app.config.agents.ownSandbox.mode = "require";
  app.config.security.operationRules = [{ id: "browser", enabled: true, revision: 1, action: "deny", match: { kind: "http", source: "browser", host: "fixture.test" } }];
  const job = createRun(app, { kind: "agent", spaceId: "personal", title: "沙箱浏览器" });
  const prep = prepareRun(app, { actor: { role: "coder" }, spaceId: "personal", runId: job.id, profile, cwd });
  async function invoke(script: string) {
    const child = await launchRun(profile, { app, mcp: prep.mcp, ownSandbox: prep.isolation.box }, (_, ownSandbox) =>
      launch("/bin/sh", ["-ec", script], { cwd, ownSandbox, env: prep.mcp.env }));
    let out = "", err = "";
    child.stdout.on("data", b => out += b); child.stderr.on("data", b => err += b);
    child.stdin.end();
    return { code: (await once(child, "close"))[0], out, err };
  }
  try {
    const result = await invoke('aad start; for i in $(seq 100); do test ! -s port || break; sleep .02; done; aad check');
    expect(result.code, result.err).toBe(0); expect(result.out).toBe("alive");
    const direct = await invoke(`node -e 'const s=require("node:net").connect(+require("node:fs").readFileSync("port"),"127.0.0.1");s.on("connect",()=>process.exit(1));s.on("error",()=>process.exit(0))'`);
    expect(direct.code, direct.err).toBe(0);
    const register = await invoke('test ! -e "$OMEM_BROWSER_PROFILES/fixture"; aad cdp; for i in $(seq 100); do node browser.mjs list | grep -q demo && break; sleep .02; done; node browser.mjs register demo --page-id PAGE');
    expect(register.code, register.err).toBe(0);
    const { sessionId } = JSON.parse(register.out);
    const viewer = getSession(sessionId);
    expect(viewer.origin?.runId).toBe(job.id);
    expect(viewer.assist.socketPath).toBeTruthy();
    const response = await fetch(app.baseUrl + "/remote/" + sessionId + "/?token=fake-viewer");
    expect(await response.text()).toBe("private viewer");
    await closeSession(app, sessionId);
    vi.stubEnv("OMEM_DESKTOP_TOOLS", "off");
    expect((await invoke("aad check")).code).toBe(126);
  } finally {
    revokeToolToken(prep.token); await server.close(); display.close(); vi.unstubAllEnvs(); app.db.close();
    rmSync(root, { recursive: true, force: true }); rmSync(app.home, { recursive: true, force: true });
  }
}, 30000);
