import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { startServer } from "../src/server/http.ts";
import { ideFolder, stopIdeWeb } from "../src/server/ide-web.ts";
import { addPeer, openPeerUi } from "../src/core/peers.ts";
import { testApp } from "./helpers.ts";

/**
 * A stand-in for `code serve-web`: answers only with the connection token cookie, echoes what it
 * got (path, cookies) over HTTP, and echoes frames after a WebSocket-style upgrade.
 */
const dir = mkdtempSync(join(tmpdir(), "omem-ide-"));
writeFileSync(join(dir, "fake-serve-web.mjs"), `
import { createServer } from "node:http";
const a = process.argv.slice(2);
const at = (k) => a[a.indexOf(k) + 1];
const token = at("--connection-token");
const ok = (req) => (req.headers.cookie ?? "").includes("vscode-tkn=" + token);
const s = createServer((req, res) => {
  if (!ok(req)) { res.writeHead(403); return res.end("forbidden"); }
  let body = "";
  req.on("data", (d) => (body += d)).on("end", () => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ path: req.url, method: req.method, cookie: req.headers.cookie, auth: req.headers.authorization ?? null, base: at("--server-base-path"), body }));
  });
});
s.on("upgrade", (req, socket) => {
  if (!ok(req)) return socket.end("HTTP/1.1 403 Forbidden\\r\\n\\r\\n");
  socket.write("HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\n\\r\\n");
  socket.on("data", (d) => socket.write("echo:" + d));
});
s.listen(Number(at("--port")), at("--host"));
`);
const fake = process.platform === "win32" ? join(dir, "fake.cmd") : join(dir, "fake.sh");
writeFileSync(fake, process.platform === "win32" ? `@"${process.execPath}" "${join(dir, "fake-serve-web.mjs")}" %*\r\n` : `#!/bin/sh\nexec "${process.execPath}" "${join(dir, "fake-serve-web.mjs")}" "$@"\n`);
if (process.platform !== "win32") chmodSync(fake, 0o755);

const app = testApp();
app.config.ide = { web: { enabled: true, command: fake } };
app.config.token = "owner-secret";
const server = await startServer(app, { port: 0, host: "127.0.0.1", quiet: true });
const base = `http://127.0.0.1:${(server.server.address() as { port: number }).port}`;
afterAll(async () => {
  await server.close();
  app.db.close();
});

