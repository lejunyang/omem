import { mkdtempSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { boot } from "../src/main.ts";
import { sameSecret } from "../src/core/util.ts";

describe("loopback trust", async () => {
  const home = mkdtempSync(join(tmpdir(), "omem-origin-"));
  const { app, server } = await boot(home, { port: 0, quiet: true, background: false });
  afterAll(() => server.close());
  const port = new URL(app.baseUrl!).port;
  const get = (path: string, headers: Record<string, string> = {}, method = "GET") =>
    new Promise<number>((ok, fail) => {
      const req = request({ host: "127.0.0.1", port, path, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
        res.resume();
        ok(res.statusCode ?? 0);
      });
      req.on("error", fail);
      req.end();
    });

  it("trusts this machine's own requests", async () => {
    expect(await get("/api/me")).toBe(200);
    expect(await get("/api/me", { host: `localhost:${port}`, origin: `http://localhost:${port}` })).toBe(200);
    // A dev server on another local port in front.
    expect(await get("/api/me", { host: `localhost:5183`, origin: "http://localhost:5183" })).toBe(200);
  });

  it("does not trust another site's page, or a host name pointed at 127.0.0.1", async () => {
    expect(await get("/api/me", { origin: "https://evil.example" })).toBe(401);
    expect(await get("/api/me", { origin: "null" })).toBe(401);
    expect(await get("/api/me", { host: `evil.example:${port}`, origin: `http://evil.example:${port}` })).toBe(401);
    expect(await get("/api/me", { host: `evil.example:${port}` })).toBe(401);
  });

  it("checks tool routes by their own token only on the tool routes", async () => {
    expect(await get("/api/tools")).toBe(401);
    expect(await get("/api/toolsets", { origin: "https://evil.example" })).toBe(401);
  });

  it("takes a token from the query only for what the browser loads itself", async () => {
    app.config.token = "secret-owner";
    try {
      expect(await get("/api/me?token=secret-owner")).toBe(200);
      expect(await get("/api/peer/unpair?token=secret-owner", { "content-type": "application/json" }, "POST")).toBe(401);
    } finally {
      app.config.token = undefined;
    }
  });

  it("compares secrets whatever their length", () => {
    expect(sameSecret("a", "a")).toBe(true);
    expect(sameSecret("a", "ab")).toBe(false);
    expect(sameSecret("", "")).toBe(false);
  });
});
