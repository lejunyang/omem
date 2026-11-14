import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { callTool, type ToolContext } from "../src/agents/tools.ts";
import { all, one } from "../src/core/db.ts";
import { subscribe, syncAll } from "../src/core/federation.ts";
import { flushOutbox, listOutbox, placementOf } from "../src/core/mesh-write.ts";
import { addPeer, invite } from "../src/core/peers.ts";
import { createSpace } from "../src/core/spaces.ts";
import { boot } from "../src/main.ts";
import { importText } from "../src/sources/import.ts";

/**
 * The owner's two devices (docs/v2/mesh.md §5): the server is the home of a space, the laptop keeps a
 * synced mirror of it. What the laptop writes into the mirror is written on the home and comes back.
 */
describe("a space has one home: writes into its mirror go there", async () => {
  const homeA = mkdtempSync(join(tmpdir(), "omem-home-"));
  const homeB = mkdtempSync(join(tmpdir(), "omem-laptop-"));
  writeFileSync(join(homeA, "config.json"), JSON.stringify({ node: { id: "server" } }));
  writeFileSync(join(homeB, "config.json"), JSON.stringify({ node: { id: "laptop" } }));
  const a = await boot(homeA, { port: 0, quiet: true, background: false });
  const b = await boot(homeB, { port: 0, quiet: true, background: false });
  afterAll(async () => {
    await b.server.close();
    await a.server.close();
  });
  const A = a.app;
  const B = b.app;
  A.config.token = "owner-server";

  createSpace(A, { id: "handbook", name: "手册" });
  const doc = importText(A, "handbook", { title: "报销制度", text: "# 报销制度\n\n差旅报销在出差结束后 30 天内提交。\n住宿标准一线城市每晚 600 元。", kind: "doc" });
  await addPeer(B, invite(A, { url: A.baseUrl! }).code);
  const sub = await subscribe(B, { peer: "server", remoteSpace: "handbook", mode: "sync" });
  await syncAll(B);
  const mirror = sub.localSpace;
  const localDoc = one<{ local_id: string }>(B.db, "select local_id from peer_aliases where peer = 'server' and entity = 'source' and remote_id = ?", doc.id)!.local_id;
  const ctx = (): ToolContext => ({ app: B, spaceId: mirror, spaces: null, tools: null, actor: "agent", profile: "test", approved: true, runId: null }) as ToolContext;
  const memoriesOn = (app: typeof A, space: string) => all<{ content: string; source_refs: string }>(app.db, "select content, source_refs from memories where space_id = ? and status = 'active' order by created_at", space);

  it("writes a memory on the home, with the home's ids, and it comes back with the sync", async () => {
    expect(placementOf(B, mirror)).toEqual({ kind: "replica", peer: "server", sync: true });
    expect(placementOf(A, "handbook")).toEqual({ kind: "home" });
    const r = await callTool(ctx(), "remember", { kind: "fact", content: "一线城市住宿标准是每晚 600 元", source_refs: [`src:${localDoc}#L4`], space: mirror });
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toContain("主在 server");
    // On the home: the memory, citing the home's own document.
    expect(memoriesOn(A, "handbook")).toEqual([expect.objectContaining({ content: "一线城市住宿标准是每晚 600 元", source_refs: JSON.stringify([`src:${doc.id}#L4`]) })]);
    // Here: one copy, the synced one (citing this node's mirror of the document), not a second local one.
    expect(memoriesOn(B, mirror)).toEqual([expect.objectContaining({ content: "一线城市住宿标准是每晚 600 元", source_refs: JSON.stringify([`src:${localDoc}#L4`]) })]);
    // A space of this node's own is written here as always.
    createSpace(B, { id: "notes", name: "笔记" });
    const own = await callTool({ ...ctx(), spaceId: "notes" }, "remember", { kind: "fact", content: "本机自己的一条", space: "notes" });
    expect(own.isError, own.text).toBe(false);
    expect(memoriesOn(B, "notes")).toHaveLength(1);
    expect(memoriesOn(A, "handbook")).toHaveLength(1);
  });

  it("refuses what cites something the home does not have", async () => {
    const stray = importText(B, "notes", { title: "草稿", text: "只在笔记本上的草稿", kind: "note" });
    const r = await callTool(ctx(), "remember", { kind: "fact", content: "引用了本机的草稿", source_refs: [`src:${stray.id}#L1`], space: mirror });
    expect(r).toMatchObject({ isError: true, text: expect.stringContaining("主（server）上没有的原件") });
    expect(memoriesOn(A, "handbook")).toHaveLength(1);
  });

  it("keeps a write for a home that cannot be reached, and sends it when it can", async () => {
    // The home goes away: its address no longer answers.
    const file = join(B.home, "secrets", "peers.json");
    const saved = readFileSync(file, "utf8");
    writeFileSync(file, JSON.stringify((JSON.parse(saved) as { url: string; urls?: string[] }[]).map((p) => ({ ...p, url: "http://127.0.0.1:9", urls: ["http://127.0.0.1:9"] }))));
    const r = await callTool(ctx(), "remember", { kind: "fact", content: "报销要在 30 天内提交", source_refs: [`src:${localDoc}#L3`], space: mirror });
    expect(r).toMatchObject({ isError: false, text: expect.stringContaining("发件箱") });
    expect(listOutbox(B)).toEqual([expect.objectContaining({ peer: "server", space: "handbook", tool: "remember", status: "waiting", summary: "报销要在 30 天内提交" })]);
    expect(await flushOutbox(B)).toMatchObject({ sent: 0, waiting: 1 });
    expect(memoriesOn(A, "handbook")).toHaveLength(1);
    // Back again: the scheduled sync sends what waited, then brings it home.
    writeFileSync(file, saved);
    await syncAll(B);
    expect(listOutbox(B)).toEqual([]);
    expect(memoriesOn(A, "handbook").map((m) => m.content)).toContain("报销要在 30 天内提交");
    expect(memoriesOn(B, mirror).map((m) => m.content)).toContain("报销要在 30 天内提交");
  }, 60_000);
});
