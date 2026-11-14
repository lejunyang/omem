import { afterAll, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boot } from "../src/main.ts";
import { run } from "../src/core/db.ts";
import { createApiToken, createUser, setUserRole } from "../src/core/users.ts";
import { upsertSource } from "../src/sources/store.ts";
import { listIgnoreRules } from "../src/core/notify-lessons.ts";

const { app, server } = await boot(mkdtempSync(join(tmpdir(), "omem-notification-settings-")), { port: 0, quiet: true, background: false });
afterAll(async () => { await server.close(); app.db.close(); rmSync(app.home, { recursive: true, force: true }); });
const request = (path: string, init: RequestInit = {}) => fetch(app.baseUrl + path, init);

it("owner gets outcome breakdown and source titles; invalid days rejected", async () => {
  const at = new Date(Date.now() - 72 * 3600_000).toISOString();
  const s = upsertSource(app, { spaceId: "personal", kind: "chat", uri: "lark:oc_team", title: "项目 A", text: "排期" });
  run(app.db, "insert into notifications(id,at,title,body,context,outcome,outcome_at) values('outcome',?,'提醒','',?,'unread',?)", at, JSON.stringify({ sourceRefs: [`src:${s.id}#L1`] }), at);
  const r = await request("/api/notifications/outcomes?days=30");
  expect(r.status).toBe(200);
  expect(await r.json()).toMatchObject({ days: 30, senders: [{ sender: "host", sent: 1, unread: 1 }], sources: [{ title: "项目 A", sourceId: s.id, sent: 1 }] });
  expect((await request("/api/notifications/outcomes?days=0")).status).toBe(400);
  const saved = await request("/api/notifications/outcomes/ignore", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sourceId: s.id }) });
  expect(saved.status).toBe(200);
  expect(listIgnoreRules(app)[0].rule).toBe("项目 A 里的消息不用提醒我，点名我或限时的事除外");
});

it("ladder reports the union of configured lists once and settings keep them disjoint", async () => {
  app.config.approvals.tools = ["upsert_item"];
  app.config.approvals.report = ["notify"];
  expect(await (await request("/api/approvals/ladder")).json()).toEqual([{ tool: "upsert_item", rung: "ask", streak: 0 }, { tool: "notify", rung: "report", streak: 0 }]);
  const saved = await request("/api/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ approvals: { tools: ["upsert_item"], report: ["upsert_item", "notify"], promoteAfter: 0 } }) });
  expect(saved.status).toBe(200);
  expect(app.config.approvals.report).toEqual(["notify"]);
});

it("outcomes, ignore and ladder routes are owner only, including admins", async () => {
  createUser(app, { id: "reader", name: "测试成员" });
  setUserRole(app, "reader", "admin");
  const token = createApiToken(app, "reader", "test");
  for (const path of ["/api/notifications/outcomes", "/api/approvals/ladder", "/api/notifications/outcomes/ignore"]) {
    const res = await request(path, { method: path.endsWith("ignore") ? "POST" : "GET", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(path.endsWith("ignore") ? { body: "{}" } : {}) });
    expect(res.status).toBe(403);
  }
});

it("bundle entries resolve their own links even beyond the first page", async () => {
  const at = new Date().toISOString();
  run(app.db, "insert into notifications(id,at,title,body,link) values('original','2000-01-01','查询完成','','#/runs/result')");
  run(app.db, "insert into notifications(id,at,title,body,context) values('bundle',?,'进展清单','',?)", at, JSON.stringify({ bundle: ["original"] }));
  const result = await (await request("/api/notifications")).json();
  expect(result.notifications.find((n: { id: string }) => n.id === "bundle").bundleItems).toEqual([{ id: "original", title: "查询完成", link: "#/runs/result" }]);
});

it("reaction learning defaults on, persists off, and rules can be read and deleted on the notification page", async () => {
  expect(app.config.notify.learnFromReactions).toBe(true);
  const saved = await request("/api/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ notify: { learnFromReactions: false } }) });
  expect(saved.status).toBe(200);
  expect(app.config.notify.learnFromReactions).toBe(false);
  const rules = await (await request("/api/notify-ignore-rules")).json();
  expect(rules.rules).toHaveLength(1);
  expect((await request("/api/notify-ignore-rules/delete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: rules.rules[0].id }) })).status).toBe(200);
  expect(await (await request("/api/notify-ignore-rules")).json()).toEqual({ rules: [] });
});