// Members never get it: /api/ide/open is outside the member routes (http.ts MEMBER_ROUTES).
describe("web VS Code under /ide", () => {
  it("lets only the owner in, through a session cookie, and adds serve-web's token on the way", async () => {
    // A configured token: loopback alone is not enough.
    expect((await fetch(`${base}/ide/`)).status).toBe(401);
    expect((await fetch(`${base}/api/ide/open`, { redirect: "manual" })).status).toBe(401);

    // A link from the page: the token as a query, like downloads.
    const s = await fetch(`${base}/api/ide/open?folder=${encodeURIComponent("/srv/work/shop web")}&token=owner-secret`, { redirect: "manual" });
    expect(s.status).toBe(302);
    expect(s.headers.get("location")).toBe("/ide/?folder=%2Fsrv%2Fwork%2Fshop%20web");
    expect(ideFolder("E:\\work\\shop")).toBe("/e:/work/shop");
    const cookie = s.headers.get("set-cookie")!.split(";")[0];
    expect(s.headers.get("set-cookie")).toMatch(/Path=\/ide; HttpOnly/);

    const r = await fetch(`${base}/ide/static/x.js?folder=a`, { headers: { cookie: `${cookie}; other=1` } });
    expect(r.status).toBe(200);
    const seen = await r.json();
    expect(seen.path).toBe("/ide/static/x.js?folder=a");
    expect(seen.base).toBe("/ide");
    expect(seen.cookie).toMatch(/vscode-tkn=[0-9a-f]{48}/);
    expect(seen.cookie).toContain("other=1");
    expect(seen.cookie).not.toContain("omem_ide");

    // Bodies pass through unparsed.
    const posted = await fetch(`${base}/ide/api/x`, { method: "POST", headers: { cookie, "content-type": "application/octet-stream" }, body: "raw-bytes" });
    expect((await posted.json()).body).toBe("raw-bytes");

    // A made-up cookie is not a session.
    expect((await fetch(`${base}/ide/`, { headers: { cookie: "omem_ide=nope" } })).status).toBe(401);
  }, 30000);

  it("passes WebSocket upgrades through with the same check", async () => {
    const s = await fetch(`${base}/api/ide/open?token=owner-secret`, { redirect: "manual" });
    const cookie = s.headers.get("set-cookie")!.split(";")[0];
    const upgrade = (headers: Record<string, string>) =>
      new Promise<{ status: number; echo?: string }>((ok, fail) => {
        const req = request(`${base}/ide/remote`, { headers: { connection: "Upgrade", upgrade: "websocket", ...headers } });
        req.on("upgrade", (res, socket) => {
          socket.once("data", (d) => (ok({ status: res.statusCode!, echo: String(d) }), socket.destroy()));
          socket.write("ping");
        });
        req.on("response", (res) => ok({ status: res.statusCode! }));
        req.on("error", fail);
        req.end();
      });
    expect(await upgrade({ cookie })).toEqual({ status: 101, echo: "echo:ping" });
    expect((await upgrade({})).status).toBe(401);
  }, 30000);

  it("is off unless the owner turns it on", async () => {
    app.config.ide.web.enabled = false;
    const s = await fetch(`${base}/api/ide/open?token=owner-secret`, { redirect: "manual" });
    expect(s.status).toBe(503);
    expect(await s.text()).toMatch(/没有打开/);
    app.config.ide.web.enabled = true;
  });

  it("reports a missing code CLI instead of taking the server down", async () => {
    stopIdeWeb();
    app.config.ide.web.command = join(dir, "no-such-code");
    const s = await fetch(`${base}/api/ide/open?token=owner-secret`, { redirect: "manual" });
    expect(s.status).toBe(503);
    expect(await s.text()).toMatch(/没能启动网页版 VS Code/);
    expect((await fetch(`${base}/api/me`, { headers: { authorization: "Bearer owner-secret" } })).status).toBe(200);
    app.config.ide.web.command = fake;
  });

  it("opens through `omem peer open`, also via a middle node, WebSocket included", async () => {
    const code = (id: string, url: string, token: string) => "omem1." + Buffer.from(JSON.stringify({ id, urls: [url], token })).toString("base64url");
    const middle = testApp();
    middle.config.token = "middle-secret";
    const mid = await startServer(middle, { port: 0, host: "127.0.0.1", quiet: true });
    const midUrl = `http://127.0.0.1:${(mid.server.address() as { port: number }).port}`;
    await addPeer(middle, code("box", base, "owner-secret"));
    const laptop = testApp();
    await addPeer(laptop, code("mid", midUrl, "middle-secret"));
    await addPeer(laptop, code("box", "", "owner-secret"), { via: "mid" });
    // "box" is reached through "mid": laptop → mid (/api/peers/box/…) → box.
    {
      const ui = await openPeerUi(laptop, "box");
      try {
        const s = await fetch(`${ui.url}/api/ide/open?folder=${encodeURIComponent("/srv/work/shop")}`, { redirect: "manual" });
        expect(s.status).toBe(302);
        expect(s.headers.get("location")).toBe("/ide/?folder=%2Fsrv%2Fwork%2Fshop");
        // No cookie needed here: the paired token goes along.
        const seen = await (await fetch(`${ui.url}/ide/static/x.js`)).json();
        expect(seen.path).toBe("/ide/static/x.js");
        expect(seen.auth).toBeNull();
        const posted = await fetch(`${ui.url}/ide/api/x`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: "raw-bytes" });
        expect((await posted.json()).body).toBe("raw-bytes");
        const echo = await new Promise<string>((ok, fail) => {
          const req = request(`${ui.url}/ide/remote`, { headers: { connection: "Upgrade", upgrade: "websocket" } });
          req.on("upgrade", (_res, socket) => {
            socket.once("data", (d) => (ok(String(d)), socket.destroy()));
            socket.write("ping");
          });
          req.on("response", (res) => fail(new Error(`status ${res.statusCode}`)));
          req.on("error", fail);
          req.end();
        });
        expect(echo).toBe("echo:ping");
      } finally {
        await ui.close();
      }
    }
    // The middle node relays only for its owner.
    expect((await fetch(`${midUrl}/api/peers/box/ide/`)).status).toBe(401);
    await mid.close();
    middle.db.close();
    laptop.db.close();
  }, 30000);

  it("stops a serve-web an earlier omem left running before starting its own", async () => {
    stopIdeWeb();
    const orphan = spawn(process.execPath, [join(dir, "fake-serve-web.mjs"), "serve-web", "--host", "127.0.0.1", "--port", "0", "--connection-token", "old"], { stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 300));
    mkdirSync(join(app.home, "ide"), { recursive: true });
    writeFileSync(join(app.home, "ide", "serve-web.pid"), String(orphan.pid));
    const gone = new Promise((r) => orphan.once("exit", r));
    const s = await fetch(`${base}/api/ide/open?token=owner-secret`, { redirect: "manual" });
    expect(s.status).toBe(302);
    await gone;
    expect(orphan.exitCode !== null || orphan.signalCode !== null).toBe(true);
  }, 30000);
});
