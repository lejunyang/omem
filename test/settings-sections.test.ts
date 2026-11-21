import { expect, it } from "vitest";
import { testApp } from "./helpers.ts";
import { createApiToken, createUser } from "../src/core/users.ts";
import { saveRole } from "../src/auth/permissions.ts";
import { configSchema } from "../src/core/config.ts";
import { ownerSettings, settingSections } from "../src/auth/settings-sections.ts";
import { startServer } from "../src/server/http.ts";

it("maps every schema key including optional settings, and reserves identity and host controls", () => {
  expect(Object.keys(settingSections).sort()).toEqual(Object.keys(configSchema.shape).sort());
  expect(ownerSettings).toEqual(expect.arrayContaining(["mentions.reply", "lark.commands", "security", "agents.accounts",
    "agents.accountIsolation", "host", "https", "shares.expiryDays", "token", "node", "backups"]));
});

it("projects sections, rejects mixed writes atomically and audits changed keys without values", async () => {
  const app = testApp();
  app.config.shares.expiryDays = 7;
  const server = await startServer(app, { port: 0, quiet: true });
  try {
    createUser(app, { id: "reader", name: "读者", role: "observer" });
    const headers = { authorization: "Bearer " + createApiToken(app, "reader") };
    const get = (url: string) => server.inject({ url, headers });
    const put = (payload: object) => server.inject({ method: "PUT", url: "/api/settings", headers, payload });
    expect((await get("/api/settings")).statusCode).toBe(403);
    for (const capability of ["settings.assistant.view", "settings.assistant.edit", "settings.security.view", "settings.channels.edit"]) {
      app.db.prepare("insert into member_capability_overrides(user_id,capability,scope_kind,scope_id,effect,created_at,created_by,updated_at) values('reader',?,'global','','allow','0','owner','0')").run(capability);
    }
    expect((await get("/api/settings/sections")).json().sections.assistant).toEqual({ view: true, edit: true });
    const view = (await get("/api/settings?section=assistant")).json();
    expect(view.config.agents.autoAdvance).toEqual(app.config.agents.autoAdvance);
    expect(view.config.agents.accounts).toBeUndefined();
    expect(view.config.security).toBeUndefined();
    expect(view.config.token).toBeUndefined();
    expect(view.home).toBeUndefined();
    expect((await put({ ...view.config, port: app.config.port + 1, timezone: "UTC" })).statusCode).toBe(403);
    const hidden = await put({ mentions: { reply: { lark: { group: "auto" } } } });
    expect(hidden.statusCode).toBe(403);
    expect(hidden.body).toContain("mentions.reply");
    const tz = app.config.timezone === "UTC" ? "Asia/Tokyo" : "UTC";
    expect((await put({ shares: { expiryDays: app.config.shares.expiryDays } })).statusCode).toBe(200);
    const refused = await put({ timezone: tz, shares: { expiryDays: 0 } });
    expect(refused.statusCode).toBe(403);
    expect(refused.body).toContain("shares.expiryDays");
    expect(app.config.timezone).not.toBe(tz);
    const saved = await put({ ...view.config, port: app.config.port, timezone: tz });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().config).not.toHaveProperty("port");
    const audit = app.db.prepare("select actor,detail from audit_events where action='settings.update'").all();
    expect(audit).toEqual([{ actor: "reader", detail: JSON.stringify({ changes: { assistant: ["timezone"] } }) }]);
  } finally { await server.close(); app.db.close(); }
});

it("separates review form access and delegation tier selection", async () => {
  const app = testApp();
  const server = await startServer(app, { port: 0, quiet: true });
  try {
    saveRole(app, { id: "delegator", name: "编码交办", scope: "global", permissions: ["code.delegate"] });
    for (const [id, role, effect] of [["review-reader", "member", "allow"], ["coder", "delegator", "deny"]]) {
      createUser(app, { id, role, name: id });
      app.db.prepare("insert into member_capability_overrides(user_id,capability,scope_kind,scope_id,effect,created_at,created_by) values(?,'settings.assistant.view','global','',?,'0','owner')").run(id, effect);
      const headers = { authorization: "Bearer " + createApiToken(app, id) };
      const get = (url: string) => server.inject({ url, headers });
      const reader = effect === "allow";
      expect((await get("/api/review-settings")).statusCode).toBe(reader ? 200 : 403);
      expect((await get("/api/review-options")).statusCode).toBe(reader ? 200 : 403);
      const tiers = await get("/api/review-tiers");
      expect(tiers.statusCode).toBe(reader ? 403 : 200);
      if (reader) {
        const agents = (await get("/api/settings?section=assistant")).json().agents;
        expect(agents.length).toBeGreaterThan(0);
        for (const backend of agents)
          expect(Object.keys(backend).every(k => ["id", "name", "installed", "transport", "model", "effort", "probe"].includes(k))).toBe(true);
      } else {
        for (const tier of tiers.json().tiers) expect(Object.keys(tier).sort()).toEqual(["checkCount", "id", "name"]);
      }
    }
  } finally { await server.close(); app.db.close(); }
});
