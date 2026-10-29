import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
    // The workbench page, as serve-web writes it for a Chinese browser.
    if ((req.headers.accept ?? "").includes("text/html")) {
      res.writeHead(200, { "content-type": "text/html", "transfer-encoding": "chunked" });
      res.write('<!-- ae:' + (req.headers["accept-encoding"] ?? "none") + ' --><script type="module" src="/ide/stable-x/static/out/nls.messages.js"></script>');
      return res.end('<script type="module" src="https://www.vscode-unpkg.net/nls/' + "c".repeat(40) + '/1.144.0/zh-cn/nls.messages.js"></script>');
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ path: req.url, method: req.method, cookie: req.headers.cookie, auth: req.headers.authorization ?? null, fwd: req.headers["x-forwarded-host"] ?? null, base: at("--server-base-path"), body, omemUrl: process.env.OMEM_URL ?? null, omemToken: process.env.OMEM_TOKEN ?? null }));
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
// Settings and extensions from this machine's real VS Code stay out of tests.
app.config.ide = { web: { command: fake, reuseSettings: false } };
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
    // serve-web addresses its WebSocket from this: the host the browser used, not its own port.
    expect(seen.fwd).toBe(new URL(base).host);

    // Bodies pass through unparsed.
    const posted = await fetch(`${base}/ide/api/x`, { method: "POST", headers: { cookie, "content-type": "application/octet-stream" }, body: "raw-bytes" });
    expect((await posted.json()).body).toBe("raw-bytes");

    // A made-up cookie is not a session.
    expect((await fetch(`${base}/ide/`, { headers: { cookie: "omem_ide=nope" } })).status).toBe(401);
  }, 30000);

  it("gives the page omem's translated strings instead of the CDN's, the omem extension and omem's address", async () => {
    stopIdeWeb();
    // A downloaded build and an older Chinese language pack in this omem's data directory.
    const commit = "c".repeat(40);
    const ide = join(app.home, "ide");
    mkdirSync(join(ide, "cli", "serve-web", commit, "out"), { recursive: true });
    writeFileSync(join(ide, "cli", "serve-web", commit, "out", "nls.keys.json"), JSON.stringify([["vs/a", ["copy", "newer"]]]));
    writeFileSync(join(ide, "cli", "serve-web", commit, "out", "nls.messages.json"), JSON.stringify(["Copy", "Newer"]));
    const packDir = join(ide, "server", "extensions", "ms-ceintl.vscode-language-pack-zh-hans-1.131.0");
    mkdirSync(join(packDir, "translations"), { recursive: true });
    writeFileSync(join(packDir, "package.json"), JSON.stringify({ name: "vscode-language-pack-zh-hans", publisher: "MS-CEINTL", version: "1.131.0", contributes: { localizations: [{ languageId: "zh-cn", translations: [{ id: "vscode", path: "./translations/main.i18n.json" }] }] } }));
    writeFileSync(join(packDir, "translations", "main.i18n.json"), JSON.stringify({ contents: { "vs/a": { copy: "复制" } } }));
    // Listed the way VS Code records an install (an earlier test's start already wrote the list).
    const list = join(ide, "server", "extensions", "extensions.json");
    const before = existsSync(list) ? JSON.parse(readFileSync(list, "utf8")) : [];
    writeFileSync(list, JSON.stringify([...before, { identifier: { id: "ms-ceintl.vscode-language-pack-zh-hans" }, version: "1.131.0", relativeLocation: "ms-ceintl.vscode-language-pack-zh-hans-1.131.0" }]));

    const s = await fetch(`${base}/api/ide/open?token=owner-secret`, { redirect: "manual" });
    const cookie = s.headers.get("set-cookie")!.split(";")[0];
    // omem's own extension went in before serve-web started, next to the pack.
    const listed = JSON.parse(readFileSync(join(ide, "server", "extensions", "extensions.json"), "utf8")) as { identifier: { id: string } }[];
    expect(listed.map((e) => e.identifier.id)).toContain("omem.omem-vscode");
    expect(existsSync(join(ide, "server", "extensions", "omem.omem-vscode-0.1.0", "out", "extension.js"))).toBe(true);

    const page = await (await fetch(`${base}/ide/`, { headers: { cookie, accept: "text/html", "accept-encoding": "gzip, br" } })).text();
    expect(page).toContain("<!-- ae:none -->");
    expect(page).not.toContain("vscode-unpkg.net");
    expect(page).toContain(`<script type="module" src="/ide/_omem/nls/${commit}/zh-cn.js"></script>`);
    const strings = await fetch(`${base}/ide/_omem/nls/${commit}/zh-cn.js`, { headers: { cookie } });
    expect(strings.headers.get("content-type")).toMatch(/javascript/);
    expect(await strings.text()).toContain('_VSCODE_NLS_MESSAGES=["复制","Newer"]');
    // Not without the session; not for a build or language it has nothing for.
    expect((await fetch(`${base}/ide/_omem/nls/${commit}/zh-cn.js`)).status).toBe(401);
    expect((await fetch(`${base}/ide/_omem/nls/${"d".repeat(40)}/zh-cn.js`, { headers: { cookie } })).status).toBe(404);

    // The extension host inherits serve-web's environment: this omem's address and token.
    const seen = await (await fetch(`${base}/ide/x`, { headers: { cookie } })).json();
    expect(seen.omemUrl).toBe(base);
    expect(seen.omemToken).toBe("owner-secret");
  }, 60000);

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

  it("says which CLI it would run, and why it cannot when the configured one is not there", async () => {
    const owner = { headers: { authorization: "Bearer owner-secret" } };
    expect(await (await fetch(`${base}/api/ide/cli`, owner)).json()).toEqual({ command: fake, found: fake });
    stopIdeWeb();
    app.config.ide.web.command = join(dir, "no-such-code");
    expect((await (await fetch(`${base}/api/ide/cli`, owner)).json()).found).toBeNull();
    const s = await fetch(`${base}/api/ide/open?token=owner-secret`, { redirect: "manual" });
    expect(s.status).toBe(503);
    expect(await s.text()).toMatch(/找不到 .*no-such-code：在运行页/);
    // The server keeps running.
    expect((await fetch(`${base}/api/me`, owner)).status).toBe(200);
    app.config.ide.web.command = fake;
  });

  it("reports a CLI that does not start instead of taking the server down", async () => {
    stopIdeWeb();
    const broken = join(dir, process.platform === "win32" ? "broken.cmd" : "broken.sh");
    writeFileSync(broken, process.platform === "win32" ? "@exit /b 3\r\n" : "#!/bin/sh\nexit 3\n");
    if (process.platform !== "win32") chmodSync(broken, 0o755);
    app.config.ide.web.command = broken;
    const s = await fetch(`${base}/api/ide/open?token=owner-secret`, { redirect: "manual" });
    expect(s.status).toBe(503);
    expect(await s.text()).toMatch(/没能启动网页版 VS Code/);
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
        expect(seen.fwd).toBe(new URL(ui.url).host);
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
