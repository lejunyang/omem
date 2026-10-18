import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { boot } from "../src/main.ts";
import { addPeer, invite, peerJson } from "../src/core/peers.ts";
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
    addPeer(relay, invite(server, { url: server.baseUrl! }).code);
    addPeer(laptop, invite(relay, { url: relay.baseUrl! }).code);
    addPeer(laptop, invite(server, { url: "http://unreachable.invalid" }).code, { via: "relay" });

    const d = await peerJson<{ node: string; counts: { memories: number } }>(laptop, "server", "/api/diag");
    expect(d).toMatchObject({ node: "server", counts: { memories: 1 } });

    const q = await peerJson<{ node: string; result: { n: number }[] }>(laptop, "server", "/api/peer/exec", { command: "sql", args: { query: "select count(*) n from memories" } });
    expect(q.result[0].n).toBe(1);
    await expect(peerJson(laptop, "server", "/api/peer/exec", { command: "sql", args: { query: "delete from memories" } })).rejects.toThrow(/只允许/);
    await expect(peerJson(laptop, "server", "/api/peer/exec", { command: "rm", args: {} })).rejects.toThrow(/没有命令/);

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
