import { copyFileSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import YAML from "yaml";
import { currentRules, decide, saveOperationRules } from "../src/agents/operation-policy.ts";
import { listRulePacks } from "../src/agents/rule-packs.ts";
import { createApiToken, createUser, setUserRole } from "../src/core/users.ts";
import { loadPlugins } from "../src/plugins/registry.ts";
import { startServer } from "../src/server/http.ts";
import { testApp } from "./helpers.ts";

describe("owner-managed operation rule packs", () => {
  const app = testApp();
  const skills = join(app.libraryDir, "_skills", "release");
  const plugins = join(app.home, "plugins");
  const plugin = join(plugins, "release");
  const file = join(skills, "operation-rules.yaml");
  const base = "/api/security/rule-packs";
  const fixture = new URL("./fixtures/rule-packs/operation-rules.yaml", import.meta.url);
  let server: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => {
    for (const dir of [skills, plugin]) {
      mkdirSync(dir, { recursive: true });
      copyFileSync(fixture, join(dir, "operation-rules.yaml"));
    }
    writeFileSync(join(skills, "SKILL.md"), "# Release\n");
    writeFileSync(join(plugin, "plugin.yaml"), "id: release\nname: Release\n");
    await loadPlugins(app, [{ dir: plugins, source: "data" }]);
    server = await startServer(app, { port: 0, quiet: true });
  });
  afterAll(async () => { await server?.close(); app.db.close(); });
  afterEach(() => {
    saveOperationRules(app, []);
    copyFileSync(fixture, file);
    copyFileSync(fixture, join(plugin, "operation-rules.yaml"));
  });

  async function packs() {
    const response = await server.inject({ method: "GET", url: base });
    expect(response.statusCode).toBe(200);
    return response.json<{ packs: ReturnType<typeof listRulePacks> }>().packs;
  }
  const post = (id: string, action: string, payload?: object) =>
    server.inject({ method: "POST", url: base + "/" + id + "/" + action, payload });

  it("restricts discovery, activation and deactivation even for administrators", async () => {
    createUser(app, { id: "admin-test", name: "Admin" });
    setUserRole(app, "admin-test", "admin");
    const headers = { authorization: "Bearer " + createApiToken(app, "admin-test") };
    for (const action of ["", "/skill:release/enable", "/skill:release/disable"]) {
      const result = await server.inject({ method: action ? "POST" : "GET", url: base + action, headers });
      expect(result.statusCode).toBe(403);
    }
  });

  it("pins scoped rules until the owner confirms the exact diff, and can disable a removed pack", async () => {
    const id = "skill:release";
    const list = await packs();
    expect(list).toEqual(expect.arrayContaining(["plugin", "skill"].map(type => expect.objectContaining({
      id: type + ":release", source: { type, name: "release" }, enabled: false, version: "1", ruleCount: 1,
    }))));
    const view = async () => (await packs()).find(p => p.id === id)!;
    const first = await view();
    expect(currentRules(app)).toEqual([]);
    expect((await post(id, "enable", { confirmation: first.confirmation })).statusCode).toBe(400);
    const scope = { spaces: ["sample"] };
    expect((await post(id, "enable", { scope, confirmation: first.confirmation })).statusCode).toBe(200);
    const [snapshot] = currentRules(app);
    expect(snapshot).toMatchObject({ scope, pack: { name: first.name, version: "1", ruleId: "publish" } });
    const op = { kind: "command", executable: "acme", argv: ["publish"] } as const;
    const decision = (space: string) => decide(app, { ...op, argv: [...op.argv] }, { member: "test", space }).action;
    expect(decision("sample")).toBe("approve");
    expect(decision("elsewhere")).toBe("allow");
    const update = YAML.parse(readFileSync(fixture, "utf8"));
    update.version = "2";
    update.rules[0].action = "log";
    writeFileSync(file, YAML.stringify(update));
    const preview = await view();
    expect(preview).toMatchObject({ installedVersion: "1", version: "2", diff: { changed: [{ before: { action: "approve" }, after: { action: "log" } }] } });
    update.rules[0].action = "deny";
    writeFileSync(file, YAML.stringify(update));
    expect((await post(id, "enable", { scope, confirmation: preview.confirmation })).statusCode).toBe(409);
    expect(decision("sample")).toBe("approve");
    expect((await post(id, "enable", { scope, confirmation: (await view()).confirmation })).statusCode).toBe(200);
    expect(decision("sample")).toBe("deny");
    expect(currentRules(app)[0]).toMatchObject({ id: snapshot.id, revision: snapshot.revision + 1, scope });
    update.rules[0].scope = {};
    writeFileSync(file, YAML.stringify(update));
    expect((await view()).error).toContain("scope");
    expect(decision("sample")).toBe("deny");
    unlinkSync(file);
    expect(await view()).toMatchObject({ enabled: true, installedVersion: "2", error: "来源已移除" });
    expect((await post(id, "disable")).statusCode).toBe(200);
    expect(currentRules(app)).toEqual([]);
  });

  it("previews insertions, removals and reordering while retaining unrelated rules", async () => {
    const id = "plugin:release";
    const view = async () => (await packs()).find(p => p.id === id)!;
    const manifest = YAML.parse(readFileSync(fixture, "utf8"));
    const publish = manifest.rules[0];
    const setRules = (ids: string[]) => writeFileSync(join(plugin, "operation-rules.yaml"), YAML.stringify({
      ...manifest, rules: ids.map(ruleId => ({ ...publish, id: ruleId })),
    }));
    const enable = async () => expect((await post(id, "enable", { scope: {}, confirmation: (await view()).confirmation })).statusCode).toBe(200);
    setRules(["a", "b", "c"]);
    await enable();
    const [a, b, c] = currentRules(app);
    const manual = { ...a, id: "manual", pack: undefined };
    saveOperationRules(app, [a, b, manual, c]);
    setRules(["c", "extra", "b"]);
    expect((await view()).diff).toMatchObject({
      removed: [{ id: "a" }], added: [{ id: "extra" }],
      order: { before: ["a", "b", "c"], after: ["c", "extra", "b"] },
    });
    await enable();
    expect(currentRules(app).map(r => r.pack?.ruleId ?? r.id)).toEqual(["c", "manual", "extra", "b"]);
    await post(id, "disable");
    expect(currentRules(app).map(r => r.id)).toEqual(["manual"]);
  });
});
