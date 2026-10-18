import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { boot } from "../src/main.ts";
import { addPeer, decodeInvite, findPeer, invite, localUrls, openPeerUi, peerJson, setPeerUrl } from "../src/core/peers.ts";
import { cleanupFetched, fetchPeer, mergeLibrary } from "../src/core/pull.ts";
import { remember, listMemories } from "../src/memory/store.ts";

const servers: { close(): Promise<unknown> }[] = [];
afterAll(async () => {
  for (const s of servers) await s.close();
});

async function node(id: string) {
  const home = mkdtempSync(join(tmpdir(), `omem-peer-${id}-`));
  const b = await boot(home, { port: 0, quiet: true, background: false });
  b.app.config.node = { id };
  // A token makes the API refuse anyone without one, like a server listening on the LAN.
  b.app.config.token = `owner-${id}`;
  servers.push(b.server);
  return b.app;
}

describe("peers", () => {
  it("pairs with one code, runs checks, forwards through a middle node, and pulls a snapshot over HTTP", async () => {
    const server = await node("server");
    const relay = await node("relay");
    const laptop = await node("laptop");
    remember(server, { spaceId: "personal", kind: "fact", content: "服务器上的一条记忆。", createdBy: "user" });

    // relay can reach server; laptop can only reach relay.
    await addPeer(relay, invite(server, { url: server.baseUrl! }).code);
    await addPeer(laptop, invite(relay, { url: relay.baseUrl! }).code);
    await addPeer(laptop, invite(server, { url: "http://unreachable.invalid" }).code, { via: "relay" });

    // The address in use stops answering: the other known addresses are tried and the
    // working one is remembered, without pairing again.
    setPeerUrl(laptop, "relay", "http://127.0.0.1:1");
    expect(findPeer(laptop, "relay")!.urls).toEqual(["http://127.0.0.1:1", relay.baseUrl]);
    await peerJson(laptop, "relay", "/api/diag");
    expect(findPeer(laptop, "relay")!.url).toBe(relay.baseUrl);

    const d = await peerJson<{ node: string; counts: { memories: number } }>(laptop, "server", "/api/diag");
    expect(d).toMatchObject({ node: "server", counts: { memories: 1 } });

    const q = await peerJson<{ node: string; result: { n: number }[] }>(laptop, "server", "/api/peer/exec", { command: "sql", args: { query: "select count(*) n from memories" } });
    expect(q.result[0].n).toBe(1);
    await expect(peerJson(laptop, "server", "/api/peer/exec", { command: "sql", args: { query: "delete from memories" } })).rejects.toThrow(/只允许/);
    await expect(peerJson(laptop, "server", "/api/peer/exec", { command: "rm", args: {} })).rejects.toThrow(/没有命令/);

    // The peer's web UI through the middle node, served locally without a token.
    const ui = await openPeerUi(laptop, "server");
    const diag = (await (await fetch(`${ui.url}/api/diag`)).json()) as { node: string };
    expect(diag.node).toBe("server");
    const page = await fetch(`${ui.url}/`);
    expect([200, 404]).toContain(page.status); // 404 only when the web build is missing
    await ui.close();

    // Without the paired token the server refuses.
    const anon = await fetch(`${server.baseUrl}/api/diag`);
    expect(anon.status).toBe(401);

    const fetched = await fetchPeer(laptop, "server");
    try {
      mergeLibrary(laptop, fetched);
    } finally {
      cleanupFetched(fetched);
    }
    expect(listMemories(laptop, { status: "active" }).map((m) => m.content)).toContain("服务器上的一条记忆。");
  });
});

describe("api auth without a configured token", () => {
  it("trusts only this machine", async () => {
    const home = mkdtempSync(join(tmpdir(), "omem-auth-"));
    const b = await boot(home, { port: 0, quiet: true, background: false });
    servers.push(b.server);
    const s = b.server as unknown as { inject(o: object): Promise<{ statusCode: number }> };
    expect((await s.inject({ method: "GET", url: "/api/me", remoteAddress: "127.0.0.1" })).statusCode).toBe(200);
    expect((await s.inject({ method: "GET", url: "/api/me", remoteAddress: "192.168.1.20" })).statusCode).toBe(401);
  });
});

describe("invite addresses", () => {
  it("lists this machine's addresses when listening on all interfaces, none on loopback", async () => {
    const home = mkdtempSync(join(tmpdir(), "omem-inv-"));
    const b = await boot(home, { port: 0, quiet: true, background: false });
    servers.push(b.server);
    b.app.config.host = "127.0.0.1";
    expect(localUrls(b.app)).toEqual([]);
    b.app.config.host = "0.0.0.0";
    b.app.config.port = 4999;
    const urls = decodeInvite(invite(b.app).code).urls;
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((u) => u.endsWith(":4999"))).toBe(true);
  });
});

describe("listen address", () => {
  it("treats the old written-out default as unset and keeps an explicit localhost", async () => {
    const { loadConfig } = await import("../src/core/config.ts");
    const { writeFileSync } = await import("node:fs");
    const home = mkdtempSync(join(tmpdir(), "omem-host-"));
    expect(loadConfig(home).host).toBe("0.0.0.0");
    writeFileSync(join(home, "config.json"), JSON.stringify({ host: "127.0.0.1" }));
    expect(loadConfig(home).host).toBe("0.0.0.0");
    writeFileSync(join(home, "config.json"), JSON.stringify({ host: "localhost" }));
    expect(loadConfig(home).host).toBe("localhost");
  });
});
