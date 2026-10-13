import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { receive } from "../src/agents/inbox.ts";
import { getRun, waitForRun } from "../src/agents/runs.ts";
import { releaseAll } from "../src/agents/sessions.ts";
import { callTool, issueToolToken, toolContextForToken } from "../src/agents/tools.ts";
import { createSpace } from "../src/core/spaces.ts";
import { accessibleSpaces, addMember, createApiToken, createUser, linkIdentity, resolveIdentity } from "../src/core/users.ts";
import { listItems } from "../src/items/store.ts";
import { importText } from "../src/sources/import.ts";
import { boot } from "../src/main.ts";

describe("users: identities, spaces, per-user turns and API", async () => {
  const home = mkdtempSync(join(tmpdir(), "omem-users-"));
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      lark: { ownerOpenId: "ou_owner" },
      agents: { default: "fake", profiles: [{ id: "fake", transport: "acp", command: process.execPath, args: [resolve("test/fake-acp-agent.ts")], env: { FAKE_MODE: "thread" } }] },
      sessions: { mergeMs: 0 },
    }),
  );
  const { app, server } = await boot(home, { port: 0, quiet: true, background: false });
  afterAll(() => {
    releaseAll();
    server.close();
  });

  it("maps channel identities to users and limits spaces", async () => {
    createSpace(app, { id: "team", name: "团队" });
    createSpace(app, { id: "secret", name: "私密" });
    const u = createUser(app, { name: "小王", id: "wang" });
    linkIdentity(app, u.id, "lark", "ou_wang");
    addMember(app, "team", u.id, "reader");
    expect(resolveIdentity(app, "lark", "ou_owner")).toBe("owner");
    expect(resolveIdentity(app, "lark", "ou_wang")).toBe("wang");
    expect(resolveIdentity(app, "lark", "ou_stranger")).toBeNull();
    expect(accessibleSpaces(app, "owner")).toBeNull();
    expect(accessibleSpaces(app, "wang")?.sort()).toEqual(["personal-wang", "team"]);

    // The member's private chat lands in their own space and runs as them.
    const r = await receive(app, { channel: "lark", chatId: "oc_wang", text: "你好", userId: "wang" });
    expect(r.thread.spaceId).toBe("personal-wang");
    expect(r.thread.userId).toBe("wang");
    const done = await waitForRun(app, r.runId!);
    expect(done.error).toBeNull();
    expect((await receive(app, { channel: "lark", chatId: "oc_wang", text: "/space secret", userId: "wang" })).reply).toMatch(/不能访问/);
    expect((await receive(app, { channel: "lark", chatId: "oc_wang", text: "/whoami", userId: "wang" })).reply).toMatch(/personal-wang/);
    expect((await receive(app, { channel: "lark", chatId: "oc_wang", text: "/todo 交周报", userId: "wang" })).reply).toMatch(/已加待办/);
    expect(listItems(app, { userId: "wang" }).map((i) => i.title)).toContain("交周报");
    expect(listItems(app, { userId: "owner" }).map((i) => i.title)).not.toContain("交周报");
    expect(getRun(app, r.runId!).status).toBe("done");
  }, 60000);

  it("tool tokens carry the user's scope", async () => {
    importText(app, "secret", { title: "s", text: "机密预算 999" });
    const token = issueToolToken({ runId: null, spaceId: "personal-wang", spaces: accessibleSpaces(app, "wang"), tools: null, actor: "agent", userId: "wang" });
    const ctx = toolContextForToken(app, token)!;
    expect((await callTool(ctx, "search", { query: "机密预算", space: "secret" })).text).toMatch(/不能访问|没有命中/);
    await callTool(ctx, "remember", { content: "回答用英文", kind: "preference" });
    const pref = app.db.prepare("select user_id from memories where content = ?").get("回答用英文") as { user_id: string };
    expect(pref.user_id).toBe("wang");
  });

  it("member API tokens reach only the member routes", async () => {
    const base = app.baseUrl!;
    const token = createApiToken(app, "wang", "test");
    const h = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    expect((await fetch(`${base}/api/me`, { headers: h }).then((r) => r.json())).id).toBe("wang");
    expect((await fetch(`${base}/api/spaces`, { headers: h })).status).toBe(403);
    const asked = await fetch(`${base}/api/ask`, { method: "POST", headers: h, body: JSON.stringify({ text: "/whoami" }) }).then((r) => r.json());
    expect(asked.reply).toMatch(/小王/);
    expect((await fetch(`${base}/api/ask`, { method: "POST", headers: h, body: JSON.stringify({ text: "hi", space: "secret" }) })).status).toBe(403);
    const convs = (await fetch(`${base}/api/conversations`, { headers: h }).then((r) => r.json())) as { user_id: string }[];
    expect(convs.every((c) => c.user_id === "wang")).toBe(true);
  });
});
