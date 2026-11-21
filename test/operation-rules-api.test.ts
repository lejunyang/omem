import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { loadConfig, saveConfig } from "../src/core/config.ts";
import { createApiToken, createUser } from "../src/core/users.ts";
import { startServer } from "../src/server/http.ts";
import { testApp } from "./helpers.ts";

it("migrates the config file without changing ordered legacy approval settings", () => {
  const { home } = testApp();
  const file = join(home, "config.json");
  writeFileSync(file, JSON.stringify({ security: { commandRules: [
    { command: "acme", args: "^read", action: "allow" },
    { command: "acme", reuse: "window", approver: "run", approvers: ["owner"] },
  ] } }));
  const config = loadConfig(home);
  expect(config.security.operationRules.map(r => r.action)).toEqual(["allow", "approve"]);
  expect(config.security.operationRules[1]?.approval).toMatchObject({ reuse: "window", approver: "run", approvers: ["owner"] });
  saveConfig(config, home);
  expect(JSON.parse(readFileSync(file, "utf8")).security).toEqual({ egress: config.security.egress, operationRules: config.security.operationRules });
  expect(loadConfig(home).security).toEqual(config.security);
});

it("protects owner routes, versions edits and preserves scoped rules through the legacy endpoint", async () => {
  const app = testApp();
  const server = await startServer(app, { port: 0, host: "127.0.0.1", quiet: true });
  try {
    createUser(app, { name: "Example", id: "member" });
    const token = createApiToken(app, "member", "test");
    const url = "/api/security/operation-rules";
    for (const method of ["GET", "PUT"] as const) {
      const res = await server.inject({ url, method, headers: { authorization: `Bearer ${token}` } });
      expect(res.statusCode).toBe(403);
    }
    const http = { id: "web", revision: 1, enabled: true, action: "log", match: { kind: "http", host: "example.org" } };
    const command = { ...http, id: "cmd", action: "deny", scope: { spaces: ["sample"] }, match: { kind: "command", executable: "acme" } };
    const put = await server.inject({ url, method: "PUT", payload: { rules: [http, command] } });
    expect(put.statusCode).toBe(200);
    const rules = put.json().rules;
    expect(rules.map((r: { enforcedBy: string[] }) => r.enforcedBy)).toEqual([["browser","egress"], ["command-gate", "acp"]]);
    expect((await server.inject({ url, method: "PUT", payload: { rules } })).json().rules).toEqual(rules);
    const edited = await server.inject({ url, method: "PUT", payload: { rules: [{ ...rules[0], action: "deny" }, rules[1]] } });
    expect(edited.json().rules[0].revision).toBe(rules[0].revision + 1);
    expect((await server.inject({ url, method: "PUT", payload: { rules: [{ ...http, match: { ...http.match, pathRegex: "(" } }] } })).statusCode).toBe(400);
    await server.inject({ url: "/api/security/command-rules", method: "PUT", payload: { rules: [{ command: "acme", args: "^read", action: "allow" }] } });
    expect((await server.inject({ url })).json().rules.slice(0, 2)).toEqual(edited.json().rules);
  } finally {
    await server.close();
    app.db.close();
  }
});
