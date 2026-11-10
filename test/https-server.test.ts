import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { connect, createSecureServer, type ClientHttp2Session } from "node:http2";
import { request as httpsRequest } from "node:https";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { startServer } from "../src/server/http.ts";
import { ensureSelfSigned, http2Compat } from "../src/server/secure.ts";
import { testApp } from "./helpers.ts";

// The optional HTTPS listener (src/server/secure.ts): HTTP/2 for browsers, HTTP/1.1 and WebSocket
// upgrades still served. The certificate is made with openssl, as `selfSigned` does.
const hasOpenssl = !spawnSync("openssl", ["version"], { encoding: "utf8" }).error;

function h2get(session: ClientHttp2Session, path: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((ok, fail) => {
    const r = session.request({ ":path": path, ...headers });
    let status = 0;
    let h: Record<string, unknown> = {};
    let body = "";
    r.on("response", (res) => ((status = Number(res[":status"])), (h = res)));
    r.on("data", (d) => (body += d));
    r.on("end", () => ok({ status, headers: h, body }));
    r.on("error", fail);
    r.end();
  });
}

describe.skipIf(!hasOpenssl)("HTTPS / HTTP/2 listener", () => {
  it("serves the same routes over HTTP/2 and HTTP/1.1, the event stream, and WebSocket upgrades", async () => {
    const app = testApp();
    app.config.https = { port: 0, selfSigned: true, hosts: [] };
    const server = await startServer(app, { port: 0, host: "127.0.0.1", quiet: true });
    const session = connect(app.secureUrl, { rejectUnauthorized: false });
    try {
      expect(app.secureUrl).toMatch(/^https:\/\/127\.0\.0\.1:\d+$/);
      expect(existsSync(join(app.home, "tls", "self-signed.crt"))).toBe(true);

      // Loopback trust needs a loopback Host and a matching Origin: HTTP/2 sends `:authority` instead.
      const me = await h2get(session, "/api/me", { origin: app.secureUrl });
      expect(me.status).toBe(200);
      expect(JSON.parse(me.body).id).toBe("owner");
      const other = await h2get(session, "/api/me", { origin: "https://elsewhere.test" });
      expect(other.status).toBe(401);
      const gz = await h2get(session, "/api/settings", { "accept-encoding": "gzip" });
      expect(gz.status).toBe(200);
      expect(gz.headers["content-encoding"]).toBe("gzip");
      // A share link (no credentials) answers the same way.
      expect((await h2get(session, `/api/share/${"a".repeat(43)}`)).status).toBe(404);

      // The live events stream over HTTP/2 (its `connection: keep-alive` is dropped, not fatal),
      // and closing the stream unsubscribes.
      const before = app.events.listenerCount("event");
      const stream = session.request({ ":path": "/api/events" });
      const got = await new Promise<string>((ok, fail) => {
        let text = "";
        stream.on("response", (h) => expect(h["content-type"]).toBe("text/event-stream"));
        stream.on("data", (d) => {
          text += d;
          if (text.includes(": connected")) app.events.emit("event", { type: "changed", entity: "item", id: "i1" });
          if (text.includes('"id":"i1"')) ok(text);
        });
        stream.on("error", fail);
      });
      expect(got).toContain('"entity":"item"');
      expect(app.events.listenerCount("event")).toBe(before + 1);
      stream.close();
      for (let i = 0; i < 50 && app.events.listenerCount("event") > before; i++) await new Promise((r) => setTimeout(r, 20));
      expect(app.events.listenerCount("event")).toBe(before);

      // HTTP/1.1 over TLS still works (curl, older clients).
      const h1 = await new Promise<{ status: number; version: string }>((ok, fail) => {
        const r = httpsRequest(`${app.secureUrl}/api/me`, { rejectUnauthorized: false }, (res) => {
          res.resume();
          res.on("end", () => ok({ status: res.statusCode ?? 0, version: res.httpVersion }));
        });
        r.on("error", fail);
        r.end();
      });
      expect(h1).toEqual({ status: 200, version: "1.1" });

      // WebSocket upgrades reach the same listeners as on the plain port.
      const wss = new WebSocketServer({ noServer: true });
      server.server.on("upgrade", (req, socket, head) => {
        if (req.url === "/test-ws") wss.handleUpgrade(req, socket, head, (ws) => ws.send(`hi ${req.headers.host ? "with host" : "no host"}`));
      });
      const message = await new Promise<string>((ok, fail) => {
        const ws = new WebSocket(`${app.secureUrl.replace("https", "wss")}/test-ws`, { rejectUnauthorized: false });
        ws.on("message", (m) => (ok(String(m)), ws.close()));
        ws.on("error", fail);
      });
      expect(message).toBe("hi with host");
      wss.close();
    } finally {
      session.close();
      await server.close();
      app.db.close();
    }
  });

  it("drops headers HTTP/2 forbids instead of failing the response", async () => {
    const app = testApp();
    const { cert, key } = ensureSelfSigned(app.home, ["localhost", "127.0.0.1"]);
    const { readFileSync } = await import("node:fs");
    // A proxied upstream's raw headers, as the IDE and remote proxies pass them on.
    const srv = createSecureServer({ allowHTTP1: true, cert: readFileSync(cert), key: readFileSync(key) }, (req, res) => {
      http2Compat(req, res);
      res.setHeader("keep-alive", "timeout=5");
      if (req.url === "/raw") res.writeHead(200, ["content-type", "text/plain", "Transfer-Encoding", "chunked", "Connection", "keep-alive"] as unknown as Record<string, string>);
      else res.writeHead(200, "OK", { "content-type": "text/plain", connection: "close", "transfer-encoding": "chunked" });
      // Pseudo-headers out of `headers` (proxies copy them upstream), still behind url and method.
      const pseudo = Object.keys(req.headers).some((k) => k.startsWith(":"));
      res.end(`host=${req.headers.host} pseudo=${pseudo} ${req.method} ${req.url}`);
    });
    await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", () => ok()));
    const port = (srv.address() as { port: number }).port;
    const session = connect(`https://127.0.0.1:${port}`, { rejectUnauthorized: false });
    try {
      const raw = await h2get(session, "/raw");
      expect(raw.status).toBe(200);
      expect(raw.body).toBe(`host=127.0.0.1:${port} pseudo=false GET /raw`);
      const obj = await h2get(session, "/obj");
      expect(obj.status).toBe(200);
      expect(obj.headers["transfer-encoding"]).toBeUndefined();
      // The certificate is reused while it covers the names.
      expect(ensureSelfSigned(app.home, ["127.0.0.1", "localhost"]).made).toBe(false);
      expect(ensureSelfSigned(app.home, ["localhost", "127.0.0.1", "omem.test"]).made).toBe(true);
    } finally {
      session.close();
      await new Promise<void>((ok) => srv.close(() => ok()));
      app.db.close();
    }
  });
});
