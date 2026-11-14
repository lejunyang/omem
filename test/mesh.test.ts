import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { agentProfileSchema } from "../src/core/config.ts";
import { one } from "../src/core/db.ts";
import { shareInvite, subscribe } from "../src/core/federation.ts";
import { askPeerAgent, knownCards, meshNote, nodeCard, refreshCards, setGrants } from "../src/core/mesh.ts";
import { addPeer } from "../src/core/peers.ts";
import { createSpace } from "../src/core/spaces.ts";
import { boot } from "../src/main.ts";
import { getSource } from "../src/sources/store.ts";
import { importText } from "../src/sources/import.ts";

/** Two servers (docs/v2/mesh.md): B learns what A has from A's card and asks one of A's Agents. */
describe("several omem working together", async () => {
  const homeA = mkdtempSync(join(tmpdir(), "omem-mesh-a-"));
  const homeB = mkdtempSync(join(tmpdir(), "omem-mesh-b-"));
  writeFileSync(join(homeA, "config.json"), JSON.stringify({ node: { id: "server-a" } }));
  writeFileSync(join(homeB, "config.json"), JSON.stringify({ node: { id: "server-b" } }));
  const a = await boot(homeA, { port: 0, quiet: true, background: false });
  const b = await boot(homeB, { port: 0, quiet: true, background: false });
  afterAll(() => {
    a.server.close();
    b.server.close();
  });
  const A = a.app;
  const B = b.app;

  createSpace(A, { id: "handbook", name: "手册", description: "报销和差旅制度" });
  createSpace(A, { id: "secret", name: "保密" });
  const doc = importText(A, "handbook", { title: "报销制度", text: "# 报销制度\n\n差旅报销在出差结束后 30 天内提交。\n住宿标准一线城市每晚 600 元。", kind: "doc" });
  // A's Agent (the real ACP path, test/fake-acp-agent.ts): answers with a citation of A's document.
  A.config.agents.default = "fake";
  A.config.agents.profiles = [agentProfileSchema.parse({ id: "fake", transport: "acp", command: process.execPath, args: [resolve("test/fake-acp-agent.ts")], env: { FAKE_SAY: `一线城市每晚 600 元（[报销制度](src:${doc.id}#L4)）。` } })];

  let svc = "";
  it("a node's card shows another server only what it was granted; the owner's own device sees everything", async () => {
    const r = shareInvite(A, { label: "server-b", shares: [{ space: "handbook", mode: "query", kinds: ["wiki", "memory", "doc"] }], url: A.baseUrl! });
    svc = r.userId;
    await addPeer(B, r.code);
    // Nothing granted beyond the space: no Agents, no AI, no assistants on the card.
    expect(await nodeCard(A, svc)).toMatchObject({ node: "server-a", spaces: [{ id: "handbook", name: "手册", description: "报销和差旅制度", mode: "query" }] });
    expect((await nodeCard(A, svc)).agents).toBeUndefined();
    setGrants(A, svc, [{ kind: "agent", name: "assistant", daily: 1 }]);
    expect((await nodeCard(A, svc)).agents).toEqual([expect.objectContaining({ name: "assistant", daily: 1 })]);
    expect((await nodeCard(A, svc)).ai).toBeUndefined();
    // The owner's own device.
    const own = await nodeCard(A, "owner");
    expect(own.spaces!.map((s) => s.id)).toEqual(expect.arrayContaining(["handbook", "secret"]));
    expect(own.ai!.map((x) => x.id)).toContain("fake");
    expect(() => setGrants(A, "owner", [])).toThrow(/服务账号/);
  });

  it("the other node keeps the card and tells its assistant who is out there", async () => {
    expect(meshNote(B)).toBe("");
    const cards = await refreshCards(B);
    expect(cards).toEqual([expect.objectContaining({ peer: "server-a", card: expect.objectContaining({ node: "server-a" }) })]);
    const note = meshNote(B);
    expect(note).toContain("「server-a」");
    expect(note).toContain("assistant@server-a");
    expect(note).toContain("手册（报销和差旅制度）");
    expect(knownCards(B)).toHaveLength(1);
  });

  it("asks an Agent of the other node: it runs there read-only, and what it cites opens here", async () => {
    await subscribe(B, { peer: "server-a", remoteSpace: "handbook", mode: "query" });
    const r = await askPeerAgent(B, "server-a", "assistant", "一线城市住宿标准是多少？", { runId: "r-local", asker: "主助手", pollMs: 200 });
    expect(r.answer).toContain("600 元");
    expect(r.landed).toBe(1);
    const local = /src:([\w-]+)#L4/.exec(r.answer)![1];
    expect(local).not.toBe(doc.id);
    expect(getSource(B, local).title).toBe("报销制度");
    // On A: a run of its own, by B's service account, saying where it came from.
    const run = one<{ user_id: string; trigger: string; input: string; status: string }>(A.db, "select user_id, trigger, input, status from runs where id = ?", r.remoteRun)!;
    expect(run).toMatchObject({ status: "done" });
    expect(JSON.parse(run.trigger)).toMatchObject({ via: "peer", by: { key: `user:${svc}` } });
    expect(JSON.parse(run.input)).toMatchObject({ role: "guest", fedAsk: { agent: "assistant", node: svc, run: "r-local", asker: "主助手" } });
    // The daily limit of the grant, and an Agent that was not granted.
    await expect(askPeerAgent(B, "server-a", "assistant", "再问一次", { pollMs: 200 })).rejects.toThrow(/次数用完了/);
    await expect(askPeerAgent(B, "server-a", "researcher", "你好", { pollMs: 200 })).rejects.toThrow(/没有开放/);
  });
});
