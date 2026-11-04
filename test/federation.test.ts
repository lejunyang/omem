import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { can } from "../src/auth/permissions.ts";
import { one } from "../src/core/db.ts";
import { fedSearch, fedSource, peerRead, peerSearch, revokeShareAccount, shareInvite, subscribe, syncSubscription } from "../src/core/federation.ts";
import { addPeer } from "../src/core/peers.ts";
import { createSpace } from "../src/core/spaces.ts";
import { boot } from "../src/main.ts";
import { remember } from "../src/memory/store.ts";
import { importText } from "../src/sources/import.ts";
import { readPage, writePage } from "../src/wiki/store.ts";

/** Two servers (docs/v2/multi-user.md “多服务连接”): A shares a space with B, B searches and mirrors it. */
describe("sharing between servers", async () => {
  const homeA = mkdtempSync(join(tmpdir(), "omem-fed-a-"));
  const homeB = mkdtempSync(join(tmpdir(), "omem-fed-b-"));
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

  createSpace(A, { id: "handbook", name: "手册" });
  createSpace(A, { id: "secret", name: "保密" });
  const doc = importText(A, "handbook", { title: "报销制度", text: "# 报销制度\n\n差旅报销在出差结束后 30 天内提交。\n住宿标准一线城市每晚 600 元。", kind: "doc" });
  const secret = importText(A, "secret", { title: "薪资", text: "薪资调整方案 机密", kind: "doc" });
  const chat = importText(A, "handbook", { title: "群聊", text: "[10:00] 小王: 报销截止是 30 天", kind: "chat" });
  writePage(A, "handbook", "travel", { meta: { title: "差旅" }, body: `出差结束后 30 天内提交报销（[依据](src:${doc.id}#L3-L3)）。` });
  remember(A, { spaceId: "handbook", kind: "fact", content: `差旅报销期限是 30 天 src:${doc.id}#L3`, sourceRefs: [`src:${doc.id}#L3`] });

  let serviceUser = "";
  it("pairs another server as a service account that sees only what is shared", async () => {
    const r = shareInvite(A, { label: "server-b", shares: [{ space: "handbook", mode: "sync", kinds: ["wiki", "memory", "doc"] }], url: A.baseUrl! });
    serviceUser = r.userId;
    expect(one<{ kind: string }>(A.db, "select kind from users where id = ?", serviceUser)!.kind).toBe("service");
    await addPeer(B, r.code);
    // What A gives this account: the doc and the page, not the chat (kind not shared) or the other space.
    expect((await fedSearch(A, serviceUser, { query: "报销" })).map((h) => h.space)).not.toContain("secret");
    expect((await fedSearch(A, serviceUser, { query: "薪资 机密" })).length).toBe(0);
    expect(() => fedSource(A, serviceUser, secret.id)).toThrow(/没有共享/);
    expect(() => fedSource(A, serviceUser, chat.id)).toThrow(/没有共享/);
    // The service account is not a person: the rest of A's API stays closed to it.
    const token = /"token":"([^"]+)"/.exec(Buffer.from(r.code.slice(6), "base64url").toString())![1];
    expect((await fetch(`${A.baseUrl}/api/spaces/secret`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(403);
    expect((await fetch(`${A.baseUrl}/api/settings`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(403);
  });

  it("searches the other server live, and brings a source here to cite it", async () => {
    const s = await subscribe(B, { peer: "server-a", remoteSpace: "handbook", mode: "sync" });
    expect(s.localSpace).toBe("server-a-handbook");
    const r = await peerSearch(B, "住宿标准");
    expect(r.missed).toEqual([]);
    const hit = r.hits.find((h) => h.type === "source")!;
    expect(hit.peer).toBe("server-a");
    const local = await peerRead(B, "server-a", hit.id);
    const row = one<{ space_id: string; text: string; uri: string }>(B.db, "select space_id, text, uri from sources where id = ?", local.id)!;
    expect(row.space_id).toBe("server-a-handbook");
    expect(row.text).toContain("每晚 600 元");
    expect(row.uri).toBe(`peer:server-a:${hit.id}`);
    // Reading it again keeps the one copy.
    expect((await peerRead(B, "server-a", hit.id)).id).toBe(local.id);
  });

  it("syncs pages and memories with citations pointing at the local copies, read-only here", async () => {
    const r = await syncSubscription(B, (await subscribe(B, { peer: "server-a", remoteSpace: "handbook", mode: "sync" })).id);
    expect(r.applied).toBeGreaterThan(0);
    const localDoc = one<{ local_id: string }>(B.db, "select local_id from peer_aliases where peer = 'server-a' and entity = 'source' and remote_id = ?", doc.id)!.local_id;
    expect(readPage(B, "server-a-handbook", "travel").body).toContain(`src:${localDoc}#L3-L3`);
    const m = one<{ content: string; reviewed_at: string | null }>(B.db, "select content, reviewed_at from memories where space_id = 'server-a-handbook'")!;
    expect(m.content).toContain(`src:${localDoc}#L3`);
    expect(m.reviewed_at).not.toBeNull();
    // The chat was not shared: it did not come along.
    expect(one(B.db, "select 1 from sources where space_id = 'server-a-handbook' and kind = 'chat'")).toBeUndefined();
    // A mirror is written by the sync only.
    expect(can(B, "owner", "wiki.write", "server-a-handbook")).toBe(false);
    expect(can(B, "owner", "space.read", "server-a-handbook")).toBe(true);
    // A later change on A arrives with the next sync.
    writePage(A, "handbook", "travel", { meta: { title: "差旅" }, body: "改成 45 天内提交。" });
    await syncSubscription(B, (await subscribe(B, { peer: "server-a", remoteSpace: "handbook", mode: "sync" })).id);
    expect(readPage(B, "server-a-handbook", "travel").body).toContain("45 天");
  });

  it("stops at once when A stops sharing", async () => {
    revokeShareAccount(A, serviceUser);
    const r = await peerSearch(B, "报销");
    expect(r.hits).toEqual([]);
    expect(r.missed).toEqual(["server-a"]);
  });
});
