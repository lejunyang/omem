import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { boot } from "../src/main.ts";
import { categoryStatus, defaultFor, keyEnv, modelChoices, newestOf, readKeys, refreshModels, setKey, setModelListFetchForTests, testProvider, useKeyHome } from "../src/core/ai-keys.ts";
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
    expect((await testProvider({ id: "c", name: "", kind: "cloudflare", backends: [] }, "k", fake)).detail).toMatch(/账号 ID/);
    expect((await testProvider({ id: "c", name: "", kind: "cloudflare", accountId: "0123456789abcdef0123456789abcdef", backends: [] }, "k", fake)).ok).toBe(true);
    expect(calls[2]).toEqual(["https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/ai/models/search?search=clef&per_page=1", { authorization: "Bearer k" }]);
  });

  it("reads the models an account lists, and an empty field takes the newest of the default's family", async () => {
    expect(newestOf(["gpt-image-2.5-sunburst", "gpt-image-2.6-sunburst", "gpt-image-2.6-flare", "gpt-image-2.7-flare-2026-12-01"], "gpt-image-2.6-flare")).toBe("gpt-image-2.6-flare");
    expect(newestOf(["gpt-image-2.5-flare", "gpt-image-2.7-sunburst"], "gpt-image-2.6-flare")).toBe("gpt-image-2.7-sunburst");
    expect(newestOf(["gpt-live-1", "gpt-live-1.5", "gpt-live-mini"], "gpt-live-1")).toBe("gpt-live-1.5");
    expect(newestOf(["clef", "clef-flash", "clef-omni"], "clef-flash")).toBe("clef-flash");
    expect(newestOf([], "gpt-transcribe")).toBe("gpt-transcribe");
    const home = mkdtempSync(join(tmpdir(), "omem-models-"));
    setKey(home, "o", "k");
    const listed = ["gpt-6-luna", "gpt-6.1-sol", "gpt-image-2.5-flare", "gpt-image-2.6-flare", "gpt-image-2.6-sunburst", "gpt-live-1", "gpt-live-1.1", "gpt-realtime-2.1", "gpt-realtime-whisper", "gpt-realtime-translate", "gpt-transcribe", "text-embedding-3-large"];
    const fake = (async (url: string, init: { headers: Record<string, string> }) => {
      expect(url).toBe("https://api.openai.com/v1/models");
      expect(init.headers.authorization).toBe("Bearer k");
      return Response.json({ data: listed.map((id) => ({ id })) });
    }) as unknown as typeof fetch;
    const p = { id: "o", name: "", kind: "openai" as const, backends: [] };
    await refreshModels(home, p, fake);
    expect(modelChoices(home, p, "image")).toEqual({ default: "gpt-image-2.6-flare", models: ["gpt-image-2.5-flare", "gpt-image-2.6-flare", "gpt-image-2.6-sunburst"] });
    expect(modelChoices(home, p, "voice.live").default).toBe("gpt-live-1.1");
    expect(modelChoices(home, p, "voice.realtime").models).toEqual(["gpt-realtime-2.1"]);
    expect(modelChoices(home, p, "voice.transcribe")).toEqual({ default: "gpt-transcribe", models: ["gpt-realtime-whisper", "gpt-transcribe"] });
    expect(modelChoices(home, p, "decision")).toEqual({ default: "gpt-6.1-sol", models: ["gpt-6-luna", "gpt-6.1-sol"] });
    const config = configSchema.parse({ ai: { providers: [p], image: { provider: "o" }, voice: { provider: "o" } } });
    expect(categoryStatus(config, "image", home)).toMatchObject({ ready: true, model: "gpt-image-2.6-flare" });
    expect(categoryStatus(config, "voice", home).model).toBe("gpt-live-1.1");
    expect(defaultFor(config, home, "voice.transcribe")).toBe("gpt-transcribe");
    // A failed refresh keeps the old list and says why.
    await refreshModels(home, p, (async () => new Response("bad key", { status: 401 })) as unknown as typeof fetch);
    expect(modelChoices(home, p, "image").default).toBe("gpt-image-2.6-flare");
  });

  it("keeps keys out of config and settings, and drops a removed provider's key", async () => {
    const home = mkdtempSync(join(tmpdir(), "omem-keys-"));
    const b = await boot(home, { port: 0, quiet: true, background: false });
    servers.push(b.server);
    const api = (path: string, method = "GET", body?: unknown) =>
      fetch(`${b.app.baseUrl}${path}`, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, body: await r.json() }));
    expect((await api("/api/ai/keys/o", "PUT", { key: "sk-x" })).status).toBe(404);
    await api("/api/settings", "PUT", { ai: { ...b.app.config.ai, providers: [{ id: "o", name: "个人", kind: "openai", backends: ["codex"] }] } });
    setModelListFetchForTests((async () => Response.json({ data: [{ id: "gpt-image-2.6-flare" }, { id: "gpt-6-luna" }] })) as unknown as typeof fetch);
    const v = await api("/api/ai/keys/o", "PUT", { key: "sk-secret-abcd" });
    setModelListFetchForTests(null);
    expect(v.body.providers[0]).toMatchObject({ id: "o", hasKey: true, keyHint: "…abcd", listed: { count: 2 } });
    expect(v.body.choices.o.image).toEqual({ default: "gpt-image-2.6-flare", models: ["gpt-image-2.6-flare"] });
    expect(readFileSync(join(home, "config.json"), "utf8")).not.toContain("sk-secret");
    const settings = await api("/api/settings");
    expect(JSON.stringify(settings.body)).not.toContain("sk-secret");
    expect(settings.body.agents.some((p: { id: string }) => p.id === "codex@o")).toBe(true);
    await api("/api/settings", "PUT", { ai: { ...b.app.config.ai, providers: [] } });
    expect(readKeys(home)).toEqual({});
    expect(existsSync(join(home, "secrets", "ai-keys.json"))).toBe(true);
  });
});
