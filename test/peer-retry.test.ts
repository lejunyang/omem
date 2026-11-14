import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { peerFetch } from "../src/core/peers.ts";
import { testApp } from "./helpers.ts";

/**
 * A connection to another device kept from an earlier request can be gone when it is used again
 * (core/peers.ts): a read is asked once more, a write is not.
 */
describe("a request to another device whose connection drops", async () => {
  const seen: string[] = [];
  let drop = 0;
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    if (drop > 0) {
      drop--;
      req.socket.destroy();
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  afterAll(() => void server.close());
  const app = testApp();
  mkdirSync(join(app.home, "secrets"), { recursive: true });
  writeFileSync(join(app.home, "secrets", "peers.json"), JSON.stringify([{ id: "server", url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token: "t", addedAt: "2026-01-01T00:00:00.000Z" }]));

  it("asks a read once more", async () => {
    drop = 1;
    seen.length = 0;
    const res = await peerFetch(app, "server", "/api/peer/files");
    expect(await res.json()).toEqual({ ok: true });
    expect(seen).toEqual(["GET /api/peer/files", "GET /api/peer/files"]);
  });

  it("does not send a write twice", async () => {
    drop = 1;
    seen.length = 0;
    await expect(peerFetch(app, "server", "/api/peer/tool", { method: "POST", body: "{}" })).rejects.toThrow(/连不上设备 server/);
    expect(seen).toEqual(["POST /api/peer/tool"]);
  });
});
