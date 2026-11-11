import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { boot } from "../src/main.ts";
import { addPeer, invite, openPeerUi, pluginPageFile } from "../src/core/peers.ts";
import { PLUGIN_STREAM, tunneled } from "../src/core/peer-tunnel.ts";

/**
 * `omem peer open` of a device reached through a middle one, showing a plugin page: the page runs
 * in a sandboxed iframe (Origin: null) and loads its module script and stylesheet in CORS mode, so
 * every hop must let those through and the answer must carry Access-Control-Allow-Origin.
 */
const closers: (() => Promise<unknown>)[] = [];
afterAll(async () => {
  for (const c of closers.reverse()) await c();
});

async function node(id: string, prepare?: (home: string) => void) {
  const home = mkdtempSync(join(tmpdir(), `omem-peerpage-${id}-`));
  prepare?.(home);
  const b = await boot(home, { port: 0, quiet: true, background: false });
  b.app.config.node = { id };
  b.app.config.token = `owner-${id}`;
  closers.push(() => b.server.close());
  return b.app;
}

/** A data-directory plugin without code, with a built page: index.html and two assets. */
function pagePlugin(home: string) {
  const dir = join(home, "plugins", "demopage");
  mkdirSync(join(dir, "web", "assets"), { recursive: true });
  writeFileSync(join(dir, "plugin.yaml"), "id: demopage\nname: 演示页面\npage: { title: 演示 }\n");
  writeFileSync(join(dir, "web", "index.html"), '<!doctype html><script type="module" crossorigin src="./assets/app.js"></script><link rel="stylesheet" crossorigin href="./assets/app.css">');
  writeFileSync(join(dir, "web", "assets", "app.js"), "export const ok = 1;\n");
  writeFileSync(join(dir, "web", "assets", "app.css"), "body { color: red }\n");
}

/** A raw GET (the path is sent as written, not normalized the way fetch would). */
function get(base: string, path: string, headers: Record<string, string> = {}) {
  const u = new URL(base);
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((ok, fail) => {
    const r = request({ host: u.hostname, port: u.port, path, method: "GET", headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => ok({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    r.on("error", fail);
    r.end();
  });
}

/** A middle node as it was before 2026-11-07: forwards the request but drops the CORS header. */
function oldMiddle(target: string) {
  const t = new URL(target);
  const s: Server = createServer((req, res) => {
    const up = request({ host: t.hostname, port: t.port, path: req.url, method: req.method, headers: { ...req.headers, host: t.host } }, (r) => {
      const h = { ...r.headers };
      delete h["access-control-allow-origin"];
      res.writeHead(r.statusCode ?? 502, h);
      r.pipe(res);
    });
    up.on("error", () => res.end());
    req.pipe(up);
  });
  return new Promise<string>((ok) =>
    s.listen(0, "127.0.0.1", () => {
      closers.push(() => new Promise((r) => s.close(r)));
      ok(`http://127.0.0.1:${(s.address() as { port: number }).port}`);
    }),
  );
}

describe("a plugin page through omem peer open and a middle node", () => {
  it("knows which paths are a plugin page's files and streams", () => {
    expect(pluginPageFile("/plugins/english/assets/index-DouO53PM.js")).toBe(true);
    expect(pluginPageFile("/plugins/english/")).toBe(true);
    expect(pluginPageFile("/plugins/_sdk/omem.js")).toBe(true);
    expect(pluginPageFile("/plugins/english/../../api/diag")).toBe(false);
    expect(pluginPageFile("/plugins/english/%2e%2e/%2e%2e/api/diag")).toBe(false);
    expect(pluginPageFile("/api/plugins/english/sessions")).toBe(false);
    expect(tunneled("/api/plugins/english/streams/live")).toBe(true);
    expect(PLUGIN_STREAM.test("/api/plugins/english/sessions")).toBe(false);
  }, 180_000);

  it("loads the page's module script and stylesheet from a sandboxed frame (Origin: null), with the CORS header at the end", async () => {
    const server = await node("pageserver", pagePlugin);
    const relay = await node("pagerelay");
    const laptop = await node("pagelaptop");
    await addPeer(relay, invite(server, { url: server.baseUrl! }).code);
    await addPeer(laptop, invite(relay, { url: relay.baseUrl! }).code);
    await addPeer(laptop, invite(server, { url: "http://unreachable.invalid" }).code, { via: "pagerelay" });

    const ui = await openPeerUi(laptop, "pageserver");
    closers.push(() => ui.close());
    // The iframe document itself: a navigation, no Origin.
    const page = await get(ui.url, "/plugins/demopage/");
    expect(page.status).toBe(200);
    expect(page.body).toContain("./assets/app.js");
    for (const [path, text] of [["/plugins/demopage/assets/app.js", "export const ok"], ["/plugins/demopage/assets/app.css", "color: red"]]) {
      const r = await get(ui.url, path, { origin: "null" });
      expect(r.status, path).toBe(200);
      expect(r.headers["access-control-allow-origin"], path).toBe("*");
      expect(r.body).toContain(text);
    }
    // The SDK for plain-HTML pages: built or not, the answer is not refused and carries the header.
    const sdk = await get(ui.url, "/plugins/_sdk/omem.js", { origin: "null" });
    expect(sdk.status).not.toBe(403);
    expect(sdk.headers["access-control-allow-origin"]).toBe("*");

    // Anything else from a sandboxed frame is still refused (it would go out with the owner's token).
    expect((await get(ui.url, "/api/diag", { origin: "null" })).status).toBe(403);
    expect((await get(ui.url, "/plugins/demopage/../../api/diag", { origin: "null" })).status).toBe(403);
    expect((await get(ui.url, "/plugins/demopage/%2e%2e/%2e%2e/api/diag", { origin: "null" })).status).toBe(403);
    // And another site's page as before.
    expect((await get(ui.url, "/plugins/demopage/assets/app.js", { origin: "https://elsewhere.example" })).status).toBe(403);
  }, 180_000);

  it("keeps the CORS header even when the middle node drops it (one older than 2026-11-07)", async () => {
    const server = await node("oldserver", pagePlugin);
    const relay = await node("oldrelay");
    const laptop = await node("oldlaptop");
    await addPeer(relay, invite(server, { url: server.baseUrl! }).code);
    const middle = await oldMiddle(relay.baseUrl!);
    await addPeer(laptop, invite(relay, { url: relay.baseUrl! }).code, { url: middle });
    await addPeer(laptop, invite(server, { url: "http://unreachable.invalid" }).code, { via: "oldrelay" });

    const ui = await openPeerUi(laptop, "oldserver");
    closers.push(() => ui.close());
    const r = await get(ui.url, "/plugins/demopage/assets/app.js", { origin: "null" });
    expect(r.status).toBe(200);
    expect(r.headers["access-control-allow-origin"]).toBe("*");
  }, 180_000);
});
