import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ask } from "../src/agents/jobs.ts";
import { waitForRun } from "../src/agents/runs.ts";
import { saveConfig } from "../src/core/config.ts";
import { addPeer, findPeer, invite, peerJson } from "../src/core/peers.ts";
import { backState, openBack, setServeBack } from "../src/core/peer-back.ts";
import { userForToken } from "../src/core/users.ts";
import { boot } from "../src/main.ts";

const servers: { close(): Promise<unknown> }[] = [];
afterAll(async () => {
  for (const s of servers.reverse()) await s.close();
}, 60_000);

async function node(id: string, config: object = {}) {
  const home = mkdtempSync(join(tmpdir(), `omem-peerback-${id}-`));
  writeFileSync(join(home, "config.json"), JSON.stringify(config));
  const b = await boot(home, { port: 0, quiet: true, background: false });
  b.app.config.node = { id };
  b.app.config.token = `owner-${id}`;
  servers.push(b.server);
  return { app: b.app, home };
}

async function until(what: () => boolean, ms = 10_000) {
  const end = Date.now() + ms;
  while (!what()) {
    if (Date.now() > end) throw new Error("等不到");
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("calling back a device that dials out", () => {
  it("lets the devices it reaches call it: requests, the raw stream, its ACP agent; off revokes", async () => {
    // The laptop reaches the relay directly and the server only through the relay; neither reaches it.
    const laptop = await node("laptop", { agents: { profiles: [{ id: "fake", transport: "acp", command: process.execPath, args: [resolve("test/fake-acp-agent.ts")] }] } });
    const relay = await node("relay");
    const server = await node("server");
    await addPeer(relay.app, invite(server.app, { url: server.app.baseUrl! }).code);
    await addPeer(laptop.app, invite(relay.app, { url: relay.app.baseUrl! }).code);
    await addPeer(laptop.app, invite(server.app, { url: "http://unreachable.invalid" }).code, { via: "relay" });

    setServeBack(laptop.app, "relay", true);
    setServeBack(laptop.app, "server", true);
    await until(() => backState(laptop.app, "relay").serving?.state === "connected" && backState(laptop.app, "server").serving?.state === "connected");
    await until(() => !!backState(server.app, "laptop").incoming?.online && !!backState(relay.app, "laptop").incoming?.online);
    // The server learned of the laptop from its connection alone.
    expect(findPeer(server.app, "laptop")).toMatchObject({ url: "", back: { token: expect.stringMatching(/^om_/) } });

    // Plain requests, from both.
    expect(await peerJson<{ node: string }>(server.app, "laptop", "/api/diag")).toMatchObject({ node: "laptop" });
    expect(await peerJson<{ node: string }>(relay.app, "laptop", "/api/diag")).toMatchObject({ node: "laptop" });
    const exec = await peerJson<{ node: string }>(server.app, "laptop", "/api/peer/exec", { command: "diag", args: {} });
    expect(exec.node).toBe("laptop");

    // What comes this way is never "this machine": without a token it is refused.
    const raw = await openBack(server.app, "laptop");
    const answer = await new Promise<string>((ok) => {
      let text = "";
      raw.on("data", (d: Buffer) => (text += d.toString()));
      raw.on("close", () => ok(text));
      raw.write("GET /api/peers HTTP/1.1\r\nhost: 127.0.0.1\r\nconnection: close\r\n\r\n");
    });
    expect(answer).toMatch(/^HTTP\/1\.1 401/);

    // The laptop's agent as a backend of the server: the bridge runs as its own process and asks the
    // server's service for a stream; tools stay on the server.
    server.app.config.agents.profiles = [{ id: "laptop-fake", name: "Fake（laptop）", transport: "acp", command: "omem", args: [], env: { OMEM_HOME: server.home, OMEM_PORT: new URL(server.app.baseUrl!).port }, idleTimeoutMs: 60_000, peer: { id: "laptop", agent: "fake" } }];
    server.app.config.agents.default = "laptop-fake";
    saveConfig(server.app.config, server.home);
    const { runId } = await ask(server.app, { text: "反向连接能用吗" });
    const run = await waitForRun(server.app, runId!);
    expect(run.error).toBeNull();
    // The fake agent's answer lists the tools it was given: they are the server's, relayed from there.
    expect((run.output as { answer: string }).answer).toMatch(/^tools=\d+; search=/);

    // Off: the laptop says goodbye, the server forgets it, the token is gone.
    const token = findPeer(laptop.app, "server")!.serveBack!.token;
    setServeBack(laptop.app, "server", false);
    expect(userForToken(laptop.app, token)).toBeNull();
    await until(() => !findPeer(server.app, "laptop"));
    await expect(peerJson(relay.app, "laptop", "/api/diag")).resolves.toMatchObject({ node: "laptop" });
  }, 120_000);

  it("refuses a control connection without the owner's token", async () => {
    const device = await node("device3");
    const res = await fetch(`${device.app.baseUrl}/api/peer/back?node=x`, { headers: { connection: "Upgrade", upgrade: "omem-back" } }).catch((e: Error) => e);
    expect(res instanceof Error || res.status !== 101).toBe(true);
  }, 30_000);
});
