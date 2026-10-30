import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ask } from "../src/agents/jobs.ts";
import { waitForRun } from "../src/agents/runs.ts";
import { addPeer, invite } from "../src/core/peers.ts";
import { allProfiles, saveConfig } from "../src/core/config.ts";
import { listMemories } from "../src/memory/store.ts";
import { importText } from "../src/sources/import.ts";
import { boot } from "../src/main.ts";

const servers: { close(): Promise<unknown> }[] = [];
afterAll(async () => {
  // The laptop first: its agent session holds connections open on the others.
  for (const s of servers.reverse()) await s.close();
});

async function node(id: string, config: object) {
  const home = mkdtempSync(join(tmpdir(), `omem-peeracp-${id}-`));
  writeFileSync(join(home, "config.json"), JSON.stringify(config));
  const b = await boot(home, { port: 0, quiet: true, background: false });
  b.app.config.node = { id };
  b.app.config.token = `owner-${id}`;
  servers.push(b.server);
  return { app: b.app, home };
}

describe("an ACP agent of another device", () => {
  it("runs there and uses this machine's tools through the connection", async () => {
    // The device has the agent; the laptop has none of its own and reaches the device through a relay.
    const device = await node("device", { agents: { profiles: [{ id: "fake", transport: "acp", command: process.execPath, args: [resolve("test/fake-acp-agent.ts")] }] } });
    const relay = await node("relay", {});
    const laptop = await node("laptop", {});
    await addPeer(relay.app, invite(device.app, { url: device.app.baseUrl! }).code);
    await addPeer(laptop.app, invite(relay.app, { url: relay.app.baseUrl! }).code);
    await addPeer(laptop.app, invite(device.app, { url: "http://unreachable.invalid" }).code, { via: "relay" });
    laptop.app.config.agents.profiles = [{ id: "device-fake", name: "Fake（device）", transport: "acp", command: "omem", args: [], env: { OMEM_HOME: laptop.home }, idleTimeoutMs: 60_000, peer: { id: "device", agent: "fake" } }];
    laptop.app.config.agents.default = "device-fake";
    saveConfig(laptop.app.config, laptop.home);
    const profile = allProfiles(laptop.app.config).find((p) => p.id === "device-fake")!;
    expect(profile.args.slice(-4)).toEqual(["peer", "acp", "device", "fake"]);

    importText(laptop.app, "personal", { title: "约定", text: "每周四下午三点和小王同步项目A进度。" });
    const { runId } = await ask(laptop.app, { text: "和小王什么时候同步" });
    const run = await waitForRun(laptop.app, runId!);
    expect(run.error).toBeNull();
    // The search and the memory happened here, on the laptop's library.
    expect((run.output as { answer: string }).answer).toMatch(/search=1\. 原件/);
    expect(listMemories(laptop.app, {}).map((m) => m.content)).toContain("FAKE: 和小王什么时候同步");
    expect(listMemories(device.app, {}).map((m) => m.content)).not.toContain("FAKE: 和小王什么时候同步");
  }, 90_000);

  it("refuses without the owner's token and for agents the device does not have", async () => {
    const { connectAcp } = await import("../src/core/peer-acp.ts");
    const device = await node("device2", {});
    const laptop = await node("laptop2", {});
    await addPeer(laptop.app, invite(device.app, { url: device.app.baseUrl! }).code);
    await expect(connectAcp(laptop.app, "device2", "nope")).rejects.toThrow(/没有可用的 Agent nope/);
    const res = await fetch(`${device.app.baseUrl}/api/peer/acp?agent=fake`, { headers: { connection: "Upgrade", upgrade: "omem-acp" } }).catch((e: Error) => e);
    expect(res instanceof Error || res.status !== 101).toBe(true);
  }, 30_000);
});
