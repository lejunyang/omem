import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { callTool, issueToolToken, toolContextForToken } from "../src/agents/tools.ts";
import { setAuthFetchForTests } from "../src/auth/providers.ts";
import { storeConnection } from "../src/auth/vault.ts";
import { keptHere, setVisibility, sourceReadable, sourceVisible } from "../src/auth/visibility.ts";
import { one } from "../src/core/db.ts";
import { fedSearch, serviceAccount, setShares } from "../src/core/federation.ts";
import { createSpace, updateSpace } from "../src/core/spaces.ts";
import { addMember, createApiToken, createUser } from "../src/core/users.ts";
import { boot } from "../src/main.ts";
import { importText } from "../src/sources/import.ts";
import { upsertSource } from "../src/sources/store.ts";

/** Sources seen by fewer people than their space (docs/v2/multi-user.md “原件级可见性”). */
describe("who may see a source", async () => {
  const home = mkdtempSync(join(tmpdir(), "omem-vis-"));
  writeFileSync(join(home, "config.json"), JSON.stringify({ lark: { appId: "cli_test" } }));
  const { app, server } = await boot(home, { port: 0, quiet: true, background: false });
  const asked: string[] = [];
  setAuthFetchForTests((async (url: string | URL | Request, init?: RequestInit) => {
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    asked.push(`${String(url)} ${auth}`);
    // Feishu: ann may read doc_ok, nobody may read doc_no; asking about doc_flaky fails (a scope is missing).
    if (String(url).includes("/doc_flaky/")) return new Response(JSON.stringify({ code: 99991679, msg: "Unauthorized. You do not have permission to perform the requested operation on the resource." }), { status: 400 });
    const allowed = String(url).includes("/doc_ok/") && auth === "Bearer at_ann";
    return new Response(JSON.stringify({ code: 0, data: { auth_result: allowed } }));
  }) as typeof fetch);
  afterAll(() => {
    setAuthFetchForTests(null);
    server.close();
  });
  const base = app.baseUrl!;

  createSpace(app, { id: "proj", name: "项目" });
  for (const id of ["ann", "bob", "mgr"]) createUser(app, { name: id, id });
  addMember(app, "proj", "ann", "editor");
  addMember(app, "proj", "bob", "editor");
  addMember(app, "proj", "mgr", "manager");
  const secret = importText(app, "proj", { title: "单聊", text: "只给小安看的单聊 关键词甲乙", kind: "note" });
  const open = importText(app, "proj", { title: "公开", text: "大家都能看的说明 关键词甲乙", kind: "note" });
  setVisibility(app, secret.id, "restricted", ["ann"]);
  const tokens = Object.fromEntries(["ann", "bob", "mgr"].map((u) => [u, createApiToken(app, u, "t")]));
  const as = (u: string, path: string, init: RequestInit = {}) => fetch(base + path, { ...init, headers: { authorization: `Bearer ${tokens[u]}`, ...(init.body ? { "content-type": "application/json" } : {}) } });
  const ctx = (u: string) => toolContextForToken(app, issueToolToken({ runId: null, spaceId: "proj", spaces: ["proj", `personal-${u}`], tools: null, actor: "agent", userId: u }))!;

  it("restricted: its viewers and the space's managers, nobody else in the space", async () => {
    expect(sourceVisible(app, "ann", secret.id)).toBe(true);
    expect(sourceVisible(app, "mgr", secret.id)).toBe(true);
    expect(sourceVisible(app, "bob", secret.id)).toBe(false);
    expect(sourceVisible(app, "owner", secret.id)).toBe(true);
    expect((await as("bob", `/api/sources/${secret.id}`)).status).toBe(403);
    expect((await as("ann", `/api/sources/${secret.id}`)).status).toBe(200);
    const list = await (await as("bob", "/api/sources?space=proj")).json();
    expect(list.sources.map((s: { id: string }) => s.id)).not.toContain(secret.id);
    const hits = await (await as("bob", "/api/search?q=关键词甲乙&space=proj")).json();
    expect(hits.hits.map((h: { sourceId?: string }) => h.sourceId)).not.toContain(secret.id);
    expect((await callTool(ctx("bob"), "search", { query: "关键词甲乙", space: "proj" })).text).not.toContain(secret.id);
    expect((await callTool(ctx("bob"), "read_source", { source: secret.id })).text).toMatch(/只对部分人开放/);
    expect((await callTool(ctx("ann"), "read_source", { source: secret.id })).text).toContain("只给小安看的单聊");
    expect(keptHere(app, secret.id)).toBe(true);
    expect(keptHere(app, open.id)).toBe(false);
    // Only a manager decides it.
    expect((await as("bob", `/api/sources/${open.id}/visibility`, { method: "PUT", body: JSON.stringify({ visibility: "restricted" }) })).status).toBe(403);
  });

  it("is never sent to another server, nor quoted by a shared space's page", async () => {
    const svc = serviceAccount(app, "other");
    setShares(app, svc, [{ space: "proj", mode: "query", kinds: ["note", "wiki"] }]);
    const ids = (await fedSearch(app, svc, { query: "关键词甲乙" })).map((h) => h.id);
    expect(ids).toContain(open.id);
    expect(ids).not.toContain(secret.id);
    const r = await callTool(ctx("ann"), "write_page", { page: "notes", title: "笔记", summary: "x", body: `见 [单聊](src:${secret.id}#L1-L1)`, space: "proj" });
    expect(r.text).toMatch(/不能引用只对部分人开放的原件/);
  });

  it("a space's Feishu documents in full only for those Feishu lets read them", async () => {
    updateSpace(app, "proj", { settings: { larkAccess: true } });
    const ok = upsertSource(app, { spaceId: "proj", kind: "doc", uri: "https://tenant.larkoffice.com/docx/doc_ok", title: "方案", text: "飞书文档 关键词丙丁", meta: { documentId: "doc_ok" } });
    const no = upsertSource(app, { spaceId: "proj", kind: "doc", uri: "https://tenant.larkoffice.com/docx/doc_no", title: "名单", text: "飞书文档 关键词丙丁", meta: { documentId: "doc_no" } });
    // Without a connection: not at all.
    expect(await sourceReadable(app, "bob", ok.id)).toBe(false);
    storeConnection(app, { userId: "ann", provider: "lark", accountId: "on_ann", accountName: "ann", scopes: [], accessToken: "at_ann", expiresIn: 7200 });
    // Unknown yet: search shows the title only.
    const before = await callTool(ctx("ann"), "search", { query: "关键词丙丁", space: "proj" });
    expect(before.text).toMatch(/核对你在飞书里/);
    expect(await sourceReadable(app, "ann", ok.id)).toBe(true);
    expect(await sourceReadable(app, "ann", no.id)).toBe(false);
    // Kept a day: asked once.
    const n = asked.length;
    expect(await sourceReadable(app, "ann", ok.id)).toBe(true);
    expect(asked.length).toBe(n);
    expect((await as("ann", `/api/sources/${no.id}`)).status).toBe(403);
    expect((await as("ann", `/api/sources/${ok.id}`)).status).toBe(200);
    expect(one<{ allowed: number }>(app.db, "select allowed from source_access where source_id = ? and user_id = 'ann'", ok.id)!.allowed).toBe(1);
    // Never leaves this server either; the owner is not checked.
    expect(keptHere(app, ok.id)).toBe(true);
    expect(await sourceReadable(app, "owner", no.id)).toBe(true);
  });

  it("does not keep a failed Feishu call as a no", async () => {
    const doc = upsertSource(app, { spaceId: "proj", kind: "doc", uri: "https://tenant.larkoffice.com/docx/doc_flaky", title: "周报", text: "飞书文档 周报", meta: { documentId: "doc_flaky" } });
    expect(await sourceReadable(app, "ann", doc.id)).toBe(false);
    expect(one(app.db, "select 1 from source_access where source_id = ?", doc.id)).toBeFalsy();
    // Not asked again right away: in ten minutes it is.
    const n = asked.length;
    expect(await sourceReadable(app, "ann", doc.id)).toBe(false);
    expect(asked.length).toBe(n);
  });

  it("only the owner sets other space settings; nobody sets a mirror by hand", async () => {
    expect((await as("mgr", "/api/spaces/proj", { method: "PATCH", body: JSON.stringify({ settings: { larkAccess: false } }) })).status).toBe(200);
    expect((await as("mgr", "/api/spaces/proj", { method: "PATCH", body: JSON.stringify({ settings: { autoLint: false } }) })).status).toBe(403);
    expect((await fetch(`${base}/api/spaces/proj`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ settings: { mirror: { peer: "x", remoteSpace: "y" } } }) })).status).toBe(400);
  });
});
