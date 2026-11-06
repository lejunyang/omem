import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { boot } from "../src/main.ts";
import { categoryStatus, keyEnv, readKeys, setKey, testProvider, useKeyHome } from "../src/core/ai-keys.ts";
import { allProfiles, configSchema, keyedProfiles } from "../src/core/config.ts";
import { backendAvailable } from "../src/agents/availability.ts";

const servers: { close(): Promise<unknown> }[] = [];
afterAll(async () => {
  for (const s of servers) await s.close();
});

const withProviders = (providers: unknown[], ai: Record<string, unknown> = {}) => configSchema.parse({ ai: { providers, ...ai } });

describe("API-key providers", () => {
  it("generates Codex / Claude Code backends that run with the key and keep their own quota", () => {
    const config = withProviders([
      { id: "team", name: "团队", kind: "openai", backends: ["codex", "codex-cli"] },
      { id: "mine", kind: "anthropic", baseUrl: "https://proxy.example.com", backends: ["claude", "codex"] },
    ]);
    const keyed = keyedProfiles(config);
    // codex is not an Anthropic backend: left out.
    expect(keyed.map((p) => p.id)).toEqual(["codex@team", "codex-cli@team", "claude@mine"]);
    expect(keyed[0]).toMatchObject({ transport: "acp", command: "codex-acp", keyRef: "team", source: "key:team", name: "Codex (ACP · 团队)" });
    expect(keyed[2].env).toMatchObject({ ANTHROPIC_BASE_URL: "https://proxy.example.com" });
    expect(allProfiles(config).some((p) => p.id === "claude@mine")).toBe(true);
    // The key itself is never part of a profile.
    expect(JSON.stringify(keyed)).not.toMatch(/API_KEY/);
  });

  it("adds the key at launch and refuses a keyed profile without one", () => {
    const home = mkdtempSync(join(tmpdir(), "omem-keys-"));
    useKeyHome(home);
    const [codex, claude] = keyedProfiles(withProviders([
      { id: "o", kind: "openai", backends: ["codex"] },
      { id: "a", kind: "anthropic", backends: ["claude-cli"] },
    ]));
    expect(() => keyEnv(codex)).toThrow(/还没有填写/);
    expect(backendAvailable(codex, home)).toBe(false);
    setKey(home, "o", "sk-openai-1234");
    setKey(home, "a", "sk-ant-5678");
    expect(keyEnv(codex)).toEqual({ CODEX_API_KEY: "sk-openai-1234", OPENAI_API_KEY: "sk-openai-1234" });
    expect(keyEnv(claude)).toEqual({ ANTHROPIC_API_KEY: "sk-ant-5678" });
    expect(keyEnv({ id: "codex", command: "codex-acp" })).toEqual({});
    setKey(home, "o", null);
    expect(readKeys(home)).toEqual({ a: "sk-ant-5678" });
  });

  it("says whether each category is usable", () => {
    const home = mkdtempSync(join(tmpdir(), "omem-keys-"));
    const config = withProviders([{ id: "o", kind: "openai" }, { id: "j", kind: "typesafe" }, { id: "c", kind: "anthropic" }], {
      voice: { provider: "o" },
      decision: { provider: "j" },
      image: { provider: "c" },
    });
    expect(categoryStatus(config, "voice", home)).toMatchObject({ ready: false, detail: expect.stringMatching(/API key/) });
    setKey(home, "o", "k1");
    setKey(home, "j", "k2");
    setKey(home, "c", "k3");
    expect(categoryStatus(config, "voice", home)).toMatchObject({ ready: true, model: "gpt-live-1" });
    expect(categoryStatus(config, "decision", home)).toMatchObject({ ready: true, model: "jev-latest" });
    // Anthropic has no image model.
    expect(categoryStatus(config, "image", home)).toMatchObject({ ready: false, detail: expect.stringMatching(/不提供/) });
    config.ai.voice.api = "realtime";
    expect(categoryStatus(config, "voice", home).model).toBe("gpt-realtime-2.1");
    config.ai.decision.provider = "startlux";
    expect(categoryStatus(config, "decision", home).ready).toBe(false);
  });

  it("checks a key without spending anything", async () => {
    const calls: [string, Record<string, string>][] = [];
    const fake = (async (url: string, init: { headers: Record<string, string> }) => {
      calls.push([url, init.headers]);
      return new Response("bad key", { status: url.includes("anthropic") ? 401 : 200 });
    }) as unknown as typeof fetch;
    expect(await testProvider({ id: "o", name: "", kind: "openai", backends: [] }, "k", fake)).toEqual({ ok: true, detail: "可用" });
    expect((await testProvider({ id: "a", name: "", kind: "anthropic", backends: [] }, "k", fake)).ok).toBe(false);
    expect(calls[0][0]).toBe("https://api.openai.com/v1/models");
    expect(calls[1]).toEqual(["https://api.anthropic.com/v1/models", { "x-api-key": "k", "anthropic-version": "2023-06-01" }]);
    expect((await testProvider({ id: "x", name: "", kind: "openai", backends: [] }, "", fake)).ok).toBe(false);
  });

  it("keeps keys out of config and settings, and drops a removed provider's key", async () => {
    const home = mkdtempSync(join(tmpdir(), "omem-keys-"));
    const b = await boot(home, { port: 0, quiet: true, background: false });
    servers.push(b.server);
    const api = (path: string, method = "GET", body?: unknown) =>
      fetch(`${b.app.baseUrl}${path}`, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, body: await r.json() }));
    expect((await api("/api/ai/keys/o", "PUT", { key: "sk-x" })).status).toBe(404);
    await api("/api/settings", "PUT", { ai: { ...b.app.config.ai, providers: [{ id: "o", name: "个人", kind: "openai", backends: ["codex"] }] } });
    const v = await api("/api/ai/keys/o", "PUT", { key: "sk-secret-abcd" });
    expect(v.body.providers[0]).toMatchObject({ id: "o", hasKey: true, keyHint: "…abcd" });
    expect(readFileSync(join(home, "config.json"), "utf8")).not.toContain("sk-secret");
    const settings = await api("/api/settings");
    expect(JSON.stringify(settings.body)).not.toContain("sk-secret");
    expect(settings.body.agents.some((p: { id: string }) => p.id === "codex@o")).toBe(true);
    await api("/api/settings", "PUT", { ai: { ...b.app.config.ai, providers: [] } });
    expect(readKeys(home)).toEqual({});
    expect(existsSync(join(home, "secrets", "ai-keys.json"))).toBe(true);
  });
});
