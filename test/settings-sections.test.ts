import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { forgetPlugin, loadPlugins } from "../src/plugins/registry.ts";
import { expect, it } from "vitest";
import { testApp } from "./helpers.ts";
import { upsertSource } from "../src/sources/store.ts";
import { addMember, createApiToken, createUser } from "../src/core/users.ts";
import { createSpace } from "../src/core/spaces.ts";
import { saveRole } from "../src/auth/permissions.ts";
import { configSchema } from "../src/core/config.ts";
import { ROUTE_RULES } from "../src/auth/routes.ts";
import { ownerControls, ownerSettings, settingSections } from "../src/auth/settings-sections.ts";
import { startServer } from "../src/server/http.ts";

it("maps every schema key including optional settings, and reserves identity and host controls", () => {
  expect(Object.keys(settingSections).sort()).toEqual(Object.keys(configSchema.shape).sort());
  expect(ownerSettings).toEqual(expect.arrayContaining(["mentions.reply", "lark.commands", "security", "agents.accounts",
    "agents.accountIsolation", "host", "https", "shares.expiryDays", "token", "node", "backups"]));
});

it("projects sections, rejects mixed writes atomically and audits changed keys without values", async () => {
  const app = testApp();
  app.config.shares.expiryDays = 7;
  app.config.notify.outletAskGrants.other = { mailbox: ["approval"] };
  app.config.notify.outlets.other = [];
  const server = await startServer(app, { port: 0, quiet: true });
  try {
    createUser(app, { id: "reader", name: "读者", role: "observer" });
    const headers = { authorization: "Bearer " + createApiToken(app, "reader") };
    const get = (url: string) => server.inject({ url, headers });
    const put = (payload: object) => server.inject({ method: "PUT", url: "/api/settings", headers, payload });
    expect((await get("/api/me")).json().ownerName).toBe("主人");
    app.db.prepare("update users set name=? where id='owner'").run("项目负责人");
    expect((await get("/api/me")).json().ownerName).toBe("项目负责人");
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
    expect(view.config.notify).not.toHaveProperty("outlets");
    expect(view.config.notify).not.toHaveProperty("outletAskGrants");
    const owner = (await server.inject({ url: "/api/settings?section=assistant" })).json();
    expect(owner.config.notify.outletAskGrants.other.mailbox).toEqual(["approval"]);
    expect(owner.config.notify.outlets.other).toEqual([]);
    expect(view.home).toBeUndefined();
    expect((await put({ ...view.config, port: app.config.port + 1, timezone: "UTC" })).statusCode).toBe(403);
    expect((await put({ remoteGrants: { defaultHours: 4, maxHours: 24 } })).statusCode).toBe(403);
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
        const review = (await get("/api/review-settings")).json();
        const payload = { tiers: review.tiers, checks: {}, rereviewAllEvery: 4 };
        const save = () => server.inject({ method: "PUT", url: "/api/review-settings", headers, payload });
        expect((await save()).statusCode).toBe(403);
        app.db.prepare("insert into member_capability_overrides(user_id,capability,scope_kind,scope_id,effect,created_at,created_by) values(?,'settings.assistant.edit','global','','allow','0','owner')").run(id);
        expect((await save()).statusCode).toBe(200);
        expect((await get("/api/review-settings")).json().rereviewAllEvery).toBe(4);
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


it("成员读插件列表、详情和改图标都能渲染权限，服务命令和目录仅本人可见", async () => {
  const app = testApp();
  const root = join(app.home, "plugins");
  const dir = join(root, "probe");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "plugin.yaml"), JSON.stringify({
    id: "probe", name: "探针", tools: ["read_page"],
    services: [{ name: "echo", command: "node", args: ["private-service.mjs"] }],
  }));
  await loadPlugins(app, [{ dir: root, source: "data" }]);
  const server = await startServer(app, { port: 0, quiet: true });
  try {
    createUser(app, { id: "reader", name: "读者", role: "observer" });
    const headers = { authorization: "Bearer " + createApiToken(app, "reader") };
    const grant = app.db.prepare("insert into member_capability_overrides(user_id,capability,scope_kind,scope_id,effect,created_at,created_by) values('reader',?,'global','','allow','0','owner')");
    grant.run("settings.ai.view");
    const url = "/api/plugins/probe";
    const owner = (await server.inject({ url })).json();
    expect(owner).toMatchObject({ dir, services: [{ command: "node private-service.mjs" }], permissions: { services: ["node private-service.mjs"] } });
    const list = await server.inject({ url: "/api/plugins", headers });
    const detail = await server.inject({ url, headers });
    expect(list.statusCode).toBe(200);
    expect(detail.statusCode).toBe(200);
    const card = detail.json();
    expect(list.json().find((p: { id: string }) => p.id === "probe")).toEqual(card);
    expect(card).toMatchObject({
      id: "probe", iconChosen: false, services: [], streams: [], spaces: [], flows: [], rules: [], hooks: [], mcp: [],
      agents: [], skills: [], tools: [], permissions: {
        tools: [], writes: false, hostTools: ["read_page"], providers: [], platforms: [], uses: [], services: [], agentLogin: [], space: null,
      },
    });
    expect(card).not.toHaveProperty("dir");
    expect(detail.body).not.toContain("private-service.mjs");
    grant.run("settings.ai.edit");
    const edited = await server.inject({ method: "PUT", url: url + "/icon", headers, payload: { icon: "star" } });
    expect(edited.statusCode).toBe(200);
    expect(edited.json()).toEqual({ ...card, icon: "star", iconChosen: true });
  } finally { forgetPlugin("probe"); await server.close(); app.db.close(); }
});

it("checks section grants on the card APIs and omits host settings from member responses", async () => {
  const app = testApp();
  const server = await startServer(app, { port: 0, quiet: true });
  try {
    createUser(app, { id: "cards", name: "成员" });
    const headers = { authorization: "Bearer " + createApiToken(app, "cards") };
    const get = (url: string) => server.inject({ url, headers });
    for (const route of Object.values(ownerControls).flat()) expect(ROUTE_RULES[route], route).toBe("owner");
    const groups = {
      AI: ["ai", "/api/ai", "/api/agents/load"],
      knowledge: ["knowledge", "/api/storage", "/api/search/providers", "/api/lark/captured", "/api/lark/wiki-crawls"],
      assistant: ["assistant", "/api/schedules", "/api/replays", "/api/agents", "/api/mentions"],
      channels: ["channels", "/api/desktop"],
      members: ["members", "/api/auth/providers"],
    };
    for (const [area, ...urls] of Object.values(groups)) {
      for (const url of urls) expect((await get(url)).statusCode, url).toBe(403);
      app.db.prepare("insert into member_capability_overrides(user_id,capability,scope_kind,scope_id,effect,created_at,created_by) values('cards',?,'global','','allow','0','owner')").run(`settings.${area}.view`);
      for (const url of urls) expect((await get(url)).statusCode, url).toBe(200);
    }
    createSpace(app, { id: "proj", name: "项目" });
    addMember(app, "proj", "cards", "reader");
    for (const id of ["shown", "hidden"]) {
      const src = upsertSource(app, { spaceId: "proj", kind: "chat", uri: `lark:${id}`, title: id, text: "一段聊天" });
      app.db.prepare("insert into lark_cursors(chat_id,name) values(?,?)").run(id,id);
      if (id === "hidden") app.db.prepare("update sources set visibility='restricted' where id=?").run(src.id);
    }
    expect((await get("/api/lark/captured")).json().chats.map((c: {chatId: string}) => c.chatId)).toEqual(["shown"]);
    app.config.ai.providers = [{ id: "demo", name: "测试", kind: "openai", baseUrl: "https://example.com/private", backends: [] }];
    expect((await get("/api/ai")).json().providers[0]).toEqual({ id: "demo", name: "测试", kind: "openai", hasKey: false, keyHint: "" });
    app.config.guard.modelDir = "private-model-directory";
    app.config.documents.doclingArtifacts = "private-model-directory";
    app.config.rerank.model = "private-model-directory";
    expect((await get("/api/settings")).body).not.toContain("private-model-directory");
    expect((await get("/api/settings?section=ai")).json().agents[0]).not.toHaveProperty("command");
    const restricted = await server.inject({ method: "PUT", url: "/api/ai/keys/demo", headers, payload: { key: null } });
    expect(restricted.statusCode).toBe(403);
  } finally { await server.close(); app.db.close(); }
});
